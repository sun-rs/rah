import type {
  ClientKind,
  IndependentTerminalStartRequest,
  IndependentTerminalStartResponse,
  NativeTuiDiagnostic,
  NativeTuiPromptState,
  NativeTuiSurfaceClaimRequest,
  NativeTuiClientCloseRequest,
  NativeTuiSurfaceReleaseRequest,
  NativeTuiSurfaceResponse,
  NativeTuiSurfaceState,
  ProviderKind,
  ManagedSession,
  StartSessionRequest,
  StartSessionResponse,
  TuiMuxSessionDiagnostic,
} from "@rah/runtime-protocol";
import { conversationStateFromRuntimeState } from "@rah/runtime-protocol";
import type { HistorySnapshotStore } from "./history-snapshots";
import { PtyHub } from "./pty-hub";
import { SessionStore, toSessionSummary, type StoredSessionState } from "./session-store";
import { EventBus } from "./event-bus";
import { applyLocalTerminalInput } from "./native-tui-prompt-state";
import {
  buildExternalLockedModeState,
  providerModeDescriptors,
} from "./session-mode-utils";
import { resolveUserPath } from "./workbench-directory-utils";
import type { NativeTuiLaunchSpec } from "./native-tui-launch-spec";
import type {
  NativeTuiBindingRecord,
  NativeTuiProviderRuntime,
} from "./native-tui-provider-runtime";
import {
  NativeTuiDiagnosticStore,
  type ListNativeTuiDiagnosticsOptions,
  maybeRecordNativeTuiBindingMissingDiagnostic,
  recordNativeTuiProcessExitDiagnostic,
  resolveNativeTuiBindingDiagnostic,
} from "./native-tui-diagnostics";
import type { NativeTuiMirrorProvider } from "./native-tui-mirror-provider";
import { nativeLocalServerAttachSpec } from "./native-local-server-attach";
import {
  DEFAULT_NATIVE_LOCAL_TUI_IDLE_CLOSE_MS,
  claimNativeLocalTuiWarmLease,
  createNativeLocalTuiWarmState,
  nativeLocalTuiWarmStateIdleExpired,
  releaseNativeLocalTuiWarmLease,
  type NativeLocalTuiWarmState,
} from "./native-local-tui-warm-lifecycle";
import {
  buildNativeTuiSessionCapabilities,
  buildStoppedNativeTuiSessionCapabilities,
  buildTuiMuxSessionCapabilities,
} from "./runtime-terminal-capabilities";
import { PtySessionRuntime, type PtySessionRuntimeEntry } from "./pty-session-runtime";
import {
  nativeTuiBindingProbeIntervalMs,
  nativeTuiBindingWarnAfterMs,
} from "./native-tui-runtime-config";
import {
  cancelNativeTuiQueuedInputsForClient,
  clearNativeTuiSessionTimers,
  dequeueNativeTuiQueuedInput,
  enqueueNativeTuiQueuedInput,
  nativeTuiProviderRuntimeSession,
  type NativeTuiSessionState,
  type NativeTuiSubmittedInput,
} from "./native-tui-session-state";
import {
  attachClientAndMaybeClaimControl,
  claimClientControlAndPublish,
  ensureClientAttachedAndPublish,
  publishSessionCreatedAndStarted,
  publishSessionStarted,
  publishSessionStateChanged,
  SYSTEM_SOURCE,
} from "./runtime-session-events";
import { NativeTuiMirrorRuntime } from "./native-tui-mirror-runtime";
import {
  createTmuxSessionNameForRahSession,
  TmuxCommandError,
  TmuxMuxBackend,
} from "./tmux-mux-backend";
import { reconcileTurnLifecycleActivity } from "./timeline-reconciler";
import type { MuxPaneSubscription, MuxRuntime } from "./mux-runtime";

type RuntimeTerminalCoordinatorDeps = {
  eventBus: EventBus;
  ptyHub: PtyHub;
  sessionStore: SessionStore;
  historySnapshots: HistorySnapshotStore;
  nativeTuiProviders: NativeTuiProviderRuntime;
  nativeTuiMirrors: NativeTuiMirrorProvider;
  onRememberSession: (state: StoredSessionState) => void;
  onSessionOwnerRemoved: (sessionId: string) => void;
};

type TuiMuxSessionState = {
  sessionId: string;
  muxSessionName: string;
  paneId: string;
  muxBackendKind: "tmux";
  muxRuntime: MuxRuntime;
  activeSurface?: NativeTuiSurfaceState;
  subscription?: MuxPaneSubscription;
  subscriptionRestartAttempts?: number;
  subscriptionRestartTimer?: ReturnType<typeof setTimeout>;
  exitPollMisses?: number;
  exitPollTimer?: ReturnType<typeof setInterval>;
  dumpTimer?: ReturnType<typeof setTimeout>;
  dumpInFlight?: boolean;
  dumpPending?: boolean;
  dumpAllowWebSizingClientFallback?: boolean;
  actionQueue?: Promise<void>;
};

const TUI_MUX_EXIT_MISSING_POLL_THRESHOLD = 3;
const NATIVE_TUI_RECENT_INPUT_PROMPT_CLEAN_GRACE_MS = 800;
const NATIVE_TUI_RECENT_INTERRUPT_NOOP_MS = 1_200;

type TuiMuxBackendKind = "tmux";

function normalizeTuiMuxBackendKind(value: string | undefined): TuiMuxBackendKind {
  if (value && value !== "tmux") {
    console.warn("[rah] RAH_TUI_MUX is deprecated; tmux is the only supported TUI mux backend.");
  }
  return "tmux";
}

function hasRecentInjectedInput(native: NativeTuiSessionState): boolean {
  return (
    native.lastInjectedInputAtMs !== undefined &&
    Date.now() - native.lastInjectedInputAtMs < NATIVE_TUI_RECENT_INPUT_PROMPT_CLEAN_GRACE_MS
  );
}

function registerSubmittedNativeTuiInput(
  native: NativeTuiSessionState,
  input: NativeTuiSubmittedInput,
): void {
  const submittedInputs = native.submittedInputs ?? [];
  submittedInputs.push(input);
  native.submittedInputs = submittedInputs.slice(-50);
}

function remainingRecentInjectedInputMs(native: NativeTuiSessionState): number {
  if (native.lastInjectedInputAtMs === undefined) {
    return 0;
  }
  return Math.max(
    0,
    NATIVE_TUI_RECENT_INPUT_PROMPT_CLEAN_GRACE_MS - (Date.now() - native.lastInjectedInputAtMs),
  );
}
const ANSI_ESCAPE_PATTERN = /\u001b\[[0-?]*[ -/]*[@-~]/g;

function initialNativeTuiPromptState(provider: ProviderKind): NativeTuiPromptState {
  // OpenCode paints its input prompt after a full-screen redraw. Keep Web
  // composer input queued until the provider handler sees the prompt marker.
  return provider === "opencode" ? "agent_busy" : "prompt_clean";
}

function initialTuiMuxPromptState(provider: ProviderKind): NativeTuiPromptState {
  // TUI mux sessions need a sizing/attach surface before the provider prompt is
  // reliable. Queue initial Web chat input until the viewport observer sees a
  // real prompt marker.
  // Claude Code can accept input while a turn is running and manages its own
  // queue inside the native TUI. RAH must not use prompt state as an
  // authoritative send gate for Claude mux sessions.
  return provider === "claude"
    ? "prompt_clean"
    : provider === "codex" || provider === "opencode" || provider === "gemini"
    ? "agent_busy"
    : "prompt_clean";
}

function providerPrimaryModelOptionId(provider: ProviderKind): string | null {
  switch (provider) {
    case "codex":
      return "model_reasoning_effort";
    case "claude":
      return "effort";
    case "gemini":
      return null;
    case "opencode":
      return "model_reasoning_variant";
    case "custom":
    default:
      return null;
  }
}

function nativeTuiStartupSessionPatch(
  launch: NativeTuiLaunchSpec,
): Pick<ManagedSession, "mode"> &
  Partial<Pick<ManagedSession, "model" | "config">> {
  const patch: Pick<ManagedSession, "mode"> &
    Partial<Pick<ManagedSession, "model" | "config">> = {
    mode: launch.modeId
      ? {
          currentModeId: launch.modeId,
          availableModes: providerModeDescriptors(launch.provider, {
            planAvailable: false,
          }),
          mutable: false,
          source: "external_locked",
        }
      : buildExternalLockedModeState(),
  };
  if (launch.modelId) {
    patch.model = {
      currentModelId: launch.modelId,
      ...(launch.reasoningId !== undefined ? { currentReasoningId: launch.reasoningId } : {}),
      availableModels: [],
      mutable: false,
      source: "native",
    };
  }
  const optionValues = launch.optionValues ?? (() => {
    const optionId = providerPrimaryModelOptionId(launch.provider);
    return optionId && launch.reasoningId !== undefined
      ? { [optionId]: launch.reasoningId }
      : undefined;
  })();
  if (optionValues !== undefined) {
    patch.config = {
      values: optionValues,
      source: "runtime_session",
    };
  }
  return patch;
}

function isPromptResetControlInput(data: string): boolean {
  if (!data.includes("\u001b") && !data.includes("\u0003")) {
    return false;
  }
  const withoutAnsiSequences = data
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\u001b/g, "")
    .replace(/\u0003/g, "");
  return withoutAnsiSequences.length === 0;
}

const NATIVE_TUI_INTERRUPT_CONFIRM_TIMEOUT_MS = 5_000;
const OPENCODE_SECOND_INTERRUPT_DELAY_MS = 120;
const NATIVE_TUI_CLEAR_PROMPT_DATA = "\u0015\u000b";
const NATIVE_TUI_SUBMIT_DELAY_MS = 250;
const TUI_MUX_CLEAR_PROMPT_SETTLE_MS = 250;
const NATIVE_TUI_OUTPUT_OBSERVATION_TAIL_LIMIT = 12_000;
const NATIVE_TUI_EXIT_ERROR_MAX_LENGTH = 320;
const NATIVE_TUI_EXIT_ERROR_PATTERN =
  /\b(?:error|failed|failure|invalid|unsupported|unknown|not found|unrecognized|unrecognised|exception)\b/i;

export function nativeTuiInterruptDataForProvider(provider: ProviderKind): string {
  // Native TUIs treat Ctrl-C inconsistently; for OpenCode it is an app-exit
  // binding, while Escape is the provider-declared session interrupt key.
  // OpenCode requires Escape twice during an active run ("again to interrupt").
  return provider === "opencode" ? "\u001b\u001b" : "\u001b";
}

function nativeTuiSubmitDataForProvider(provider: ProviderKind): string {
  return "\r";
}

function nativeTuiSubmitCountForProvider(provider: ProviderKind): number {
  // Claude Code can keep long Web-injected prompts in its multiline composer
  // after the first Enter. A second Enter submits the draft; while an ordinary
  // short prompt is already running, the second Enter is harmless.
  return provider === "claude" ? 2 : 1;
}

function isClaudeNativeTuiPassthrough(native: NativeTuiSessionState): boolean {
  return native.provider === "claude";
}

function usesBestEffortEscNativeTuiInterrupt(native: NativeTuiSessionState): boolean {
  return native.provider === "claude" || native.provider === "gemini";
}

function syntheticNativeTuiInterruptTurnId(sessionId: string): string {
  return `native-tui:${sessionId}:interrupt:${Date.now().toString(36)}`;
}

function latestSubmittedNativeTuiClientTurnId(native: NativeTuiSessionState): string | undefined {
  const inputs = native.submittedInputs;
  if (!inputs || inputs.length === 0) {
    return undefined;
  }
  for (let index = inputs.length - 1; index >= 0; index--) {
    const clientTurnId = inputs[index]?.clientTurnId;
    if (clientTurnId) {
      return clientTurnId;
    }
  }
  return undefined;
}

function nativeTuiInterruptTurnId(
  native: NativeTuiSessionState,
  activeTurnId: string | undefined,
): string {
  return (
    activeTurnId ??
    latestSubmittedNativeTuiClientTurnId(native) ??
    syntheticNativeTuiInterruptTurnId(native.sessionId)
  );
}

function isIdleNativeTuiInterruptRequest(
  native: NativeTuiSessionState,
  state: StoredSessionState | undefined,
  activeTurnId: string | undefined,
): boolean {
  const recentlyCompletedInterrupt =
    native.lastInterruptCompletedAtMs !== undefined &&
    Date.now() - native.lastInterruptCompletedAtMs < NATIVE_TUI_RECENT_INTERRUPT_NOOP_MS;
  if (
    recentlyCompletedInterrupt &&
    activeTurnId === undefined &&
    native.queuedInputs.length === 0
  ) {
    return true;
  }
  return (
    activeTurnId === undefined &&
    native.queuedInputs.length === 0 &&
    native.promptState === "prompt_clean" &&
    state?.session.runtimeState !== "running" &&
    !hasRecentInjectedInput(native)
  );
}

function stripTerminalControl(value: string): string {
  return value.replace(ANSI_ESCAPE_PATTERN, "");
}

function nativeTuiExitErrorFromOutput(native: NativeTuiSessionState | undefined): string | undefined {
  if (!native?.recentOutputTail) {
    return undefined;
  }
  const lines = stripTerminalControl(native.recentOutputTail)
    .replace(/\r/g, "\n")
    .split("\n")
    .map((line) =>
      line
        .replace(/[╭╮╰╯│─┌┐└┘]+/gu, " ")
        .replace(/\s+/g, " ")
        .trim(),
    )
    .filter(Boolean);
  const errorLines = lines.filter((line) => NATIVE_TUI_EXIT_ERROR_PATTERN.test(line));
  const error = errorLines.slice(-3).join(" ").replace(/\s+/g, " ").trim();
  if (!error) {
    return undefined;
  }
  return error.length > NATIVE_TUI_EXIT_ERROR_MAX_LENGTH
    ? `${error.slice(0, NATIVE_TUI_EXIT_ERROR_MAX_LENGTH - 3)}...`
    : error;
}

function muxSnapshotCursorSuffix(lines: readonly string[]): string {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const visible = stripTerminalControl(lines[index] ?? "").replace(/\r/g, "");
    const trimmed = visible.trimEnd();
    if (/^\s*(?:[›❯>])(?:\s|$)/u.test(trimmed) || /Ask anything/i.test(trimmed)) {
      const row = Math.max(1, index + 1);
      const col = Math.max(1, trimmed.length + 1);
      return `\u001b[?25h\u001b[${row};${col}H`;
    }
  }
  return "\u001b[?25l";
}

function renderMuxViewport(lines: readonly string[]): string {
  return `\u001b[2J\u001b[H${lines.join("\r\n")}${muxSnapshotCursorSuffix(lines)}`;
}

function renderMuxDump(dumped: string): string {
  const lines = dumped.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  return `\u001b[2J\u001b[H${lines.join("\r\n")}${muxSnapshotCursorSuffix(lines)}`;
}

function isTmuxSessionMissingError(error: unknown): boolean {
  if (!(error instanceof TmuxCommandError)) {
    return false;
  }
  const detail = `${error.stdout}\n${error.stderr}\n${error.message}`;
  return /no server running|can't find session|can't find pane|session not found|error connecting to .*no such file/i.test(
    detail,
  );
}

function isMuxSessionMissingError(error: unknown): boolean {
  return isTmuxSessionMissingError(error);
}

function isExitedTuiMuxPane(pane: { exited: boolean; held: boolean; exitStatus: number | null }): boolean {
  return pane.exited || pane.held || pane.exitStatus !== null;
}

function normalizeIndependentTerminalOwner(
  owner: IndependentTerminalStartRequest["owner"] | undefined,
): IndependentTerminalStartRequest["owner"] | undefined {
  if (!owner) {
    return undefined;
  }
  if (owner.kind === "workspace") {
    return { kind: "workspace", id: resolveUserPath(owner.id) };
  }
  return owner;
}

function appendCodexTuiMuxArgs(launch: NativeTuiLaunchSpec): NativeTuiLaunchSpec {
  if (launch.provider !== "codex" || launch.args.includes("--no-alt-screen")) {
    return launch;
  }
  const args =
    launch.args[0] === "resume"
      ? ["--no-alt-screen", ...launch.args]
      : [...launch.args, "--no-alt-screen"];
  return {
    ...launch,
    args,
    preview: `${launch.preview} --no-alt-screen`,
  };
}

export class RuntimeTerminalCoordinator {
  private readonly ptySessions = new PtySessionRuntime();
  private readonly tmuxMux = new TmuxMuxBackend();
  private readonly preferredTuiMuxBackendKind = normalizeTuiMuxBackendKind(process.env.RAH_TUI_MUX);
  private readonly tuiMuxSessions = new Map<string, TuiMuxSessionState>();
  private readonly nativeTuiSessions = new Map<string, NativeTuiSessionState>();
  private readonly nativeTuiSessionIds = new Set<string>();
  private readonly independentTerminals = new Map<string, IndependentTerminalStartResponse["terminal"]>();
  private readonly closingNativeTuiSessionIds = new Set<string>();
  private readonly nativeLocalTuiWarmStates = new Map<string, NativeLocalTuiWarmState>();
  private readonly nativeLocalTuiIdleCloseTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly nativeTuiDiagnostics = new NativeTuiDiagnosticStore();
  private readonly mirrorRuntime: NativeTuiMirrorRuntime;

  constructor(private readonly deps: RuntimeTerminalCoordinatorDeps) {
    this.mirrorRuntime = new NativeTuiMirrorRuntime({
      eventBus: deps.eventBus,
      ptyHub: deps.ptyHub,
      sessionStore: deps.sessionStore,
      nativeTuiMirrors: deps.nativeTuiMirrors,
      diagnostics: this.nativeTuiDiagnostics,
      getSession: (sessionId) => this.nativeTuiSessions.get(sessionId),
      updatePromptState: (sessionId, promptState) => {
        this.updateNativeTuiPromptState(sessionId, promptState);
      },
    });
  }

  hasNativeTuiSession(sessionId: string): boolean {
    return this.nativeTuiSessionIds.has(sessionId);
  }

  private muxRuntimeForKind(kind: TuiMuxBackendKind): MuxRuntime {
    return this.tmuxMux;
  }

  private currentMuxRuntimeForSession(session: ManagedSession): MuxRuntime | null {
    const kind = session.mux?.backend;
    if (kind !== "tmux") {
      return null;
    }
    return this.muxRuntimeForKind(kind);
  }

  private muxSessionNameForRahSession(sessionId: string, kind: TuiMuxBackendKind): string {
    return createTmuxSessionNameForRahSession(sessionId);
  }

  private muxSocketDirForKind(kind: TuiMuxBackendKind): string | undefined {
    return undefined;
  }

  async restoreTuiMuxSession(session: ManagedSession): Promise<boolean> {
    const mux = session.mux;
    const muxRuntime = this.currentMuxRuntimeForSession(session);
    if (
      session.liveBackend !== "tui_mux" ||
      !mux ||
      !muxRuntime
    ) {
      return false;
    }
    if (this.deps.sessionStore.getSession(session.id)) {
      return true;
    }
    const panes = await muxRuntime.listPanes(mux.sessionName).catch((error) => {
      console.warn("[rah] failed to list TUI mux panes during recovery", {
        sessionId: session.id,
        muxSessionName: mux.sessionName,
        error,
      });
      return [];
    });
    const pane = panes.find((candidate) => candidate.paneId === mux.paneId);
    if (!pane || isExitedTuiMuxPane(pane)) {
      return false;
    }

    const restoredRuntimeState: "running" | "idle" =
      session.nativeTui?.promptState === "agent_busy" ? "running" : "idle";
    const restoredSession: ManagedSession = {
      ...session,
      liveBackend: "tui_mux",
      ...conversationStateFromRuntimeState(restoredRuntimeState),
      runtimeState: restoredRuntimeState,
      ptyId: session.ptyId || session.id,
      nativeTui: {
        terminalId: session.id,
        viewAvailable: true,
        promptState: session.nativeTui?.promptState ?? initialNativeTuiPromptState(session.provider),
        queuedInputCount: 0,
      },
      mux,
      capabilities: {
        ...session.capabilities,
        ...buildTuiMuxSessionCapabilities(session.provider),
      },
    };
    this.deps.sessionStore.restoreSession({
      session: restoredSession,
      clients: [],
      controlLease: { sessionId: session.id },
    });
    this.deps.ptyHub.ensureSession(session.id);
    this.registerTuiMuxRuntime({
      sessionId: session.id,
      provider: session.provider,
      cwd: session.cwd,
      ...(session.providerSessionId
        ? { providerSessionId: session.providerSessionId }
        : {}),
      promptState: restoredSession.nativeTui?.promptState ?? "prompt_clean",
      startupTimestampMs: Date.now(),
      muxSessionName: mux.sessionName,
      paneId: mux.paneId,
      muxBackendKind: mux.backend,
      muxRuntime,
    });
    const dumped = await muxRuntime
      .dumpScreen(mux.sessionName, mux.paneId, { ansi: true })
      .catch(() => "");
    if (dumped) {
      const text = renderMuxDump(dumped);
      this.deps.ptyHub.appendOutput(session.id, text, { replaceReplay: true });
      this.observeNativeTuiOutput(session.id, text);
    }
    publishSessionCreatedAndStarted(this.deps, session.id);
    publishSessionStateChanged(this.deps, session.id, restoredRuntimeState);
    return true;
  }

  listNativeTuiDiagnostics(options?: ListNativeTuiDiagnosticsOptions): NativeTuiDiagnostic[] {
    return this.nativeTuiDiagnostics.list(options);
  }

  async listTuiMuxDiagnostics(): Promise<TuiMuxSessionDiagnostic[]> {
    const bySessionName = new Map<string, TuiMuxSessionDiagnostic>();
    const remember = (
      sessionName: string,
      backend: TuiMuxBackendKind = "tmux",
    ): TuiMuxSessionDiagnostic => {
      const existing = bySessionName.get(sessionName);
      if (existing) {
        return existing;
      }
      const created: TuiMuxSessionDiagnostic = {
        sessionName,
        backend,
        panes: [],
      };
      bySessionName.set(sessionName, created);
      return created;
    };

    for (const tmux of this.tuiMuxSessions.values()) {
      const managed = this.deps.sessionStore.getSession(tmux.sessionId)?.session;
      const entry = remember(tmux.muxSessionName, tmux.muxBackendKind);
      entry.managedSessionId = tmux.sessionId;
      entry.paneId = tmux.paneId;
      if (managed) {
        entry.provider = managed.provider;
        entry.runtimeState = managed.runtimeState;
      }
    }

    try {
      for (const session of await this.tmuxMux.listSessions()) {
        if (session.sessionName.startsWith("rah-")) {
          remember(session.sessionName, "tmux");
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      for (const entry of bySessionName.values()) {
        entry.error = message;
      }
    }

    await Promise.all(
      [...bySessionName.values()].map(async (entry) => {
        try {
          const muxRuntime = this.muxRuntimeForKind("tmux");
          const panes = await muxRuntime.listPanes(entry.sessionName);
          entry.panes = panes.map((pane) => ({
            paneId: pane.paneId,
            title: pane.title,
            exited: pane.exited,
            held: pane.held,
            exitStatus: pane.exitStatus,
            rows: pane.rows,
            columns: pane.columns,
            ...(pane.command ? { command: pane.command } : {}),
            ...(pane.cwd ? { cwd: pane.cwd } : {}),
            ...(pane.tabId !== undefined ? { tabId: pane.tabId } : {}),
            ...(pane.tabName ? { tabName: pane.tabName } : {}),
          }));
        } catch (error) {
          entry.error = error instanceof Error ? error.message : String(error);
        }
      }),
    );

    return [...bySessionName.values()].sort((left, right) =>
      left.sessionName.localeCompare(right.sessionName),
    );
  }

  async closeUnmanagedTuiMuxSession(sessionName: string): Promise<void> {
    const trimmedSessionName = sessionName.trim();
    if (!/^rah-[0-9a-z][0-9a-z-]*$/i.test(trimmedSessionName)) {
      throw new Error("Only RAH-owned TUI mux sessions can be closed from diagnostics.");
    }
    const managed = [...this.tuiMuxSessions.values()].find(
      (tmux) => tmux.muxSessionName === trimmedSessionName,
    );
    if (managed) {
      throw new Error("This TUI mux session is managed by a running RAH session. Close the running session instead.");
    }
    await this.removeMuxSession(trimmedSessionName, "tmux").catch((error) => {
      if (!isMuxSessionMissingError(error)) {
        throw error;
      }
    });
  }

  async cleanupUnmanagedTuiMuxSessions(): Promise<string[]> {
    const managedSessionNames = new Set(
      [...this.tuiMuxSessions.values()].map((session) => session.muxSessionName),
    );
    const closed: string[] = [];
    let sessions: Awaited<ReturnType<TmuxMuxBackend["listSessions"]>>;
    try {
      sessions = await this.tmuxMux.listSessions();
    } catch (error) {
      console.warn("[rah] failed to list tmux sessions during RAH cleanup", {
        error: error instanceof Error ? error.message : String(error),
      });
      return closed;
    }
    for (const session of sessions) {
      if (!session.sessionName.startsWith("rah-") || managedSessionNames.has(session.sessionName)) {
        continue;
      }
      await this.removeMuxSession(session.sessionName, "tmux").then(
        () => {
          closed.push(session.sessionName);
        },
        (error) => {
          console.warn("[rah] failed to clean unmanaged RAH tmux session", {
            sessionName: session.sessionName,
            error: error instanceof Error ? error.message : String(error),
          });
        },
      );
    }
    return closed;
  }

  private async removeMuxSession(
    sessionName: string,
    backend: TuiMuxBackendKind = "tmux",
  ): Promise<void> {
    const muxRuntime = this.muxRuntimeForKind(backend);
    await muxRuntime.killSession(sessionName).catch((error) => {
      if (isMuxSessionMissingError(error)) {
        return;
      }
      throw error;
    });
    await muxRuntime.deleteSession?.(sessionName).catch((error) => {
      if (isMuxSessionMissingError(error)) {
        return;
      }
      throw error;
    });
  }

  clearSessionState(sessionId: string): void {
    void this.closeNativeLocalServerTuiClient(sessionId).catch(() => undefined);
    this.clearTuiMuxRuntimeState(sessionId);
    this.clearNativeTuiRuntimeState(sessionId);
    this.nativeTuiSessionIds.delete(sessionId);
  }

  private nativeLocalTuiWarmState(sessionId: string): NativeLocalTuiWarmState {
    const existing = this.nativeLocalTuiWarmStates.get(sessionId);
    if (existing) {
      return existing;
    }
    const next = createNativeLocalTuiWarmState();
    this.nativeLocalTuiWarmStates.set(sessionId, next);
    return next;
  }

  private clearNativeLocalTuiIdleCloseTimer(sessionId: string): void {
    const timer = this.nativeLocalTuiIdleCloseTimers.get(sessionId);
    if (!timer) {
      return;
    }
    clearTimeout(timer);
    this.nativeLocalTuiIdleCloseTimers.delete(sessionId);
  }

  private clearNativeLocalTuiWarmState(sessionId: string): void {
    this.clearNativeLocalTuiIdleCloseTimer(sessionId);
    this.nativeLocalTuiWarmStates.delete(sessionId);
  }

  private claimNativeLocalTuiVisibleLease(
    sessionId: string,
    request: NativeTuiSurfaceClaimRequest,
  ): void {
    const state = this.nativeLocalTuiWarmState(sessionId);
    this.clearNativeLocalTuiIdleCloseTimer(sessionId);
    claimNativeLocalTuiWarmLease({
      state,
      sessionId,
      request,
      nowMs: Date.now(),
      attachedAt: new Date().toISOString(),
    });
  }

  private releaseNativeLocalTuiVisibleLease(
    sessionId: string,
    request: NativeTuiSurfaceReleaseRequest,
  ): void {
    const state = this.nativeLocalTuiWarmStates.get(sessionId);
    if (!state) {
      return;
    }
    releaseNativeLocalTuiWarmLease({
      state,
      request,
      nowMs: Date.now(),
      idleCloseMs: DEFAULT_NATIVE_LOCAL_TUI_IDLE_CLOSE_MS,
    });
    if (state.leases.size === 0 && this.ptySessions.has(sessionId)) {
      this.scheduleNativeLocalTuiIdleClose(sessionId);
    }
  }

  private scheduleNativeLocalTuiIdleClose(sessionId: string): void {
    this.clearNativeLocalTuiIdleCloseTimer(sessionId);
    const state = this.nativeLocalTuiWarmStates.get(sessionId);
    if (!state?.closeAfterMs) {
      return;
    }
    const delayMs = Math.max(1, state.closeAfterMs - Date.now());
    const timer = setTimeout(() => {
      this.nativeLocalTuiIdleCloseTimers.delete(sessionId);
      const current = this.nativeLocalTuiWarmStates.get(sessionId);
      if (!nativeLocalTuiWarmStateIdleExpired(current, Date.now())) {
        return;
      }
      void this.closeNativeLocalServerTuiClient(sessionId).catch((error) => {
        console.warn("[rah] failed to close idle native local TUI client", {
          sessionId,
          error,
        });
      });
    }, delayMs);
    timer.unref?.();
    this.nativeLocalTuiIdleCloseTimers.set(sessionId, timer);
  }

  private clearTuiMuxRuntimeState(sessionId: string): void {
    const tmux = this.tuiMuxSessions.get(sessionId);
    if (!tmux) {
      return;
    }
    tmux.subscription?.close();
    if (tmux.dumpTimer) {
      clearTimeout(tmux.dumpTimer);
    }
    if (tmux.subscriptionRestartTimer) {
      clearTimeout(tmux.subscriptionRestartTimer);
    }
    if (tmux.exitPollTimer) {
      clearInterval(tmux.exitPollTimer);
    }
    this.tuiMuxSessions.delete(sessionId);
  }

  private clearNativeTuiRuntimeState(sessionId: string): void {
    const native = this.nativeTuiSessions.get(sessionId);
    clearNativeTuiSessionTimers(native);
    this.nativeTuiDiagnostics.clearSession(sessionId);
    this.nativeTuiSessions.delete(sessionId);
  }

  handleNativeTuiInput(
    sessionId: string,
    clientId: string,
    text: string,
    options?: { clientMessageId?: string; clientTurnId?: string },
  ): boolean {
    const tmux = this.tuiMuxSessions.get(sessionId);
    if (tmux) {
      const native = this.nativeTuiSessions.get(sessionId);
      if (!native) {
        throw new Error("Native TUI process is not running.");
      }
      this.claimWebControl(sessionId, clientId);
      if (this.shouldQueueNativeTuiChatInput(native)) {
        const queued = enqueueNativeTuiQueuedInput(
          native,
          {
            clientId,
            text,
            queuedAt: new Date().toISOString(),
            ...(options?.clientMessageId !== undefined ? { clientMessageId: options.clientMessageId } : {}),
            ...(options?.clientTurnId !== undefined ? { clientTurnId: options.clientTurnId } : {}),
          },
          20,
        );
        if (!queued) {
          throw new Error("Native TUI input queue is full.");
        }
        this.updateNativeTuiPromptState(sessionId, native.promptState);
        void this.dumpTuiMuxScreen(tmux);
        return true;
      }
      this.injectNativeTuiChatInput(native, clientId, text, options);
      return true;
    }
    const native = this.nativeTuiSessions.get(sessionId);
    if (!native) {
      if (this.nativeTuiSessionIds.has(sessionId)) {
        throw new Error("Native TUI process is not running.");
      }
      return false;
    }
    this.claimWebControl(sessionId, clientId);
    if (this.shouldQueueNativeTuiChatInput(native)) {
      const queued = enqueueNativeTuiQueuedInput(
        native,
        {
          clientId,
          text,
          queuedAt: new Date().toISOString(),
          ...(options?.clientMessageId !== undefined ? { clientMessageId: options.clientMessageId } : {}),
          ...(options?.clientTurnId !== undefined ? { clientTurnId: options.clientTurnId } : {}),
        },
        20,
      );
      if (!queued) {
        throw new Error("Native TUI input queue is full.");
      }
      this.updateNativeTuiPromptState(sessionId, native.promptState);
      return true;
    }
    this.injectNativeTuiChatInput(native, clientId, text, options);
    return true;
  }

  private injectNativeTuiChatInput(
    native: NativeTuiSessionState,
    clientId: string,
    text: string,
    options?: { clientMessageId?: string; clientTurnId?: string },
  ): void {
    this.claimWebControl(native.sessionId, clientId);
    this.cancelNativeTuiPromptClear(native);
    const clearPromptBeforeSubmit =
      native.clearPromptBeforeNextInput === true ||
      isClaudeNativeTuiPassthrough(native) ||
      native.promptTracker.draftText.length > 0;
    native.promptTracker.draftText = "";
    native.lastInjectedInputAtMs = Date.now();
    registerSubmittedNativeTuiInput(native, {
      clientId,
      text,
      submittedAt: new Date().toISOString(),
      ...(options?.clientMessageId !== undefined ? { clientMessageId: options.clientMessageId } : {}),
      ...(options?.clientTurnId !== undefined ? { clientTurnId: options.clientTurnId } : {}),
    });
    if (!isClaudeNativeTuiPassthrough(native)) {
      this.updateNativeTuiPromptState(native.sessionId, "agent_busy");
    }
    // Drain already persisted mirror events after the new input watermark is
    // established, so stale persisted completions cannot briefly clear Stop.
    this.mirrorRuntime.mirrorSession(native.sessionId);
    delete native.clearPromptBeforeNextInput;
    this.writeNativeTuiChatSubmit(native, text, { clearPromptBeforeSubmit });
  }

  private writeNativeTuiChatSubmit(
    native: NativeTuiSessionState,
    text: string,
    options?: { clearPromptBeforeSubmit?: boolean },
  ): void {
    const tmux = this.tuiMuxSessions.get(native.sessionId);
    if (tmux) {
      void this.withTuiMuxActionSurface(tmux, async () => {
        if (options?.clearPromptBeforeSubmit) {
          await this.sendTuiMuxClearPrompt(tmux);
          // tmux action send-keys returns after enqueueing synthesized keys,
          // not necessarily after the target TUI has consumed them. Give the
          // clear sequence a short deterministic settle window so the next
          // raw write is not erased by a delayed Ctrl-K/Ctrl-U.
          await new Promise((resolve) => setTimeout(resolve, TUI_MUX_CLEAR_PROMPT_SETTLE_MS));
        }
        await this.writeTuiMuxText(tmux, text);
        for (let index = 0; index < nativeTuiSubmitCountForProvider(native.provider); index += 1) {
          await new Promise((resolve) => setTimeout(resolve, NATIVE_TUI_SUBMIT_DELAY_MS));
          await this.writeTuiMuxInput(tmux, nativeTuiSubmitDataForProvider(native.provider));
        }
      })
        .then(
          () => {
            void this.pollTuiMuxExit(tmux.sessionId);
          },
          (error) => {
            void this.pollTuiMuxExit(tmux.sessionId);
            this.handleTuiMuxInputFailure(tmux, error);
          },
        );
    } else {
      const prefix = options?.clearPromptBeforeSubmit ? NATIVE_TUI_CLEAR_PROMPT_DATA : "";
      native.process.write(`${prefix}${text}`);
      const submitOnce = (remaining: number) => {
        const current = this.nativeTuiSessions.get(native.sessionId);
        if (current === native) {
          current.process.write(nativeTuiSubmitDataForProvider(current.provider));
        }
        if (remaining > 1) {
          const nextTimer = setTimeout(() => submitOnce(remaining - 1), NATIVE_TUI_SUBMIT_DELAY_MS);
          nextTimer.unref?.();
        }
      };
      const timer = setTimeout(
        () => submitOnce(nativeTuiSubmitCountForProvider(native.provider)),
        NATIVE_TUI_SUBMIT_DELAY_MS,
      );
      timer.unref?.();
    }
  }

  private shouldQueueNativeTuiChatInput(native: NativeTuiSessionState): boolean {
    if (isClaudeNativeTuiPassthrough(native)) {
      return false;
    }
    return (
      native.promptState !== "prompt_clean" ||
      native.promptTracker.draftText.length > 0 ||
      hasRecentInjectedInput(native)
    );
  }

  private scheduleNativeTuiQueuedDrain(native: NativeTuiSessionState): void {
    if (native.queuedDrainTimer) {
      return;
    }
    const delayMs = Math.max(25, remainingRecentInjectedInputMs(native) + 10);
    native.queuedDrainTimer = setTimeout(() => {
      delete native.queuedDrainTimer;
      const current = this.nativeTuiSessions.get(native.sessionId);
      if (
        current !== native ||
        current.promptState !== "prompt_clean" ||
        current.promptTracker.draftText.length > 0 ||
        current.queuedInputs.length === 0 ||
        hasRecentInjectedInput(current)
      ) {
        return;
      }
      this.updateNativeTuiPromptState(current.sessionId, "prompt_clean");
    }, delayMs);
    native.queuedDrainTimer.unref?.();
  }

  handleNativeTuiInterrupt(sessionId: string, clientId: string): boolean {
    const tmux = this.tuiMuxSessions.get(sessionId);
    if (tmux) {
      const native = this.nativeTuiSessions.get(sessionId);
      this.claimWebControl(sessionId, clientId);
      const activeTurnId = this.deps.sessionStore.getSession(sessionId)?.activeTurnId;
      if (native) {
        if (usesBestEffortEscNativeTuiInterrupt(native)) {
          cancelNativeTuiQueuedInputsForClient(native, clientId);
          native.promptTracker.draftText = "";
          delete native.lastInjectedInputAtMs;
          native.clearPromptBeforeNextInput = true;
          this.sendTuiMuxInterrupt(tmux, native.provider);
          this.scheduleBestEffortEscNativeTuiPromptClear(native);
          this.updateNativeTuiPromptState(sessionId, "prompt_clean");
          return true;
        }
        if (native.stopPending) {
          return true;
        }
        const currentState = this.deps.sessionStore.getSession(sessionId);
        if (isIdleNativeTuiInterruptRequest(native, currentState, activeTurnId)) {
          return true;
        }
        cancelNativeTuiQueuedInputsForClient(native, clientId);
        native.promptTracker.draftText = "";
        delete native.lastInjectedInputAtMs;
        native.clearPromptBeforeNextInput = true;
        native.stopPending = true;
        native.stopTurnId = nativeTuiInterruptTurnId(native, activeTurnId);
        this.scheduleNativeTuiInterruptConfirmation(native);
        if (currentState?.session.runtimeState !== "running") {
          this.deps.sessionStore.setRuntimeState(sessionId, "running");
          publishSessionStateChanged(this.deps, sessionId, "running");
        }
      }
      this.sendTuiMuxInterrupt(tmux, native?.provider ?? "codex");
      this.deps.eventBus.publish({
        sessionId,
        type: "runtime.status",
        source: SYSTEM_SOURCE,
        payload: { status: "stopping", detail: "Interrupt requested" },
        ...(activeTurnId ? { turnId: activeTurnId } : {}),
      });
      return true;
    }
    const native = this.nativeTuiSessions.get(sessionId);
    if (!native) {
      if (this.nativeTuiSessionIds.has(sessionId)) {
        throw new Error("Native TUI process is not running.");
      }
      return false;
    }
    this.claimWebControl(sessionId, clientId);
    const queuedInputCount = native.queuedInputs.length;
    if (usesBestEffortEscNativeTuiInterrupt(native)) {
      cancelNativeTuiQueuedInputsForClient(native, clientId);
      this.writeNativeTuiInterrupt(native);
      native.promptTracker.draftText = "";
      delete native.lastInjectedInputAtMs;
      native.clearPromptBeforeNextInput = true;
      this.scheduleBestEffortEscNativeTuiPromptClear(native);
      this.updateNativeTuiPromptState(sessionId, "prompt_clean");
      return true;
    }
    if (native.stopPending) {
      return true;
    }
    const activeTurnId = this.deps.sessionStore.getSession(sessionId)?.activeTurnId;
    const currentState = this.deps.sessionStore.getSession(sessionId);
    if (isIdleNativeTuiInterruptRequest(native, currentState, activeTurnId)) {
      return true;
    }
    cancelNativeTuiQueuedInputsForClient(native, clientId);
    this.writeNativeTuiInterrupt(native);
    native.promptTracker.draftText = "";
    delete native.lastInjectedInputAtMs;
    native.clearPromptBeforeNextInput = true;
    native.stopPending = true;
    native.stopTurnId = nativeTuiInterruptTurnId(native, activeTurnId);
    this.scheduleNativeTuiInterruptConfirmation(native);
    if (queuedInputCount !== native.queuedInputs.length) {
      this.updateNativeTuiPromptState(sessionId, native.promptState);
    }
    this.deps.eventBus.publish({
      sessionId,
      type: "runtime.status",
      source: SYSTEM_SOURCE,
      payload: { status: "stopping", detail: "Interrupt requested" },
      ...(activeTurnId ? { turnId: activeTurnId } : {}),
    });
    return true;
  }

  private writeNativeTuiInterrupt(native: NativeTuiSessionState): void {
    if (native.provider !== "opencode") {
      native.process.write(nativeTuiInterruptDataForProvider(native.provider));
      for (const retryDelay of [350, 900]) {
        const timer = setTimeout(() => {
          const current = this.nativeTuiSessions.get(native.sessionId);
          if (current === native && current.stopPending) {
            current.process.write(nativeTuiInterruptDataForProvider(current.provider));
          }
        }, retryDelay);
        timer.unref?.();
      }
      return;
    }
    native.process.write("\u001b");
    const timer = setTimeout(() => {
      const current = this.nativeTuiSessions.get(native.sessionId);
      if (current === native) {
        current.process.write("\u001b");
      }
    }, OPENCODE_SECOND_INTERRUPT_DELAY_MS);
    timer.unref?.();
  }

  private clearNativeTuiPromptInput(native: NativeTuiSessionState): void {
    native.promptTracker.draftText = "";
    delete native.clearPromptBeforeNextInput;
    const tmux = this.tuiMuxSessions.get(native.sessionId);
    if (tmux) {
      void this.withTuiMuxActionSurface(tmux, async () => {
        await this.sendTuiMuxClearPrompt(tmux);
      }).catch((error) => {
        this.handleTuiMuxInputFailure(tmux, error);
      });
      return;
    }
    native.process.write(NATIVE_TUI_CLEAR_PROMPT_DATA);
  }

  private scheduleBestEffortEscNativeTuiPromptClear(native: NativeTuiSessionState): void {
    this.cancelNativeTuiPromptClear(native);
    const scheduledAtMs = Date.now();
    native.promptClearScheduledAtMs = scheduledAtMs;
    native.promptClearTimer = setTimeout(() => {
      const current = this.nativeTuiSessions.get(native.sessionId);
      if (current !== native) {
        return;
      }
      delete current.promptClearTimer;
      delete current.promptClearScheduledAtMs;
      if (!usesBestEffortEscNativeTuiInterrupt(current)) {
        return;
      }
      if (
        current.lastInjectedInputAtMs !== undefined &&
        current.lastInjectedInputAtMs >= scheduledAtMs
      ) {
        return;
      }
      this.clearNativeTuiPromptInput(current);
    }, NATIVE_TUI_SUBMIT_DELAY_MS);
    native.promptClearTimer.unref?.();
  }

  private cancelNativeTuiPromptClear(native: NativeTuiSessionState): void {
    if (native.promptClearTimer) {
      clearTimeout(native.promptClearTimer);
      delete native.promptClearTimer;
    }
    delete native.promptClearScheduledAtMs;
  }

  private sendTuiMuxInterrupt(tmux: TuiMuxSessionState, provider: ProviderKind): void {
    const sendEsc = async (count = 1): Promise<void> => {
      await tmux.muxRuntime.sendKeys(
        tmux.muxSessionName,
        tmux.paneId,
        Array.from({ length: count }, () => "Esc"),
      );
    };
    void this.withTuiMuxActionSurface(tmux, async () => {
      if (provider === "opencode") {
        await sendEsc(2);
        return;
      }
      await sendEsc();
      const retryDelays = [350, 900];
      for (const retryDelay of retryDelays) {
        await new Promise((resolve) => setTimeout(resolve, retryDelay));
        const native = this.nativeTuiSessions.get(tmux.sessionId);
        if (!this.isCurrentTuiMuxSession(tmux)) {
          break;
        }
        if (!native?.stopPending) {
          break;
        }
        await sendEsc();
      }
    }).catch((error) => {
      this.handleTuiMuxInputFailure(tmux, error);
    });
  }

  private async sendTuiMuxClearPrompt(tmux: TuiMuxSessionState): Promise<void> {
    // tmux action write can inject control bytes as literal composer text in
    // raw-mode TUIs. send-keys asks tmux to synthesize terminal key events.
    await tmux.muxRuntime.sendKeys(tmux.muxSessionName, tmux.paneId, [
      "Ctrl a",
      "Ctrl k",
      "Ctrl u",
    ]);
  }

  private scheduleNativeTuiInterruptConfirmation(native: NativeTuiSessionState): void {
    if (native.stopTimer) {
      clearTimeout(native.stopTimer);
    }
    native.stopTimer = setTimeout(() => {
      const current = this.nativeTuiSessions.get(native.sessionId);
      if (!current?.stopPending) {
        return;
      }
      current.promptTracker.draftText = "";
      delete current.lastInjectedInputAtMs;
      this.completeNativeTuiInterrupt(current);
      this.updateNativeTuiPromptState(current.sessionId, "prompt_clean");
    }, NATIVE_TUI_INTERRUPT_CONFIRM_TIMEOUT_MS);
    native.stopTimer.unref?.();
  }

  private completeNativeTuiInterrupt(native: NativeTuiSessionState): void {
    if (!native.stopPending) {
      return;
    }
    const sessionId = native.sessionId;
    const activeTurnId = this.deps.sessionStore.getSession(sessionId)?.activeTurnId;
    const turnId = native.stopTurnId ?? activeTurnId;
    if (native.stopTimer) {
      clearTimeout(native.stopTimer);
      delete native.stopTimer;
    }
    delete native.stopPending;
    delete native.stopTurnId;
    native.lastInterruptCompletedAtMs = Date.now();
    if (activeTurnId) {
      this.deps.sessionStore.setActiveTurn(sessionId, undefined);
    }
    if (!turnId) {
      return;
    }
    const reconciled = reconcileTurnLifecycleActivity(this.deps, sessionId, {
      type: "turn_canceled",
      turnId,
      reason: "interrupted",
    });
    if (reconciled !== null) {
      this.deps.eventBus.publish({
        sessionId,
        type: "turn.canceled",
        source: SYSTEM_SOURCE,
        payload: {
          reason: reconciled.activity.reason,
          ...(reconciled.identity !== undefined ? { identity: reconciled.identity } : {}),
        },
        turnId: reconciled.activity.turnId,
      });
    }
  }

  private claimWebControl(sessionId: string, clientId: string): void {
    const state = ensureClientAttachedAndPublish(this.deps, {
      sessionId,
      client: {
        id: clientId,
        kind: "web",
        connectionId: clientId,
      },
      mode: "interactive",
    });
    if (!state) {
      return;
    }
    if (this.deps.sessionStore.hasInputControl(sessionId, clientId)) {
      return;
    }
    claimClientControlAndPublish(this.deps, {
      sessionId,
      clientId,
      clientKind: "web",
    });
  }

  private observeNativeTuiPtyInput(native: NativeTuiSessionState, data: string): void {
    if (isPromptResetControlInput(data)) {
      native.promptTracker.draftText = "";
      delete native.lastInjectedInputAtMs;
      native.clearPromptBeforeNextInput = true;
      this.updateNativeTuiPromptState(native.sessionId, "prompt_clean");
      return;
    }
    const nextPromptState = applyLocalTerminalInput({
      tracker: native.promptTracker,
      promptState: native.promptState,
      data,
    });
    this.updateNativeTuiPromptState(native.sessionId, nextPromptState);
  }

  private updateNativeTuiPromptState(
    sessionId: string,
    promptState: NativeTuiPromptState,
  ): void {
    const native = this.nativeTuiSessions.get(sessionId);
    const existingState = this.deps.sessionStore.getSession(sessionId);
    if (!native || !existingState) {
      return;
    }
    native.promptState = promptState;
    if (promptState === "prompt_clean") {
      if (!hasRecentInjectedInput(native)) {
        delete native.lastInjectedInputAtMs;
      }
      if (native.stopPending && native.clearPromptBeforeNextInput) {
        this.clearNativeTuiPromptInput(native);
      }
      this.completeNativeTuiInterrupt(native);
    }
    this.deps.sessionStore.patchManagedSession(sessionId, {
      nativeTui: {
        terminalId: sessionId,
        viewAvailable: true,
        promptState,
        queuedInputCount: native.queuedInputs.length,
      },
    });
    this.deps.eventBus.publish({
      sessionId,
      type: "session.native_tui.prompt_state.changed",
      source: SYSTEM_SOURCE,
      payload: { promptState, queuedInputCount: native.queuedInputs.length },
    });
    const nextRuntimeState = isClaudeNativeTuiPassthrough(native)
      ? "idle"
      : native.stopPending || native.queuedInputs.length > 0
        ? "running"
        : promptState === "agent_busy"
          ? "running"
          : "idle";
    if (existingState.session.runtimeState !== nextRuntimeState) {
      this.deps.sessionStore.setRuntimeState(sessionId, nextRuntimeState);
      publishSessionStateChanged(this.deps, sessionId, nextRuntimeState);
    }
    if (
      promptState !== "prompt_clean" ||
      native.promptTracker.draftText.length > 0 ||
      native.queuedInputs.length === 0
    ) {
      return;
    }
    if (hasRecentInjectedInput(native)) {
      this.scheduleNativeTuiQueuedDrain(native);
      return;
    }
    const queued = dequeueNativeTuiQueuedInput(native);
    if (!queued) {
      return;
    }
    this.injectNativeTuiChatInput(native, queued.clientId, queued.text, {
      ...(queued.clientMessageId !== undefined ? { clientMessageId: queued.clientMessageId } : {}),
      ...(queued.clientTurnId !== undefined ? { clientTurnId: queued.clientTurnId } : {}),
    });
  }

  getNativeTuiSurface(sessionId: string): NativeTuiSurfaceResponse {
    const tmux = this.tuiMuxSessions.get(sessionId);
    return tmux ? this.tuiMuxSurfaceResponse(tmux) : {};
  }

  async claimNativeTuiSurface(
    sessionId: string,
    request: NativeTuiSurfaceClaimRequest,
  ): Promise<NativeTuiSurfaceResponse> {
    const tmux = this.tuiMuxSessions.get(sessionId);
    if (!tmux) {
      if (await this.ensureNativeLocalServerTuiClient(sessionId, request)) {
        this.claimNativeLocalTuiVisibleLease(sessionId, request);
        return {};
      }
      return {};
    }
    const surface: NativeTuiSurfaceState = {
      sessionId,
      clientId: request.clientId,
      clientKind: request.clientKind,
      ...(request.cols !== undefined ? { cols: Math.max(20, Math.floor(request.cols)) } : {}),
      ...(request.rows !== undefined ? { rows: Math.max(8, Math.floor(request.rows)) } : {}),
      attachedAt: new Date().toISOString(),
    };
    tmux.activeSurface = surface;
    if (surface.cols !== undefined && surface.rows !== undefined) {
      await tmux.muxRuntime.resizePane?.(
        tmux.muxSessionName,
        tmux.paneId,
        surface.cols,
        surface.rows,
      );
    }
    this.deps.ptyHub.resetSession(sessionId);
    await this.dumpTuiMuxScreen(tmux);
    return this.tuiMuxSurfaceResponse(tmux);
  }

  async releaseNativeTuiSurface(
    sessionId: string,
    request: NativeTuiSurfaceReleaseRequest,
  ): Promise<NativeTuiSurfaceResponse> {
    const tmux = this.tuiMuxSessions.get(sessionId);
    if (!tmux) {
      this.releaseNativeLocalTuiVisibleLease(sessionId, request);
      return {};
    }
    if (tmux.activeSurface?.clientId !== request.clientId) {
      return this.tuiMuxSurfaceResponse(tmux);
    }
    delete tmux.activeSurface;
    return {};
  }

  async closeNativeTuiClient(
    sessionId: string,
    request: NativeTuiClientCloseRequest,
  ): Promise<NativeTuiSurfaceResponse> {
    const tmux = this.tuiMuxSessions.get(sessionId);
    if (tmux) {
      return await this.releaseNativeTuiSurface(sessionId, request);
    }
    const current = this.deps.sessionStore.getSession(sessionId);
    if (current?.session.liveBackend !== "native_local_server") {
      return {};
    }
    this.releaseNativeLocalTuiVisibleLease(sessionId, request);
    return {};
  }

  async ensureNativeLocalServerTuiClient(
    sessionId: string,
    request?: NativeTuiSurfaceClaimRequest,
  ): Promise<boolean> {
    const state = this.deps.sessionStore.getSession(sessionId);
    if (!state) {
      return false;
    }
    const spec = state.session.liveBackend === "native_local_server"
      ? nativeLocalServerAttachSpec({
          provider: state.session.provider,
          providerSessionId: state.session.providerSessionId,
          endpoint: state.session.runtimeDiagnostics?.serverEndpoint,
        })
      : null;
    if (!spec) {
      return false;
    }
    if (request) {
      ensureClientAttachedAndPublish(this.deps, {
        sessionId,
        client: {
          id: request.clientId,
          kind: request.clientKind,
          connectionId: request.clientId,
        },
        mode: "interactive",
      });
      if (!this.deps.sessionStore.hasInputControl(sessionId, request.clientId)) {
        claimClientControlAndPublish(this.deps, {
          sessionId,
          clientId: request.clientId,
          clientKind: request.clientKind,
        });
      }
    }
    this.deps.sessionStore.patchManagedSession(sessionId, {
      nativeTui: {
        terminalId: sessionId,
        viewAvailable: true,
        promptState: "prompt_clean",
        queuedInputCount: 0,
      },
      capabilities: {
        nativeTui: true,
        rawPtyInput: true,
      },
      runtimeDiagnostics: {
        ...(state.session.runtimeDiagnostics ?? {}),
        attachCommand: spec.attachCommand,
        attachState: this.ptySessions.has(sessionId) ? "ready" : "unverified",
      },
    });
    if (this.ptySessions.has(sessionId)) {
      return true;
    }
    this.deps.ptyHub.resetSession(sessionId);
    this.deps.ptyHub.appendOutput(
      sessionId,
      `\r\n[rah] Starting ${state.session.provider} TUI client...\r\n`,
    );
    try {
      const terminal = this.ptySessions.create({
        id: sessionId,
        cwd: state.session.cwd,
        ...(request?.cols !== undefined ? { cols: request.cols } : {}),
        ...(request?.rows !== undefined ? { rows: request.rows } : {}),
        command: spec.command,
        args: spec.args,
        onData: (terminalId, data) => {
          this.deps.ptyHub.appendOutput(terminalId, data);
          this.observeNativeTuiOutput(terminalId, data);
          this.scheduleNativeTuiMirrorWake(terminalId);
        },
        onExit: (terminalId, exitArgs) => {
          this.clearNativeLocalTuiWarmState(terminalId);
          this.deps.ptyHub.emitExit(terminalId, exitArgs.exitCode, exitArgs.signal);
          const current = this.deps.sessionStore.getSession(terminalId);
          if (!current) {
            return;
          }
          const exitError = `TUI client exited${exitArgs.exitCode !== undefined ? ` with code ${exitArgs.exitCode}` : ""}`;
          this.deps.sessionStore.patchManagedSession(terminalId, {
            nativeTui: {
              terminalId,
              viewAvailable: true,
              promptState: "prompt_clean",
              queuedInputCount: 0,
            },
            runtimeDiagnostics: {
              ...(current.session.runtimeDiagnostics ?? {}),
              attachState: "unavailable",
              lastError:
                current.session.runtimeDiagnostics?.lastError?.trim() || exitError,
            },
          });
        },
      });
      void terminal.process.waitUntilReady()
        .then(() => {
          const latest = this.deps.sessionStore.getSession(sessionId);
          if (!latest || !this.ptySessions.has(sessionId)) {
            return;
          }
          this.deps.sessionStore.patchManagedSession(sessionId, {
            runtimeDiagnostics: {
              ...(latest.session.runtimeDiagnostics ?? {}),
              attachCommand: spec.attachCommand,
              attachState: "ready",
            },
          });
        })
        .catch((error) => {
          void this.ptySessions.close(sessionId).catch(() => undefined);
          const current = this.deps.sessionStore.getSession(sessionId);
          if (!current) {
            return;
          }
          this.deps.sessionStore.patchManagedSession(sessionId, {
            runtimeDiagnostics: {
              ...(current.session.runtimeDiagnostics ?? {}),
              attachCommand: spec.attachCommand,
              attachState: "failed",
              lastError: error instanceof Error ? error.message : String(error),
            },
          });
        });
      return true;
    } catch (error) {
      await this.ptySessions.close(sessionId).catch(() => undefined);
      const current = this.deps.sessionStore.getSession(sessionId);
      if (current) {
        this.deps.sessionStore.patchManagedSession(sessionId, {
          runtimeDiagnostics: {
            ...(current.session.runtimeDiagnostics ?? {}),
            attachCommand: spec.attachCommand,
            attachState: "failed",
            lastError: error instanceof Error ? error.message : String(error),
          },
        });
      }
      throw error;
    }
  }

  async closeNativeLocalServerTuiClient(sessionId: string): Promise<boolean> {
    this.clearNativeLocalTuiWarmState(sessionId);
    if (!this.ptySessions.has(sessionId)) {
      return false;
    }
    await this.ptySessions.close(sessionId);
    return true;
  }

  handlePtyInput(sessionId: string, clientId: string, data: string): boolean {
    const tmux = this.tuiMuxSessions.get(sessionId);
    if (tmux) {
      this.assertTuiMuxSurface(tmux, clientId);
      const native = this.nativeTuiSessions.get(sessionId);
      void this.writeTuiMuxInput(tmux, data)
        .then(() => {
          if (native) {
            this.observeNativeTuiPtyInput(native, data);
          }
        })
        .catch((error) => {
          this.handleTuiMuxInputFailure(tmux, error);
        });
      return true;
    }
    if (!this.ptySessions.has(sessionId)) {
      return false;
    }
    const native = this.nativeTuiSessions.get(sessionId);
    const wrote = this.ptySessions.write(sessionId, data);
    if (wrote && native) {
      this.observeNativeTuiPtyInput(native, data);
    }
    return wrote;
  }

  handlePtyResize(sessionId: string, clientId: string, cols: number, rows: number): boolean {
    const tmux = this.tuiMuxSessions.get(sessionId);
    if (tmux) {
      if (!tmux.activeSurface) {
        void this.claimNativeTuiSurface(sessionId, {
          clientId,
          clientKind: "web",
          cols,
          rows,
        }).catch((error) => this.handleTuiMuxInputFailure(tmux, error));
      } else if (tmux.activeSurface.clientId === clientId) {
        tmux.activeSurface = {
          ...tmux.activeSurface,
          cols: Math.max(20, Math.floor(cols)),
          rows: Math.max(8, Math.floor(rows)),
        };
        void tmux.muxRuntime.resizePane?.(tmux.muxSessionName, tmux.paneId, cols, rows)
          .then(() => this.dumpTuiMuxScreen(tmux))
          .catch((error) => this.handleTuiMuxInputFailure(tmux, error));
      }
      return true;
    }
    return this.ptySessions.resize(sessionId, cols, rows);
  }

  private assertTuiMuxSurface(tmux: TuiMuxSessionState, clientId: string): void {
    if (!tmux.activeSurface) {
      throw new Error("No active TUI display surface. Open the TUI view before sending terminal input.");
    }
    if (tmux.activeSurface.clientId !== clientId) {
      throw new Error(
        `TUI display is controlled by ${tmux.activeSurface.clientKind}; reclaim it before sending terminal input.`,
      );
    }
  }

  private shouldUseTuiMuxSizingClient(kind: ClientKind): boolean {
    return kind !== "terminal";
  }

  private tuiMuxSurfaceResponse(tmux?: TuiMuxSessionState): NativeTuiSurfaceResponse {
    if (!tmux?.activeSurface) {
      return {};
    }
    return { surface: { ...tmux.activeSurface } };
  }

  async startIndependentTerminal(
    request?: IndependentTerminalStartRequest,
  ): Promise<IndependentTerminalStartResponse> {
    const requestedCwd = resolveUserPath(request?.cwd || "~");
    let cwd = requestedCwd;
    try {
      const directoryStat = await import("node:fs/promises").then(({ stat }) => stat(requestedCwd));
      if (!directoryStat.isDirectory()) {
        cwd = resolveUserPath("~");
      }
    } catch {
      cwd = resolveUserPath("~");
    }
    const id = crypto.randomUUID();
    const owner = normalizeIndependentTerminalOwner(request?.owner);
    this.deps.ptyHub.ensureSession(id);
    let terminal: PtySessionRuntimeEntry;
    try {
      terminal = await this.ptySessions.start({
        id,
        cwd,
        ...(request?.cols !== undefined ? { cols: request.cols } : {}),
        ...(request?.rows !== undefined ? { rows: request.rows } : {}),
        onData: (terminalId, data) => {
          this.deps.ptyHub.appendOutput(terminalId, data);
        },
        onExit: (terminalId, args) => {
          this.independentTerminals.delete(terminalId);
          this.deps.ptyHub.emitExit(terminalId, args.exitCode, args.signal);
        },
      });
    } catch (error) {
      this.deps.ptyHub.removeSession(id);
      throw error;
    }
    const session = {
      id,
      cwd,
      shell: terminal.shell,
      ...(owner ? { owner } : {}),
    };
    this.independentTerminals.set(id, session);
    return {
      terminal: session,
    };
  }

  listIndependentTerminals(request?: {
    cwd?: string;
    owner?: IndependentTerminalStartRequest["owner"];
  }): IndependentTerminalStartResponse["terminal"][] {
    const cwd = request?.cwd ? resolveUserPath(request.cwd) : null;
    const owner = normalizeIndependentTerminalOwner(request?.owner);
    return Array.from(this.independentTerminals.values())
      .filter((terminal) => !cwd || terminal.cwd === cwd)
      .filter((terminal) =>
        !owner || (terminal.owner?.kind === owner.kind && terminal.owner.id === owner.id),
      )
      .sort((a, b) => a.cwd.localeCompare(b.cwd) || a.id.localeCompare(b.id));
  }

  async closeIndependentTerminal(id: string): Promise<void> {
    this.independentTerminals.delete(id);
    const closed = await this.ptySessions.close(id);
    if (closed) {
      this.deps.ptyHub.removeSession(id);
    }
  }

  async startNativeTuiSession(args: {
    launch: NativeTuiLaunchSpec;
    attach?: StartSessionRequest["attach"];
    providerSessionId?: string;
    origin?: StartSessionRequest["origin"];
  }): Promise<StartSessionResponse> {
    const sessionId = crypto.randomUUID();
    const providerSessionId = args.providerSessionId ?? args.launch.providerSessionId;
    const startupTimestampMs = Date.now();
    const launchSource = args.attach?.client.kind === "terminal" ? "terminal" : "web";
    const initialPromptState = initialNativeTuiPromptState(args.launch.provider);
    this.deps.sessionStore.createManagedSession({
      id: sessionId,
      provider: args.launch.provider,
      ...(providerSessionId ? { providerSessionId } : {}),
      ...(args.origin ? { origin: args.origin } : {}),
      launchSource,
      liveBackend: "native_tui",
      cwd: args.launch.cwd,
      rootDir: args.launch.cwd,
      title: args.launch.title,
      preview: args.launch.preview,
      nativeTui: {
        terminalId: sessionId,
        viewAvailable: true,
        promptState: initialPromptState,
        queuedInputCount: 0,
      },
      ptyId: sessionId,
      ...nativeTuiStartupSessionPatch(args.launch),
      capabilities: buildNativeTuiSessionCapabilities(args.launch.provider),
    });
    this.deps.ptyHub.ensureSession(sessionId);

    if (args.attach) {
      attachClientAndMaybeClaimControl(this.deps, {
        sessionId,
        client: args.attach.client,
        mode: args.attach.mode,
        ...(args.attach.claimControl !== undefined
          ? { claimControl: args.attach.claimControl }
          : {}),
      });
    }

    publishSessionCreatedAndStarted(this.deps, sessionId);

    let terminal: PtySessionRuntimeEntry;
    try {
      terminal = this.ptySessions.create({
        id: sessionId,
        cwd: args.launch.cwd,
        ...(args.attach?.client.cols !== undefined ? { cols: args.attach.client.cols } : {}),
        ...(args.attach?.client.rows !== undefined ? { rows: args.attach.client.rows } : {}),
        command: args.launch.command,
        args: args.launch.args,
        ...(args.launch.env ? { env: args.launch.env } : {}),
        onData: (terminalId, data) => {
          this.deps.ptyHub.appendOutput(terminalId, data);
          this.observeNativeTuiOutput(terminalId, data);
          this.scheduleNativeTuiMirrorWake(terminalId);
        },
        onExit: (terminalId, exitArgs) => {
          const native = this.nativeTuiSessions.get(terminalId);
          const expectedClose = this.closingNativeTuiSessionIds.has(terminalId);
          const exitError = expectedClose ? undefined : nativeTuiExitErrorFromOutput(native);
          this.clearNativeTuiRuntimeState(terminalId);
          this.closingNativeTuiSessionIds.delete(terminalId);
          this.deps.ptyHub.emitExit(terminalId, exitArgs.exitCode, exitArgs.signal);
          const currentState = this.deps.sessionStore.getSession(terminalId);
          if (currentState) {
            const runtimeDiagnostics = exitError
              ? {
                  ...(currentState.session.runtimeDiagnostics ?? {}),
                  lastError: currentState.session.runtimeDiagnostics?.lastError ?? exitError,
                }
              : undefined;
            this.deps.sessionStore.patchManagedSession(terminalId, {
              capabilities: buildStoppedNativeTuiSessionCapabilities(currentState.session.provider),
              nativeTui: {
                terminalId,
                viewAvailable: true,
                promptState: "prompt_clean",
                queuedInputCount: 0,
              },
              ...(runtimeDiagnostics ? { runtimeDiagnostics } : {}),
            });
            this.deps.sessionStore.setActiveTurn(terminalId, undefined);
            const runtimeState = exitError ? "failed" : "stopped";
            this.deps.sessionStore.setRuntimeState(terminalId, runtimeState);
            publishSessionStateChanged(this.deps, terminalId, runtimeState);
          }
          if (native && !expectedClose) {
            recordNativeTuiProcessExitDiagnostic(this.nativeTuiDiagnostics, native, exitArgs);
          }
        },
      });
    } catch (error) {
      this.clearNativeTuiRuntimeState(sessionId);
      this.nativeTuiSessionIds.delete(sessionId);
      this.deps.ptyHub.removeSession(sessionId);
      this.deps.sessionStore.removeSession(sessionId);
      throw error;
    }
    this.nativeTuiSessions.set(sessionId, {
      sessionId,
      process: terminal.process,
      provider: args.launch.provider,
      cwd: args.launch.cwd,
      startupTimestampMs,
      ...(args.launch.env ? { launchEnv: args.launch.env } : {}),
      promptState: initialPromptState,
      promptTracker: { draftText: "" },
      queuedInputs: [],
      ...(providerSessionId ? { providerSessionId } : {}),
    });
    this.nativeTuiSessionIds.add(sessionId);
    this.startNativeTuiBindingProbe(sessionId);
    this.mirrorRuntime.startSessionMirror(sessionId);

    try {
      await terminal.process.waitUntilReady();
    } catch (error) {
      await this.ptySessions.close(sessionId).catch(() => undefined);
      this.clearNativeTuiRuntimeState(sessionId);
      this.nativeTuiSessionIds.delete(sessionId);
      this.deps.ptyHub.removeSession(sessionId);
      this.deps.sessionStore.removeSession(sessionId);
      throw error;
    }

    const native = this.nativeTuiSessions.get(sessionId);
    const runtimeState = "idle";
    const readyState = this.deps.sessionStore.setRuntimeState(sessionId, runtimeState);
    publishSessionStateChanged(this.deps, sessionId, runtimeState);
    return { session: toSessionSummary(readyState) };
  }

  async startTuiMuxSession(args: {
    launch: NativeTuiLaunchSpec;
    attach?: StartSessionRequest["attach"];
    providerSessionId?: string;
    origin?: StartSessionRequest["origin"];
  }): Promise<StartSessionResponse> {
    const launch = appendCodexTuiMuxArgs(args.launch);
    const sessionId = crypto.randomUUID();
    const providerSessionId = args.providerSessionId ?? launch.providerSessionId;
    const startupTimestampMs = Date.now();
    const launchSource = args.attach?.client.kind === "terminal" ? "terminal" : "web";
    const initialPromptState = initialTuiMuxPromptState(launch.provider);
    const muxBackendKind = this.preferredTuiMuxBackendKind;
    const muxRuntime = this.muxRuntimeForKind(muxBackendKind);
    const muxSessionName = this.muxSessionNameForRahSession(sessionId, muxBackendKind);
    const muxPatch = {
      backend: muxBackendKind,
      sessionName: muxSessionName,
      paneId: "pending",
    } satisfies ManagedSession["mux"];
    this.deps.sessionStore.createManagedSession({
      id: sessionId,
      provider: launch.provider,
      ...(providerSessionId ? { providerSessionId } : {}),
      ...(args.origin ? { origin: args.origin } : {}),
      launchSource,
      liveBackend: "tui_mux",
      cwd: launch.cwd,
      rootDir: launch.cwd,
      title: launch.title,
      preview: launch.preview,
      nativeTui: {
        terminalId: sessionId,
        viewAvailable: true,
        promptState: initialPromptState,
        queuedInputCount: 0,
      },
      mux: muxPatch,
      ptyId: sessionId,
      ...nativeTuiStartupSessionPatch(launch),
      capabilities: buildTuiMuxSessionCapabilities(launch.provider),
    });
    this.deps.ptyHub.ensureSession(sessionId);

    if (args.attach) {
      attachClientAndMaybeClaimControl(this.deps, {
        sessionId,
        client: args.attach.client,
        mode: args.attach.mode,
        ...(args.attach.claimControl !== undefined
          ? { claimControl: args.attach.claimControl }
          : {}),
      });
    }

    publishSessionCreatedAndStarted(this.deps, sessionId);

    let tmux: TuiMuxSessionState | undefined;
    try {
      const created = await muxRuntime.createSession({
        sessionName: muxSessionName,
        cwd: launch.cwd,
        command: launch.command,
        args: launch.args,
        ...(launch.env ? { env: launch.env } : {}),
        title: `${launch.provider}-${sessionId.slice(0, 8)}`,
        replaceDefaultPane: true,
      });
      tmux = this.registerTuiMuxRuntime({
        sessionId,
        provider: launch.provider,
        cwd: launch.cwd,
        ...(providerSessionId ? { providerSessionId } : {}),
        promptState: initialPromptState,
        startupTimestampMs,
        ...(launch.env ? { launchEnv: launch.env } : {}),
        muxSessionName,
        paneId: created.paneId,
        muxBackendKind,
        muxRuntime,
      });
      this.deps.sessionStore.patchManagedSession(sessionId, {
        mux: {
          backend: muxBackendKind,
          sessionName: muxSessionName,
          paneId: created.paneId,
        },
      });
    } catch (error) {
      this.clearTuiMuxRuntimeState(sessionId);
      this.clearNativeTuiRuntimeState(sessionId);
      this.nativeTuiSessionIds.delete(sessionId);
      this.deps.ptyHub.removeSession(sessionId);
      this.deps.sessionStore.removeSession(sessionId);
      if (tmux) {
        await this.removeMuxSession(tmux.muxSessionName, tmux.muxBackendKind).catch(() => undefined);
      } else {
        await this.removeMuxSession(muxSessionName, muxBackendKind).catch(() => undefined);
      }
      throw error;
    }

    const runtimeState = "idle";
    const readyState = this.deps.sessionStore.setRuntimeState(sessionId, runtimeState);
    publishSessionStateChanged(this.deps, sessionId, runtimeState);
    return { session: toSessionSummary(readyState) };
  }

  async closeNativeTuiSession(sessionId: string): Promise<boolean> {
    const tmux = this.tuiMuxSessions.get(sessionId);
    if (tmux) {
      this.closingNativeTuiSessionIds.add(sessionId);
      this.clearTuiMuxRuntimeState(sessionId);
      this.clearNativeTuiRuntimeState(sessionId);
      this.nativeTuiSessionIds.delete(sessionId);
      try {
        await this.closeTuiMuxSession(tmux);
      } finally {
        this.closingNativeTuiSessionIds.delete(sessionId);
      }
      return true;
    }
    if (!this.nativeTuiSessionIds.has(sessionId)) {
      return false;
    }
    this.closingNativeTuiSessionIds.add(sessionId);
    this.clearNativeTuiRuntimeState(sessionId);
    this.nativeTuiSessionIds.delete(sessionId);
    try {
      await this.ptySessions.close(sessionId);
    } finally {
      this.closingNativeTuiSessionIds.delete(sessionId);
    }
    return true;
  }

  private registerTuiMuxRuntime(args: {
    sessionId: string;
    provider: ProviderKind;
    cwd: string;
    providerSessionId?: string;
    promptState: NativeTuiPromptState;
    startupTimestampMs: number;
    muxSessionName: string;
    paneId: string;
    muxBackendKind: TuiMuxBackendKind;
    muxRuntime: MuxRuntime;
    launchEnv?: Record<string, string>;
  }): TuiMuxSessionState {
    const tmux: TuiMuxSessionState = {
      sessionId: args.sessionId,
      muxSessionName: args.muxSessionName,
      paneId: args.paneId,
      muxBackendKind: args.muxBackendKind,
      muxRuntime: args.muxRuntime,
    };
    this.tuiMuxSessions.set(args.sessionId, tmux);
    const processProxy = {
      shell: args.muxBackendKind,
      cwd: args.cwd,
      write: (data: string) => {
        void this.writeTuiMuxInput(tmux, data).catch((error) => {
          this.handleTuiMuxInputFailure(tmux, error);
        });
      },
      resize: () => undefined,
      close: async () => {
        await this.closeTuiMuxSession(tmux);
      },
      waitUntilReady: async () => undefined,
    } as unknown as NativeTuiSessionState["process"];
    this.nativeTuiSessions.set(args.sessionId, {
      sessionId: args.sessionId,
      process: processProxy,
      provider: args.provider,
      cwd: args.cwd,
      startupTimestampMs: args.startupTimestampMs,
      ...(args.launchEnv ? { launchEnv: args.launchEnv } : {}),
      promptState: args.promptState,
      promptTracker: { draftText: "" },
      queuedInputs: [],
      ...(args.providerSessionId ? { providerSessionId: args.providerSessionId } : {}),
    });
    this.nativeTuiSessionIds.add(args.sessionId);
    this.startTuiMuxSubscription(tmux);
    tmux.exitPollTimer = setInterval(() => {
      void this.pollTuiMuxExit(args.sessionId);
    }, 500);
    tmux.exitPollTimer.unref?.();
    this.startNativeTuiBindingProbe(args.sessionId);
    this.mirrorRuntime.startSessionMirror(args.sessionId);
    return tmux;
  }

  private startTuiMuxSubscription(tmux: TuiMuxSessionState): void {
    tmux.subscription?.close();
    tmux.subscription = tmux.muxRuntime.subscribePane(
      tmux.muxSessionName,
      tmux.paneId,
      (update) => {
        if (!this.isCurrentTuiMuxSession(tmux)) {
          return;
        }
        tmux.subscriptionRestartAttempts = 0;
        const text = renderMuxViewport(update.viewport);
        this.observeNativeTuiOutput(tmux.sessionId, text);
        this.scheduleNativeTuiMirrorWake(tmux.sessionId);
        if (tmux.activeSurface?.clientKind === "web") {
          // tmux subscribe viewports can briefly use a stale mirror size when
          // ownership moves between terminal and Web. Use the frame only as a
          // repaint signal; dump-screen gives xterm the canonical pane snapshot.
          this.scheduleTuiMuxScreenDump(tmux, { allowWebSizingClientFallback: true });
          return;
        }
        this.deps.ptyHub.appendOutput(tmux.sessionId, text, { replaceReplay: true });
      },
      {
        ansi: true,
        onExit: (exit) => {
          this.handleTuiMuxSubscriptionExit(tmux.sessionId, exit);
        },
      },
    );
    // `tmux subscribe --scrollback` can resend a large scrollback window on
    // every repaint, which makes Codex/Claude feel slow through the web TUI.
    // Seed the client once, then stream viewport snapshots only.
    void this.dumpTuiMuxScreen(tmux);
  }

  private scheduleTuiMuxScreenDump(
    tmux: TuiMuxSessionState,
    options: { allowWebSizingClientFallback?: boolean } = {},
  ): void {
    if (!this.isCurrentTuiMuxSession(tmux)) {
      return;
    }
    tmux.dumpPending = true;
    if (options.allowWebSizingClientFallback === true) {
      tmux.dumpAllowWebSizingClientFallback = true;
    }
    if (tmux.dumpTimer || tmux.dumpInFlight) {
      return;
    }
    tmux.dumpTimer = setTimeout(() => {
      delete tmux.dumpTimer;
      void this.flushTuiMuxScreenDump(tmux);
    }, 35);
    tmux.dumpTimer.unref?.();
  }

  private async flushTuiMuxScreenDump(tmux: TuiMuxSessionState): Promise<void> {
    if (!this.isCurrentTuiMuxSession(tmux)) {
      return;
    }
    if (tmux.dumpInFlight) {
      tmux.dumpPending = true;
      return;
    }
    tmux.dumpPending = false;
    tmux.dumpInFlight = true;
    const allowWebSizingClientFallback = tmux.dumpAllowWebSizingClientFallback === true;
    delete tmux.dumpAllowWebSizingClientFallback;
    try {
      await this.dumpTuiMuxScreen(tmux, { allowWebSizingClientFallback });
    } finally {
      tmux.dumpInFlight = false;
      if (tmux.dumpPending && this.isCurrentTuiMuxSession(tmux)) {
        tmux.dumpPending = false;
        const pendingAllowWebSizingClientFallback =
          tmux.dumpAllowWebSizingClientFallback === true;
        delete tmux.dumpAllowWebSizingClientFallback;
        this.scheduleTuiMuxScreenDump(tmux, {
          allowWebSizingClientFallback: pendingAllowWebSizingClientFallback,
        });
      }
    }
  }

  private async dumpTuiMuxScreen(
    tmux: TuiMuxSessionState,
    options: { allowWebSizingClientFallback?: boolean } = {},
  ): Promise<void> {
    const dumped = await tmux.muxRuntime
      .dumpScreen(tmux.muxSessionName, tmux.paneId, { ansi: true })
      .catch((error) => {
        this.handleTuiMuxInputFailure(tmux, error);
        return "";
      });
    if (!dumped || !this.isCurrentTuiMuxSession(tmux)) {
      return;
    }
    const text = renderMuxDump(dumped);
    this.deps.ptyHub.appendOutput(tmux.sessionId, text, { replaceReplay: true });
    this.observeNativeTuiOutput(tmux.sessionId, text);
  }

  private isCurrentTuiMuxSession(tmux: TuiMuxSessionState): boolean {
    return (
      this.tuiMuxSessions.get(tmux.sessionId) === tmux &&
      this.deps.sessionStore.getSession(tmux.sessionId) !== undefined
    );
  }

  private handleTuiMuxSubscriptionExit(
    sessionId: string,
    exit: { code?: number | null; signal?: NodeJS.Signals | null; error?: Error },
  ): void {
    const tmux = this.tuiMuxSessions.get(sessionId);
    if (!tmux) {
      return;
    }
    void this.pollTuiMuxExit(sessionId).then(() => {
      const current = this.tuiMuxSessions.get(sessionId);
      if (!current || current.subscriptionRestartTimer) {
        return;
      }
      const attempts = (current.subscriptionRestartAttempts ?? 0) + 1;
      current.subscriptionRestartAttempts = attempts;
      if (attempts > 5) {
        this.deps.eventBus.publish({
          sessionId,
          type: "runtime.status",
          source: SYSTEM_SOURCE,
          payload: {
            status: "error",
            detail: "tmux subscription stopped repeatedly.",
          },
        });
        return;
      }
      current.subscriptionRestartTimer = setTimeout(() => {
        const latest = this.tuiMuxSessions.get(sessionId);
        if (!latest) {
          return;
        }
        delete latest.subscriptionRestartTimer;
        this.startTuiMuxSubscription(latest);
      }, 500);
      current.subscriptionRestartTimer.unref?.();
      console.warn("[rah] tmux TUI subscription exited; scheduling reconnect", {
        sessionId,
        muxSessionName: current.muxSessionName,
        paneId: current.paneId,
        attempts,
        ...(exit.code !== undefined ? { code: exit.code } : {}),
        ...(exit.signal !== undefined ? { signal: exit.signal } : {}),
        ...(exit.error ? { error: exit.error.message } : {}),
      });
    });
  }

  private async writeTuiMuxInput(
    tmux: TuiMuxSessionState,
    data: string,
  ): Promise<void> {
    await tmux.muxRuntime.writeBytes(tmux.muxSessionName, tmux.paneId, data);
  }

  private async writeTuiMuxText(
    tmux: TuiMuxSessionState,
    text: string,
  ): Promise<void> {
    if (!text) {
      return;
    }
    // Use the same pane-targeted byte channel as submit/interrupt. tmux's
    // write-chars is convenient for interactive attach surfaces, but it has
    // proven less deterministic for chat-driven injection into multiple hidden
    // panes. Plain UTF-8 bytes preserve text exactly and avoid focus-sensitive
    // character synthesis.
    await tmux.muxRuntime.writeBytes(tmux.muxSessionName, tmux.paneId, text);
  }

  private async withTuiMuxActionSurface<T>(
    tmux: TuiMuxSessionState,
    action: () => Promise<T>,
  ): Promise<T> {
    const previousAction = tmux.actionQueue ?? Promise.resolve();
    const queuedAction = previousAction.catch(() => undefined).then(() =>
      this.withTuiMuxActionSurfaceNow(tmux, action),
    );
    const actionTail = queuedAction.then(
      () => undefined,
      () => undefined,
    );
    tmux.actionQueue = actionTail;
    void actionTail.finally(() => {
      if (tmux.actionQueue === actionTail) {
        delete tmux.actionQueue;
      }
    });
    return queuedAction;
  }

  private async withTuiMuxActionSurfaceNow<T>(
    tmux: TuiMuxSessionState,
    action: () => Promise<T>,
  ): Promise<T> {
    // Chat and control actions target the tmux pane directly. They do not need
    // an attach/sizing client, so they cannot steal redraw ownership from a
    // visible terminal attach.
    return await action();
  }

  private handleTuiMuxInputFailure(tmux: TuiMuxSessionState, error: unknown): void {
    if (isMuxSessionMissingError(error)) {
      void this.pollTuiMuxExit(tmux.sessionId);
      return;
    }
    console.warn("[rah] failed to write tmux TUI input", {
      sessionId: tmux.sessionId,
      muxSessionName: tmux.muxSessionName,
      paneId: tmux.paneId,
      error,
    });
    this.deps.eventBus.publish({
      sessionId: tmux.sessionId,
      type: "runtime.status",
      source: SYSTEM_SOURCE,
      payload: {
        status: "error",
        detail: `Failed to write input to ${tmux.muxBackendKind} TUI.`,
      },
    });
  }

  private async pollTuiMuxExit(sessionId: string): Promise<void> {
    const tmux = this.tuiMuxSessions.get(sessionId);
    if (!tmux) {
      return;
    }
    const panes = await tmux.muxRuntime.listPanes(tmux.muxSessionName).catch((error) => {
      if (isMuxSessionMissingError(error)) {
        return null;
      }
      console.warn("[rah] failed to poll tmux pane state", {
        sessionId,
        muxSessionName: tmux.muxSessionName,
        paneId: tmux.paneId,
        error,
      });
      return undefined;
    });
    if (panes === undefined) {
      return;
    }
    const pane = panes?.find((candidate) => candidate.paneId === tmux.paneId);
    if (panes && pane && !isExitedTuiMuxPane(pane)) {
      tmux.exitPollMisses = 0;
      return;
    }
    if (panes && pane && isExitedTuiMuxPane(pane)) {
      tmux.exitPollMisses = 0;
    } else {
      const misses = (tmux.exitPollMisses ?? 0) + 1;
      tmux.exitPollMisses = misses;
      if (misses < TUI_MUX_EXIT_MISSING_POLL_THRESHOLD) {
        return;
      }
    }
    const native = this.nativeTuiSessions.get(sessionId);
    const expectedClose = this.closingNativeTuiSessionIds.has(sessionId);
    const exitError = expectedClose ? undefined : nativeTuiExitErrorFromOutput(native);
    this.clearTuiMuxRuntimeState(sessionId);
    this.clearNativeTuiRuntimeState(sessionId);
    if (!exitError) {
      this.nativeTuiSessionIds.delete(sessionId);
    }
    this.closingNativeTuiSessionIds.delete(sessionId);
    this.deps.ptyHub.emitExit(sessionId, pane?.exitStatus ?? undefined, undefined);
    const currentState = this.deps.sessionStore.getSession(sessionId);
    if (currentState) {
      if (exitError) {
        this.deps.sessionStore.patchManagedSession(sessionId, {
          capabilities: buildStoppedNativeTuiSessionCapabilities(currentState.session.provider),
          nativeTui: {
            terminalId: sessionId,
            viewAvailable: true,
            promptState: "prompt_clean",
            queuedInputCount: 0,
          },
          runtimeDiagnostics: {
            ...(currentState.session.runtimeDiagnostics ?? {}),
            lastError: currentState.session.runtimeDiagnostics?.lastError ?? exitError,
          },
        });
        this.deps.sessionStore.setActiveTurn(sessionId, undefined);
        this.deps.sessionStore.setRuntimeState(sessionId, "failed");
        publishSessionStateChanged(this.deps, sessionId, "failed");
      } else {
        this.deps.onRememberSession(currentState);
        this.deps.sessionStore.setActiveTurn(sessionId, undefined);
        this.deps.sessionStore.removeSession(sessionId);
        this.deps.historySnapshots.clear(sessionId);
        this.deps.onSessionOwnerRemoved(sessionId);
        this.deps.eventBus.publish({
          sessionId,
          type: "session.closed",
          source: SYSTEM_SOURCE,
          payload: {},
        });
      }
    }
    if (!exitError) {
      this.deps.ptyHub.removeSession(sessionId);
    }
    if (native && !expectedClose) {
      recordNativeTuiProcessExitDiagnostic(this.nativeTuiDiagnostics, native, {
        ...(pane?.exitStatus !== null && pane?.exitStatus !== undefined
          ? { exitCode: pane.exitStatus }
          : {}),
      });
    }
    await this.removeMuxSession(tmux.muxSessionName, tmux.muxBackendKind).catch(() => undefined);
  }

  private async closeTuiMuxSession(tmux: TuiMuxSessionState): Promise<void> {
    await tmux.muxRuntime.closePane(tmux.muxSessionName, tmux.paneId).catch((error) => {
      if (isMuxSessionMissingError(error)) {
        return;
      }
      console.warn("[rah] failed to close tmux pane, falling back to kill-session", {
        sessionId: tmux.sessionId,
        muxSessionName: tmux.muxSessionName,
        paneId: tmux.paneId,
        error,
      });
    });
    const deadline = Date.now() + 1_500;
    while (Date.now() < deadline) {
      const panes = await tmux.muxRuntime.listPanes(tmux.muxSessionName).catch(() => []);
      const pane = panes.find((candidate) => candidate.paneId === tmux.paneId);
      if (!pane || isExitedTuiMuxPane(pane)) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await this.removeMuxSession(tmux.muxSessionName, tmux.muxBackendKind).catch((error) => {
      if (isMuxSessionMissingError(error)) {
        return;
      }
      console.warn("[rah] failed to remove tmux session", {
        sessionId: tmux.sessionId,
        muxSessionName: tmux.muxSessionName,
        error,
      });
    });
  }

  private startNativeTuiBindingProbe(sessionId: string): void {
    const native = this.nativeTuiSessions.get(sessionId);
    if (
      !native ||
      (native.providerSessionId && native.provider !== "claude") ||
      !this.deps.nativeTuiProviders.canProbeBinding(native.provider)
    ) {
      return;
    }
    const timer = setInterval(() => {
      this.probeNativeTuiBinding(sessionId);
      this.warnIfNativeTuiBindingIsStillMissing(sessionId);
    }, nativeTuiBindingProbeIntervalMs());
    timer.unref?.();
    native.bindingTimer = timer;
  }

  private warnIfNativeTuiBindingIsStillMissing(sessionId: string): void {
    const native = this.nativeTuiSessions.get(sessionId);
    if (!native || native.providerSessionId || native.bindingWarningEmitted) {
      return;
    }
    native.bindingWarningEmitted = maybeRecordNativeTuiBindingMissingDiagnostic(
      this.nativeTuiDiagnostics,
      native,
      nativeTuiBindingWarnAfterMs(),
    );
  }

  private observeNativeTuiOutput(sessionId: string, data: string): void {
    const native = this.nativeTuiSessions.get(sessionId);
    if (!native) {
      return;
    }
    native.recentOutputTail = `${native.recentOutputTail ?? ""}${data}`.slice(
      -NATIVE_TUI_OUTPUT_OBSERVATION_TAIL_LIMIT,
    );
    const observation = this.deps.nativeTuiProviders.observeOutput(
      nativeTuiProviderRuntimeSession(native),
      native.recentOutputTail,
    );
    if (observation.promptClean && native.promptTracker.draftText.length === 0) {
      native.promptTracker.draftText = "";
      this.updateNativeTuiPromptState(sessionId, "prompt_clean");
    }
    if (observation.binding) {
      this.bindNativeTuiProviderSession(
        sessionId,
        observation.binding.providerSessionId,
        observation.binding.record,
      );
    }
  }

  private scheduleNativeTuiMirrorWake(sessionId: string): void {
    const native = this.nativeTuiSessions.get(sessionId);
    if (!native || !native.providerSessionId || !this.deps.nativeTuiMirrors.supports(native.provider)) {
      return;
    }
    if (native.mirrorWakeTimer) {
      return;
    }
    native.mirrorWakeTimer = setTimeout(() => {
      const current = this.nativeTuiSessions.get(sessionId);
      if (current) {
        delete current.mirrorWakeTimer;
      }
      this.mirrorRuntime.mirrorSession(sessionId);
    }, 75);
    native.mirrorWakeTimer.unref?.();
  }

  private probeNativeTuiBinding(sessionId: string): void {
    const native = this.nativeTuiSessions.get(sessionId);
    if (!native || (native.providerSessionId && native.provider !== "claude")) {
      return;
    }
    const candidate = this.deps.nativeTuiProviders.probeBinding(
      nativeTuiProviderRuntimeSession(native),
    );
    if (!candidate) {
      return;
    }
    this.bindNativeTuiProviderSession(
      sessionId,
      candidate.providerSessionId,
      candidate.record,
    );
  }

  private bindNativeTuiProviderSession(
    sessionId: string,
    providerSessionId: string,
    record: NativeTuiBindingRecord | null,
  ): void {
    const native = this.nativeTuiSessions.get(sessionId);
    if (!native) {
      return;
    }
    if (
      native.providerSessionId &&
      native.providerSessionId !== providerSessionId &&
      native.provider !== "claude"
    ) {
      return;
    }
    native.providerSessionId = providerSessionId;
    resolveNativeTuiBindingDiagnostic(this.nativeTuiDiagnostics, sessionId, providerSessionId);
    if (native.bindingTimer) {
      clearInterval(native.bindingTimer);
      delete native.bindingTimer;
    }
    if (native.providerMirror?.providerSessionId !== providerSessionId) {
      delete native.providerMirror;
    }
    const currentState = this.deps.sessionStore.getSession(sessionId);
    const nextTitle = record?.ref.title ?? currentState?.session.title ?? providerSessionId;
    const nextPreview = record?.ref.preview ?? currentState?.session.preview ?? providerSessionId;
    this.deps.sessionStore.patchManagedSession(sessionId, {
      providerSessionId,
      title: nextTitle,
      preview: nextPreview,
    });
    this.deps.historySnapshots.clear(sessionId);
    publishSessionStarted(this.deps, sessionId);
    this.mirrorRuntime.mirrorSession(sessionId);
  }

  async shutdown(): Promise<void> {
    const tmuxSessions = Array.from(this.tuiMuxSessions.values());
    const tmuxResults = await Promise.allSettled(
      tmuxSessions.map(async (tmux) => {
        this.clearTuiMuxRuntimeState(tmux.sessionId);
        await this.closeTuiMuxSession(tmux);
      }),
    );
    tmuxResults.forEach((result, index) => {
      if (result.status === "rejected") {
        const tmux = tmuxSessions[index];
        console.error("[rah] failed to kill tmux session during shutdown", {
          sessionId: tmux?.sessionId,
          muxSessionName: tmux?.muxSessionName,
          error: result.reason,
        });
      }
    });
    const closedUnmanaged = await this.cleanupUnmanagedTuiMuxSessions();
    if (closedUnmanaged.length > 0) {
      console.warn("[rah] cleaned unmanaged RAH tmux sessions during shutdown", {
        sessions: closedUnmanaged,
      });
    }
    for (const sessionId of this.nativeTuiSessions.keys()) {
      this.clearNativeTuiRuntimeState(sessionId);
    }
    for (const sessionId of this.nativeLocalTuiWarmStates.keys()) {
      this.clearNativeLocalTuiWarmState(sessionId);
    }
    this.nativeTuiSessionIds.clear();
    const results = await this.ptySessions.closeAll();
    this.independentTerminals.clear();
    for (const result of results) {
      this.deps.ptyHub.removeSession(result.id);
      if (result.status === "rejected") {
        console.error("[rah] failed to close PTY session during shutdown", {
          terminalId: result.id,
          error: result.reason,
        });
      }
    }
  }

}

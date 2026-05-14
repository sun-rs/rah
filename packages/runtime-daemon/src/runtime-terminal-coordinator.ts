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
  ZellijMuxSessionDiagnostic,
} from "@rah/runtime-protocol";
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
import {
  buildNativeTuiSessionCapabilities,
  buildStoppedNativeTuiSessionCapabilities,
  buildZellijTuiSessionCapabilities,
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
  createZellijSessionNameForRahSession,
  ZellijCommandError,
  ZellijMuxBackend,
} from "./zellij-mux-backend";
import { reconcileTurnLifecycleActivity } from "./timeline-reconciler";
import type { MuxPaneSubscription } from "./mux-runtime";

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

type ZellijTuiSessionState = {
  sessionId: string;
  zellijSessionName: string;
  paneId: string;
  socketDir: string;
  sizingClientPtyId?: string;
  lastSizingClientOutputAtMs?: number;
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

const DEFAULT_ZELLIJ_TUI_COLS = 140;
const DEFAULT_ZELLIJ_TUI_ROWS = 44;
const ZELLIJ_TUI_EXIT_MISSING_POLL_THRESHOLD = 3;
const NATIVE_TUI_RECENT_INPUT_PROMPT_CLEAN_GRACE_MS = 800;
const NATIVE_TUI_RECENT_INTERRUPT_NOOP_MS = 1_200;

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
const ZELLIJ_TUI_SURFACE_SETTLE_MS = 350;
const ANSI_ESCAPE_PATTERN = /\u001b\[[0-?]*[ -/]*[@-~]/g;

function initialNativeTuiPromptState(provider: ProviderKind): NativeTuiPromptState {
  // OpenCode paints its input prompt after a full-screen redraw. Keep Web
  // composer input queued until the provider handler sees the prompt marker.
  return provider === "opencode" ? "agent_busy" : "prompt_clean";
}

function initialZellijTuiPromptState(provider: ProviderKind): NativeTuiPromptState {
  // zellij sessions need a sizing/attach surface before the provider prompt is
  // reliable. Queue initial Web chat input until the viewport observer sees a
  // real prompt marker.
  // Claude Code can accept input while a turn is running and manages its own
  // queue inside the native TUI. RAH must not use prompt state as an
  // authoritative send gate for Claude zellij sessions.
  return provider === "claude"
    ? "prompt_clean"
    : provider === "codex" || provider === "opencode"
    ? "agent_busy"
    : "prompt_clean";
}

function providerPrimaryModelOptionId(provider: ProviderKind): string | null {
  switch (provider) {
    case "codex":
      return "model_reasoning_effort";
    case "claude":
      return "effort";
    case "opencode":
      return "model_reasoning_variant";
    case "custom":
    default:
      return null;
  }
}

function nativeLocalServerTuiAttachSpec(session: ManagedSession):
  | { command: string; args: string[]; attachCommand: string }
  | null {
  const providerSessionId = session.providerSessionId;
  const endpoint = session.runtimeDiagnostics?.serverEndpoint;
  if (!providerSessionId || !endpoint || session.liveBackend !== "native_local_server") {
    return null;
  }
  if (session.provider === "codex") {
    if (!/^wss?:\/\//.test(endpoint)) {
      return null;
    }
    const command = process.env.RAH_CODEX_BINARY || "codex";
    const args = ["--remote", endpoint, "resume", providerSessionId];
    return {
      command,
      args,
      attachCommand: `${command} --remote ${endpoint} resume ${providerSessionId}`,
    };
  }
  if (session.provider === "opencode") {
    const command = process.env.RAH_OPENCODE_BINARY || "opencode";
    const args = ["attach", endpoint, "--session", providerSessionId];
    return {
      command,
      args,
      attachCommand: `${command} attach ${endpoint} --session ${providerSessionId}`,
    };
  }
  return null;
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
const ZELLIJ_TUI_CLEAR_PROMPT_SETTLE_MS = 250;
const NATIVE_TUI_OUTPUT_OBSERVATION_TAIL_LIMIT = 12_000;

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

function zellijSnapshotCursorSuffix(lines: readonly string[]): string {
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

function renderZellijViewport(lines: readonly string[]): string {
  return `\u001b[2J\u001b[H${lines.join("\r\n")}${zellijSnapshotCursorSuffix(lines)}`;
}

function renderZellijDump(dumped: string): string {
  const lines = dumped.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  return `\u001b[2J\u001b[H${lines.join("\r\n")}${zellijSnapshotCursorSuffix(lines)}`;
}

function isZellijSessionMissingError(error: unknown): boolean {
  if (!(error instanceof ZellijCommandError)) {
    return false;
  }
  const detail = `${error.stdout}\n${error.stderr}\n${error.message}`;
  return /No session named|Session:?\s*['"][^'"]+['"] not found|There is no active session|session may have exited/i.test(detail);
}

function isExitedZellijPane(pane: { exited: boolean; held: boolean; exitStatus: number | null }): boolean {
  return pane.exited || pane.held || pane.exitStatus !== null;
}

function appendCodexZellijArgs(launch: NativeTuiLaunchSpec): NativeTuiLaunchSpec {
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
  private readonly zellijMux = new ZellijMuxBackend();
  private readonly zellijTuiSessions = new Map<string, ZellijTuiSessionState>();
  private readonly nativeTuiSessions = new Map<string, NativeTuiSessionState>();
  private readonly nativeTuiSessionIds = new Set<string>();
  private readonly closingNativeTuiSessionIds = new Set<string>();
  private readonly nativeTuiDiagnostics = new NativeTuiDiagnosticStore();
  private readonly mirrorRuntime: NativeTuiMirrorRuntime;
  private zellijActionQueue?: Promise<void>;

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

  async restoreZellijTuiSession(session: ManagedSession): Promise<boolean> {
    const mux = session.mux;
    if (session.liveBackend !== "zellij_tui" || mux?.backend !== "zellij") {
      return false;
    }
    if (this.deps.sessionStore.getSession(session.id)) {
      return true;
    }
    if (mux.socketDir !== this.zellijMux.getSocketDir()) {
      console.warn("[rah] skipped zellij session recovery for different socket dir", {
        sessionId: session.id,
        expectedSocketDir: this.zellijMux.getSocketDir(),
        socketDir: mux.socketDir,
      });
      return false;
    }
    const panes = await this.zellijMux.listPanes(mux.sessionName).catch((error) => {
      console.warn("[rah] failed to list zellij panes during recovery", {
        sessionId: session.id,
        zellijSessionName: mux.sessionName,
        error,
      });
      return [];
    });
    const pane = panes.find((candidate) => candidate.paneId === mux.paneId);
    if (!pane || isExitedZellijPane(pane)) {
      return false;
    }

    const restoredRuntimeState: "running" | "idle" =
      session.nativeTui?.promptState === "agent_busy" ? "running" : "idle";
    const restoredSession: ManagedSession = {
      ...session,
      liveBackend: "zellij_tui",
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
        ...buildZellijTuiSessionCapabilities(session.provider),
      },
    };
    this.deps.sessionStore.restoreSession({
      session: restoredSession,
      clients: [],
      controlLease: { sessionId: session.id },
    });
    this.deps.ptyHub.ensureSession(session.id);
    this.registerZellijTuiRuntime({
      sessionId: session.id,
      provider: session.provider,
      cwd: session.cwd,
      ...(session.providerSessionId
        ? { providerSessionId: session.providerSessionId }
        : {}),
      promptState: restoredSession.nativeTui?.promptState ?? "prompt_clean",
      startupTimestampMs: Date.now(),
      zellijSessionName: mux.sessionName,
      paneId: mux.paneId,
      socketDir: mux.socketDir,
    });
    const dumped = await this.zellijMux
      .dumpScreen(mux.sessionName, mux.paneId, { ansi: true })
      .catch(() => "");
    if (dumped) {
      const text = renderZellijDump(dumped);
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

  async listZellijMuxDiagnostics(): Promise<ZellijMuxSessionDiagnostic[]> {
    const bySessionName = new Map<string, ZellijMuxSessionDiagnostic>();
    const remember = (sessionName: string): ZellijMuxSessionDiagnostic => {
      const existing = bySessionName.get(sessionName);
      if (existing) {
        return existing;
      }
      const created: ZellijMuxSessionDiagnostic = {
        sessionName,
        socketDir: this.zellijMux.getSocketDir(),
        panes: [],
      };
      bySessionName.set(sessionName, created);
      return created;
    };

    for (const zellij of this.zellijTuiSessions.values()) {
      const managed = this.deps.sessionStore.getSession(zellij.sessionId)?.session;
      const entry = remember(zellij.zellijSessionName);
      entry.managedSessionId = zellij.sessionId;
      entry.paneId = zellij.paneId;
      if (managed) {
        entry.provider = managed.provider;
        entry.runtimeState = managed.runtimeState;
      }
    }

    try {
      for (const session of await this.zellijMux.listSessions()) {
        if (session.sessionName.startsWith("rah-")) {
          remember(session.sessionName);
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
          const panes = await this.zellijMux.listPanes(entry.sessionName);
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

  async closeUnmanagedZellijMuxSession(sessionName: string): Promise<void> {
    const trimmedSessionName = sessionName.trim();
    if (!/^rah-[0-9a-z][0-9a-z-]*$/i.test(trimmedSessionName)) {
      throw new Error("Only RAH-owned zellij sessions can be closed from diagnostics.");
    }
    const managed = [...this.zellijTuiSessions.values()].find(
      (zellij) => zellij.zellijSessionName === trimmedSessionName,
    );
    if (managed) {
      throw new Error("This zellij session is managed by a live RAH session. Archive the live session instead.");
    }
    await this.removeZellijMuxSession(trimmedSessionName).catch((error) => {
      if (isZellijSessionMissingError(error)) {
        return;
      }
      throw error;
    });
  }

  private async removeZellijMuxSession(sessionName: string): Promise<void> {
    await this.zellijMux.killSession(sessionName).catch((error) => {
      if (isZellijSessionMissingError(error)) {
        return;
      }
      throw error;
    });
    await this.zellijMux.deleteSession(sessionName).catch((error) => {
      if (isZellijSessionMissingError(error)) {
        return;
      }
      throw error;
    });
  }

  clearSessionState(sessionId: string): void {
    void this.closeNativeLocalServerTuiClient(sessionId).catch(() => undefined);
    this.clearZellijTuiRuntimeState(sessionId);
    this.clearNativeTuiRuntimeState(sessionId);
    this.nativeTuiSessionIds.delete(sessionId);
  }

  private clearZellijTuiRuntimeState(sessionId: string): void {
    const zellij = this.zellijTuiSessions.get(sessionId);
    if (!zellij) {
      return;
    }
    zellij.subscription?.close();
    if (zellij.sizingClientPtyId) {
      void this.ptySessions.close(zellij.sizingClientPtyId).catch(() => undefined);
    }
    if (zellij.dumpTimer) {
      clearTimeout(zellij.dumpTimer);
    }
    if (zellij.subscriptionRestartTimer) {
      clearTimeout(zellij.subscriptionRestartTimer);
    }
    if (zellij.exitPollTimer) {
      clearInterval(zellij.exitPollTimer);
    }
    this.zellijTuiSessions.delete(sessionId);
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
    const zellij = this.zellijTuiSessions.get(sessionId);
    if (zellij) {
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
        void this.dumpZellijTuiScreen(zellij);
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
    const zellij = this.zellijTuiSessions.get(native.sessionId);
    if (zellij) {
      void this.withZellijActionSurface(zellij, async () => {
        if (options?.clearPromptBeforeSubmit) {
          await this.sendZellijTuiClearPrompt(zellij);
          // zellij action send-keys returns after enqueueing synthesized keys,
          // not necessarily after the target TUI has consumed them. Give the
          // clear sequence a short deterministic settle window so the next
          // raw write is not erased by a delayed Ctrl-K/Ctrl-U.
          await new Promise((resolve) => setTimeout(resolve, ZELLIJ_TUI_CLEAR_PROMPT_SETTLE_MS));
        }
        await this.writeZellijTuiText(zellij, text);
        for (let index = 0; index < nativeTuiSubmitCountForProvider(native.provider); index += 1) {
          await new Promise((resolve) => setTimeout(resolve, NATIVE_TUI_SUBMIT_DELAY_MS));
          await this.writeZellijTuiInput(zellij, nativeTuiSubmitDataForProvider(native.provider));
        }
      })
        .then(
          () => {
            void this.pollZellijTuiExit(zellij.sessionId);
          },
          (error) => {
            void this.pollZellijTuiExit(zellij.sessionId);
            this.handleZellijTuiInputFailure(zellij, error);
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
    return native.promptState !== "prompt_clean" || native.promptTracker.draftText.length > 0;
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
    const zellij = this.zellijTuiSessions.get(sessionId);
    if (zellij) {
      const native = this.nativeTuiSessions.get(sessionId);
      this.claimWebControl(sessionId, clientId);
      const activeTurnId = this.deps.sessionStore.getSession(sessionId)?.activeTurnId;
      if (native) {
        if (isClaudeNativeTuiPassthrough(native)) {
          cancelNativeTuiQueuedInputsForClient(native, clientId);
          native.promptTracker.draftText = "";
          delete native.lastInjectedInputAtMs;
          native.clearPromptBeforeNextInput = true;
          this.sendZellijTuiInterrupt(zellij, native.provider);
          this.scheduleClaudeNativeTuiPromptClear(native);
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
      this.sendZellijTuiInterrupt(zellij, native?.provider ?? "codex");
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
    if (isClaudeNativeTuiPassthrough(native)) {
      cancelNativeTuiQueuedInputsForClient(native, clientId);
      this.writeNativeTuiInterrupt(native);
      native.promptTracker.draftText = "";
      delete native.lastInjectedInputAtMs;
      native.clearPromptBeforeNextInput = true;
      this.scheduleClaudeNativeTuiPromptClear(native);
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
    const zellij = this.zellijTuiSessions.get(native.sessionId);
    if (zellij) {
      void this.withZellijActionSurface(zellij, async () => {
        await this.sendZellijTuiClearPrompt(zellij);
      }).catch((error) => {
        this.handleZellijTuiInputFailure(zellij, error);
      });
      return;
    }
    native.process.write(NATIVE_TUI_CLEAR_PROMPT_DATA);
  }

  private scheduleClaudeNativeTuiPromptClear(native: NativeTuiSessionState): void {
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
      if (!isClaudeNativeTuiPassthrough(current)) {
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

  private sendZellijTuiInterrupt(zellij: ZellijTuiSessionState, provider: ProviderKind): void {
    const sendEsc = async (): Promise<void> => {
      await this.writeZellijTuiInput(zellij, "\u001b");
    };
    void this.withZellijActionSurface(zellij, async () => {
      if (provider === "opencode") {
        await this.writeZellijTuiInput(zellij, nativeTuiInterruptDataForProvider(provider));
        return;
      }
      await sendEsc();
      const retryDelays = [350, 900];
      for (const retryDelay of retryDelays) {
        await new Promise((resolve) => setTimeout(resolve, retryDelay));
        const native = this.nativeTuiSessions.get(zellij.sessionId);
        if (!this.isCurrentZellijTuiSession(zellij)) {
          break;
        }
        if (!native?.stopPending) {
          break;
        }
        await sendEsc();
      }
    }).catch((error) => {
      this.handleZellijTuiInputFailure(zellij, error);
    });
  }

  private async sendZellijTuiClearPrompt(zellij: ZellijTuiSessionState): Promise<void> {
    // zellij action write can inject control bytes as literal composer text in
    // raw-mode TUIs. send-keys asks zellij to synthesize terminal key events.
    await this.zellijMux.sendKeys(zellij.zellijSessionName, zellij.paneId, [
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
    return this.zellijSurfaceResponse(this.zellijTuiSessions.get(sessionId));
  }

  async claimNativeTuiSurface(
    sessionId: string,
    request: NativeTuiSurfaceClaimRequest,
  ): Promise<NativeTuiSurfaceResponse> {
    const zellij = this.zellijTuiSessions.get(sessionId);
    if (!zellij) {
      if (await this.ensureNativeLocalServerTuiClient(sessionId, request)) {
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
    zellij.activeSurface = surface;
    if (this.shouldUseZellijSizingClient(request.clientKind)) {
      this.deps.ptyHub.resetSession(sessionId);
      await this.ensureZellijTuiSizingClient(
        zellij,
        surface.cols ?? DEFAULT_ZELLIJ_TUI_COLS,
        surface.rows ?? DEFAULT_ZELLIJ_TUI_ROWS,
      );
      await new Promise((resolve) => setTimeout(resolve, ZELLIJ_TUI_SURFACE_SETTLE_MS));
      await this.dumpZellijTuiScreen(zellij, { allowWebSizingClientFallback: true });
    } else {
      await this.closeZellijTuiSizingClient(zellij);
    }
    return this.zellijSurfaceResponse(zellij);
  }

  async releaseNativeTuiSurface(
    sessionId: string,
    request: NativeTuiSurfaceReleaseRequest,
  ): Promise<NativeTuiSurfaceResponse> {
    const zellij = this.zellijTuiSessions.get(sessionId);
    if (!zellij) {
      return {};
    }
    if (zellij.activeSurface?.clientId !== request.clientId) {
      return this.zellijSurfaceResponse(zellij);
    }
    const releasedKind = zellij.activeSurface.clientKind;
    delete zellij.activeSurface;
    if (this.shouldUseZellijSizingClient(releasedKind)) {
      await this.closeZellijTuiSizingClient(zellij);
    }
    return {};
  }

  async closeNativeTuiClient(
    sessionId: string,
    request: NativeTuiClientCloseRequest,
  ): Promise<NativeTuiSurfaceResponse> {
    const zellij = this.zellijTuiSessions.get(sessionId);
    if (zellij) {
      return await this.releaseNativeTuiSurface(sessionId, request);
    }
    const current = this.deps.sessionStore.getSession(sessionId);
    if (current?.session.liveBackend !== "native_local_server") {
      return {};
    }
    const closed = await this.closeNativeLocalServerTuiClient(sessionId);
    if (closed) {
      this.deps.ptyHub.resetSession(sessionId);
      this.deps.ptyHub.appendOutput(
        sessionId,
        "\r\n[rah] Web TUI client closed. Activate TUI to attach a new native client.\r\n",
      );
    }
    if (current) {
      this.deps.sessionStore.patchManagedSession(sessionId, {
        runtimeDiagnostics: {
          ...(current.session.runtimeDiagnostics ?? {}),
          attachState: "unavailable",
        },
      });
    }
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
    const spec = nativeLocalServerTuiAttachSpec(state.session);
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
          this.deps.ptyHub.emitExit(terminalId, exitArgs.exitCode, exitArgs.signal);
          const current = this.deps.sessionStore.getSession(terminalId);
          if (!current) {
            return;
          }
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
              lastError: `TUI client exited${exitArgs.exitCode !== undefined ? ` with code ${exitArgs.exitCode}` : ""}`,
            },
          });
        },
      });
      await terminal.process.waitUntilReady();
      const latest = this.deps.sessionStore.getSession(sessionId);
      if (latest) {
        this.deps.sessionStore.patchManagedSession(sessionId, {
          runtimeDiagnostics: {
            ...(latest.session.runtimeDiagnostics ?? {}),
            attachCommand: spec.attachCommand,
            attachState: "ready",
          },
        });
      }
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
    if (!this.ptySessions.has(sessionId)) {
      return false;
    }
    await this.ptySessions.close(sessionId);
    return true;
  }

  handlePtyInput(sessionId: string, clientId: string, data: string): boolean {
    const zellij = this.zellijTuiSessions.get(sessionId);
    if (zellij) {
      this.assertZellijTuiSurface(zellij, clientId);
      const native = this.nativeTuiSessions.get(sessionId);
      void this.writeZellijTuiInput(zellij, data)
        .then(() => {
          if (native) {
            this.observeNativeTuiPtyInput(native, data);
          }
        })
        .catch((error) => {
          this.handleZellijTuiInputFailure(zellij, error);
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
    const zellij = this.zellijTuiSessions.get(sessionId);
    if (zellij) {
      if (!zellij.activeSurface) {
        void this.claimNativeTuiSurface(sessionId, {
          clientId,
          clientKind: "web",
          cols,
          rows,
        }).catch((error) => this.handleZellijTuiInputFailure(zellij, error));
      } else if (zellij.activeSurface.clientId === clientId) {
        zellij.activeSurface = {
          ...zellij.activeSurface,
          cols: Math.max(20, Math.floor(cols)),
          rows: Math.max(8, Math.floor(rows)),
        };
        void this.ensureZellijTuiSizingClient(zellij, cols, rows).catch((error) =>
          this.handleZellijTuiInputFailure(zellij, error),
        );
      }
      return true;
    }
    return this.ptySessions.resize(sessionId, cols, rows);
  }

  private async ensureZellijTuiSizingClient(
    zellij: ZellijTuiSessionState,
    cols: number,
    rows: number,
  ): Promise<void> {
    const nextCols = Math.max(20, Math.floor(cols));
    const nextRows = Math.max(8, Math.floor(rows));
    if (zellij.sizingClientPtyId && this.ptySessions.resize(zellij.sizingClientPtyId, nextCols, nextRows)) {
      return;
    }
    await this.startZellijTuiSizingClient({
      sessionId: zellij.sessionId,
      zellijSessionName: zellij.zellijSessionName,
      socketDir: zellij.socketDir,
      cols: nextCols,
      rows: nextRows,
      createIfMissing: false,
    });
  }

  private async closeZellijTuiSizingClient(zellij: ZellijTuiSessionState): Promise<void> {
    const sizingClientPtyId = zellij.sizingClientPtyId;
    if (!sizingClientPtyId) {
      return;
    }
    delete zellij.sizingClientPtyId;
    delete zellij.lastSizingClientOutputAtMs;
    await this.ptySessions.close(sizingClientPtyId).catch(() => undefined);
  }

  private assertZellijTuiSurface(zellij: ZellijTuiSessionState, clientId: string): void {
    if (!zellij.activeSurface) {
      throw new Error("No active TUI display surface. Open the TUI view before sending terminal input.");
    }
    if (zellij.activeSurface.clientId !== clientId) {
      throw new Error(
        `TUI display is controlled by ${zellij.activeSurface.clientKind}; reclaim it before sending terminal input.`,
      );
    }
  }

  private shouldUseZellijSizingClient(kind: ClientKind): boolean {
    return kind !== "terminal";
  }

  private zellijSurfaceResponse(zellij?: ZellijTuiSessionState): NativeTuiSurfaceResponse {
    if (!zellij?.activeSurface) {
      return {};
    }
    return { surface: { ...zellij.activeSurface } };
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
          this.deps.ptyHub.emitExit(terminalId, args.exitCode, args.signal);
        },
      });
    } catch (error) {
      this.deps.ptyHub.removeSession(id);
      throw error;
    }
    return {
      terminal: {
        id,
        cwd,
        shell: terminal.shell,
      },
    };
  }

  async closeIndependentTerminal(id: string): Promise<void> {
    const closed = await this.ptySessions.close(id);
    if (closed) {
      this.deps.ptyHub.removeSession(id);
    }
  }

  async startNativeTuiSession(args: {
    launch: NativeTuiLaunchSpec;
    attach?: StartSessionRequest["attach"];
    providerSessionId?: string;
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
          this.clearNativeTuiRuntimeState(terminalId);
          this.closingNativeTuiSessionIds.delete(terminalId);
          this.deps.ptyHub.emitExit(terminalId, exitArgs.exitCode, exitArgs.signal);
          const currentState = this.deps.sessionStore.getSession(terminalId);
          if (currentState) {
            this.deps.sessionStore.patchManagedSession(terminalId, {
              capabilities: buildStoppedNativeTuiSessionCapabilities(currentState.session.provider),
              nativeTui: {
                terminalId,
                viewAvailable: true,
                promptState: "prompt_clean",
                queuedInputCount: 0,
              },
            });
            this.deps.sessionStore.setActiveTurn(terminalId, undefined);
            this.deps.sessionStore.setRuntimeState(terminalId, "stopped");
            publishSessionStateChanged(this.deps, terminalId, "stopped");
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

  async startZellijTuiSession(args: {
    launch: NativeTuiLaunchSpec;
    attach?: StartSessionRequest["attach"];
    providerSessionId?: string;
  }): Promise<StartSessionResponse> {
    const launch = appendCodexZellijArgs(args.launch);
    const sessionId = crypto.randomUUID();
    const providerSessionId = args.providerSessionId ?? launch.providerSessionId;
    const startupTimestampMs = Date.now();
    const launchSource = args.attach?.client.kind === "terminal" ? "terminal" : "web";
    const initialPromptState = initialZellijTuiPromptState(launch.provider);
    const zellijSessionName = createZellijSessionNameForRahSession(sessionId);
    this.deps.sessionStore.createManagedSession({
      id: sessionId,
      provider: launch.provider,
      ...(providerSessionId ? { providerSessionId } : {}),
      launchSource,
      liveBackend: "zellij_tui",
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
      mux: {
        backend: "zellij",
        sessionName: zellijSessionName,
        paneId: "pending",
        socketDir: this.zellijMux.getSocketDir(),
      },
      ptyId: sessionId,
      ...nativeTuiStartupSessionPatch(launch),
      capabilities: buildZellijTuiSessionCapabilities(launch.provider),
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

    let zellij: ZellijTuiSessionState | undefined;
    let sizingClientPtyId: string | undefined;
    try {
      sizingClientPtyId = await this.startZellijTuiSizingClient({
        sessionId,
        zellijSessionName,
        socketDir: this.zellijMux.getSocketDir(),
        cols: args.attach?.client.cols ?? DEFAULT_ZELLIJ_TUI_COLS,
        rows: args.attach?.client.rows ?? DEFAULT_ZELLIJ_TUI_ROWS,
        createIfMissing: true,
      });
      const created = await this.zellijMux.createSession({
        sessionName: zellijSessionName,
        cwd: launch.cwd,
        command: launch.command,
        args: launch.args,
        ...(launch.env ? { env: launch.env } : {}),
        title: `${launch.provider}-${sessionId.slice(0, 8)}`,
        replaceDefaultPane: true,
      });
      zellij = this.registerZellijTuiRuntime({
        sessionId,
        provider: launch.provider,
        cwd: launch.cwd,
        ...(providerSessionId ? { providerSessionId } : {}),
        promptState: initialPromptState,
        startupTimestampMs,
        ...(launch.env ? { launchEnv: launch.env } : {}),
        zellijSessionName,
        paneId: created.paneId,
        socketDir: this.zellijMux.getSocketDir(),
      });
      if (sizingClientPtyId) {
        await this.ptySessions.close(sizingClientPtyId).catch(() => undefined);
        sizingClientPtyId = undefined;
      }
      this.deps.sessionStore.patchManagedSession(sessionId, {
        mux: {
          backend: "zellij",
          sessionName: zellijSessionName,
          paneId: created.paneId,
          socketDir: this.zellijMux.getSocketDir(),
        },
      });
    } catch (error) {
      this.clearZellijTuiRuntimeState(sessionId);
      this.clearNativeTuiRuntimeState(sessionId);
      this.nativeTuiSessionIds.delete(sessionId);
      this.deps.ptyHub.removeSession(sessionId);
      this.deps.sessionStore.removeSession(sessionId);
      if (sizingClientPtyId) {
        await this.ptySessions.close(sizingClientPtyId).catch(() => undefined);
      }
      if (zellij) {
        await this.removeZellijMuxSession(zellij.zellijSessionName).catch(() => undefined);
      } else {
        await this.removeZellijMuxSession(zellijSessionName).catch(() => undefined);
      }
      throw error;
    }

    const runtimeState = "idle";
    const readyState = this.deps.sessionStore.setRuntimeState(sessionId, runtimeState);
    publishSessionStateChanged(this.deps, sessionId, runtimeState);
    return { session: toSessionSummary(readyState) };
  }

  async closeNativeTuiSession(sessionId: string): Promise<boolean> {
    const zellij = this.zellijTuiSessions.get(sessionId);
    if (zellij) {
      this.closingNativeTuiSessionIds.add(sessionId);
      this.clearZellijTuiRuntimeState(sessionId);
      this.clearNativeTuiRuntimeState(sessionId);
      this.nativeTuiSessionIds.delete(sessionId);
      try {
        await this.closeZellijTuiSession(zellij);
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

  private registerZellijTuiRuntime(args: {
    sessionId: string;
    provider: ProviderKind;
    cwd: string;
    providerSessionId?: string;
    promptState: NativeTuiPromptState;
    startupTimestampMs: number;
    zellijSessionName: string;
    paneId: string;
    socketDir: string;
    sizingClientPtyId?: string;
    launchEnv?: Record<string, string>;
  }): ZellijTuiSessionState {
    const zellij: ZellijTuiSessionState = {
      sessionId: args.sessionId,
      zellijSessionName: args.zellijSessionName,
      paneId: args.paneId,
      socketDir: args.socketDir,
      ...(args.sizingClientPtyId ? { sizingClientPtyId: args.sizingClientPtyId } : {}),
    };
    this.zellijTuiSessions.set(args.sessionId, zellij);
    const processProxy = {
      shell: "zellij",
      cwd: args.cwd,
      write: (data: string) => {
        void this.writeZellijTuiInput(zellij, data).catch((error) => {
          this.handleZellijTuiInputFailure(zellij, error);
        });
      },
      resize: () => undefined,
      close: async () => {
        await this.closeZellijTuiSession(zellij);
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
    this.startZellijTuiSubscription(zellij);
    zellij.exitPollTimer = setInterval(() => {
      void this.pollZellijTuiExit(args.sessionId);
    }, 500);
    zellij.exitPollTimer.unref?.();
    this.startNativeTuiBindingProbe(args.sessionId);
    this.mirrorRuntime.startSessionMirror(args.sessionId);
    return zellij;
  }

  private async startZellijTuiSizingClient(args: {
    sessionId: string;
    zellijSessionName: string;
    socketDir: string;
    cols: number;
    rows: number;
    createIfMissing: boolean;
  }): Promise<string> {
    const sizingClientPtyId = `zellij-sizing:${args.sessionId}`;
    this.ptySessions.create({
      id: sizingClientPtyId,
      cwd: process.cwd(),
      cols: Math.max(20, Math.floor(args.cols)),
      rows: Math.max(8, Math.floor(args.rows)),
      command: "zellij",
      args: [
        "attach",
        ...(args.createIfMissing ? ["-c"] : []),
        args.zellijSessionName,
        "options",
        "--mirror-session",
        "true",
        "--pane-frames",
        "false",
        "--show-startup-tips",
        "false",
      ],
      env: {
        ZELLIJ_SOCKET_DIR: args.socketDir,
      },
      onData: (_terminalId, data) => {
        const current = this.zellijTuiSessions.get(args.sessionId);
        if (
          current?.sizingClientPtyId !== sizingClientPtyId ||
          current.activeSurface?.clientKind !== "web"
        ) {
          return;
        }
        current.lastSizingClientOutputAtMs = Date.now();
        this.observeNativeTuiOutput(args.sessionId, data);
      },
      onExit: () => {
        const current = this.zellijTuiSessions.get(args.sessionId);
        if (current?.sizingClientPtyId === sizingClientPtyId) {
          delete current.sizingClientPtyId;
          delete current.lastSizingClientOutputAtMs;
        }
      },
    });
    const current = this.zellijTuiSessions.get(args.sessionId);
    if (current) {
      current.sizingClientPtyId = sizingClientPtyId;
    }

    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      const panes = await this.zellijMux.listPanes(args.zellijSessionName).catch(() => []);
      if (panes.length > 0) {
        return sizingClientPtyId;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return sizingClientPtyId;
  }

  private startZellijTuiSubscription(zellij: ZellijTuiSessionState): void {
    zellij.subscription?.close();
    zellij.subscription = this.zellijMux.subscribePane(
      zellij.zellijSessionName,
      zellij.paneId,
      (update) => {
        if (!this.isCurrentZellijTuiSession(zellij)) {
          return;
        }
        zellij.subscriptionRestartAttempts = 0;
        const text = renderZellijViewport(update.viewport);
        this.observeNativeTuiOutput(zellij.sessionId, text);
        this.scheduleNativeTuiMirrorWake(zellij.sessionId);
        if (zellij.activeSurface?.clientKind === "web") {
          // zellij subscribe viewports can briefly use a stale mirror size when
          // ownership moves between terminal and Web. Use the frame only as a
          // repaint signal; dump-screen gives xterm the canonical pane snapshot.
          this.scheduleZellijTuiScreenDump(zellij, { allowWebSizingClientFallback: true });
          return;
        }
        this.deps.ptyHub.appendOutput(zellij.sessionId, text, { replaceReplay: true });
      },
      {
        ansi: true,
        onExit: (exit) => {
          this.handleZellijTuiSubscriptionExit(zellij.sessionId, exit);
        },
      },
    );
    // `zellij subscribe --scrollback` can resend a large scrollback window on
    // every repaint, which makes Codex/Claude feel slow through the web TUI.
    // Seed the client once, then stream viewport snapshots only.
    void this.dumpZellijTuiScreen(zellij);
  }

  private scheduleZellijTuiScreenDump(
    zellij: ZellijTuiSessionState,
    options: { allowWebSizingClientFallback?: boolean } = {},
  ): void {
    if (!this.isCurrentZellijTuiSession(zellij)) {
      return;
    }
    zellij.dumpPending = true;
    if (options.allowWebSizingClientFallback === true) {
      zellij.dumpAllowWebSizingClientFallback = true;
    }
    if (zellij.dumpTimer || zellij.dumpInFlight) {
      return;
    }
    zellij.dumpTimer = setTimeout(() => {
      delete zellij.dumpTimer;
      void this.flushZellijTuiScreenDump(zellij);
    }, 35);
    zellij.dumpTimer.unref?.();
  }

  private async flushZellijTuiScreenDump(zellij: ZellijTuiSessionState): Promise<void> {
    if (!this.isCurrentZellijTuiSession(zellij)) {
      return;
    }
    if (zellij.dumpInFlight) {
      zellij.dumpPending = true;
      return;
    }
    zellij.dumpPending = false;
    zellij.dumpInFlight = true;
    const allowWebSizingClientFallback = zellij.dumpAllowWebSizingClientFallback === true;
    delete zellij.dumpAllowWebSizingClientFallback;
    try {
      await this.dumpZellijTuiScreen(zellij, { allowWebSizingClientFallback });
    } finally {
      zellij.dumpInFlight = false;
      if (zellij.dumpPending && this.isCurrentZellijTuiSession(zellij)) {
        zellij.dumpPending = false;
        const pendingAllowWebSizingClientFallback =
          zellij.dumpAllowWebSizingClientFallback === true;
        delete zellij.dumpAllowWebSizingClientFallback;
        this.scheduleZellijTuiScreenDump(zellij, {
          allowWebSizingClientFallback: pendingAllowWebSizingClientFallback,
        });
      }
    }
  }

  private async dumpZellijTuiScreen(
    zellij: ZellijTuiSessionState,
    options: { allowWebSizingClientFallback?: boolean } = {},
  ): Promise<void> {
    if (
      zellij.activeSurface?.clientKind === "web" &&
      zellij.sizingClientPtyId &&
      options.allowWebSizingClientFallback !== true
    ) {
      return;
    }
    const dumped = await this.zellijMux
      .dumpScreen(zellij.zellijSessionName, zellij.paneId, { ansi: true })
      .catch((error) => {
        this.handleZellijTuiInputFailure(zellij, error);
        return "";
      });
    if (!dumped || !this.isCurrentZellijTuiSession(zellij)) {
      return;
    }
    const text = renderZellijDump(dumped);
    this.deps.ptyHub.appendOutput(zellij.sessionId, text, { replaceReplay: true });
    this.observeNativeTuiOutput(zellij.sessionId, text);
  }

  private isCurrentZellijTuiSession(zellij: ZellijTuiSessionState): boolean {
    return (
      this.zellijTuiSessions.get(zellij.sessionId) === zellij &&
      this.deps.sessionStore.getSession(zellij.sessionId) !== undefined
    );
  }

  private handleZellijTuiSubscriptionExit(
    sessionId: string,
    exit: { code?: number | null; signal?: NodeJS.Signals | null; error?: Error },
  ): void {
    const zellij = this.zellijTuiSessions.get(sessionId);
    if (!zellij) {
      return;
    }
    void this.pollZellijTuiExit(sessionId).then(() => {
      const current = this.zellijTuiSessions.get(sessionId);
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
            detail: "zellij subscription stopped repeatedly.",
          },
        });
        return;
      }
      current.subscriptionRestartTimer = setTimeout(() => {
        const latest = this.zellijTuiSessions.get(sessionId);
        if (!latest) {
          return;
        }
        delete latest.subscriptionRestartTimer;
        this.startZellijTuiSubscription(latest);
      }, 500);
      current.subscriptionRestartTimer.unref?.();
      console.warn("[rah] zellij TUI subscription exited; scheduling reconnect", {
        sessionId,
        zellijSessionName: current.zellijSessionName,
        paneId: current.paneId,
        attempts,
        ...(exit.code !== undefined ? { code: exit.code } : {}),
        ...(exit.signal !== undefined ? { signal: exit.signal } : {}),
        ...(exit.error ? { error: exit.error.message } : {}),
      });
    });
  }

  private async writeZellijTuiInput(
    zellij: ZellijTuiSessionState,
    data: string,
  ): Promise<void> {
    await this.zellijMux.writeBytes(zellij.zellijSessionName, zellij.paneId, data);
  }

  private async writeZellijTuiText(
    zellij: ZellijTuiSessionState,
    text: string,
  ): Promise<void> {
    if (!text) {
      return;
    }
    await this.zellijMux.writeChars(zellij.zellijSessionName, zellij.paneId, text);
  }

  private async withZellijActionSurface<T>(
    zellij: ZellijTuiSessionState,
    action: () => Promise<T>,
  ): Promise<T> {
    const previousAction = zellij.actionQueue ?? Promise.resolve();
    const queuedAction = previousAction.catch(() => undefined).then(() =>
      this.withZellijGlobalAction(() => this.withZellijActionSurfaceNow(zellij, action)),
    );
    const actionTail = queuedAction.then(
      () => undefined,
      () => undefined,
    );
    zellij.actionQueue = actionTail;
    void actionTail.finally(() => {
      if (zellij.actionQueue === actionTail) {
        delete zellij.actionQueue;
      }
    });
    return queuedAction;
  }

  private async withZellijGlobalAction<T>(action: () => Promise<T>): Promise<T> {
    const previousAction = this.zellijActionQueue ?? Promise.resolve();
    const queuedAction = previousAction.catch(() => undefined).then(action);
    const actionTail = queuedAction.then(
      () => undefined,
      () => undefined,
    );
    this.zellijActionQueue = actionTail;
    void actionTail.finally(() => {
      if (this.zellijActionQueue === actionTail) {
        delete this.zellijActionQueue;
      }
    });
    return queuedAction;
  }

  private async withZellijActionSurfaceNow<T>(
    zellij: ZellijTuiSessionState,
    action: () => Promise<T>,
  ): Promise<T> {
    const needsSizingClient = zellij.activeSurface?.clientKind === "web";
    if (needsSizingClient) {
      await this.ensureZellijTuiSizingClient(
        zellij,
        zellij.activeSurface?.cols ?? DEFAULT_ZELLIJ_TUI_COLS,
        zellij.activeSurface?.rows ?? DEFAULT_ZELLIJ_TUI_ROWS,
      );
      await new Promise((resolve) => setTimeout(resolve, ZELLIJ_TUI_SURFACE_SETTLE_MS));
    }
    // Active Web TUI surfaces own the sizing client lifecycle. Chat-only
    // actions without a visible surface should not create or close a zellij
    // attach client; direct pane-targeted actions are more reliable and avoid
    // stealing redraw ownership from an existing terminal attach.
    return await action();
  }

  private handleZellijTuiInputFailure(zellij: ZellijTuiSessionState, error: unknown): void {
    if (isZellijSessionMissingError(error)) {
      void this.pollZellijTuiExit(zellij.sessionId);
      return;
    }
    console.warn("[rah] failed to write zellij TUI input", {
      sessionId: zellij.sessionId,
      zellijSessionName: zellij.zellijSessionName,
      paneId: zellij.paneId,
      error,
    });
    this.deps.eventBus.publish({
      sessionId: zellij.sessionId,
      type: "runtime.status",
      source: SYSTEM_SOURCE,
      payload: {
        status: "error",
        detail: "Failed to write input to zellij TUI.",
      },
    });
  }

  private async pollZellijTuiExit(sessionId: string): Promise<void> {
    const zellij = this.zellijTuiSessions.get(sessionId);
    if (!zellij) {
      return;
    }
    const panes = await this.zellijMux.listPanes(zellij.zellijSessionName).catch((error) => {
      if (isZellijSessionMissingError(error)) {
        return null;
      }
      console.warn("[rah] failed to poll zellij pane state", {
        sessionId,
        zellijSessionName: zellij.zellijSessionName,
        paneId: zellij.paneId,
        error,
      });
      return undefined;
    });
    if (panes === undefined) {
      return;
    }
    const pane = panes?.find((candidate) => candidate.paneId === zellij.paneId);
    if (panes && pane && !isExitedZellijPane(pane)) {
      zellij.exitPollMisses = 0;
      return;
    }
    if (panes && pane && isExitedZellijPane(pane)) {
      zellij.exitPollMisses = 0;
    } else {
      const misses = (zellij.exitPollMisses ?? 0) + 1;
      zellij.exitPollMisses = misses;
      if (misses < ZELLIJ_TUI_EXIT_MISSING_POLL_THRESHOLD) {
        return;
      }
    }
    const native = this.nativeTuiSessions.get(sessionId);
    const expectedClose = this.closingNativeTuiSessionIds.has(sessionId);
    this.clearZellijTuiRuntimeState(sessionId);
    this.clearNativeTuiRuntimeState(sessionId);
    this.nativeTuiSessionIds.delete(sessionId);
    this.closingNativeTuiSessionIds.delete(sessionId);
    this.deps.ptyHub.emitExit(sessionId, pane?.exitStatus ?? undefined, undefined);
    const currentState = this.deps.sessionStore.getSession(sessionId);
    if (currentState) {
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
    this.deps.ptyHub.removeSession(sessionId);
    if (native && !expectedClose) {
      recordNativeTuiProcessExitDiagnostic(this.nativeTuiDiagnostics, native, {
        ...(pane?.exitStatus !== null && pane?.exitStatus !== undefined
          ? { exitCode: pane.exitStatus }
          : {}),
      });
    }
    await this.removeZellijMuxSession(zellij.zellijSessionName).catch(() => undefined);
  }

  private async closeZellijTuiSession(zellij: ZellijTuiSessionState): Promise<void> {
    await this.zellijMux.closePane(zellij.zellijSessionName, zellij.paneId).catch((error) => {
      if (isZellijSessionMissingError(error)) {
        return;
      }
      console.warn("[rah] failed to close zellij pane, falling back to kill-session", {
        sessionId: zellij.sessionId,
        zellijSessionName: zellij.zellijSessionName,
        paneId: zellij.paneId,
        error,
      });
    });
    const deadline = Date.now() + 1_500;
    while (Date.now() < deadline) {
      const panes = await this.zellijMux.listPanes(zellij.zellijSessionName).catch(() => []);
      const pane = panes.find((candidate) => candidate.paneId === zellij.paneId);
      if (!pane || isExitedZellijPane(pane)) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await this.removeZellijMuxSession(zellij.zellijSessionName).catch((error) => {
      if (isZellijSessionMissingError(error)) {
        return;
      }
      console.warn("[rah] failed to remove zellij session", {
        sessionId: zellij.sessionId,
        zellijSessionName: zellij.zellijSessionName,
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
    const zellijSessions = Array.from(this.zellijTuiSessions.values());
    for (const zellij of zellijSessions) {
      this.clearZellijTuiRuntimeState(zellij.sessionId);
      await this.closeZellijTuiSession(zellij).catch((error) => {
        console.error("[rah] failed to kill zellij session during shutdown", {
          sessionId: zellij.sessionId,
          zellijSessionName: zellij.zellijSessionName,
          error,
        });
      });
    }
    for (const sessionId of this.nativeTuiSessions.keys()) {
      this.clearNativeTuiRuntimeState(sessionId);
    }
    this.nativeTuiSessionIds.clear();
    const results = await this.ptySessions.closeAll();
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

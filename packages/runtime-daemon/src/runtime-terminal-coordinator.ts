import type {
  CloseSessionRequest,
  IndependentTerminalStartRequest,
  IndependentTerminalStartResponse,
  NativeTuiDiagnostic,
  PermissionResponseRequest,
  ProviderKind,
  StartSessionRequest,
  StartSessionResponse,
  RahEvent,
} from "@rah/runtime-protocol";
import type { HistorySnapshotStore } from "./history-snapshots";
import { type ProviderActivity } from "./provider-activity";
import { PtyHub } from "./pty-hub";
import { SessionStore, toSessionSummary, type StoredSessionState } from "./session-store";
import {
  type TerminalWrapperFromDaemonMessage,
  type TerminalWrapperPromptState,
  type WrapperHelloMessage,
  type WrapperProviderBoundMessage,
  type WrapperReadyMessage,
} from "./terminal-wrapper-control";
import { EventBus } from "./event-bus";
import { applyLocalTerminalInput } from "./native-tui-prompt-state";
import { buildExternalLockedModeState } from "./session-mode-utils";
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
import { TerminalWrapperSessionRuntime } from "./terminal-wrapper-session-runtime";
import {
  createZellijSessionNameForRahSession,
  ZellijMuxBackend,
} from "./zellij-mux-backend";
import type { MuxPaneSubscription } from "./mux-runtime";

type RuntimeTerminalCoordinatorDeps = {
  eventBus: EventBus;
  ptyHub: PtyHub;
  sessionStore: SessionStore;
  historySnapshots: HistorySnapshotStore;
  nativeTuiProviders: NativeTuiProviderRuntime;
  nativeTuiMirrors: NativeTuiMirrorProvider;
  enableLegacyWrapperRuntime?: boolean;
  onRememberSession: (state: StoredSessionState) => void;
  onSessionOwnerRemoved: (sessionId: string) => void;
};

type ZellijTuiSessionState = {
  sessionId: string;
  zellijSessionName: string;
  paneId: string;
  socketDir: string;
  subscription?: MuxPaneSubscription;
  exitPollTimer?: ReturnType<typeof setInterval>;
};

function initialNativeTuiPromptState(provider: ProviderKind): TerminalWrapperPromptState {
  // OpenCode paints its input prompt after a full-screen redraw. Keep Web
  // composer input queued until the provider handler sees the prompt marker.
  return provider === "opencode" ? "agent_busy" : "prompt_clean";
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

export function nativeTuiInterruptDataForProvider(provider: ProviderKind): string {
  // Native TUIs treat Ctrl-C inconsistently; for Codex/Claude it can end the
  // process instead of canceling the active turn. Escape is their interactive
  // cancel key. OpenCode requires a second Escape to confirm active-turn stop.
  return provider === "opencode" ? "\u001b\u001b" : "\u001b";
}

function nativeTuiInterruptKeysForProvider(provider: ProviderKind): string[] {
  return provider === "opencode" ? ["Esc", "Esc"] : ["Esc"];
}

function renderZellijViewport(lines: string[]): string {
  return `\u001b[2J\u001b[H${lines.join("\r\n")}`;
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
  private readonly terminalWrappers: TerminalWrapperSessionRuntime | undefined;
  private readonly ptySessions = new PtySessionRuntime();
  private readonly zellijMux = new ZellijMuxBackend();
  private readonly zellijTuiSessions = new Map<string, ZellijTuiSessionState>();
  private readonly nativeTuiSessions = new Map<string, NativeTuiSessionState>();
  private readonly nativeTuiSessionIds = new Set<string>();
  private readonly closingNativeTuiSessionIds = new Set<string>();
  private readonly nativeTuiDiagnostics = new NativeTuiDiagnosticStore();
  private readonly mirrorRuntime: NativeTuiMirrorRuntime;

  constructor(private readonly deps: RuntimeTerminalCoordinatorDeps) {
    this.terminalWrappers =
      deps.enableLegacyWrapperRuntime === true
        ? new TerminalWrapperSessionRuntime(deps)
        : undefined;
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

  private requireTerminalWrappers(): TerminalWrapperSessionRuntime {
    if (!this.terminalWrappers) {
      throw new Error("Legacy terminal wrapper runtime is disabled.");
    }
    return this.terminalWrappers;
  }

  hasWrapperSession(sessionId: string): boolean {
    return this.terminalWrappers?.hasSession(sessionId) ?? false;
  }

  isClosingWrapperSession(sessionId: string): boolean {
    return this.terminalWrappers?.isClosingSession(sessionId) ?? false;
  }

  hasNativeTuiSession(sessionId: string): boolean {
    return this.nativeTuiSessionIds.has(sessionId);
  }

  listNativeTuiDiagnostics(options?: ListNativeTuiDiagnosticsOptions): NativeTuiDiagnostic[] {
    return this.nativeTuiDiagnostics.list(options);
  }

  clearSessionState(sessionId: string): void {
    this.terminalWrappers?.clearSessionState(sessionId);
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

  handleNativeTuiInput(sessionId: string, clientId: string, text: string): boolean {
    const zellij = this.zellijTuiSessions.get(sessionId);
    if (zellij) {
      this.claimWebControl(sessionId, clientId);
      void this.injectZellijTuiChatInput(zellij, text);
      this.updateNativeTuiPromptState(sessionId, "agent_busy");
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
    if (native.promptState !== "prompt_clean") {
      const queued = enqueueNativeTuiQueuedInput(
        native,
        {
          clientId,
          text,
          queuedAt: new Date().toISOString(),
        },
        20,
      );
      if (!queued) {
        throw new Error("Native TUI input queue is full.");
      }
      this.updateNativeTuiPromptState(sessionId, native.promptState);
      return true;
    }
    this.injectNativeTuiChatInput(native, clientId, text);
    return true;
  }

  private injectNativeTuiChatInput(
    native: NativeTuiSessionState,
    clientId: string,
    text: string,
  ): void {
    this.claimWebControl(native.sessionId, clientId);
    // Drain already persisted mirror events before injecting a new chat turn.
    // Otherwise delayed history polling can replay old completions after the
    // new input and incorrectly mark the native TUI session idle.
    this.mirrorRuntime.mirrorSession(native.sessionId);
    native.promptTracker.draftText = "";
    native.lastInjectedInputAtMs = Date.now();
    native.process.write(`${text}\r`);
    this.updateNativeTuiPromptState(native.sessionId, "agent_busy");
  }

  handleNativeTuiInterrupt(sessionId: string, clientId: string): boolean {
    const zellij = this.zellijTuiSessions.get(sessionId);
    if (zellij) {
      const native = this.nativeTuiSessions.get(sessionId);
      this.claimWebControl(sessionId, clientId);
      void this.zellijMux.sendKeys(zellij.zellijSessionName, zellij.paneId, [
        ...nativeTuiInterruptKeysForProvider(native?.provider ?? "codex"),
      ]);
      this.updateNativeTuiPromptState(sessionId, "prompt_clean");
      this.deps.eventBus.publish({
        sessionId,
        type: "runtime.status",
        source: SYSTEM_SOURCE,
        payload: { status: "stopping", detail: "Interrupt requested" },
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
    cancelNativeTuiQueuedInputsForClient(native, clientId);
    native.process.write(nativeTuiInterruptDataForProvider(native.provider));
    native.promptTracker.draftText = "";
    delete native.lastInjectedInputAtMs;
    const activeTurnId = this.deps.sessionStore.getSession(sessionId)?.activeTurnId;
    native.stopPending = true;
    if (activeTurnId) {
      native.stopTurnId = activeTurnId;
    } else {
      delete native.stopTurnId;
    }
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
    if (activeTurnId) {
      this.deps.sessionStore.setActiveTurn(sessionId, undefined);
    }
    if (turnId && activeTurnId) {
      this.deps.eventBus.publish({
        sessionId,
        type: "turn.canceled",
        source: SYSTEM_SOURCE,
        payload: { reason: "interrupted" },
        turnId,
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
    promptState: TerminalWrapperPromptState,
  ): void {
    const native = this.nativeTuiSessions.get(sessionId);
    const existingState = this.deps.sessionStore.getSession(sessionId);
    if (!native || !existingState) {
      return;
    }
    native.promptState = promptState;
    if (promptState === "prompt_clean") {
      delete native.lastInjectedInputAtMs;
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
    const nextRuntimeState = native.stopPending
      ? "running"
      : promptState === "agent_busy"
        ? "running"
        : "idle";
    if (existingState.session.runtimeState !== nextRuntimeState) {
      this.deps.sessionStore.setRuntimeState(sessionId, nextRuntimeState);
      publishSessionStateChanged(this.deps, sessionId, nextRuntimeState);
    }
    if (promptState !== "prompt_clean" || native.queuedInputs.length === 0) {
      return;
    }
    const queued = dequeueNativeTuiQueuedInput(native);
    if (!queued) {
      return;
    }
    this.injectNativeTuiChatInput(native, queued.clientId, queued.text);
  }

  handleWrapperInput(sessionId: string, clientId: string, text: string): boolean {
    return this.terminalWrappers?.handleInput(sessionId, clientId, text) ?? false;
  }

  handleWrapperInterrupt(sessionId: string, clientId: string): boolean {
    return this.terminalWrappers?.handleInterrupt(sessionId, clientId) ?? false;
  }

  requestWrapperClose(sessionId: string, request: CloseSessionRequest): boolean {
    return this.terminalWrappers?.requestClose(sessionId, request) ?? false;
  }

  handlePermissionResponse(
    sessionId: string,
    requestId: string,
    response: PermissionResponseRequest,
  ): boolean {
    return (
      this.terminalWrappers?.handlePermissionResponse(sessionId, requestId, response) ?? false
    );
  }

  handlePtyInput(sessionId: string, data: string): boolean {
    const zellij = this.zellijTuiSessions.get(sessionId);
    if (zellij) {
      const native = this.nativeTuiSessions.get(sessionId);
      if (native) {
        this.observeNativeTuiPtyInput(native, data);
      }
      void this.writeZellijTuiInput(zellij, data);
      return true;
    }
    if (!this.ptySessions.has(sessionId)) {
      return false;
    }
    const native = this.nativeTuiSessions.get(sessionId);
    if (native) {
      this.observeNativeTuiPtyInput(native, data);
    }
    return this.ptySessions.write(sessionId, data);
  }

  handlePtyResize(sessionId: string, cols: number, rows: number): boolean {
    return this.ptySessions.resize(sessionId, cols, rows);
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
      mode: buildExternalLockedModeState(),
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
    const runtimeState = native?.promptState === "agent_busy" ? "running" : "idle";
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
    const initialPromptState = initialNativeTuiPromptState(launch.provider);
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
      mode: buildExternalLockedModeState(),
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
    try {
      const created = await this.zellijMux.createSession({
        sessionName: zellijSessionName,
        cwd: launch.cwd,
        command: launch.command,
        args: launch.args,
        title: `${launch.provider}-${sessionId.slice(0, 8)}`,
        replaceDefaultPane: true,
      });
      zellij = {
        sessionId,
        zellijSessionName,
        paneId: created.paneId,
        socketDir: this.zellijMux.getSocketDir(),
      };
      this.zellijTuiSessions.set(sessionId, zellij);
      const processProxy = {
        shell: "zellij",
        cwd: launch.cwd,
        write: (data: string) => {
          void this.writeZellijTuiInput(zellij!, data);
        },
        resize: () => undefined,
        close: async () => {
          await this.zellijMux.killSession(zellij!.zellijSessionName);
        },
        waitUntilReady: async () => undefined,
      } as unknown as NativeTuiSessionState["process"];
      this.nativeTuiSessions.set(sessionId, {
        sessionId,
        process: processProxy,
        provider: launch.provider,
        cwd: launch.cwd,
        startupTimestampMs,
        ...(launch.env ? { launchEnv: launch.env } : {}),
        promptState: initialPromptState,
        promptTracker: { draftText: "" },
        queuedInputs: [],
        ...(providerSessionId ? { providerSessionId } : {}),
      });
      this.nativeTuiSessionIds.add(sessionId);
      this.deps.sessionStore.patchManagedSession(sessionId, {
        mux: {
          backend: "zellij",
          sessionName: zellijSessionName,
          paneId: created.paneId,
          socketDir: this.zellijMux.getSocketDir(),
        },
      });
      zellij.subscription = this.zellijMux.subscribePane(
        zellijSessionName,
        created.paneId,
        (update) => {
          const text = renderZellijViewport([
            ...(update.scrollback ?? []),
            ...update.viewport,
          ]);
          this.deps.ptyHub.appendOutput(sessionId, text);
          this.observeNativeTuiOutput(sessionId, text);
        },
        { scrollback: 200, ansi: true },
      );
      zellij.exitPollTimer = setInterval(() => {
        void this.pollZellijTuiExit(sessionId);
      }, 500);
      zellij.exitPollTimer.unref?.();
      this.startNativeTuiBindingProbe(sessionId);
      this.mirrorRuntime.startSessionMirror(sessionId);
    } catch (error) {
      this.clearZellijTuiRuntimeState(sessionId);
      this.clearNativeTuiRuntimeState(sessionId);
      this.nativeTuiSessionIds.delete(sessionId);
      this.deps.ptyHub.removeSession(sessionId);
      this.deps.sessionStore.removeSession(sessionId);
      if (zellij) {
        await this.zellijMux.killSession(zellij.zellijSessionName).catch(() => undefined);
      } else {
        await this.zellijMux.killSession(zellijSessionName).catch(() => undefined);
      }
      throw error;
    }

    const runtimeState = initialPromptState === "agent_busy" ? "running" : "idle";
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
      await this.zellijMux.killSession(zellij.zellijSessionName).catch(() => undefined);
      return true;
    }
    if (!this.nativeTuiSessionIds.has(sessionId)) {
      return false;
    }
    this.closingNativeTuiSessionIds.add(sessionId);
    this.clearNativeTuiRuntimeState(sessionId);
    this.nativeTuiSessionIds.delete(sessionId);
    await this.ptySessions.close(sessionId);
    return true;
  }

  private async injectZellijTuiChatInput(
    zellij: ZellijTuiSessionState,
    text: string,
  ): Promise<void> {
    await this.zellijMux.writeChars(zellij.zellijSessionName, zellij.paneId, text);
    await this.zellijMux.sendKeys(zellij.zellijSessionName, zellij.paneId, ["Enter"]);
  }

  private async writeZellijTuiInput(
    zellij: ZellijTuiSessionState,
    data: string,
  ): Promise<void> {
    let textBuffer = "";
    const flushText = async () => {
      if (!textBuffer) {
        return;
      }
      const text = textBuffer;
      textBuffer = "";
      await this.zellijMux.writeChars(zellij.zellijSessionName, zellij.paneId, text);
    };
    for (const char of data) {
      if (char === "\r" || char === "\n") {
        await flushText();
        await this.zellijMux.sendKeys(zellij.zellijSessionName, zellij.paneId, ["Enter"]);
        continue;
      }
      if (char === "\u001b") {
        await flushText();
        await this.zellijMux.sendKeys(zellij.zellijSessionName, zellij.paneId, ["Esc"]);
        continue;
      }
      if (char === "\u0003") {
        await flushText();
        await this.zellijMux.sendKeys(zellij.zellijSessionName, zellij.paneId, ["Ctrl c"]);
        continue;
      }
      textBuffer += char;
    }
    await flushText();
  }

  private async pollZellijTuiExit(sessionId: string): Promise<void> {
    const zellij = this.zellijTuiSessions.get(sessionId);
    if (!zellij) {
      return;
    }
    const panes = await this.zellijMux.listPanes(zellij.zellijSessionName).catch(() => []);
    const pane = panes.find((candidate) => candidate.paneId === zellij.paneId);
    if (!pane?.exited) {
      return;
    }
    const native = this.nativeTuiSessions.get(sessionId);
    const expectedClose = this.closingNativeTuiSessionIds.has(sessionId);
    this.clearZellijTuiRuntimeState(sessionId);
    this.clearNativeTuiRuntimeState(sessionId);
    this.nativeTuiSessionIds.delete(sessionId);
    this.closingNativeTuiSessionIds.delete(sessionId);
    this.deps.ptyHub.emitExit(sessionId, pane.exitStatus ?? undefined, undefined);
    const currentState = this.deps.sessionStore.getSession(sessionId);
    if (currentState) {
      this.deps.sessionStore.patchManagedSession(sessionId, {
        capabilities: buildStoppedNativeTuiSessionCapabilities(currentState.session.provider),
        nativeTui: {
          terminalId: sessionId,
          viewAvailable: true,
          promptState: "prompt_clean",
          queuedInputCount: 0,
        },
      });
      this.deps.sessionStore.setActiveTurn(sessionId, undefined);
      this.deps.sessionStore.setRuntimeState(sessionId, "stopped");
      publishSessionStateChanged(this.deps, sessionId, "stopped");
    }
    if (native && !expectedClose) {
      recordNativeTuiProcessExitDiagnostic(this.nativeTuiDiagnostics, native, {
        ...(pane.exitStatus !== null ? { exitCode: pane.exitStatus } : {}),
      });
    }
  }

  private startNativeTuiBindingProbe(sessionId: string): void {
    const native = this.nativeTuiSessions.get(sessionId);
    if (
      !native ||
      native.providerSessionId ||
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
    const observation = this.deps.nativeTuiProviders.observeOutput(
      nativeTuiProviderRuntimeSession(native),
      data,
    );
    if (observation.promptClean) {
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

  private probeNativeTuiBinding(sessionId: string): void {
    const native = this.nativeTuiSessions.get(sessionId);
    if (!native || native.providerSessionId) {
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
    if (native.providerSessionId && native.providerSessionId !== providerSessionId) {
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
    publishSessionStarted(this.deps, sessionId);
    this.mirrorRuntime.mirrorSession(sessionId);
  }

  registerTerminalWrapperSession(
    request: WrapperHelloMessage,
    sendMessage: (message: TerminalWrapperFromDaemonMessage) => void,
  ): WrapperReadyMessage {
    return this.requireTerminalWrappers().registerSession(request, sendMessage);
  }

  disconnectTerminalWrapperSession(sessionId: string): void {
    this.terminalWrappers?.disconnectSession(sessionId);
  }

  bindTerminalWrapperProviderSession(message: WrapperProviderBoundMessage): void {
    this.terminalWrappers?.bindProviderSession(message);
  }

  updateTerminalWrapperPromptState(
    sessionId: string,
    promptState: TerminalWrapperPromptState,
  ): void {
    this.terminalWrappers?.updatePromptState(sessionId, promptState);
  }

  applyTerminalWrapperActivity(sessionId: string, activity: ProviderActivity): RahEvent[] {
    return this.terminalWrappers?.applyActivity(sessionId, activity) ?? [];
  }

  appendTerminalWrapperPtyOutput(sessionId: string, data: string): RahEvent[] {
    return this.terminalWrappers?.appendPtyOutput(sessionId, data) ?? [];
  }

  markTerminalWrapperExited(
    sessionId: string,
    options?: { exitCode?: number; signal?: string },
  ): RahEvent[] {
    return this.terminalWrappers?.markExited(sessionId, options) ?? [];
  }

  async shutdown(): Promise<void> {
    this.terminalWrappers?.shutdown();
    const zellijSessions = Array.from(this.zellijTuiSessions.values());
    for (const zellij of zellijSessions) {
      this.clearZellijTuiRuntimeState(zellij.sessionId);
      await this.zellijMux.killSession(zellij.zellijSessionName).catch((error) => {
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

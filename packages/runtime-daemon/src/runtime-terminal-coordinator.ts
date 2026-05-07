import type {
  CloseSessionRequest,
  IndependentTerminalStartRequest,
  IndependentTerminalStartResponse,
  NativeTuiDiagnostic,
  PermissionResponseRequest,
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
import { buildNativeTuiSessionCapabilities } from "./runtime-terminal-capabilities";
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

export class RuntimeTerminalCoordinator {
  private readonly terminalWrappers: TerminalWrapperSessionRuntime | undefined;
  private readonly ptySessions = new PtySessionRuntime();
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
    this.clearNativeTuiRuntimeState(sessionId);
    this.nativeTuiSessionIds.delete(sessionId);
  }

  private clearNativeTuiRuntimeState(sessionId: string): void {
    const native = this.nativeTuiSessions.get(sessionId);
    clearNativeTuiSessionTimers(native);
    this.nativeTuiDiagnostics.clearSession(sessionId);
    this.nativeTuiSessions.delete(sessionId);
  }

  handleNativeTuiInput(sessionId: string, clientId: string, text: string): boolean {
    const native = this.nativeTuiSessions.get(sessionId);
    if (!native) {
      if (this.nativeTuiSessionIds.has(sessionId)) {
        throw new Error("Native TUI process is not running.");
      }
      return false;
    }
    this.claimWebControl(sessionId, clientId);
    if (native.promptState === "prompt_dirty") {
      throw new Error(
        "Native TUI prompt is not clean. Switch to TUI or clear the current prompt before sending from chat.",
      );
    }
    if (native.promptState === "agent_busy") {
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
    const native = this.nativeTuiSessions.get(sessionId);
    if (!native) {
      if (this.nativeTuiSessionIds.has(sessionId)) {
        throw new Error("Native TUI process is not running.");
      }
      return false;
    }
    this.claimWebControl(sessionId, clientId);
    cancelNativeTuiQueuedInputsForClient(native, clientId);
    native.process.write("\u0003");
    native.promptTracker.draftText = "";
    delete native.lastInjectedInputAtMs;
    this.updateNativeTuiPromptState(sessionId, "prompt_dirty");
    const activeTurnId = this.deps.sessionStore.getSession(sessionId)?.activeTurnId;
    this.deps.sessionStore.setActiveTurn(sessionId, undefined);
    this.deps.sessionStore.setRuntimeState(sessionId, "idle");
    if (activeTurnId) {
      this.deps.eventBus.publish({
        sessionId,
        type: "turn.canceled",
        source: SYSTEM_SOURCE,
        payload: { reason: "interrupted" },
        turnId: activeTurnId,
      });
    }
    publishSessionStateChanged(this.deps, sessionId, "idle");
    return true;
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
    const nextPromptState = applyLocalTerminalInput({
      tracker: native.promptTracker,
      promptState: native.promptState,
      data,
    });
    if (
      data.includes("\u001b") &&
      !data.includes("\u0003") &&
      nextPromptState === native.promptState &&
      native.promptTracker.draftText.length === 0
    ) {
      this.updateNativeTuiPromptState(native.sessionId, "prompt_dirty");
      return;
    }
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
    this.deps.sessionStore.patchManagedSession(sessionId, {
      nativeTui: {
        terminalId: sessionId,
        viewAvailable: true,
        promptState,
      },
    });
    this.deps.eventBus.publish({
      sessionId,
      type: "session.native_tui.prompt_state.changed",
      source: SYSTEM_SOURCE,
      payload: { promptState },
    });
    if (promptState === "prompt_clean") {
      delete native.lastInjectedInputAtMs;
    }
    const nextRuntimeState = promptState === "agent_busy" ? "running" : "idle";
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
        promptState: "prompt_clean",
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
          if (this.deps.sessionStore.getSession(terminalId)) {
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
      promptState: "prompt_clean",
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

    const readyState = this.deps.sessionStore.setRuntimeState(sessionId, "idle");
    publishSessionStateChanged(this.deps, sessionId, "idle");
    return { session: toSessionSummary(readyState) };
  }

  async closeNativeTuiSession(sessionId: string): Promise<boolean> {
    if (!this.nativeTuiSessionIds.has(sessionId)) {
      return false;
    }
    this.closingNativeTuiSessionIds.add(sessionId);
    this.clearNativeTuiRuntimeState(sessionId);
    this.nativeTuiSessionIds.delete(sessionId);
    await this.ptySessions.close(sessionId);
    return true;
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

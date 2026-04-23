import type {
  CloseSessionRequest,
  IndependentTerminalSession,
  IndependentTerminalStartRequest,
  IndependentTerminalStartResponse,
  PermissionResponseRequest,
  RahEvent,
} from "@rah/runtime-protocol";
import type { HistorySnapshotStore } from "./history-snapshots";
import { IndependentTerminalProcess } from "./independent-terminal";
import { applyProviderActivity, type ProviderActivity } from "./provider-activity";
import { PtyHub } from "./pty-hub";
import { SessionStore, type StoredSessionState } from "./session-store";
import {
  TerminalWrapperRegistry,
  type TerminalWrapperFromDaemonMessage,
  type TerminalWrapperPromptState,
  type WrapperHelloMessage,
  type WrapperProviderBoundMessage,
  type WrapperReadyMessage,
} from "./terminal-wrapper-control";
import { EventBus } from "./event-bus";
import { resolveUserPath } from "./workbench-directory-utils";

const SYSTEM_SOURCE = {
  provider: "system" as const,
  channel: "system" as const,
  authority: "authoritative" as const,
};

type IndependentTerminalState = {
  id: string;
  cwd: string;
  shell: string;
  process: IndependentTerminalProcess;
};

type RuntimeTerminalCoordinatorDeps = {
  eventBus: EventBus;
  ptyHub: PtyHub;
  sessionStore: SessionStore;
  historySnapshots: HistorySnapshotStore;
  onRememberSession: (state: StoredSessionState) => void;
  onSessionOwnerRemoved: (sessionId: string) => void;
};

export class RuntimeTerminalCoordinator {
  private readonly terminalWrappers = new TerminalWrapperRegistry();
  private readonly terminalWrapperSenders = new Map<
    string,
    (message: TerminalWrapperFromDaemonMessage) => void
  >();
  private readonly closingTerminalWrapperSessionIds = new Set<string>();
  private readonly independentTerminals = new Map<string, IndependentTerminalState>();

  constructor(private readonly deps: RuntimeTerminalCoordinatorDeps) {}

  hasWrapperSession(sessionId: string): boolean {
    return this.terminalWrappers.get(sessionId) !== undefined;
  }

  isClosingWrapperSession(sessionId: string): boolean {
    return this.closingTerminalWrapperSessionIds.has(sessionId);
  }

  clearSessionState(sessionId: string): void {
    this.terminalWrappers.remove(sessionId);
    this.terminalWrapperSenders.delete(sessionId);
    this.closingTerminalWrapperSessionIds.delete(sessionId);
  }

  handleWrapperInput(sessionId: string, clientId: string, text: string): boolean {
    const wrapper = this.terminalWrappers.get(sessionId);
    if (!wrapper) {
      return false;
    }
    const queuedTurn = this.terminalWrappers.enqueueRemoteTurn(sessionId, clientId, text);
    const sender = this.terminalWrapperSenders.get(sessionId);
    if (sender) {
      if (wrapper.promptState === "prompt_clean") {
        const injectable = this.terminalWrappers.dequeueInjectableTurn(sessionId);
        if (injectable) {
          sender({ type: "turn.inject", sessionId, queuedTurn: injectable });
        }
      } else {
        sender({ type: "turn.enqueue", sessionId, queuedTurn });
      }
    }
    return true;
  }

  handleWrapperInterrupt(sessionId: string, clientId: string): boolean {
    if (!this.terminalWrappers.get(sessionId)) {
      return false;
    }
    this.terminalWrapperSenders.get(sessionId)?.({
      type: "turn.interrupt",
      sessionId,
      sourceSurfaceId: clientId,
    });
    return true;
  }

  requestWrapperClose(sessionId: string, request: CloseSessionRequest): boolean {
    if (!this.terminalWrappers.get(sessionId)) {
      return false;
    }
    this.closingTerminalWrapperSessionIds.add(sessionId);
    this.deps.sessionStore.setRuntimeState(sessionId, "stopped");
    this.terminalWrapperSenders.get(sessionId)?.({
      type: "wrapper.close",
      sessionId,
    });
    this.deps.eventBus.publish({
      sessionId,
      type: "session.closed",
      source: SYSTEM_SOURCE,
      payload: {
        clientId: request.clientId,
      },
    });
    return true;
  }

  handlePermissionResponse(
    sessionId: string,
    requestId: string,
    response: PermissionResponseRequest,
  ): boolean {
    if (!this.terminalWrappers.get(sessionId)) {
      return false;
    }
    this.terminalWrapperSenders.get(sessionId)?.({
      type: "permission.resolve",
      sessionId,
      requestId,
      response,
    });
    return true;
  }

  handlePtyInput(sessionId: string, data: string): boolean {
    const terminal = this.independentTerminals.get(sessionId);
    if (!terminal) {
      return false;
    }
    terminal.process.write(data);
    return true;
  }

  handlePtyResize(sessionId: string, cols: number, rows: number): boolean {
    const terminal = this.independentTerminals.get(sessionId);
    if (!terminal) {
      return false;
    }
    terminal.process.resize(cols, rows);
    return true;
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
    const process = new IndependentTerminalProcess({
      cwd,
      ...(request?.cols !== undefined ? { cols: request.cols } : {}),
      ...(request?.rows !== undefined ? { rows: request.rows } : {}),
      onData: (data) => {
        this.deps.ptyHub.appendOutput(id, data);
      },
      onExit: (args) => {
        this.deps.ptyHub.emitExit(id, args.exitCode, args.signal);
        this.independentTerminals.delete(id);
      },
    });
    try {
      await process.waitUntilReady();
    } catch (error) {
      await process.close().catch(() => undefined);
      this.deps.ptyHub.removeSession(id);
      throw error;
    }
    this.independentTerminals.set(id, {
      id,
      cwd,
      shell: process.shell,
      process,
    });
    const terminal: IndependentTerminalSession = {
      id,
      cwd,
      shell: process.shell,
    };
    return { terminal };
  }

  async closeIndependentTerminal(id: string): Promise<void> {
    const terminal = this.independentTerminals.get(id);
    if (!terminal) {
      return;
    }
    this.independentTerminals.delete(id);
    await terminal.process.close();
    this.deps.ptyHub.removeSession(id);
  }

  registerTerminalWrapperSession(
    request: WrapperHelloMessage,
    sendMessage: (message: TerminalWrapperFromDaemonMessage) => void,
  ): WrapperReadyMessage {
    const state = this.deps.sessionStore.createManagedSession({
      provider: request.provider,
      ...(request.resumeProviderSessionId
        ? { providerSessionId: request.resumeProviderSessionId }
        : {}),
      launchSource: "terminal",
      cwd: request.cwd,
      rootDir: request.rootDir,
      title: `${request.provider} terminal session`,
      preview: request.launchCommand.join(" "),
      capabilities: {
        steerInput: true,
        queuedInput: true,
      },
    });
    this.deps.ptyHub.ensureSession(state.session.id);
    this.deps.sessionStore.setRuntimeState(state.session.id, "running");
    this.deps.eventBus.publish({
      sessionId: state.session.id,
      type: "session.created",
      source: SYSTEM_SOURCE,
      payload: { session: state.session },
    });
    this.deps.eventBus.publish({
      sessionId: state.session.id,
      type: "session.started",
      source: SYSTEM_SOURCE,
      payload: { session: state.session },
    });

    const surfaceId = `terminal:${request.terminalPid}:${crypto.randomUUID()}`;
    const operatorGroupId = `terminal-group:${state.session.id}`;
    this.terminalWrappers.register({
      sessionId: state.session.id,
      provider: request.provider,
      cwd: request.cwd,
      rootDir: request.rootDir,
      terminalPid: request.terminalPid,
      launchCommand: request.launchCommand,
      surfaceId,
      operatorGroupId,
      promptState: "agent_busy",
      ...(request.resumeProviderSessionId
        ? { resumeProviderSessionId: request.resumeProviderSessionId }
        : {}),
    });
    this.terminalWrapperSenders.set(state.session.id, sendMessage);
    this.deps.sessionStore.attachClient({
      sessionId: state.session.id,
      clientId: surfaceId,
      kind: "terminal",
      connectionId: surfaceId,
      attachMode: "interactive",
      focus: true,
    });
    this.deps.sessionStore.claimControl(state.session.id, surfaceId, "terminal");
    this.deps.eventBus.publish({
      sessionId: state.session.id,
      type: "session.attached",
      source: SYSTEM_SOURCE,
      payload: {
        clientId: surfaceId,
        clientKind: "terminal",
      },
    });
    this.deps.eventBus.publish({
      sessionId: state.session.id,
      type: "control.claimed",
      source: SYSTEM_SOURCE,
      payload: {
        clientId: surfaceId,
        clientKind: "terminal",
      },
    });
    return {
      type: "wrapper.ready",
      sessionId: state.session.id,
      surfaceId,
      operatorGroupId,
    };
  }

  disconnectTerminalWrapperSession(sessionId: string): void {
    if (!this.terminalWrappers.get(sessionId)) {
      this.terminalWrapperSenders.delete(sessionId);
      return;
    }
    void this.markTerminalWrapperExited(sessionId);
  }

  bindTerminalWrapperProviderSession(message: WrapperProviderBoundMessage): void {
    if (
      this.closingTerminalWrapperSessionIds.has(message.sessionId) ||
      !this.terminalWrappers.get(message.sessionId) ||
      !this.deps.sessionStore.getSession(message.sessionId)
    ) {
      return;
    }
    const update = this.terminalWrappers.bindProviderSession({
      sessionId: message.sessionId,
      providerSessionId: message.providerSessionId,
      ...(message.providerTitle !== undefined ? { providerTitle: message.providerTitle } : {}),
      ...(message.providerPreview !== undefined ? { providerPreview: message.providerPreview } : {}),
      ...(message.reason !== undefined ? { reason: message.reason } : {}),
    });
    if (!update.changed) {
      return;
    }
    const isRebind =
      update.previousProviderSessionId !== undefined &&
      update.previousProviderSessionId !== message.providerSessionId;
    this.deps.sessionStore.patchManagedSession(message.sessionId, {
      providerSessionId: message.providerSessionId,
      ...(message.providerTitle !== undefined ? { title: message.providerTitle } : {}),
      ...(message.providerPreview !== undefined ? { preview: message.providerPreview } : {}),
    });
    if (isRebind) {
      this.deps.sessionStore.setActiveTurn(message.sessionId);
      this.deps.sessionStore.updateUsage(message.sessionId, undefined);
      this.deps.sessionStore.setRuntimeState(message.sessionId, "idle");
      this.deps.historySnapshots.clear(message.sessionId);
    }
    const state = this.deps.sessionStore.getSession(message.sessionId);
    if (state) {
      this.deps.eventBus.publish({
        sessionId: message.sessionId,
        type: "session.started",
        source: SYSTEM_SOURCE,
        payload: { session: state.session },
      });
    }
    if (
      !isRebind &&
      update.binding.resumeProviderSessionId &&
      update.binding.resumeProviderSessionId !== message.providerSessionId
    ) {
      throw new Error(
        `Wrapper bound provider session ${message.providerSessionId} but expected ${update.binding.resumeProviderSessionId}.`,
      );
    }
  }

  updateTerminalWrapperPromptState(
    sessionId: string,
    promptState: TerminalWrapperPromptState,
  ): void {
    const existingState = this.deps.sessionStore.getSession(sessionId);
    if (
      this.closingTerminalWrapperSessionIds.has(sessionId) ||
      !this.terminalWrappers.get(sessionId) ||
      !existingState
    ) {
      return;
    }
    this.terminalWrappers.updatePromptState(sessionId, promptState);
    const nextRuntimeState = promptState === "agent_busy" ? "running" : "idle";
    if (existingState.session.runtimeState !== nextRuntimeState) {
      this.deps.sessionStore.setRuntimeState(sessionId, nextRuntimeState);
      this.deps.eventBus.publish({
        sessionId,
        type: "session.state.changed",
        source: SYSTEM_SOURCE,
        payload: {
          state: nextRuntimeState,
        },
      });
    }
    if (promptState !== "prompt_clean") {
      return;
    }
    const injectable = this.terminalWrappers.dequeueInjectableTurn(sessionId);
    if (injectable) {
      this.terminalWrapperSenders.get(sessionId)?.({
        type: "turn.inject",
        sessionId,
        queuedTurn: injectable,
      });
    }
  }

  applyTerminalWrapperActivity(sessionId: string, activity: ProviderActivity): RahEvent[] {
    if (this.closingTerminalWrapperSessionIds.has(sessionId)) {
      return [];
    }
    const session = this.deps.sessionStore.getSession(sessionId)?.session;
    if (!session) {
      return [];
    }
    return applyProviderActivity(
      {
        eventBus: this.deps.eventBus,
        ptyHub: this.deps.ptyHub,
        sessionStore: this.deps.sessionStore,
      },
      sessionId,
      {
        provider: session.provider,
        authority: "authoritative",
      },
      activity,
    );
  }

  appendTerminalWrapperPtyOutput(sessionId: string, data: string): RahEvent[] {
    if (
      this.closingTerminalWrapperSessionIds.has(sessionId) ||
      !this.deps.sessionStore.getSession(sessionId)
    ) {
      return [];
    }
    return this.applyTerminalWrapperActivity(sessionId, {
      type: "terminal_output",
      data,
    });
  }

  markTerminalWrapperExited(
    sessionId: string,
    options?: { exitCode?: number; signal?: string },
  ): RahEvent[] {
    const state = this.deps.sessionStore.getSession(sessionId);
    if (!state) {
      this.terminalWrapperSenders.delete(sessionId);
      this.terminalWrappers.remove(sessionId);
      this.closingTerminalWrapperSessionIds.delete(sessionId);
      return [];
    }
    const published = this.applyTerminalWrapperActivity(sessionId, {
      type: "terminal_exited",
      ...(options?.exitCode !== undefined ? { exitCode: options.exitCode } : {}),
      ...(options?.signal !== undefined ? { signal: options.signal } : {}),
    });
    this.deps.onRememberSession(state);
    this.terminalWrapperSenders.delete(sessionId);
    this.terminalWrappers.remove(sessionId);
    this.closingTerminalWrapperSessionIds.delete(sessionId);
    this.deps.sessionStore.removeSession(sessionId);
    this.deps.ptyHub.removeSession(sessionId);
    this.deps.historySnapshots.clear(sessionId);
    this.deps.onSessionOwnerRemoved(sessionId);
    this.deps.eventBus.publish({
      sessionId,
      type: "session.closed",
      source: SYSTEM_SOURCE,
      payload: {},
    });
    return published;
  }

  async shutdown(): Promise<void> {
    this.terminalWrapperSenders.clear();
    for (const terminal of this.independentTerminals.values()) {
      await terminal.process.close();
      this.deps.ptyHub.removeSession(terminal.id);
    }
    this.independentTerminals.clear();
  }
}

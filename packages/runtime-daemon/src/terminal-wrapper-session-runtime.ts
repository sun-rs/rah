import type {
  CloseSessionRequest,
  PermissionResponseRequest,
  RahEvent,
} from "@rah/runtime-protocol";
import { EventBus } from "./event-bus";
import type { HistorySnapshotStore } from "./history-snapshots";
import { applyProviderActivity, type ProviderActivity } from "./provider-activity";
import type { PtyHub } from "./pty-hub";
import { SessionStore, type StoredSessionState } from "./session-store";
import {
  attachClientAndMaybeClaimControl,
  claimClientControlAndPublish,
  ensureClientAttachedAndPublish,
  publishSessionCreatedAndStarted,
  publishSessionStarted,
  publishSessionStateChanged,
  SYSTEM_SOURCE,
} from "./runtime-session-events";
import { buildExternalLockedModeState } from "./session-mode-utils";
import {
  TerminalWrapperRegistry,
  type TerminalWrapperFromDaemonMessage,
  type TerminalWrapperPromptState,
  type WrapperHelloMessage,
  type WrapperProviderBoundMessage,
  type WrapperReadyMessage,
} from "./terminal-wrapper-control";
import { buildTerminalWrapperSessionCapabilities } from "./runtime-terminal-capabilities";

const PREEMPTIVE_WRAPPER_INTERRUPT_TTL_MS = 1_500;

type TerminalWrapperSessionRuntimeDeps = {
  eventBus: EventBus;
  ptyHub: PtyHub;
  sessionStore: SessionStore;
  historySnapshots: HistorySnapshotStore;
  onRememberSession: (state: StoredSessionState) => void;
  onSessionOwnerRemoved: (sessionId: string) => void;
};

export class TerminalWrapperSessionRuntime {
  private readonly terminalWrappers = new TerminalWrapperRegistry();
  private readonly terminalWrapperSenders = new Map<
    string,
    (message: TerminalWrapperFromDaemonMessage) => void
  >();
  private readonly preemptiveWrapperInterrupts = new Map<string, Map<string, number>>();
  private readonly closingTerminalWrapperSessionIds = new Set<string>();

  constructor(private readonly deps: TerminalWrapperSessionRuntimeDeps) {}

  hasSession(sessionId: string): boolean {
    return this.terminalWrappers.get(sessionId) !== undefined;
  }

  isClosingSession(sessionId: string): boolean {
    return this.closingTerminalWrapperSessionIds.has(sessionId);
  }

  clearSessionState(sessionId: string): void {
    this.terminalWrappers.remove(sessionId);
    this.terminalWrapperSenders.delete(sessionId);
    this.preemptiveWrapperInterrupts.delete(sessionId);
    this.closingTerminalWrapperSessionIds.delete(sessionId);
  }

  handleInput(sessionId: string, clientId: string, text: string): boolean {
    const wrapper = this.terminalWrappers.get(sessionId);
    if (!wrapper) {
      return false;
    }
    this.claimWebControl(sessionId, clientId);
    if (this.consumePreemptiveWrapperInterrupt(sessionId, clientId)) {
      return true;
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

  handleInterrupt(sessionId: string, clientId: string): boolean {
    if (!this.terminalWrappers.get(sessionId)) {
      return false;
    }
    this.terminalWrappers.cancelQueuedTurns(sessionId, clientId);
    this.armPreemptiveWrapperInterrupt(sessionId, clientId);
    this.terminalWrapperSenders.get(sessionId)?.({
      type: "turn.interrupt",
      sessionId,
      sourceSurfaceId: clientId,
    });
    return true;
  }

  requestClose(sessionId: string, request: CloseSessionRequest): boolean {
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

  registerSession(
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
      mode: buildExternalLockedModeState(),
      capabilities: buildTerminalWrapperSessionCapabilities(request.provider),
    });
    this.deps.ptyHub.ensureSession(state.session.id);
    this.deps.sessionStore.setRuntimeState(state.session.id, "running");
    publishSessionCreatedAndStarted(this.deps, state.session.id);

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
    attachClientAndMaybeClaimControl(this.deps, {
      sessionId: state.session.id,
      client: {
        id: surfaceId,
        kind: "terminal",
        connectionId: surfaceId,
      },
      mode: "interactive",
      claimControl: true,
    });
    return {
      type: "wrapper.ready",
      sessionId: state.session.id,
      surfaceId,
      operatorGroupId,
    };
  }

  disconnectSession(sessionId: string): void {
    if (!this.terminalWrappers.get(sessionId)) {
      this.terminalWrapperSenders.delete(sessionId);
      return;
    }
    void this.markExited(sessionId);
  }

  bindProviderSession(message: WrapperProviderBoundMessage): void {
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
    publishSessionStarted(this.deps, message.sessionId);
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

  updatePromptState(sessionId: string, promptState: TerminalWrapperPromptState): void {
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
      publishSessionStateChanged(this.deps, sessionId, nextRuntimeState);
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

  applyActivity(sessionId: string, activity: ProviderActivity): RahEvent[] {
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

  appendPtyOutput(sessionId: string, data: string): RahEvent[] {
    if (
      this.closingTerminalWrapperSessionIds.has(sessionId) ||
      !this.deps.sessionStore.getSession(sessionId)
    ) {
      return [];
    }
    return this.applyActivity(sessionId, {
      type: "terminal_output",
      data,
    });
  }

  markExited(
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
    const published = this.applyActivity(sessionId, {
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

  shutdown(): void {
    this.terminalWrapperSenders.clear();
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

  private armPreemptiveWrapperInterrupt(sessionId: string, clientId: string): void {
    const byClient = this.preemptiveWrapperInterrupts.get(sessionId) ?? new Map<string, number>();
    byClient.set(clientId, Date.now() + PREEMPTIVE_WRAPPER_INTERRUPT_TTL_MS);
    this.preemptiveWrapperInterrupts.set(sessionId, byClient);
  }

  private consumePreemptiveWrapperInterrupt(sessionId: string, clientId: string): boolean {
    const byClient = this.preemptiveWrapperInterrupts.get(sessionId);
    if (!byClient) {
      return false;
    }
    const expiresAt = byClient.get(clientId);
    if (expiresAt === undefined) {
      return false;
    }
    byClient.delete(clientId);
    if (byClient.size === 0) {
      this.preemptiveWrapperInterrupts.delete(sessionId);
    }
    return expiresAt >= Date.now();
  }
}

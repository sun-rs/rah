import type {
  AttachSessionRequest,
  AttachSessionResponse,
  ClaimControlRequest,
  CloseSessionRequest,
  DetachSessionRequest,
  ReleaseControlRequest,
  SessionSummary,
} from "@rah/runtime-protocol";
import type { HistorySnapshotStore } from "./history-snapshots";
import type { ProviderAdapter } from "./provider-adapter";
import { PtyHub } from "./pty-hub";
import { EventBus } from "./event-bus";
import { SessionStore, toSessionSummary, type StoredSessionState } from "./session-store";
import { RuntimeTerminalCoordinator } from "./runtime-terminal-coordinator";

const SYSTEM_SOURCE = {
  provider: "system" as const,
  channel: "system" as const,
  authority: "authoritative" as const,
};

type RuntimeSessionLifecycleDeps = {
  eventBus: EventBus;
  ptyHub: PtyHub;
  sessionStore: SessionStore;
  historySnapshots: HistorySnapshotStore;
  terminals: RuntimeTerminalCoordinator;
  rememberSession: (state: StoredSessionState) => void;
  refreshRememberedState: () => void;
  publishStoredSessionDiscovery: () => void;
  removeSessionOwner: (sessionId: string) => void;
  requireSessionAdapter: (sessionId: string) => ProviderAdapter;
};

export class RuntimeSessionLifecycle {
  constructor(private readonly deps: RuntimeSessionLifecycleDeps) {}

  attachSession(sessionId: string, request: AttachSessionRequest): AttachSessionResponse {
    const state = this.deps.sessionStore.attachClient({
      sessionId,
      clientId: request.client.id,
      kind: request.client.kind,
      connectionId: request.client.connectionId,
      attachMode: request.mode,
      focus: true,
    });

    this.deps.eventBus.publish({
      sessionId,
      type: "session.attached",
      source: SYSTEM_SOURCE,
      payload: {
        clientId: request.client.id,
        clientKind: request.client.kind,
      },
    });

    if (request.claimControl) {
      this.claimControl(sessionId, { client: request.client });
    }

    return { session: toSessionSummary(state) };
  }

  claimControl(sessionId: string, request: ClaimControlRequest): SessionSummary {
    const state = this.deps.sessionStore.attachClient({
      sessionId,
      clientId: request.client.id,
      kind: request.client.kind,
      connectionId: request.client.connectionId,
      attachMode: "interactive",
      focus: true,
    });
    this.deps.sessionStore.claimControl(sessionId, request.client.id, request.client.kind);
    this.deps.eventBus.publish({
      sessionId,
      type: "control.claimed",
      source: SYSTEM_SOURCE,
      payload: {
        clientId: request.client.id,
        clientKind: request.client.kind,
      },
    });
    return toSessionSummary(state);
  }

  releaseControl(sessionId: string, request: ReleaseControlRequest): SessionSummary {
    const state = this.deps.sessionStore.releaseControl(sessionId, request.clientId);
    this.deps.eventBus.publish({
      sessionId,
      type: "control.released",
      source: SYSTEM_SOURCE,
      payload: {
        clientId: request.clientId,
      },
    });
    return toSessionSummary(state);
  }

  async renameSession(sessionId: string, title: string): Promise<SessionSummary> {
    const nextTitle = title.trim();
    if (!nextTitle) {
      throw new Error("Session title is required.");
    }
    const state = this.deps.sessionStore.getSession(sessionId);
    if (!state) {
      throw new Error(`Unknown session ${sessionId}`);
    }
    if (!state.session.capabilities.renameSession || !state.session.providerSessionId) {
      throw new Error("This session does not support provider-native rename.");
    }
    const adapter = this.deps.requireSessionAdapter(sessionId);
    if (!adapter.renameSession) {
      throw new Error(`Provider ${state.session.provider} does not support rename.`);
    }
    const summary = await adapter.renameSession(sessionId, nextTitle);
    const nextState = this.deps.sessionStore.getSession(sessionId);
    if (!nextState) {
      throw new Error(`Unknown session ${sessionId}`);
    }
    this.deps.rememberSession(nextState);
    this.deps.refreshRememberedState();
    this.deps.publishStoredSessionDiscovery();
    return summary;
  }

  async closeSession(sessionId: string, request: CloseSessionRequest): Promise<void> {
    const state = this.deps.sessionStore.getSession(sessionId);
    if (!state) {
      throw new Error(`Unknown session ${sessionId}`);
    }
    if (!this.deps.sessionStore.hasAttachedClient(sessionId, request.clientId)) {
      throw new Error(`Client ${request.clientId} is not attached to ${sessionId}.`);
    }
    this.deps.rememberSession(state);
    this.deps.refreshRememberedState();
    if (this.deps.terminals.requestWrapperClose(sessionId, request)) {
      return;
    }
    const adapter = this.deps.requireSessionAdapter(sessionId);
    await adapter.closeSession?.(sessionId, request);
    this.deps.sessionStore.removeSession(sessionId);
    this.deps.ptyHub.removeSession(sessionId);
    this.deps.historySnapshots.clear(sessionId);
    this.deps.removeSessionOwner(sessionId);
    this.deps.eventBus.publish({
      sessionId,
      type: "session.closed",
      source: SYSTEM_SOURCE,
      payload: {
        clientId: request.clientId,
      },
    });
  }

  detachSession(sessionId: string, request: DetachSessionRequest): SessionSummary {
    const state = this.deps.sessionStore.detachClient(sessionId, request.clientId);
    this.deps.eventBus.publish({
      sessionId,
      type: "session.detached",
      source: SYSTEM_SOURCE,
      payload: {
        clientId: request.clientId,
      },
    });
    return toSessionSummary(state);
  }
}

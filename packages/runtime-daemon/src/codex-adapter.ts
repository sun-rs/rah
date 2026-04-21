import type {
  CloseSessionRequest,
  GitDiffResponse,
  GitStatusResponse,
  InterruptSessionRequest,
  PermissionResponseRequest,
  ResumeSessionRequest,
  ResumeSessionResponse,
  SessionHistoryPageResponse,
  SessionInputRequest,
  SessionSummary,
  StartSessionRequest,
  StartSessionResponse,
  StoredSessionRef,
  WorkspaceSnapshotResponse,
  ContextUsage,
} from "@rah/runtime-protocol";
import type { ProviderAdapter, RuntimeServices } from "./provider-adapter";
import {
  respondToCodexLivePermission,
  resumeCodexLiveSession,
  startCodexLiveSession,
  type LiveCodexSession,
} from "./codex-live-client";
import {
  discoverCodexStoredSessions,
  getCodexGitDiff,
  getCodexGitStatus,
  getCodexStoredSessionHistoryPage,
  getCodexWorkspaceSnapshot,
  resumeCodexStoredSession,
  type CodexStoredSessionRecord,
} from "./codex-stored-sessions";
import {
  finalizeStoredReplayResume,
  prepareProviderSessionResume,
} from "./provider-resume";
import { codexLaunchSpec, probeProviderVersion } from "./provider-diagnostics";
import { toSessionSummary } from "./session-store";

export class CodexAdapter implements ProviderAdapter {
  readonly id = "codex";
  readonly providers: Array<"codex"> = ["codex"];

  private readonly services: RuntimeServices;
  private readonly liveSessions = new Map<string, LiveCodexSession>();
  private readonly rehydratedSessionIds = new Set<string>();
  private readonly rehydratedSessionRecords = new Map<string, CodexStoredSessionRecord>();
  private storedSessionIndex = new Map<string, CodexStoredSessionRecord>();

  constructor(services: RuntimeServices) {
    this.services = services;
  }

  startSession(request: StartSessionRequest): Promise<StartSessionResponse> {
    return startCodexLiveSession({
      services: this.services,
      request,
      onLiveSessionReady: (liveSession) => {
        this.liveSessions.set(liveSession.sessionId, liveSession);
      },
    }).then((response) => ({ session: response.summary }));
  }

  async resumeSession(request: ResumeSessionRequest): Promise<ResumeSessionResponse> {
    prepareProviderSessionResume({
      services: this.services,
      provider: "codex",
      providerSessionId: request.providerSessionId,
      preferStoredReplay: request.preferStoredReplay,
      rehydratedSessionIds: this.rehydratedSessionIds,
    });
    const existing = this.services.sessionStore.findManagedByProviderSession(
      "codex",
      request.providerSessionId,
    );
    if (existing) {
      throw new Error(
        `Provider session codex:${request.providerSessionId} is already running; attach instead of resume.`,
      );
    }

    const record =
      this.refreshStoredSessions().get(request.providerSessionId) ??
      this.storedSessionIndex.get(request.providerSessionId);
    if (!record && request.cwd === undefined) {
      throw new Error(`Unknown Codex session ${request.providerSessionId}.`);
    }

    if (request.preferStoredReplay && record) {
      return finalizeStoredReplayResume({
        services: this.services,
        provider: "codex",
        providerSessionId: request.providerSessionId,
        rehydratedSessionIds: this.rehydratedSessionIds,
        createSession: () => {
          const resumed = resumeCodexStoredSession(
            request.attach !== undefined
              ? { services: this.services, record, attach: request.attach }
              : { services: this.services, record },
          );
          this.rehydratedSessionRecords.set(resumed.sessionId, record);
          return resumed;
        },
      });
    }

    if (record && request.cwd !== undefined && request.cwd !== record.ref.cwd) {
      record.ref = {
        ...record.ref,
        cwd: request.cwd,
        rootDir: request.cwd,
      };
    }

    try {
      const response = await resumeCodexLiveSession({
        services: this.services,
        request,
        ...(record ? { record } : {}),
        onLiveSessionReady: (liveSession) => {
          this.liveSessions.set(liveSession.sessionId, liveSession);
        },
      });
      return { session: response.summary };
    } catch (error) {
      if (!record) {
        throw error;
      }
    }

    return finalizeStoredReplayResume({
      services: this.services,
      provider: "codex",
      providerSessionId: request.providerSessionId,
      rehydratedSessionIds: this.rehydratedSessionIds,
      createSession: () => {
        const resumed = resumeCodexStoredSession(
          request.attach !== undefined
            ? { services: this.services, record, attach: request.attach }
            : { services: this.services, record },
        );
        this.rehydratedSessionRecords.set(resumed.sessionId, record);
        return resumed;
      },
    });
  }

  sendInput(sessionId: string, request: SessionInputRequest): void {
    const live = this.liveSessions.get(sessionId);
    if (live) {
      if (!this.services.sessionStore.hasInputControl(sessionId, request.clientId)) {
        throw new Error(`Client ${request.clientId} does not hold input control for ${sessionId}.`);
      }
      void live.client.request(
        "turn/start",
        {
          threadId: live.threadId,
          input: [{ type: "text", text: request.text }],
          cwd: live.cwd,
        },
        90_000,
      );
      return;
    }
    throw new Error(
      "Rehydrated Codex sessions are currently read-only. Live Codex app-server control is not wired yet.",
    );
  }

  async closeSession(sessionId: string, request: CloseSessionRequest): Promise<void> {
    const state = this.services.sessionStore.getSession(sessionId);
    if (!state) {
      throw new Error(`Unknown session ${sessionId}`);
    }
    if (!state.clients.some((client) => client.id === request.clientId)) {
      throw new Error(`Client ${request.clientId} is not attached to ${sessionId}.`);
    }
    const live = this.liveSessions.get(sessionId);
    if (live) {
      this.liveSessions.delete(sessionId);
      await live.client.dispose();
    }
    this.rehydratedSessionIds.delete(sessionId);
    this.rehydratedSessionRecords.delete(sessionId);
  }

  async destroySession(sessionId: string): Promise<void> {
    const live = this.liveSessions.get(sessionId);
    if (live) {
      this.liveSessions.delete(sessionId);
      await live.client.dispose();
    }
    this.rehydratedSessionIds.delete(sessionId);
    this.rehydratedSessionRecords.delete(sessionId);
  }

  interruptSession(sessionId: string, request: InterruptSessionRequest): SessionSummary {
    const live = this.liveSessions.get(sessionId);
    if (live) {
      if (!this.services.sessionStore.hasInputControl(sessionId, request.clientId)) {
        throw new Error(`Client ${request.clientId} does not hold input control for ${sessionId}.`);
      }
      const turnId = live.currentTurnId;
      if (turnId) {
        void live.client.request("turn/interrupt", {
          threadId: live.threadId,
          turnId,
        });
      }
      const state = this.services.sessionStore.getSession(sessionId);
      if (!state) {
        throw new Error(`Unknown session ${sessionId}`);
      }
      return toSessionSummary(state);
    }
    const state = this.services.sessionStore.getSession(sessionId);
    if (!state) {
      throw new Error(`Unknown session ${sessionId}`);
    }
    return toSessionSummary(state);
  }

  async respondToPermission(
    sessionId: string,
    requestId: string,
    response: PermissionResponseRequest,
  ): Promise<void> {
    const live = this.liveSessions.get(sessionId);
    if (!live) {
      throw new Error(`Session ${sessionId} does not support live permission responses.`);
    }
    await respondToCodexLivePermission({
      services: this.services,
      liveSession: live,
      requestId,
      response,
    });
  }

  onPtyInput(sessionId: string, clientId: string, data: string): void {
    if (this.liveSessions.has(sessionId)) {
      throw new Error("Codex live sessions do not support PTY input bridging yet.");
    }
    void clientId;
    void data;
    throw new Error("Rehydrated Codex sessions do not accept PTY input.");
  }

  onPtyResize(sessionId: string, clientId: string, cols: number, rows: number): void {
    if (this.liveSessions.has(sessionId)) {
      return;
    }
    void sessionId;
    void clientId;
    void cols;
    void rows;
  }

  getWorkspaceSnapshot(sessionId: string): WorkspaceSnapshotResponse {
    const session = this.services.sessionStore.getSession(sessionId)?.session;
    if (!session) {
      const record = this.rehydratedSessionRecords.get(sessionId);
      if (!record) {
        throw new Error(`Unknown session ${sessionId}`);
      }
      const snapshot = getCodexWorkspaceSnapshot(record.ref.cwd ?? process.cwd());
      return {
        sessionId,
        cwd: snapshot.cwd,
        nodes: snapshot.nodes,
      };
    }
    const snapshot = getCodexWorkspaceSnapshot(session.cwd);
    return {
      sessionId,
      cwd: snapshot.cwd,
      nodes: snapshot.nodes,
    };
  }

  getGitStatus(sessionId: string): GitStatusResponse {
    const session = this.services.sessionStore.getSession(sessionId)?.session;
    if (!session) {
      const record = this.rehydratedSessionRecords.get(sessionId);
      if (!record) {
        throw new Error(`Unknown session ${sessionId}`);
      }
      const status = getCodexGitStatus(record.ref.cwd ?? process.cwd());
      return {
        sessionId,
        ...(status.branch !== undefined ? { branch: status.branch } : {}),
        changedFiles: status.changedFiles,
      };
    }
    const status = getCodexGitStatus(session.cwd);
    return {
      sessionId,
      ...(status.branch !== undefined ? { branch: status.branch } : {}),
      changedFiles: status.changedFiles,
    };
  }

  getGitDiff(sessionId: string, targetPath: string): GitDiffResponse {
    const session = this.services.sessionStore.getSession(sessionId)?.session;
    if (!session) {
      const record = this.rehydratedSessionRecords.get(sessionId);
      if (!record) {
        throw new Error(`Unknown session ${sessionId}`);
      }
      return {
        sessionId,
        path: targetPath,
        diff: getCodexGitDiff(record.ref.cwd ?? process.cwd(), targetPath),
      };
    }
    return {
      sessionId,
      path: targetPath,
      diff: getCodexGitDiff(session.cwd, targetPath),
    };
  }

  getSessionHistoryPage(
    sessionId: string,
    options: { beforeTs?: string; limit?: number } = {},
  ): SessionHistoryPageResponse {
    const session = this.services.sessionStore.getSession(sessionId)?.session;
    if (!session) {
      const record = this.rehydratedSessionRecords.get(sessionId);
      if (!record) {
        throw new Error(`Unknown session ${sessionId}`);
      }
      return getCodexStoredSessionHistoryPage({
        sessionId,
        record,
        ...options,
      });
    }
    const providerSessionId = session.providerSessionId;
    if (!providerSessionId) {
      return { sessionId, events: [] };
    }
    const record =
      this.refreshStoredSessions().get(providerSessionId) ??
      this.storedSessionIndex.get(providerSessionId);
    if (!record) {
      return { sessionId, events: [] };
    }
    return getCodexStoredSessionHistoryPage({
      sessionId,
      record,
      ...options,
    });
  }

  getContextUsage(sessionId: string): ContextUsage | undefined {
    return this.services.sessionStore.getSession(sessionId)?.usage;
  }

  listStoredSessions(): StoredSessionRef[] {
    return [...this.refreshStoredSessions().values()].map((record) => record.ref);
  }

  getProviderDiagnostic() {
    return probeProviderVersion("codex", codexLaunchSpec());
  }

  private refreshStoredSessions(): Map<string, CodexStoredSessionRecord> {
    this.storedSessionIndex = new Map(
      discoverCodexStoredSessions().map((record) => [record.ref.providerSessionId, record]),
    );
    return this.storedSessionIndex;
  }

  async shutdown(): Promise<void> {
    for (const live of this.liveSessions.values()) {
      await live.client.dispose();
    }
    this.liveSessions.clear();
  }
}

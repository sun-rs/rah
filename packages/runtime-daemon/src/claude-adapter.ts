import type {
  CloseSessionRequest,
  ContextUsage,
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
} from "@rah/runtime-protocol";
import type { ProviderAdapter, RuntimeServices } from "./provider-adapter";
import {
  type ClaudeQueryFactory,
  closeClaudeLiveSession,
  interruptClaudeLiveSession,
  respondToClaudeLivePermission,
  resumeClaudeLiveSession,
  sendInputToClaudeLiveSession,
  startClaudeLiveSession,
  type LiveClaudeSession,
} from "./claude-live-client";
import {
  type ClaudeStoredSessionRecord,
  discoverClaudeStoredSessions,
  findClaudeStoredSessionRecord,
  getClaudeStoredSessionHistoryPage,
  resumeClaudeStoredSession,
  waitForClaudeStoredSessionRecord,
} from "./claude-session-files";
import {
  finalizeStoredReplayResume,
  prepareProviderSessionResume,
} from "./provider-resume";
import { claudeLaunchSpec, probeProviderVersion } from "./provider-diagnostics";
import { getCodexGitDiff, getCodexGitStatus, getCodexWorkspaceSnapshot } from "./codex-stored-sessions";
import { toSessionSummary } from "./session-store";
import { movePathToTrash } from "./trash";

interface ClaudeAdapterOptions {
  queryFactory?: ClaudeQueryFactory;
}

export class ClaudeAdapter implements ProviderAdapter {
  readonly id = "claude";
  readonly providers: Array<"claude"> = ["claude"];

  private readonly services: RuntimeServices;
  private readonly liveSessions = new Map<string, LiveClaudeSession>();
  private readonly rehydratedSessionIds = new Set<string>();
  private readonly permissionModeByProviderSessionId = new Map<string, LiveClaudeSession["permissionMode"]>();
  private storedSessionIndex = new Map<string, ClaudeStoredSessionRecord>();
  private readonly queryFactory: ClaudeAdapterOptions["queryFactory"];

  constructor(services: RuntimeServices, options: ClaudeAdapterOptions = {}) {
    this.services = services;
    this.queryFactory = options.queryFactory;
  }

  async startSession(request: StartSessionRequest): Promise<StartSessionResponse> {
    const response = await startClaudeLiveSession({
      services: this.services,
      request,
      ...(this.queryFactory ? { queryFactory: this.queryFactory } : {}),
    });
    this.liveSessions.set(response.liveSession.sessionId, response.liveSession);
    if (response.liveSession.providerSessionId) {
      this.permissionModeByProviderSessionId.set(
        response.liveSession.providerSessionId,
        response.liveSession.permissionMode,
      );
    }
    return { session: response.summary };
  }

  async resumeSession(request: ResumeSessionRequest): Promise<ResumeSessionResponse> {
    prepareProviderSessionResume({
      services: this.services,
      provider: "claude",
      providerSessionId: request.providerSessionId,
      preferStoredReplay: request.preferStoredReplay,
      rehydratedSessionIds: this.rehydratedSessionIds,
    });
    const existing = this.services.sessionStore.findManagedByProviderSession(
      "claude",
      request.providerSessionId,
    );
    if (existing) {
      throw new Error(
        `Provider session claude:${request.providerSessionId} is already running; attach instead of resume.`,
      );
    }

    let record = findClaudeStoredSessionRecord(request.providerSessionId, request.cwd);
    if (request.preferStoredReplay ?? true) {
      if (!record) {
        record = await waitForClaudeStoredSessionRecord(
          request.cwd
            ? {
                providerSessionId: request.providerSessionId,
                cwd: request.cwd,
              }
            : {
                providerSessionId: request.providerSessionId,
              },
        );
      }
      if (!record) {
        throw new Error(`Unknown Claude session ${request.providerSessionId}.`);
      }
      const replayRecord = record;
      return finalizeStoredReplayResume({
        services: this.services,
        provider: "claude",
        providerSessionId: request.providerSessionId,
        rehydratedSessionIds: this.rehydratedSessionIds,
        createSession: () =>
          resumeClaudeStoredSession({
            services: this.services,
            record: replayRecord,
            ...(request.attach ? { attach: request.attach } : {}),
          }),
      });
    }

    const response = await resumeClaudeLiveSession({
      services: this.services,
      providerSessionId: request.providerSessionId,
      cwd: request.cwd ?? record?.ref.cwd ?? process.cwd(),
      permissionMode:
        this.permissionModeByProviderSessionId.get(request.providerSessionId) ?? "default",
      ...(request.attach ? { attach: request.attach } : {}),
      ...(this.queryFactory ? { queryFactory: this.queryFactory } : {}),
    });
    this.liveSessions.set(response.liveSession.sessionId, response.liveSession);
    return { session: response.summary };
  }

  sendInput(sessionId: string, request: SessionInputRequest): void {
    const live = this.liveSessions.get(sessionId);
    if (!live) {
      throw new Error("Rehydrated Claude sessions are currently read-only.");
    }
    void sendInputToClaudeLiveSession({
      services: this.services,
      liveSession: live,
      request,
    });
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
      if (live.providerSessionId) {
        this.permissionModeByProviderSessionId.set(
          live.providerSessionId,
          live.permissionMode,
        );
      }
      this.liveSessions.delete(sessionId);
      await closeClaudeLiveSession(live, request);
    }
    this.rehydratedSessionIds.delete(sessionId);
  }

  async destroySession(sessionId: string): Promise<void> {
    const live = this.liveSessions.get(sessionId);
    if (live) {
      if (live.providerSessionId) {
        this.permissionModeByProviderSessionId.set(
          live.providerSessionId,
          live.permissionMode,
        );
      }
      this.liveSessions.delete(sessionId);
      await closeClaudeLiveSession(live);
    }
    this.rehydratedSessionIds.delete(sessionId);
  }

  interruptSession(sessionId: string, request: InterruptSessionRequest): SessionSummary {
    const live = this.liveSessions.get(sessionId);
    if (live) {
      return interruptClaudeLiveSession({
        services: this.services,
        liveSession: live,
        request,
      });
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
    await respondToClaudeLivePermission({
      liveSession: live,
      services: this.services,
      requestId,
      response,
    });
  }

  onPtyInput(): void {
    throw new Error("Claude sessions do not support PTY input bridging.");
  }

  onPtyResize(): void {
    // Claude replay sessions do not use PTY-backed rendering.
  }

  getWorkspaceSnapshot(sessionId: string): WorkspaceSnapshotResponse {
    const state = this.services.sessionStore.getSession(sessionId);
    if (!state) {
      throw new Error(`Unknown session ${sessionId}`);
    }
    const snapshot = getCodexWorkspaceSnapshot(state.session.cwd);
    return {
      sessionId,
      cwd: snapshot.cwd,
      nodes: snapshot.nodes,
    };
  }

  getGitStatus(sessionId: string): GitStatusResponse {
    const state = this.services.sessionStore.getSession(sessionId);
    if (!state) {
      throw new Error(`Unknown session ${sessionId}`);
    }
    const status = getCodexGitStatus(state.session.cwd);
    return {
      sessionId,
      ...(status.branch ? { branch: status.branch } : {}),
      changedFiles: status.changedFiles,
    };
  }

  getGitDiff(sessionId: string, targetPath: string): GitDiffResponse {
    const state = this.services.sessionStore.getSession(sessionId);
    if (!state) {
      throw new Error(`Unknown session ${sessionId}`);
    }
    return {
      sessionId,
      path: targetPath,
      diff: getCodexGitDiff(state.session.cwd, targetPath),
    };
  }

  getSessionHistoryPage(
    sessionId: string,
    options?: { beforeTs?: string; limit?: number },
  ): SessionHistoryPageResponse {
    const state = this.services.sessionStore.getSession(sessionId);
    if (!state?.session.providerSessionId) {
      return { sessionId, events: [] };
    }
    const record = findClaudeStoredSessionRecord(
      state.session.providerSessionId,
      state.session.cwd,
    );
    if (!record) {
      return { sessionId, events: [] };
    }
    return getClaudeStoredSessionHistoryPage({
      sessionId,
      record,
      ...(options?.beforeTs ? { beforeTs: options.beforeTs } : {}),
      ...(options?.limit ? { limit: options.limit } : {}),
    });
  }

  getContextUsage(sessionId: string): ContextUsage | undefined {
    return this.services.sessionStore.getSession(sessionId)?.usage;
  }

  listStoredSessions(): StoredSessionRef[] {
    return [...this.refreshStoredSessions().values()].map((record) => record.ref);
  }

  async removeStoredSession(session: StoredSessionRef): Promise<void> {
    const record =
      this.storedSessionIndex.get(session.providerSessionId) ??
      this.refreshStoredSessions().get(session.providerSessionId);
    if (!record) {
      throw new Error(`Could not find a stored Claude history file for ${session.providerSessionId}.`);
    }
    await movePathToTrash(record.filePath);
    this.storedSessionIndex.delete(session.providerSessionId);
  }

  getProviderDiagnostic() {
    return probeProviderVersion("claude", claudeLaunchSpec());
  }

  private refreshStoredSessions(): Map<string, ClaudeStoredSessionRecord> {
    this.storedSessionIndex = new Map(
      discoverClaudeStoredSessions().map((record) => [record.ref.providerSessionId, record] as const),
    );
    return this.storedSessionIndex;
  }
}

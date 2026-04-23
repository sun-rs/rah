import type {
  CloseSessionRequest,
  ContextUsage,
  GitDiffResponse,
  GitFileActionRequest,
  GitFileActionResponse,
  GitHunkActionRequest,
  GitHunkActionResponse,
  GitStatusResponse,
  InterruptSessionRequest,
  PermissionResponseRequest,
  ResumeSessionRequest,
  ResumeSessionResponse,
  SessionFileResponse,
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
  createClaudeStoredSessionFrozenHistoryPageLoader,
  type ClaudeStoredSessionRecord,
  discoverClaudeStoredSessions,
  findClaudeStoredSessionRecord,
  getClaudeStoredSessionHistoryPage,
  resolveClaudeStoredSessionWatchRoots,
  resumeClaudeStoredSession,
  waitForClaudeStoredSessionRecord,
} from "./claude-session-files";
import {
  finalizeStoredReplayResume,
  prepareProviderSessionResume,
} from "./provider-resume";
import { claudeLaunchSpec, probeProviderDiagnostic } from "./provider-diagnostics";
import {
  applyCodexGitFileAction,
  applyCodexGitHunkAction,
  getCodexGitDiff,
  getCodexGitStatus,
  getCodexWorkspaceSnapshot,
  readWorkspaceFile,
} from "./codex-stored-sessions";
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

  getWorkspaceSnapshot(sessionId: string, options?: { scopeRoot?: string }): WorkspaceSnapshotResponse {
    const state = this.services.sessionStore.getSession(sessionId);
    if (!state) {
      throw new Error(`Unknown session ${sessionId}`);
    }
    const snapshot = getCodexWorkspaceSnapshot(options?.scopeRoot ?? state.session.cwd);
    return {
      sessionId,
      cwd: snapshot.cwd,
      nodes: snapshot.nodes,
    };
  }

  getGitStatus(sessionId: string, options?: { scopeRoot?: string }): GitStatusResponse {
    const state = this.services.sessionStore.getSession(sessionId);
    if (!state) {
      throw new Error(`Unknown session ${sessionId}`);
    }
    const status = getCodexGitStatus(state.session.cwd, options);
    return {
      sessionId,
      ...(status.branch ? { branch: status.branch } : {}),
      changedFiles: status.changedFiles,
      ...(status.stagedFiles ? { stagedFiles: status.stagedFiles } : {}),
      ...(status.unstagedFiles ? { unstagedFiles: status.unstagedFiles } : {}),
      ...(status.totalStaged !== undefined ? { totalStaged: status.totalStaged } : {}),
      ...(status.totalUnstaged !== undefined ? { totalUnstaged: status.totalUnstaged } : {}),
    };
  }

  getGitDiff(
    sessionId: string,
    targetPath: string,
    options?: { staged?: boolean; ignoreWhitespace?: boolean; scopeRoot?: string },
  ): GitDiffResponse {
    const state = this.services.sessionStore.getSession(sessionId);
    if (!state) {
      throw new Error(`Unknown session ${sessionId}`);
    }
    return {
      sessionId,
      path: targetPath,
      diff: getCodexGitDiff(state.session.cwd, targetPath, options),
    };
  }

  applyGitFileAction(sessionId: string, request: GitFileActionRequest): GitFileActionResponse {
    const state = this.services.sessionStore.getSession(sessionId);
    if (!state) {
      throw new Error(`Unknown session ${sessionId}`);
    }
    return {
      ...applyCodexGitFileAction(state.session.cwd, request, {
        scopeRoot: state.session.rootDir ?? state.session.cwd,
      }),
      sessionId,
    };
  }

  applyGitHunkAction(sessionId: string, request: GitHunkActionRequest): GitHunkActionResponse {
    const state = this.services.sessionStore.getSession(sessionId);
    if (!state) {
      throw new Error(`Unknown session ${sessionId}`);
    }
    return {
      ...applyCodexGitHunkAction(state.session.cwd, request, {
        scopeRoot: state.session.rootDir ?? state.session.cwd,
      }),
      sessionId,
    };
  }

  readSessionFile(
    sessionId: string,
    targetPath: string,
    options?: { scopeRoot?: string },
  ): SessionFileResponse {
    const state = this.services.sessionStore.getSession(sessionId);
    if (!state) {
      throw new Error(`Unknown session ${sessionId}`);
    }
    return {
      sessionId,
      ...readWorkspaceFile(state.session.cwd, targetPath, options),
    };
  }

  getSessionHistoryPage(
    sessionId: string,
    options?: { beforeTs?: string; cursor?: string; limit?: number },
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

  createFrozenHistoryPageLoader(sessionId: string) {
    const state = this.services.sessionStore.getSession(sessionId);
    if (!state?.session.providerSessionId) {
      return undefined;
    }
    const record = findClaudeStoredSessionRecord(
      state.session.providerSessionId,
      state.session.cwd,
    );
    if (!record) {
      return undefined;
    }
    return createClaudeStoredSessionFrozenHistoryPageLoader({
      sessionId,
      record,
    });
  }

  getContextUsage(sessionId: string): ContextUsage | undefined {
    return this.services.sessionStore.getSession(sessionId)?.usage;
  }

  listStoredSessions(): StoredSessionRef[] {
    if (this.storedSessionIndex.size === 0) {
      this.refreshStoredSessionIndex();
    }
    return [...this.storedSessionIndex.values()].map((record) => record.ref);
  }

  refreshStoredSessionsCatalog(): StoredSessionRef[] {
    this.refreshStoredSessionIndex();
    return this.listStoredSessions();
  }

  listStoredSessionWatchRoots(): string[] {
    return resolveClaudeStoredSessionWatchRoots();
  }

  async removeStoredSession(session: StoredSessionRef): Promise<void> {
    const record =
      this.storedSessionIndex.get(session.providerSessionId) ??
      this.refreshStoredSessionIndex().get(session.providerSessionId);
    if (!record) {
      throw new Error(`Could not find a stored Claude history file for ${session.providerSessionId}.`);
    }
    await movePathToTrash(record.filePath);
    this.storedSessionIndex.delete(session.providerSessionId);
  }

  getProviderDiagnostic(options?: { forceRefresh?: boolean }) {
    return probeProviderDiagnostic("claude", claudeLaunchSpec(), options);
  }

  private refreshStoredSessionIndex(): Map<string, ClaudeStoredSessionRecord> {
    this.storedSessionIndex = new Map(
      discoverClaudeStoredSessions().map((record) => [record.ref.providerSessionId, record] as const),
    );
    return this.storedSessionIndex;
  }
}

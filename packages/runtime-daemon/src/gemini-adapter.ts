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
  createGeminiStoredSessionFrozenHistoryPageLoader,
  type GeminiStoredSessionRecord,
  discoverGeminiStoredSessions,
  findGeminiStoredSessionRecord,
  getGeminiStoredSessionHistoryPage,
  resolveGeminiStoredSessionWatchRoots,
  resumeGeminiStoredSession,
} from "./gemini-session-files";
import {
  closeGeminiLiveSession,
  interruptGeminiLiveSession,
  resumeGeminiLiveSession,
  sendInputToGeminiLiveSession,
  startGeminiLiveSession,
  type LiveGeminiSession,
} from "./gemini-live-client";
import {
  finalizeStoredReplayResume,
  prepareProviderSessionResume,
} from "./provider-resume";
import { geminiLaunchSpec, probeProviderDiagnostic } from "./provider-diagnostics";
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

export class GeminiAdapter implements ProviderAdapter {
  readonly id = "gemini";
  readonly providers: Array<"gemini"> = ["gemini"];

  private readonly services: RuntimeServices;
  private readonly liveSessions = new Map<string, LiveGeminiSession>();
  private readonly rehydratedSessionIds = new Set<string>();
  private storedSessionIndex = new Map<string, GeminiStoredSessionRecord>();

  constructor(services: RuntimeServices) {
    this.services = services;
  }

  async startSession(request: StartSessionRequest): Promise<StartSessionResponse> {
    const response = startGeminiLiveSession({
      services: this.services,
      request,
    });
    this.liveSessions.set(response.liveSession.sessionId, response.liveSession);
    return { session: response.summary };
  }

  async resumeSession(request: ResumeSessionRequest): Promise<ResumeSessionResponse> {
    prepareProviderSessionResume({
      services: this.services,
      provider: "gemini",
      providerSessionId: request.providerSessionId,
      preferStoredReplay: request.preferStoredReplay,
      rehydratedSessionIds: this.rehydratedSessionIds,
    });
    const existing = this.services.sessionStore.findManagedByProviderSession(
      "gemini",
      request.providerSessionId,
    );
    if (existing) {
      throw new Error(
        `Provider session gemini:${request.providerSessionId} is already running; attach instead of resume.`,
      );
    }

    const record = findGeminiStoredSessionRecord(request.providerSessionId, request.cwd);
    if (request.preferStoredReplay) {
      if (!record) {
        throw new Error(`Unknown Gemini session ${request.providerSessionId}.`);
      }
      return finalizeStoredReplayResume({
        services: this.services,
        provider: "gemini",
        providerSessionId: request.providerSessionId,
        rehydratedSessionIds: this.rehydratedSessionIds,
        createSession: () =>
          resumeGeminiStoredSession({
            services: this.services,
            record,
            ...(request.cwd ? { cwd: request.cwd } : {}),
            ...(request.attach ? { attach: request.attach } : {}),
          }),
      });
    }

    const response = resumeGeminiLiveSession({
      services: this.services,
      request: {
        providerSessionId: request.providerSessionId,
        ...(request.cwd ? { cwd: request.cwd } : {}),
        ...(request.attach ? { attach: request.attach } : {}),
      },
    });
    this.liveSessions.set(response.liveSession.sessionId, response.liveSession);
    return { session: response.summary };
  }

  sendInput(sessionId: string, request: SessionInputRequest): void {
    const live = this.liveSessions.get(sessionId);
    if (!live) {
      throw new Error("Rehydrated Gemini sessions are currently read-only.");
    }
    void sendInputToGeminiLiveSession({
      services: this.services,
      liveSession: live,
      sessionId,
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
      this.liveSessions.delete(sessionId);
      await closeGeminiLiveSession(live, request);
    }
    this.rehydratedSessionIds.delete(sessionId);
  }

  async destroySession(sessionId: string): Promise<void> {
    const live = this.liveSessions.get(sessionId);
    if (live) {
      this.liveSessions.delete(sessionId);
      await closeGeminiLiveSession(live);
    }
    this.rehydratedSessionIds.delete(sessionId);
  }

  interruptSession(sessionId: string, request: InterruptSessionRequest): SessionSummary {
    const live = this.liveSessions.get(sessionId);
    if (!live) {
      const state = this.services.sessionStore.getSession(sessionId);
      if (!state) {
        throw new Error(`Unknown session ${sessionId}`);
      }
      return toSessionSummary(state);
    }
    return interruptGeminiLiveSession({
      services: this.services,
      liveSession: live,
      request,
    });
  }

  onPtyInput(): void {
    throw new Error("Gemini sessions do not support PTY input bridging.");
  }

  onPtyResize(): void {
    // Gemini sessions do not use PTY-backed rendering.
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
    const record = findGeminiStoredSessionRecord(
      state.session.providerSessionId,
      state.session.cwd,
    );
    if (!record) {
      return { sessionId, events: [] };
    }
    return getGeminiStoredSessionHistoryPage({
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
    const record =
      this.storedSessionIndex.get(state.session.providerSessionId) ??
      findGeminiStoredSessionRecord(
        state.session.providerSessionId,
        state.session.cwd,
      );
    if (!record) {
      return undefined;
    }
    return createGeminiStoredSessionFrozenHistoryPageLoader({
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
    return resolveGeminiStoredSessionWatchRoots();
  }

  async removeStoredSession(session: StoredSessionRef): Promise<void> {
    const record =
      this.storedSessionIndex.get(session.providerSessionId) ??
      this.refreshStoredSessionIndex().get(session.providerSessionId);
    if (!record) {
      throw new Error(`Could not find a stored Gemini history file for ${session.providerSessionId}.`);
    }
    await movePathToTrash(record.filePath);
    this.storedSessionIndex.delete(session.providerSessionId);
  }

  getProviderDiagnostic(options?: { forceRefresh?: boolean }) {
    return probeProviderDiagnostic("gemini", geminiLaunchSpec(), options);
  }

  private refreshStoredSessionIndex(): Map<string, GeminiStoredSessionRecord> {
    this.storedSessionIndex = new Map(
      discoverGeminiStoredSessions().map((record) => [record.ref.providerSessionId, record] as const),
    );
    return this.storedSessionIndex;
  }
}

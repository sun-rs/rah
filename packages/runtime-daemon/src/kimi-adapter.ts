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
  applyWorkspaceGitFileAction,
  applyWorkspaceGitHunkAction,
  getWorkspaceGitDiff,
  getWorkspaceGitStatus,
  getWorkspaceSnapshot,
  readWorkspaceFileFromDirectory,
} from "./workspace-utils";
import {
  closeKimiLiveSession,
  interruptKimiLiveSession,
  respondToKimiLivePermission,
  resumeKimiLiveSession,
  sendInputToKimiLiveSession,
  startKimiLiveSession,
  type LiveKimiSession,
} from "./kimi-live-client";
import {
  createKimiStoredSessionFrozenHistoryPageLoader,
  discoverKimiStoredSessions,
  getKimiStoredSessionHistoryPage,
  resolveKimiStoredSessionWatchRoots,
  resumeKimiStoredSession,
  type KimiStoredSessionRecord,
} from "./kimi-session-files";
import {
  finalizeStoredReplayResume,
  prepareProviderSessionResume,
} from "./provider-resume";
import { kimiLaunchSpec, probeProviderDiagnostic } from "./provider-diagnostics";
import { toSessionSummary } from "./session-store";
import { movePathToTrash } from "./trash";
import path from "node:path";

export class KimiAdapter implements ProviderAdapter {
  readonly id = "kimi";
  readonly providers: Array<"kimi"> = ["kimi"];

  private readonly services: RuntimeServices;
  private readonly liveSessions = new Map<string, LiveKimiSession>();
  private readonly rehydratedSessionIds = new Set<string>();
  private storedSessionIndex = new Map<string, KimiStoredSessionRecord>();

  constructor(services: RuntimeServices) {
    this.services = services;
  }

  async startSession(request: StartSessionRequest): Promise<StartSessionResponse> {
    const response = await startKimiLiveSession({
      services: this.services,
      request,
    });
    this.liveSessions.set(response.liveSession.sessionId, response.liveSession);
    return { session: response.summary };
  }

  async resumeSession(request: ResumeSessionRequest): Promise<ResumeSessionResponse> {
    prepareProviderSessionResume({
      services: this.services,
      provider: "kimi",
      providerSessionId: request.providerSessionId,
      preferStoredReplay: request.preferStoredReplay,
      rehydratedSessionIds: this.rehydratedSessionIds,
    });
    const existing = this.services.sessionStore.findManagedByProviderSession(
      "kimi",
      request.providerSessionId,
    );
    if (existing) {
      throw new Error(
        `Provider session kimi:${request.providerSessionId} is already running; attach instead of resume.`,
      );
    }

    const record =
      this.refreshStoredSessionIndex().get(request.providerSessionId) ??
      this.storedSessionIndex.get(request.providerSessionId);
    if (request.preferStoredReplay) {
      if (!record) {
        throw new Error(`Unknown Kimi session ${request.providerSessionId}.`);
      }
      return finalizeStoredReplayResume({
        services: this.services,
        provider: "kimi",
        providerSessionId: request.providerSessionId,
        rehydratedSessionIds: this.rehydratedSessionIds,
        createSession: () =>
          resumeKimiStoredSession({
            services: this.services,
            record,
            ...(request.attach ? { attach: request.attach } : {}),
          }),
      });
    }

    const cwd = request.cwd ?? record?.ref.cwd ?? process.cwd();
    const response = await resumeKimiLiveSession({
      services: this.services,
      providerSessionId: request.providerSessionId,
      cwd,
      ...(request.attach ? { attach: request.attach } : {}),
    });
    this.liveSessions.set(response.liveSession.sessionId, response.liveSession);
    return { session: response.summary };
  }

  sendInput(sessionId: string, request: SessionInputRequest): void {
    const live = this.liveSessions.get(sessionId);
    if (!live) {
      throw new Error("Rehydrated Kimi sessions are currently read-only.");
    }
    void sendInputToKimiLiveSession({
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
    if (!this.services.sessionStore.hasAttachedClient(sessionId, request.clientId)) {
      throw new Error(`Client ${request.clientId} is not attached to ${sessionId}.`);
    }
    const live = this.liveSessions.get(sessionId);
    if (live) {
      this.liveSessions.delete(sessionId);
      await closeKimiLiveSession(live, request);
    }
    this.rehydratedSessionIds.delete(sessionId);
  }

  async destroySession(sessionId: string): Promise<void> {
    const live = this.liveSessions.get(sessionId);
    if (live) {
      this.liveSessions.delete(sessionId);
      await closeKimiLiveSession(live);
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
    return interruptKimiLiveSession({
      services: this.services,
      liveSession: live,
      request,
    });
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
    await respondToKimiLivePermission({
      liveSession: live,
      requestId,
      response,
    });
  }

  onPtyInput(): void {
    throw new Error("Kimi sessions do not support PTY input bridging.");
  }

  onPtyResize(): void {
    // Kimi sessions do not use PTY-backed rendering.
  }

  getWorkspaceSnapshot(sessionId: string, options?: { scopeRoot?: string }): WorkspaceSnapshotResponse {
    const state = this.services.sessionStore.getSession(sessionId);
    if (!state) {
      throw new Error(`Unknown session ${sessionId}`);
    }
    const snapshot = getWorkspaceSnapshot(options?.scopeRoot ?? state.session.cwd);
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
    const status = getWorkspaceGitStatus(state.session.cwd, options);
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
      diff: getWorkspaceGitDiff(state.session.cwd, targetPath, options),
    };
  }

  applyGitFileAction(sessionId: string, request: GitFileActionRequest): GitFileActionResponse {
    const state = this.services.sessionStore.getSession(sessionId);
    if (!state) {
      throw new Error(`Unknown session ${sessionId}`);
    }
    return {
      ...applyWorkspaceGitFileAction(state.session.cwd, request, {
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
      ...applyWorkspaceGitHunkAction(state.session.cwd, request, {
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
      ...readWorkspaceFileFromDirectory(state.session.cwd, targetPath, options),
      sessionId,
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
    const record =
      this.refreshStoredSessionIndex().get(state.session.providerSessionId) ??
      this.storedSessionIndex.get(state.session.providerSessionId);
    if (!record) {
      return { sessionId, events: [] };
    }
    return getKimiStoredSessionHistoryPage({
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
      this.refreshStoredSessionIndex().get(state.session.providerSessionId) ??
      this.storedSessionIndex.get(state.session.providerSessionId);
    if (!record) {
      return undefined;
    }
    return createKimiStoredSessionFrozenHistoryPageLoader({
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
    return resolveKimiStoredSessionWatchRoots();
  }

  async removeStoredSession(session: StoredSessionRef): Promise<void> {
    const record =
      this.storedSessionIndex.get(session.providerSessionId) ??
      this.refreshStoredSessionIndex().get(session.providerSessionId);
    if (!record) {
      throw new Error(`Could not find a stored Kimi history directory for ${session.providerSessionId}.`);
    }
    await movePathToTrash(path.dirname(record.wirePath));
    this.storedSessionIndex.delete(session.providerSessionId);
  }

  getProviderDiagnostic(options?: { forceRefresh?: boolean }) {
    return probeProviderDiagnostic("kimi", kimiLaunchSpec(), options);
  }

  private refreshStoredSessionIndex() {
    this.storedSessionIndex = new Map(
      discoverKimiStoredSessions().map((record) => [record.ref.providerSessionId, record] as const),
    );
    return this.storedSessionIndex;
  }
}

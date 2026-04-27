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
  ProviderModelCatalog,
  ResumeSessionRequest,
  ResumeSessionResponse,
  SetSessionModelRequest,
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
  closeOpenCodeLiveSession,
  interruptOpenCodeLiveSession,
  respondToOpenCodeLivePermission,
  resumeOpenCodeLiveSession,
  sendInputToOpenCodeLiveSession,
  setOpenCodeLiveSessionMode,
  startOpenCodeLiveSession,
  type LiveOpenCodeSession,
} from "./opencode-live-client";
import {
  archiveOpenCodeStoredSession,
  discoverOpenCodeStoredSessions,
  findOpenCodeStoredSessionRecord,
  getOpenCodeStoredSessionHistoryPage,
  resolveOpenCodeStoredSessionWatchRoots,
  resumeOpenCodeStoredSession,
  type OpenCodeStoredSessionRecord,
} from "./opencode-stored-sessions";
import { opencodeLaunchSpec, probeProviderDiagnostic } from "./provider-diagnostics";
import {
  buildOpenCodeFallbackModelCatalog,
  buildOpenCodeProviderModelId,
  OpenCodeModelCatalogCache,
  resolveOpenCodeRuntimeCapabilityState,
} from "./opencode-model-catalog";
import {
  finalizeStoredReplayResume,
  prepareProviderSessionResume,
} from "./provider-resume";
import { toSessionSummary } from "./session-store";
import {
  applyWorkspaceGitFileActionAsync,
  applyWorkspaceGitHunkActionAsync,
  getWorkspaceGitDiffAsync,
  getWorkspaceGitStatusAsync,
  getWorkspaceSnapshot,
  readWorkspaceFileFromDirectoryAsync,
} from "./workspace-utils";

export class OpenCodeAdapter implements ProviderAdapter {
  readonly id = "opencode";
  readonly providers: Array<"opencode"> = ["opencode"];

  private readonly services: RuntimeServices;
  private readonly liveSessions = new Map<string, LiveOpenCodeSession>();
  private readonly rehydratedSessionIds = new Set<string>();
  private readonly rehydratedSessionRecords = new Map<string, OpenCodeStoredSessionRecord>();
  private readonly modelCatalog = new OpenCodeModelCatalogCache();
  private storedSessionIndex = new Map<string, OpenCodeStoredSessionRecord>();

  constructor(services: RuntimeServices) {
    this.services = services;
  }

  async startSession(request: StartSessionRequest): Promise<StartSessionResponse> {
    const modelCatalog = this.modelCatalog.getCached() ?? buildOpenCodeFallbackModelCatalog();
    void this.modelCatalog.listModels({ cwd: request.cwd }).catch(() => undefined);
    const response = await startOpenCodeLiveSession({
      services: this.services,
      request,
      modelCatalog,
    });
    this.liveSessions.set(response.liveSession.sessionId, response.liveSession);
    return { session: response.summary };
  }

  async resumeSession(request: ResumeSessionRequest): Promise<ResumeSessionResponse> {
    const preparedResume = prepareProviderSessionResume({
      services: this.services,
      provider: "opencode",
      providerSessionId: request.providerSessionId,
      preferStoredReplay: request.preferStoredReplay,
      rehydratedSessionIds: this.rehydratedSessionIds,
    });
    const existing = this.services.sessionStore.findManagedByProviderSession(
      "opencode",
      request.providerSessionId,
    );
    if (existing) {
      throw new Error(
        `Provider session opencode:${request.providerSessionId} is already running; attach instead of resume.`,
      );
    }
    const record =
      this.storedSessionIndex.get(request.providerSessionId) ??
      this.refreshStoredSessionIndex().get(request.providerSessionId) ??
      findOpenCodeStoredSessionRecord(request.providerSessionId);
    if (request.preferStoredReplay) {
      if (!record) {
        throw new Error(`Unknown OpenCode session ${request.providerSessionId}.`);
      }
      return finalizeStoredReplayResume({
        services: this.services,
        provider: "opencode",
        providerSessionId: request.providerSessionId,
        rehydratedSessionIds: this.rehydratedSessionIds,
        createSession: () => {
          const resumed = resumeOpenCodeStoredSession(
            request.attach !== undefined
              ? { services: this.services, record, attach: request.attach }
              : { services: this.services, record },
          );
          this.rehydratedSessionRecords.set(resumed.sessionId, record);
          return resumed;
        },
      });
    }
    try {
      const cachedModelCatalog = this.modelCatalog.getCached();
      void this.modelCatalog
        .listModels({ cwd: request.cwd ?? record?.ref.cwd ?? process.cwd() })
        .catch(() => undefined);
      const response = await resumeOpenCodeLiveSession({
        services: this.services,
        providerSessionId: request.providerSessionId,
        cwd: request.cwd ?? record?.ref.cwd ?? process.cwd(),
        ...(request.attach ? { attach: request.attach } : {}),
        ...(cachedModelCatalog ? { modelCatalog: cachedModelCatalog } : {}),
      });
      this.liveSessions.set(response.liveSession.sessionId, response.liveSession);
      return { session: response.summary };
    } catch (error) {
      preparedResume.rollback();
      throw error;
    }
  }

  async listModels(options?: { cwd?: string; forceRefresh?: boolean }): Promise<ProviderModelCatalog> {
    return await this.modelCatalog.listModels(options);
  }

  async setSessionModel(
    sessionId: string,
    request: SetSessionModelRequest,
  ): Promise<SessionSummary> {
    const live = this.liveSessions.get(sessionId);
    if (!live) {
      throw new Error("OpenCode model switching is only available for live sessions.");
    }
    const catalog = await this.modelCatalog.listModels({ cwd: live.cwd });
    const model = catalog.models.find((entry) => entry.id === request.modelId);
    if (!model) {
      throw new Error(`Unsupported OpenCode model '${request.modelId}'.`);
    }
    const reasoningId =
      request.reasoningId !== undefined
        ? request.reasoningId
        : model.defaultReasoningId ?? null;
    if (
      reasoningId !== null &&
      reasoningId !== undefined &&
      !(model.reasoningOptions ?? []).some((option) => option.id === reasoningId)
    ) {
      throw new Error(
        `Unsupported OpenCode reasoning variant '${reasoningId}' for model '${request.modelId}'.`,
      );
    }
    await live.acp.setSessionModel(
      live.providerSessionId,
      buildOpenCodeProviderModelId({
        modelId: request.modelId,
        reasoningId,
      }),
    );
    live.model = request.modelId;
    live.reasoningId = reasoningId;
    const runtimeCapabilityState = resolveOpenCodeRuntimeCapabilityState({
      catalog,
      modelId: request.modelId,
      reasoningId,
    });
    const nextState = this.services.sessionStore.patchManagedSession(sessionId, {
      model: {
        currentModelId: request.modelId,
        currentReasoningId: reasoningId,
        availableModels: catalog.models,
        mutable: true,
        source: catalog.source,
      },
      ...runtimeCapabilityState,
    });
    return toSessionSummary(nextState);
  }

  async setSessionMode(sessionId: string, modeId: string): Promise<SessionSummary> {
    const live = this.liveSessions.get(sessionId);
    if (!live) {
      throw new Error("OpenCode mode switching is only available for live sessions.");
    }
    return await setOpenCodeLiveSessionMode({
      services: this.services,
      liveSession: live,
      modeId,
    });
  }

  sendInput(sessionId: string, request: SessionInputRequest): void {
    const live = this.liveSessions.get(sessionId);
    if (!live) {
      throw new Error("OpenCode session is not live.");
    }
    void sendInputToOpenCodeLiveSession({
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
      await closeOpenCodeLiveSession(live, request);
    }
    this.rehydratedSessionIds.delete(sessionId);
    this.rehydratedSessionRecords.delete(sessionId);
  }

  async destroySession(sessionId: string): Promise<void> {
    const live = this.liveSessions.get(sessionId);
    if (live) {
      this.liveSessions.delete(sessionId);
      await closeOpenCodeLiveSession(live);
    }
    this.rehydratedSessionIds.delete(sessionId);
    this.rehydratedSessionRecords.delete(sessionId);
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
    return interruptOpenCodeLiveSession({
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
    await respondToOpenCodeLivePermission({ liveSession: live, requestId, response });
  }

  onPtyInput(): void {
    throw new Error("OpenCode sessions do not support PTY input bridging.");
  }

  onPtyResize(): void {
    // OpenCode live sessions are structured API sessions, not PTY-backed sessions.
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

  async getGitStatus(sessionId: string, options?: { scopeRoot?: string }): Promise<GitStatusResponse> {
    const state = this.services.sessionStore.getSession(sessionId);
    if (!state) {
      throw new Error(`Unknown session ${sessionId}`);
    }
    const status = await getWorkspaceGitStatusAsync(state.session.cwd, options);
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

  async getGitDiff(
    sessionId: string,
    path: string,
    options?: { staged?: boolean; ignoreWhitespace?: boolean; scopeRoot?: string },
  ): Promise<GitDiffResponse> {
    const state = this.services.sessionStore.getSession(sessionId);
    if (!state) {
      throw new Error(`Unknown session ${sessionId}`);
    }
    return {
      sessionId,
      path,
      diff: await getWorkspaceGitDiffAsync(state.session.cwd, path, options),
    };
  }

  async applyGitFileAction(
    sessionId: string,
    request: GitFileActionRequest,
  ): Promise<GitFileActionResponse> {
    const state = this.services.sessionStore.getSession(sessionId);
    if (!state) {
      throw new Error(`Unknown session ${sessionId}`);
    }
    return {
      ...(await applyWorkspaceGitFileActionAsync(state.session.cwd, request, {
        scopeRoot: state.session.rootDir ?? state.session.cwd,
      })),
      sessionId,
    };
  }

  async applyGitHunkAction(
    sessionId: string,
    request: GitHunkActionRequest,
  ): Promise<GitHunkActionResponse> {
    const state = this.services.sessionStore.getSession(sessionId);
    if (!state) {
      throw new Error(`Unknown session ${sessionId}`);
    }
    return {
      ...(await applyWorkspaceGitHunkActionAsync(state.session.cwd, request, {
        scopeRoot: state.session.rootDir ?? state.session.cwd,
      })),
      sessionId,
    };
  }

  async readSessionFile(
    sessionId: string,
    path: string,
    options?: { scopeRoot?: string },
  ): Promise<SessionFileResponse> {
    const state = this.services.sessionStore.getSession(sessionId);
    if (!state) {
      throw new Error(`Unknown session ${sessionId}`);
    }
    return {
      ...(await readWorkspaceFileFromDirectoryAsync(state.session.cwd, path, options)),
      sessionId,
    };
  }

  getContextUsage(sessionId: string): ContextUsage | undefined {
    return this.services.sessionStore.getSession(sessionId)?.usage;
  }

  getSessionHistoryPage(
    sessionId: string,
    options?: { beforeTs?: string; cursor?: string; limit?: number },
  ): SessionHistoryPageResponse {
    void options?.cursor;
    const state = this.services.sessionStore.getSession(sessionId);
    const providerSessionId =
      state?.session.providerSessionId ??
      this.rehydratedSessionRecords.get(sessionId)?.ref.providerSessionId;
    if (!providerSessionId) {
      return { sessionId, events: [] };
    }
    const record =
      this.rehydratedSessionRecords.get(sessionId) ??
      this.storedSessionIndex.get(providerSessionId) ??
      this.refreshStoredSessionIndex().get(providerSessionId) ??
      findOpenCodeStoredSessionRecord(providerSessionId);
    if (!record) {
      return { sessionId, events: [] };
    }
    return getOpenCodeStoredSessionHistoryPage({
      sessionId,
      record,
      ...(options?.beforeTs ? { beforeTs: options.beforeTs } : {}),
      ...(options?.limit ? { limit: options.limit } : {}),
    });
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
    return resolveOpenCodeStoredSessionWatchRoots();
  }

  removeStoredSession(session: StoredSessionRef): void {
    const record =
      this.storedSessionIndex.get(session.providerSessionId) ??
      this.refreshStoredSessionIndex().get(session.providerSessionId) ??
      findOpenCodeStoredSessionRecord(session.providerSessionId);
    if (!record) {
      throw new Error(`Could not find a stored OpenCode session for ${session.providerSessionId}.`);
    }
    archiveOpenCodeStoredSession(record);
    this.storedSessionIndex.delete(session.providerSessionId);
  }

  async getProviderDiagnostic(options?: { forceRefresh?: boolean }) {
    return await probeProviderDiagnostic("opencode", await opencodeLaunchSpec(), options);
  }

  private refreshStoredSessionIndex(): Map<string, OpenCodeStoredSessionRecord> {
    this.storedSessionIndex = new Map(
      discoverOpenCodeStoredSessions().map((record) => [record.ref.providerSessionId, record]),
    );
    return this.storedSessionIndex;
  }

  async shutdown(): Promise<void> {
    await Promise.all(
      [...this.liveSessions.values()].map((session) => closeOpenCodeLiveSession(session)),
    );
    this.liveSessions.clear();
  }
}

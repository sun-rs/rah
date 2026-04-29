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
  updateClaudeSessionTitle,
  waitForClaudeStoredSessionRecord,
} from "./claude-session-files";
import {
  finalizeStoredReplayResume,
  prepareProviderSessionResume,
} from "./provider-resume";
import { claudeLaunchSpec, probeProviderDiagnostic } from "./provider-diagnostics";
import {
  ClaudeModelCatalogCache,
  resolveClaudeEffortValue,
  resolveClaudeRuntimeCapabilityState,
  resolveClaudeRuntimeModelId,
} from "./claude-model-catalog";
import {
  applyWorkspaceGitFileActionAsync,
  applyWorkspaceGitHunkActionAsync,
  getWorkspaceGitDiffAsync,
  getWorkspaceGitStatusAsync,
  getWorkspaceSnapshot,
  readWorkspaceFileFromDirectoryAsync,
} from "./workspace-utils";
import { toSessionSummary } from "./session-store";
import { buildClaudeModeState, isClaudeModeId } from "./session-mode-utils";
import { approvalPolicyToPermissionMode } from "./claude-live-helpers";
import { movePathToTrash } from "./trash";

const CLAUDE_EVENT_SOURCE = {
  provider: "claude" as const,
  channel: "structured_live" as const,
  authority: "derived" as const,
};

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
  private readonly modelCatalog = new ClaudeModelCatalogCache();

  constructor(services: RuntimeServices, options: ClaudeAdapterOptions = {}) {
    this.services = services;
    this.queryFactory = options.queryFactory;
  }

  private reportAsyncLiveError(sessionId: string, detail: string): void {
    this.services.eventBus.publish({
      sessionId,
      type: "runtime.status",
      source: CLAUDE_EVENT_SOURCE,
      payload: {
        status: "error",
        detail,
      },
    });
    this.services.sessionStore.setRuntimeState(sessionId, "failed");
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
    const preparedResume = prepareProviderSessionResume({
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

    try {
      const response = await resumeClaudeLiveSession({
        services: this.services,
        providerSessionId: request.providerSessionId,
        cwd: request.cwd ?? record?.ref.cwd ?? process.cwd(),
        ...(request.model ? { model: request.model } : {}),
        ...(request.reasoningId !== undefined ? { reasoningId: request.reasoningId } : {}),
        ...(request.modeId ? { modeId: request.modeId } : {}),
        permissionMode:
          request.approvalPolicy !== undefined
            ? approvalPolicyToPermissionMode(request.approvalPolicy)
            : this.permissionModeByProviderSessionId.get(request.providerSessionId) ??
              "bypassPermissions",
        ...(request.attach ? { attach: request.attach } : {}),
        ...(this.queryFactory ? { queryFactory: this.queryFactory } : {}),
      });
      this.liveSessions.set(response.liveSession.sessionId, response.liveSession);
      return { session: response.summary };
    } catch (error) {
      preparedResume.rollback();
      throw error;
    }
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
    }).catch((error) => {
      this.reportAsyncLiveError(
        sessionId,
        error instanceof Error ? error.message : String(error),
      );
    });
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
      throw new Error("Claude model switching is only available for live sessions.");
    }
    const nextModelId = request.modelId.trim();
    if (!nextModelId) {
      throw new Error("Session model is required.");
    }
    const catalog = await this.modelCatalog.listModels({ cwd: live.cwd });
    const model = catalog.models.find((entry) => entry.id === nextModelId);
    if (!model) {
      throw new Error(`Unsupported Claude model '${nextModelId}'.`);
    }
    const effortOptions = model.reasoningOptions ?? [];
    const requestedEffort =
      request.reasoningId === null
        ? undefined
        : resolveClaudeEffortValue(request.reasoningId ?? model.defaultReasoningId);
    if (
      requestedEffort !== undefined &&
      effortOptions.length > 0 &&
      !effortOptions.some((option) => option.id === String(requestedEffort))
    ) {
      throw new Error(`Unsupported Claude effort option '${requestedEffort}'.`);
    }

    const runtimeModelId = resolveClaudeRuntimeModelId(model);
    if (runtimeModelId) {
      live.model = runtimeModelId;
    } else {
      delete live.model;
    }
    if (requestedEffort !== undefined && effortOptions.length > 0) {
      live.effort = requestedEffort as LiveClaudeSession["effort"];
    } else {
      delete live.effort;
    }
    if (live.activeTurn?.query?.setModel) {
      await live.activeTurn.query.setModel(runtimeModelId);
    }

    const runtimeCapabilityState = resolveClaudeRuntimeCapabilityState({
      catalog,
      modelId: nextModelId,
      effort: live.effort,
    });
    const nextState = this.services.sessionStore.patchManagedSession(sessionId, {
      model: {
        currentModelId: nextModelId,
        currentReasoningId: live.effort ?? null,
        availableModels: catalog.models,
        mutable: true,
        source: catalog.source,
      },
      ...(runtimeCapabilityState.modelProfile
        ? { modelProfile: runtimeCapabilityState.modelProfile }
        : {}),
      config: runtimeCapabilityState.config ?? {
        values: {},
        source: "runtime_session",
      },
    });
    return toSessionSummary(nextState);
  }

  renameSession(sessionId: string, title: string): SessionSummary {
    const state = this.services.sessionStore.getSession(sessionId);
    if (!state?.session.providerSessionId) {
      throw new Error(`Session ${sessionId} does not have a provider session id.`);
    }
    updateClaudeSessionTitle(state.session.providerSessionId, title, state.session.cwd);
    const nextState = this.services.sessionStore.patchManagedSession(sessionId, { title });
    return toSessionSummary(nextState);
  }

  async setSessionMode(sessionId: string, modeId: string): Promise<SessionSummary> {
    if (!isClaudeModeId(modeId)) {
      throw new Error(`Unsupported Claude mode '${modeId}'.`);
    }
    const live = this.liveSessions.get(sessionId);
    if (!live) {
      throw new Error("Claude mode switching is only available for live sessions.");
    }
    const nextMode = modeId as LiveClaudeSession["permissionMode"];
    live.permissionMode = nextMode;
    if (live.activeTurn?.query?.setPermissionMode) {
      await live.activeTurn.query.setPermissionMode(nextMode);
    }
    if (live.providerSessionId) {
      this.permissionModeByProviderSessionId.set(live.providerSessionId, live.permissionMode);
    }
    const nextState = this.services.sessionStore.patchManagedSession(sessionId, {
      mode: buildClaudeModeState({
        currentModeId: live.permissionMode,
        mutable: true,
      }),
    });
    return toSessionSummary(nextState);
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
    targetPath: string,
    options?: { staged?: boolean; ignoreWhitespace?: boolean; scopeRoot?: string },
  ): Promise<GitDiffResponse> {
    const state = this.services.sessionStore.getSession(sessionId);
    if (!state) {
      throw new Error(`Unknown session ${sessionId}`);
    }
    return {
      sessionId,
      path: targetPath,
      diff: await getWorkspaceGitDiffAsync(state.session.cwd, targetPath, options),
    };
  }

  async applyGitFileAction(sessionId: string, request: GitFileActionRequest): Promise<GitFileActionResponse> {
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

  async applyGitHunkAction(sessionId: string, request: GitHunkActionRequest): Promise<GitHunkActionResponse> {
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
    targetPath: string,
    options?: { scopeRoot?: string },
  ): Promise<SessionFileResponse> {
    const state = this.services.sessionStore.getSession(sessionId);
    if (!state) {
      throw new Error(`Unknown session ${sessionId}`);
    }
    return {
      ...(await readWorkspaceFileFromDirectoryAsync(state.session.cwd, targetPath, options)),
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

  async getProviderDiagnostic(options?: { forceRefresh?: boolean }) {
    return probeProviderDiagnostic("claude", await claudeLaunchSpec(), options);
  }

  private refreshStoredSessionIndex(): Map<string, ClaudeStoredSessionRecord> {
    this.storedSessionIndex = new Map(
      discoverClaudeStoredSessions().map((record) => [record.ref.providerSessionId, record] as const),
    );
    return this.storedSessionIndex;
  }
}

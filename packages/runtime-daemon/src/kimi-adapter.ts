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
  applyWorkspaceGitFileActionAsync,
  applyWorkspaceGitHunkActionAsync,
  getWorkspaceGitDiffAsync,
  getWorkspaceGitStatusAsync,
  getWorkspaceSnapshot,
  readWorkspaceFileFromDirectoryAsync,
} from "./workspace-utils";
import {
  closeKimiLiveSession,
  interruptKimiLiveSession,
  respondToKimiLivePermission,
  restartKimiLiveClient,
  resumeKimiLiveSession,
  sendInputToKimiLiveSession,
  startKimiLiveSession,
  type LiveKimiSession,
} from "./kimi-live-client";
import {
  createKimiStoredSessionFrozenHistoryPageLoader,
  countKimiHistoryTurns,
  discoverKimiStoredSessions,
  getKimiStoredSessionHistoryPage,
  resolveKimiStoredSessionWatchRoots,
  resumeKimiStoredSession,
  updateKimiSessionTitle,
  type KimiStoredSessionRecord,
} from "./kimi-session-files";
import {
  finalizeStoredReplayResume,
  prepareProviderSessionResume,
} from "./provider-resume";
import { kimiLaunchSpec, probeProviderDiagnostic } from "./provider-diagnostics";
import {
  buildKimiFallbackModelCatalog,
  KimiModelCatalogCache,
} from "./kimi-model-catalog";
import { buildKimiModeState, isKimiModeId } from "./session-mode-utils";
import { toSessionSummary } from "./session-store";
import { movePathToTrash } from "./trash";
import path from "node:path";

const KIMI_EVENT_SOURCE = {
  provider: "kimi" as const,
  channel: "structured_live" as const,
  authority: "derived" as const,
};

function isKimiGeneratedSessionRejected(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /^Unknown session [0-9a-f-]{36}$/i.test(message.trim());
}

export class KimiAdapter implements ProviderAdapter {
  readonly id = "kimi";
  readonly providers: Array<"kimi"> = ["kimi"];

  private readonly services: RuntimeServices;
  private readonly liveSessions = new Map<string, LiveKimiSession>();
  private readonly rehydratedSessionIds = new Set<string>();
  private readonly modelCatalog = new KimiModelCatalogCache();
  private storedSessionIndex = new Map<string, KimiStoredSessionRecord>();

  constructor(services: RuntimeServices) {
    this.services = services;
  }

  private reportAsyncLiveError(sessionId: string, detail: string): void {
    this.services.eventBus.publish({
      sessionId,
      type: "runtime.status",
      source: KIMI_EVENT_SOURCE,
      payload: {
        status: "error",
        detail,
      },
    });
    if (this.services.sessionStore.getSession(sessionId)) {
      this.services.sessionStore.setRuntimeState(sessionId, "failed");
    }
  }

  async startSession(request: StartSessionRequest): Promise<StartSessionResponse> {
    const modelCatalog =
      request.model || request.reasoningId !== undefined || request.optionValues !== undefined
        ? await this.modelCatalog.listModels({ cwd: request.cwd })
        : this.modelCatalog.getCached() ?? buildKimiFallbackModelCatalog();
    void this.modelCatalog.listModels({ cwd: request.cwd }).catch(() => undefined);
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const response = await startKimiLiveSession({
          services: this.services,
          request,
          modelCatalog,
        });
        this.liveSessions.set(response.liveSession.sessionId, response.liveSession);
        return { session: response.summary };
      } catch (error) {
        lastError = error;
        if (!isKimiGeneratedSessionRejected(error)) {
          throw error;
        }
      }
    }
    throw lastError;
  }

  async resumeSession(request: ResumeSessionRequest): Promise<ResumeSessionResponse> {
    const preparedResume = prepareProviderSessionResume({
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
    try {
      const cachedModelCatalog =
        request.model || request.reasoningId !== undefined || request.optionValues !== undefined
          ? await this.modelCatalog.listModels({ cwd })
          : this.modelCatalog.getCached();
      void this.modelCatalog.listModels({ cwd }).catch(() => undefined);
      const response = await resumeKimiLiveSession({
        services: this.services,
        providerSessionId: request.providerSessionId,
        cwd,
        ...(request.model ? { model: request.model } : {}),
        ...(request.optionValues !== undefined ? { optionValues: request.optionValues } : {}),
        ...(request.reasoningId !== undefined ? { reasoningId: request.reasoningId } : {}),
        ...(request.attach ? { attach: request.attach } : {}),
        ...(request.modeId ? { modeId: request.modeId } : {}),
        ...(request.approvalPolicy ? { approvalPolicy: request.approvalPolicy } : {}),
        ...(cachedModelCatalog ? { modelCatalog: cachedModelCatalog } : {}),
        ...(record ? { initialTurnIndex: countKimiHistoryTurns(record.wirePath) } : {}),
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

  sendInput(sessionId: string, request: SessionInputRequest): void {
    const live = this.liveSessions.get(sessionId);
    if (!live) {
      throw new Error("Rehydrated Kimi sessions are currently read-only.");
    }
    void sendInputToKimiLiveSession({
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

  renameSession(sessionId: string, title: string): SessionSummary {
    const state = this.services.sessionStore.getSession(sessionId);
    if (!state?.session.providerSessionId) {
      throw new Error(`Session ${sessionId} does not have a provider session id.`);
    }
    updateKimiSessionTitle(state.session.providerSessionId, title, state.session.cwd);
    const nextState = this.services.sessionStore.patchManagedSession(sessionId, { title });
    const record = this.storedSessionIndex.get(state.session.providerSessionId);
    if (record) {
      record.ref = {
        ...record.ref,
        title,
      };
    }
    return toSessionSummary(nextState);
  }

  async setSessionMode(sessionId: string, modeId: string): Promise<SessionSummary> {
    if (!isKimiModeId(modeId)) {
      throw new Error(`Unsupported Kimi mode '${modeId}'.`);
    }
    const live = this.liveSessions.get(sessionId);
    if (!live) {
      throw new Error("Kimi mode switching is only available for live sessions.");
    }
    if (live.activeTurn) {
      throw new Error("Kimi mode switching is only available while the session is idle.");
    }
    const enablePlan = modeId === "plan";
    const nextYolo = modeId === "yolo";
    if (live.nativeYolo !== nextYolo) {
      await restartKimiLiveClient({
        services: this.services,
        liveSession: live,
        yolo: nextYolo,
      });
    }
    await live.client.request("set_plan_mode", { enabled: enablePlan });
    live.planMode = enablePlan;
    live.approvalMode = nextYolo ? "yolo" : "default";
    const nextState = this.services.sessionStore.patchManagedSession(sessionId, {
      mode: buildKimiModeState({
        currentModeId: modeId,
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

  async getProviderDiagnostic(options?: { forceRefresh?: boolean }) {
    return probeProviderDiagnostic("kimi", await kimiLaunchSpec(), options);
  }

  async shutdown(): Promise<void> {
    const sessions = [...this.liveSessions.values()];
    this.liveSessions.clear();
    const results = await Promise.allSettled(
      sessions.map((live) => closeKimiLiveSession(live)),
    );
    results.forEach((result, index) => {
      if (result.status === "rejected") {
        console.error("[rah] failed to close Kimi live session during shutdown", {
          sessionId: sessions[index]?.sessionId,
          error: result.reason,
        });
      }
    });
  }

  private refreshStoredSessionIndex() {
    this.storedSessionIndex = new Map(
      discoverKimiStoredSessions().map((record) => [record.ref.providerSessionId, record] as const),
    );
    return this.storedSessionIndex;
  }
}

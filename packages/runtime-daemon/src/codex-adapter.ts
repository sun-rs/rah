import { statSync } from "node:fs";
import type {
  CloseSessionRequest,
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
  ContextUsage,
} from "@rah/runtime-protocol";
import type { ProviderAdapter, RuntimeServices } from "./provider-adapter";
import {
  createCodexAppServerClient,
  loadCodexPlanCollaborationMode,
  respondToCodexLivePermission,
  resumeCodexLiveSession,
  startCodexLiveSession,
  type LiveCodexSession,
} from "./codex-live-client";
import {
  CodexModelCatalogCache,
  resolveCodexRuntimeCapabilityState,
} from "./codex-model-catalog";
import { canFinalizeCodexStoredHistory } from "./codex-history-liveness";
import {
  createCodexStoredSessionFrozenHistoryPageLoader,
  discoverCodexStoredSessions,
  getCodexStoredSessionHistoryPage,
  resolveCodexStoredSessionWatchRoots,
  resumeCodexStoredSession,
  type CodexStoredSessionRecord,
} from "./codex-stored-sessions";
import {
  finalizeStoredReplayResume,
  prepareProviderSessionResume,
} from "./provider-resume";
import { codexLaunchSpec, probeProviderDiagnostic } from "./provider-diagnostics";
import { toSessionSummary } from "./session-store";
import {
  loadStoredSessionMetadataCache,
  setCachedStoredSessionRef,
  writeStoredSessionMetadataCache,
} from "./stored-session-metadata-cache";
import { movePathToTrash } from "./trash";
import { buildCodexModeState, parseCodexModeId } from "./session-mode-utils";
import { optionValueAsString, resolveModelOptionValues } from "./session-model-options";
import {
  applyWorkspaceGitFileActionAsync,
  applyWorkspaceGitHunkActionAsync,
  getWorkspaceGitDiffAsync,
  getWorkspaceGitStatusAsync,
  getWorkspaceSnapshot,
  readWorkspaceFileFromDirectoryAsync,
} from "./workspace-utils";

const CODEX_EVENT_SOURCE = {
  provider: "codex" as const,
  channel: "structured_live" as const,
  authority: "derived" as const,
};

type CodexTurnCollaborationMode = {
  mode: "default" | "plan";
  settings: {
    model: string;
    reasoning_effort: string | null;
    developer_instructions: string | null;
  };
};

function codexSandboxPolicyForTurn(args: {
  sandboxMode: string;
  cwd: string;
}) {
  switch (args.sandboxMode) {
    case "read-only":
      return {
        type: "readOnly" as const,
        networkAccess: false,
      };
    case "workspace-write":
      return {
        type: "workspaceWrite" as const,
        writableRoots: [args.cwd],
        networkAccess: false,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      };
    case "danger-full-access":
    default:
      return {
        type: "dangerFullAccess" as const,
      };
  }
}

function codexCollaborationModeForTurn(live: LiveCodexSession): CodexTurnCollaborationMode | null {
  const model = live.modelId ?? live.planCollaborationMode?.settings.model ?? null;
  if (!model) {
    return null;
  }
  if (live.activeModeId !== "plan" || !live.planCollaborationMode) {
    // Codex preserves the previous collaboration mode when this field is omitted.
    // Send default explicitly so toggling Plan off actually exits plan mode.
    return {
      mode: "default",
      settings: {
        model,
        reasoning_effort: live.reasoningId,
        developer_instructions: null,
      },
    };
  }
  return {
    mode: "plan",
    settings: {
      ...live.planCollaborationMode.settings,
      model,
      reasoning_effort:
        live.reasoningId ?? live.planCollaborationMode.settings.reasoning_effort,
    },
  };
}

export class CodexAdapter implements ProviderAdapter {
  readonly id = "codex";
  readonly providers: Array<"codex"> = ["codex"];

  private readonly services: RuntimeServices;
  private readonly liveSessions = new Map<string, LiveCodexSession>();
  private readonly rehydratedSessionIds = new Set<string>();
  private readonly rehydratedSessionRecords = new Map<string, CodexStoredSessionRecord>();
  private storedSessionIndex = new Map<string, CodexStoredSessionRecord>();
  private readonly modelCatalog = new CodexModelCatalogCache();

  constructor(services: RuntimeServices) {
    this.services = services;
  }

  private hasRahManagedCodexWriter(providerSessionId: string): boolean {
    const managed = this.services.sessionStore.findManagedByProviderSession(
      "codex",
      providerSessionId,
    );
    if (!managed || this.rehydratedSessionIds.has(managed.session.id)) {
      return false;
    }
    if (this.liveSessions.has(managed.session.id)) {
      return true;
    }
    if (managed.session.launchSource !== "terminal") {
      return false;
    }
    return (
      managed.session.capabilities.steerInput ||
      managed.session.capabilities.queuedInput ||
      managed.session.capabilities.actions.archive
    );
  }

  private canFinalizeStoredHistory(record: CodexStoredSessionRecord): boolean {
    return canFinalizeCodexStoredHistory({
      rolloutPath: record.rolloutPath,
      hasRahManagedWriter: this.hasRahManagedCodexWriter(record.ref.providerSessionId),
    });
  }

  private reportAsyncLiveError(sessionId: string, detail: string): void {
    this.services.eventBus.publish({
      sessionId,
      type: "runtime.status",
      source: CODEX_EVENT_SOURCE,
      payload: {
        status: "error",
        detail,
      },
    });
    this.services.sessionStore.setRuntimeState(sessionId, "failed");
  }

  private registerLiveSession(liveSession: LiveCodexSession): void {
    liveSession.drainQueuedInput = () => this.drainQueuedInput(liveSession);
    this.liveSessions.set(liveSession.sessionId, liveSession);
  }

  private drainQueuedInput(live: LiveCodexSession): void {
    if (live.currentTurnId || live.turnStartInFlight) {
      return;
    }
    const next = live.queuedInputs.shift();
    if (!next) {
      return;
    }
    this.startLiveTurn(live, next);
  }

  private startLiveTurn(live: LiveCodexSession, request: SessionInputRequest): void {
    if (!this.services.sessionStore.hasInputControl(live.sessionId, request.clientId)) {
      throw new Error(`Client ${request.clientId} does not hold input control for ${live.sessionId}.`);
    }
    const collaborationMode = codexCollaborationModeForTurn(live);
    live.turnStartInFlight = true;
    void live.client.request(
      "turn/start",
      {
        threadId: live.threadId,
        input: [{ type: "text", text: request.text }],
        cwd: live.cwd,
        approvalPolicy: live.approvalPolicy,
        sandboxPolicy: codexSandboxPolicyForTurn({
          sandboxMode: live.sandboxMode,
          cwd: live.cwd,
        }),
        ...(live.modelId ? { model: live.modelId } : {}),
        ...(live.reasoningId ? { effort: live.reasoningId } : {}),
        ...(collaborationMode ? { collaborationMode } : {}),
      },
      90_000,
    ).then((result) => {
      const turn =
        result && typeof result === "object" && !Array.isArray(result)
          ? (result as { turn?: { id?: unknown } }).turn
          : undefined;
      if (
        typeof turn?.id === "string" &&
        !live.currentTurnId &&
        !live.finishedTurnIds.has(turn.id)
      ) {
        live.currentTurnId = turn.id;
      }
      if (typeof turn?.id === "string" && live.interruptWhenTurnStarts) {
        live.interruptWhenTurnStarts = false;
        void live.client.request("turn/interrupt", {
          threadId: live.threadId,
          turnId: turn.id,
        }).catch((error) => {
          this.reportAsyncLiveError(
            live.sessionId,
            error instanceof Error ? error.message : String(error),
          );
        });
      }
    }).catch((error) => {
      this.reportAsyncLiveError(
        live.sessionId,
        error instanceof Error ? error.message : String(error),
      );
    }).finally(() => {
      live.turnStartInFlight = false;
      if (!live.currentTurnId) {
        live.interruptWhenTurnStarts = false;
      }
      this.drainQueuedInput(live);
    });
  }

  async startSession(request: StartSessionRequest): Promise<StartSessionResponse> {
    const cachedModelCatalog =
      request.model || request.reasoningId !== undefined || request.optionValues !== undefined
        ? await this.modelCatalog.listModels()
        : this.modelCatalog.getCached();
    return await startCodexLiveSession({
      services: this.services,
      request,
      ...(cachedModelCatalog ? { initialModelCatalog: cachedModelCatalog } : {}),
      onLiveSessionReady: (liveSession) => {
        this.registerLiveSession(liveSession);
      },
    }).then((response) => ({ session: response.summary }));
  }

  async resumeSession(request: ResumeSessionRequest): Promise<ResumeSessionResponse> {
    const preparedResume = prepareProviderSessionResume({
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
      this.refreshStoredSessionIndex().get(request.providerSessionId) ??
      this.storedSessionIndex.get(request.providerSessionId);
    if (request.preferStoredReplay && !record) {
      throw new Error(`Unknown Codex session ${request.providerSessionId}.`);
    }
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

    const cachedModelCatalog =
      request.model || request.reasoningId !== undefined || request.optionValues !== undefined
        ? await this.modelCatalog.listModels()
        : this.modelCatalog.getCached();
    try {
      const response = await resumeCodexLiveSession({
        services: this.services,
        request,
        ...(record ? { record } : {}),
        ...(cachedModelCatalog ? { initialModelCatalog: cachedModelCatalog } : {}),
        onLiveSessionReady: (liveSession) => {
          this.registerLiveSession(liveSession);
        },
      });
      return { session: response.summary };
    } catch (error) {
      if (!record) {
        preparedResume.rollback();
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
      if (live.currentTurnId || live.turnStartInFlight) {
        live.queuedInputs.push(request);
        return;
      }
      this.startLiveTurn(live, request);
      return;
    }
    throw new Error(
      "Rehydrated Codex sessions are currently read-only. Live Codex app-server control is not wired yet.",
    );
  }

  async listModels(options?: { cwd?: string; forceRefresh?: boolean }): Promise<ProviderModelCatalog> {
    void options?.cwd;
    return await this.modelCatalog.listModels(options);
  }

  async setSessionModel(
    sessionId: string,
    request: SetSessionModelRequest,
  ): Promise<SessionSummary> {
    const live = this.liveSessions.get(sessionId);
    if (!live) {
      throw new Error("Codex model switching is only available for live sessions.");
    }
    const nextModelId = request.modelId.trim();
    if (!nextModelId) {
      throw new Error("Session model is required.");
    }
    const catalog = await this.modelCatalog.listModels();
    const model = catalog.models.find((entry) => entry.id === nextModelId);
    if (!model) {
      throw new Error(`Unsupported Codex model '${nextModelId}'.`);
    }
    const optionValues = resolveModelOptionValues({
      catalog,
      model,
      optionValues: request.optionValues,
      reasoningId: request.reasoningId,
      useDefaults: true,
      requireMutable: true,
    });
    const optionReasoningId = optionValueAsString(optionValues, "model_reasoning_effort");
    const nextReasoningId =
      optionReasoningId !== undefined
        ? optionReasoningId
        : request.reasoningId === null
          ? null
          : request.reasoningId?.trim() || model.defaultReasoningId || null;
    live.modelId = nextModelId;
    live.reasoningId = nextReasoningId;
    live.modelCatalog = catalog;
    const nextState = this.services.sessionStore.patchManagedSession(sessionId, {
      model: {
        currentModelId: nextModelId,
        currentReasoningId: nextReasoningId,
        availableModels: catalog.models,
        mutable: true,
        source: catalog.source,
      },
      ...resolveCodexRuntimeCapabilityState({
        catalog,
        modelId: nextModelId,
        reasoningId: nextReasoningId,
        optionValues,
      }),
    });
    return toSessionSummary(nextState);
  }

  async setSessionMode(sessionId: string, modeId: string): Promise<SessionSummary> {
    const live = this.liveSessions.get(sessionId);
    if (!live) {
      throw new Error("Codex mode switching is only available for live sessions.");
    }
    if (modeId === "plan") {
      if (!live.planCollaborationMode) {
        live.planCollaborationMode = await loadCodexPlanCollaborationMode(live.client);
      }
      if (!live.planCollaborationMode) {
        throw new Error("Codex plan mode is not available for this session.");
      }
      live.activeModeId = "plan";
      const nextState = this.services.sessionStore.patchManagedSession(sessionId, {
        mode: buildCodexModeState({
          currentModeId: "plan",
          mutable: true,
          preferredAccessModeId: live.lastNonPlanModeId,
          planAvailable: true,
        }),
      });
      return toSessionSummary(nextState);
    }
    const parsed = parseCodexModeId(modeId);
    if (!parsed) {
      throw new Error(`Unsupported Codex mode '${modeId}'.`);
    }
    live.approvalPolicy = parsed.approvalPolicy;
    live.sandboxMode = parsed.sandboxMode;
    live.activeModeId = modeId;
    live.lastNonPlanModeId = modeId;
    const nextState = this.services.sessionStore.patchManagedSession(sessionId, {
      mode: buildCodexModeState({
        currentModeId: modeId,
        mutable: true,
        planAvailable: Boolean(live.planCollaborationMode),
      }),
    });
    return toSessionSummary(nextState);
  }

  async renameSession(sessionId: string, title: string): Promise<SessionSummary> {
    const state = this.services.sessionStore.getSession(sessionId);
    if (!state?.session.providerSessionId) {
      throw new Error(`Session ${sessionId} does not have a provider session id.`);
    }

    const live = this.liveSessions.get(sessionId);
    if (live) {
      await live.client.request("thread/name/set", {
        threadId: live.threadId,
        name: title,
      });
    } else {
      const client = await createCodexAppServerClient();
      try {
        await client.request("thread/name/set", {
          threadId: state.session.providerSessionId,
          name: title,
        });
      } finally {
        await client.dispose();
      }
    }

    const nextState = this.services.sessionStore.patchManagedSession(sessionId, { title });
    this.patchStoredTitle(state.session.providerSessionId, title);
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
      live.queuedInputs.length = 0;
      if (turnId) {
        void live.client.request("turn/interrupt", {
          threadId: live.threadId,
          turnId,
        }).catch((error) => {
          this.reportAsyncLiveError(
            sessionId,
            error instanceof Error ? error.message : String(error),
          );
        });
      } else if (live.turnStartInFlight) {
        live.interruptWhenTurnStarts = true;
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

  getWorkspaceSnapshot(sessionId: string, options?: { scopeRoot?: string }): WorkspaceSnapshotResponse {
    const session = this.services.sessionStore.getSession(sessionId)?.session;
    if (!session) {
      const record = this.rehydratedSessionRecords.get(sessionId);
      if (!record) {
        throw new Error(`Unknown session ${sessionId}`);
      }
      const snapshot = getWorkspaceSnapshot(options?.scopeRoot ?? record.ref.cwd ?? process.cwd());
      return {
        sessionId,
        cwd: snapshot.cwd,
        nodes: snapshot.nodes,
      };
    }
    const snapshot = getWorkspaceSnapshot(options?.scopeRoot ?? session.cwd);
    return {
      sessionId,
      cwd: snapshot.cwd,
      nodes: snapshot.nodes,
    };
  }

  async getGitStatus(sessionId: string, options?: { scopeRoot?: string }): Promise<GitStatusResponse> {
    const session = this.services.sessionStore.getSession(sessionId)?.session;
    if (!session) {
      const record = this.rehydratedSessionRecords.get(sessionId);
      if (!record) {
        throw new Error(`Unknown session ${sessionId}`);
      }
      const status = await getWorkspaceGitStatusAsync(record.ref.cwd ?? process.cwd(), options);
      return {
        sessionId,
        ...(status.branch !== undefined ? { branch: status.branch } : {}),
        changedFiles: status.changedFiles,
        ...(status.stagedFiles ? { stagedFiles: status.stagedFiles } : {}),
        ...(status.unstagedFiles ? { unstagedFiles: status.unstagedFiles } : {}),
        ...(status.totalStaged !== undefined ? { totalStaged: status.totalStaged } : {}),
        ...(status.totalUnstaged !== undefined ? { totalUnstaged: status.totalUnstaged } : {}),
      };
    }
    const status = await getWorkspaceGitStatusAsync(session.cwd, options);
    return {
      sessionId,
      ...(status.branch !== undefined ? { branch: status.branch } : {}),
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
    const session = this.services.sessionStore.getSession(sessionId)?.session;
    if (!session) {
      const record = this.rehydratedSessionRecords.get(sessionId);
      if (!record) {
        throw new Error(`Unknown session ${sessionId}`);
      }
      return {
        sessionId,
        path: targetPath,
        diff: await getWorkspaceGitDiffAsync(record.ref.cwd ?? process.cwd(), targetPath, options),
      };
    }
    return {
      sessionId,
      path: targetPath,
      diff: await getWorkspaceGitDiffAsync(session.cwd, targetPath, options),
    };
  }

  async applyGitFileAction(sessionId: string, request: GitFileActionRequest): Promise<GitFileActionResponse> {
    const session = this.services.sessionStore.getSession(sessionId)?.session;
    if (!session) {
      const record = this.rehydratedSessionRecords.get(sessionId);
      if (!record) {
        throw new Error(`Unknown session ${sessionId}`);
      }
      return {
        ...(await applyWorkspaceGitFileActionAsync(record.ref.cwd ?? process.cwd(), request, {
          scopeRoot: record.ref.rootDir ?? record.ref.cwd ?? process.cwd(),
        })),
        sessionId,
      };
    }
    return {
      ...(await applyWorkspaceGitFileActionAsync(session.cwd, request, {
        scopeRoot: session.rootDir ?? session.cwd,
      })),
      sessionId,
    };
  }

  async applyGitHunkAction(sessionId: string, request: GitHunkActionRequest): Promise<GitHunkActionResponse> {
    const session = this.services.sessionStore.getSession(sessionId)?.session;
    if (!session) {
      const record = this.rehydratedSessionRecords.get(sessionId);
      if (!record) {
        throw new Error(`Unknown session ${sessionId}`);
      }
      return {
        ...(await applyWorkspaceGitHunkActionAsync(record.ref.cwd ?? process.cwd(), request, {
          scopeRoot: record.ref.rootDir ?? record.ref.cwd ?? process.cwd(),
        })),
        sessionId,
      };
    }
    return {
      ...(await applyWorkspaceGitHunkActionAsync(session.cwd, request, {
        scopeRoot: session.rootDir ?? session.cwd,
      })),
      sessionId,
    };
  }

  async readSessionFile(
    sessionId: string,
    targetPath: string,
    options?: { scopeRoot?: string },
  ): Promise<SessionFileResponse> {
    const session = this.services.sessionStore.getSession(sessionId)?.session;
    if (!session) {
      const record = this.rehydratedSessionRecords.get(sessionId);
      if (!record) {
        throw new Error(`Unknown session ${sessionId}`);
      }
      return {
        ...(await readWorkspaceFileFromDirectoryAsync(record.ref.cwd ?? process.cwd(), targetPath, options)),
        sessionId,
      };
    }
    return {
      ...(await readWorkspaceFileFromDirectoryAsync(session.cwd, targetPath, options)),
      sessionId,
    };
  }

  getSessionHistoryPage(
    sessionId: string,
    options: { beforeTs?: string; cursor?: string; limit?: number } = {},
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
        finalizeUnterminatedTools: this.canFinalizeStoredHistory(record),
        ...options,
      });
    }
    const providerSessionId = session.providerSessionId;
    if (!providerSessionId) {
      return { sessionId, events: [] };
    }
    const record =
      this.refreshStoredSessionIndex().get(providerSessionId) ??
      this.storedSessionIndex.get(providerSessionId);
    if (!record) {
      return { sessionId, events: [] };
    }
    return getCodexStoredSessionHistoryPage({
      sessionId,
      record,
      finalizeUnterminatedTools: this.canFinalizeStoredHistory(record),
      ...options,
    });
  }

  createFrozenHistoryPageLoader(sessionId: string) {
    const session = this.services.sessionStore.getSession(sessionId)?.session;
    if (!session) {
      const record = this.rehydratedSessionRecords.get(sessionId);
      if (!record) {
        return undefined;
      }
      return createCodexStoredSessionFrozenHistoryPageLoader({
        sessionId,
        record,
        finalizeUnterminatedTools: this.canFinalizeStoredHistory(record),
      });
    }
    const providerSessionId = session.providerSessionId;
    if (!providerSessionId) {
      return undefined;
    }
    const record =
      this.rehydratedSessionRecords.get(sessionId) ??
      this.storedSessionIndex.get(providerSessionId) ??
      this.refreshStoredSessionIndex().get(providerSessionId);
    if (!record) {
      return undefined;
    }
    return createCodexStoredSessionFrozenHistoryPageLoader({
      sessionId,
      record,
      finalizeUnterminatedTools: this.canFinalizeStoredHistory(record),
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
    return resolveCodexStoredSessionWatchRoots();
  }

  async removeStoredSession(session: StoredSessionRef): Promise<void> {
    const record =
      this.storedSessionIndex.get(session.providerSessionId) ??
      this.refreshStoredSessionIndex().get(session.providerSessionId);
    if (!record) {
      throw new Error(`Could not find a stored Codex history file for ${session.providerSessionId}.`);
    }
    await movePathToTrash(record.rolloutPath);
    this.storedSessionIndex.delete(session.providerSessionId);
  }

  async getProviderDiagnostic(options?: { forceRefresh?: boolean }) {
    return probeProviderDiagnostic("codex", await codexLaunchSpec(), options);
  }

  private refreshStoredSessionIndex(): Map<string, CodexStoredSessionRecord> {
    this.storedSessionIndex = new Map(
      discoverCodexStoredSessions().map((record) => [record.ref.providerSessionId, record]),
    );
    return this.storedSessionIndex;
  }

  private patchStoredTitle(providerSessionId: string, title: string): void {
    const patchRecord = (record: CodexStoredSessionRecord | undefined) => {
      if (!record) {
        return;
      }
      record.ref = {
        ...record.ref,
        title,
      };
      const stats = statSync(record.rolloutPath);
      const cache = loadStoredSessionMetadataCache("codex");
      setCachedStoredSessionRef({
        cache,
        filePath: record.rolloutPath,
        size: stats.size,
        mtimeMs: stats.mtimeMs,
        ref: record.ref,
      });
      writeStoredSessionMetadataCache("codex", cache);
    };

    patchRecord(this.storedSessionIndex.get(providerSessionId));
    for (const record of this.rehydratedSessionRecords.values()) {
      if (record.ref.providerSessionId === providerSessionId) {
        patchRecord(record);
      }
    }
  }

  async shutdown(): Promise<void> {
    const sessions = [...this.liveSessions.values()];
    this.liveSessions.clear();
    const results = await Promise.allSettled(sessions.map((live) => live.client.dispose()));
    results.forEach((result, index) => {
      if (result.status === "rejected") {
        console.error("[rah] failed to dispose Codex live session during shutdown", {
          sessionId: sessions[index]?.sessionId,
          error: result.reason,
        });
      }
    });
  }
}

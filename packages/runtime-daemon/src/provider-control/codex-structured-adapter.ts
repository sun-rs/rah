import type {
  CloseSessionRequest,
  InterruptSessionRequest,
  PermissionResponseRequest,
  ProviderModelCatalog,
  ResumeSessionRequest,
  ResumeSessionResponse,
  SetSessionModelRequest,
  SessionInputRequest,
  SessionSummary,
  StartSessionRequest,
  StartSessionResponse,
} from "@rah/runtime-protocol";
import type { ProviderAdapter, RuntimeServices } from "../provider-adapter";
import {
  loadCodexPlanCollaborationMode,
  respondToCodexLivePermission,
  resumeCodexLiveSession,
  startCodexLiveSession,
  type LiveCodexSession,
} from "./codex-live-client";
import { createCodexAppServerClient } from "../codex-app-server-client";
import {
  CodexModelCatalogCache,
  resolveCodexRuntimeCapabilityState,
} from "../codex-model-catalog";
import {
  findCodexStoredSessionRecord,
  patchCodexStoredSessionTitle,
  resumeCodexStoredSession,
} from "../codex-stored-sessions";
import {
  finalizeStoredReplayResume,
  prepareProviderSessionResume,
} from "../provider-resume";
import { codexLaunchSpec, probeProviderDiagnostic } from "../provider-diagnostics";
import { toSessionSummary } from "../session-store";
import {
  buildCodexModeState,
  codexPlanAccessModeId,
  parseCodexModeId,
} from "../session-mode-utils";
import { optionValueAsString, resolveModelOptionValues } from "../session-model-options";
import { applyProviderActivity } from "../provider-activity";
import { timelineRuntimeModel } from "../timeline-runtime-model";
import { mergeManualProviderModels } from "../manual-provider-models";
import { publishSessionStateChanged } from "../runtime-session-events";

const CODEX_EVENT_SOURCE = {
  provider: "codex" as const,
  channel: "structured_live" as const,
  authority: "derived" as const,
};
const CODEX_INTERRUPT_FALLBACK_MS = 1_500;

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
  private readonly modelCatalog = new CodexModelCatalogCache();

  constructor(services: RuntimeServices) {
    this.services = services;
  }

  private reportAsyncLiveError(sessionId: string, detail: string): void {
    const state = this.services.sessionStore.getSession(sessionId);
    if (state) {
      this.services.sessionStore.patchManagedSession(sessionId, {
        runtimeDiagnostics: {
          ...(state.session.runtimeDiagnostics ?? {}),
          lastError: detail,
        },
      });
    }
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
    liveSession.requestTurnInterrupt = (turnId) => this.requestLiveTurnInterrupt(liveSession, turnId);
    liveSession.client.setCloseHandler((error) => {
      this.handleLiveClientClosed(liveSession, error);
    });
    this.liveSessions.set(liveSession.sessionId, liveSession);
  }

  private handleLiveClientClosed(liveSession: LiveCodexSession, error: Error): void {
    if (this.liveSessions.get(liveSession.sessionId) !== liveSession) {
      return;
    }
    this.liveSessions.delete(liveSession.sessionId);
    this.clearInterruptFallback(liveSession);
    const state = this.services.sessionStore.getSession(liveSession.sessionId);
    if (!state) {
      return;
    }
    const detail = error.message || "Codex app-server closed";
    this.services.sessionStore.patchManagedSession(liveSession.sessionId, {
      ...(state.session.nativeTui
        ? {
            nativeTui: {
              ...state.session.nativeTui,
              viewAvailable: false,
            },
          }
        : {}),
      runtimeDiagnostics: {
        ...(state.session.runtimeDiagnostics ?? {}),
        attachState: "failed",
        lastError: detail,
      },
    });
    this.services.eventBus.publish({
      sessionId: liveSession.sessionId,
      type: "runtime.status",
      source: CODEX_EVENT_SOURCE,
      payload: {
        status: "error",
        detail,
      },
    });
    this.services.sessionStore.setRuntimeState(liveSession.sessionId, "failed");
    publishSessionStateChanged(this.services, liveSession.sessionId, "failed");
  }

  private drainQueuedInput(live: LiveCodexSession): void {
    if (!live.threadId || live.currentTurnId || live.turnStartInFlight) {
      return;
    }
    const next = live.queuedInputs.shift();
    if (!next) {
      return;
    }
    this.startLiveTurn(live, next);
  }

  private clearInterruptFallback(live: LiveCodexSession): void {
    if (live.interruptFallbackTimer) {
      clearTimeout(live.interruptFallbackTimer);
      delete live.interruptFallbackTimer;
    }
    delete live.interruptFallbackTurnId;
  }

  private scheduleInterruptFallback(live: LiveCodexSession, turnId: string): void {
    this.clearInterruptFallback(live);
    live.interruptFallbackTurnId = turnId;
    live.interruptFallbackTimer = setTimeout(() => {
      delete live.interruptFallbackTimer;
      delete live.interruptFallbackTurnId;
      if (
        this.liveSessions.get(live.sessionId) !== live ||
        live.currentTurnId !== turnId ||
        !live.interruptingTurnIds.has(turnId)
      ) {
        return;
      }
      live.finishedTurnIds.add(turnId);
      live.interruptingTurnIds.delete(turnId);
      live.currentTurnId = null;
      live.interruptWhenTurnStarts = false;
      applyProviderActivity(this.services, live.sessionId, CODEX_EVENT_SOURCE, {
        type: "turn_canceled",
        turnId,
        reason: "Interrupted",
      });
      live.drainQueuedInput?.();
    }, CODEX_INTERRUPT_FALLBACK_MS);
    live.interruptFallbackTimer.unref?.();
  }

  private requestLiveTurnInterrupt(live: LiveCodexSession, turnId: string): void {
    if (live.interruptingTurnIds.has(turnId)) {
      return;
    }
    live.interruptingTurnIds.add(turnId);
    void live.client
      .request("turn/interrupt", {
        threadId: live.threadId,
        turnId,
      })
      .then(() => {
        this.scheduleInterruptFallback(live, turnId);
      })
      .catch((error) => {
        this.reportAsyncLiveError(
          live.sessionId,
          error instanceof Error ? error.message : String(error),
        );
      });
  }

  private startLiveTurn(live: LiveCodexSession, request: SessionInputRequest): void {
    if (!live.threadId) {
      live.queuedInputs.push(request);
      return;
    }
    live.interruptExternalTurnWhenStarts = false;
    const collaborationMode = codexCollaborationModeForTurn(live);
    const requestRuntimeModel = timelineRuntimeModel({
      modelId: live.modelId,
      optionId: live.reasoningId,
      optionKind: "reasoning_effort",
      source: "request",
    });
    if (requestRuntimeModel) {
      live.translationState.pendingRuntimeModel = requestRuntimeModel;
    } else {
      delete live.translationState.pendingRuntimeModel;
    }
    live.turnStartInFlight = true;
    void live.client.request(
      "turn/start",
      {
        threadId: live.threadId,
        input: [{ type: "text", text: request.text }],
        cwd: live.cwd,
        approvalPolicy: live.approvalPolicy,
        ...(live.approvalsReviewer === "auto_review"
          ? { approvalsReviewer: live.approvalsReviewer }
          : {}),
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
      if (
        typeof turn?.id === "string" &&
        live.translationState.pendingRuntimeModel &&
        !live.translationState.runtimeModelByTurnId.has(turn.id)
      ) {
        live.translationState.runtimeModelByTurnId.set(
          turn.id,
          live.translationState.pendingRuntimeModel,
        );
        delete live.translationState.pendingRuntimeModel;
      }
      if (typeof turn?.id === "string" && live.interruptWhenTurnStarts) {
        const turnId = turn.id;
        live.interruptWhenTurnStarts = false;
        this.requestLiveTurnInterrupt(live, turnId);
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
    const rawCachedModelCatalog = this.modelCatalog.getCached();
    const cachedModelCatalog =
      request.model || request.reasoningId !== undefined || request.optionValues !== undefined
        ? mergeManualProviderModels(await this.modelCatalog.listModels())
        : rawCachedModelCatalog
          ? mergeManualProviderModels(rawCachedModelCatalog)
          : null;
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
      historySourceSessionId: request.historySourceSessionId,
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

    const record = findCodexStoredSessionRecord(request.providerSessionId);
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
        createSession: () =>
          resumeCodexStoredSession(
            request.attach !== undefined
              ? { services: this.services, record, attach: request.attach }
              : { services: this.services, record },
          ),
      });
    }

    if (record && request.cwd !== undefined && request.cwd !== record.ref.cwd) {
      record.ref = {
        ...record.ref,
        cwd: request.cwd,
        rootDir: request.cwd,
      };
    }

    const rawCachedModelCatalog = this.modelCatalog.getCached();
    const cachedModelCatalog =
      request.model || request.reasoningId !== undefined || request.optionValues !== undefined
        ? mergeManualProviderModels(await this.modelCatalog.listModels())
        : rawCachedModelCatalog
          ? mergeManualProviderModels(rawCachedModelCatalog)
          : null;
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
      createSession: () =>
        resumeCodexStoredSession(
          request.attach !== undefined
            ? { services: this.services, record, attach: request.attach }
            : { services: this.services, record },
        ),
    });
  }

  sendInput(sessionId: string, request: SessionInputRequest): void {
    const live = this.liveSessions.get(sessionId);
    if (live) {
      if (!live.threadId || live.currentTurnId || live.turnStartInFlight) {
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
    return mergeManualProviderModels(await this.modelCatalog.listModels(options));
  }

  async setSessionModel(
    sessionId: string,
    request: SetSessionModelRequest,
  ): Promise<SessionSummary> {
    const live = this.liveSessions.get(sessionId);
    if (!live) {
      throw new Error("Codex model switching is only available for running sessions.");
    }
    const nextModelId = request.modelId.trim();
    if (!nextModelId) {
      throw new Error("Session model is required.");
    }
    const catalog = mergeManualProviderModels(await this.modelCatalog.listModels());
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
      throw new Error("Codex mode switching is only available for running sessions.");
    }
    const planAccessModeId = codexPlanAccessModeId(modeId);
    if (modeId === "plan" || planAccessModeId) {
      if (!live.planCollaborationMode) {
        live.planCollaborationMode = await loadCodexPlanCollaborationMode(live.client);
      }
      if (!live.planCollaborationMode) {
        throw new Error("Codex plan mode is not available for this session.");
      }
      if (planAccessModeId) {
        const parsed = parseCodexModeId(planAccessModeId);
        if (!parsed) {
          throw new Error(`Unsupported Codex mode '${modeId}'.`);
        }
        live.approvalPolicy = parsed.approvalPolicy;
        live.sandboxMode = parsed.sandboxMode;
        live.approvalsReviewer = parsed.approvalsReviewer ?? "user";
        live.lastNonPlanModeId = planAccessModeId;
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
    live.approvalsReviewer = parsed.approvalsReviewer ?? "user";
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
    patchCodexStoredSessionTitle(state.session.providerSessionId, title);
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
      this.clearInterruptFallback(live);
      await live.client.dispose();
    }
    this.rehydratedSessionIds.delete(sessionId);
  }

  async destroySession(sessionId: string): Promise<void> {
    const live = this.liveSessions.get(sessionId);
    if (live) {
      this.liveSessions.delete(sessionId);
      this.clearInterruptFallback(live);
      await live.client.dispose();
    }
    this.rehydratedSessionIds.delete(sessionId);
  }

  interruptSession(sessionId: string, request: InterruptSessionRequest): SessionSummary {
    const live = this.liveSessions.get(sessionId);
    if (live) {
      const state = this.services.sessionStore.getSession(sessionId);
      if (!state) {
        throw new Error(`Unknown session ${sessionId}`);
      }
      const turnId = live.currentTurnId;
      live.queuedInputs.length = 0;
      if (turnId) {
        this.requestLiveTurnInterrupt(live, turnId);
      } else if (live.turnStartInFlight && !live.interruptWhenTurnStarts) {
        live.interruptWhenTurnStarts = true;
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
      throw new Error("Codex running sessions do not support PTY input bridging yet.");
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

  async getProviderDiagnostic(options?: { forceRefresh?: boolean }) {
    return probeProviderDiagnostic("codex", await codexLaunchSpec(), options);
  }

  async shutdown(): Promise<void> {
    const sessions = [...this.liveSessions.values()];
    this.liveSessions.clear();
    sessions.forEach((live) => this.clearInterruptFallback(live));
    const results = await Promise.allSettled(sessions.map((live) => live.client.dispose()));
    results.forEach((result, index) => {
      if (result.status === "rejected") {
        console.error("[rah] failed to dispose Codex running session during shutdown", {
          sessionId: sessions[index]?.sessionId,
          error: result.reason,
        });
      }
    });
  }
}

import type {
  CloseSessionRequest,
  DeleteQueuedInputRequest,
  InterruptSessionRequest,
  PermissionResponseRequest,
  ProviderModelCatalog,
  ReorderQueuedInputRequest,
  ResumeSessionRequest,
  ResumeSessionResponse,
  SetSessionModelRequest,
  SessionInputRequest,
  SessionSummary,
  StartSessionRequest,
  StartSessionResponse,
  UpdateQueuedInputRequest,
} from "@rah/runtime-protocol";
import type { ProviderAdapter, RuntimeServices } from "../provider-adapter";
import {
  closeOpenCodeLiveSession,
  deleteOpenCodeQueuedInput,
  interruptOpenCodeLiveSession,
  respondToOpenCodeLivePermission,
  retryOpenCodeQueuedInput,
  resumeOpenCodeLiveSession,
  sendInputToOpenCodeLiveSession,
  setOpenCodeLiveSessionMode,
  startOpenCodeLiveSession,
  type LiveOpenCodeSession,
} from "./opencode-live-client";
import {
  findOpenCodeStoredSessionRecord,
  resumeOpenCodeStoredSession,
} from "../opencode-stored-sessions";
import { opencodeLaunchSpec, probeProviderDiagnostic } from "../provider-diagnostics";
import {
  buildOpenCodeFallbackModelCatalog,
  normalizeOpenCodeOptionValues,
  normalizeOpenCodeReasoningId,
  OpenCodeModelCatalogCache,
  resolveOpenCodeRuntimeCapabilityState,
} from "../opencode-model-catalog";
import { optionValueAsString, resolveModelOptionValues } from "../session-model-options";
import {
  finalizeStoredReplayResume,
  prepareProviderSessionResume,
  reuseExistingProviderSessionForResume,
} from "../provider-resume";
import { toSessionSummary } from "../session-store";
import { mergeManualProviderModels } from "../manual-provider-models";
import {
  publishSessionInputQueue,
  reorderRuntimeQueuedInput,
  SessionInputQueueConflictError,
  updateRuntimeQueuedInput,
} from "../session-input-queue";

interface OpenCodeStartupModelCatalogSource {
  getCached(options?: { cwd?: string }): ProviderModelCatalog | null;
  listModels(options?: { cwd?: string; forceRefresh?: boolean }): Promise<ProviderModelCatalog>;
}

export function readOpenCodeStartupModelCatalog(
  source: OpenCodeStartupModelCatalogSource,
  cwd: string,
): ProviderModelCatalog {
  const catalog = mergeManualProviderModels(
    source.getCached({ cwd }) ?? buildOpenCodeFallbackModelCatalog(),
  );
  // A selected model and its provider-native option values are already part of
  // the start/resume request. Catalog discovery enriches later UI controls but
  // must never serialize provider probing into the interactive launch path.
  void source.listModels({ cwd }).catch(() => undefined);
  return catalog;
}

export class OpenCodeAdapter implements ProviderAdapter {
  readonly id = "opencode";
  readonly providers: Array<"opencode"> = ["opencode"];

  private readonly services: RuntimeServices;
  private readonly liveSessions = new Map<string, LiveOpenCodeSession>();
  private readonly rehydratedSessionIds = new Set<string>();
  private readonly modelCatalog = new OpenCodeModelCatalogCache();

  constructor(services: RuntimeServices) {
    this.services = services;
  }

  async startSession(request: StartSessionRequest): Promise<StartSessionResponse> {
    const modelCatalog = readOpenCodeStartupModelCatalog(this.modelCatalog, request.cwd);
    const response = await startOpenCodeLiveSession({
      services: this.services,
      request,
      modelCatalog,
    });
    this.liveSessions.set(response.liveSession.sessionId, response.liveSession);
    publishSessionInputQueue(
      this.services,
      response.liveSession.sessionId,
      response.liveSession.queuedInputs,
    );
    return { session: response.summary };
  }

  async resumeSession(request: ResumeSessionRequest): Promise<ResumeSessionResponse> {
    const reused = reuseExistingProviderSessionForResume({
      services: this.services,
      provider: "opencode",
      providerSessionId: request.providerSessionId,
      preferStoredReplay: request.preferStoredReplay,
      historySourceSessionId: request.historySourceSessionId,
      rehydratedSessionIds: this.rehydratedSessionIds,
      ...(request.attach !== undefined ? { attach: request.attach } : {}),
    });
    if (reused) {
      return reused;
    }
    const preparedResume = prepareProviderSessionResume({
      services: this.services,
      provider: "opencode",
      providerSessionId: request.providerSessionId,
      preferStoredReplay: request.preferStoredReplay,
      historySourceSessionId: request.historySourceSessionId,
      rehydratedSessionIds: this.rehydratedSessionIds,
    });
    const record = findOpenCodeStoredSessionRecord(request.providerSessionId);
    if (request.preferStoredReplay) {
      if (!record) {
        throw new Error(`Unknown OpenCode session ${request.providerSessionId}.`);
      }
      return finalizeStoredReplayResume({
        services: this.services,
        provider: "opencode",
        providerSessionId: request.providerSessionId,
        rehydratedSessionIds: this.rehydratedSessionIds,
        createSession: () =>
          resumeOpenCodeStoredSession(
            request.attach !== undefined
              ? { services: this.services, record, attach: request.attach }
              : { services: this.services, record },
          ),
      });
    }
    try {
      const resumeCwd = request.cwd ?? record?.ref.cwd ?? record?.ref.rootDir ?? process.cwd();
      const cachedModelCatalog = readOpenCodeStartupModelCatalog(this.modelCatalog, resumeCwd);
      const response = await resumeOpenCodeLiveSession({
        services: this.services,
        providerSessionId: request.providerSessionId,
        cwd: resumeCwd,
        ...(request.attach ? { attach: request.attach } : {}),
        ...(request.origin !== undefined ? { origin: request.origin } : {}),
        ...(request.modeId ? { modeId: request.modeId } : {}),
        ...(request.model ? { model: request.model } : {}),
        ...(request.optionValues !== undefined ? { optionValues: request.optionValues } : {}),
        ...(request.historyReplay !== undefined ? { historyReplay: request.historyReplay } : {}),
        modelCatalog: cachedModelCatalog,
      });
      this.liveSessions.set(response.liveSession.sessionId, response.liveSession);
      publishSessionInputQueue(
        this.services,
        response.liveSession.sessionId,
        response.liveSession.queuedInputs,
      );
      return { session: response.summary };
    } catch (error) {
      preparedResume.rollback();
      throw error;
    }
  }

  async listModels(options?: { cwd?: string; forceRefresh?: boolean }): Promise<ProviderModelCatalog> {
    return mergeManualProviderModels(await this.modelCatalog.listModels(options));
  }

  async setSessionModel(
    sessionId: string,
    request: SetSessionModelRequest,
  ): Promise<SessionSummary> {
    const live = this.liveSessions.get(sessionId);
    if (!live) {
      throw new Error("OpenCode model switching is only available for running sessions.");
    }
    const catalog = mergeManualProviderModels(await this.modelCatalog.listModels({ cwd: live.cwd }));
    const model = catalog.models.find((entry) => entry.id === request.modelId);
    const requestedOptionValues = normalizeOpenCodeOptionValues(request.optionValues);
    const optionValues = model
      ? resolveModelOptionValues({
          catalog,
          model,
          optionValues: requestedOptionValues,
          useDefaults: true,
          requireMutable: true,
        })
      : requestedOptionValues ?? {};
    const normalizedOptionValues = normalizeOpenCodeOptionValues(optionValues) ?? {};
    const optionReasoningId = optionValueAsString(normalizedOptionValues, "model_reasoning_variant");
    const reasoningId = optionReasoningId ?? model?.defaultReasoningId ?? null;
    live.model = request.modelId;
    live.reasoningId = reasoningId;
    const runtimeCapabilityState = resolveOpenCodeRuntimeCapabilityState({
      catalog,
      modelId: request.modelId,
      reasoningId,
      optionValues: normalizedOptionValues,
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
      throw new Error("OpenCode mode switching is only available for running sessions.");
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

  updateQueuedInput(
    sessionId: string,
    clientMessageId: string,
    request: UpdateQueuedInputRequest,
  ): SessionSummary {
    const live = this.liveSessions.get(sessionId);
    if (!live) {
      throw new Error("OpenCode session is not live.");
    }
    if (!request.text.trim()) {
      throw new Error("Queued message cannot be empty.");
    }
    if (!updateRuntimeQueuedInput(live.queuedInputs, clientMessageId, request.text)) {
      throw new SessionInputQueueConflictError(
        "Queued message is no longer waiting and cannot be edited.",
      );
    }
    publishSessionInputQueue(this.services, sessionId, live.queuedInputs);
    retryOpenCodeQueuedInput({
      services: this.services,
      liveSession: live,
      clientMessageId,
    });
    return toSessionSummary(this.services.sessionStore.getSession(sessionId)!);
  }

  deleteQueuedInput(
    sessionId: string,
    clientMessageId: string,
    request: DeleteQueuedInputRequest,
  ): SessionSummary {
    void request;
    const live = this.liveSessions.get(sessionId);
    if (!live) {
      throw new Error("OpenCode session is not live.");
    }
    if (!deleteOpenCodeQueuedInput({
      services: this.services,
      liveSession: live,
      clientMessageId,
    })) {
      throw new SessionInputQueueConflictError(
        "Queued message is no longer waiting and cannot be removed.",
      );
    }
    return toSessionSummary(this.services.sessionStore.getSession(sessionId)!);
  }

  reorderQueuedInput(
    sessionId: string,
    clientMessageId: string,
    request: ReorderQueuedInputRequest,
  ): SessionSummary {
    const live = this.liveSessions.get(sessionId);
    if (!live) {
      throw new Error("OpenCode session is not live.");
    }
    if (!reorderRuntimeQueuedInput(live.queuedInputs, clientMessageId, request.position)) {
      throw new SessionInputQueueConflictError(
        "Queued message is no longer waiting and cannot be reordered.",
      );
    }
    publishSessionInputQueue(this.services, sessionId, live.queuedInputs);
    return toSessionSummary(this.services.sessionStore.getSession(sessionId)!);
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
      await closeOpenCodeLiveSession(live, request, this.services);
    }
    this.rehydratedSessionIds.delete(sessionId);
  }

  async destroySession(sessionId: string): Promise<void> {
    const live = this.liveSessions.get(sessionId);
    if (live) {
      this.liveSessions.delete(sessionId);
      await closeOpenCodeLiveSession(live, undefined, this.services);
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
    // OpenCode running sessions are structured API sessions, not PTY-backed sessions.
  }

  async getProviderDiagnostic(options?: { forceRefresh?: boolean; includeHealth?: boolean }) {
    return await probeProviderDiagnostic("opencode", await opencodeLaunchSpec(), options);
  }

  async shutdown(): Promise<void> {
    const sessions = [...this.liveSessions.values()];
    this.liveSessions.clear();
    const results = await Promise.allSettled(
      sessions.map((session) => closeOpenCodeLiveSession(session, undefined, this.services)),
    );
    results.forEach((result, index) => {
      if (result.status === "rejected") {
        console.error("[rah] failed to close OpenCode running session during shutdown", {
          sessionId: sessions[index]?.sessionId,
          error: result.reason,
        });
      }
    });
  }
}

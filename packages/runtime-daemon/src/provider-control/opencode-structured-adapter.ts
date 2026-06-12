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
    const modelCatalog =
      request.model || request.reasoningId !== undefined || request.optionValues !== undefined
        ? mergeManualProviderModels(await this.modelCatalog.listModels({ cwd: request.cwd }))
        : mergeManualProviderModels(
            this.modelCatalog.getCached({ cwd: request.cwd }) ?? buildOpenCodeFallbackModelCatalog(),
          );
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
      const rawCachedModelCatalog = this.modelCatalog.getCached({ cwd: resumeCwd });
      const cachedModelCatalog =
        request.model || request.reasoningId !== undefined || request.optionValues !== undefined
          ? mergeManualProviderModels(await this.modelCatalog.listModels({ cwd: resumeCwd }))
          : rawCachedModelCatalog
            ? mergeManualProviderModels(rawCachedModelCatalog)
            : null;
      void this.modelCatalog.listModels({ cwd: resumeCwd }).catch(() => undefined);
      const response = await resumeOpenCodeLiveSession({
        services: this.services,
        providerSessionId: request.providerSessionId,
        cwd: resumeCwd,
        ...(request.attach ? { attach: request.attach } : {}),
        ...(request.origin !== undefined ? { origin: request.origin } : {}),
        ...(request.modeId ? { modeId: request.modeId } : {}),
        ...(request.model ? { model: request.model } : {}),
        ...(request.optionValues !== undefined ? { optionValues: request.optionValues } : {}),
        ...(request.reasoningId !== undefined ? { reasoningId: request.reasoningId } : {}),
        ...(request.providerConfig ? { providerConfig: request.providerConfig } : {}),
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
    const requestedReasoningId = normalizeOpenCodeReasoningId(request.reasoningId);
    const optionValues = model
      ? resolveModelOptionValues({
          catalog,
          model,
          optionValues: requestedOptionValues,
          reasoningId: requestedReasoningId,
          useDefaults: true,
          requireMutable: true,
        })
      : requestedOptionValues ?? {};
    const normalizedOptionValues = normalizeOpenCodeOptionValues(optionValues) ?? {};
    const optionReasoningId = optionValueAsString(normalizedOptionValues, "model_reasoning_variant");
    const reasoningId =
      optionReasoningId !== undefined
        ? optionReasoningId
        : requestedReasoningId !== undefined
          ? requestedReasoningId
          : model?.defaultReasoningId ?? null;
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
  }

  async destroySession(sessionId: string): Promise<void> {
    const live = this.liveSessions.get(sessionId);
    if (live) {
      this.liveSessions.delete(sessionId);
      await closeOpenCodeLiveSession(live);
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

  async getProviderDiagnostic(options?: { forceRefresh?: boolean }) {
    return await probeProviderDiagnostic("opencode", await opencodeLaunchSpec(), options);
  }

  async shutdown(): Promise<void> {
    const sessions = [...this.liveSessions.values()];
    this.liveSessions.clear();
    const results = await Promise.allSettled(
      sessions.map((session) => closeOpenCodeLiveSession(session)),
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

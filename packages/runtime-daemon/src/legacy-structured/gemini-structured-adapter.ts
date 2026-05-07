import type {
  CloseSessionRequest,
  InterruptSessionRequest,
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
  findGeminiStoredSessionRecord,
  resumeGeminiStoredSession,
} from "../gemini-session-files";
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
} from "../provider-resume";
import { geminiLaunchSpec, probeProviderDiagnostic } from "../provider-diagnostics";
import {
  buildGeminiModelCatalog,
  GeminiModelCatalogCache,
  normalizeGeminiModelId,
  resolveGeminiRuntimeCapabilityState,
} from "../gemini-model-catalog";
import { buildGeminiModeState, isGeminiModeId } from "../session-mode-utils";
import { toSessionSummary } from "../session-store";

const GEMINI_EVENT_SOURCE = {
  provider: "gemini" as const,
  channel: "structured_live" as const,
  authority: "derived" as const,
};

export class GeminiAdapter implements ProviderAdapter {
  readonly id = "gemini";
  readonly providers: Array<"gemini"> = ["gemini"];

  private readonly services: RuntimeServices;
  private readonly liveSessions = new Map<string, LiveGeminiSession>();
  private readonly rehydratedSessionIds = new Set<string>();
  private readonly modelCatalog = new GeminiModelCatalogCache();

  constructor(services: RuntimeServices) {
    this.services = services;
  }

  private reportAsyncLiveError(sessionId: string, detail: string): void {
    this.services.eventBus.publish({
      sessionId,
      type: "runtime.status",
      source: GEMINI_EVENT_SOURCE,
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
    const modelCatalog = this.modelCatalog.getCached() ?? buildGeminiModelCatalog();
    const response = startGeminiLiveSession({
      services: this.services,
      request,
      modelCatalog,
    });
    void this.modelCatalog.listModels({ cwd: request.cwd }).catch(() => undefined);
    this.liveSessions.set(response.liveSession.sessionId, response.liveSession);
    return { session: response.summary };
  }

  async resumeSession(request: ResumeSessionRequest): Promise<ResumeSessionResponse> {
    const preparedResume = prepareProviderSessionResume({
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

    const modelCatalog = this.modelCatalog.getCached() ?? buildGeminiModelCatalog();
    try {
      const response = resumeGeminiLiveSession({
        services: this.services,
        request: {
          providerSessionId: request.providerSessionId,
          ...(request.cwd ? { cwd: request.cwd } : {}),
          ...(request.model ? { model: request.model } : {}),
          ...(request.attach ? { attach: request.attach } : {}),
          ...(request.modeId ? { modeId: request.modeId } : {}),
          ...(request.approvalPolicy ? { approvalPolicy: request.approvalPolicy } : {}),
        },
        modelCatalog,
      });
      const catalogCwd = request.cwd ?? record?.ref.cwd;
      void this.modelCatalog
        .listModels(catalogCwd ? { cwd: catalogCwd } : undefined)
        .catch(() => undefined);
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
      throw new Error("Rehydrated Gemini sessions are currently read-only.");
    }
    void sendInputToGeminiLiveSession({
      services: this.services,
      liveSession: live,
      sessionId,
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
      throw new Error("Gemini model switching is only available for live sessions.");
    }
    const nextModelId = normalizeGeminiModelId(request.modelId);
    if (!nextModelId) {
      throw new Error("Session model is required.");
    }
    if (request.reasoningId !== undefined && request.reasoningId !== null) {
      throw new Error("Gemini does not expose a RAH-controlled reasoning option.");
    }
    if (request.optionValues !== undefined && Object.keys(request.optionValues).length > 0) {
      throw new Error("Gemini does not expose RAH-controlled model options.");
    }
    const catalog = await this.modelCatalog.listModels({ cwd: live.cwd });
    const model = catalog.models.find((entry) => entry.id === nextModelId);
    if (!model) {
      throw new Error(`Unsupported Gemini model '${nextModelId}'.`);
    }
    live.model = nextModelId;
    const runtimeCapabilityState = resolveGeminiRuntimeCapabilityState({
      catalog,
      modelId: nextModelId,
    });
    const nextState = this.services.sessionStore.patchManagedSession(sessionId, {
      model: {
        currentModelId: nextModelId,
        availableModels: catalog.models,
        mutable: true,
        source: catalog.source,
      },
      ...(runtimeCapabilityState.modelProfile
        ? { modelProfile: runtimeCapabilityState.modelProfile }
        : {}),
    });
    return toSessionSummary(nextState);
  }

  async renameSession(sessionId: string, title: string): Promise<SessionSummary> {
    const state = this.services.sessionStore.getSession(sessionId);
    if (!state) {
      throw new Error(`Unknown session ${sessionId}`);
    }
    const nextTitle = title.trim();
    if (!nextTitle) {
      throw new Error("Session title is required.");
    }
    if (state.session.providerSessionId) {
      this.services.workbenchState?.setSessionTitleOverride(
        {
          provider: "gemini",
          providerSessionId: state.session.providerSessionId,
        },
        nextTitle,
      );
    } else {
      this.services.workbenchState?.setPendingSessionTitleOverride(sessionId, nextTitle);
    }
    const nextState = this.services.sessionStore.patchManagedSession(sessionId, {
      title: nextTitle,
    });
    return toSessionSummary(nextState);
  }

  setSessionMode(sessionId: string, modeId: string): SessionSummary {
    if (!isGeminiModeId(modeId)) {
      throw new Error(`Unsupported Gemini mode '${modeId}'.`);
    }
    const live = this.liveSessions.get(sessionId);
    if (!live) {
      throw new Error("Gemini mode switching is only available for live sessions.");
    }
    live.approvalMode = modeId;
    const nextState = this.services.sessionStore.patchManagedSession(sessionId, {
      mode: buildGeminiModeState({
        currentModeId: live.approvalMode,
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

  async getProviderDiagnostic(options?: { forceRefresh?: boolean }) {
    return probeProviderDiagnostic("gemini", await geminiLaunchSpec(), options);
  }

  async shutdown(): Promise<void> {
    const sessions = [...this.liveSessions.values()];
    this.liveSessions.clear();
    const results = await Promise.allSettled(
      sessions.map((live) => closeGeminiLiveSession(live)),
    );
    results.forEach((result, index) => {
      if (result.status === "rejected") {
        console.error("[rah] failed to close Gemini live session during shutdown", {
          sessionId: sessions[index]?.sessionId,
          error: result.reason,
        });
      }
    });
  }

}

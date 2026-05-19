import type {
  ResumeSessionRequest,
  ResumeSessionResponse,
  SessionHistoryPageResponse,
  StoredSessionRef,
} from "@rah/runtime-protocol";
import {
  createGeminiStoredSessionFrozenHistoryPageLoader,
  discoverGeminiStoredSessions,
  findGeminiStoredSessionRecord,
  getGeminiStoredSessionHistoryPage,
  resolveGeminiStoredSessionWatchRoots,
  resumeGeminiStoredSession,
  type GeminiStoredSessionRecord,
} from "./gemini-session-files";
import type {
  ProviderAdapter,
  ProviderStoredHistoryAdapter,
  RuntimeServices,
} from "./provider-adapter";
import {
  finalizeStoredReplayResume,
  prepareProviderSessionResume,
} from "./provider-resume";
import { movePathToTrash } from "./trash";

export class GeminiStoredHistoryAdapter implements ProviderAdapter, ProviderStoredHistoryAdapter {
  readonly id = "gemini-stored-history";
  readonly providers: Array<"gemini"> = ["gemini"];

  private storedSessionIndex = new Map<string, GeminiStoredSessionRecord>();
  private readonly rehydratedSessionIds = new Set<string>();

  constructor(private readonly services: RuntimeServices) {}

  resumeStoredSession(request: ResumeSessionRequest): ResumeSessionResponse {
    const preparedResume = prepareProviderSessionResume({
      services: this.services,
      provider: "gemini",
      providerSessionId: request.providerSessionId,
      preferStoredReplay: true,
      rehydratedSessionIds: this.rehydratedSessionIds,
    });
    const record =
      this.storedSessionIndex.get(request.providerSessionId) ??
      this.refreshStoredSessionIndex().get(request.providerSessionId) ??
      findGeminiStoredSessionRecord(request.providerSessionId, request.cwd);
    if (!record) {
      throw new Error(`Unknown Gemini session ${request.providerSessionId}.`);
    }
    try {
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
    } catch (error) {
      preparedResume.rollback();
      throw error;
    }
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
      findGeminiStoredSessionRecord(state.session.providerSessionId, state.session.cwd);
    if (!record) {
      return undefined;
    }
    return createGeminiStoredSessionFrozenHistoryPageLoader({ sessionId, record });
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

  private refreshStoredSessionIndex(): Map<string, GeminiStoredSessionRecord> {
    const nextIndex = new Map<string, GeminiStoredSessionRecord>();
    for (const record of discoverGeminiStoredSessions()) {
      if (!nextIndex.has(record.ref.providerSessionId)) {
        nextIndex.set(record.ref.providerSessionId, record);
      }
    }
    this.storedSessionIndex = nextIndex;
    return this.storedSessionIndex;
  }
}

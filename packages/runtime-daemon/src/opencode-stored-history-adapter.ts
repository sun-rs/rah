import type {
  ResumeSessionRequest,
  ResumeSessionResponse,
  SessionHistoryPageResponse,
  StoredSessionRef,
} from "@rah/runtime-protocol";
import type {
  ProviderAdapter,
  ProviderStoredHistoryAdapter,
  RuntimeServices,
} from "./provider-adapter";
import {
  archiveOpenCodeStoredSession,
  createOpenCodeStoredSessionFrozenHistoryPageLoader,
  discoverOpenCodeStoredSessions,
  findOpenCodeStoredSessionRecord,
  getOpenCodeStoredSessionHistoryPage,
  OpenCodeSqliteReadError,
  resolveOpenCodeStoredSessionWatchRoots,
  resumeOpenCodeStoredSession,
  type OpenCodeStoredSessionRecord,
} from "./opencode-stored-sessions";
import {
  finalizeStoredReplayResume,
  prepareProviderSessionResume,
} from "./provider-resume";

export class OpenCodeStoredHistoryAdapter implements ProviderAdapter, ProviderStoredHistoryAdapter {
  readonly id = "opencode-stored-history";
  readonly providers: Array<"opencode"> = ["opencode"];

  private storedSessionIndex = new Map<string, OpenCodeStoredSessionRecord>();
  private readonly rehydratedSessionIds = new Set<string>();

  constructor(private readonly services: RuntimeServices) {}

  resumeStoredSession(request: ResumeSessionRequest): ResumeSessionResponse {
    const preparedResume = prepareProviderSessionResume({
      services: this.services,
      provider: "opencode",
      providerSessionId: request.providerSessionId,
      preferStoredReplay: true,
      rehydratedSessionIds: this.rehydratedSessionIds,
    });
    const record =
      this.storedSessionIndex.get(request.providerSessionId) ??
      this.refreshStoredSessionIndex().get(request.providerSessionId) ??
      findOpenCodeStoredSessionRecord(request.providerSessionId);
    if (!record) {
      throw new Error(`Unknown OpenCode session ${request.providerSessionId}.`);
    }
    try {
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
    } catch (error) {
      preparedResume.rollback();
      throw error;
    }
  }

  getSessionHistoryPage(
    sessionId: string,
    options?: { beforeTs?: string; cursor?: string; limit?: number },
  ): SessionHistoryPageResponse {
    void options?.cursor;
    const record = this.findRecordForRuntimeSession(sessionId);
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

  createFrozenHistoryPageLoader(sessionId: string) {
    const record = this.findRecordForRuntimeSession(sessionId);
    if (!record) {
      return undefined;
    }
    return createOpenCodeStoredSessionFrozenHistoryPageLoader({
      sessionId,
      record,
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

  private findRecordForRuntimeSession(sessionId: string): OpenCodeStoredSessionRecord | undefined {
    const state = this.services.sessionStore.getSession(sessionId);
    const providerSessionId = state?.session.providerSessionId;
    if (!providerSessionId) {
      return undefined;
    }
    return (
      this.storedSessionIndex.get(providerSessionId) ??
      this.refreshStoredSessionIndex().get(providerSessionId) ??
      findOpenCodeStoredSessionRecord(providerSessionId)
    ) ?? undefined;
  }

  private refreshStoredSessionIndex(): Map<string, OpenCodeStoredSessionRecord> {
    try {
      this.storedSessionIndex = new Map(
        discoverOpenCodeStoredSessions({ throwOnReadError: true }).map((record) => [
          record.ref.providerSessionId,
          record,
        ]),
      );
    } catch (error) {
      if (error instanceof OpenCodeSqliteReadError) {
        console.warn(
          `[rah] OpenCode history refresh failed; keeping ${this.storedSessionIndex.size} cached session(s). ${error.message}`,
        );
        return this.storedSessionIndex;
      }
      throw error;
    }
    return this.storedSessionIndex;
  }
}

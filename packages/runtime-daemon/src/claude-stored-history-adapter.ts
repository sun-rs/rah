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
  createClaudeStoredSessionFrozenHistoryPageLoader,
  type ClaudeStoredSessionRecord,
  discoverClaudeStoredSessions,
  findClaudeStoredSessionRecord,
  getClaudeStoredSessionHistoryPage,
  resolveClaudeStoredSessionWatchRoots,
  resumeClaudeStoredSession,
  waitForClaudeStoredSessionRecord,
} from "./claude-session-files";
import {
  finalizeStoredReplayResume,
  prepareProviderSessionResume,
} from "./provider-resume";
import { movePathToTrash } from "./trash";

export class ClaudeStoredHistoryAdapter implements ProviderAdapter, ProviderStoredHistoryAdapter {
  readonly id = "claude-stored-history";
  readonly providers: Array<"claude"> = ["claude"];

  private storedSessionIndex = new Map<string, ClaudeStoredSessionRecord>();
  private readonly rehydratedSessionIds = new Set<string>();

  constructor(private readonly services: RuntimeServices) {}

  async resumeStoredSession(request: ResumeSessionRequest): Promise<ResumeSessionResponse> {
    const preparedResume = prepareProviderSessionResume({
      services: this.services,
      provider: "claude",
      providerSessionId: request.providerSessionId,
      preferStoredReplay: true,
      rehydratedSessionIds: this.rehydratedSessionIds,
    });
    let record = findClaudeStoredSessionRecord(request.providerSessionId, request.cwd);
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
    try {
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

  private refreshStoredSessionIndex(): Map<string, ClaudeStoredSessionRecord> {
    this.storedSessionIndex = new Map(
      discoverClaudeStoredSessions().map((record) => [record.ref.providerSessionId, record] as const),
    );
    return this.storedSessionIndex;
  }
}

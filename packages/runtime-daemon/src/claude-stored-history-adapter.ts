import type {
  ResumeSessionRequest,
  ResumeSessionResponse,
  ConversationEvidencePage,
  StoredSessionRef,
} from "@rah/runtime-protocol";
import { stat } from "node:fs/promises";
import type {
  ProviderAdapter,
  ProviderShutdownAdapter,
  ProviderStoredHistoryAdapter,
  RuntimeServices,
} from "./provider-adapter";
import type { StoredSessionCatalogRecord } from "./stored-session-catalog-types";
import {
  createClaudeStoredSessionFrozenHistoryPageLoader,
  type ClaudeStoredSessionRecord,
  getClaudeStoredSessionHistoryPage,
  resolveClaudeStoredSessionWatchRoots,
  resumeClaudeStoredSession,
} from "./claude-session-files";
import { ClaudeHistoryPageStore } from "./claude-history-page-store";
import {
  finalizeStoredReplayResume,
  prepareProviderSessionResume,
} from "./provider-resume";
import { movePathToTrash } from "./trash";
import { ClaudeSessionArchiveStore } from "./claude-session-archive";

export class ClaudeStoredHistoryAdapter
  implements ProviderAdapter, ProviderStoredHistoryAdapter, ProviderShutdownAdapter
{
  readonly id = "claude-stored-history";
  readonly providers: Array<"claude"> = ["claude"];
  readonly storedSessionArchiveBackend = "rah_snapshot" as const;

  private storedSessionIndex = new Map<string, ClaudeStoredSessionRecord>();
  private readonly rehydratedSessionIds = new Set<string>();
  private readonly archiveStore = new ClaudeSessionArchiveStore();
  private readonly historyPages = new ClaudeHistoryPageStore();

  constructor(private readonly services: RuntimeServices) {}

  async resumeStoredSession(request: ResumeSessionRequest): Promise<ResumeSessionResponse> {
    const preparedResume = prepareProviderSessionResume({
      services: this.services,
      provider: "claude",
      providerSessionId: request.providerSessionId,
      preferStoredReplay: true,
      rehydratedSessionIds: this.rehydratedSessionIds,
    });
    const record = this.storedSessionIndex.get(request.providerSessionId);
    if (!record) {
      throw new Error(
        `Claude session ${request.providerSessionId} is not present in the hydrated history catalog.`,
      );
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

  getConversationEvidencePage(
    sessionId: string,
    options?: { beforeTs?: string; cursor?: string; limit?: number },
  ): ConversationEvidencePage {
    const record = this.indexedRecordForRuntimeSession(sessionId);
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

  async getConversationSummaryEvidencePage(
    sessionId: string,
    options: { cursor?: string; limit?: number } = {},
  ): Promise<ConversationEvidencePage> {
    const record = this.indexedRecordForRuntimeSession(sessionId);
    if (!record) {
      return {
        sessionId,
        events: [],
        detailMode: "summary",
        approximateBytes: 0,
      };
    }
    return this.historyPages.getSummaryPage({
      sessionId,
      record,
      ...(options.cursor ? { cursor: options.cursor } : {}),
      limit: Math.max(1, Math.min(options.limit ?? 20, 100)),
    });
  }

  async getSessionConversationSourceRevision(
    sessionId: string,
  ): Promise<string | undefined> {
    const record = this.indexedRecordForRuntimeSession(sessionId);
    if (!record) {
      return undefined;
    }
    try {
      const source = await stat(record.filePath);
      return `${Math.trunc(source.mtimeMs)}:${source.size}`;
    } catch {
      return undefined;
    }
  }

  createFrozenHistoryPageLoader(sessionId: string) {
    const record = this.indexedRecordForRuntimeSession(sessionId);
    if (!record) {
      return undefined;
    }
    return createClaudeStoredSessionFrozenHistoryPageLoader({
      sessionId,
      record,
    });
  }

  listStoredSessions(): StoredSessionRef[] {
    return [...this.storedSessionIndex.values()].map((record) => record.ref);
  }

  hydrateStoredSessionsCatalog(records: readonly StoredSessionCatalogRecord[]): void {
    this.storedSessionIndex = new Map(
      records
        .filter((record) => record.ref.provider === "claude")
        .map((record) => [
          record.ref.providerSessionId,
          { ref: record.ref, filePath: record.storagePath },
        ] as const),
    );
  }

  listStoredSessionWatchRoots(): string[] {
    return resolveClaudeStoredSessionWatchRoots();
  }

  async archiveStoredSession(session: StoredSessionRef): Promise<"rah_snapshot"> {
    const record = this.storedSessionIndex.get(session.providerSessionId);
    if (!record) {
      throw new Error(`Could not find a stored Claude history file for ${session.providerSessionId}.`);
    }
    await this.archiveStore.archive(record);
    this.storedSessionIndex.delete(session.providerSessionId);
    return "rah_snapshot";
  }

  async restoreStoredSession(session: StoredSessionRef): Promise<void> {
    const archived = this.archiveStore.find(session.providerSessionId);
    const restoredPath = await this.archiveStore.restore(session.providerSessionId);
    const restoredRef = archived?.snapshot ?? session;
    const { libraryState: _libraryState, ...ref } = restoredRef;
    void _libraryState;
    this.storedSessionIndex.set(session.providerSessionId, {
      ref,
      filePath: restoredPath,
    });
  }

  async removeStoredSession(session: StoredSessionRef): Promise<void> {
    if (await this.archiveStore.removeArchived(session.providerSessionId)) {
      this.storedSessionIndex.delete(session.providerSessionId);
      return;
    }
    const record = this.storedSessionIndex.get(session.providerSessionId);
    if (!record) {
      throw new Error(`Could not find a stored Claude history file for ${session.providerSessionId}.`);
    }
    await movePathToTrash(record.filePath);
    this.storedSessionIndex.delete(session.providerSessionId);
  }

  async shutdown(): Promise<void> {
    await Promise.all([
      this.archiveStore.flush(),
      this.historyPages.shutdown(),
    ]);
  }

  /**
   * All adapter reads are index-only. Catalog discovery runs in the background
   * catalog child process; a missing row remains a miss on the daemon event
   * loop instead of becoming a synchronous ~/.claude traversal.
   */
  private indexedRecordForRuntimeSession(
    sessionId: string,
  ): ClaudeStoredSessionRecord | undefined {
    const state = this.services.sessionStore.getSession(sessionId);
    const providerSessionId = state?.session.providerSessionId;
    if (!providerSessionId) {
      return undefined;
    }
    return this.storedSessionIndex.get(providerSessionId);
  }
}

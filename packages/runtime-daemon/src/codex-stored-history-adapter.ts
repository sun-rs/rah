import type {
  ResumeSessionRequest,
  ResumeSessionResponse,
  ConversationEvidencePage,
  ConversationTurnDirectoryResponse,
  StoredSessionRef,
} from "@rah/runtime-protocol";
import { statSync } from "node:fs";
import { canFinalizeCodexStoredHistory } from "./codex-history-liveness";
import {
  createCodexStoredSessionFrozenHistoryPageLoader,
  discoverCodexStoredSessions,
  findCodexStoredSessionRecord,
  getCodexStoredSessionHistoryPage,
  resolveCodexStoredSessionWatchRoots,
  resumeCodexStoredSession,
  type CodexStoredSessionRecord,
} from "./codex-stored-sessions";
import type {
  ProviderAdapter,
  ProviderShutdownAdapter,
  ProviderStoredHistoryAdapter,
  RuntimeServices,
} from "./provider-adapter";
import type { StoredSessionCatalogRecord } from "./stored-session-catalog-types";
import {
  finalizeStoredReplayResume,
  prepareProviderSessionResume,
} from "./provider-resume";
import { movePathToTrash } from "./trash";
import { CodexTurnDirectoryStore } from "./codex-turn-directory";
import { CodexTurnPageCache } from "./codex-turn-page-cache";
import {
  readCodexConversationTurnDetail,
} from "./codex-turn-history";
import { createCodexAppServerClient } from "./codex-app-server-client";
import type { CodexAppServerRpcClient } from "./codex-live-rpc";
import {
  materializeCodexAppServerTurnsPage,
  materializeCodexAppServerItemDetail,
  materializeCodexAppServerTurnItems,
  type CodexAppServerItemsPage,
  type CodexAppServerTurnsPage,
  reconcileCodexTrailingTurnLiveness,
} from "./codex-app-server-turns-page";

function isUnsupportedExperimentalListError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /method not found|unknown method|not supported|experimental api/i.test(message);
}

function isBrokenPagingTransport(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /timed out|closed|exited|ECONN|socket|websocket/i.test(message);
}

const DEFAULT_INDEXED_SUMMARY_THRESHOLD_BYTES = 64 * 1024 * 1024;

type CodexStoredHistoryOptions = {
  indexedSummaryThresholdBytes?: number;
};

export class CodexStoredHistoryAdapter
  implements ProviderAdapter, ProviderStoredHistoryAdapter, ProviderShutdownAdapter
{
  readonly id = "codex-stored-history";
  readonly providers: Array<"codex"> = ["codex"];

  private storedSessionIndex = new Map<string, CodexStoredSessionRecord>();
  private readonly rehydratedSessionIds = new Set<string>();
  private readonly turnDirectories = new CodexTurnDirectoryStore();
  private readonly turnPages = new CodexTurnPageCache();
  private turnsListSupport: "unknown" | "available" | "unavailable" = "unknown";
  private itemsListSupport: "unknown" | "available" | "unavailable" = "unknown";
  private pagingClient: CodexAppServerRpcClient | undefined;
  private pagingClientPromise: Promise<CodexAppServerRpcClient> | undefined;

  constructor(
    private readonly services: RuntimeServices,
    private readonly createPagingClient: () => Promise<CodexAppServerRpcClient> = createCodexAppServerClient,
    private readonly options: CodexStoredHistoryOptions = {},
  ) {}

  resumeStoredSession(request: ResumeSessionRequest): ResumeSessionResponse {
    const preparedResume = prepareProviderSessionResume({
      services: this.services,
      provider: "codex",
      providerSessionId: request.providerSessionId,
      preferStoredReplay: true,
      rehydratedSessionIds: this.rehydratedSessionIds,
    });
    const record =
      this.storedSessionIndex.get(request.providerSessionId) ??
      this.refreshStoredSessionIndex().get(request.providerSessionId) ??
      findCodexStoredSessionRecord(request.providerSessionId);
    if (!record) {
      throw new Error(`Unknown Codex session ${request.providerSessionId}.`);
    }
    try {
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
    } catch (error) {
      preparedResume.rollback();
      throw error;
    }
  }

  getConversationEvidencePage(
    sessionId: string,
    options: { beforeTs?: string; cursor?: string; limit?: number } = {},
  ): ConversationEvidencePage {
    const record = this.findRecordForRuntimeSession(sessionId);
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

  async getConversationSummaryEvidencePage(
    sessionId: string,
    options: { cursor?: string; limit?: number } = {},
  ): Promise<ConversationEvidencePage | undefined> {
    const record = this.findRecordForRuntimeSession(sessionId);
    if (!record) {
      return undefined;
    }
    const limit = Math.max(1, Math.min(options.limit ?? 20, 100));
    const sourceSettled = this.canFinalizeStoredHistory(record);
    const indexedThreshold = Math.max(
      0,
      this.options.indexedSummaryThresholdBytes ?? DEFAULT_INDEXED_SUMMARY_THRESHOLD_BYTES,
    );
    const useIndexedSummary =
      this.turnsListSupport === "unavailable" ||
      statSync(record.rolloutPath).size >= indexedThreshold;
    if (useIndexedSummary) {
      return this.materializeIndexedSummaryPage(sessionId, record, {
        ...(options.cursor ? { cursor: options.cursor } : {}),
        limit,
        sourceSettled,
      });
    }
    try {
      const page = await this.turnPages.getOrLoad({
        providerSessionId: record.ref.providerSessionId,
        rolloutPath: record.rolloutPath,
        ...(options.cursor ? { cursor: options.cursor } : {}),
        limit,
        sourceSettled,
        load: async (revision) => {
          const client = await this.getPagingClient();
          const raw = (await client.request(
            "thread/turns/list",
            {
              threadId: record.ref.providerSessionId,
              ...(options.cursor ? { cursor: options.cursor } : {}),
              limit,
              sortDirection: "desc",
              itemsView: "summary",
            },
            8_000,
          )) as CodexAppServerTurnsPage;
          if (!Array.isArray(raw?.data)) {
            throw new Error("Codex thread/turns/list returned an invalid page.");
          }
          this.turnsListSupport = "available";
          return reconcileCodexTrailingTurnLiveness(raw, {
            latestPage: !options.cursor,
            sourceSettled,
            fallbackCompletedAtMs: revision.mtimeMs,
          });
        },
      });
      return materializeCodexAppServerTurnsPage({
        sessionId,
        providerSessionId: record.ref.providerSessionId,
        page,
      });
    } catch (error) {
      if (isUnsupportedExperimentalListError(error)) {
        this.turnsListSupport = "unavailable";
        console.warn("[rah] Codex native turn paging is unavailable; using indexed persisted history", {
          providerSessionId: record.ref.providerSessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      } else {
        console.warn("[rah] Codex native turn paging failed; using indexed persisted history", {
          providerSessionId: record.ref.providerSessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      if (isBrokenPagingTransport(error)) {
        await this.resetPagingClient();
      }
      return this.materializeIndexedSummaryPage(sessionId, record, {
        ...(options.cursor ? { cursor: options.cursor } : {}),
        limit,
        sourceSettled,
      });
    }
  }

  private async materializeIndexedSummaryPage(
    sessionId: string,
    record: CodexStoredSessionRecord,
    options: { cursor?: string; limit: number; sourceSettled: boolean },
  ): Promise<ConversationEvidencePage> {
    const page = await this.turnDirectories.getSummaryPage(record, options);
    return materializeCodexAppServerTurnsPage({
      sessionId,
      providerSessionId: record.ref.providerSessionId,
      page,
    });
  }

  async getSessionConversationItemDetail(
    sessionId: string,
    options: { providerTurnId: string; providerItemId: string },
  ): Promise<ConversationEvidencePage | undefined> {
    const record = this.findRecordForRuntimeSession(sessionId);
    if (!record) {
      return undefined;
    }
    const items = await this.listNativeTurnItems(
      record,
      options.providerTurnId,
      options.providerItemId,
    );
    const item = items?.find(
      (candidate) =>
        candidate !== null &&
        typeof candidate === "object" &&
        !Array.isArray(candidate) &&
        (candidate as Record<string, unknown>).id === options.providerItemId,
    );
    if (item === undefined) {
      return undefined;
    }
    return materializeCodexAppServerItemDetail({
      sessionId,
      providerSessionId: record.ref.providerSessionId,
      providerTurnId: options.providerTurnId,
      item,
    });
  }

  async getSessionConversationTurnDetail(
    sessionId: string,
    options: { providerTurnId: string },
  ): Promise<ConversationEvidencePage | undefined> {
    const record = this.findRecordForRuntimeSession(sessionId);
    if (!record) {
      return undefined;
    }
    const nativeItems = await this.listNativeTurnItems(record, options.providerTurnId);
    if (nativeItems !== undefined) {
      return materializeCodexAppServerTurnItems({
        sessionId,
        providerSessionId: record.ref.providerSessionId,
        providerTurnId: options.providerTurnId,
        items: nativeItems,
      });
    }
    const range = await this.turnDirectories.getTurnRange(record, options.providerTurnId);
    if (!range) {
      return undefined;
    }
    return await readCodexConversationTurnDetail({
      sessionId,
      turnId: options.providerTurnId,
      record,
      range,
    });
  }

  createFrozenHistoryPageLoader(sessionId: string) {
    const record = this.findRecordForRuntimeSession(sessionId);
    if (!record) {
      return undefined;
    }
    return createCodexStoredSessionFrozenHistoryPageLoader({
      sessionId,
      record,
      finalizeUnterminatedTools: this.canFinalizeStoredHistory(record),
    });
  }

  async getSessionConversationDirectory(sessionId: string): Promise<ConversationTurnDirectoryResponse> {
    const record = this.findRecordForRuntimeSession(sessionId);
    if (!record) {
      return {
        sessionId,
        revision: "unavailable",
        items: [],
        complete: false,
        generatedAt: new Date().toISOString(),
      };
    }
    return this.turnDirectories.getDirectory(sessionId, record);
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

  hydrateStoredSessionsCatalog(records: readonly StoredSessionCatalogRecord[]): void {
    this.storedSessionIndex = new Map(
      records
        .filter((record) => record.ref.provider === "codex")
        .map((record) => [
          record.ref.providerSessionId,
          {
            ref: record.ref,
            rolloutPath: record.storagePath,
            archived: record.archived ?? record.ref.providerState?.archived === true,
          },
        ] as const),
    );
  }

  listStoredSessionWatchRoots(): string[] {
    return resolveCodexStoredSessionWatchRoots();
  }

  async archiveStoredSession(session: StoredSessionRef): Promise<void> {
    const record =
      this.storedSessionIndex.get(session.providerSessionId) ??
      this.refreshStoredSessionIndex().get(session.providerSessionId);
    if (!record) {
      throw new Error(`Could not find a stored Codex history file for ${session.providerSessionId}.`);
    }
    if (record.archived) {
      return;
    }
    try {
      const client = await this.getPagingClient();
      await client.request(
        "thread/archive",
        { threadId: session.providerSessionId },
        8_000,
      );
    } catch (error) {
      if (isBrokenPagingTransport(error)) {
        await this.resetPagingClient();
      }
      throw error;
    }
    this.turnDirectories.clear(session.providerSessionId);
    this.turnPages.clear(session.providerSessionId);
    this.storedSessionIndex.set(session.providerSessionId, {
      ...record,
      archived: true,
      ref: {
        ...record.ref,
        providerState: {
          ...record.ref.providerState,
          archived: true,
          archivedAt: new Date().toISOString(),
        },
      },
    });
  }

  async removeStoredSession(session: StoredSessionRef): Promise<void> {
    const record =
      this.storedSessionIndex.get(session.providerSessionId) ??
      this.refreshStoredSessionIndex().get(session.providerSessionId);
    if (!record) {
      throw new Error(`Could not find a stored Codex history file for ${session.providerSessionId}.`);
    }
    await movePathToTrash(record.rolloutPath);
    this.turnDirectories.clear(session.providerSessionId);
    this.turnPages.clear(session.providerSessionId);
    this.storedSessionIndex.delete(session.providerSessionId);
  }

  async shutdown(): Promise<void> {
    await this.resetPagingClient();
    await this.turnDirectories.shutdown();
  }

  private async getPagingClient(): Promise<CodexAppServerRpcClient> {
    if (this.pagingClient) {
      return this.pagingClient;
    }
    this.pagingClientPromise ??= this.createPagingClient();
    try {
      this.pagingClient = await this.pagingClientPromise;
      return this.pagingClient;
    } finally {
      this.pagingClientPromise = undefined;
    }
  }

  private async resetPagingClient(): Promise<void> {
    const pendingClient = this.pagingClientPromise;
    const client =
      this.pagingClient ??
      (pendingClient ? await pendingClient.catch(() => undefined) : undefined);
    this.pagingClient = undefined;
    this.pagingClientPromise = undefined;
    await client?.dispose().catch(() => undefined);
  }

  private async listNativeTurnItems(
    record: CodexStoredSessionRecord,
    providerTurnId: string,
    stopAtItemId?: string,
  ): Promise<unknown[] | undefined> {
    if (this.itemsListSupport === "unavailable") {
      return undefined;
    }
    try {
      const client = await this.getPagingClient();
      const items: unknown[] = [];
      let cursor: string | undefined;
      const seenCursors = new Set<string>();
      for (let pageIndex = 0; pageIndex < 100; pageIndex += 1) {
        const raw = (await client.request(
          "thread/items/list",
          {
            threadId: record.ref.providerSessionId,
            turnId: providerTurnId,
            ...(cursor ? { cursor } : {}),
            limit: 100,
            sortDirection: "asc",
          },
          8_000,
        )) as CodexAppServerItemsPage;
        if (!Array.isArray(raw?.data)) {
          throw new Error("Codex thread/items/list returned an invalid page.");
        }
        this.itemsListSupport = "available";
        items.push(...raw.data);
        if (
          stopAtItemId &&
          raw.data.some(
            (candidate) =>
              candidate !== null &&
              typeof candidate === "object" &&
              !Array.isArray(candidate) &&
              (candidate as Record<string, unknown>).id === stopAtItemId,
          )
        ) {
          return items;
        }
        cursor = typeof raw.nextCursor === "string" && raw.nextCursor ? raw.nextCursor : undefined;
        if (!cursor) {
          return items;
        }
        if (seenCursors.has(cursor)) {
          throw new Error("Codex thread/items/list returned a repeated cursor.");
        }
        seenCursors.add(cursor);
      }
      throw new Error("Codex thread/items/list exceeded the paging limit.");
    } catch (error) {
      if (isUnsupportedExperimentalListError(error)) {
        this.itemsListSupport = "unavailable";
      }
      console.warn("[rah] Codex native item paging failed; using rollout fallback", {
        providerSessionId: record.ref.providerSessionId,
        providerTurnId,
        ...(stopAtItemId ? { providerItemId: stopAtItemId } : {}),
        error: error instanceof Error ? error.message : String(error),
      });
      if (isBrokenPagingTransport(error)) {
        await this.resetPagingClient();
      }
      return undefined;
    }
  }

  private findRecordForRuntimeSession(sessionId: string): CodexStoredSessionRecord | undefined {
    const state = this.services.sessionStore.getSession(sessionId);
    const providerSessionId = state?.session.providerSessionId;
    if (!providerSessionId) {
      return undefined;
    }
    return (
      this.storedSessionIndex.get(providerSessionId) ??
      this.refreshStoredSessionIndex().get(providerSessionId) ??
      findCodexStoredSessionRecord(providerSessionId)
    );
  }

  private canFinalizeStoredHistory(record: CodexStoredSessionRecord): boolean {
    return canFinalizeCodexStoredHistory({
      rolloutPath: record.rolloutPath,
      hasRahManagedWriter: this.hasRahManagedCodexWriter(record.ref.providerSessionId),
    });
  }

  private hasRahManagedCodexWriter(providerSessionId: string): boolean {
    const managed = this.services.sessionStore.findManagedByProviderSession(
      "codex",
      providerSessionId,
    );
    if (!managed) {
      return false;
    }
    return (
      managed.session.capabilities.steerInput ||
      managed.session.capabilities.queuedInput ||
      managed.session.capabilities.actions.stop
    );
  }

  private refreshStoredSessionIndex(): Map<string, CodexStoredSessionRecord> {
    this.storedSessionIndex = new Map(
      discoverCodexStoredSessions().map((record) => [record.ref.providerSessionId, record]),
    );
    return this.storedSessionIndex;
  }
}

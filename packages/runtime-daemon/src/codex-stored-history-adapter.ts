import type {
  ResumeSessionRequest,
  ResumeSessionResponse,
  ConversationEvidencePage,
  ConversationTurnDirectoryResponse,
  RahEvent,
  StoredSessionRef,
} from "@rah/runtime-protocol";
import { stat } from "node:fs/promises";
import { CodexHistoryLivenessTracker } from "./codex-history-liveness";
import {
  createCodexStoredSessionFrozenHistoryPageLoader,
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
  readCodexConversationItemDetail,
  readCodexConversationTurnFileDiff,
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
import { approximateJsonByteLength } from "./bounded-json-size";

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
  readonly storedSessionArchiveBackend = "provider_native" as const;

  private storedSessionIndex = new Map<string, CodexStoredSessionRecord>();
  private readonly rehydratedSessionIds = new Set<string>();
  private readonly providerSessionIdsByRuntimeSession = new Map<string, string>();
  private readonly turnDirectories = new CodexTurnDirectoryStore();
  private readonly turnPages = new CodexTurnPageCache();
  private readonly historyLiveness = new CodexHistoryLivenessTracker();
  private turnsListSupport: "unknown" | "available" | "unavailable" = "unknown";
  private itemsListSupport: "unknown" | "available" | "unavailable" = "unknown";
  private itemsListProbePromise:
    | Promise<"available" | "unavailable" | "failed">
    | undefined;
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
    const record = this.storedSessionIndex.get(request.providerSessionId);
    if (!record) {
      throw new Error(`Unknown Codex session ${request.providerSessionId}.`);
    }
    try {
      const resumed = finalizeStoredReplayResume({
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
      this.providerSessionIdsByRuntimeSession.set(
        resumed.session.session.id,
        request.providerSessionId,
      );
      return resumed;
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
      finalizeUnterminatedTools: this.peekCanFinalizeStoredHistory(record),
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
    const sourceSettled = await this.resolveCanFinalizeStoredHistory(record);
    const indexedThreshold = Math.max(
      0,
      this.options.indexedSummaryThresholdBytes ?? DEFAULT_INDEXED_SUMMARY_THRESHOLD_BYTES,
    );
    const useIndexedSummary =
      this.turnsListSupport === "unavailable" ||
      (await stat(record.rolloutPath)).size >= indexedThreshold;
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
      return await this.appendIndexedTurnFileChanges(
        record,
        materializeCodexAppServerTurnsPage({
          sessionId,
          providerSessionId: record.ref.providerSessionId,
          page,
        }),
        page.data.flatMap((turn) => {
          if (!turn || typeof turn !== "object" || Array.isArray(turn)) {
            return [];
          }
          const id = (turn as Record<string, unknown>).id;
          return typeof id === "string" ? [id] : [];
        }),
      );
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
    return await this.appendIndexedTurnFileChanges(
      record,
      materializeCodexAppServerTurnsPage({
        sessionId,
        providerSessionId: record.ref.providerSessionId,
        page,
      }),
      page.data.flatMap((turn) => {
        if (!turn || typeof turn !== "object" || Array.isArray(turn)) {
          return [];
        }
        const id = (turn as Record<string, unknown>).id;
        return typeof id === "string" ? [id] : [];
      }),
    );
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
    if (item !== undefined) {
      return materializeCodexAppServerItemDetail({
        sessionId,
        providerSessionId: record.ref.providerSessionId,
        providerTurnId: options.providerTurnId,
        item,
      });
    }

    // Code-mode custom calls use call_id as their canonical provider identity,
    // while native item paging may expose a different response-item id. Fall
    // back to the indexed turn range so the call and output remain joined for
    // the third-level result disclosure.
    const range = await this.turnDirectories.getTurnRange(record, options.providerTurnId);
    if (!range) {
      return undefined;
    }
    return readCodexConversationItemDetail({
      sessionId,
      turnId: options.providerTurnId,
      itemId: options.providerItemId,
      record,
      range,
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
      return await this.appendIndexedTurnFileChanges(
        record,
        materializeCodexAppServerTurnItems({
          sessionId,
          providerSessionId: record.ref.providerSessionId,
          providerTurnId: options.providerTurnId,
          items: nativeItems,
        }),
        [options.providerTurnId],
      );
    }
    const range = await this.turnDirectories.getTurnRange(record, options.providerTurnId);
    if (!range) {
      return undefined;
    }
    return await this.appendIndexedTurnFileChanges(
      record,
      await readCodexConversationTurnDetail({
        sessionId,
        turnId: options.providerTurnId,
        record,
        range,
      }),
      [options.providerTurnId],
    );
  }

  async getSessionConversationTurnFileDiff(
    sessionId: string,
    options: { providerTurnId: string; path: string },
  ) {
    const record = this.findRecordForRuntimeSession(sessionId);
    if (!record) {
      return undefined;
    }
    const range = await this.turnDirectories.getTurnRange(
      record,
      options.providerTurnId,
    );
    if (!range) {
      return undefined;
    }
    return await readCodexConversationTurnFileDiff({
      sessionId,
      turnId: options.providerTurnId,
      path: options.path,
      record,
      range,
    });
  }

  async getSessionConversationSourceRevision(
    sessionId: string,
  ): Promise<string | undefined> {
    const record = this.findRecordForRuntimeSession(sessionId);
    if (!record) {
      return undefined;
    }
    try {
      const source = await stat(record.rolloutPath);
      return `${Math.trunc(source.mtimeMs)}:${source.size}`;
    } catch {
      return undefined;
    }
  }

  private async appendIndexedTurnFileChanges(
    record: CodexStoredSessionRecord,
    page: ConversationEvidencePage,
    providerTurnIds: readonly string[],
  ): Promise<ConversationEvidencePage> {
    const summaries = await this.turnDirectories.getFileChangesByTurnIds(
      record,
      providerTurnIds,
    );
    if (summaries.size === 0) {
      return page;
    }
    let nextSeq = page.events.reduce(
      (maximum, event) => Math.max(maximum, event.seq),
      0,
    );
    const events = [...page.events];
    for (const providerTurnId of providerTurnIds) {
      const fileChanges = summaries.get(providerTurnId);
      if (!fileChanges) {
        continue;
      }
      const turnEvents = page.events.filter(
        (event) => event.turnId === providerTurnId,
      );
      const timestamp =
        [...turnEvents].reverse().find((event) => event.type === "turn.completed")
          ?.ts ??
        turnEvents.at(-1)?.ts ??
        "1970-01-01T00:00:00.000Z";
      events.push({
        id: `codex-turn-file-changes:${record.ref.providerSessionId}:${providerTurnId}`,
        seq: ++nextSeq,
        ts: timestamp,
        sessionId: page.sessionId,
        turnId: providerTurnId,
        type: "turn.file_changes.updated",
        source: {
          provider: "codex",
          channel: "structured_persisted",
          authority: "authoritative",
        },
        payload: { fileChanges },
      } satisfies RahEvent);
    }
    const response: ConversationEvidencePage = {
      ...page,
      events,
    };
    response.approximateBytes = approximateJsonByteLength(response);
    return response;
  }

  createFrozenHistoryPageLoader(sessionId: string) {
    const record = this.findRecordForRuntimeSession(sessionId);
    if (!record) {
      return undefined;
    }
    return createCodexStoredSessionFrozenHistoryPageLoader({
      sessionId,
      record,
      finalizeUnterminatedTools: this.peekCanFinalizeStoredHistory(record),
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
    return [...this.storedSessionIndex.values()].map((record) => record.ref);
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
    const record = this.storedSessionIndex.get(session.providerSessionId);
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
    await this.turnPages.clear(session.providerSessionId);
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

  async restoreStoredSession(session: StoredSessionRef): Promise<void> {
    const record = this.storedSessionIndex.get(session.providerSessionId);
    if (!record) {
      throw new Error(`Could not find a stored Codex history file for ${session.providerSessionId}.`);
    }
    if (!record.archived && record.ref.providerState?.archived !== true) {
      return;
    }
    try {
      const client = await this.getPagingClient();
      await client.request(
        "thread/unarchive",
        { threadId: session.providerSessionId },
        8_000,
      );
    } catch (error) {
      if (isBrokenPagingTransport(error)) {
        await this.resetPagingClient();
      }
      throw error;
    }
    const { archived: _archived, archivedAt: _archivedAt, ...remainingProviderState } =
      record.ref.providerState ?? {};
    void _archived;
    void _archivedAt;
    const { providerState: _providerState, ...remainingRef } = record.ref;
    void _providerState;
    this.storedSessionIndex.set(session.providerSessionId, {
      ...record,
      archived: false,
      ref: {
        ...remainingRef,
        ...(Object.keys(remainingProviderState).length > 0
          ? { providerState: remainingProviderState }
          : {}),
      },
    });
  }

  async removeStoredSession(session: StoredSessionRef): Promise<void> {
    const record = this.storedSessionIndex.get(session.providerSessionId);
    if (!record) {
      throw new Error(`Could not find a stored Codex history file for ${session.providerSessionId}.`);
    }
    await movePathToTrash(record.rolloutPath);
    this.turnDirectories.clear(session.providerSessionId);
    await this.turnPages.clear(session.providerSessionId);
    this.storedSessionIndex.delete(session.providerSessionId);
    for (const [runtimeSessionId, providerSessionId] of this.providerSessionIdsByRuntimeSession) {
      if (providerSessionId === session.providerSessionId) {
        this.providerSessionIdsByRuntimeSession.delete(runtimeSessionId);
      }
    }
  }

  async shutdown(): Promise<void> {
    this.providerSessionIdsByRuntimeSession.clear();
    this.historyLiveness.shutdown();
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
    if (
      (await this.ensureNativeItemsListSupport(record, providerTurnId)) !==
      "available"
    ) {
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

  private async ensureNativeItemsListSupport(
    record: CodexStoredSessionRecord,
    providerTurnId: string,
  ): Promise<"available" | "unavailable" | "failed"> {
    if (this.itemsListSupport !== "unknown") {
      return this.itemsListSupport;
    }
    this.itemsListProbePromise ??= (async () => {
      try {
        const client = await this.getPagingClient();
        const raw = (await client.request(
          "thread/items/list",
          {
            threadId: record.ref.providerSessionId,
            turnId: providerTurnId,
            limit: 1,
            sortDirection: "asc",
          },
          8_000,
        )) as CodexAppServerItemsPage;
        if (!Array.isArray(raw?.data)) {
          throw new Error("Codex thread/items/list returned an invalid capability probe.");
        }
        this.itemsListSupport = "available";
        return "available" as const;
      } catch (error) {
        if (isUnsupportedExperimentalListError(error)) {
          this.itemsListSupport = "unavailable";
          return "unavailable" as const;
        }
        console.warn("[rah] Codex native item paging capability probe failed", {
          providerSessionId: record.ref.providerSessionId,
          providerTurnId,
          error: error instanceof Error ? error.message : String(error),
        });
        if (isBrokenPagingTransport(error)) {
          await this.resetPagingClient();
        }
        return "failed" as const;
      }
    })();
    try {
      return await this.itemsListProbePromise;
    } finally {
      this.itemsListProbePromise = undefined;
    }
  }

  private findRecordForRuntimeSession(sessionId: string): CodexStoredSessionRecord | undefined {
    const state = this.services.sessionStore.getSession(sessionId);
    const providerSessionId =
      state?.session.providerSessionId ??
      this.providerSessionIdsByRuntimeSession.get(sessionId);
    if (!providerSessionId) {
      return undefined;
    }
    this.providerSessionIdsByRuntimeSession.set(sessionId, providerSessionId);
    // Conversation reads are latency-sensitive daemon request paths. Provider
    // discovery can traverse years of rollout files, so cache misses must stay
    // misses here. RuntimeEngine owns asynchronous catalog reconciliation and
    // hydrates this index before retrying explicit lifecycle operations.
    return this.storedSessionIndex.get(providerSessionId);
  }

  private peekCanFinalizeStoredHistory(record: CodexStoredSessionRecord): boolean {
    return this.historyLiveness.peekOrRefresh({
      rolloutPath: record.rolloutPath,
      hasRahManagedWriter: this.hasRahManagedCodexWriter(record.ref.providerSessionId),
    });
  }

  private resolveCanFinalizeStoredHistory(
    record: CodexStoredSessionRecord,
  ): Promise<boolean> {
    return this.historyLiveness.resolve({
      rolloutPath: record.rolloutPath,
      hasRahManagedWriter: this.hasRahManagedCodexWriter(
        record.ref.providerSessionId,
      ),
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
}

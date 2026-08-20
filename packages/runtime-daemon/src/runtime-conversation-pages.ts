import type {
  ConversationEvidenceDetailMode,
  ConversationEvidencePage,
  ConversationItemDetailResponse,
  ConversationItemProjection,
  ConversationResourceIndexResponse,
  ConversationTurnDetailResponse,
  ConversationTurnDirectoryResponse,
  ConversationTurnProjection,
  ConversationTurnsPageResponse,
  ManagedSession,
  RahEvent,
} from "@rah/runtime-protocol";
import { approximateJsonByteLength } from "./bounded-json-size";
import { ConversationPageHotCache } from "./conversation-page-hot-cache";
import type { ConversationProjectionStore } from "./conversation-projection-store";
import { ConversationResourceIndexStore } from "./conversation-resource-index";
import { summarizeConversationTurnsForTransport } from "./conversation-transport-summary";
import { buildConversationTurnDirectory } from "./conversation-turn-directory";
import { projectConversation } from "./conversation-projector";
import {
  chatHistoryPage,
  fullHistoryPage,
  historyEventMatchesItem,
  summarizeHistoryPage,
} from "./history-event-projection";
import type { EventBus } from "./event-bus";
import type { HistorySnapshotStore } from "./history-snapshots";
import type {
  ProcessOutputStore,
  StoredProcessOutput,
} from "./process-output-store";
import type { ProviderStoredHistoryAdapter } from "./provider-adapter";
import { shouldSuppressCouncilManagedHistoryEvent } from "./provider-activity";
import type { SessionStore } from "./session-store";
import type { TurnArtifactStore } from "./turn-artifact-store";
import { turnArtifactOwnerKey } from "./turn-artifact-store";

const MAX_MATERIALIZED_HISTORY_EVENTS = 5_000;

type RuntimeConversationPagesDeps = {
  sessionStore: SessionStore;
  conversationStore: ConversationProjectionStore;
  eventBus: EventBus;
  historySnapshots: HistorySnapshotStore;
  processOutputs: ProcessOutputStore;
  turnArtifacts: TurnArtifactStore;
  storedHistoryAdapterForSession(
    sessionId: string,
  ): ProviderStoredHistoryAdapter | undefined;
};

function filterCouncilManagedHistoryPage(
  session: ManagedSession | undefined,
  page: ConversationEvidencePage,
): ConversationEvidencePage {
  if (session?.origin?.kind !== "council") {
    return page;
  }
  return {
    ...page,
    events: page.events.filter(
      (event) => !shouldSuppressCouncilManagedHistoryEvent(event),
    ),
  };
}

/**
 * Owns provider-history paging and the resident-live overlay contract.
 *
 * Keeping this transaction outside RuntimeEngine prevents route orchestration,
 * provider lookup, frozen cursors, hot-cache revisions and artifact hydration
 * from becoming five independently evolving implementations.
 */
export class RuntimeConversationPages {
  private readonly hotPages = new ConversationPageHotCache();
  private readonly resourceIndexes = new ConversationResourceIndexStore();

  constructor(private readonly deps: RuntimeConversationPagesDeps) {}

  getEvidencePage(
    sessionId: string,
    options?: {
      beforeTs?: string;
      cursor?: string;
      limit?: number;
      detail?: ConversationEvidenceDetailMode;
    },
  ): ConversationEvidencePage {
    const adapter = this.deps.storedHistoryAdapterForSession(sessionId);
    if (!adapter?.getConversationEvidencePage) {
      return { sessionId, events: [] };
    }
    const session = this.deps.sessionStore.getSession(sessionId)?.session;
    const page = this.deps.historySnapshots.getPage({
      sessionId,
      ...(options?.cursor ? { cursor: options.cursor } : {}),
      ...(options?.limit ? { limit: options.limit } : {}),
      loadFrozenPage: () => adapter.createFrozenHistoryPageLoader?.(sessionId),
      loadEvents: () =>
        adapter.getConversationEvidencePage!(
          sessionId,
          options?.beforeTs
            ? {
                beforeTs: options.beforeTs,
                limit: MAX_MATERIALIZED_HISTORY_EVENTS,
              }
            : { limit: MAX_MATERIALIZED_HISTORY_EVENTS },
        ).events,
    });
    const filtered = filterCouncilManagedHistoryPage(session, page);
    if (options?.detail === "full") {
      return fullHistoryPage(filtered);
    }
    if (options?.detail === "chat") {
      return chatHistoryPage(filtered);
    }
    return summarizeHistoryPage(filtered);
  }

  async getTurns(
    sessionId: string,
    options?: { cursor?: string; limit?: number; liveOnly?: boolean },
  ): Promise<ConversationTurnsPageResponse> {
    const turnLimit = Math.max(1, Math.min(options?.limit ?? 20, 100));
    if (options?.liveOnly) {
      const resident = this.deps.conversationStore.snapshot(sessionId);
      const response: ConversationTurnsPageResponse = {
        ...resident,
        turns: summarizeConversationTurnsForTransport(
          resident.turns.slice(-turnLimit),
        ),
        liveRevision: resident.liveRevision,
      };
      response.approximateBytes = approximateJsonByteLength(response);
      return response;
    }

    const historyEventLimit = Math.min(500, Math.max(100, turnLimit * 40));
    const adapter = this.deps.storedHistoryAdapterForSession(sessionId);
    const liveRevisionAtRequest =
      this.deps.conversationStore.snapshot(sessionId).liveRevision;
    const sourceRevisionAtRequest =
      await adapter?.getSessionConversationSourceRevision?.(sessionId);
    const cacheAddress = {
      sessionId,
      ...(options?.cursor ? { cursor: options.cursor } : {}),
      limit: turnLimit,
    };
    if (sourceRevisionAtRequest) {
      const cached = this.hotPages.get(cacheAddress, {
        sourceRevision: sourceRevisionAtRequest,
        liveRevision: liveRevisionAtRequest,
      });
      if (cached) {
        return cached;
      }
    }

    const nativeTurnPage =
      await adapter?.getConversationSummaryEvidencePage?.(sessionId, {
        ...(options?.cursor ? { cursor: options.cursor } : {}),
        limit: turnLimit,
      });
    const historyPage =
      nativeTurnPage ??
      this.getEvidencePage(sessionId, {
        ...(options?.cursor ? { cursor: options.cursor } : {}),
        limit: historyEventLimit,
        detail: "summary",
      });
    const session = this.deps.sessionStore.getSession(sessionId)?.session;
    const seenEventIds = new Set<string>();
    const events = historyPage.events
      .filter((event) => {
        if (event.turnId === undefined || seenEventIds.has(event.id)) {
          return false;
        }
        seenEventIds.add(event.id);
        return true;
      })
      .map((event, index) => ({ ...event, seq: index + 1 }) as RahEvent);
    const projectedHistory = projectConversation(sessionId, events, {
      assumeSettled:
        nativeTurnPage === undefined &&
        (session?.status === "stopped" ||
          session?.runtime?.kind === "stored_history"),
      partial: Boolean(historyPage.nextCursor ?? historyPage.nextBeforeTs),
    });
    const projection = nativeTurnPage
      ? {
          ...projectedHistory,
          turns: projectedHistory.turns.map((turn) => ({
            ...turn,
            itemsView: "summary" as const,
            ...(turn.providerTurnId !== undefined &&
            historyPage.turnProcessDetailsAvailable?.[turn.providerTurnId] !==
              undefined
              ? {
                  processDetailsAvailable:
                    historyPage.turnProcessDetailsAvailable[
                      turn.providerTurnId
                    ],
                }
              : {}),
          })),
        }
      : projectedHistory;

    // Provider paging can await I/O. Capture resident state only afterwards so
    // the returned live revision and overlay are one atomic observation.
    const liveSnapshot = options?.cursor
      ? {
          ...projection,
          liveRevision:
            this.deps.conversationStore.snapshot(sessionId).liveRevision,
        }
      : this.deps.conversationStore.overlayLiveSnapshot(projection);
    const { liveRevision, ...responseProjection } = liveSnapshot;
    const pageTurns = await this.restorePersistedTurnFileChanges(
      sessionId,
      nativeTurnPage
        ? responseProjection.turns
        : responseProjection.turns.slice(-turnLimit),
    );
    const responseSourceRevision =
      sourceRevisionAtRequest ?? historyPage.sourceRevision;
    const response: ConversationTurnsPageResponse = {
      ...responseProjection,
      liveRevision,
      ...(responseSourceRevision
        ? { sourceRevision: responseSourceRevision }
        : {}),
      turns: summarizeConversationTurnsForTransport(pageTurns),
      ...(historyPage.nextCursor || historyPage.nextBeforeTs
        ? { nextCursor: historyPage.nextCursor ?? historyPage.nextBeforeTs }
        : {}),
    };
    response.approximateBytes = approximateJsonByteLength(response);
    if (response.sourceRevision) {
      this.hotPages.set(
        cacheAddress,
        { sourceRevision: response.sourceRevision, liveRevision },
        response,
      );
    }
    return response;
  }

  async getSourceRevision(sessionId: string) {
    const sourceRevision =
      await this.deps
        .storedHistoryAdapterForSession(sessionId)
        ?.getSessionConversationSourceRevision?.(sessionId);
    return { sessionId, sourceRevision: sourceRevision ?? null };
  }

  async getVisualArtifact(sessionId: string, artifactId: string) {
    const artifact = await this.deps
      .storedHistoryAdapterForSession(sessionId)
      ?.getSessionConversationVisualArtifact?.(sessionId, artifactId);
    if (!artifact) {
      throw new Error(
        `Unknown conversation visual artifact ${artifactId} for session ${sessionId}.`,
      );
    }
    return artifact;
  }

  async getVisualArtifactSource(sessionId: string, artifactId: string) {
    const source = await this.deps
      .storedHistoryAdapterForSession(sessionId)
      ?.getSessionConversationVisualArtifactSource?.(sessionId, artifactId);
    return {
      sessionId,
      artifactId,
      path: source?.path ?? null,
    };
  }

  async getTurnDetail(
    sessionId: string,
    options: { turnId: string; providerTurnId: string },
  ): Promise<ConversationTurnDetailResponse | undefined> {
    const nativePage = await this.deps
      .storedHistoryAdapterForSession(sessionId)
      ?.getSessionConversationTurnDetail?.(sessionId, {
        providerTurnId: options.providerTurnId,
      });
    if (!nativePage) {
      return undefined;
    }
    const projection = projectConversation(
      sessionId,
      nativePage.events
        .filter((event) => event.turnId !== undefined)
        .map((event, index) => ({ ...event, seq: index + 1 }) as RahEvent),
      { assumeSettled: true, partial: true },
    );
    const projectedTurn = projection.turns.find(
      (candidate) => candidate.providerTurnId === options.providerTurnId,
    );
    if (!projectedTurn) {
      return undefined;
    }
    const [turn] = await this.restorePersistedTurnFileChanges(sessionId, [
      {
        ...projectedTurn,
        id: options.turnId,
        itemsView: "full" as const,
        items: projectedTurn.items.map((item) => ({
          ...item,
          turnId: options.turnId,
        })),
      },
    ]);
    if (!turn) {
      return undefined;
    }
    const response: ConversationTurnDetailResponse = {
      sessionId,
      turnId: options.turnId,
      turn,
    };
    response.approximateBytes = approximateJsonByteLength(response);
    return response;
  }

  async getResourceIndex(
    sessionId: string,
    options?: { refresh?: boolean },
  ): Promise<ConversationResourceIndexResponse> {
    const adapter = this.deps.storedHistoryAdapterForSession(sessionId);
    const historyRevision =
      (await adapter?.getSessionConversationSourceRevision?.(sessionId)) ??
      adapter?.createFrozenHistoryPageLoader?.(sessionId)?.boundary
        ?.sourceRevision;
    const state = this.deps.sessionStore.getSession(sessionId);
    const liveRevision =
      this.deps.conversationStore.snapshot(sessionId).liveRevision;
    const sourceRevision = JSON.stringify({
      history: historyRevision ?? null,
      providerSessionId: state?.session.providerSessionId ?? null,
      liveRevision,
      status: state?.session.status ?? null,
      fallbackActivity:
        historyRevision === undefined
          ? state?.conversationActivityAt ??
            state?.session.updatedAt ??
            sessionId
          : null,
    });
    return this.resourceIndexes.load({
      sessionId,
      sourceRevision,
      progressive: true,
      ...(options?.refresh ? { refresh: true } : {}),
      readTurns: (cursor) =>
        this.getTurns(sessionId, {
          ...(cursor ? { cursor } : {}),
          limit: 100,
        }),
      readTurnDetail: (turn) =>
        turn.providerTurnId
          ? this.getTurnDetail(sessionId, {
              turnId: turn.id,
              providerTurnId: turn.providerTurnId,
            })
          : Promise.resolve(undefined),
    });
  }

  async getItemDetail(
    sessionId: string,
    options: {
      itemId: string;
      turnId?: string;
      providerTurnId: string;
      providerItemId: string;
    },
  ): Promise<ConversationItemDetailResponse | undefined> {
    const nativePage = await this.deps
      .storedHistoryAdapterForSession(sessionId)
      ?.getSessionConversationItemDetail?.(sessionId, {
        providerTurnId: options.providerTurnId,
        providerItemId: options.providerItemId,
      });
    const page =
      nativePage ??
      (() => {
        const eventsById = new Map<string, RahEvent>();
        for (const kind of ["tool_call", "observation"] as const) {
          for (const event of this.getHistoryItemDetail(sessionId, {
            kind,
            itemId: options.providerItemId,
          }).events) {
            eventsById.set(event.id, event);
          }
        }
        return eventsById.size > 0
          ? { sessionId, events: [...eventsById.values()] }
          : undefined;
      })();
    if (!page) {
      return undefined;
    }
    const projection = projectConversation(
      sessionId,
      page.events
        .filter((event) => event.turnId !== undefined)
        .map((event, index) => ({ ...event, seq: index + 1 }) as RahEvent),
      { partial: true },
    );
    const turn = projection.turns.find(
      (candidate) => candidate.providerTurnId === options.providerTurnId,
    );
    const item = turn?.items.find(
      (candidate) =>
        candidate.id === options.itemId ||
        candidate.providerItemId === options.providerItemId,
    );
    if (!turn || !item) {
      return undefined;
    }
    const turnId = options.turnId ?? turn.id;
    const storedProcessOutput = await this.deps.processOutputs.read(
      sessionId,
      options.providerItemId,
    );
    const hydratedItem = storedProcessOutput
      ? this.hydrateProcessOutput(item, storedProcessOutput)
      : item;
    const response: ConversationItemDetailResponse = {
      sessionId,
      turnId,
      itemId: options.itemId,
      item: { ...hydratedItem, id: options.itemId, turnId },
    };
    response.approximateBytes = approximateJsonByteLength(response);
    return response;
  }

  async getDirectory(
    sessionId: string,
  ): Promise<ConversationTurnDirectoryResponse> {
    const adapter = this.deps.storedHistoryAdapterForSession(sessionId);
    if (adapter?.getSessionConversationDirectory) {
      return adapter.getSessionConversationDirectory(sessionId);
    }
    return buildConversationTurnDirectory({
      sessionId,
      loadPage: (cursor) =>
        this.getTurns(sessionId, {
          ...(cursor ? { cursor } : {}),
          limit: 100,
        }),
    });
  }

  getHistoryItemDetail(
    sessionId: string,
    options: { kind: "tool_call" | "observation"; itemId: string },
  ) {
    const eventsById = new Map<string, RahEvent>();
    const matches = (event: RahEvent) =>
      historyEventMatchesItem(event, options.kind, options.itemId);
    for (const event of this.deps.historySnapshots.findCachedEvents(
      sessionId,
      matches,
    )) {
      eventsById.set(event.id, event);
    }
    for (const event of this.deps.eventBus.list({ sessionIds: [sessionId] })) {
      if (matches(event)) {
        eventsById.set(event.id, event);
      }
    }
    return {
      sessionId,
      kind: options.kind,
      itemId: options.itemId,
      events: [...eventsById.values()],
    };
  }

  invalidate(sessionId: string): void {
    this.resourceIndexes.invalidate(sessionId);
  }

  async flushPersistence(): Promise<void> {
    await this.resourceIndexes.flushPersistence();
  }

  async restorePersistedTurnFileChanges(
    sessionId: string,
    turns: readonly ConversationTurnProjection[],
  ): Promise<ConversationTurnProjection[]> {
    const ownerId = turnArtifactOwnerKey(
      sessionId,
      this.deps.sessionStore.getSession(sessionId)?.session,
    );
    return Promise.all(
      turns.map(async (turn) => {
        const { fileChanges: _unbackedFileChanges, ...turnWithoutFileChanges } =
          turn;
        const artifactTurnIds = [turn.providerTurnId, turn.id].filter(
          (turnId, index, values): turnId is string =>
            typeof turnId === "string" && values.indexOf(turnId) === index,
        );
        for (const artifactTurnId of artifactTurnIds) {
          const persisted = await this.deps.turnArtifacts.findTurnFileChanges(
            ownerId,
            artifactTurnId,
            sessionId,
          );
          if (persisted) {
            return {
              ...turnWithoutFileChanges,
              fileChanges: persisted.fileChanges,
            };
          }
        }
        return turnWithoutFileChanges;
      }),
    );
  }

  private hydrateProcessOutput(
    item: ConversationItemProjection,
    stored: StoredProcessOutput,
  ): ConversationItemProjection {
    if (item.content.kind === "tool") {
      const toolCall = item.content.toolCall;
      const artifacts = (toolCall.detail?.artifacts ?? []).filter(
        (artifact) =>
          !(
            artifact.kind === "text" &&
            (artifact.label === "output" || artifact.label === "stdout")
          ),
      );
      return {
        ...item,
        detailAvailable: true,
        content: {
          ...item.content,
          toolCall: {
            ...toolCall,
            detailAvailable: true,
            detailSizeBytes: stored.output.totalBytes,
            detail: {
              ...toolCall.detail,
              artifacts: [
                ...artifacts,
                { kind: "text" as const, label: "output", text: stored.text },
              ],
            },
          },
        },
      };
    }
    if (item.content.kind === "observation") {
      const observation = item.content.observation;
      const artifacts = (observation.detail?.artifacts ?? []).filter(
        (artifact) =>
          !(
            artifact.kind === "text" &&
            (artifact.label === "output" || artifact.label === "stdout")
          ),
      );
      return {
        ...item,
        detailAvailable: true,
        content: {
          ...item.content,
          observation: {
            ...observation,
            detailAvailable: true,
            detailSizeBytes: stored.output.totalBytes,
            detail: {
              ...observation.detail,
              artifacts: [
                ...artifacts,
                { kind: "text" as const, label: "output", text: stored.text },
              ],
            },
          },
        },
      };
    }
    return item;
  }
}

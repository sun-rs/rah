import { isDeepStrictEqual } from "node:util";
import type {
  ConversationItemProjection,
  ConversationProjection,
  ConversationProjectionDelta,
  ConversationTurnDelta,
  ConversationTurnProjection,
  ConversationTurnStateProjection,
  RahEvent,
} from "@rah/runtime-protocol";
import { summarizeConversationActivities } from "@rah/runtime-protocol";
import { projectConversationTurnResources } from "./conversation-resource-projector";
import type { EventBus } from "./event-bus";
import { summarizeHistoryEvent } from "./history-event-projection";
import {
  IncrementalConversationProjector,
  isConversationProjectionEvent,
  type IncrementalConversationProjectorChange,
} from "./incremental-conversation-projector";

type MergePosition = "older" | "newer";

interface StoredConversationProjection {
  projection: ConversationProjection;
  liveRevision: number;
}

export interface ConversationProjectionSnapshot extends ConversationProjection {
  liveRevision: number;
}

const DEFAULT_DELTA_HISTORY = 2_000;
const DEFAULT_RESIDENT_TURNS = 64;

type TouchedItemIdsByTurn =
  IncrementalConversationProjectorChange["turns"];

function emptyProjection(sessionId: string): ConversationProjection {
  return {
    sessionId,
    turns: [],
    revision: 0,
    generatedAt: new Date(0).toISOString(),
    sourceEventCount: 0,
    partial: true,
  };
}

function statusRank(status: ConversationItemProjection["status"]): number {
  switch (status) {
    case "pending":
      return 0;
    case "running":
      return 1;
    case "completed":
    case "interrupted":
    case "failed":
      return 2;
  }
}

function turnStatusRank(status: ConversationTurnProjection["status"]): number {
  return status === "in_progress" ? 0 : 1;
}

function authorityRank(authority: ConversationItemProjection["source"]["authority"]): number {
  switch (authority) {
    case "heuristic":
      return 0;
    case "derived":
      return 1;
    case "authoritative":
      return 2;
  }
}

function earliestTimestamp(...values: Array<string | undefined>): string | undefined {
  return values
    .filter((value): value is string => Boolean(value))
    .sort()[0];
}

function mergeItemContent(
  existing: ConversationItemProjection,
  incoming: ConversationItemProjection,
  options: { preferIncomingState?: boolean } = {},
): ConversationItemProjection["content"] {
  if (existing.content.kind !== incoming.content.kind) {
    return authorityRank(incoming.source.authority) >= authorityRank(existing.source.authority)
      ? incoming.content
      : existing.content;
  }
  switch (incoming.content.kind) {
    case "tool":
      return existing.content.kind === "tool"
        ? {
            kind: "tool",
            toolCall: {
              ...existing.content.toolCall,
              ...incoming.content.toolCall,
              ...(incoming.content.toolCall.detail ?? existing.content.toolCall.detail
                ? {
                    detail:
                      incoming.content.toolCall.detail ?? existing.content.toolCall.detail,
                  }
                : {}),
            },
            ...(incoming.content.error ?? existing.content.error
              ? { error: incoming.content.error ?? existing.content.error }
              : {}),
          }
        : incoming.content;
    case "observation":
      return existing.content.kind === "observation"
        ? {
            kind: "observation",
            observation: {
              ...existing.content.observation,
              ...incoming.content.observation,
              ...(incoming.content.observation.detail ?? existing.content.observation.detail
                ? {
                    detail:
                      incoming.content.observation.detail ?? existing.content.observation.detail,
                  }
                : {}),
            },
            ...(incoming.content.error ?? existing.content.error
              ? { error: incoming.content.error ?? existing.content.error }
              : {}),
          }
        : incoming.content;
    case "permission":
      return existing.content.kind === "permission"
        ? {
            kind: "permission",
            ...(incoming.content.request ?? existing.content.request
              ? { request: incoming.content.request ?? existing.content.request }
              : {}),
            ...(incoming.content.resolution ?? existing.content.resolution
              ? { resolution: incoming.content.resolution ?? existing.content.resolution }
              : {}),
          }
        : incoming.content;
    default:
      return options.preferIncomingState || incoming.revision >= existing.revision
        ? incoming.content
        : existing.content;
  }
}

function mergeConversationItem(
  existing: ConversationItemProjection,
  incoming: ConversationItemProjection,
  options: { preferIncomingState?: boolean } = {},
): ConversationItemProjection {
  const incomingStatusWins =
    options.preferIncomingState === true ||
    statusRank(incoming.status) > statusRank(existing.status) ||
    (statusRank(incoming.status) === statusRank(existing.status) &&
      incoming.revision >= existing.revision);
  const incomingSourceWins =
    options.preferIncomingState === true ||
    authorityRank(incoming.source.authority) > authorityRank(existing.source.authority) ||
    (authorityRank(incoming.source.authority) === authorityRank(existing.source.authority) &&
      incoming.revision >= existing.revision);
  const startedAt = earliestTimestamp(existing.startedAt, incoming.startedAt);
  const content = mergeItemContent(existing, incoming, options);
  const role = (() => {
    if (content.kind === "timeline") {
      if (content.item.kind === "user_message") {
        return "user" as const;
      }
      if (content.item.kind === "system") {
        return "system" as const;
      }
      if (content.item.kind === "assistant_message") {
        if (content.item.phase === "final_answer") {
          return "final" as const;
        }
        if (content.item.phase === "commentary") {
          return "process" as const;
        }
      } else {
        return "process" as const;
      }
    }
    return incoming.role === "final" || existing.role !== "final"
      ? incoming.role
      : existing.role;
  })();
  const winningStatus = incomingStatusWins ? incoming.status : existing.status;
  const completedAt =
    winningStatus === "pending" || winningStatus === "running"
      ? undefined
      : incomingStatusWins
        ? incoming.completedAt ?? existing.completedAt
        : existing.completedAt ?? incoming.completedAt;
  const durationMs =
    winningStatus === "pending" || winningStatus === "running"
      ? undefined
      : incomingStatusWins
        ? incoming.durationMs ?? existing.durationMs
        : existing.durationMs ?? incoming.durationMs;
  const {
    completedAt: _existingCompletedAt,
    durationMs: _existingDurationMs,
    ...existingBase
  } = existing;
  return {
    ...existingBase,
    id: incoming.id,
    turnId: incoming.turnId,
    ...(incoming.providerItemId ?? existing.providerItemId
      ? { providerItemId: incoming.providerItemId ?? existing.providerItemId }
      : {}),
    role,
    status: winningStatus,
    ...(startedAt ? { startedAt } : {}),
    ...(completedAt ? { completedAt } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    content,
    source: incomingSourceWins ? incoming.source : existing.source,
    ...(incoming.detailAvailable ?? existing.detailAvailable) !== undefined
      ? { detailAvailable: incoming.detailAvailable ?? existing.detailAvailable }
      : {},
    revision: Math.max(existing.revision, incoming.revision),
  };
}

function mergeConversationTurn(
  existing: ConversationTurnProjection,
  incoming: ConversationTurnProjection,
  options: { preferIncomingLifecycle?: boolean } = {},
): ConversationTurnProjection {
  const incomingItemsById = new Map(incoming.items.map((item) => [item.id, item]));
  const mergedItems = existing.items.map((item) => {
    const next = incomingItemsById.get(item.id);
    return next
      ? mergeConversationItem(
          item,
          next,
          options.preferIncomingLifecycle ? { preferIncomingState: true } : {},
        )
      : item;
  });
  const existingItemIds = new Set(existing.items.map((item) => item.id));
  for (const item of incoming.items) {
    if (!existingItemIds.has(item.id)) {
      mergedItems.push(item);
    }
  }
  const incomingStatusWins =
    options.preferIncomingLifecycle === true ||
    turnStatusRank(incoming.status) > turnStatusRank(existing.status) ||
    (turnStatusRank(incoming.status) === turnStatusRank(existing.status) &&
      incoming.statusAuthority === "native" &&
      (existing.statusAuthority !== "native" || incoming.revision >= existing.revision));
  const preferredFinalAnswerItemIds = incomingStatusWins
    ? [incoming.finalAnswerItemId, existing.finalAnswerItemId]
    : [existing.finalAnswerItemId, incoming.finalAnswerItemId];
  const finalAnswerItemId =
    preferredFinalAnswerItemIds.find(
      (itemId) => itemId && mergedItems.some((item) => item.id === itemId && item.role === "final"),
    ) ?? [...mergedItems].reverse().find((item) => item.role === "final")?.id;
  const startedAt = earliestTimestamp(existing.startedAt, incoming.startedAt);
  const winningStatus = incomingStatusWins ? incoming.status : existing.status;
  const completedAt =
    winningStatus === "in_progress"
      ? undefined
      : incomingStatusWins
        ? incoming.completedAt ?? existing.completedAt
        : existing.completedAt ?? incoming.completedAt;
  const durationMs =
    winningStatus === "in_progress"
      ? undefined
      : incomingStatusWins
        ? incoming.durationMs ?? existing.durationMs
        : existing.durationMs ?? incoming.durationMs;
  const error =
    winningStatus === "in_progress"
      ? undefined
      : incomingStatusWins
        ? incoming.error ?? existing.error
        : existing.error ?? incoming.error;
  const {
    completedAt: _existingCompletedAt,
    durationMs: _existingDurationMs,
    error: _existingError,
    finalAnswerItemId: _existingFinalAnswerItemId,
    outputs: _existingOutputs,
    sources: _existingSources,
    fileChanges: _existingFileChanges,
    ...existingBase
  } = existing;
  const fileChanges = incoming.fileChanges ?? existing.fileChanges;
  const resources = projectConversationTurnResources(mergedItems);
  return {
    ...existingBase,
    id: incoming.id,
    provider: incoming.provider,
    ...(incoming.providerSessionId ?? existing.providerSessionId
      ? { providerSessionId: incoming.providerSessionId ?? existing.providerSessionId }
      : {}),
    ...(incoming.providerTurnId ?? existing.providerTurnId
      ? { providerTurnId: incoming.providerTurnId ?? existing.providerTurnId }
      : {}),
    status: winningStatus,
    statusAuthority: incomingStatusWins
      ? incoming.statusAuthority
      : existing.statusAuthority,
    ...(startedAt ? { startedAt } : {}),
    ...(completedAt ? { completedAt } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    items: mergedItems,
    activities: summarizeConversationActivities(mergedItems),
    ...(resources.outputs.length > 0 ? { outputs: resources.outputs } : {}),
    ...(resources.sources.length > 0 ? { sources: resources.sources } : {}),
    ...(fileChanges ? { fileChanges } : {}),
    ...(finalAnswerItemId ? { finalAnswerItemId } : {}),
    failedItemCount: mergedItems.filter((item) => item.status === "failed").length,
    ...(incoming.usage ?? existing.usage ? { usage: incoming.usage ?? existing.usage } : {}),
    ...(error ? { error } : {}),
    ...(incoming.identityConfidence ?? existing.identityConfidence
      ? { identityConfidence: incoming.identityConfidence ?? existing.identityConfidence }
      : {}),
    revision: Math.max(existing.revision, incoming.revision),
  };
}

function turnState(turn: ConversationTurnProjection): ConversationTurnStateProjection {
  const { items: _items, ...state } = turn;
  return state;
}

function turnDelta(
  before: ConversationTurnProjection | undefined,
  after: ConversationTurnProjection,
  touchedItems: readonly ConversationItemProjection[] = after.items,
): ConversationTurnDelta | null {
  const beforeItems = new Map(before?.items.map((item) => [item.id, item]) ?? []);
  const afterItems = new Map(after.items.map((item) => [item.id, item]));
  const upsertItems = touchedItems
    .map((item) => afterItems.get(item.id))
    .filter((item): item is ConversationItemProjection => item !== undefined)
    .filter((item) => !isDeepStrictEqual(beforeItems.get(item.id), item));
  const metadataChanged = !isDeepStrictEqual(
    before ? turnState(before) : undefined,
    turnState(after),
  );
  if (!metadataChanged && upsertItems.length === 0) {
    return null;
  }
  return {
    turn: turnState(after),
    upsertItems,
  };
}

function findMatchingTurnIndex(
  turns: readonly ConversationTurnProjection[],
  incoming: ConversationTurnProjection,
): number {
  const exact = turns.findIndex((turn) => turn.id === incoming.id);
  if (exact >= 0) {
    return exact;
  }
  if (!incoming.providerTurnId) {
    return -1;
  }
  return turns.findIndex(
    (turn) =>
      turn.provider === incoming.provider && turn.providerTurnId === incoming.providerTurnId,
  );
}

function boundResidentTurns(
  turns: readonly ConversationTurnProjection[],
  maxTurns: number,
): ConversationTurnProjection[] {
  if (turns.length <= maxTurns) {
    return [...turns];
  }
  let removeCount = turns.length - maxTurns;
  return turns.filter((turn) => {
    if (removeCount > 0 && turn.status !== "in_progress") {
      removeCount -= 1;
      return false;
    }
    return true;
  });
}

export class ConversationProjectionStore {
  private readonly sessions = new Map<string, StoredConversationProjection>();
  private readonly liveProjectors = new Map<
    string,
    IncrementalConversationProjector
  >();
  private readonly deltasBySourceSeq = new Map<number, ConversationProjectionDelta>();
  private readonly deltaSourceSeqs: number[] = [];
  private readonly unsubscribe: () => void;

  constructor(
    eventBus: EventBus,
    private readonly options: {
      /** @deprecated Live projection no longer replays a sliding event window. */
      eventWindow?: number;
      maxDeltaHistory?: number;
      maxResidentTurns?: number;
      eventFilter?: (event: RahEvent) => boolean;
    } = {},
  ) {
    this.unsubscribe = eventBus.subscribe({}, (event) => {
      if (
        event.type !== "session.closed" &&
        !(this.options.eventFilter?.(event) ?? event.source.channel === "structured_live")
      ) {
        return;
      }
      this.applyLiveEvent(event);
    });
  }

  close(): void {
    this.unsubscribe();
  }

  snapshot(sessionId: string): ConversationProjectionSnapshot {
    const stored = this.sessions.get(sessionId);
    if (!stored) {
      return { ...emptyProjection(sessionId), liveRevision: 0 };
    }
    return { ...stored.projection, liveRevision: stored.liveRevision };
  }

  deltaForSourceSeq(sourceSeq: number): ConversationProjectionDelta | undefined {
    return this.deltasBySourceSeq.get(sourceSeq);
  }

  overlayLiveProjection(base: ConversationProjection): ConversationProjection {
    const { liveRevision: _liveRevision, ...projection } = this.overlayLiveSnapshot(base);
    return projection;
  }

  overlayLiveSnapshot(base: ConversationProjection): ConversationProjectionSnapshot {
    const stored = this.sessions.get(base.sessionId);
    if (!stored || stored.projection.turns.length === 0) {
      return { ...base, liveRevision: stored?.liveRevision ?? 0 };
    }
    const turns = [...base.turns];
    const lastMatchingResidentIndex = stored.projection.turns.reduce(
      (lastIndex, liveTurn, index) =>
        findMatchingTurnIndex(base.turns, liveTurn) >= 0 ? index : lastIndex,
      -1,
    );
    for (const [residentIndex, liveTurn] of stored.projection.turns.entries()) {
      const index = findMatchingTurnIndex(turns, liveTurn);
      if (index < 0) {
        if (
          lastMatchingResidentIndex < 0 ||
          residentIndex > lastMatchingResidentIndex
        ) {
          turns.push(liveTurn);
        }
      } else {
        // A separate provider paging client can only expose persisted state.
        // The resident stream owns the overlapping live turn lifecycle, even
        // when the persisted snapshot still reports an older terminal status.
        turns[index] = mergeConversationTurn(turns[index]!, liveTurn, {
          preferIncomingLifecycle: true,
        });
      }
    }
    return {
      ...base,
      turns,
      revision: Math.max(base.revision, stored.projection.revision),
      generatedAt:
        base.generatedAt >= stored.projection.generatedAt
          ? base.generatedAt
          : stored.projection.generatedAt,
      sourceEventCount: base.sourceEventCount + stored.projection.sourceEventCount,
      liveRevision: stored.liveRevision,
    };
  }

  mergeProjection(
    incoming: ConversationProjection,
    options: {
      position?: MergePosition;
      live?: boolean;
      sourceSeq?: number;
      removeTurnIds?: readonly string[];
      replaceTurns?: boolean;
      touchedItemIdsByTurn?: TouchedItemIdsByTurn;
    } = {},
  ): ConversationProjectionDelta | undefined {
    const stored = this.sessions.get(incoming.sessionId) ?? {
      projection: emptyProjection(incoming.sessionId),
      liveRevision: 0,
    };
    const beforeTurns = stored.projection.turns;
    const requestedRemoveTurnIds = new Set(options.removeTurnIds ?? []);
    const nextTurns = beforeTurns.filter(
      (turn) => !requestedRemoveTurnIds.has(turn.id),
    );
    const removedTurnIds = beforeTurns
      .filter((turn) => requestedRemoveTurnIds.has(turn.id))
      .map((turn) => turn.id);
    const changedTurns: ConversationTurnDelta[] = [];
    const incomingNewTurns: ConversationTurnProjection[] = [];

    for (const incomingTurn of incoming.turns) {
      const index = findMatchingTurnIndex(nextTurns, incomingTurn);
      if (index < 0) {
        incomingNewTurns.push(incomingTurn);
        const delta = turnDelta(undefined, incomingTurn);
        if (delta) {
          changedTurns.push(delta);
        }
        continue;
      }
      const previous = nextTurns[index]!;
      const merged = options.replaceTurns
        ? incomingTurn
        : mergeConversationTurn(previous, incomingTurn);
      if (previous.id !== merged.id) {
        removedTurnIds.push(previous.id);
      }
      nextTurns[index] = merged;
      const touchedItemIds = options.touchedItemIdsByTurn?.get(
        incomingTurn.id,
      );
      const touchedItems =
        touchedItemIds === undefined || touchedItemIds === null
          ? incomingTurn.items
          : incomingTurn.items.filter((item) => touchedItemIds.has(item.id));
      const delta = turnDelta(previous, merged, touchedItems);
      if (delta) {
        changedTurns.push(delta);
      }
    }

    if (incomingNewTurns.length > 0) {
      if (options.position === "older") {
        nextTurns.unshift(...incomingNewTurns);
      } else {
        nextTurns.push(...incomingNewTurns);
      }
    }
    if (changedTurns.length === 0 && removedTurnIds.length === 0) {
      this.sessions.set(incoming.sessionId, stored);
      return undefined;
    }

    const nextContentRevision = stored.projection.revision + 1;
    const baseLiveRevision = stored.liveRevision;
    const nextLiveRevision = options.live ? baseLiveRevision + 1 : baseLiveRevision;
    const residentTurns = options.live
      ? boundResidentTurns(
          nextTurns,
          Math.max(1, this.options.maxResidentTurns ?? DEFAULT_RESIDENT_TURNS),
        )
      : nextTurns;
    stored.projection = {
      sessionId: incoming.sessionId,
      turns: residentTurns,
      revision: nextContentRevision,
      generatedAt: new Date().toISOString(),
      sourceEventCount: Math.max(
        stored.projection.sourceEventCount,
        incoming.sourceEventCount,
      ),
      ...(incoming.partial ?? stored.projection.partial ? { partial: true } : {}),
    };
    stored.liveRevision = nextLiveRevision;
    this.sessions.set(incoming.sessionId, stored);

    if (!options.live) {
      return undefined;
    }
    const delta: ConversationProjectionDelta = {
      sessionId: incoming.sessionId,
      baseRevision: baseLiveRevision,
      revision: nextLiveRevision,
      ...(options.sourceSeq !== undefined ? { sourceSeq: options.sourceSeq } : {}),
      upsertTurns: changedTurns,
      ...(removedTurnIds.length > 0 ? { removeTurnIds: removedTurnIds } : {}),
    };
    if (options.sourceSeq !== undefined) {
      this.rememberDelta(options.sourceSeq, delta);
    }
    return delta;
  }

  private applyLiveEvent(event: RahEvent): void {
    if (event.type === "session.closed") {
      this.sessions.delete(event.sessionId);
      this.liveProjectors.delete(event.sessionId);
      return;
    }
    // Canonical events share one bus, but process output, message deltas, and
    // tool deltas are high-volume data-plane traffic. They have bounded stores
    // of their own and must never enter semantic conversation projection.
    if (!isConversationProjectionEvent(event)) {
      return;
    }
    let projector = this.liveProjectors.get(event.sessionId);
    if (!projector) {
      projector = new IncrementalConversationProjector(event.sessionId);
      this.liveProjectors.set(event.sessionId, projector);
    }
    const change = projector.apply(summarizeHistoryEvent(event));
    const prunedTurnIds = projector.pruneCompletedTurns(
      Math.max(1, this.options.maxResidentTurns ?? DEFAULT_RESIDENT_TURNS),
    );
    const removeTurnIds = [...new Set([
      ...change.removedTurnIds,
      ...prunedTurnIds,
    ])];
    if (change.turns.size === 0 && removeTurnIds.length === 0) {
      return;
    }
    const projection = projector.projection(
      { partial: true },
      new Set(change.turns.keys()),
    );
    this.mergeProjection(projection, {
      position: "newer",
      live: true,
      sourceSeq: event.seq,
      removeTurnIds,
      replaceTurns: true,
      touchedItemIdsByTurn: change.turns,
    });
  }

  private rememberDelta(sourceSeq: number, delta: ConversationProjectionDelta): void {
    this.deltasBySourceSeq.set(sourceSeq, delta);
    this.deltaSourceSeqs.push(sourceSeq);
    const maxHistory = this.options.maxDeltaHistory ?? DEFAULT_DELTA_HISTORY;
    if (this.deltaSourceSeqs.length <= maxHistory) {
      return;
    }
    const removed = this.deltaSourceSeqs.splice(0, this.deltaSourceSeqs.length - maxHistory);
    for (const seq of removed) {
      this.deltasBySourceSeq.delete(seq);
    }
  }
}

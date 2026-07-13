import type {
  ConversationItemDetailResponse,
  ConversationItemProjection,
  ConversationProjectionDelta,
  ConversationTurnDetailResponse,
  ConversationTurnDelta,
  ConversationTurnProjection,
  ConversationTurnsPageResponse,
} from "@rah/runtime-protocol";
import { summarizeConversationActivities } from "@rah/runtime-protocol";
import * as api from "./api";
import {
  mergeConversationOutputs,
  mergeConversationSources,
} from "./conversation-resources";
import {
  initialConversationSyncState,
  type ConversationSyncState,
  type SessionProjection,
} from "./types";

type ConversationState = {
  projections: Map<string, SessionProjection>;
};

type ConversationSetState = (
  partial:
    | Partial<ConversationState>
    | ((state: ConversationState) => Partial<ConversationState> | ConversationState),
) => void;

type ConversationDeps = {
  get: () => ConversationState;
  set: ConversationSetState;
  readTurns?: typeof api.readSessionConversationTurns;
  readItemDetail?: typeof api.readSessionConversationItemDetail;
  readTurnDetail?: typeof api.readSessionConversationTurnDetail;
};

const MAX_PENDING_DELTAS = 256;
const turnDetailRequests = new Map<string, Promise<boolean>>();
const conversationPageRequests = new Map<string, Promise<boolean>>();

function normalizeConversationTurn(
  turn: ConversationTurnProjection,
): ConversationTurnProjection {
  const items = Array.isArray(turn.items) ? turn.items : [];
  return {
    ...turn,
    items,
    activities: Array.isArray(turn.activities)
      ? turn.activities
      : summarizeConversationActivities(items),
    failedItemCount:
      typeof turn.failedItemCount === "number"
        ? turn.failedItemCount
        : items.filter((item) => item.status === "failed").length,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function replaceProjectionState(
  state: ConversationState,
  sessionId: string,
  update: (current: ConversationSyncState) => ConversationSyncState,
): Partial<ConversationState> | ConversationState {
  const projection = state.projections.get(sessionId);
  if (!projection) {
    return state;
  }
  const next = new Map(state.projections);
  next.set(sessionId, {
    ...projection,
    conversation: update(projection.conversation ?? initialConversationSyncState()),
  });
  return { projections: next };
}

function mergeProcessItem(
  current: ConversationItemProjection,
  incoming: ConversationItemProjection,
): ConversationItemProjection {
  if (current.content.kind !== incoming.content.kind) {
    return incoming;
  }
  if (current.content.kind === "tool" && incoming.content.kind === "tool") {
    const detailAvailable = incoming.detailAvailable ?? current.detailAvailable;
    return {
      ...current,
      ...incoming,
      content: {
        ...incoming.content,
        toolCall: {
          ...current.content.toolCall,
          ...incoming.content.toolCall,
          ...(incoming.content.toolCall.detail ?? current.content.toolCall.detail
            ? { detail: incoming.content.toolCall.detail ?? current.content.toolCall.detail }
            : {}),
        },
        ...(incoming.content.error ?? current.content.error
          ? { error: incoming.content.error ?? current.content.error }
          : {}),
      },
      ...(detailAvailable !== undefined ? { detailAvailable } : {}),
      revision: Math.max(current.revision, incoming.revision),
    };
  }
  if (current.content.kind === "observation" && incoming.content.kind === "observation") {
    const detailAvailable = incoming.detailAvailable ?? current.detailAvailable;
    return {
      ...current,
      ...incoming,
      content: {
        ...incoming.content,
        observation: {
          ...current.content.observation,
          ...incoming.content.observation,
          ...(incoming.content.observation.detail ?? current.content.observation.detail
            ? {
                detail:
                  incoming.content.observation.detail ?? current.content.observation.detail,
              }
            : {}),
        },
        ...(incoming.content.error ?? current.content.error
          ? { error: incoming.content.error ?? current.content.error }
          : {}),
      },
      ...(detailAvailable !== undefined ? { detailAvailable } : {}),
      revision: Math.max(current.revision, incoming.revision),
    };
  }
  return incoming;
}

function sameConversationItemIdentity(
  left: ConversationItemProjection,
  right: ConversationItemProjection,
): boolean {
  return (
    left.id === right.id ||
    Boolean(
      left.providerItemId &&
        right.providerItemId &&
        left.providerItemId === right.providerItemId,
    )
  );
}

function lastFinalItem(
  items: readonly ConversationItemProjection[],
): ConversationItemProjection | undefined {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (items[index]?.role === "final") {
      return items[index];
    }
  }
  return undefined;
}

function mergeFullTurnWithSummary(
  current: ConversationTurnProjection,
  incoming: ConversationTurnProjection,
): ConversationTurnProjection {
  const consumedIncoming = new Set<ConversationItemProjection>();
  const items = current.items.map((currentItem) => {
    const match = incoming.items.find(
      (incomingItem) =>
        incomingItem.role === currentItem.role &&
        sameConversationItemIdentity(currentItem, incomingItem),
    );
    if (!match) {
      return currentItem;
    }
    consumedIncoming.add(match);
    if (currentItem.role === "process") {
      return mergeProcessItem(currentItem, match);
    }
    return {
      ...match,
      id: currentItem.id,
      turnId: currentItem.turnId,
      ...(currentItem.providerItemId
        ? { providerItemId: currentItem.providerItemId }
        : {}),
      revision: Math.max(currentItem.revision, match.revision),
    };
  });

  const identityCollidesWithCurrent = (incomingItem: ConversationItemProjection): boolean =>
    current.items.some(
      (currentItem) =>
        currentItem.role !== incomingItem.role &&
        sameConversationItemIdentity(currentItem, incomingItem),
    );
  const unmatched = incoming.items.filter(
    (item) => !consumedIncoming.has(item) && !identityCollidesWithCurrent(item),
  );
  const newLeading = unmatched.filter(
    (item) =>
      item.role !== "process" &&
      item.role !== "final" &&
      (item.role !== "user" || !items.some((currentItem) => currentItem.role === "user")),
  );
  const newProcess = unmatched.filter((item) => item.role === "process");
  const newFinal = items.some((item) => item.role === "final")
    ? []
    : unmatched.filter((item) => item.role === "final");
  const firstProcessIndex = items.findIndex((item) => item.role === "process");
  if (newLeading.length > 0) {
    items.splice(firstProcessIndex >= 0 ? firstProcessIndex : 0, 0, ...newLeading);
  }
  const firstFinalIndex = items.findIndex((item) => item.role === "final");
  if (newProcess.length > 0) {
    items.splice(firstFinalIndex >= 0 ? firstFinalIndex : items.length, 0, ...newProcess);
  }
  items.push(...newFinal);

  const final = lastFinalItem(items);
  const outputs = mergeConversationOutputs(current.outputs, incoming.outputs);
  const sources = mergeConversationSources(current.sources, incoming.sources);
  const merged: ConversationTurnProjection = {
    ...incoming,
    items,
    ...(outputs.length > 0 ? { outputs } : {}),
    ...(sources.length > 0 ? { sources } : {}),
    itemsView: "full",
    failedItemCount: items.filter((item) => item.status === "failed").length,
    activities: summarizeConversationActivities(items),
    revision: Math.max(current.revision, incoming.revision),
  };
  if (final) {
    merged.finalAnswerItemId = final.id;
  } else {
    delete merged.finalAnswerItemId;
  }
  return merged;
}

function mergeTurnWithoutDetailDowngrade(
  current: ConversationTurnProjection,
  incoming: ConversationTurnProjection,
): ConversationTurnProjection {
  if (current.itemsView === "full" && incoming.itemsView !== "full") {
    return mergeFullTurnWithSummary(current, incoming);
  }
  const currentProcessById = new Map(
    current.items.filter((item) => item.role === "process").map((item) => [item.id, item]),
  );
  const currentProcessByProviderId = new Map(
    current.items
      .filter((item) => item.role === "process" && item.providerItemId)
      .map((item) => [item.providerItemId!, item]),
  );
  const incomingProcess = incoming.items.filter((item) => item.role === "process");
  const process = incomingProcess.map((item) => {
    const detailed =
      currentProcessById.get(item.id) ??
      (item.providerItemId ? currentProcessByProviderId.get(item.providerItemId) : undefined);
    if (!detailed || detailed.content.kind !== item.content.kind) {
      return item;
    }
    return mergeProcessItem(detailed, item);
  });
  const processById = new Map(process.map((item) => [item.id, item]));
  const processByProviderId = new Map(
    process
      .filter((item) => item.providerItemId)
      .map((item) => [item.providerItemId!, item]),
  );
  return normalizeConversationTurn({
    ...incoming,
    items: incoming.items.map((item) =>
      item.role === "process"
        ? processById.get(item.id) ??
          (item.providerItemId ? processByProviderId.get(item.providerItemId) : undefined) ??
          item
        : item,
    ),
    revision: Math.max(current.revision, incoming.revision),
  });
}

function mergeNewerTurns(
  current: readonly ConversationTurnProjection[],
  incoming: readonly ConversationTurnProjection[],
): ConversationTurnProjection[] {
  const incomingById = new Map(incoming.map((turn) => [turn.id, turn]));
  const existingIds = new Set(current.map((turn) => turn.id));
  return [
    ...current.map((turn) => {
      const incomingTurn = incomingById.get(turn.id);
      return incomingTurn ? mergeTurnWithoutDetailDowngrade(turn, incomingTurn) : turn;
    }),
    ...incoming.filter((turn) => !existingIds.has(turn.id)),
  ];
}

function mergeOlderTurns(
  current: readonly ConversationTurnProjection[],
  incoming: readonly ConversationTurnProjection[],
): ConversationTurnProjection[] {
  const currentIds = new Set(current.map((turn) => turn.id));
  return [
    ...incoming.filter((turn) => !currentIds.has(turn.id)),
    ...current,
  ];
}

function applyTurnDelta(
  turns: readonly ConversationTurnProjection[],
  delta: ConversationTurnDelta,
): ConversationTurnProjection[] {
  const removedItemIds = new Set(delta.removeItemIds ?? []);
  const incomingItems = new Map(delta.upsertItems.map((item) => [item.id, item]));
  const turnIndex = turns.findIndex((turn) => turn.id === delta.turn.id);
  if (turnIndex < 0) {
    return [
      ...turns,
      normalizeConversationTurn({
        ...delta.turn,
        items: delta.upsertItems.filter((item) => !removedItemIds.has(item.id)),
      }),
    ];
  }

  const existing = turns[turnIndex]!;
  const existingItemIds = new Set(existing.items.map((item) => item.id));
  const items = [
    ...existing.items
      .filter((item) => !removedItemIds.has(item.id))
      .map((item) => incomingItems.get(item.id) ?? item),
    ...delta.upsertItems.filter(
      (item) => !removedItemIds.has(item.id) && !existingItemIds.has(item.id),
    ),
  ];
  const next = [...turns];
  next[turnIndex] = mergeTurnWithoutDetailDowngrade(existing, {
    ...delta.turn,
    items,
  });
  return next;
}

function applyProjectionDelta(
  turns: readonly ConversationTurnProjection[],
  delta: ConversationProjectionDelta,
): ConversationTurnProjection[] {
  const removedTurnIds = new Set(delta.removeTurnIds ?? []);
  let next = turns.filter((turn) => !removedTurnIds.has(turn.id));
  for (const turnDelta of delta.upsertTurns) {
    next = applyTurnDelta(next, turnDelta);
  }
  return next;
}

function normalizePendingDeltas(
  deltas: readonly ConversationProjectionDelta[],
): ConversationProjectionDelta[] {
  const byRevision = new Map<number, ConversationProjectionDelta>();
  for (const delta of deltas) {
    byRevision.set(delta.revision, delta);
  }
  return [...byRevision.values()]
    .sort((left, right) => left.revision - right.revision)
    .slice(-MAX_PENDING_DELTAS);
}

function applyPendingDeltas(
  turns: readonly ConversationTurnProjection[],
  daemonRevision: number,
  pendingDeltas: readonly ConversationProjectionDelta[],
): {
  turns: ConversationTurnProjection[];
  daemonRevision: number;
  pendingDeltas: ConversationProjectionDelta[];
  needsRefresh: boolean;
} {
  let nextTurns = [...turns];
  let nextRevision = daemonRevision;
  const pending = normalizePendingDeltas(pendingDeltas).filter(
    (delta) => delta.revision > daemonRevision,
  );
  let appliedCount = 0;
  for (const delta of pending) {
    if (delta.baseRevision !== nextRevision) {
      break;
    }
    nextTurns = applyProjectionDelta(nextTurns, delta);
    nextRevision = delta.revision;
    appliedCount += 1;
  }
  const unresolved = pending.slice(appliedCount);
  return {
    turns: nextTurns,
    daemonRevision: nextRevision,
    pendingDeltas: unresolved,
    needsRefresh: unresolved.length > 0,
  };
}

function appendPendingDelta(
  current: ConversationSyncState,
  delta: ConversationProjectionDelta,
): ConversationSyncState {
  const pendingDeltas = normalizePendingDeltas([...current.pendingDeltas, delta]);
  return {
    ...current,
    pendingDeltas,
    needsRefresh:
      current.needsRefresh ||
      pendingDeltas.length >= MAX_PENDING_DELTAS ||
      (current.daemonRevision !== null &&
        pendingDeltas[0] !== undefined &&
        pendingDeltas[0].baseRevision !== current.daemonRevision),
  };
}

function applyDeltaToConversation(
  current: ConversationSyncState,
  delta: ConversationProjectionDelta,
): ConversationSyncState {
  if (current.daemonRevision === null || current.phase !== "ready") {
    return appendPendingDelta(current, delta);
  }
  if (delta.revision <= current.daemonRevision) {
    return current;
  }
  const pending = applyPendingDeltas(
    current.turns,
    current.daemonRevision,
    [...current.pendingDeltas, delta],
  );
  return {
    ...current,
    turns: pending.turns,
    daemonRevision: pending.daemonRevision,
    pendingDeltas: pending.pendingDeltas,
    needsRefresh: pending.needsRefresh,
    revision:
      pending.daemonRevision === current.daemonRevision
        ? current.revision
        : current.revision + 1,
    loadedAt: new Date().toISOString(),
    lastError: null,
  };
}

export function applyConversationDeltasToProjectionMap(
  current: Map<string, SessionProjection>,
  deltas: readonly ConversationProjectionDelta[],
): Map<string, SessionProjection> {
  let next: Map<string, SessionProjection> | null = null;
  for (const delta of deltas) {
    const projection = (next ?? current).get(delta.sessionId);
    if (!projection?.conversation) {
      continue;
    }
    const conversation = applyDeltaToConversation(projection.conversation, delta);
    if (conversation === projection.conversation) {
      continue;
    }
    next ??= new Map(current);
    next.set(delta.sessionId, { ...projection, conversation });
  }
  return next ?? current;
}

async function performLoadTurns(
  deps: ConversationDeps,
  sessionId: string,
  mode: "initial" | "refresh" | "older",
  options: { liveOnly?: boolean } = {},
): Promise<boolean> {
  const projection = deps.get().projections.get(sessionId);
  if (!projection) {
    return false;
  }
  const current = projection.conversation ?? initialConversationSyncState();
  if (
    mode === "initial" &&
    current.phase === "ready" &&
    (options.liveOnly || current.loadedScope === "history")
  ) {
    return true;
  }
  if (mode === "older" && !current.nextCursor) {
    return false;
  }

  deps.set((state) =>
    replaceProjectionState(state, sessionId, (value) => ({
      ...value,
      phase: "loading",
      lastError: null,
    })),
  );

  try {
    const response = await (deps.readTurns ?? api.readSessionConversationTurns)(sessionId, {
      ...(mode === "older" && current.nextCursor ? { cursor: current.nextCursor } : {}),
      limit: 20,
      ...(options.liveOnly ? { liveOnly: true } : {}),
    });
    deps.set((state) =>
      replaceProjectionState(state, sessionId, (value) => {
        const responseTurns = response.turns.map(normalizeConversationTurn);
        const pageTurns =
          mode === "initial"
            ? responseTurns
            : mode === "older"
              ? mergeOlderTurns(value.turns, responseTurns)
              : mergeNewerTurns(value.turns, responseTurns);
        const responseLiveRevision = response.liveRevision ?? response.revision;
        const baselineRevision =
          mode === "older"
            ? (value.daemonRevision ?? responseLiveRevision)
            : Math.max(value.daemonRevision ?? 0, responseLiveRevision);
        const baselineTurns =
          mode !== "older" &&
          value.daemonRevision !== null &&
          responseLiveRevision < value.daemonRevision
            ? mergeNewerTurns(pageTurns, value.turns)
            : pageTurns;
        const pending = applyPendingDeltas(
          baselineTurns,
          baselineRevision,
          value.pendingDeltas,
        );
        return {
          phase: "ready",
          loadedScope:
            mode === "older" || mode === "refresh" || !options.liveOnly
              ? "history"
              : value.loadedScope === "history"
                ? "history"
                : "live",
          turns: pending.turns,
          nextCursor:
            mode === "refresh"
              ? value.nextCursor
              : response.nextCursor ?? null,
          revision: value.revision + 1,
          daemonRevision: pending.daemonRevision,
          pendingDeltas: pending.pendingDeltas,
          needsRefresh: pending.needsRefresh,
          approximateBytes:
            mode === "older"
              ? (value.approximateBytes ?? 0) + (response.approximateBytes ?? 0)
              : Math.max(value.approximateBytes ?? 0, response.approximateBytes ?? 0),
          loadedAt: new Date().toISOString(),
          lastError: null,
        };
      }),
    );
    return true;
  } catch (error) {
    deps.set((state) =>
      replaceProjectionState(state, sessionId, (value) => ({
        ...value,
        phase: value.turns.length > 0 ? "ready" : "error",
        lastError: errorMessage(error),
      })),
    );
    return false;
  }
}

function loadTurns(
  deps: ConversationDeps,
  sessionId: string,
  mode: "initial" | "refresh" | "older",
  options: { liveOnly?: boolean } = {},
): Promise<boolean> {
  const active = conversationPageRequests.get(sessionId);
  if (active) {
    return active.then(() => loadTurns(deps, sessionId, mode, options));
  }
  let tracked: Promise<boolean>;
  tracked = performLoadTurns(deps, sessionId, mode, options).finally(() => {
    if (conversationPageRequests.get(sessionId) === tracked) {
      conversationPageRequests.delete(sessionId);
    }
  });
  conversationPageRequests.set(sessionId, tracked);
  return tracked;
}

export function ensureConversationLoadedCommand(
  deps: ConversationDeps,
  sessionId: string,
): Promise<boolean> {
  return loadTurns(deps, sessionId, "initial");
}

export function initializeLiveConversationCommand(
  deps: ConversationDeps,
  sessionId: string,
): Promise<boolean> {
  return loadTurns(deps, sessionId, "initial", { liveOnly: true });
}

export function refreshConversationCommand(
  deps: ConversationDeps,
  sessionId: string,
): Promise<boolean> {
  return loadTurns(deps, sessionId, "refresh");
}

export function loadOlderConversationCommand(
  deps: ConversationDeps,
  sessionId: string,
): Promise<boolean> {
  return loadTurns(deps, sessionId, "older");
}

function findItemAddress(
  projection: SessionProjection,
  itemId: string,
): { itemId: string; turnId: string; providerTurnId: string; providerItemId: string } | null {
  for (const turn of projection.conversation?.turns ?? []) {
    const item = turn.items.find((candidate) => {
      if (candidate.id === itemId) {
        return true;
      }
      return candidate.content.kind === "tool"
        ? candidate.content.toolCall.id === itemId
        : candidate.content.kind === "observation"
          ? candidate.content.observation.id === itemId
          : false;
    });
    if (item && turn.providerTurnId && item.providerItemId) {
      return {
        itemId: item.id,
        turnId: turn.id,
        providerTurnId: turn.providerTurnId,
        providerItemId: item.providerItemId,
      };
    }
  }
  return null;
}

function applyItemDetail(
  current: ConversationSyncState,
  response: ConversationItemDetailResponse,
): ConversationSyncState {
  return {
    ...current,
    turns: current.turns.map((turn) =>
      turn.id === response.turnId
        ? {
            ...turn,
            items: turn.items.map((item) =>
              item.id === response.itemId ? response.item : item,
            ),
            revision: turn.revision + 1,
          }
        : turn,
    ),
    revision: current.revision + 1,
    approximateBytes:
      (current.approximateBytes ?? 0) + (response.approximateBytes ?? 0),
    lastError: null,
  };
}

export async function loadConversationItemDetailCommand(
  deps: ConversationDeps,
  sessionId: string,
  itemId: string,
): Promise<boolean> {
  const projection = deps.get().projections.get(sessionId);
  if (!projection) {
    return false;
  }
  const address = findItemAddress(projection, itemId);
  if (!address) {
    return false;
  }
  try {
    const response = await (deps.readItemDetail ?? api.readSessionConversationItemDetail)(
      sessionId,
      {
        itemId: address.itemId,
        providerTurnId: address.providerTurnId,
        providerItemId: address.providerItemId,
      },
    );
    if (
      response.sessionId !== sessionId ||
      response.turnId !== address.turnId ||
      response.itemId !== address.itemId ||
      response.item.id !== address.itemId
    ) {
      return false;
    }
    deps.set((state) =>
      replaceProjectionState(state, sessionId, (current) =>
        applyItemDetail(current, response),
      ),
    );
    return true;
  } catch {
    return false;
  }
}

function applyTurnDetail(
  current: ConversationSyncState,
  response: ConversationTurnDetailResponse,
): ConversationSyncState {
  const applyToTurn = (
    turn: ConversationTurnProjection,
  ): ConversationTurnProjection => {
    const existingProcessById = new Map(
      turn.items.filter((item) => item.role === "process").map((item) => [item.id, item]),
    );
    const existingProcessByProviderId = new Map(
      turn.items
        .filter((item) => item.role === "process" && item.providerItemId)
        .map((item) => [item.providerItemId!, item]),
    );
    const hydratedProcess = response.turn.items
      .filter((item) => item.role === "process")
      .map((item) => {
        const existing =
          existingProcessById.get(item.id) ??
          (item.providerItemId
            ? existingProcessByProviderId.get(item.providerItemId)
            : undefined);
        return existing ? mergeProcessItem(item, existing) : item;
      });
    const detailedItems = response.turn.items;
    const identityIsRepresentedByDetail = (item: ConversationItemProjection): boolean =>
      detailedItems.some((detailed) => sameConversationItemIdentity(item, detailed));
    const liveOnlyProcess = turn.items.filter(
      (item) => item.role === "process" && !identityIsRepresentedByDetail(item),
    );
    const detailedLeading = detailedItems.filter(
      (item) => item.role !== "process" && item.role !== "final",
    );
    const detailedFinal = detailedItems.filter((item) => item.role === "final");
    const leading = detailedLeading.length > 0
      ? detailedLeading
      : turn.items.filter((item) => item.role !== "process" && item.role !== "final");
    const final = detailedFinal.length > 0
      ? detailedFinal
      : turn.items.filter((item) => item.role === "final");
    const items = [...leading, ...hydratedProcess, ...liveOnlyProcess, ...final];
    const finalItem = lastFinalItem(items);
    const outputs = mergeConversationOutputs(turn.outputs, response.turn.outputs);
    const sources = mergeConversationSources(turn.sources, response.turn.sources);
    const hydrated: ConversationTurnProjection = {
      ...turn,
      items,
      ...(outputs.length > 0 ? { outputs } : {}),
      ...(sources.length > 0 ? { sources } : {}),
      itemsView: "full",
      failedItemCount: items.filter((item) => item.status === "failed").length,
      activities: summarizeConversationActivities(items),
      revision: Math.max(turn.revision, response.turn.revision) + 1,
    };
    if (finalItem) {
      hydrated.finalAnswerItemId = finalItem.id;
    } else {
      delete hydrated.finalAnswerItemId;
    }
    return hydrated;
  };

  const matchingIndex = current.turns.findIndex(
    (turn) =>
      turn.id === response.turnId ||
      Boolean(
        turn.providerTurnId &&
          response.turn.providerTurnId &&
          turn.providerTurnId === response.turn.providerTurnId,
      ),
  );
  const turns = matchingIndex >= 0
    ? current.turns.map((turn, index) => index === matchingIndex ? applyToTurn(turn) : turn)
    : [...current.turns, normalizeConversationTurn(response.turn)].sort((left, right) => {
        const byStartedAt = (left.startedAt ?? "").localeCompare(right.startedAt ?? "");
        return byStartedAt || left.id.localeCompare(right.id);
      });
  return {
    ...current,
    turns,
    revision: current.revision + 1,
    approximateBytes:
      (current.approximateBytes ?? 0) + (response.approximateBytes ?? 0),
    lastError: null,
  };
}

export async function hydrateConversationTurnByProviderIdCommand(
  deps: ConversationDeps,
  sessionId: string,
  providerTurnId: string,
): Promise<boolean> {
  const projection = deps.get().projections.get(sessionId);
  if (!projection?.conversation) {
    return false;
  }
  const existing = projection.conversation.turns.find(
    (turn) => turn.id === providerTurnId || turn.providerTurnId === providerTurnId,
  );
  if (existing?.itemsView === "full") {
    return true;
  }
  const turnId = existing?.id ?? providerTurnId;
  const key = `${sessionId}\0${turnId}`;
  const active = turnDetailRequests.get(key);
  if (active) {
    return active;
  }
  const request = (async () => {
    try {
      const response = await (deps.readTurnDetail ?? api.readSessionConversationTurnDetail)(
        sessionId,
        { turnId, providerTurnId },
      );
      if (
        response.sessionId !== sessionId ||
        response.turnId !== turnId ||
        response.turn.id !== turnId ||
        response.turn.providerTurnId !== providerTurnId
      ) {
        return false;
      }
      deps.set((state) =>
        replaceProjectionState(state, sessionId, (current) =>
          applyTurnDetail(current, response),
        ),
      );
      return true;
    } catch {
      return false;
    }
  })().finally(() => {
    if (turnDetailRequests.get(key) === request) {
      turnDetailRequests.delete(key);
    }
  });
  turnDetailRequests.set(key, request);
  return request;
}

export async function loadConversationTurnDetailCommand(
  deps: ConversationDeps,
  sessionId: string,
  turnId: string,
): Promise<boolean> {
  const key = `${sessionId}\0${turnId}`;
  const existing = turnDetailRequests.get(key);
  if (existing) {
    return existing;
  }
  const request = (async () => {
    const projection = deps.get().projections.get(sessionId);
    const turn = projection?.conversation?.turns.find((candidate) => candidate.id === turnId);
    if (!turn?.providerTurnId || turn.itemsView !== "summary") {
      return false;
    }
    try {
      const response = await (deps.readTurnDetail ?? api.readSessionConversationTurnDetail)(
        sessionId,
        { turnId, providerTurnId: turn.providerTurnId },
      );
      if (
        response.sessionId !== sessionId ||
        response.turnId !== turnId ||
        response.turn.id !== turnId ||
        response.turn.providerTurnId !== turn.providerTurnId
      ) {
        return false;
      }
      deps.set((state) =>
        replaceProjectionState(state, sessionId, (current) =>
          applyTurnDetail(current, response),
        ),
      );
      return true;
    } catch {
      return false;
    }
  })().finally(() => {
    turnDetailRequests.delete(key);
  });
  turnDetailRequests.set(key, request);
  return request;
}

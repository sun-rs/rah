import type {
  ConversationItemDetailResponse,
  ConversationItemProjection,
  ConversationProjectionDelta,
  ConversationTurnDetailResponse,
  ConversationTurnDelta,
  ConversationTurnProjection,
  ConversationTurnsPageResponse,
} from "@rah/runtime-protocol";
import * as api from "./api";
import {
  initialConversationV2SyncState,
  type ConversationV2SyncState,
  type SessionProjection,
} from "./types";

type ConversationV2State = {
  projections: Map<string, SessionProjection>;
};

type ConversationV2SetState = (
  partial:
    | Partial<ConversationV2State>
    | ((state: ConversationV2State) => Partial<ConversationV2State> | ConversationV2State),
) => void;

type ConversationV2Deps = {
  get: () => ConversationV2State;
  set: ConversationV2SetState;
  readTurns?: typeof api.readSessionConversationTurns;
  readItemDetail?: typeof api.readSessionConversationItemDetail;
  readTurnDetail?: typeof api.readSessionConversationTurnDetail;
};

const MAX_PENDING_DELTAS = 256;
const turnDetailRequests = new Map<string, Promise<boolean>>();
const conversationPageRequests = new Map<string, Promise<boolean>>();

export async function loadPreferredConversationHistory(args: {
  conversationV2Enabled: boolean;
  loadConversationV2: () => Promise<boolean>;
  loadLegacy: () => Promise<void>;
}): Promise<"conversation_v2" | "legacy"> {
  if (args.conversationV2Enabled && await args.loadConversationV2()) {
    return "conversation_v2";
  }
  await args.loadLegacy();
  return "legacy";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function replaceProjectionState(
  state: ConversationV2State,
  sessionId: string,
  update: (current: ConversationV2SyncState) => ConversationV2SyncState,
): Partial<ConversationV2State> | ConversationV2State {
  const projection = state.projections.get(sessionId);
  if (!projection) {
    return state;
  }
  const next = new Map(state.projections);
  next.set(sessionId, {
    ...projection,
    conversationV2: update(projection.conversationV2 ?? initialConversationV2SyncState()),
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

function mergeTurnWithoutDetailDowngrade(
  current: ConversationTurnProjection,
  incoming: ConversationTurnProjection,
): ConversationTurnProjection {
  const preserveFullProcess = current.itemsView === "full" && incoming.itemsView !== "full";
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
  if (!preserveFullProcess) {
    const processById = new Map(process.map((item) => [item.id, item]));
    const processByProviderId = new Map(
      process
        .filter((item) => item.providerItemId)
        .map((item) => [item.providerItemId!, item]),
    );
    return {
      ...incoming,
      items: incoming.items.map((item) =>
        item.role === "process"
          ? processById.get(item.id) ??
            (item.providerItemId ? processByProviderId.get(item.providerItemId) : undefined) ??
            item
          : item,
      ),
      revision: Math.max(current.revision, incoming.revision),
    };
  }
  const representedIds = new Set(process.map((item) => item.id));
  const representedProviderIds = new Set(
    process
      .map((item) => item.providerItemId)
      .filter((value): value is string => Boolean(value)),
  );
  process.push(
    ...current.items.filter(
      (item) =>
        item.role === "process" &&
        !representedIds.has(item.id) &&
        !(item.providerItemId && representedProviderIds.has(item.providerItemId)),
    ),
  );
  const items = [
    ...incoming.items.filter((item) => item.role !== "process" && item.role !== "final"),
    ...process,
    ...incoming.items.filter((item) => item.role === "final"),
  ];
  return {
    ...incoming,
    items,
    itemsView: "full",
    failedItemCount: Math.max(
      current.failedItemCount,
      incoming.failedItemCount,
      items.filter((item) => item.status === "failed").length,
    ),
    revision: Math.max(current.revision, incoming.revision),
  };
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
      {
        ...delta.turn,
        items: delta.upsertItems.filter((item) => !removedItemIds.has(item.id)),
      },
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
  current: ConversationV2SyncState,
  delta: ConversationProjectionDelta,
): ConversationV2SyncState {
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
  current: ConversationV2SyncState,
  delta: ConversationProjectionDelta,
): ConversationV2SyncState {
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

export function applyConversationV2DeltasToProjectionMap(
  current: Map<string, SessionProjection>,
  deltas: readonly ConversationProjectionDelta[],
): Map<string, SessionProjection> {
  let next: Map<string, SessionProjection> | null = null;
  for (const delta of deltas) {
    const projection = (next ?? current).get(delta.sessionId);
    if (!projection?.conversationV2) {
      continue;
    }
    const conversationV2 = applyDeltaToConversation(projection.conversationV2, delta);
    if (conversationV2 === projection.conversationV2) {
      continue;
    }
    next ??= new Map(current);
    next.set(delta.sessionId, { ...projection, conversationV2 });
  }
  return next ?? current;
}

async function performLoadTurns(
  deps: ConversationV2Deps,
  sessionId: string,
  mode: "initial" | "refresh" | "older",
  options: { liveOnly?: boolean } = {},
): Promise<boolean> {
  const projection = deps.get().projections.get(sessionId);
  if (!projection) {
    return false;
  }
  const current = projection.conversationV2 ?? initialConversationV2SyncState();
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
        const pageTurns =
          mode === "initial"
            ? response.turns
            : mode === "older"
              ? mergeOlderTurns(value.turns, response.turns)
              : mergeNewerTurns(value.turns, response.turns);
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
  deps: ConversationV2Deps,
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

export function ensureConversationV2LoadedCommand(
  deps: ConversationV2Deps,
  sessionId: string,
): Promise<boolean> {
  return loadTurns(deps, sessionId, "initial");
}

export function initializeLiveConversationV2Command(
  deps: ConversationV2Deps,
  sessionId: string,
): Promise<boolean> {
  return loadTurns(deps, sessionId, "initial", { liveOnly: true });
}

export function refreshConversationV2Command(
  deps: ConversationV2Deps,
  sessionId: string,
): Promise<boolean> {
  return loadTurns(deps, sessionId, "refresh");
}

export function loadOlderConversationV2Command(
  deps: ConversationV2Deps,
  sessionId: string,
): Promise<boolean> {
  return loadTurns(deps, sessionId, "older");
}

function findItemAddress(
  projection: SessionProjection,
  itemId: string,
): { itemId: string; turnId: string; providerTurnId: string; providerItemId: string } | null {
  for (const turn of projection.conversationV2?.turns ?? []) {
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

export function conversationV2LegacyDetailId(
  projection: SessionProjection,
  kind: "tool_call" | "observation",
  itemId: string,
): string {
  for (const turn of projection.conversationV2?.turns ?? []) {
    for (const item of turn.items) {
      if (item.id !== itemId) {
        continue;
      }
      if (kind === "tool_call" && item.content.kind === "tool") {
        return item.content.toolCall.id;
      }
      if (kind === "observation" && item.content.kind === "observation") {
        return item.content.observation.id;
      }
    }
  }
  return itemId;
}

function applyItemDetail(
  current: ConversationV2SyncState,
  response: ConversationItemDetailResponse,
): ConversationV2SyncState {
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

export async function loadConversationV2ItemDetailCommand(
  deps: ConversationV2Deps,
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
  current: ConversationV2SyncState,
  response: ConversationTurnDetailResponse,
): ConversationV2SyncState {
  return {
    ...current,
    turns: current.turns.map((turn) => {
      if (turn.id !== response.turnId) {
        return turn;
      }
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
      const hydratedIds = new Set(hydratedProcess.map((item) => item.id));
      const hydratedProviderIds = new Set(
        hydratedProcess
          .map((item) => item.providerItemId)
          .filter((value): value is string => Boolean(value)),
      );
      const liveOnlyProcess = turn.items.filter(
        (item) =>
          item.role === "process" &&
          !hydratedIds.has(item.id) &&
          !(item.providerItemId && hydratedProviderIds.has(item.providerItemId)),
      );
      const leading = turn.items.filter(
        (item) => item.role !== "process" && item.role !== "final",
      );
      const final = turn.items.filter((item) => item.role === "final");
      const items = [...leading, ...hydratedProcess, ...liveOnlyProcess, ...final];
      return {
        ...turn,
        items,
        itemsView: "full",
        failedItemCount: items.filter((item) => item.status === "failed").length,
        revision: Math.max(turn.revision, response.turn.revision) + 1,
      };
    }),
    revision: current.revision + 1,
    approximateBytes:
      (current.approximateBytes ?? 0) + (response.approximateBytes ?? 0),
    lastError: null,
  };
}

export async function loadConversationV2TurnDetailCommand(
  deps: ConversationV2Deps,
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
    const turn = projection?.conversationV2?.turns.find((candidate) => candidate.id === turnId);
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

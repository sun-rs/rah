import type { RahEvent, TimelineIdentity, TimelineItem, TimelineTurnIdentity } from "@rah/runtime-protocol";
import type { ProviderActivity } from "./provider-activity";

type TimelineProviderActivity = Extract<
  ProviderActivity,
  { type: "timeline_item" | "timeline_item_updated" }
>;

type TurnLifecycleActivity = Extract<
  ProviderActivity,
  { type: "turn_completed" | "turn_failed" | "turn_canceled" }
>;

interface TimelineLedgerEntry {
  item: TimelineItem;
  turnId?: string;
}

interface TurnLifecycleReconciliation<T extends TurnLifecycleActivity> {
  activity: T;
  identity?: TimelineTurnIdentity;
}

interface TimelineLedgerState {
  itemsBySession: Map<string, Map<string, TimelineLedgerEntry>>;
  turnIdentitiesBySession: Map<string, Map<string, TimelineTurnIdentity>>;
  terminalLifecycleKeysBySession: Map<string, Set<string>>;
}

const MAX_LEDGER_ITEMS_PER_SESSION = 50_000;
const MAX_TERMINAL_LIFECYCLE_KEYS_PER_SESSION = 50_000;

let statesByServices = new WeakMap<object, TimelineLedgerState>();

export function reconcileTimelineActivity(
  services: object,
  sessionId: string,
  activity: TimelineProviderActivity,
): TimelineProviderActivity | null {
  registerTimelineTurnIdentity(services, sessionId, activity.turnId, activity.identity);
  const canonicalItemId = activity.identity?.canonicalItemId;
  if (canonicalItemId === undefined) {
    return activity;
  }

  const sessionLedger = sessionLedgerForServices(services, sessionId);
  const existing = sessionLedger.get(canonicalItemId);
  const incoming: TimelineLedgerEntry = {
    item: activity.item,
    ...(activity.turnId !== undefined ? { turnId: activity.turnId } : {}),
  };

  if (existing === undefined) {
    sessionLedger.set(canonicalItemId, incoming);
    pruneOldestLedgerItems(sessionLedger);
    return activity;
  }

  if (ledgerEntriesEqual(existing, incoming)) {
    return null;
  }

  sessionLedger.set(canonicalItemId, incoming);
  return {
    ...activity,
    type: "timeline_item_updated",
  };
}

export function reconcileTurnLifecycleActivity<T extends TurnLifecycleActivity>(
  services: object,
  sessionId: string,
  activity: T,
): TurnLifecycleReconciliation<T> | null {
  const identity = activity.identity ?? turnIdentityForTurnId(services, sessionId, activity.turnId);
  const dedupeKey = `${activity.type}:${
    identity?.canonicalTurnId ?? `legacy:${activity.turnId}`
  }`;
  const terminalKeys = terminalLifecycleKeysForServices(services, sessionId);
  if (terminalKeys.has(dedupeKey)) {
    return null;
  }
  terminalKeys.add(dedupeKey);
  pruneOldestSetItems(terminalKeys, MAX_TERMINAL_LIFECYCLE_KEYS_PER_SESSION);
  return {
    activity,
    ...(identity !== undefined ? { identity } : {}),
  };
}

export function normalizeTranscriptEvents(events: readonly RahEvent[]): RahEvent[] {
  const turnIdentitiesByTurnId = new Map<string, TimelineTurnIdentity>();
  for (const event of events) {
    if (
      (event.type === "timeline.item.added" || event.type === "timeline.item.updated") &&
      event.turnId !== undefined &&
      event.payload.identity !== undefined
    ) {
      turnIdentitiesByTurnId.set(
        event.turnId,
        timelineTurnIdentityFromTimelineIdentity(event.payload.identity),
      );
    }
  }

  const canonicalItemIndexes = new Map<string, number>();
  const seenTerminalLifecycleKeys = new Set<string>();
  const normalized: RahEvent[] = [];

  for (const event of events) {
    if (
      (event.type === "timeline.item.added" || event.type === "timeline.item.updated") &&
      typeof event.payload.identity?.canonicalItemId === "string"
    ) {
      const existingIndex = canonicalItemIndexes.get(event.payload.identity.canonicalItemId);
      if (existingIndex !== undefined) {
        if (event.type === "timeline.item.updated") {
          normalized[existingIndex] = event;
        }
        continue;
      }
      canonicalItemIndexes.set(event.payload.identity.canonicalItemId, normalized.length);
      normalized.push(event);
      continue;
    }

    if (
      event.type === "turn.completed" ||
      event.type === "turn.failed" ||
      event.type === "turn.canceled"
    ) {
      const identity =
        event.payload.identity ??
        (event.turnId !== undefined ? turnIdentitiesByTurnId.get(event.turnId) : undefined);
      const dedupeKey = `${event.type}:${
        identity?.canonicalTurnId ?? `legacy:${event.turnId ?? event.seq}`
      }`;
      if (seenTerminalLifecycleKeys.has(dedupeKey)) {
        continue;
      }
      seenTerminalLifecycleKeys.add(dedupeKey);
      normalized.push(
        identity !== undefined
          ? {
              ...event,
              payload: {
                ...event.payload,
                identity,
              },
            } as RahEvent
          : event,
      );
      continue;
    }

    normalized.push(event);
  }

  return normalized;
}

export function resetTimelineReconcilerForTests(): void {
  statesByServices = new WeakMap<object, TimelineLedgerState>();
}

function stateKeyForServices(services: object): object {
  const candidate = services as { eventBus?: unknown };
  if (candidate.eventBus && typeof candidate.eventBus === "object") {
    return candidate.eventBus;
  }
  return services;
}

function sessionLedgerForServices(
  services: object,
  sessionId: string,
): Map<string, TimelineLedgerEntry> {
  const key = stateKeyForServices(services);
  let state = statesByServices.get(key);
  if (state === undefined) {
    state = {
      itemsBySession: new Map(),
      turnIdentitiesBySession: new Map(),
      terminalLifecycleKeysBySession: new Map(),
    };
    statesByServices.set(key, state);
  }
  let sessionLedger = state.itemsBySession.get(sessionId);
  if (sessionLedger === undefined) {
    sessionLedger = new Map<string, TimelineLedgerEntry>();
    state.itemsBySession.set(sessionId, sessionLedger);
  }
  return sessionLedger;
}

function turnIdentitiesForServices(
  services: object,
  sessionId: string,
): Map<string, TimelineTurnIdentity> {
  const key = stateKeyForServices(services);
  let state = statesByServices.get(key);
  if (state === undefined) {
    state = {
      itemsBySession: new Map(),
      turnIdentitiesBySession: new Map(),
      terminalLifecycleKeysBySession: new Map(),
    };
    statesByServices.set(key, state);
  }
  let turnIdentities = state.turnIdentitiesBySession.get(sessionId);
  if (turnIdentities === undefined) {
    turnIdentities = new Map<string, TimelineTurnIdentity>();
    state.turnIdentitiesBySession.set(sessionId, turnIdentities);
  }
  return turnIdentities;
}

function terminalLifecycleKeysForServices(
  services: object,
  sessionId: string,
): Set<string> {
  const key = stateKeyForServices(services);
  let state = statesByServices.get(key);
  if (state === undefined) {
    state = {
      itemsBySession: new Map(),
      turnIdentitiesBySession: new Map(),
      terminalLifecycleKeysBySession: new Map(),
    };
    statesByServices.set(key, state);
  }
  let keys = state.terminalLifecycleKeysBySession.get(sessionId);
  if (keys === undefined) {
    keys = new Set<string>();
    state.terminalLifecycleKeysBySession.set(sessionId, keys);
  }
  return keys;
}

function registerTimelineTurnIdentity(
  services: object,
  sessionId: string,
  turnId: string | undefined,
  identity: TimelineIdentity | undefined,
): void {
  if (turnId === undefined || identity === undefined) {
    return;
  }
  turnIdentitiesForServices(services, sessionId).set(
    turnId,
    timelineTurnIdentityFromTimelineIdentity(identity),
  );
}

function turnIdentityForTurnId(
  services: object,
  sessionId: string,
  turnId: string,
): TimelineTurnIdentity | undefined {
  return turnIdentitiesForServices(services, sessionId).get(turnId);
}

function timelineTurnIdentityFromTimelineIdentity(identity: TimelineIdentity): TimelineTurnIdentity {
  return {
    canonicalTurnId: identity.canonicalTurnId,
    provider: identity.provider,
    ...(identity.providerSessionId !== undefined ? { providerSessionId: identity.providerSessionId } : {}),
    turnKey: identity.turnKey,
    origin: identity.origin,
    confidence: identity.confidence,
  };
}

function pruneOldestLedgerItems(ledger: Map<string, TimelineLedgerEntry>): void {
  while (ledger.size > MAX_LEDGER_ITEMS_PER_SESSION) {
    const oldestKey = ledger.keys().next().value as string | undefined;
    if (oldestKey === undefined) {
      return;
    }
    ledger.delete(oldestKey);
  }
}

function pruneOldestSetItems(set: Set<string>, max: number): void {
  while (set.size > max) {
    const oldestKey = set.keys().next().value as string | undefined;
    if (oldestKey === undefined) {
      return;
    }
    set.delete(oldestKey);
  }
}

function ledgerEntriesEqual(left: TimelineLedgerEntry, right: TimelineLedgerEntry): boolean {
  return left.turnId === right.turnId && stableJson(left.item) === stableJson(right.item);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${stableJson(nested)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

import type { TimelineItem } from "@rah/runtime-protocol";
import type { ProviderActivity } from "./provider-activity";

type TimelineProviderActivity = Extract<
  ProviderActivity,
  { type: "timeline_item" | "timeline_item_updated" }
>;

interface TimelineLedgerEntry {
  item: TimelineItem;
  turnId?: string;
}

interface TimelineLedgerState {
  itemsBySession: Map<string, Map<string, TimelineLedgerEntry>>;
}

const MAX_LEDGER_ITEMS_PER_SESSION = 50_000;

let statesByServices = new WeakMap<object, TimelineLedgerState>();

export function reconcileTimelineActivity(
  services: object,
  sessionId: string,
  activity: TimelineProviderActivity,
): TimelineProviderActivity | null {
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

export function resetTimelineReconcilerForTests(): void {
  statesByServices = new WeakMap<object, TimelineLedgerState>();
}

function sessionLedgerForServices(
  services: object,
  sessionId: string,
): Map<string, TimelineLedgerEntry> {
  let state = statesByServices.get(services);
  if (state === undefined) {
    state = { itemsBySession: new Map() };
    statesByServices.set(services, state);
  }
  let sessionLedger = state.itemsBySession.get(sessionId);
  if (sessionLedger === undefined) {
    sessionLedger = new Map<string, TimelineLedgerEntry>();
    state.itemsBySession.set(sessionId, sessionLedger);
  }
  return sessionLedger;
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

import type { SessionSummary } from "@rah/runtime-protocol";
import type { FeedEntry, SessionProjection } from "./types";
import { conversationItemFeedKey } from "./conversation-feed";

/**
 * Unread is deliberately owned by one browser/PWA storage container. A final
 * reply that was read on macOS may therefore remain unread on iOS, allowing
 * each client to grant its own one-shot reply-start navigation. Do not move
 * this cursor into daemon/account state without changing that product contract.
 */
const SESSION_LAST_SEEN_AT_KEY = "rah.sessionLastSeenAt.v1";
const READ_STATE_INITIALIZED_AT_KEY = "__rahReadStateInitializedAt";
const MAX_STORED_SESSION_READ_KEYS = 1_000;
const READ_EPSILON_MS = 250;

type StoredReadState = Record<string, number>;

function getBrowserStorage(): Storage | null {
  try {
    if (typeof globalThis.window === "undefined") {
      return null;
    }
    return globalThis.window.localStorage ?? null;
  } catch {
    return null;
  }
}

export function readSessionReadState(): StoredReadState | null {
  const storage = getBrowserStorage();
  if (!storage) {
    return null;
  }
  let raw: string | null;
  try {
    raw = storage.getItem(SESSION_LAST_SEEN_AT_KEY);
  } catch {
    return null;
  }
  if (!raw) {
    return {};
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    const state: StoredReadState = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "number" && Number.isFinite(value) && value > 0) {
        state[key] = value;
      }
    }
    return state;
  } catch {
    return null;
  }
}

export function writeSessionReadState(state: StoredReadState): void {
  const storage = getBrowserStorage();
  if (!storage) {
    return;
  }
  try {
    const entries = Object.entries(state)
      .filter(([, value]) => Number.isFinite(value) && value > 0)
      .sort((left, right) => right[1] - left[1])
      .slice(0, MAX_STORED_SESSION_READ_KEYS);
    storage.setItem(
      SESSION_LAST_SEEN_AT_KEY,
      JSON.stringify(Object.fromEntries(entries)),
    );
  } catch {
    // Last-seen state is a local convenience; storage failures should not affect chat.
  }
}

function readStateInitializedAtMs(state: Readonly<StoredReadState>): number | null {
  const initializedAtMs = state[READ_STATE_INITIALIZED_AT_KEY];
  return typeof initializedAtMs === "number" &&
    Number.isFinite(initializedAtMs) &&
    initializedAtMs > 0
    ? initializedAtMs
    : null;
}

export function ensureSessionReadStateInitialized(
  state: StoredReadState,
  nowMs = Date.now(),
): boolean {
  if (readStateInitializedAtMs(state) !== null) {
    return false;
  }
  if (!Number.isFinite(nowMs) || nowMs <= 0) {
    return false;
  }
  state[READ_STATE_INITIALIZED_AT_KEY] = nowMs;
  return true;
}

function parseTimestampMs(value: string | undefined): number | null {
  if (!value) {
    return null;
  }
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

export function sessionReadKey(summary: SessionSummary): string {
  const providerSessionId = summary.session.providerSessionId?.trim();
  if (providerSessionId) {
    return `provider:${summary.session.provider}:${providerSessionId}`;
  }
  return `runtime:${summary.session.id}`;
}

function unreadEntryTimestampMs(entry: FeedEntry): number | null {
  if (entry.kind === "timeline") {
    if (
      entry.item.kind !== "assistant_message" ||
      entry.item.phase !== "final_answer"
    ) {
      return null;
    }
    return parseTimestampMs(entry.ts);
  }
  return null;
}

/**
 * Returns the stable feed identity for the newest canonical final reply.
 * Sidebar selection captures this before selecting the Session clears its
 * unread marker, so Chat can honor the blue-dot entry contract without
 * consulting mutable read state after navigation.
 */
export function latestFinalReplyEntryKey(
  projection: SessionProjection,
): string | null {
  return latestFinalReplyNavigationTarget(projection)?.entryKey ?? null;
}

export function latestFinalReplyNavigationTarget(
  projection: SessionProjection,
): {
  entryKey: string | null;
  turnId: string | null;
  replyTimestampMs: number | null;
} | null {
  const latestTerminalEvent = [...projection.events]
    .reverse()
    .find((event) =>
      event.type === "turn.completed" ||
      event.type === "turn.failed" ||
      event.type === "turn.canceled"
    );
  const completedTurnId = latestTerminalEvent?.type === "turn.completed"
    ? latestTerminalEvent.payload.identity?.canonicalTurnId ?? latestTerminalEvent.turnId ?? null
    : null;
  const terminalAtMs = latestTerminalEvent
    ? parseTimestampMs(latestTerminalEvent.payload.completedAt ?? latestTerminalEvent.ts)
    : null;
  let bestEntryKey: string | null = null;
  let bestTurnId: string | null = null;
  let completedEntryKey: string | null = null;
  let bestTimestampMs: number | null = null;
  let bestOrder = -1;
  let order = 0;
  const consider = (
    entryKey: string,
    turnId: string | undefined,
    timestamp: string | undefined,
  ) => {
    const candidateTimestampMs = parseTimestampMs(timestamp);
    const candidateOrder = order++;
    if (completedTurnId && turnId === completedTurnId) {
      completedEntryKey = entryKey;
    }
    if (
      bestEntryKey === null ||
      (candidateTimestampMs !== null &&
        (bestTimestampMs === null || candidateTimestampMs > bestTimestampMs)) ||
      (candidateTimestampMs === bestTimestampMs && candidateOrder > bestOrder)
    ) {
      bestEntryKey = entryKey;
      bestTurnId = turnId ?? null;
      bestTimestampMs = candidateTimestampMs;
      bestOrder = candidateOrder;
    }
  };

  for (const entry of projection.feed) {
    if (
      entry.kind === "timeline" &&
      entry.item.kind === "assistant_message" &&
      entry.item.phase === "final_answer"
    ) {
      consider(
        entry.canonicalItemId
          ? conversationItemFeedKey(entry.canonicalItemId)
          : entry.key,
        entry.turnId,
        entry.ts,
      );
    }
  }
  for (const turn of projection.conversation?.turns ?? []) {
    const finalItem =
      (turn.finalAnswerItemId
        ? turn.items.find((item) => item.id === turn.finalAnswerItemId)
        : undefined) ?? [...turn.items].reverse().find((item) => item.role === "final");
    if (
      finalItem?.content.kind !== "timeline" ||
      finalItem.content.item.kind !== "assistant_message"
    ) {
      continue;
    }
    consider(
      conversationItemFeedKey(finalItem.id),
      turn.id,
      finalItem.completedAt ?? finalItem.startedAt ?? turn.completedAt ?? turn.startedAt,
    );
  }
  const terminalOwnsTarget = latestTerminalEvent &&
    (bestTimestampMs === null || terminalAtMs === null ||
      terminalAtMs + READ_EPSILON_MS >= bestTimestampMs);
  if (terminalOwnsTarget) {
    if (latestTerminalEvent.type !== "turn.completed") {
      return null;
    }
    return {
      entryKey: completedEntryKey,
      turnId: completedTurnId,
      replyTimestampMs: terminalAtMs,
    };
  }
  return bestEntryKey
    ? { entryKey: bestEntryKey, turnId: bestTurnId, replyTimestampMs: bestTimestampMs }
    : null;
}

export function latestSessionActivityTimestampMs(projection: SessionProjection): number | null {
  let latest = parseTimestampMs(projection.summary.session.updatedAt);
  for (const entry of projection.feed) {
    const entryMs = parseTimestampMs(entry.ts);
    if (entryMs !== null && (latest === null || entryMs > latest)) {
      latest = entryMs;
    }
  }
  return latest;
}

export function latestUnreadTimestampMs(projection: SessionProjection): number | null {
  let latest: number | null = null;
  for (const entry of projection.feed) {
    const entryMs = unreadEntryTimestampMs(entry);
    if (entryMs !== null && (latest === null || entryMs > latest)) {
      latest = entryMs;
    }
  }
  for (const turn of projection.conversation?.turns ?? []) {
    const hasFinalAnswer =
      Boolean(turn.finalAnswerItemId) ||
      turn.items.some(
        (item) =>
          item.role === "final" &&
          item.status !== "pending" &&
          item.status !== "running",
      );
    if (!hasFinalAnswer) {
      continue;
    }
    const turnMs = parseTimestampMs(
      turn.completedAt ??
        [...turn.items]
          .reverse()
          .find((item) => item.role === "final")
          ?.completedAt,
    );
    if (turnMs !== null && (latest === null || turnMs > latest)) {
      latest = turnMs;
    }
  }
  // `session.updatedAt` is lifecycle metadata, not conversation evidence.
  // Running-session heartbeats, attachment changes, and foreground recovery
  // all advance it, so using it here paints every background-running Session
  // blue even when no assistant reply was produced.
  return latest;
}

export function hasUnreadSinceReadState(
  projection: SessionProjection,
  state: Readonly<StoredReadState> | null,
): boolean {
  if (!state) {
    return false;
  }
  const latestUnreadAtMs = latestUnreadTimestampMs(projection);
  if (latestUnreadAtMs === null) {
    return false;
  }
  const seenAtMs =
    state[sessionReadKey(projection.summary)] ?? readStateInitializedAtMs(state);
  if (seenAtMs === null) {
    return false;
  }
  return latestUnreadAtMs > seenAtMs + READ_EPSILON_MS;
}

export function hasUnreadSinceLastSeen(projection: SessionProjection): boolean {
  return hasUnreadSinceReadState(projection, readSessionReadState());
}

export function markProjectionSeenInState(
  state: StoredReadState,
  projection: SessionProjection,
): boolean {
  const seenAtMs = latestSessionActivityTimestampMs(projection);
  if (seenAtMs === null) {
    return false;
  }
  const key = sessionReadKey(projection.summary);
  if ((state[key] ?? 0) >= seenAtMs) {
    return false;
  }
  state[key] = seenAtMs;
  return true;
}

export function markProjectionSeen(projection: SessionProjection): void {
  const state = readSessionReadState();
  if (!state) {
    return;
  }
  if (markProjectionSeenInState(state, projection)) {
    writeSessionReadState(state);
  }
}

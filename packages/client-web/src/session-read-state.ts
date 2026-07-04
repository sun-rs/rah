import type { SessionSummary } from "@rah/runtime-protocol";
import type { FeedEntry, SessionProjection } from "./types";

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
    if (entry.item.kind !== "assistant_message") {
      return null;
    }
    return parseTimestampMs(entry.ts);
  }
  if (entry.kind === "permission" || entry.kind === "notification") {
    return parseTimestampMs(entry.ts);
  }
  return null;
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
  if (latest !== null) {
    return latest;
  }
  if (projection.summary.session.status !== "running") {
    return null;
  }
  return parseTimestampMs(projection.summary.session.updatedAt);
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

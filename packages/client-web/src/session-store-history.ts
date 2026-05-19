import type { RahEvent, SessionSummary } from "@rah/runtime-protocol";
import {
  clearLastHistorySelection,
  writeLastHistorySelection,
} from "./history-selection";
import { isReadOnlyReplay } from "./session-capabilities";
import {
  applyEventToProjection,
  initialHistorySyncState,
  type FeedEntry,
  type SessionProjection,
} from "./types";

const PROVISIONAL_USER_ECHO_WINDOW_MS = 5_000;
const COMPOSITE_USER_ECHO_WINDOW_MS = 15_000;

type HistorySelectionState = Pick<
  {
    selectedSessionId: string | null;
    projections: Map<string, SessionProjection>;
    workspaceDir: string;
  },
  "selectedSessionId" | "projections" | "workspaceDir"
>;

export function syncLastHistorySelectionFromState(state: HistorySelectionState) {
  const selectedSummary = state.selectedSessionId
    ? state.projections.get(state.selectedSessionId)?.summary ?? null
    : null;
  if (!selectedSummary) {
    return;
  }
  if (selectedSummary.session.providerSessionId && isReadOnlyReplay(selectedSummary)) {
    const historyWorkspaceDir =
      selectedSummary.session.rootDir || selectedSummary.session.cwd || state.workspaceDir;
    writeLastHistorySelection({
      provider: selectedSummary.session.provider,
      providerSessionId: selectedSummary.session.providerSessionId,
      ...(historyWorkspaceDir ? { workspaceDir: historyWorkspaceDir } : {}),
    });
    return;
  }
  clearLastHistorySelection();
}

export function replayEventsIntoProjection(
  summary: SessionSummary,
  events: RahEvent[],
): SessionProjection {
  let projection: SessionProjection = {
    summary,
    feed: [],
    events: [],
    lastSeq: 0,
    history: initialHistorySyncState(),
  };
  for (const event of [...events].sort((a, b) => a.seq - b.seq)) {
    projection = applyEventToProjection(projection, event);
  }
  return projection;
}

function feedEntriesShareStableIdentity(
  left: FeedEntry,
  right: FeedEntry,
  context?: {
    leftFeed: readonly FeedEntry[];
    rightFeed: readonly FeedEntry[];
  },
): boolean {
  return (
    feedEntriesShareTimelineIdentity(left, right) ||
    feedEntriesShareInterruptNoticeIdentity(left, right, context)
  );
}

function feedEntriesShareTimelineIdentity(left: FeedEntry, right: FeedEntry): boolean {
  if (left.kind !== right.kind) {
    return false;
  }
  if (left.kind !== "timeline" || right.kind !== "timeline") {
    return false;
  }
  const leftCanonicalItemId = left.canonicalItemId;
  const rightCanonicalItemId = right.canonicalItemId;
  if (leftCanonicalItemId !== undefined || rightCanonicalItemId !== undefined) {
    if (leftCanonicalItemId !== undefined && rightCanonicalItemId !== undefined) {
      return leftCanonicalItemId === rightCanonicalItemId;
    }
    return (
      entriesShareOptimisticUserPlaceholder(left, right) ||
      entriesShareProvisionalUserEcho(left, right)
    );
  }
  if (entriesShareOptimisticUserPlaceholder(left, right)) {
    return true;
  }
  if (left.item.kind !== right.item.kind) {
    return false;
  }
  const leftClientMessageId = readTimelineClientMessageId(left.item);
  const rightClientMessageId = readTimelineClientMessageId(right.item);
  if (leftClientMessageId !== undefined || rightClientMessageId !== undefined) {
    return (
      (leftClientMessageId !== undefined && leftClientMessageId === rightClientMessageId) ||
      entriesShareProvisionalUserEcho(left, right)
    );
  }
  const leftMessageId = readTimelineMessageId(left.item);
  const rightMessageId = readTimelineMessageId(right.item);
  if (leftMessageId !== undefined || rightMessageId !== undefined) {
    return (
      (leftMessageId !== undefined && leftMessageId === rightMessageId) ||
      entriesShareWeakUserEcho(left, right)
    );
  }
  if (entriesShareWeakUserEcho(left, right)) {
    return true;
  }
  return false;
}

function feedEntriesShareInterruptNoticeIdentity(
  left: FeedEntry,
  right: FeedEntry,
  context:
    | {
        leftFeed: readonly FeedEntry[];
        rightFeed: readonly FeedEntry[];
      }
    | undefined,
): boolean {
  if (
    left.kind !== "notification" ||
    right.kind !== "notification" ||
    !isInterruptNotice(left) ||
    !isInterruptNotice(right)
  ) {
    return false;
  }
  if (
    left.canonicalTurnId !== undefined &&
    right.canonicalTurnId !== undefined &&
    left.canonicalTurnId === right.canonicalTurnId
  ) {
    return true;
  }
  if (left.turnId !== undefined && right.turnId !== undefined && left.turnId === right.turnId) {
    return true;
  }
  if (
    left.interruptAnchorKey !== undefined &&
    right.interruptAnchorKey !== undefined &&
    left.interruptAnchorKey === right.interruptAnchorKey
  ) {
    return true;
  }
  if (
    context === undefined ||
    left.interruptAnchorKey === undefined ||
    right.interruptAnchorKey === undefined
  ) {
    return false;
  }
  const leftAnchor = context.leftFeed.find((entry) => entry.key === left.interruptAnchorKey);
  const rightAnchor = context.rightFeed.find((entry) => entry.key === right.interruptAnchorKey);
  if (leftAnchor === undefined || rightAnchor === undefined) {
    return false;
  }
  return feedEntriesShareTimelineIdentity(leftAnchor, rightAnchor);
}

function isInterruptNotice(entry: Extract<FeedEntry, { kind: "notification" }>): boolean {
  return (
    entry.title === "Conversation interrupted" &&
    entry.body === "The previous turn was interrupted."
  );
}

function readTimelineMessageId(
  item: Extract<FeedEntry, { kind: "timeline" }>["item"],
): string | undefined {
  if (item.kind === "user_message" || item.kind === "assistant_message") {
    return item.messageId;
  }
  return undefined;
}

function readTimelineClientMessageId(
  item: Extract<FeedEntry, { kind: "timeline" }>["item"],
): string | undefined {
  return item.kind === "user_message" ? item.clientMessageId : undefined;
}

function entriesShareOptimisticUserPlaceholder(left: FeedEntry, right: FeedEntry): boolean {
  if (left.kind !== "timeline" || right.kind !== "timeline") {
    return false;
  }
  if (left.item.kind !== "user_message" || right.item.kind !== "user_message") {
    return false;
  }
  const leftOptimistic = left.key.startsWith("optimistic:user:");
  const rightOptimistic = right.key.startsWith("optimistic:user:");
  if (leftOptimistic === rightOptimistic) {
    return false;
  }
  const leftClientMessageId = left.item.clientMessageId;
  const rightClientMessageId = right.item.clientMessageId;
  if (leftClientMessageId !== undefined && rightClientMessageId !== undefined) {
    return leftClientMessageId === rightClientMessageId;
  }
  return left.item.text === right.item.text;
}

function entriesShareWeakUserEcho(left: FeedEntry, right: FeedEntry): boolean {
  if (left.kind !== "timeline" || right.kind !== "timeline") {
    return false;
  }
  if (left.item.kind !== "user_message" || right.item.kind !== "user_message") {
    return false;
  }
  if (left.item.text !== right.item.text) {
    return false;
  }
  return (
    (isWeakUserEcho(left) && isAuthoritativeUserEcho(right)) ||
    (isWeakUserEcho(right) && isAuthoritativeUserEcho(left))
  );
}

function entriesShareProvisionalUserEcho(left: FeedEntry, right: FeedEntry): boolean {
  if (left.kind !== "timeline" || right.kind !== "timeline") {
    return false;
  }
  if (left.item.kind !== "user_message" || right.item.kind !== "user_message") {
    return false;
  }
  if (left.item.text !== right.item.text) {
    return false;
  }
  if (
    !(
      (isProvisionalUserEcho(left) && isAuthoritativeUserEcho(right)) ||
      (isProvisionalUserEcho(right) && isAuthoritativeUserEcho(left))
    )
  ) {
    return false;
  }
  return timelineTimestampsWithinMs(left.ts, right.ts, PROVISIONAL_USER_ECHO_WINDOW_MS);
}

function isWeakUserEcho(entry: Extract<FeedEntry, { kind: "timeline" }>): boolean {
  return (
    entry.item.kind === "user_message" &&
    entry.canonicalItemId === undefined &&
    entry.item.messageId === undefined &&
    entry.item.clientMessageId === undefined
  );
}

function isProvisionalUserEcho(entry: Extract<FeedEntry, { kind: "timeline" }>): boolean {
  return (
    entry.item.kind === "user_message" &&
    entry.canonicalItemId === undefined &&
    entry.item.messageId === undefined &&
    entry.item.clientMessageId !== undefined
  );
}

function isAuthoritativeUserEcho(entry: Extract<FeedEntry, { kind: "timeline" }>): boolean {
  return (
    entry.item.kind === "user_message" &&
    (entry.canonicalItemId !== undefined || entry.item.messageId !== undefined)
  );
}

function timelineTimestampsWithinMs(leftTs: string, rightTs: string, maxMs: number): boolean {
  const leftMs = Date.parse(leftTs);
  const rightMs = Date.parse(rightTs);
  if (!Number.isFinite(leftMs) || !Number.isFinite(rightMs)) {
    return false;
  }
  return Math.abs(leftMs - rightMs) <= maxMs;
}

export function prependHistoryPage(
  projection: SessionProjection,
  events: RahEvent[],
  options?: { nextBeforeTs?: string; nextCursor?: string },
): SessionProjection {
  if (events.length === 0) {
    return {
      ...projection,
      history: {
        ...projection.history,
        phase: "ready",
        nextCursor: options?.nextCursor ?? null,
        nextBeforeTs: options?.nextBeforeTs ?? null,
        authoritativeApplied: true,
        lastError: null,
      },
    };
  }

  const historyProjection = replayEventsIntoProjection(projection.summary, events);
  if (!projection.history.authoritativeApplied) {
    return {
      ...projection,
      feed: mergeLatestHistoryFeed(projection.feed, historyProjection.feed),
      history: {
        ...projection.history,
        phase: "ready",
        nextCursor: options?.nextCursor ?? null,
        nextBeforeTs: options?.nextBeforeTs ?? null,
        authoritativeApplied: true,
        lastError: null,
      },
    };
  }

  const nextFeed = [...projection.feed];
  const currentKeyIndex = new Map(
    nextFeed.map((entry, index) => [entry.key, index] as const),
  );
  const matchedCurrentIndexes = new Set<number>();
  const prepend = historyProjection.feed.filter((entry) => {
    const existingIndex = currentKeyIndex.get(entry.key);
    if (existingIndex !== undefined) {
      nextFeed[existingIndex] = entry;
      matchedCurrentIndexes.add(existingIndex);
      return false;
    }
    const identityIndex = nextFeed.findIndex(
      (current, index) =>
        !matchedCurrentIndexes.has(index) &&
        feedEntriesShareStableIdentity(current, entry, {
          leftFeed: nextFeed,
          rightFeed: historyProjection.feed,
        }),
    );
    if (identityIndex >= 0) {
      nextFeed[identityIndex] = entry;
      matchedCurrentIndexes.add(identityIndex);
      return false;
    }
    return true;
  });

  return {
    ...projection,
    feed: [...prepend, ...nextFeed],
    history: {
      ...projection.history,
      phase: "ready",
      nextCursor: options?.nextCursor ?? null,
      nextBeforeTs: options?.nextBeforeTs ?? null,
      authoritativeApplied: true,
      lastError: null,
    },
  };
}

export function mergeLatestHistoryPage(
  projection: SessionProjection,
  events: RahEvent[],
  options?: { nextBeforeTs?: string; nextCursor?: string },
): SessionProjection {
  if (events.length === 0) {
    return {
      ...projection,
      history: {
        ...projection.history,
        phase: "ready",
        nextCursor: options?.nextCursor ?? projection.history.nextCursor,
        nextBeforeTs: options?.nextBeforeTs ?? projection.history.nextBeforeTs,
        authoritativeApplied: projection.history.authoritativeApplied,
        lastError: null,
      },
    };
  }

  const historyProjection = replayEventsIntoProjection(projection.summary, events);
  return {
    ...projection,
    feed: mergeLatestHistoryFeed(projection.feed, historyProjection.feed),
    history: {
      ...projection.history,
      phase: "ready",
      nextCursor: options?.nextCursor ?? projection.history.nextCursor,
      nextBeforeTs: options?.nextBeforeTs ?? projection.history.nextBeforeTs,
      authoritativeApplied: true,
      lastError: null,
    },
  };
}

function mergeLatestHistoryFeed(
  currentFeed: FeedEntry[],
  historyFeed: FeedEntry[],
): FeedEntry[] {
  const nextFeed = [...historyFeed];
  const currentKeyIndex = new Map(
    nextFeed.map((entry, index) => [entry.key, index] as const),
  );
  const matchedHistoryIndexes = new Set<number>();
  const latestHistoryMs = latestFeedTimestampMs(nextFeed);
  const compositeCoveredOptimisticKeys = findCompositeCoveredOptimisticKeys(
    currentFeed,
    historyFeed,
  );

  for (const current of currentFeed) {
    const existingIndex = currentKeyIndex.get(current.key);
    if (existingIndex !== undefined) {
      matchedHistoryIndexes.add(existingIndex);
      continue;
    }
    const identityIndex = nextFeed.findIndex(
      (historyEntry, index) =>
        !matchedHistoryIndexes.has(index) &&
        feedEntriesShareStableIdentity(historyEntry, current, {
          leftFeed: nextFeed,
          rightFeed: currentFeed,
        }),
    );
    if (identityIndex >= 0) {
      matchedHistoryIndexes.add(identityIndex);
      continue;
    }
    if (isOptimisticPlaceholderCoveredByHistory(current, nextFeed, latestHistoryMs)) {
      continue;
    }
    if (compositeCoveredOptimisticKeys.has(current.key)) {
      continue;
    }
    nextFeed.push(current);
  }

  return nextFeed;
}

function findCompositeCoveredOptimisticKeys(
  currentFeed: readonly FeedEntry[],
  historyFeed: readonly FeedEntry[],
): Set<string> {
  const covered = new Set<string>();
  const candidates = currentFeed
    .filter(isOptimisticUserPlaceholder)
    .map((entry) => ({ entry, tsMs: Date.parse(entry.ts) }))
    .filter(({ tsMs }) => Number.isFinite(tsMs));
  if (candidates.length < 2) {
    return covered;
  }

  for (const historyEntry of historyFeed) {
    if (!isAuthoritativeUserHistoryEntry(historyEntry) || historyEntry.sourceProvider !== "gemini") {
      continue;
    }
    const historyText = historyEntry.item.text;
    if (!historyText.includes("\n\n")) {
      continue;
    }
    const historyMs = Date.parse(historyEntry.ts);
    if (!Number.isFinite(historyMs)) {
      continue;
    }
    for (let start = 0; start < candidates.length; start += 1) {
      const keys: string[] = [];
      const parts: string[] = [];
      for (let cursor = start; cursor < candidates.length; cursor += 1) {
        const candidate = candidates[cursor]!;
        if (Math.abs(candidate.tsMs - historyMs) > COMPOSITE_USER_ECHO_WINDOW_MS) {
          continue;
        }
        keys.push(candidate.entry.key);
        parts.push(candidate.entry.item.text);
        const joined = parts.join("\n\n");
        if (joined === historyText && keys.length > 1) {
          keys.forEach((key) => covered.add(key));
          break;
        }
        if (!historyText.startsWith(joined)) {
          break;
        }
      }
    }
  }
  return covered;
}

function isOptimisticPlaceholderCoveredByHistory(
  current: FeedEntry,
  historyFeed: readonly FeedEntry[],
  latestHistoryMs: number | undefined,
): boolean {
  if (
    !isOptimisticUserPlaceholder(current)
  ) {
    return false;
  }
  const currentMs = Date.parse(current.ts);
  if (!Number.isFinite(currentMs)) {
    return false;
  }
  if (latestHistoryMs !== undefined && currentMs > latestHistoryMs) {
    return false;
  }
  return historyFeed.some((historyEntry) => {
    if (!feedEntriesShareTimelineIdentity(historyEntry, current)) {
      return false;
    }
    return true;
  });
}

function isOptimisticUserPlaceholder(
  entry: FeedEntry,
): entry is Extract<FeedEntry, { kind: "timeline" }> & {
  item: Extract<FeedEntry, { kind: "timeline" }>["item"] & { kind: "user_message" };
} {
  return (
    entry.kind === "timeline" &&
    entry.item.kind === "user_message" &&
    entry.key.startsWith("optimistic:user:")
  );
}

function isAuthoritativeUserHistoryEntry(
  entry: FeedEntry,
): entry is Extract<FeedEntry, { kind: "timeline" }> & {
  item: Extract<FeedEntry, { kind: "timeline" }>["item"] & { kind: "user_message" };
} {
  return (
    entry.kind === "timeline" &&
    entry.item.kind === "user_message" &&
    (entry.canonicalItemId !== undefined || entry.item.messageId !== undefined)
  );
}

function latestFeedTimestampMs(feed: readonly FeedEntry[]): number | undefined {
  let latest: number | undefined;
  for (const entry of feed) {
    const value = Date.parse(entry.ts);
    if (!Number.isFinite(value)) {
      continue;
    }
    if (latest === undefined || value > latest) {
      latest = value;
    }
  }
  return latest;
}

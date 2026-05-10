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
    return entriesShareOptimisticUserPlaceholder(left, right);
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
    return leftClientMessageId !== undefined && leftClientMessageId === rightClientMessageId;
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

function isWeakUserEcho(entry: Extract<FeedEntry, { kind: "timeline" }>): boolean {
  return (
    entry.item.kind === "user_message" &&
    entry.canonicalItemId === undefined &&
    entry.item.messageId === undefined &&
    entry.item.clientMessageId === undefined
  );
}

function isAuthoritativeUserEcho(entry: Extract<FeedEntry, { kind: "timeline" }>): boolean {
  return (
    entry.item.kind === "user_message" &&
    (entry.canonicalItemId !== undefined ||
      entry.item.messageId !== undefined ||
      entry.item.clientMessageId !== undefined)
  );
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
    nextFeed.push(current);
  }

  return nextFeed;
}

function isOptimisticPlaceholderCoveredByHistory(
  current: FeedEntry,
  historyFeed: readonly FeedEntry[],
  latestHistoryMs: number | undefined,
): boolean {
  if (
    current.kind !== "timeline" ||
    current.item.kind !== "user_message" ||
    !current.key.startsWith("optimistic:user:")
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

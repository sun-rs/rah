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

const LIVE_HISTORY_ECHO_WINDOW_MS = 60_000;

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
      entriesLookLikeSameOptimisticHistoryEcho(left, right) ||
      entriesLookLikeSameLiveHistoryEcho(left, right)
    );
  }
  if (entriesLookLikeSameOptimisticHistoryEcho(left, right)) {
    return true;
  }
  if (left.item.kind !== right.item.kind) {
    return false;
  }
  switch (left.item.kind) {
    case "user_message":
    case "assistant_message": {
      const leftItem = left.item;
      const rightItem = right.item as typeof leftItem;
      const leftMessageId = leftItem.messageId;
      const rightMessageId = rightItem.messageId;
      if (leftMessageId !== undefined && rightMessageId !== undefined) {
        return leftMessageId === rightMessageId;
      }
      if (entriesLookLikeSameLiveHistoryEcho(left, right)) {
        return true;
      }
      return Boolean(
        left.turnId &&
          right.turnId &&
          left.turnId === right.turnId &&
          leftItem.text === rightItem.text,
      );
    }
    case "reasoning": {
      const leftItem = left.item;
      const rightItem = right.item as typeof leftItem;
      if (entriesLookLikeSameLiveHistoryEcho(left, right)) {
        return true;
      }
      return Boolean(
        left.turnId &&
          right.turnId &&
          left.turnId === right.turnId &&
          leftItem.text === rightItem.text,
      );
    }
    default:
      return false;
  }
}

function isTurnCanceledNotice(
  entry: FeedEntry,
): entry is Extract<FeedEntry, { kind: "notification" }> {
  return (
    entry.kind === "notification" &&
    entry.title === "Conversation interrupted" &&
    entry.body === "The previous turn was interrupted."
  );
}

function findCancellationAnchor(
  feed: FeedEntry[],
  noticeIndex: number,
  notice: Extract<FeedEntry, { kind: "notification" }>,
): Extract<FeedEntry, { kind: "timeline" }> | null {
  if (notice.turnId) {
    for (let index = noticeIndex - 1; index >= 0; index -= 1) {
      const candidate = feed[index];
      if (candidate?.kind === "timeline" && candidate.turnId === notice.turnId) {
        return candidate;
      }
    }
  }
  for (let index = noticeIndex - 1; index >= 0; index -= 1) {
    const candidate = feed[index];
    if (candidate?.kind === "timeline") {
      return candidate;
    }
  }
  return null;
}

function turnCanceledNoticesShareIdentity(args: {
  leftFeed: FeedEntry[];
  leftIndex: number;
  rightFeed: FeedEntry[];
  rightIndex: number;
}): boolean {
  const left = args.leftFeed[args.leftIndex];
  const right = args.rightFeed[args.rightIndex];
  if (!left || !right || !isTurnCanceledNotice(left) || !isTurnCanceledNotice(right)) {
    return false;
  }
  if (left.key === right.key) {
    return true;
  }
  if (left.turnId && right.turnId && left.turnId === right.turnId) {
    return true;
  }
  const leftAnchor = findCancellationAnchor(args.leftFeed, args.leftIndex, left);
  const rightAnchor = findCancellationAnchor(args.rightFeed, args.rightIndex, right);
  if (leftAnchor && rightAnchor) {
    return feedEntriesShareTimelineIdentity(leftAnchor, rightAnchor);
  }
  return false;
}

function findEquivalentFeedEntryIndex(
  targetFeed: FeedEntry[],
  incomingEntry: FeedEntry,
  incomingFeed: FeedEntry[],
  incomingIndex: number,
): number {
  return targetFeed.findIndex((current, currentIndex) => {
    if (feedEntriesShareTimelineIdentity(current, incomingEntry)) {
      return true;
    }
    return turnCanceledNoticesShareIdentity({
      leftFeed: targetFeed,
      leftIndex: currentIndex,
      rightFeed: incomingFeed,
      rightIndex: incomingIndex,
    });
  });
}

function isHistoryTurnId(turnId: string | undefined): boolean {
  return turnId?.startsWith("history:") ?? false;
}

function readTimelineMessageId(
  item: Extract<FeedEntry, { kind: "timeline" }>["item"],
): string | undefined {
  if (item.kind === "user_message" || item.kind === "assistant_message") {
    return item.messageId;
  }
  return undefined;
}

function hasTimelineText(
  item: Extract<FeedEntry, { kind: "timeline" }>["item"],
): item is Extract<Extract<FeedEntry, { kind: "timeline" }>["item"], { text: string }> {
  return (
    item.kind === "user_message" ||
    item.kind === "assistant_message" ||
    item.kind === "reasoning"
  );
}

function entriesLookLikeSameLiveHistoryEcho(left: FeedEntry, right: FeedEntry): boolean {
  if (left.kind !== "timeline" || right.kind !== "timeline") {
    return false;
  }
  if (left.item.kind !== right.item.kind) {
    return false;
  }
  if (!hasTimelineText(left.item) || !hasTimelineText(right.item)) {
    return false;
  }
  if (left.item.text !== right.item.text) {
    return false;
  }
  const leftTs = Date.parse(left.ts);
  const rightTs = Date.parse(right.ts);
  if (!Number.isFinite(leftTs) || !Number.isFinite(rightTs)) {
    return false;
  }
  if (Math.abs(leftTs - rightTs) > LIVE_HISTORY_ECHO_WINDOW_MS) {
    return false;
  }

  const leftHistory = isHistoryTurnId(left.turnId);
  const rightHistory = isHistoryTurnId(right.turnId);
  if (leftHistory !== rightHistory) {
    return true;
  }

  const leftHasMessageId = readTimelineMessageId(left.item) !== undefined;
  const rightHasMessageId = readTimelineMessageId(right.item) !== undefined;
  return left.item.kind === "user_message" && leftHasMessageId !== rightHasMessageId;
}

function entriesLookLikeSameOptimisticHistoryEcho(left: FeedEntry, right: FeedEntry): boolean {
  if (left.kind !== "timeline" || right.kind !== "timeline") {
    return false;
  }
  if (left.item.kind !== "user_message" || right.item.kind !== "user_message") {
    return false;
  }
  if (left.item.text !== right.item.text) {
    return false;
  }
  const leftOptimistic = left.key.startsWith("optimistic:user:");
  const rightOptimistic = right.key.startsWith("optimistic:user:");
  if (leftOptimistic === rightOptimistic) {
    return false;
  }
  const leftTs = Date.parse(left.ts);
  const rightTs = Date.parse(right.ts);
  return (
    Number.isFinite(leftTs) &&
    Number.isFinite(rightTs) &&
    Math.abs(leftTs - rightTs) <= LIVE_HISTORY_ECHO_WINDOW_MS
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
  const prepend = historyProjection.feed.filter((entry, entryIndex) => {
    const existingIndex = currentKeyIndex.get(entry.key);
    if (existingIndex !== undefined) {
      nextFeed[existingIndex] = entry;
      return false;
    }
    const identityIndex = findEquivalentFeedEntryIndex(
      nextFeed,
      entry,
      historyProjection.feed,
      entryIndex,
    );
    if (identityIndex >= 0) {
      nextFeed[identityIndex] = entry;
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

  for (const [currentIndex, current] of currentFeed.entries()) {
    const existingIndex = currentKeyIndex.get(current.key);
    if (existingIndex !== undefined) {
      continue;
    }
    const identityIndex = findEquivalentFeedEntryIndex(
      nextFeed,
      current,
      currentFeed,
      currentIndex,
    );
    if (identityIndex >= 0) {
      continue;
    }
    nextFeed.push(current);
  }

  return nextFeed;
}

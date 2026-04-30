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

function entriesLookLikeSameLiveHistoryEcho(left: FeedEntry, right: FeedEntry): boolean {
  if (left.kind !== "timeline" || right.kind !== "timeline") {
    return false;
  }
  if (left.item.kind !== "user_message" || right.item.kind !== "user_message") {
    return false;
  }
  if (left.item.text !== right.item.text) {
    return false;
  }
  const leftHasMessageId = left.item.messageId !== undefined;
  const rightHasMessageId = right.item.messageId !== undefined;
  if (leftHasMessageId === rightHasMessageId) {
    return false;
  }
  const leftTs = Date.parse(left.ts);
  const rightTs = Date.parse(right.ts);
  if (!Number.isFinite(leftTs) || !Number.isFinite(rightTs)) {
    return false;
  }
  return Math.abs(leftTs - rightTs) <= LIVE_HISTORY_ECHO_WINDOW_MS;
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
  const nextFeed = [...projection.feed];
  const currentKeyIndex = new Map(
    nextFeed.map((entry, index) => [entry.key, index] as const),
  );
  const prepend = historyProjection.feed.filter((entry) => {
    const existingIndex = currentKeyIndex.get(entry.key);
    if (existingIndex !== undefined) {
      nextFeed[existingIndex] = entry;
      return false;
    }
    const identityIndex = nextFeed.findIndex((current) =>
      feedEntriesShareTimelineIdentity(current, entry),
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

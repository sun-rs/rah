import type { FeedEntry } from "../../types";
import { isInternalUserReminder } from "./assistant-turn-headers";
import type { VirtualFeedLayout } from "./virtualized-feed-layout";
import { VIRTUAL_FEED_ROW_GAP_PX } from "./virtualized-feed-layout";

const LATEST_REPLY_VIEWPORT_MARGIN_PX = 24;
const LATEST_REPLY_TOP_SCROLL_THRESHOLD_PX = 16;

export type LatestReplyStartTarget = {
  entryKey: string;
  entryIndex: number;
  targetScrollTop: number;
  replyHeight: number;
};

export type LatestReplyAutoNavigationState = {
  latestUserKey: string | null;
  latestReplyKey: string | null;
  generationActive: boolean;
  armed: boolean;
  pendingReplyKey: string | null;
};

function isAssistantReplyEntry(entry: FeedEntry): boolean {
  return entry.kind === "timeline" && entry.item.kind === "assistant_message";
}

function isNavigableAssistantReplyEntry(
  entry: FeedEntry,
  navigableAssistantKeys: ReadonlySet<string> | undefined,
): boolean {
  return isAssistantReplyEntry(entry) && (navigableAssistantKeys?.has(entry.key) ?? true);
}

function isVisibleConversationMessageEntry(entry: FeedEntry): boolean {
  if (isAssistantReplyEntry(entry)) {
    return true;
  }
  return (
    entry.kind === "timeline" &&
    entry.item.kind === "user_message" &&
    !isInternalUserReminder(entry.item.text)
  );
}

export function latestVisibleConversationMessageIndex(entries: readonly FeedEntry[]): number {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry && isVisibleConversationMessageEntry(entry)) {
      return index;
    }
  }
  return -1;
}

export function latestVisibleUserMessageKey(entries: readonly FeedEntry[]): string | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (
      entry?.kind === "timeline" &&
      entry.item.kind === "user_message" &&
      !isInternalUserReminder(entry.item.text)
    ) {
      return entry.key;
    }
  }
  return null;
}

export function latestNavigableAssistantReplyKey(
  entries: readonly FeedEntry[],
  navigableAssistantKeys?: ReadonlySet<string>,
): string | null {
  const index = latestVisibleConversationMessageIndex(entries);
  const entry = index >= 0 ? entries[index] : undefined;
  return entry && isNavigableAssistantReplyEntry(entry, navigableAssistantKeys)
    ? entry.key
    : null;
}

export function createLatestReplyAutoNavigationState(args: {
  latestUserKey: string | null;
  latestReplyKey: string | null;
  generationActive: boolean;
}): LatestReplyAutoNavigationState {
  return {
    latestUserKey: args.latestUserKey,
    latestReplyKey: args.latestReplyKey,
    generationActive: args.generationActive,
    armed: args.generationActive,
    pendingReplyKey: null,
  };
}

/**
 * Arms on a live turn, then targets the first canonical final that becomes the
 * latest visible conversation message. This follows turn identity rather than
 * waiting for the whole session runtime to become idle, which may happen later
 * when queued prompts or subagents are still active.
 */
export function advanceLatestReplyAutoNavigationState(
  current: LatestReplyAutoNavigationState,
  args: {
    latestUserKey: string | null;
    latestReplyKey: string | null;
    generationActive: boolean;
  },
): LatestReplyAutoNavigationState {
  const userChanged = args.latestUserKey !== current.latestUserKey;
  const replyChanged = args.latestReplyKey !== current.latestReplyKey;
  let armed = current.armed || (!current.generationActive && args.generationActive);
  let pendingReplyKey = current.pendingReplyKey;

  if (userChanged) {
    pendingReplyKey = null;
    if (args.generationActive || args.latestUserKey?.startsWith("optimistic:user:")) {
      armed = true;
    }
  }
  if (replyChanged && args.latestReplyKey && armed) {
    pendingReplyKey = args.latestReplyKey;
    armed = false;
  }

  return {
    latestUserKey: args.latestUserKey,
    latestReplyKey: args.latestReplyKey,
    generationActive: args.generationActive,
    armed,
    pendingReplyKey,
  };
}

function measuredReplyHeight(args: {
  entryKey: string;
  rowIndex: number;
  rowCount: number;
  rowHeight: number;
  measuredHeights: ReadonlyMap<string, number>;
}): number {
  const measuredHeight = args.measuredHeights.get(args.entryKey);
  if (measuredHeight !== undefined) {
    return measuredHeight;
  }
  const rowGap = args.rowIndex < args.rowCount - 1 ? VIRTUAL_FEED_ROW_GAP_PX : 0;
  return Math.max(1, args.rowHeight - rowGap);
}

export function resolveLatestReplyStartTarget(args: {
  entries: readonly FeedEntry[];
  layout: VirtualFeedLayout;
  measuredHeights: ReadonlyMap<string, number>;
  scrollTop: number;
  viewportHeight: number;
  contentTopOffset?: number;
  navigableAssistantKeys?: ReadonlySet<string>;
}): LatestReplyStartTarget | null {
  if (args.viewportHeight <= 0) {
    return null;
  }
  const entryIndex = latestVisibleConversationMessageIndex(args.entries);
  if (entryIndex < 0) {
    return null;
  }
  const entry = args.entries[entryIndex];
  if (!entry) {
    return null;
  }
  const rowIndex = args.layout.rows.findIndex((candidate) => candidate.key === entry.key);
  const row = rowIndex >= 0 ? args.layout.rows[rowIndex] : undefined;
  if (!row) {
    return null;
  }
  if (!isNavigableAssistantReplyEntry(entry, args.navigableAssistantKeys)) {
    return null;
  }

  const replyHeight = measuredReplyHeight({
    entryKey: entry.key,
    rowIndex,
    rowCount: args.layout.rows.length,
    rowHeight: row.height,
    measuredHeights: args.measuredHeights,
  });
  if (replyHeight <= args.viewportHeight - LATEST_REPLY_VIEWPORT_MARGIN_PX) {
    return null;
  }

  const targetScrollTop = row.offsetTop + (args.contentTopOffset ?? 0);
  if (args.scrollTop <= targetScrollTop + LATEST_REPLY_TOP_SCROLL_THRESHOLD_PX) {
    return null;
  }

  return {
    entryKey: entry.key,
    entryIndex,
    targetScrollTop,
    replyHeight,
  };
}

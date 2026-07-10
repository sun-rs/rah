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

function latestVisibleConversationMessageIndex(entries: readonly FeedEntry[]): number {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry && isVisibleConversationMessageEntry(entry)) {
      return index;
    }
  }
  return -1;
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

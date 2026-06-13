import type { FeedEntry } from "../../types";
import type { VirtualFeedLayout } from "./virtualized-feed-layout";
import { VIRTUAL_FEED_ROW_GAP_PX } from "./virtualized-feed-layout";

const LATEST_REPLY_MIN_HEIGHT_PX = 180;
const LATEST_REPLY_VIEWPORT_RATIO = 0.8;
const LATEST_REPLY_TOP_SCROLL_THRESHOLD_PX = 48;

export type LatestReplyStartTarget = {
  entryKey: string;
  entryIndex: number;
  targetScrollTop: number;
  replyHeight: number;
};

function isAssistantReplyEntry(entry: FeedEntry): boolean {
  return entry.kind === "timeline" && entry.item.kind === "assistant_message";
}

function measuredReplyHeight(args: {
  entryKey: string;
  entryIndex: number;
  entryCount: number;
  rowHeight: number;
  measuredHeights: ReadonlyMap<string, number>;
}): number {
  const measuredHeight = args.measuredHeights.get(args.entryKey);
  if (measuredHeight !== undefined) {
    return measuredHeight;
  }
  const rowGap = args.entryIndex < args.entryCount - 1 ? VIRTUAL_FEED_ROW_GAP_PX : 0;
  return Math.max(1, args.rowHeight - rowGap);
}

export function resolveLatestReplyStartTarget(args: {
  entries: readonly FeedEntry[];
  layout: VirtualFeedLayout;
  measuredHeights: ReadonlyMap<string, number>;
  scrollTop: number;
  viewportHeight: number;
  contentTopOffset?: number;
}): LatestReplyStartTarget | null {
  if (args.viewportHeight <= 0) {
    return null;
  }
  let entryIndex = -1;
  for (let index = args.entries.length - 1; index >= 0; index -= 1) {
    if (isAssistantReplyEntry(args.entries[index]!)) {
      entryIndex = index;
      break;
    }
  }
  if (entryIndex < 0) {
    return null;
  }
  const entry = args.entries[entryIndex];
  const row = args.layout.rows[entryIndex];
  if (!entry || !row) {
    return null;
  }

  const replyHeight = measuredReplyHeight({
    entryKey: entry.key,
    entryIndex,
    entryCount: args.entries.length,
    rowHeight: row.height,
    measuredHeights: args.measuredHeights,
  });
  const longReplyThreshold = Math.max(
    LATEST_REPLY_MIN_HEIGHT_PX,
    args.viewportHeight * LATEST_REPLY_VIEWPORT_RATIO,
  );
  if (replyHeight <= longReplyThreshold) {
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

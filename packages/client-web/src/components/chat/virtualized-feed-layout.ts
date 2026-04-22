import type { FeedEntry } from "../../types";

export const VIRTUAL_FEED_OVERSCAN = 6;

type VirtualFeedRowLayout = {
  key: string;
  height: number;
  offsetTop: number;
};

export type VirtualFeedLayout = {
  rows: VirtualFeedRowLayout[];
  totalHeight: number;
};

export type VirtualFeedWindow = {
  startIndex: number;
  endIndex: number;
  topSpacerHeight: number;
  bottomSpacerHeight: number;
};

function estimateTimelineHeight(entry: Extract<FeedEntry, { kind: "timeline" }>): number {
  switch (entry.item.kind) {
    case "assistant_message":
    case "user_message":
    case "reasoning": {
      const text =
        "text" in entry.item && typeof entry.item.text === "string" ? entry.item.text : "";
      return Math.max(84, Math.min(320, 68 + Math.ceil(text.length / 80) * 24));
    }
    case "plan":
      return 144;
    case "todo":
      return 128;
    case "attachment":
    case "side_question":
    case "step":
      return 124;
    case "compaction":
    case "error":
    case "retry":
    case "system":
      return 72;
  }
}

function estimateFeedEntryHeight(entry: FeedEntry): number {
  switch (entry.kind) {
    case "timeline":
      return estimateTimelineHeight(entry);
    case "tool_call":
      return 64;
    case "permission":
      return 152;
    case "observation":
      return 84;
    case "attention":
      return 112;
    case "operation":
    case "message_part":
      return 72;
    case "runtime_status":
    case "notification":
      return 64;
  }
}

export function buildVirtualFeedLayout(
  entries: readonly FeedEntry[],
  measuredHeights: ReadonlyMap<string, number>,
): VirtualFeedLayout {
  let offsetTop = 0;
  const rows = entries.map((entry) => {
    const height = measuredHeights.get(entry.key) ?? estimateFeedEntryHeight(entry);
    const row = {
      key: entry.key,
      height,
      offsetTop,
    };
    offsetTop += height;
    return row;
  });
  return {
    rows,
    totalHeight: offsetTop,
  };
}

function findRowIndexAtOffset(rows: readonly VirtualFeedRowLayout[], offset: number): number {
  if (rows.length === 0) {
    return 0;
  }
  let low = 0;
  let high = rows.length - 1;
  let result = rows.length - 1;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const row = rows[mid]!;
    if (offset < row.offsetTop + row.height) {
      result = mid;
      high = mid - 1;
    } else {
      low = mid + 1;
    }
  }
  return result;
}

export function resolveVirtualFeedWindow(args: {
  layout: VirtualFeedLayout;
  scrollTop: number;
  viewportHeight: number;
  overscan?: number;
}): VirtualFeedWindow {
  if (args.layout.rows.length === 0) {
    return {
      startIndex: 0,
      endIndex: 0,
      topSpacerHeight: 0,
      bottomSpacerHeight: 0,
    };
  }

  const overscan = Math.max(0, args.overscan ?? VIRTUAL_FEED_OVERSCAN);
  const boundedScrollTop = Math.max(0, args.scrollTop);
  const viewportBottom = boundedScrollTop + Math.max(1, args.viewportHeight);
  const firstVisibleIndex = findRowIndexAtOffset(args.layout.rows, boundedScrollTop);
  const lastVisibleIndex = findRowIndexAtOffset(args.layout.rows, viewportBottom);
  const startIndex = Math.max(0, firstVisibleIndex - overscan);
  const endIndex = Math.min(args.layout.rows.length, lastVisibleIndex + overscan + 1);
  const topSpacerHeight = args.layout.rows[startIndex]?.offsetTop ?? 0;
  const endRow = args.layout.rows[endIndex - 1];
  const renderedBottom = endRow ? endRow.offsetTop + endRow.height : topSpacerHeight;
  return {
    startIndex,
    endIndex,
    topSpacerHeight,
    bottomSpacerHeight: Math.max(0, args.layout.totalHeight - renderedBottom),
  };
}

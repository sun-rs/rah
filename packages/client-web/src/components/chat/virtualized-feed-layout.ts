import type { FeedEntry } from "../../types";

export const VIRTUAL_FEED_OVERSCAN = 6;
export const VIRTUAL_FEED_ROW_GAP_PX = 20;
export const VIRTUAL_FEED_MAX_EAGER_ROWS = 80;
export const VIRTUAL_FEED_MAX_EAGER_HEIGHT_PX = 12_000;
export const VIRTUAL_FEED_MAX_EAGER_VIEWPORTS = 8;

export type VirtualFeedRowGapResolver<T extends { key: string } = FeedEntry> = (
  entry: T,
  index: number,
  entries: readonly T[],
) => number;

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

/**
 * Native text selection owns the rows that were mounted when the drag began.
 * Returning that exact window avoids replacing the browser Range with either a
 * different virtual slice or the full transcript while the pointer is down.
 */
export function resolveLeasedVirtualFeedWindow(
  resolvedWindow: VirtualFeedWindow,
  selectionLease: VirtualFeedWindow | null,
): VirtualFeedWindow {
  return selectionLease ?? resolvedWindow;
}

/**
 * Window by render cost, not merely by item count. A handful of very long
 * markdown replies can be more expensive than hundreds of compact process
 * rows, so either dimension may put the feed into its bounded-DOM mode.
 */
export function shouldVirtualizeFeedLayout(args: {
  layout: VirtualFeedLayout;
  viewportHeight: number;
  rowCount?: number;
}): boolean {
  const viewportHeight = Math.max(0, args.viewportHeight);
  if (viewportHeight <= 0 || args.layout.rows.length === 0) {
    return false;
  }
  const rowCount = args.rowCount ?? args.layout.rows.length;
  const heightBudget = Math.max(
    VIRTUAL_FEED_MAX_EAGER_HEIGHT_PX,
    viewportHeight * VIRTUAL_FEED_MAX_EAGER_VIEWPORTS,
  );
  return rowCount > VIRTUAL_FEED_MAX_EAGER_ROWS || args.layout.totalHeight >= heightBudget;
}

export function projectVirtualAnchorScrollTop(args: {
  layout: VirtualFeedLayout;
  entryKey: string;
  viewportOffset: number;
  contentTopOffset: number;
}): number | null {
  const row = args.layout.rows.find((candidate) => candidate.key === args.entryKey);
  if (!row) {
    return null;
  }
  return Math.max(
    0,
    args.contentTopOffset + row.offsetTop - args.viewportOffset,
  );
}

function estimateTimelineHeight(entry: Extract<FeedEntry, { kind: "timeline" }>): number {
  switch (entry.item.kind) {
    case "assistant_message":
    case "user_message":
    case "reasoning": {
      const text =
        "text" in entry.item && typeof entry.item.text === "string" ? entry.item.text : "";
      const estimatedLines = text
        .split(/\r?\n/)
        .reduce((total, line) => total + Math.max(1, Math.ceil(line.length / 56)), 0);
      return Math.max(84, Math.min(12_000, 68 + estimatedLines * 24));
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
      return 28;
    case "error":
    case "retry":
    case "system":
      return 72;
  }
}

export function estimateFeedEntryHeight(entry: FeedEntry): number {
  switch (entry.kind) {
    case "timeline":
      return estimateTimelineHeight(entry);
    case "tool_call":
      return 64;
    case "permission":
      return 152;
    case "observation":
      return 84;
    case "operation":
    case "message_part":
      return 72;
    case "runtime_status":
    case "notification":
      return 64;
  }
}

export function buildVirtualFeedLayout<T extends { key: string } = FeedEntry>(
  entries: readonly T[],
  measuredHeights: ReadonlyMap<string, number>,
  rowGapResolver?: VirtualFeedRowGapResolver<T>,
  estimateHeight?: (entry: T) => number,
): VirtualFeedLayout {
  let offsetTop = 0;
  const rows = entries.map((entry, index) => {
    const rowGap =
      index < entries.length - 1
        ? Math.max(0, rowGapResolver?.(entry, index, entries) ?? VIRTUAL_FEED_ROW_GAP_PX)
        : 0;
    const height =
      (measuredHeights.get(entry.key) ??
        (estimateHeight
          ? estimateHeight(entry)
          : estimateFeedEntryHeight(entry as unknown as FeedEntry))) +
      rowGap;
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

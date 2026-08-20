export type ViewportAnchorSnapshot = {
  scrollHeight: number;
  scrollTop: number;
  entryKey: string | null;
  offsetTop: number | null;
  element: HTMLElement | null;
  elementOffsetTop: number | null;
};

const READER_ANCHOR_SELECTOR = [
  "p",
  "li",
  "pre",
  "tr",
  "blockquote",
  "button",
  "[data-testid='conversation-inline-image']",
].join(",");

export function captureVisibleViewportAnchor(
  node: HTMLElement,
  preferredElement?: HTMLElement,
): ViewportAnchorSnapshot {
  const containerBounds = node.getBoundingClientRect();
  const entryNodes = Array.from(
    node.querySelectorAll<HTMLElement>("[data-feed-entry-key]"),
  );
  const preferredRow = preferredElement?.closest<HTMLElement>("[data-feed-entry-key]");
  const visibleRow =
    preferredRow ??
    entryNodes.find((entry) => entry.getBoundingClientRect().bottom > containerBounds.top + 1) ??
    entryNodes[0] ??
    null;
  const element =
    preferredElement ??
    (visibleRow
      ? Array.from(visibleRow.querySelectorAll<HTMLElement>(READER_ANCHOR_SELECTOR)).find(
          (candidate) => {
            const bounds = candidate.getBoundingClientRect();
            return bounds.bottom > containerBounds.top + 1 && bounds.top < containerBounds.bottom - 1;
          },
        )
      : null) ??
    visibleRow;
  return {
    scrollHeight: node.scrollHeight,
    scrollTop: node.scrollTop,
    entryKey: visibleRow?.dataset.feedEntryKey ?? null,
    offsetTop: visibleRow ? visibleRow.getBoundingClientRect().top - containerBounds.top : null,
    element,
    elementOffsetTop: element ? element.getBoundingClientRect().top - containerBounds.top : null,
  };
}

export function resolvePrependAnchorScrollTop(input: {
  currentScrollTop: number;
  anchorScrollTop: number;
  currentScrollHeight: number;
  anchorScrollHeight: number;
  currentViewportOffset: number | null;
  anchorViewportOffset: number | null;
}): number {
  if (input.currentViewportOffset !== null && input.anchorViewportOffset !== null) {
    return Math.max(
      0,
      input.currentScrollTop +
        input.currentViewportOffset -
        input.anchorViewportOffset,
    );
  }
  return Math.max(
    0,
    input.anchorScrollTop +
      input.currentScrollHeight -
      input.anchorScrollHeight,
  );
}

export function shouldRequestOlderConversationHistory(input: {
  armed: boolean;
  inLoadZone: boolean;
  contentUnderfilled: boolean;
  userDetachedFromLatest: boolean;
}): boolean {
  if (!input.armed || !input.inLoadZone) {
    return false;
  }
  // An underfilled first page may chain older pages so the reader gets a
  // useful viewport. Otherwise only an intentional reader scroll can own a
  // prepend. Safari/iOS scroll restoration and virtual-height corrections are
  // passive scrolls; letting either capture a prepend anchor overrides the
  // explicit Session-entry lease and strands the viewport in old history.
  return input.contentUnderfilled || input.userDetachedFromLatest;
}

export function shouldMaintainDetachedReaderAnchor(input: {
  userDetachedFromLatest: boolean;
  historyLoadActive: boolean;
  explicitAlignmentActive: boolean;
}): boolean {
  return (
    input.userDetachedFromLatest &&
    !input.historyLoadActive &&
    !input.explicitAlignmentActive
  );
}

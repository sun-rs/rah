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

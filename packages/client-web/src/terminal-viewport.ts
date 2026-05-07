export interface TerminalViewportMetrics {
  keyboardInsetPx: number;
  visibleHeightPx: number;
  panelTopPx: number;
  panelLeftPx: number;
  panelWidthPx: number;
}

export function computeKeyboardInsetPx(args: {
  layoutHeight: number;
  visualHeight: number;
  visualOffsetTop: number;
}): number {
  return Math.max(
    0,
    Math.round(args.layoutHeight - (args.visualHeight + args.visualOffsetTop)),
  );
}

export function computeTerminalVisibleHeightPx(args: {
  panelTop: number;
  panelHeight: number;
  visualHeight: number;
  visualOffsetTop: number;
  minHeight?: number;
}): number {
  const minHeight = args.minHeight ?? 180;
  const viewportBottom = args.visualOffsetTop + args.visualHeight;
  const effectiveTop = Math.max(args.panelTop, args.visualOffsetTop);
  const availableHeight = Math.max(0, viewportBottom - effectiveTop);
  const clampedToPanel = Math.min(args.panelHeight, Math.max(minHeight, availableHeight));
  return Math.max(0, Math.round(clampedToPanel));
}

export function readTerminalViewportMetrics(panel: HTMLElement | null): TerminalViewportMetrics {
  if (typeof window === "undefined") {
    return {
      keyboardInsetPx: 0,
      visibleHeightPx: 0,
      panelTopPx: 0,
      panelLeftPx: 0,
      panelWidthPx: 0,
    };
  }
  const visualViewport = window.visualViewport;
  const visualHeight = visualViewport?.height ?? window.innerHeight;
  const visualOffsetTop = visualViewport?.offsetTop ?? 0;
  const panelRect = panel?.getBoundingClientRect();
  return {
    keyboardInsetPx: computeKeyboardInsetPx({
      layoutHeight: window.innerHeight,
      visualHeight,
      visualOffsetTop,
    }),
    panelTopPx: panelRect ? Math.max(0, Math.round(Math.max(panelRect.top, visualOffsetTop))) : 0,
    panelLeftPx: panelRect ? Math.max(0, Math.round(panelRect.left)) : 0,
    panelWidthPx: panelRect ? Math.max(0, Math.round(panelRect.width)) : 0,
    visibleHeightPx: panelRect
      ? computeTerminalVisibleHeightPx({
          panelTop: panelRect.top,
          panelHeight: panelRect.height,
          visualHeight,
          visualOffsetTop,
        })
      : Math.round(visualHeight),
  };
}

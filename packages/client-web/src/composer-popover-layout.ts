export interface ComposerPopoverRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

export interface ComposerVisualViewportBounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

export interface ComposerPopoverLayout {
  left: number;
  top: number;
  width: number;
  height: number;
  placement: "above" | "below";
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), Math.max(minimum, maximum));
}

export function resolveComposerVisualViewportBounds(args: {
  layoutWidth: number;
  layoutHeight: number;
  visualViewport?: {
    offsetLeft: number;
    offsetTop: number;
    width: number;
    height: number;
  } | null;
}): ComposerVisualViewportBounds {
  const left = Math.max(0, args.visualViewport?.offsetLeft ?? 0);
  const top = Math.max(0, args.visualViewport?.offsetTop ?? 0);
  const width = Math.max(0, args.visualViewport?.width ?? args.layoutWidth);
  const height = Math.max(0, args.visualViewport?.height ?? args.layoutHeight);
  return {
    left,
    top,
    right: left + width,
    bottom: top + height,
    width,
    height,
  };
}

export function readComposerVisualViewportBounds(): ComposerVisualViewportBounds {
  if (typeof window === "undefined") {
    return {
      left: 0,
      top: 0,
      right: 0,
      bottom: 0,
      width: 0,
      height: 0,
    };
  }
  return resolveComposerVisualViewportBounds({
    layoutWidth: window.innerWidth,
    layoutHeight: window.innerHeight,
    visualViewport: window.visualViewport,
  });
}

export function resolveComposerPopoverLayout(args: {
  anchor: ComposerPopoverRect;
  viewport: ComposerVisualViewportBounds;
  desiredWidth: number;
  desiredHeight: number;
  maximumHeight: number;
  minimumUsableHeight?: number;
  padding?: number;
  gap?: number;
  horizontalAlignment?: "start" | "center" | "end";
}): ComposerPopoverLayout {
  const padding = args.padding ?? 8;
  const gap = args.gap ?? 6;
  const minimumUsableHeight = args.minimumUsableHeight ?? 96;
  const maximumWidth = Math.max(0, args.viewport.width - padding * 2);
  const width = Math.min(Math.max(0, args.desiredWidth), maximumWidth);
  const horizontalAlignment = args.horizontalAlignment ?? "start";
  const desiredLeft =
    horizontalAlignment === "end"
      ? args.anchor.right - width
      : horizontalAlignment === "center"
        ? args.anchor.left + (args.anchor.width - width) / 2
        : args.anchor.left;
  const left = clamp(
    desiredLeft,
    args.viewport.left + padding,
    args.viewport.right - padding - width,
  );
  const spaceBelow = Math.max(
    0,
    args.viewport.bottom - padding - gap - args.anchor.bottom,
  );
  const spaceAbove = Math.max(
    0,
    args.anchor.top - args.viewport.top - padding - gap,
  );
  const targetHeight = Math.min(
    Math.max(0, args.desiredHeight),
    Math.max(0, args.maximumHeight),
  );
  const usefulTarget = Math.min(targetHeight, minimumUsableHeight);
  const placement =
    spaceBelow >= usefulTarget || spaceBelow >= spaceAbove ? "below" : "above";
  const availableHeight = placement === "below" ? spaceBelow : spaceAbove;
  const height = Math.min(targetHeight, availableHeight);
  const unclampedTop =
    placement === "below"
      ? args.anchor.bottom + gap
      : args.anchor.top - gap - height;
  const top = clamp(
    unclampedTop,
    args.viewport.top + padding,
    args.viewport.bottom - padding - height,
  );

  return { left, top, width, height, placement };
}

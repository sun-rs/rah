export const COMPACT_MAX_WIDTH_PX = 699;
export const MEDIUM_MIN_WIDTH_PX = 700;
export const WIDE_MIN_WIDTH_PX = 900;

export type ResponsiveTier = "compact" | "medium" | "wide";

export function resolveResponsiveTier(viewportWidthPx: number): ResponsiveTier {
  if (!Number.isFinite(viewportWidthPx) || viewportWidthPx >= WIDE_MIN_WIDTH_PX) {
    return "wide";
  }
  return viewportWidthPx >= MEDIUM_MIN_WIDTH_PX ? "medium" : "compact";
}

export function isInlinePanelTier(
  tier: ResponsiveTier,
  breakpoint: "medium" | "wide" = "medium",
): boolean {
  return breakpoint === "wide" ? tier === "wide" : tier !== "compact";
}

export function resolveSidePanelOpenForTier(
  tier: ResponsiveTier,
  inlineOpen: boolean,
  overlayOpen: boolean,
  breakpoint: "medium" | "wide" = "medium",
): boolean {
  return isInlinePanelTier(tier, breakpoint) ? inlineOpen : overlayOpen;
}

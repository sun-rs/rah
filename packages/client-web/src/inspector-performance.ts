export type ProgressiveRenderConfig = {
  threshold: number;
  initial: number;
  step: number;
};

export type HighlightLimits = {
  maxLines: number;
  maxChars: number;
};

export const DIFF_PROGRESSIVE_RENDER: ProgressiveRenderConfig = {
  threshold: 600,
  initial: 400,
  step: 400,
};

export const FILE_PROGRESSIVE_RENDER: ProgressiveRenderConfig = {
  threshold: 1_500,
  initial: 800,
  step: 800,
};

export const DIFF_HIGHLIGHT_LIMITS: HighlightLimits = {
  maxLines: 250,
  maxChars: 24_000,
};

export const FILE_HIGHLIGHT_LIMITS: HighlightLimits = {
  maxLines: 1_000,
  maxChars: 100_000,
};

export function shouldUseProgressiveRender(totalCount: number, config: ProgressiveRenderConfig): boolean {
  return totalCount > config.threshold;
}

export function getInitialVisibleCount(totalCount: number, config: ProgressiveRenderConfig): number {
  if (!shouldUseProgressiveRender(totalCount, config)) {
    return totalCount;
  }
  return Math.min(totalCount, config.initial);
}

export function getNextVisibleCount(
  currentCount: number,
  totalCount: number,
  config: ProgressiveRenderConfig,
): number {
  return Math.min(totalCount, currentCount + config.step);
}

export function shouldHighlightPreview(
  language: string | null,
  lineCount: number,
  charCount: number,
  limits: HighlightLimits,
): boolean {
  return language !== null && lineCount <= limits.maxLines && charCount <= limits.maxChars;
}

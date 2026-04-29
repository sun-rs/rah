import type { ContextUsage } from "@rah/runtime-protocol";

function finiteNumber(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function clampPercent(value: number): number {
  const clamped = Math.max(0, Math.min(100, value));
  return Math.round(clamped * 10) / 10;
}

function hasTokenAccounting(usage: ContextUsage): boolean {
  return (
    usage.usedTokens !== undefined ||
    usage.percentUsed !== undefined ||
    usage.percentRemaining !== undefined ||
    usage.inputTokens !== undefined ||
    usage.cachedInputTokens !== undefined ||
    usage.outputTokens !== undefined ||
    usage.reasoningOutputTokens !== undefined ||
    usage.totalCostUsd !== undefined
  );
}

export function normalizeContextUsage(usage: ContextUsage): ContextUsage {
  const next: ContextUsage = { ...usage };
  const usedTokens = finiteNumber(next.usedTokens);
  const contextWindow = finiteNumber(next.contextWindow);
  const percentUsed = finiteNumber(next.percentUsed);
  const percentRemaining = finiteNumber(next.percentRemaining);

  if (usedTokens !== undefined) {
    next.usedTokens = usedTokens;
  }
  if (contextWindow !== undefined) {
    next.contextWindow = contextWindow;
  }

  if (usedTokens !== undefined && contextWindow !== undefined && contextWindow > 0) {
    next.percentUsed = clampPercent((usedTokens / contextWindow) * 100);
    next.percentRemaining = clampPercent(((contextWindow - usedTokens) / contextWindow) * 100);
    next.basis ??= "context_window";
  } else if (percentUsed !== undefined) {
    next.percentUsed = clampPercent(percentUsed);
    next.percentRemaining = clampPercent(100 - next.percentUsed);
    next.basis ??= "context_window";
  } else if (percentRemaining !== undefined) {
    next.percentRemaining = clampPercent(percentRemaining);
    next.percentUsed = clampPercent(100 - next.percentRemaining);
    next.basis ??= "context_window";
  } else if (hasTokenAccounting(next)) {
    next.basis ??= "turn";
  }

  if (next.precision === undefined && hasTokenAccounting(next)) {
    next.precision = "exact";
  }

  return next;
}

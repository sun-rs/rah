const HISTORY_SIZE_UNITS = ["B", "KB", "MB", "GB", "TB"] as const;

export type HistorySizeFilterUnit = "KB" | "MB" | "GB";

const HISTORY_SIZE_FILTER_MULTIPLIERS: Record<HistorySizeFilterUnit, number> = {
  KB: 1024,
  MB: 1024 ** 2,
  GB: 1024 ** 3,
};

function normalizedHistoryBytes(bytes: number): number {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return 0;
  }
  return Math.round(bytes);
}

function formattedUnitValue(value: number): string {
  const fractionDigits = value < 100 ? 1 : 0;
  return value.toFixed(fractionDigits).replace(/\.0$/, "");
}

export function formatHistoryBytes(
  bytes: number,
  options: { compact?: boolean } = {},
): string {
  const normalized = normalizedHistoryBytes(bytes);
  let unitIndex = 0;
  let value = normalized;
  while (value >= 1024 && unitIndex < HISTORY_SIZE_UNITS.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const separator = options.compact ? "" : " ";
  return `${formattedUnitValue(value)}${separator}${HISTORY_SIZE_UNITS[unitIndex]}`;
}

export function formatExactHistoryBytes(bytes: number): string {
  return `${normalizedHistoryBytes(bytes).toLocaleString("en-US")} bytes`;
}

export function parseMaxHistoryBytes(
  value: string,
  unit: HistorySizeFilterUnit,
): number | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return null;
  }
  return Math.round(parsed * HISTORY_SIZE_FILTER_MULTIPLIERS[unit]);
}

/**
 * A deliberately early, shallow warning scale: history remains usable at all
 * sizes, but larger records deserve progressively more attention before they
 * become expensive to scan, copy, or recover.
 */
export function historySizeRiskClassName(bytes: number | undefined): string {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 16 * 1024 ** 2) {
    return "border-[var(--app-border)] bg-[var(--app-subtle-bg)] text-[var(--app-hint)]";
  }
  if (bytes < 64 * 1024 ** 2) {
    return "border-sky-500/20 bg-sky-500/10 text-sky-700 dark:text-sky-300";
  }
  if (bytes < 256 * 1024 ** 2) {
    return "border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-300";
  }
  if (bytes < 1024 ** 3) {
    return "border-orange-500/25 bg-orange-500/10 text-orange-700 dark:text-orange-300";
  }
  return "border-red-500/25 bg-red-500/10 text-red-700 dark:text-red-300";
}

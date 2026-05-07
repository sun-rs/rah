import type { PtySessionStats } from "@rah/runtime-protocol";

export interface PtyRuntimeHealthSummary {
  totalSessions: number;
  openSessions: number;
  exitedSessions: number;
  replayBytes: number;
  maxReplayBytes: number;
  replayChunks: number;
  subscriberCount: number;
  trimmedSessions: number;
  largestReplayBytes: number;
  replayUsageRatio: number;
  status: "idle" | "healthy" | "trimmed";
}

export interface PtyRuntimeHealthTrend {
  openSessionsDelta: number;
  replayBytesDelta: number;
  replayChunksDelta: number;
  subscriberCountDelta: number;
  trimmedSessionsDelta: number;
}

export function formatPtyBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0 B";
  }
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const precision = unitIndex === 0 || value >= 10 || Number.isInteger(value) ? 0 : 1;
  return `${value.toFixed(precision)} ${units[unitIndex]}`;
}

export function formatSignedPtyBytes(bytes: number): string {
  if (bytes === 0) {
    return "0 B";
  }
  const sign = bytes > 0 ? "+" : "-";
  return `${sign}${formatPtyBytes(Math.abs(bytes))}`;
}

export function formatSignedCount(value: number): string {
  if (value === 0) {
    return "0";
  }
  return value > 0 ? `+${value}` : String(value);
}

export function summarizePtyRuntimeHealth(stats: readonly PtySessionStats[]): PtyRuntimeHealthSummary {
  let openSessions = 0;
  let replayBytes = 0;
  let maxReplayBytes = 0;
  let replayChunks = 0;
  let subscriberCount = 0;
  let trimmedSessions = 0;
  let largestReplayBytes = 0;

  for (const stat of stats) {
    if (stat.status === "open") {
      openSessions += 1;
    }
    replayBytes += stat.replayBytes;
    maxReplayBytes += stat.maxReplayBytes;
    replayChunks += stat.replayChunks;
    subscriberCount += stat.subscriberCount;
    largestReplayBytes = Math.max(largestReplayBytes, stat.replayBytes);
    if (stat.droppedBeforeSeq !== undefined) {
      trimmedSessions += 1;
    }
  }

  return {
    totalSessions: stats.length,
    openSessions,
    exitedSessions: stats.length - openSessions,
    replayBytes,
    maxReplayBytes,
    replayChunks,
    subscriberCount,
    trimmedSessions,
    largestReplayBytes,
    replayUsageRatio: maxReplayBytes > 0 ? replayBytes / maxReplayBytes : 0,
    status: stats.length === 0 ? "idle" : trimmedSessions > 0 ? "trimmed" : "healthy",
  };
}

export function comparePtyRuntimeHealth(
  previous: readonly PtySessionStats[] | null,
  current: readonly PtySessionStats[],
): PtyRuntimeHealthTrend | null {
  if (!previous) {
    return null;
  }
  const previousSummary = summarizePtyRuntimeHealth(previous);
  const currentSummary = summarizePtyRuntimeHealth(current);
  return {
    openSessionsDelta: currentSummary.openSessions - previousSummary.openSessions,
    replayBytesDelta: currentSummary.replayBytes - previousSummary.replayBytes,
    replayChunksDelta: currentSummary.replayChunks - previousSummary.replayChunks,
    subscriberCountDelta: currentSummary.subscriberCount - previousSummary.subscriberCount,
    trimmedSessionsDelta: currentSummary.trimmedSessions - previousSummary.trimmedSessions,
  };
}

export function sortPtyStatsForDisplay(stats: readonly PtySessionStats[]): PtySessionStats[] {
  return [...stats].sort((left, right) => {
    if (left.status !== right.status) {
      return left.status === "open" ? -1 : 1;
    }
    return right.replayBytes - left.replayBytes || left.sessionId.localeCompare(right.sessionId);
  });
}

import { statSync, type Stats } from "node:fs";
import type { StoredSessionRef } from "@rah/runtime-protocol";

export function historyMetaForFileSync(
  filePath: string,
  stats: Stats = statSync(filePath),
  options?: { bytes?: number; lines?: number; messages?: number },
): NonNullable<StoredSessionRef["historyMeta"]> {
  return {
    bytes: options?.bytes ?? stats.size,
    ...(options?.lines !== undefined ? { lines: options.lines } : {}),
    ...(options?.messages !== undefined ? { messages: options.messages } : {}),
  };
}

export function withHistoryFileMeta(
  ref: StoredSessionRef,
  filePath: string,
  stats: Stats = statSync(filePath),
  options?: { bytes?: number; lines?: number; messages?: number },
): StoredSessionRef {
  const historyMeta = historyMetaForFileSync(filePath, stats, options);
  if (
    ref.historyMeta?.bytes === historyMeta?.bytes &&
    ref.historyMeta?.lines === historyMeta?.lines &&
    ref.historyMeta?.messages === historyMeta?.messages
  ) {
    return ref;
  }
  return {
    ...ref,
    historyMeta,
  };
}

export function withHistoryMeta(
  ref: StoredSessionRef,
  historyMeta: NonNullable<StoredSessionRef["historyMeta"]>,
): StoredSessionRef {
  if (
    ref.historyMeta?.bytes === historyMeta.bytes &&
    ref.historyMeta?.lines === historyMeta.lines &&
    ref.historyMeta?.messages === historyMeta.messages
  ) {
    return ref;
  }
  return {
    ...ref,
    historyMeta,
  };
}

import { closeSync, openSync, readSync, statSync, type Stats } from "node:fs";
import type { StoredSessionRef } from "@rah/runtime-protocol";

const COUNT_BUFFER_SIZE = 64 * 1024;

export function countFileLinesSync(filePath: string): number | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(filePath, "r");
    const buffer = Buffer.allocUnsafe(COUNT_BUFFER_SIZE);
    let lines = 0;
    let lastByte: number | undefined;
    while (true) {
      const bytesRead = readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead === 0) {
        break;
      }
      for (let index = 0; index < bytesRead; index += 1) {
        const byte = buffer[index]!;
        if (byte === 10) {
          lines += 1;
        }
        lastByte = byte;
      }
    }
    if (lastByte !== undefined && lastByte !== 10) {
      lines += 1;
    }
    return lines;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      closeSync(fd);
    }
  }
}

export function historyMetaForFileSync(
  filePath: string,
  stats: Stats = statSync(filePath),
  options?: { bytes?: number; messages?: number },
): NonNullable<StoredSessionRef["historyMeta"]> {
  const lines = countFileLinesSync(filePath);
  return {
    bytes: options?.bytes ?? stats.size,
    ...(lines !== undefined ? { lines } : {}),
    ...(options?.messages !== undefined ? { messages: options.messages } : {}),
  };
}

export function withHistoryFileMeta(
  ref: StoredSessionRef,
  filePath: string,
  stats: Stats = statSync(filePath),
  options?: { bytes?: number; messages?: number },
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

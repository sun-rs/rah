import { open } from "node:fs/promises";

// These are event-loop slice budgets, not transcript limits. A large provider
// line may span several reads; complete semantic lines are still delivered.
// Keeping each slice small ensures live mirror catch-up yields between batches
// instead of competing with HTTP/WebSocket work.
export const DEFAULT_JSONL_MIRROR_READ_BYTES = 64 * 1024;
export const DEFAULT_JSONL_MIRROR_LINE_BYTES = 512 * 1024;
export const DEFAULT_JSONL_MIRROR_LINES = 256;

export type IncrementalJsonlCursor = {
  byteOffset: number;
  sourceIdentity?: string;
  pendingLine: Buffer;
  discardingOversizedLine: boolean;
};

export type IncrementalJsonlBatch = {
  lines: string[];
  hasMore: boolean;
  droppedOversizedLines: number;
};

export function createIncrementalJsonlCursor(): IncrementalJsonlCursor {
  return {
    byteOffset: 0,
    pendingLine: Buffer.alloc(0),
    discardingOversizedLine: false,
  };
}

function resetCursor(cursor: IncrementalJsonlCursor, sourceIdentity: string): void {
  cursor.byteOffset = 0;
  cursor.sourceIdentity = sourceIdentity;
  cursor.pendingLine = Buffer.alloc(0);
  cursor.discardingOversizedLine = false;
}

function appendBoundedSegment(
  cursor: IncrementalJsonlCursor,
  segment: Buffer,
  maxLineBytes: number,
): boolean {
  if (cursor.discardingOversizedLine) {
    return false;
  }
  if (cursor.pendingLine.length + segment.length > maxLineBytes) {
    cursor.pendingLine = Buffer.alloc(0);
    cursor.discardingOversizedLine = true;
    return false;
  }
  if (segment.length === 0) {
    return true;
  }
  cursor.pendingLine =
    cursor.pendingLine.length === 0
      ? Buffer.from(segment)
      : Buffer.concat([cursor.pendingLine, segment], cursor.pendingLine.length + segment.length);
  return true;
}

function finishLine(cursor: IncrementalJsonlCursor): string | undefined {
  if (cursor.discardingOversizedLine) {
    cursor.discardingOversizedLine = false;
    cursor.pendingLine = Buffer.alloc(0);
    return undefined;
  }
  const line =
    cursor.pendingLine.at(-1) === 0x0d
      ? cursor.pendingLine.subarray(0, cursor.pendingLine.length - 1)
      : cursor.pendingLine;
  cursor.pendingLine = Buffer.alloc(0);
  const text = line.toString("utf8").trim();
  return text.length > 0 ? text : undefined;
}

/**
 * Reads only newly appended JSONL bytes. Each call has hard byte, line-count,
 * and individual-line budgets so a provider rollout cannot monopolize the
 * daemon event loop or grow resident memory without bound.
 */
export async function readIncrementalJsonlBatch(
  filePath: string,
  cursor: IncrementalJsonlCursor,
  options: {
    maxBytes?: number;
    maxLineBytes?: number;
    maxLines?: number;
  } = {},
): Promise<IncrementalJsonlBatch> {
  const maxBytes = Math.max(1, options.maxBytes ?? DEFAULT_JSONL_MIRROR_READ_BYTES);
  const maxLineBytes = Math.max(1, options.maxLineBytes ?? DEFAULT_JSONL_MIRROR_LINE_BYTES);
  const maxLines = Math.max(1, options.maxLines ?? DEFAULT_JSONL_MIRROR_LINES);
  const handle = await open(filePath, "r");
  try {
    const stats = await handle.stat();
    const sourceIdentity = `${stats.dev}:${stats.ino}`;
    if (
      cursor.sourceIdentity !== sourceIdentity ||
      stats.size < cursor.byteOffset
    ) {
      resetCursor(cursor, sourceIdentity);
    }
    if (stats.size <= cursor.byteOffset) {
      return { lines: [], hasMore: false, droppedOversizedLines: 0 };
    }

    const requestedBytes = Math.min(maxBytes, stats.size - cursor.byteOffset);
    const buffer = Buffer.allocUnsafe(requestedBytes);
    const { bytesRead } = await handle.read(
      buffer,
      0,
      requestedBytes,
      cursor.byteOffset,
    );
    const chunk = buffer.subarray(0, bytesRead);
    const lines: string[] = [];
    let droppedOversizedLines = 0;
    let segmentStart = 0;
    let consumedBytes = 0;

    while (segmentStart < chunk.length && lines.length < maxLines) {
      const newlineIndex = chunk.indexOf(0x0a, segmentStart);
      if (newlineIndex < 0) {
        break;
      }
      const wasDiscarding = cursor.discardingOversizedLine;
      const accepted = appendBoundedSegment(
        cursor,
        chunk.subarray(segmentStart, newlineIndex),
        maxLineBytes,
      );
      const line = finishLine(cursor);
      if (line !== undefined) {
        lines.push(line);
      } else if (wasDiscarding || !accepted) {
        droppedOversizedLines += 1;
      }
      segmentStart = newlineIndex + 1;
      consumedBytes = segmentStart;
    }

    if (lines.length < maxLines && segmentStart < chunk.length) {
      appendBoundedSegment(cursor, chunk.subarray(segmentStart), maxLineBytes);
      consumedBytes = chunk.length;
    }
    cursor.byteOffset += consumedBytes;
    return {
      lines,
      hasMore: stats.size > cursor.byteOffset,
      droppedOversizedLines,
    };
  } finally {
    await handle.close();
  }
}

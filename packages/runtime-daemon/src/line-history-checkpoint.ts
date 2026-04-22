import type { RahEvent } from "@rah/runtime-protocol";

type CachedSuffix = {
  suffixLines: string[];
  suffixEvents?: RahEvent[];
};

type CreateLineHistoryWindowTranslatorArgs = {
  sessionId: string;
  findSafeBoundaryIndex(lines: readonly string[]): number | null;
  translateLines(lines: readonly string[]): RahEvent[];
};

function arraysEndWith<T>(value: readonly T[], suffix: readonly T[]): boolean {
  if (suffix.length > value.length) {
    return false;
  }
  const offset = value.length - suffix.length;
  for (let index = 0; index < suffix.length; index += 1) {
    if (value[offset + index] !== suffix[index]) {
      return false;
    }
  }
  return true;
}

function normalizeHistoryWindowEvents(sessionId: string, events: readonly RahEvent[]): RahEvent[] {
  const ordered = [...events].sort((left, right) => left.ts.localeCompare(right.ts) || left.seq - right.seq);
  const turnIds = new Map<string, string>();
  let nextSeq = 1_000_000_000;
  let nextTurn = 0;
  return ordered.map((event) => {
    const turnId =
      event.turnId === undefined
        ? undefined
        : (turnIds.get(event.turnId) ??
          (() => {
            const rebound = `history:${sessionId}:turn-${++nextTurn}`;
            turnIds.set(event.turnId!, rebound);
            return rebound;
          })());
    return {
      ...event,
      id: `history:${sessionId}:${++nextSeq}`,
      seq: nextSeq,
      sessionId,
      ...(turnId !== undefined ? { turnId } : {}),
    };
  });
}

/**
 * Creates a loader-local ephemeral checkpoint strategy for line-oriented
 * history windows. The optimization is intentionally small:
 *
 * - it only applies when the same `endOffset` is re-read with a larger window
 * - it only reuses a suffix that begins at a provider-declared safe boundary
 * - it never persists outside the current loader instance
 */
export function createLineHistoryWindowTranslator(
  args: CreateLineHistoryWindowTranslatorArgs,
): (endOffset: number, lines: readonly string[]) => RahEvent[] {
  const cacheByEndOffset = new Map<number, CachedSuffix>();

  return (endOffset, lines) => {
    const cached = cacheByEndOffset.get(endOffset);
    if (cached && arraysEndWith(lines, cached.suffixLines) && lines.length > cached.suffixLines.length) {
      const prefixLines = lines.slice(0, lines.length - cached.suffixLines.length);
      const prefixEvents = args.translateLines(prefixLines);
      const suffixEvents = cached.suffixEvents ?? args.translateLines(cached.suffixLines);
      cached.suffixEvents = suffixEvents;
      return normalizeHistoryWindowEvents(args.sessionId, [...prefixEvents, ...suffixEvents]);
    }

    const translated = normalizeHistoryWindowEvents(args.sessionId, args.translateLines(lines));
    const safeBoundaryIndex = args.findSafeBoundaryIndex(lines);
    if (safeBoundaryIndex !== null && safeBoundaryIndex > 0) {
      cacheByEndOffset.set(endOffset, {
        suffixLines: [...lines.slice(safeBoundaryIndex)],
      });
    }
    return translated;
  };
}

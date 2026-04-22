import { randomUUID } from "node:crypto";
import type { RahEvent } from "@rah/runtime-protocol";
import type {
  FrozenHistoryBoundary,
  FrozenHistoryPage,
  FrozenHistoryPageLoader,
} from "./history-snapshots";

type LineHistoryWindow = {
  startOffset: number;
  events: RahEvent[];
};

type LineHistoryCursorState = {
  endOffset: number;
  carryEvents: RahEvent[];
};

type CreateLineFrozenHistoryPageLoaderArgs = {
  boundary: FrozenHistoryBoundary;
  snapshotEndOffset: number;
  readWindow(args: { endOffset: number; lineBudget: number }): LineHistoryWindow;
  selectPage?(events: readonly RahEvent[], limit: number): RahEvent[];
  initialLineBudget?: number;
  maxLineBudget?: number;
};

function defaultSelectPage(events: readonly RahEvent[], limit: number): RahEvent[] {
  return [...events].slice(Math.max(0, events.length - limit));
}

/**
 * Creates a provider-owned frozen history pager for line-oriented persisted
 * transcript files.
 *
 * The pager keeps loader-local cursor state so providers can:
 * - rewind the recent window semantically without creating gaps
 * - reuse excluded prefix events on subsequent older-page reads
 * - avoid turning cursor semantics into byte-offset arithmetic in the runtime
 */
export function createLineFrozenHistoryPageLoader(
  args: CreateLineFrozenHistoryPageLoaderArgs,
): FrozenHistoryPageLoader {
  const selectPage = args.selectPage ?? defaultSelectPage;
  const maxLineBudget = Math.max(args.maxLineBudget ?? 8192, 1);
  const cursorStateById = new Map<string, LineHistoryCursorState>();

  function storeCursorState(state: LineHistoryCursorState): string | undefined {
    if (state.endOffset <= 0 && state.carryEvents.length === 0) {
      return undefined;
    }
    const cursor = randomUUID();
    cursorStateById.set(cursor, {
      endOffset: state.endOffset,
      carryEvents: [...state.carryEvents],
    });
    return cursor;
  }

  function finalizePage(
    pageEvents: RahEvent[],
    nextState: LineHistoryCursorState,
  ): FrozenHistoryPage {
    const nextCursor = storeCursorState(nextState);
    return {
      boundary: args.boundary,
      events: pageEvents,
      ...(nextCursor ? { nextCursor } : {}),
      ...(pageEvents[0] ? { nextBeforeTs: pageEvents[0].ts } : {}),
    };
  }

  function pageFromCarry(state: LineHistoryCursorState, limit: number): FrozenHistoryPage {
    if (state.carryEvents.length === 0) {
      return finalizePage([], {
        endOffset: state.endOffset,
        carryEvents: [],
      });
    }
    const splitIndex = Math.max(0, state.carryEvents.length - limit);
    return finalizePage(state.carryEvents.slice(splitIndex), {
      endOffset: state.endOffset,
      carryEvents: state.carryEvents.slice(0, splitIndex),
    });
  }

  function buildPage(state: LineHistoryCursorState, limit: number): FrozenHistoryPage {
    const safeLimit = Math.max(1, limit);
    if (state.carryEvents.length >= safeLimit || state.endOffset <= 0) {
      return pageFromCarry(state, safeLimit);
    }

    let lineBudget = Math.max(args.initialLineBudget ?? safeLimit * 4, 1);
    for (;;) {
      const window = args.readWindow({
        endOffset: state.endOffset,
        lineBudget,
      });
      const combined = [...window.events, ...state.carryEvents];
      const pageEvents = selectPage(combined, safeLimit);
      const prefixLength = Math.max(0, combined.length - pageEvents.length);
      const nextState: LineHistoryCursorState = {
        endOffset: window.startOffset,
        carryEvents: combined.slice(0, prefixLength),
      };
      if (
        pageEvents.length >= safeLimit ||
        window.startOffset <= 0 ||
        window.startOffset === state.endOffset ||
        lineBudget >= maxLineBudget
      ) {
        return finalizePage(pageEvents, nextState);
      }
      lineBudget = Math.min(maxLineBudget, lineBudget * 2);
    }
  }

  return {
    loadInitialPage: (limit) =>
      buildPage(
        {
          endOffset: args.snapshotEndOffset,
          carryEvents: [],
        },
        limit,
      ),
    loadOlderPage: (cursor, limit, boundary) => {
      if (boundary.sourceRevision !== args.boundary.sourceRevision) {
        throw new Error("Frozen line history boundary changed while paging.");
      }
      const state = cursorStateById.get(cursor);
      if (!state) {
        throw new Error(`Unknown frozen line history cursor ${cursor}`);
      }
      return buildPage(state, limit);
    },
  };
}

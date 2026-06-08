import { randomUUID } from "node:crypto";
import type { RahEvent } from "@rah/runtime-protocol";
import type {
  FrozenHistoryBoundary,
  FrozenHistoryPage,
  FrozenHistoryPageLoader,
  HistoryEventFilter,
  HistoryPageFilterOptions,
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
  isPageStable?(events: readonly RahEvent[]): boolean;
  initialLineBudget?: number;
  maxLineBudget?: number;
};

function defaultSelectPage(events: readonly RahEvent[], limit: number): RahEvent[] {
  return [...events].slice(Math.max(0, events.length - limit));
}

function countPageCandidates(
  events: readonly RahEvent[],
  eventFilter: HistoryEventFilter | undefined,
): number {
  return eventFilter ? events.filter(eventFilter).length : events.length;
}

function selectPageFromCombined(args: {
  combined: RahEvent[];
  limit: number;
  eventFilter: HistoryEventFilter | undefined;
  selectPage: (events: readonly RahEvent[], limit: number) => RahEvent[];
}): { pageEvents: RahEvent[]; prefixEvents: RahEvent[] } {
  const candidates = args.eventFilter
    ? args.combined.filter(args.eventFilter)
    : args.combined;
  const pageEvents = args.eventFilter
    ? defaultSelectPage(candidates, args.limit)
    : args.selectPage(candidates, args.limit);
  const firstPageEvent = pageEvents[0];
  if (!firstPageEvent) {
    return {
      pageEvents: [],
      prefixEvents: [],
    };
  }
  const firstPageIndex = args.combined.indexOf(firstPageEvent);
  return {
    pageEvents,
    prefixEvents: args.combined.slice(0, Math.max(0, firstPageIndex)),
  };
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

  function pageFromCarry(
    state: LineHistoryCursorState,
    limit: number,
    options: HistoryPageFilterOptions | undefined,
  ): FrozenHistoryPage {
    const eventFilter = options?.eventFilter;
    if (countPageCandidates(state.carryEvents, eventFilter) === 0) {
      return finalizePage([], {
        endOffset: state.endOffset,
        carryEvents: [],
      });
    }
    const { pageEvents, prefixEvents } = selectPageFromCombined({
      combined: state.carryEvents,
      limit,
      eventFilter,
      selectPage,
    });
    return finalizePage(pageEvents, {
      endOffset: state.endOffset,
      carryEvents: prefixEvents,
    });
  }

  function buildPage(
    state: LineHistoryCursorState,
    limit: number,
    options: HistoryPageFilterOptions | undefined,
  ): FrozenHistoryPage {
    const safeLimit = Math.max(1, limit);
    const eventFilter = options?.eventFilter;
    if (countPageCandidates(state.carryEvents, eventFilter) >= safeLimit || state.endOffset <= 0) {
      return pageFromCarry(state, safeLimit, options);
    }

    let lineBudget = Math.max(args.initialLineBudget ?? safeLimit * 4, 1);
    for (;;) {
      const window = args.readWindow({
        endOffset: state.endOffset,
        lineBudget,
      });
      const combined = [...window.events, ...state.carryEvents];
      const { pageEvents, prefixEvents } = selectPageFromCombined({
        combined,
        limit: safeLimit,
        eventFilter,
        selectPage,
      });
      const pageStable = args.isPageStable?.(pageEvents) ?? true;
      const nextState: LineHistoryCursorState = {
        endOffset: window.startOffset,
        carryEvents: prefixEvents,
      };
      if (
        (pageEvents.length >= safeLimit && pageStable) ||
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
    loadInitialPage: (limit, options) =>
      buildPage(
        {
          endOffset: args.snapshotEndOffset,
          carryEvents: [],
        },
        limit,
        options,
      ),
    loadOlderPage: (cursor, limit, boundary, options) => {
      if (boundary.sourceRevision !== args.boundary.sourceRevision) {
        throw new Error("Frozen line history boundary changed while paging.");
      }
      const state = cursorStateById.get(cursor);
      if (!state) {
        throw new Error(`Unknown frozen line history cursor ${cursor}`);
      }
      return buildPage(state, limit, options);
    },
  };
}

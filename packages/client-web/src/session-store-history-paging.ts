import * as api from "./api";
import { readErrorMessage } from "./session-store-bootstrap";
import { takeDeferredBootstrapEvents } from "./session-store-history-bootstrap";
import { mergeLatestHistoryPage, prependHistoryPage } from "./session-store-history";
import { applyEventBatchToProjection } from "./session-store-projections";
import { isReadOnlyReplay } from "./session-capabilities";
import { isStoredHistoryReplayShellSummary } from "./stored-history-replay";
import type { SessionProjection } from "./types";

type HistoryPagingState = {
  projections: Map<string, SessionProjection>;
  error: string | null;
};

type HistoryPagingSetState = (
  partial:
    | Partial<HistoryPagingState>
    | ((state: HistoryPagingState) => Partial<HistoryPagingState> | HistoryPagingState),
) => void;

export async function ensureSessionHistoryLoadedCommand(args: {
  get: () => HistoryPagingState;
  loadOlderHistory: (sessionId: string) => Promise<void>;
  refreshLatestHistory?: (sessionId: string) => Promise<void>;
  sessionId: string;
}) {
  const projection = args.get().projections.get(args.sessionId);
  if (
    !projection ||
    projection.history.phase === "loading" ||
    !projection.summary.session.providerSessionId ||
    isStoredHistoryReplayShellSummary(projection.summary)
  ) {
    return;
  }
  if (!isReadOnlyReplay(projection.summary)) {
    await args.refreshLatestHistory?.(args.sessionId);
    return;
  }
  if (projection.history.authoritativeApplied) {
    await args.refreshLatestHistory?.(args.sessionId);
    return;
  }
  await args.loadOlderHistory(args.sessionId);
}

export async function refreshLatestHistoryCommand(args: {
  get: () => HistoryPagingState;
  set: HistoryPagingSetState;
  sessionId: string;
  historyPageLimit: number;
}) {
  const projection = args.get().projections.get(args.sessionId);
  if (!projection) {
    return;
  }
  if (
    !projection.summary.session.providerSessionId ||
    isStoredHistoryReplayShellSummary(projection.summary)
  ) {
    return;
  }

  const requestGeneration = projection.history.generation;

  try {
    const page = await api.readSessionHistory(args.sessionId, {
      limit: args.historyPageLimit,
      scope: "conversation",
    });
    args.set((state) => {
      const current = state.projections.get(args.sessionId);
      if (!current || current.history.generation !== requestGeneration) {
        return state;
      }
      const next = new Map(state.projections);
      const withHistory = mergeLatestHistoryPage(current, page.events, {
        ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
        ...(page.nextBeforeTs ? { nextBeforeTs: page.nextBeforeTs } : {}),
      });
      const replayed = applyEventBatchToProjection(
        withHistory,
        takeDeferredBootstrapEvents(args.sessionId),
      );
      next.set(args.sessionId, replayed);
      return { projections: next, error: null };
    });
  } catch (error) {
    args.set((state) => {
      const current = state.projections.get(args.sessionId);
      if (!current) {
        return state;
      }
      const next = new Map(state.projections);
      const failed = applyEventBatchToProjection(
        {
          ...current,
          history: {
            ...current.history,
            lastError: readErrorMessage(error),
          },
        },
        takeDeferredBootstrapEvents(args.sessionId),
      );
      next.set(args.sessionId, failed);
      return { projections: next };
    });
    throw error;
  }
}

export async function loadOlderHistoryCommand(args: {
  get: () => HistoryPagingState;
  set: HistoryPagingSetState;
  sessionId: string;
  historyPageLimit: number;
}) {
  const projection = args.get().projections.get(args.sessionId);
  if (
    !projection ||
    projection.history.phase === "loading" ||
    isStoredHistoryReplayShellSummary(projection.summary)
  ) {
    return;
  }

  const cursor = projection.history.nextCursor ?? undefined;
  const beforeTs =
    cursor === undefined
      ? projection.history.nextBeforeTs ?? projection.feed[0]?.ts ?? undefined
      : undefined;
  const requestGeneration = projection.history.generation + 1;

  args.set((state) => {
    const current = state.projections.get(args.sessionId);
    if (!current) {
      return state;
    }
    const next = new Map(state.projections);
    next.set(args.sessionId, {
      ...current,
      history: {
        ...current.history,
        phase: "loading",
        generation: requestGeneration,
        lastError: null,
      },
    });
    return { projections: next };
  });

  try {
    const page = await api.readSessionHistory(args.sessionId, {
      ...(cursor ? { cursor } : {}),
      ...(beforeTs ? { beforeTs } : {}),
      limit: args.historyPageLimit,
      scope: "conversation",
    });
    args.set((state) => {
      const current = state.projections.get(args.sessionId);
      if (!current || current.history.generation !== requestGeneration) {
        return state;
      }
      const next = new Map(state.projections);
      const withHistory = prependHistoryPage(current, page.events, {
        ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
        ...(page.nextBeforeTs ? { nextBeforeTs: page.nextBeforeTs } : {}),
      });
      const replayed = applyEventBatchToProjection(
        withHistory,
        takeDeferredBootstrapEvents(args.sessionId),
      );
      next.set(args.sessionId, replayed);
      return { projections: next, error: null };
    });
  } catch (error) {
    args.set((state) => {
      const current = state.projections.get(args.sessionId);
      if (!current) {
        return { error: readErrorMessage(error) };
      }
      const next = new Map(state.projections);
      const failed = applyEventBatchToProjection(
        {
          ...current,
          history: {
            ...current.history,
            phase: "error",
            lastError: readErrorMessage(error),
          },
        },
        takeDeferredBootstrapEvents(args.sessionId),
      );
      next.set(args.sessionId, failed);
      return { projections: next, error: readErrorMessage(error) };
    });
    throw error;
  }
}

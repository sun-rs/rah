import * as api from "./api";
import { readErrorMessage } from "./session-store-bootstrap";
import { mergeLatestHistoryPage } from "./session-store-history";
import type { SessionProjection } from "./types";

type TurnDirectoryState = {
  projections: Map<string, SessionProjection>;
};

type TurnDirectorySetState = (
  partial:
    | Partial<TurnDirectoryState>
    | ((state: TurnDirectoryState) => Partial<TurnDirectoryState> | TurnDirectoryState),
) => void;

const turnHistoryLoads = new Map<string, Promise<void>>();

function projectionHasTurn(projection: SessionProjection, turnId: string): boolean {
  return projection.feed.some(
    (entry) =>
      entry.turnId === turnId ||
      (entry.kind === "timeline" && entry.providerTurnId === turnId) ||
      ("canonicalTurnId" in entry && entry.canonicalTurnId === turnId),
  );
}

export async function ensureSessionTurnDirectoryCommand(args: {
  get: () => TurnDirectoryState;
  set: TurnDirectorySetState;
  sessionId: string;
}): Promise<void> {
  const projection = args.get().projections.get(args.sessionId);
  if (
    !projection?.summary.session.providerSessionId ||
    projection.turnDirectory?.phase === "loading" ||
    projection.turnDirectory?.phase === "ready"
  ) {
    return;
  }
  args.set((state) => {
    const current = state.projections.get(args.sessionId);
    if (!current) {
      return state;
    }
    const next = new Map(state.projections);
    next.set(args.sessionId, {
      ...current,
      turnDirectory: {
        phase: "loading",
        revision: current.turnDirectory?.revision ?? null,
        items: current.turnDirectory?.items ?? [],
        complete: current.turnDirectory?.complete ?? false,
        sourceBytes: current.turnDirectory?.sourceBytes ?? null,
        generatedAt: current.turnDirectory?.generatedAt ?? null,
        lastError: null,
      },
    });
    return { projections: next };
  });
  try {
    const directory = await api.readSessionTurnDirectory(args.sessionId);
    args.set((state) => {
      const current = state.projections.get(args.sessionId);
      if (!current) {
        return state;
      }
      const next = new Map(state.projections);
      next.set(args.sessionId, {
        ...current,
        turnDirectory: {
          phase: "ready",
          revision: directory.revision,
          items: directory.items,
          complete: directory.complete,
          sourceBytes: directory.sourceBytes ?? null,
          generatedAt: directory.generatedAt,
          lastError: null,
        },
      });
      return { projections: next };
    });
  } catch (error) {
    args.set((state) => {
      const current = state.projections.get(args.sessionId);
      if (!current) {
        return state;
      }
      const next = new Map(state.projections);
      next.set(args.sessionId, {
        ...current,
        turnDirectory: {
          phase: "error",
          revision: current.turnDirectory?.revision ?? null,
          items: current.turnDirectory?.items ?? [],
          complete: current.turnDirectory?.complete ?? false,
          sourceBytes: current.turnDirectory?.sourceBytes ?? null,
          generatedAt: current.turnDirectory?.generatedAt ?? null,
          lastError: readErrorMessage(error),
        },
      });
      return { projections: next };
    });
  }
}

export async function loadSessionTurnHistoryCommand(args: {
  get: () => TurnDirectoryState;
  set: TurnDirectorySetState;
  sessionId: string;
  turnId: string;
}): Promise<void> {
  const projection = args.get().projections.get(args.sessionId);
  if (!projection || projectionHasTurn(projection, args.turnId)) {
    return;
  }
  const key = `${args.sessionId}:${args.turnId}`;
  const currentLoad = turnHistoryLoads.get(key);
  if (currentLoad) {
    return currentLoad;
  }
  const load = (async () => {
    try {
      const turn = await api.readSessionTurnHistory(args.sessionId, args.turnId);
      args.set((state) => {
        const current = state.projections.get(args.sessionId);
        if (!current) {
          return state;
        }
        const next = new Map(state.projections);
        next.set(args.sessionId, mergeLatestHistoryPage(current, turn.events));
        return { projections: next };
      });
    } catch (error) {
      args.set((state) => {
        const current = state.projections.get(args.sessionId);
        if (!current) {
          return state;
        }
        const next = new Map(state.projections);
        next.set(args.sessionId, {
          ...current,
          turnDirectory: {
            phase: current.turnDirectory?.phase ?? "error",
            revision: current.turnDirectory?.revision ?? null,
            items: current.turnDirectory?.items ?? [],
            complete: current.turnDirectory?.complete ?? false,
            sourceBytes: current.turnDirectory?.sourceBytes ?? null,
            generatedAt: current.turnDirectory?.generatedAt ?? null,
            lastError: readErrorMessage(error),
          },
        });
        return { projections: next };
      });
      throw error;
    }
  })().finally(() => {
    if (turnHistoryLoads.get(key) === load) {
      turnHistoryLoads.delete(key);
    }
  });
  turnHistoryLoads.set(key, load);
  return load;
}

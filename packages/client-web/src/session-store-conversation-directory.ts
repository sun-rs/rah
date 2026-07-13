import * as api from "./api";
import { readErrorMessage } from "./session-store-bootstrap";
import {
  ensureConversationLoadedCommand,
  hydrateConversationTurnByProviderIdCommand,
} from "./session-store-conversation";
import type { SessionProjection } from "./types";

type TurnDirectoryState = {
  projections: Map<string, SessionProjection>;
};

type TurnDirectorySetState = (
  partial:
    | Partial<TurnDirectoryState>
    | ((state: TurnDirectoryState) => Partial<TurnDirectoryState> | TurnDirectoryState),
) => void;

const directoryTurnLoads = new Map<string, Promise<void>>();

export async function ensureSessionConversationDirectoryCommand(args: {
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
    const directory = await api.readSessionConversationDirectory(args.sessionId);
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

export async function loadConversationDirectoryTurnCommand(args: {
  get: () => TurnDirectoryState;
  set: TurnDirectorySetState;
  sessionId: string;
  turnId: string;
}): Promise<void> {
  const projection = args.get().projections.get(args.sessionId);
  if (!projection) {
    return;
  }
  const key = `${args.sessionId}:${args.turnId}`;
  const currentLoad = directoryTurnLoads.get(key);
  if (currentLoad) {
    return currentLoad;
  }
  const load = (async () => {
    try {
      if (!projection.conversation) {
        const initialized = await ensureConversationLoadedCommand(
          { get: args.get, set: args.set },
          args.sessionId,
        );
        if (!initialized) {
          throw new Error("Canonical conversation history is not available.");
        }
      }
      const loaded = await hydrateConversationTurnByProviderIdCommand(
        { get: args.get, set: args.set },
        args.sessionId,
        args.turnId,
      );
      if (loaded) {
        return;
      }
      throw new Error("Canonical conversation turn detail is not available.");
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
    if (directoryTurnLoads.get(key) === load) {
      directoryTurnLoads.delete(key);
    }
  });
  directoryTurnLoads.set(key, load);
  return load;
}

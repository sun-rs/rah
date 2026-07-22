import type {
  ConversationOutputProjection,
  ConversationSourceProjection,
  ConversationTurnDetailResponse,
  ConversationTurnProjection,
  ConversationTurnsPageResponse,
} from "@rah/runtime-protocol";
import {
  mergeConversationOutputs,
  mergeConversationSources,
} from "../conversation-resources";

export type ConversationResourceIndex = {
  outputs: ConversationOutputProjection[];
  sources: ConversationSourceProjection[];
};

type TurnResources = ConversationResourceIndex;

type ResourceIndexDependencies = {
  readTurns: (
    sessionId: string,
    options: { cursor?: string; limit: number; signal?: AbortSignal },
  ) => Promise<ConversationTurnsPageResponse>;
  readTurnDetail: (
    sessionId: string,
    options: { turnId: string; providerTurnId: string; signal?: AbortSignal },
  ) => Promise<ConversationTurnDetailResponse>;
};

function abortError(): Error {
  const error = new Error("The operation was aborted.");
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw abortError();
  }
}

function turnKey(turn: ConversationTurnProjection): string {
  return turn.providerTurnId ?? turn.id;
}

function resourcesFromTurn(turn: ConversationTurnProjection): TurnResources {
  return {
    outputs: [...(turn.outputs ?? [])],
    sources: [...(turn.sources ?? [])],
  };
}

function aggregateTurnResources(
  resourcesByTurn: ReadonlyMap<string, TurnResources>,
): ConversationResourceIndex {
  let outputs: ConversationOutputProjection[] = [];
  let sources: ConversationSourceProjection[] = [];
  for (const resources of resourcesByTurn.values()) {
    outputs = mergeConversationOutputs(outputs, resources.outputs);
    sources = mergeConversationSources(sources, resources.sources);
  }
  return { outputs, sources };
}

async function hydrateSummaryTurns(args: {
  sessionId: string;
  turns: readonly ConversationTurnProjection[];
  fullProviderTurnIds: Set<string>;
  resourcesByTurn: Map<string, TurnResources>;
  signal?: AbortSignal;
  readTurnDetail: ResourceIndexDependencies["readTurnDetail"];
}): Promise<void> {
  const candidates = args.turns.filter(
    (turn) =>
      turn.itemsView !== "full" &&
      Boolean(turn.providerTurnId) &&
      !args.fullProviderTurnIds.has(turn.providerTurnId!),
  );
  let cursor = 0;
  const worker = async () => {
    while (cursor < candidates.length) {
      throwIfAborted(args.signal);
      const turn = candidates[cursor++];
      if (!turn?.providerTurnId) continue;
      try {
        const detail = await args.readTurnDetail(args.sessionId, {
          turnId: turn.id,
          providerTurnId: turn.providerTurnId,
          ...(args.signal ? { signal: args.signal } : {}),
        });
        throwIfAborted(args.signal);
        args.resourcesByTurn.set(turnKey(turn), resourcesFromTurn(detail.turn));
        args.fullProviderTurnIds.add(turn.providerTurnId);
      } catch (error) {
        if (args.signal?.aborted || (error instanceof Error && error.name === "AbortError")) {
          throw abortError();
        }
        // Some providers or historical records cannot expose full turn detail.
        // Keep any resource metadata already present on the summary in that case.
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(3, candidates.length) }, () => worker()),
  );
}

/**
 * Builds an Inspector-only resource index without hydrating or replacing the
 * conversation turns currently rendered by Chat.
 */
export async function loadConversationResourceIndex(args: {
  sessionId: string;
  seedTurns?: readonly ConversationTurnProjection[];
  signal?: AbortSignal;
  onProgress?: (index: ConversationResourceIndex) => void;
  dependencies: ResourceIndexDependencies;
}): Promise<ConversationResourceIndex> {
  const resourcesByTurn = new Map<string, TurnResources>();
  const fullProviderTurnIds = new Set<string>();
  for (const turn of args.seedTurns ?? []) {
    resourcesByTurn.set(turnKey(turn), resourcesFromTurn(turn));
    if (turn.itemsView === "full" && turn.providerTurnId) {
      fullProviderTurnIds.add(turn.providerTurnId);
    }
  }
  args.onProgress?.(aggregateTurnResources(resourcesByTurn));

  let cursor: string | undefined;
  const seenCursors = new Set<string>();
  do {
    throwIfAborted(args.signal);
    const page = await args.dependencies.readTurns(args.sessionId, {
      ...(cursor ? { cursor } : {}),
      limit: 100,
      ...(args.signal ? { signal: args.signal } : {}),
    });
    throwIfAborted(args.signal);
    for (const turn of page.turns) {
      const key = turnKey(turn);
      if (!fullProviderTurnIds.has(turn.providerTurnId ?? "")) {
        resourcesByTurn.set(key, resourcesFromTurn(turn));
      }
      if (turn.itemsView === "full" && turn.providerTurnId) {
        fullProviderTurnIds.add(turn.providerTurnId);
      }
    }
    await hydrateSummaryTurns({
      sessionId: args.sessionId,
      turns: page.turns,
      fullProviderTurnIds,
      resourcesByTurn,
      ...(args.signal ? { signal: args.signal } : {}),
      readTurnDetail: args.dependencies.readTurnDetail,
    });
    args.onProgress?.(aggregateTurnResources(resourcesByTurn));

    const nextCursor = page.nextCursor;
    if (!nextCursor || seenCursors.has(nextCursor)) {
      cursor = undefined;
      break;
    }
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  } while (cursor);

  const result = aggregateTurnResources(resourcesByTurn);
  args.onProgress?.(result);
  return result;
}

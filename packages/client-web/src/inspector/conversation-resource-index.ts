import type {
  ConversationOutputProjection,
  ConversationResourceIndexResponse,
  ConversationSourceProjection,
  ConversationTurnProjection,
} from "@rah/runtime-protocol";
import {
  mergeConversationOutputs,
  mergeConversationSources,
} from "../conversation-resources";

export type ConversationResourceIndex = {
  outputs: ConversationOutputProjection[];
  sources: ConversationSourceProjection[];
};

type ResourceIndexDependencies = {
  readIndex: (
    sessionId: string,
    options?: { refresh?: boolean; signal?: AbortSignal },
  ) => Promise<ConversationResourceIndexResponse>;
};

type ConversationResourceIndexCacheEntry = {
  index: ConversationResourceIndex;
  complete: boolean;
  validatedAt: number;
  sourceRevision?: string;
  warning?: string;
  promise?: Promise<ConversationResourceIndex>;
};

const RESOURCE_INDEX_CACHE_LIMIT = 50;
const RESOURCE_INDEX_REVALIDATE_MS = 2_000;
const resourceIndexCache = new Map<string, ConversationResourceIndexCacheEntry>();
const forceRefreshSessionIds = new Set<string>();

function mergeResourceIndexes(
  left: ConversationResourceIndex,
  right: ConversationResourceIndex,
): ConversationResourceIndex {
  return {
    outputs: mergeConversationOutputs(left.outputs, right.outputs),
    sources: mergeConversationSources(left.sources, right.sources),
  };
}

function seedResourceIndex(
  turns: readonly ConversationTurnProjection[] | undefined,
): ConversationResourceIndex {
  let outputs: ConversationOutputProjection[] = [];
  let sources: ConversationSourceProjection[] = [];
  for (const turn of turns ?? []) {
    outputs = mergeConversationOutputs(outputs, turn.outputs);
    sources = mergeConversationSources(sources, turn.sources);
  }
  return { outputs, sources };
}

function trimResourceIndexCache(): void {
  while (resourceIndexCache.size > RESOURCE_INDEX_CACHE_LIMIT) {
    const oldestKey = resourceIndexCache.keys().next().value as string | undefined;
    if (!oldestKey) return;
    resourceIndexCache.delete(oldestKey);
  }
}

export function readCachedConversationResourceIndex(
  sessionId: string,
): { index: ConversationResourceIndex; complete: boolean; warning?: string } | undefined {
  const entry = resourceIndexCache.get(sessionId);
  if (!entry) return undefined;
  return {
    index: entry.index,
    complete: entry.complete,
    ...(entry.warning ? { warning: entry.warning } : {}),
  };
}

export function resetConversationResourceIndexCacheForTests(): void {
  resourceIndexCache.clear();
  forceRefreshSessionIds.clear();
}

export function invalidateCachedConversationResourceIndex(sessionId: string): void {
  resourceIndexCache.delete(sessionId);
  forceRefreshSessionIds.add(sessionId);
}

export async function loadConversationResourceIndex(args: {
  sessionId: string;
  seedTurns?: readonly ConversationTurnProjection[];
  signal?: AbortSignal;
  refresh?: boolean;
  onProgress?: (index: ConversationResourceIndex) => void;
  onWarning?: (warning: string) => void;
  dependencies: ResourceIndexDependencies;
}): Promise<ConversationResourceIndex> {
  const seed = seedResourceIndex(args.seedTurns);
  args.onProgress?.(seed);
  const response = await args.dependencies.readIndex(args.sessionId, {
    ...(args.refresh ? { refresh: true } : {}),
    ...(args.signal ? { signal: args.signal } : {}),
  });
  const index = mergeResourceIndexes(
    { outputs: response.outputs, sources: response.sources },
    seed,
  );
  args.onProgress?.(index);
  if (response.warning) {
    args.onWarning?.(response.warning);
  }
  return index;
}

/**
 * Keeps a small client cache for instant Inspector remounts while revalidating
 * through one daemon-owned provider-neutral resource-index request.
 */
export async function loadCachedConversationResourceIndex(args: {
  sessionId: string;
  seedTurns?: readonly ConversationTurnProjection[];
  onProgress?: (index: ConversationResourceIndex) => void;
  onWarning?: (warning: string) => void;
  dependencies: ResourceIndexDependencies;
}): Promise<ConversationResourceIndex> {
  const seed = seedResourceIndex(args.seedTurns);
  let entry = resourceIndexCache.get(args.sessionId);
  if (!entry) {
    entry = { index: seed, complete: false, validatedAt: 0 };
    resourceIndexCache.set(args.sessionId, entry);
    trimResourceIndexCache();
  } else {
    entry.index = mergeResourceIndexes(entry.index, seed);
    resourceIndexCache.delete(args.sessionId);
    resourceIndexCache.set(args.sessionId, entry);
  }
  args.onProgress?.(entry.index);
  if (
    !entry.promise &&
    entry.validatedAt > 0 &&
    Date.now() - entry.validatedAt < RESOURCE_INDEX_REVALIDATE_MS
  ) {
    if (entry.warning) args.onWarning?.(entry.warning);
    return entry.index;
  }
  if (!entry.promise) {
    const activeEntry = entry;
    const refresh = forceRefreshSessionIds.delete(args.sessionId);
    const request = args.dependencies
      .readIndex(args.sessionId, refresh ? { refresh: true } : undefined)
      .then((response) => {
        activeEntry.index = mergeResourceIndexes(
          { outputs: response.outputs, sources: response.sources },
          seed,
        );
        activeEntry.complete = response.complete;
        activeEntry.validatedAt = Date.now();
        activeEntry.sourceRevision = response.sourceRevision;
        if (response.warning) {
          activeEntry.warning = response.warning;
        } else {
          delete activeEntry.warning;
        }
        return activeEntry.index;
      })
      .finally(() => {
        delete activeEntry.promise;
      });
    activeEntry.promise = request;
  }
  const pending = entry.promise;
  if (!pending) {
    return entry.index;
  }
  const result = mergeResourceIndexes(await pending, seed);
  entry.index = result;
  args.onProgress?.(result);
  if (entry.warning) args.onWarning?.(entry.warning);
  return result;
}

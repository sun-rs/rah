import {
  CONVERSATION_RESOURCE_INDEX_PROTOCOL_VERSION,
  type ConversationOutputProjection,
  type ConversationResourceIndexResponse,
  type ConversationSourceProjection,
} from "@rah/runtime-protocol";
import { waitForSharedRequest } from "../shared-cache-request";

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
  publishedSnapshotId?: string;
  warning?: string;
  error?: string;
  controller?: AbortController;
  promise?: Promise<ConversationResourceIndex>;
};

export type ConversationResourceIndexSnapshot = {
  index: ConversationResourceIndex;
  complete: boolean;
  validated: boolean;
  warning?: string;
  error?: string;
};

type ConversationResourceIndexListener = (
  snapshot: ConversationResourceIndexSnapshot | undefined,
) => void;

const RESOURCE_INDEX_CACHE_LIMIT = 50;
const RESOURCE_INDEX_REVALIDATE_MS = 2_000;
const RESOURCE_INDEX_POLL_INITIAL_MS = 300;
const RESOURCE_INDEX_POLL_MAX_MS = 1_500;
const resourceIndexCache = new Map<string, ConversationResourceIndexCacheEntry>();
const forceRefreshSessionIds = new Set<string>();
const resourceIndexListeners = new Map<
  string,
  Set<ConversationResourceIndexListener>
>();

function trimResourceIndexCache(): void {
  while (resourceIndexCache.size > RESOURCE_INDEX_CACHE_LIMIT) {
    const oldestKey = resourceIndexCache.keys().next().value as string | undefined;
    if (!oldestKey) return;
    resourceIndexCache.get(oldestKey)?.controller?.abort();
    resourceIndexCache.delete(oldestKey);
  }
}

function assertSupportedResourceIndexResponse(
  response: ConversationResourceIndexResponse,
): void {
  if (
    response.protocolVersion !==
    CONVERSATION_RESOURCE_INDEX_PROTOCOL_VERSION
  ) {
    throw new Error(
      "The RAH daemon uses an incompatible Outputs/Sources index protocol. Restart RAH, then reload this page.",
    );
  }
  if (response.stable !== true && response.indexing !== true) {
    throw new Error(
      "The RAH daemon returned an uncommitted Outputs/Sources index response. Restart RAH, then reload this page.",
    );
  }
}

function waitForResourceIndexPoll(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(
      signal.reason instanceof Error
        ? signal.reason
        : new DOMException("The operation was aborted.", "AbortError"),
    );
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      globalThis.clearTimeout(timeout);
      reject(
        signal?.reason instanceof Error
          ? signal.reason
          : new DOMException("The operation was aborted.", "AbortError"),
      );
    };
    const timeout = globalThis.setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function readCachedConversationResourceIndex(
  sessionId: string,
): ConversationResourceIndexSnapshot | undefined {
  const entry = resourceIndexCache.get(sessionId);
  if (!entry) return undefined;
  return {
    index: entry.index,
    complete: entry.complete,
    validated: entry.validatedAt > 0,
    ...(entry.warning ? { warning: entry.warning } : {}),
    ...(entry.error ? { error: entry.error } : {}),
  };
}

function notifyResourceIndex(sessionId: string): void {
  const snapshot = readCachedConversationResourceIndex(sessionId);
  for (const listener of resourceIndexListeners.get(sessionId) ?? []) {
    listener(snapshot);
  }
}

export function subscribeConversationResourceIndex(
  sessionId: string,
  listener: ConversationResourceIndexListener,
): () => void {
  let listeners = resourceIndexListeners.get(sessionId);
  if (!listeners) {
    listeners = new Set();
    resourceIndexListeners.set(sessionId, listeners);
  }
  listeners.add(listener);
  listener(readCachedConversationResourceIndex(sessionId));
  return () => {
    const current = resourceIndexListeners.get(sessionId);
    current?.delete(listener);
    if (current?.size === 0) {
      resourceIndexListeners.delete(sessionId);
    }
  };
}

export function resetConversationResourceIndexCacheForTests(): void {
  for (const entry of resourceIndexCache.values()) {
    entry.controller?.abort();
  }
  resourceIndexCache.clear();
  forceRefreshSessionIds.clear();
  resourceIndexListeners.clear();
}

export function invalidateCachedConversationResourceIndex(sessionId: string): void {
  forceRefreshSessionIds.add(sessionId);
  const entry = resourceIndexCache.get(sessionId);
  if (entry) {
    delete entry.error;
  }
  notifyResourceIndex(sessionId);
}

/**
 * Keeps a small client cache for instant Inspector remounts while revalidating
 * through one daemon-owned provider-neutral resource-index request.
 */
export async function loadCachedConversationResourceIndex(args: {
  sessionId: string;
  signal?: AbortSignal;
  onWarning?: (warning: string) => void;
  dependencies: ResourceIndexDependencies;
}): Promise<ConversationResourceIndex> {
  let entry = resourceIndexCache.get(args.sessionId);
  if (!entry) {
    entry = {
      index: { outputs: [], sources: [] },
      complete: false,
      validatedAt: 0,
    };
    resourceIndexCache.set(args.sessionId, entry);
    trimResourceIndexCache();
  } else {
    resourceIndexCache.delete(args.sessionId);
    resourceIndexCache.set(args.sessionId, entry);
  }
  notifyResourceIndex(args.sessionId);
  const refreshRequested = forceRefreshSessionIds.has(args.sessionId);
  if (
    !entry.promise &&
    !refreshRequested &&
    entry.validatedAt > 0 &&
    Date.now() - entry.validatedAt < RESOURCE_INDEX_REVALIDATE_MS
  ) {
    if (entry.warning) args.onWarning?.(entry.warning);
    return entry.index;
  }
  if (entry.promise && refreshRequested) {
    await waitForSharedRequest(entry.promise, args.signal);
    return loadCachedConversationResourceIndex(args);
  }
  if (!entry.promise) {
    const activeEntry = entry;
    const refresh = forceRefreshSessionIds.delete(args.sessionId);
    const controller = new AbortController();
    activeEntry.controller = controller;
    const request = (async () => {
      let requestRefresh = refresh;
      let pollDelayMs = RESOURCE_INDEX_POLL_INITIAL_MS;
      let previousGeneratedAt: string | undefined;
      for (;;) {
        const response = await args.dependencies.readIndex(args.sessionId, {
          ...(requestRefresh ? { refresh: true } : {}),
          signal: controller.signal,
        });
        assertSupportedResourceIndexResponse(response);
        requestRefresh = false;
        const stableSnapshot =
          response.stable === true;
        const publishedSnapshotId = stableSnapshot
          ? `${response.sourceRevision}\u0000${response.generatedAt}`
          : undefined;
        if (
          stableSnapshot &&
          activeEntry.publishedSnapshotId !== publishedSnapshotId
        ) {
          activeEntry.index = {
            outputs: response.outputs,
            sources: response.sources,
          };
          activeEntry.complete = response.complete;
          activeEntry.validatedAt = Date.now();
          activeEntry.publishedSnapshotId =
            `${response.sourceRevision}\u0000${response.generatedAt}`;
          if (response.warning) {
            activeEntry.warning = response.warning;
          } else {
            delete activeEntry.warning;
          }
          delete activeEntry.error;
          notifyResourceIndex(args.sessionId);
        }
        if (response.indexing !== true) {
          return activeEntry.index;
        }
        pollDelayMs =
          previousGeneratedAt && previousGeneratedAt === response.generatedAt
            ? Math.min(
                RESOURCE_INDEX_POLL_MAX_MS,
                Math.round(pollDelayMs * 1.5),
              )
            : RESOURCE_INDEX_POLL_INITIAL_MS;
        previousGeneratedAt = response.generatedAt;
        await waitForResourceIndexPoll(pollDelayMs, controller.signal);
      }
    })()
      .catch((error) => {
        if (!controller.signal.aborted) {
          activeEntry.error = error instanceof Error ? error.message : String(error);
          notifyResourceIndex(args.sessionId);
        }
        throw error;
      })
      .finally(() => {
        if (activeEntry.promise === request) {
          delete activeEntry.promise;
          delete activeEntry.controller;
        }
      });
    activeEntry.promise = request;
  }
  const pending = entry.promise;
  if (!pending) {
    return entry.index;
  }
  const pendingResult = await waitForSharedRequest(pending, args.signal);
  entry.index = pendingResult;
  if (entry.warning) args.onWarning?.(entry.warning);
  return pendingResult;
}

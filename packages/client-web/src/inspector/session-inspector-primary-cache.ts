import type { GitStatusResponse } from "@rah/runtime-protocol";
import {
  listDirectory,
  readGitStatus,
  type DirectoryListingResponse,
} from "../api";
import type { DirectoryEntry, InspectorGitStatus } from "./shared";

export type SessionInspectorPrimarySnapshot = {
  gitStatus: InspectorGitStatus | null;
  rootEntries: DirectoryEntry[];
  gitStatusError: string | null;
  directoryError: string | null;
  complete: boolean;
};

type SessionInspectorPrimaryDependencies = {
  readGitStatus: (
    sessionId: string,
    options: { scopeRoot: string; signal?: AbortSignal },
  ) => Promise<GitStatusResponse>;
  listDirectory: (
    path: string,
    options?: { signal?: AbortSignal },
  ) => Promise<DirectoryListingResponse>;
};

type SessionInspectorPrimaryCacheEntry = {
  snapshot: SessionInspectorPrimarySnapshot;
  validatedAt: number;
  promise?: Promise<SessionInspectorPrimarySnapshot>;
};

type SessionInspectorPrimaryListener = (
  snapshot: SessionInspectorPrimarySnapshot,
) => void;

const PRIMARY_CACHE_LIMIT = 50;
const PRIMARY_REVALIDATE_MS = 2_000;
const primaryCache = new Map<string, SessionInspectorPrimaryCacheEntry>();
const primaryListeners = new Map<string, Set<SessionInspectorPrimaryListener>>();

const defaultDependencies: SessionInspectorPrimaryDependencies = {
  readGitStatus,
  listDirectory,
};

function cacheKey(sessionId: string, workspaceRoot: string): string {
  return `${sessionId}\u0000${workspaceRoot}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof Error && error.name === "AbortError")
  );
}

function sortDirectoryEntries(entries: readonly DirectoryEntry[]): DirectoryEntry[] {
  return [...entries].sort((left, right) => {
    if (left.type === right.type) {
      return left.name.localeCompare(right.name);
    }
    return left.type === "directory" ? -1 : 1;
  });
}

function emptySnapshot(): SessionInspectorPrimarySnapshot {
  return {
    gitStatus: null,
    rootEntries: [],
    gitStatusError: null,
    directoryError: null,
    complete: false,
  };
}

function notify(
  key: string,
  snapshot: SessionInspectorPrimarySnapshot,
): void {
  for (const listener of primaryListeners.get(key) ?? []) {
    listener(snapshot);
  }
}

function trimCache(): void {
  while (primaryCache.size > PRIMARY_CACHE_LIMIT) {
    const oldestKey = primaryCache.keys().next().value as string | undefined;
    if (!oldestKey) return;
    primaryCache.delete(oldestKey);
  }
}

export function normalizeInspectorGitStatus(
  response: GitStatusResponse,
): InspectorGitStatus {
  return {
    ...(response.branch ? { branch: response.branch } : {}),
    ...(response.baseBranch ? { baseBranch: response.baseBranch } : {}),
    ...(response.comparisonMode ? { comparisonMode: response.comparisonMode } : {}),
    ...(response.comparisonBase ? { comparisonBase: response.comparisonBase } : {}),
    branchOptions: response.branchOptions ?? [],
    branchFiles: response.branchFiles ?? [],
    changedFiles: response.changedFiles,
    stagedFiles: response.stagedFiles ?? [],
    unstagedFiles: response.unstagedFiles ?? [],
    totalBranch: response.totalBranch ?? response.branchFiles?.length ?? 0,
    totalStaged: response.totalStaged ?? response.stagedFiles?.length ?? 0,
    totalUnstaged: response.totalUnstaged ?? response.unstagedFiles?.length ?? 0,
  };
}

export function readCachedSessionInspectorPrimary(
  sessionId: string,
  workspaceRoot: string,
): SessionInspectorPrimarySnapshot | undefined {
  return primaryCache.get(cacheKey(sessionId, workspaceRoot))?.snapshot;
}

export function subscribeSessionInspectorPrimary(
  sessionId: string,
  workspaceRoot: string,
  listener: SessionInspectorPrimaryListener,
): () => void {
  const key = cacheKey(sessionId, workspaceRoot);
  let listeners = primaryListeners.get(key);
  if (!listeners) {
    listeners = new Set();
    primaryListeners.set(key, listeners);
  }
  listeners.add(listener);
  const cached = primaryCache.get(key)?.snapshot;
  if (cached) {
    listener(cached);
  }
  return () => {
    const current = primaryListeners.get(key);
    current?.delete(listener);
    if (current?.size === 0) {
      primaryListeners.delete(key);
    }
  };
}

export function resetSessionInspectorPrimaryCacheForTests(): void {
  primaryCache.clear();
  primaryListeners.clear();
}

/**
 * Loads the two high-probability Inspector surfaces as one cacheable stage.
 * Changes and the workspace root listing run concurrently, but this stage is
 * started only after Chat hydration by the session-view preload coordinator.
 */
export async function loadCachedSessionInspectorPrimary(args: {
  sessionId: string;
  workspaceRoot: string;
  signal?: AbortSignal;
  refresh?: boolean;
  dependencies?: SessionInspectorPrimaryDependencies;
}): Promise<SessionInspectorPrimarySnapshot> {
  const key = cacheKey(args.sessionId, args.workspaceRoot);
  let entry = primaryCache.get(key);
  if (!entry) {
    entry = { snapshot: emptySnapshot(), validatedAt: 0 };
    primaryCache.set(key, entry);
    trimCache();
  } else {
    primaryCache.delete(key);
    primaryCache.set(key, entry);
  }

  if (!args.workspaceRoot) {
    entry.snapshot = { ...emptySnapshot(), complete: true };
    entry.validatedAt = Date.now();
    notify(key, entry.snapshot);
    return entry.snapshot;
  }

  if (
    !args.refresh &&
    !entry.promise &&
    entry.validatedAt > 0 &&
    Date.now() - entry.validatedAt < PRIMARY_REVALIDATE_MS
  ) {
    return entry.snapshot;
  }

  if (!entry.promise) {
    const activeEntry = entry;
    const dependencies = args.dependencies ?? defaultDependencies;
    activeEntry.snapshot = { ...activeEntry.snapshot, complete: false };
    notify(key, activeEntry.snapshot);

    const request = Promise.allSettled([
      dependencies.readGitStatus(args.sessionId, {
        scopeRoot: args.workspaceRoot,
        ...(args.signal ? { signal: args.signal } : {}),
      }),
      dependencies.listDirectory(
        args.workspaceRoot,
        args.signal ? { signal: args.signal } : undefined,
      ),
    ])
      .then(([gitResult, directoryResult]) => {
        if (args.signal?.aborted) {
          throw args.signal.reason instanceof Error
            ? args.signal.reason
            : new DOMException("The operation was aborted.", "AbortError");
        }
        activeEntry.snapshot = {
          gitStatus:
            gitResult.status === "fulfilled"
              ? normalizeInspectorGitStatus(gitResult.value)
              : null,
          rootEntries:
            directoryResult.status === "fulfilled"
              ? sortDirectoryEntries(directoryResult.value.entries)
              : [],
          gitStatusError:
            gitResult.status === "rejected" ? errorMessage(gitResult.reason) : null,
          directoryError:
            directoryResult.status === "rejected"
              ? errorMessage(directoryResult.reason)
              : null,
          complete: true,
        };
        activeEntry.validatedAt = Date.now();
        notify(key, activeEntry.snapshot);
        return activeEntry.snapshot;
      })
      .finally(() => {
        delete activeEntry.promise;
      });
    activeEntry.promise = request;
  }

  const pending = entry.promise;
  if (!pending) {
    return entry.snapshot;
  }
  try {
    return await pending;
  } catch (error) {
    // A new view can reuse this key while the previous view's cancelled
    // request is still settling. Retry only for that shared-abort race; real
    // failures and cancellation of the current view remain authoritative.
    if (isAbortError(error) && !args.signal?.aborted) {
      return loadCachedSessionInspectorPrimary(args);
    }
    throw error;
  }
}

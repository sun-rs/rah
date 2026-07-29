import { readSessionConversationResourceIndex } from "./api";
import {
  loadCachedConversationResourceIndex,
  readCachedConversationResourceIndex,
} from "./inspector/conversation-resource-index";
import {
  loadCachedSessionInspectorPrimary,
  readCachedSessionInspectorPrimary,
} from "./inspector/session-inspector-primary-cache";
import {
  startSessionViewPerformanceTrace,
  type SessionViewCacheState,
  type SessionViewPerformanceTraceHandle,
  type SessionViewPreloadStage,
} from "./session-view-performance";

export type SessionViewPreloadStageDependencies = {
  hydrateConversation: () => Promise<unknown>;
  loadChangesAndFiles: () => Promise<unknown>;
  loadOutputsAndSources: () => Promise<unknown>;
};

export type SessionViewPreloadObserver = Pick<
  SessionViewPerformanceTraceHandle,
  "stageStarted" | "stageSettled"
>;

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new DOMException("The operation was aborted.", "AbortError");
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

async function observeStage(
  stage: SessionViewPreloadStage,
  dependency: () => Promise<unknown>,
  observer?: SessionViewPreloadObserver,
): Promise<void> {
  observer?.stageStarted(stage);
  try {
    await dependency();
    observer?.stageSettled(stage, "ready");
  } catch (error) {
    observer?.stageSettled(
      stage,
      isAbortError(error) ? "aborted" : "error",
      error,
    );
    throw error;
  }
}

export async function runSessionViewPreloadStages(args: {
  signal?: AbortSignal;
  dependencies: SessionViewPreloadStageDependencies;
  observer?: SessionViewPreloadObserver;
}): Promise<void> {
  try {
    await observeStage(
      "chat",
      args.dependencies.hydrateConversation,
      args.observer,
    );
  } catch {
    throwIfAborted(args.signal);
  }
  throwIfAborted(args.signal);
  // Preserve launch priority without turning it into a completion barrier.
  // Git status can take seconds in a large worktree, while detached provider
  // resource indexing can take much longer. Once Chat is usable, start both
  // Inspector stages in order so either surface may become ready first.
  const changesAndFiles = Promise.resolve().then(() =>
    observeStage(
      "changes_files",
      args.dependencies.loadChangesAndFiles,
      args.observer,
    ),
  );
  throwIfAborted(args.signal);
  const outputsAndSources = Promise.resolve().then(() =>
    observeStage(
      "outputs_sources",
      args.dependencies.loadOutputsAndSources,
      args.observer,
    ),
  );
  const results = await Promise.allSettled([changesAndFiles, outputsAndSources]);
  throwIfAborted(args.signal);
  const resourceFailure = results[1];
  if (resourceFailure?.status === "rejected") {
    throw resourceFailure.reason;
  }
}

function primaryCacheState(
  sessionId: string,
  workspaceRoot: string,
): SessionViewCacheState {
  const snapshot = readCachedSessionInspectorPrimary(
    sessionId,
    workspaceRoot,
  );
  if (!snapshot) return "miss";
  return snapshot.complete ? "available" : "partial";
}

function resourceCacheState(sessionId: string): SessionViewCacheState {
  const snapshot = readCachedConversationResourceIndex(sessionId);
  if (!snapshot) return "miss";
  return snapshot.validated && snapshot.complete ? "available" : "partial";
}

export async function preloadSelectedSessionView(args: {
  sessionId: string;
  workspaceRoot: string;
  signal?: AbortSignal;
  ensureConversationLoaded: (sessionId: string) => Promise<unknown>;
}): Promise<void> {
  const trace = startSessionViewPerformanceTrace({
    sessionId: args.sessionId,
    workspaceRoot: args.workspaceRoot,
    cacheStates: {
      chat: "unknown",
      changes_files: primaryCacheState(args.sessionId, args.workspaceRoot),
      outputs_sources: resourceCacheState(args.sessionId),
    },
  });
  try {
    await runSessionViewPreloadStages({
      ...(args.signal ? { signal: args.signal } : {}),
      observer: trace,
      dependencies: {
        hydrateConversation: () => args.ensureConversationLoaded(args.sessionId),
        loadChangesAndFiles: () =>
          loadCachedSessionInspectorPrimary({
            sessionId: args.sessionId,
            workspaceRoot: args.workspaceRoot,
            ...(args.signal ? { signal: args.signal } : {}),
          }),
        loadOutputsAndSources: () =>
          loadCachedConversationResourceIndex({
            sessionId: args.sessionId,
            ...(args.signal ? { signal: args.signal } : {}),
            dependencies: {
              readIndex: readSessionConversationResourceIndex,
            },
          }),
      },
    });
    trace.finish();
  } catch (error) {
    trace.finish(
      args.signal?.aborted || isAbortError(error) ? "aborted" : "error",
      error,
    );
    throw error;
  }
}

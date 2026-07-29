import { readSessionConversationResourceIndex } from "./api";
import { loadCachedConversationResourceIndex } from "./inspector/conversation-resource-index";
import { loadCachedSessionInspectorPrimary } from "./inspector/session-inspector-primary-cache";

export type SessionViewPreloadStageDependencies = {
  hydrateConversation: () => Promise<unknown>;
  loadChangesAndFiles: () => Promise<unknown>;
  loadOutputsAndSources: () => Promise<unknown>;
};

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new DOMException("The operation was aborted.", "AbortError");
}

export async function runSessionViewPreloadStages(args: {
  signal?: AbortSignal;
  dependencies: SessionViewPreloadStageDependencies;
}): Promise<void> {
  try {
    await args.dependencies.hydrateConversation();
  } catch {
    throwIfAborted(args.signal);
  }
  throwIfAborted(args.signal);
  // Preserve launch priority without turning it into a completion barrier.
  // Git status can take seconds in a large worktree, while detached provider
  // resource indexing can take much longer. Once Chat is usable, start both
  // Inspector stages in order so either surface may become ready first.
  const changesAndFiles = Promise.resolve().then(() =>
    args.dependencies.loadChangesAndFiles(),
  );
  throwIfAborted(args.signal);
  const outputsAndSources = Promise.resolve().then(() =>
    args.dependencies.loadOutputsAndSources(),
  );
  const results = await Promise.allSettled([changesAndFiles, outputsAndSources]);
  throwIfAborted(args.signal);
  const resourceFailure = results[1];
  if (resourceFailure?.status === "rejected") {
    throw resourceFailure.reason;
  }
}

export async function preloadSelectedSessionView(args: {
  sessionId: string;
  workspaceRoot: string;
  signal?: AbortSignal;
  ensureConversationLoaded: (sessionId: string) => Promise<unknown>;
}): Promise<void> {
  await runSessionViewPreloadStages({
    ...(args.signal ? { signal: args.signal } : {}),
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
}

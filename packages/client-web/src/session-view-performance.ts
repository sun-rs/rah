export const SESSION_VIEW_PERFORMANCE_EVENT =
  "rah:session-view-performance";

export type SessionViewPreloadStage =
  | "chat"
  | "changes_files"
  | "outputs_sources";

export type SessionViewCacheState =
  | "available"
  | "partial"
  | "miss"
  | "unknown";

export type SessionViewStageStatus =
  | "pending"
  | "loading"
  | "ready"
  | "error"
  | "aborted";

export type SessionViewTraceStatus =
  | "loading"
  | "ready"
  | "partial"
  | "error"
  | "aborted";

export type SessionViewPerformanceStage = {
  status: SessionViewStageStatus;
  cacheState: SessionViewCacheState;
  startedAt?: number;
  settledAt?: number;
  durationMs?: number;
  errorName?: string;
};

export type SessionViewPerformanceTrace = {
  id: number;
  sessionId: string;
  workspaceRoot: string;
  status: SessionViewTraceStatus;
  startedAt: number;
  settledAt?: number;
  durationMs?: number;
  stages: Record<SessionViewPreloadStage, SessionViewPerformanceStage>;
};

export type SessionViewPerformanceTraceHandle = {
  stageStarted: (stage: SessionViewPreloadStage) => void;
  stageSettled: (
    stage: SessionViewPreloadStage,
    status: Extract<SessionViewStageStatus, "ready" | "error" | "aborted">,
    error?: unknown,
  ) => void;
  finish: (status?: SessionViewTraceStatus, error?: unknown) => void;
};

type SessionViewPerformanceListener = (
  traces: readonly SessionViewPerformanceTrace[],
) => void;

const TRACE_LIMIT = 40;
const traces: SessionViewPerformanceTrace[] = [];
const listeners = new Set<SessionViewPerformanceListener>();
let nextTraceId = 1;

function cloneStage(
  stage: SessionViewPerformanceStage,
): SessionViewPerformanceStage {
  return { ...stage };
}

function cloneTrace(
  trace: SessionViewPerformanceTrace,
): SessionViewPerformanceTrace {
  return {
    ...trace,
    stages: {
      chat: cloneStage(trace.stages.chat),
      changes_files: cloneStage(trace.stages.changes_files),
      outputs_sources: cloneStage(trace.stages.outputs_sources),
    },
  };
}

function readTraces(): SessionViewPerformanceTrace[] {
  return traces.map(cloneTrace);
}

function publish(): void {
  const snapshot = readTraces();
  for (const listener of listeners) {
    listener(snapshot);
  }
  if (
    typeof globalThis.dispatchEvent === "function" &&
    typeof globalThis.CustomEvent === "function"
  ) {
    globalThis.dispatchEvent(
      new CustomEvent(SESSION_VIEW_PERFORMANCE_EVENT, {
        detail: snapshot,
      }),
    );
  }
}

function errorName(error: unknown): string | undefined {
  if (error instanceof Error && error.name) {
    return error.name;
  }
  return error === undefined ? undefined : "UnknownError";
}

function derivedTraceStatus(
  trace: SessionViewPerformanceTrace,
): SessionViewTraceStatus {
  const stageStatuses = Object.values(trace.stages).map(
    (stage) => stage.status,
  );
  if (stageStatuses.includes("aborted")) return "aborted";
  if (stageStatuses.includes("error")) return "partial";
  return stageStatuses.every((status) => status === "ready")
    ? "ready"
    : "partial";
}

export function startSessionViewPerformanceTrace(args: {
  sessionId: string;
  workspaceRoot: string;
  cacheStates?: Partial<
    Record<SessionViewPreloadStage, SessionViewCacheState>
  >;
  now?: () => number;
}): SessionViewPerformanceTraceHandle {
  const now = args.now ?? Date.now;
  const trace: SessionViewPerformanceTrace = {
    id: nextTraceId,
    sessionId: args.sessionId,
    workspaceRoot: args.workspaceRoot,
    status: "loading",
    startedAt: now(),
    stages: {
      chat: {
        status: "pending",
        cacheState: args.cacheStates?.chat ?? "unknown",
      },
      changes_files: {
        status: "pending",
        cacheState: args.cacheStates?.changes_files ?? "unknown",
      },
      outputs_sources: {
        status: "pending",
        cacheState: args.cacheStates?.outputs_sources ?? "unknown",
      },
    },
  };
  nextTraceId += 1;
  traces.push(trace);
  while (traces.length > TRACE_LIMIT) {
    traces.shift();
  }
  publish();

  return {
    stageStarted: (stage) => {
      if (trace.status !== "loading") return;
      const current = trace.stages[stage];
      if (current.status !== "pending") return;
      current.status = "loading";
      current.startedAt = now();
      publish();
    },
    stageSettled: (stage, status, error) => {
      if (trace.status !== "loading") return;
      const current = trace.stages[stage];
      if (current.status !== "loading" && current.status !== "pending") return;
      const settledAt = now();
      current.status = status;
      current.startedAt ??= settledAt;
      current.settledAt = settledAt;
      current.durationMs = Math.max(0, settledAt - current.startedAt);
      const name = errorName(error);
      if (name) {
        current.errorName = name;
      }
      publish();
    },
    finish: (status, error) => {
      if (trace.status !== "loading") return;
      const settledAt = now();
      trace.status = status ?? derivedTraceStatus(trace);
      trace.settledAt = settledAt;
      trace.durationMs = Math.max(0, settledAt - trace.startedAt);
      if (error !== undefined && trace.status === "error") {
        const pendingStage = Object.values(trace.stages).find(
          (stage) => stage.status === "loading" || stage.status === "pending",
        );
        const name = errorName(error);
        if (pendingStage && name) {
          pendingStage.errorName = name;
        }
      }
      publish();
    },
  };
}

export function readSessionViewPerformanceTraces(): readonly SessionViewPerformanceTrace[] {
  return readTraces();
}

export function subscribeSessionViewPerformance(
  listener: SessionViewPerformanceListener,
): () => void {
  listeners.add(listener);
  listener(readTraces());
  return () => {
    listeners.delete(listener);
  };
}

export function resetSessionViewPerformanceForTests(): void {
  traces.length = 0;
  listeners.clear();
  nextTraceId = 1;
}

import type { ConversationEvidencePage } from "@rah/runtime-protocol";
import type { ClaudeStoredSessionRecord } from "./claude-session-files";
import type {
  ClaudeHistoryPageWorkerRequest,
  ClaudeHistoryPageWorkerResponse,
} from "./claude-history-page-worker";
import {
  runBackgroundIpcTask,
  terminateBackgroundIpcProcess,
  type BackgroundIpcChild,
} from "./background-ipc-task";
import { BoundedTaskScheduler } from "./bounded-task-scheduler";
import {
  HISTORY_WORKLOAD_PRIORITY,
  sharedHistoryWorkloadScheduler,
} from "./history-workload-governor";

const CLAUDE_HISTORY_RESPONSE_BYTES = 8 * 1024 * 1024;

export class ClaudeHistoryPageStore {
  private readonly workers = new Set<BackgroundIpcChild>();
  private readonly abortControllers = new Set<AbortController>();
  private readonly inFlight = new Map<string, Promise<ConversationEvidencePage>>();
  private closed = false;

  constructor(
    private readonly scheduler: BoundedTaskScheduler = sharedHistoryWorkloadScheduler,
  ) {}

  getSummaryPage(args: {
    sessionId: string;
    record: ClaudeStoredSessionRecord;
    cursor?: string;
    limit: number;
  }): Promise<ConversationEvidencePage> {
    if (this.closed) {
      return Promise.reject(new Error("Claude history page store is closed."));
    }
    const key = JSON.stringify([
      args.sessionId,
      args.record.filePath,
      args.cursor ?? null,
      args.limit,
    ]);
    const pending = this.inFlight.get(key);
    if (pending) {
      return pending;
    }
    const controller = new AbortController();
    this.abortControllers.add(controller);
    const request: ClaudeHistoryPageWorkerRequest = {
      kind: "claude-history-summary-page",
      sessionId: args.sessionId,
      record: args.record,
      ...(args.cursor ? { cursor: args.cursor } : {}),
      limit: args.limit,
    };
    const promise = this.scheduler
      .schedule(
        (signal) => this.runWorker(request, signal),
        {
          signal: controller.signal,
          priority: HISTORY_WORKLOAD_PRIORITY.interactive,
        },
      )
      .finally(() => {
        this.abortControllers.delete(controller);
        if (this.inFlight.get(key) === promise) {
          this.inFlight.delete(key);
        }
      });
    this.inFlight.set(key, promise);
    return promise;
  }

  async shutdown(): Promise<void> {
    this.closed = true;
    for (const controller of this.abortControllers) {
      controller.abort(
        new DOMException("Claude history page store closed", "AbortError"),
      );
    }
    this.abortControllers.clear();
    const workers = [...this.workers];
    this.workers.clear();
    await Promise.all(workers.map(terminateBackgroundIpcProcess));
  }

  private runWorker(
    request: ClaudeHistoryPageWorkerRequest,
    signal: AbortSignal,
  ): Promise<ConversationEvidencePage> {
    return runBackgroundIpcTask<
      ClaudeHistoryPageWorkerRequest,
      ClaudeHistoryPageWorkerResponse
    >({
      script: new URL("./claude-history-page-worker.ts", import.meta.url),
      request,
      label: "Claude history page worker",
      signal,
      timeoutMs: 30_000,
      maxResponseBytes: CLAUDE_HISTORY_RESPONSE_BYTES,
      onSpawn: (worker) => {
        this.workers.add(worker);
      },
      onClose: (worker) => {
        this.workers.delete(worker);
      },
    }).then((response) => {
      if (response.ok) {
        return response.page;
      }
      throw new Error(response.error);
    });
  }
}

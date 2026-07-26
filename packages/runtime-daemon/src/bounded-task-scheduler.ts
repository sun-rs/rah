export class TaskSchedulerClosedError extends Error {
  constructor(message = "Task scheduler is closed.") {
    super(message);
    this.name = "TaskSchedulerClosedError";
  }
}

export class TaskSchedulerOverloadedError extends Error {
  constructor(message = "Task scheduler queue is full.") {
    super(message);
    this.name = "TaskSchedulerOverloadedError";
  }
}

type QueuedTask<T> = {
  run: (signal: AbortSignal) => Promise<T>;
  signal?: AbortSignal | undefined;
  priority: number;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
  abortListener?: (() => void) | undefined;
};

export type BoundedTaskSchedulerOptions = {
  maxConcurrency: number;
  maxQueued: number;
};

/**
 * A process-wide admission controller for CPU-heavy background work.
 *
 * Callers keep ownership of the work itself; the scheduler only guarantees
 * that active and waiting work stay within fixed bounds. Abort signals remove
 * work before it starts and are forwarded to running work so shutdown does not
 * leave a hidden backlog behind.
 */
export class BoundedTaskScheduler {
  private readonly queue: QueuedTask<unknown>[] = [];
  private readonly maxConcurrency: number;
  private readonly maxQueued: number;
  private activeCount = 0;
  private closed = false;

  constructor(options: BoundedTaskSchedulerOptions) {
    this.maxConcurrency = Math.max(1, Math.floor(options.maxConcurrency));
    this.maxQueued = Math.max(0, Math.floor(options.maxQueued));
  }

  schedule<T>(
    run: (signal: AbortSignal) => Promise<T>,
    options: {
      signal?: AbortSignal | undefined;
      priority?: number | undefined;
    } = {},
  ): Promise<T> {
    if (this.closed) {
      return Promise.reject(new TaskSchedulerClosedError());
    }
    if (options.signal?.aborted) {
      return Promise.reject(options.signal.reason ?? new DOMException("Aborted", "AbortError"));
    }
    const priority = Number.isFinite(options.priority)
      ? Math.floor(options.priority!)
      : 0;
    if (this.activeCount >= this.maxConcurrency && this.queue.length >= this.maxQueued) {
      const lowestPriorityTask = this.queue.at(-1);
      if (!lowestPriorityTask || priority <= lowestPriorityTask.priority) {
        return Promise.reject(new TaskSchedulerOverloadedError());
      }
      this.queue.pop();
      this.removeAbortListener(lowestPriorityTask);
      lowestPriorityTask.reject(
        new TaskSchedulerOverloadedError(
          "Task scheduler evicted lower-priority queued work.",
        ),
      );
    }

    return new Promise<T>((resolve, reject) => {
      const task: QueuedTask<T> = {
        run,
        signal: options.signal,
        priority,
        resolve,
        reject,
      };
      if (options.signal) {
        task.abortListener = () => {
          const index = this.queue.indexOf(task as QueuedTask<unknown>);
          if (index < 0) {
            return;
          }
          this.queue.splice(index, 1);
          reject(options.signal?.reason ?? new DOMException("Aborted", "AbortError"));
        };
        options.signal.addEventListener("abort", task.abortListener, { once: true });
      }
      const insertAt = this.queue.findIndex(
        (queued) => queued.priority < priority,
      );
      if (insertAt < 0) {
        this.queue.push(task as QueuedTask<unknown>);
      } else {
        this.queue.splice(insertAt, 0, task as QueuedTask<unknown>);
      }
      this.pump();
    });
  }

  shutdown(reason: unknown = new TaskSchedulerClosedError()): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    for (const task of this.queue.splice(0)) {
      this.removeAbortListener(task);
      task.reject(reason);
    }
  }

  stats(): { active: number; queued: number; maxConcurrency: number; maxQueued: number } {
    return {
      active: this.activeCount,
      queued: this.queue.length,
      maxConcurrency: this.maxConcurrency,
      maxQueued: this.maxQueued,
    };
  }

  private pump(): void {
    while (!this.closed && this.activeCount < this.maxConcurrency) {
      const task = this.queue.shift();
      if (!task) {
        return;
      }
      this.removeAbortListener(task);
      if (task.signal?.aborted) {
        task.reject(task.signal.reason ?? new DOMException("Aborted", "AbortError"));
        continue;
      }
      this.activeCount += 1;
      const runningSignal = task.signal ?? new AbortController().signal;
      void task.run(runningSignal).then(task.resolve, task.reject).finally(() => {
        this.activeCount -= 1;
        this.pump();
      });
    }
  }

  private removeAbortListener(task: QueuedTask<unknown>): void {
    if (task.signal && task.abortListener) {
      task.signal.removeEventListener("abort", task.abortListener);
      delete task.abortListener;
    }
  }
}

import assert from "node:assert/strict";
import test from "node:test";
import {
  BoundedTaskScheduler,
  TaskSchedulerOverloadedError,
} from "./bounded-task-scheduler";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

test("bounded scheduler never exceeds its global concurrency", async () => {
  const scheduler = new BoundedTaskScheduler({ maxConcurrency: 2, maxQueued: 8 });
  const gates = Array.from({ length: 5 }, () => deferred<void>());
  let active = 0;
  let peak = 0;
  const tasks = gates.map((gate) =>
    scheduler.schedule(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await gate.promise;
      active -= 1;
    }),
  );

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(scheduler.stats(), {
    active: 2,
    queued: 3,
    maxConcurrency: 2,
    maxQueued: 8,
  });
  for (const gate of gates) {
    gate.resolve();
    await new Promise((resolve) => setImmediate(resolve));
  }
  await Promise.all(tasks);
  assert.equal(peak, 2);
});

test("bounded scheduler rejects overflow instead of growing memory", async () => {
  const scheduler = new BoundedTaskScheduler({ maxConcurrency: 1, maxQueued: 1 });
  const gate = deferred<void>();
  const first = scheduler.schedule(() => gate.promise);
  const second = scheduler.schedule(async () => undefined);
  await assert.rejects(
    scheduler.schedule(async () => undefined),
    TaskSchedulerOverloadedError,
  );
  gate.resolve();
  await Promise.all([first, second]);
});

test("aborting queued work removes it before execution", async () => {
  const scheduler = new BoundedTaskScheduler({ maxConcurrency: 1, maxQueued: 2 });
  const gate = deferred<void>();
  const first = scheduler.schedule(() => gate.promise);
  const abortController = new AbortController();
  let ran = false;
  const queued = scheduler.schedule(
    async () => {
      ran = true;
    },
    { signal: abortController.signal },
  );
  abortController.abort();
  await assert.rejects(queued, { name: "AbortError" });
  assert.equal(scheduler.stats().queued, 0);
  gate.resolve();
  await first;
  assert.equal(ran, false);
});

test("higher-priority queued work runs first without disturbing active work", async () => {
  const scheduler = new BoundedTaskScheduler({ maxConcurrency: 1, maxQueued: 3 });
  const gate = deferred<void>();
  const order: string[] = [];
  const active = scheduler.schedule(async () => {
    order.push("active");
    await gate.promise;
  });
  const low = scheduler.schedule(
    async () => {
      order.push("low");
    },
    { priority: -10 },
  );
  const high = scheduler.schedule(
    async () => {
      order.push("high");
    },
    { priority: 10 },
  );

  gate.resolve();
  await Promise.all([active, low, high]);
  assert.deepEqual(order, ["active", "high", "low"]);
});

test("higher-priority work evicts a lower-priority backlog when the queue is full", async () => {
  const scheduler = new BoundedTaskScheduler({ maxConcurrency: 1, maxQueued: 1 });
  const gate = deferred<void>();
  const order: string[] = [];
  const active = scheduler.schedule(() => gate.promise);
  const low = scheduler.schedule(
    async () => {
      order.push("low");
    },
    { priority: -10 },
  );
  const high = scheduler.schedule(
    async () => {
      order.push("high");
    },
    { priority: 10 },
  );

  await assert.rejects(low, TaskSchedulerOverloadedError);
  gate.resolve();
  await Promise.all([active, high]);
  assert.deepEqual(order, ["high"]);
});

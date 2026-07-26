import assert from "node:assert/strict";
import test from "node:test";
import { resolveHistoryWorkloadLimits } from "./history-workload-governor";

test("history workload defaults preserve one global heavy-work lane", () => {
  assert.deepEqual(resolveHistoryWorkloadLimits({}), {
    maxConcurrency: 1,
    maxQueued: 64,
  });
});

test("history workload environment overrides are hard-clamped", () => {
  assert.deepEqual(
    resolveHistoryWorkloadLimits({
      RAH_HISTORY_WORKERS: "9999",
      RAH_HISTORY_QUEUE: "9999",
    }),
    {
      maxConcurrency: 2,
      maxQueued: 128,
    },
  );
});

test("history workload invalid overrides cannot disable admission control", () => {
  assert.deepEqual(
    resolveHistoryWorkloadLimits({
      RAH_HISTORY_WORKERS: "0",
      RAH_HISTORY_QUEUE: "-1",
    }),
    {
      maxConcurrency: 1,
      maxQueued: 64,
    },
  );
});

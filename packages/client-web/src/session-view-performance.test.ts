import assert from "node:assert/strict";
import test from "node:test";
import {
  readSessionViewPerformanceTraces,
  resetSessionViewPerformanceForTests,
  startSessionViewPerformanceTrace,
} from "./session-view-performance";

test.afterEach(() => {
  resetSessionViewPerformanceForTests();
});

test("records bounded stage timings and cache state without conversation content", () => {
  let now = 100;
  const trace = startSessionViewPerformanceTrace({
    sessionId: "session-a",
    workspaceRoot: "/workspace/a",
    cacheStates: {
      chat: "unknown",
      changes_files: "available",
      outputs_sources: "miss",
    },
    now: () => now,
  });

  now = 110;
  trace.stageStarted("chat");
  now = 135;
  trace.stageSettled("chat", "ready");
  now = 140;
  trace.stageStarted("changes_files");
  now = 145;
  trace.stageSettled("changes_files", "ready");
  trace.stageStarted("outputs_sources");
  now = 170;
  trace.stageSettled("outputs_sources", "ready");
  now = 175;
  trace.finish();

  const [snapshot] = readSessionViewPerformanceTraces();
  assert.equal(snapshot?.status, "ready");
  assert.equal(snapshot?.durationMs, 75);
  assert.equal(snapshot?.stages.chat.durationMs, 25);
  assert.equal(snapshot?.stages.changes_files.cacheState, "available");
  assert.equal(snapshot?.stages.outputs_sources.cacheState, "miss");
  assert.deepEqual(Object.keys(snapshot ?? {}).sort(), [
    "durationMs",
    "id",
    "sessionId",
    "settledAt",
    "stages",
    "startedAt",
    "status",
    "workspaceRoot",
  ]);
});

test("keeps aborted and replacement selection traces independent", () => {
  const first = startSessionViewPerformanceTrace({
    sessionId: "session-a",
    workspaceRoot: "/workspace/a",
  });
  first.stageStarted("chat");

  const replacement = startSessionViewPerformanceTrace({
    sessionId: "session-b",
    workspaceRoot: "/workspace/b",
  });
  replacement.stageStarted("chat");
  replacement.stageSettled("chat", "ready");
  replacement.stageStarted("changes_files");
  replacement.stageSettled("changes_files", "ready");
  replacement.stageStarted("outputs_sources");
  replacement.stageSettled("outputs_sources", "ready");
  replacement.finish();

  first.stageSettled("chat", "aborted", new DOMException("aborted", "AbortError"));
  first.finish("aborted");

  const snapshots = readSessionViewPerformanceTraces();
  assert.deepEqual(
    snapshots.map((snapshot) => [snapshot.sessionId, snapshot.status]),
    [
      ["session-a", "aborted"],
      ["session-b", "ready"],
    ],
  );
});

test("retains only the newest bounded diagnostic traces", () => {
  for (let index = 0; index < 45; index += 1) {
    const trace = startSessionViewPerformanceTrace({
      sessionId: `session-${index}`,
      workspaceRoot: "/workspace",
    });
    trace.finish("partial");
  }

  const snapshots = readSessionViewPerformanceTraces();
  assert.equal(snapshots.length, 40);
  assert.equal(snapshots[0]?.sessionId, "session-5");
  assert.equal(snapshots.at(-1)?.sessionId, "session-44");
});

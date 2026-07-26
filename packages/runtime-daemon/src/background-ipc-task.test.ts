import assert from "node:assert/strict";
import test from "node:test";
import {
  runBackgroundIpcTask,
  type BackgroundIpcChild,
} from "./background-ipc-task";

type Response =
  | { ok: true; value: string }
  | { ok: false; error: string };

test("background IPC tasks return one bounded response from an isolated process", async () => {
  let child: BackgroundIpcChild | undefined;
  const response = await runBackgroundIpcTask<
    { kind: "echo"; value: string },
    Response
  >({
    script: new URL("./background-ipc-task-test-worker.ts", import.meta.url),
    request: { kind: "echo", value: "ready" },
    label: "Background IPC echo test",
    onSpawn: (spawned) => {
      child = spawned;
    },
  });

  assert.deepEqual(response, { ok: true, value: "ready" });
  assert.ok(child?.pid);
});

test("background IPC workers fail closed when a response exceeds its byte budget", async () => {
  const response = await runBackgroundIpcTask<
    { kind: "large"; bytes: number },
    Response
  >({
    script: new URL("./background-ipc-task-test-worker.ts", import.meta.url),
    request: { kind: "large", bytes: 8 * 1024 },
    label: "Background IPC response budget test",
    maxResponseBytes: 1024,
  });

  assert.equal(response.ok, false);
  assert.match(response.ok ? "" : response.error, /IPC message limit/);
});

test("aborting background IPC work terminates the isolated process", async () => {
  const controller = new AbortController();
  let child: BackgroundIpcChild | undefined;
  const pending = runBackgroundIpcTask<
    { kind: "delay"; milliseconds: number },
    Response
  >({
    script: new URL("./background-ipc-task-test-worker.ts", import.meta.url),
    request: { kind: "delay", milliseconds: 10_000 },
    label: "Background IPC abort test",
    signal: controller.signal,
    onSpawn: (spawned) => {
      child = spawned;
    },
  });
  controller.abort(new DOMException("test abort", "AbortError"));

  await assert.rejects(pending, { name: "AbortError" });
  assert.ok(child);
  await new Promise<void>((resolve) => {
    if (child!.exitCode !== null || child!.signalCode !== null) {
      resolve();
      return;
    }
    child!.once("exit", () => resolve());
  });
});

test("background IPC tasks have a hard execution deadline", async () => {
  const startedAt = Date.now();
  await assert.rejects(
    runBackgroundIpcTask<
      { kind: "delay"; milliseconds: number },
      Response
    >({
      script: new URL("./background-ipc-task-test-worker.ts", import.meta.url),
      request: { kind: "delay", milliseconds: 10_000 },
      label: "Background IPC timeout test",
      timeoutMs: 100,
    }),
    /timed out/,
  );
  assert.ok(Date.now() - startedAt < 5_000);
});

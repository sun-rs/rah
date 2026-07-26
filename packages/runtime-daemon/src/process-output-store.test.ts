import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ProcessOutputSnapshot } from "@rah/runtime-protocol";
import { ProcessOutputStore } from "./process-output-store";

describe("ProcessOutputStore", () => {
  test("coalesces noisy append bursts before starting filesystem I/O", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "rah-process-output-"));
    try {
      const store = new ProcessOutputStore({
        rootDir,
        flushIntervalMs: 60_000,
        flushBatchBytes: 1024 * 1024,
      });
      for (let index = 0; index < 1_000; index += 1) {
        store.append({
          sessionId: "session-burst",
          turnId: "turn-burst",
          output: {
            itemId: "call-burst",
            stream: "stdout",
            sequence: index + 1,
            offsetBytes: index,
            data: "x",
            totalBytes: index + 1,
          },
        });
      }

      // Ingress only mutates bounded memory. The delayed batch owns disk I/O.
      assert.deepEqual(await readdir(rootDir), []);

      store.complete({
        sessionId: "session-burst",
        turnId: "turn-burst",
        output: {
          itemId: "call-burst",
          stream: "stdout",
          totalBytes: 1_000,
          retainedBytes: 1_000,
          truncatedBeforeBytes: 0,
          tail: "x".repeat(1_000),
        },
      });
      await store.flush();

      assert.equal(
        (await store.read("session-burst", "call-burst"))?.text,
        "x".repeat(1_000),
      );
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  test("persists append-only chunks and restores them through a manifest", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "rah-process-output-"));
    try {
      const store = new ProcessOutputStore({ rootDir });
      store.append({
        sessionId: "session-1",
        turnId: "turn-1",
        output: {
          itemId: "call-1",
          stream: "stdout",
          sequence: 1,
          offsetBytes: 0,
          data: "hello",
          totalBytes: 5,
        },
      });
      const snapshot: ProcessOutputSnapshot = {
        itemId: "call-1",
        stream: "stdout" as const,
        totalBytes: 5,
        retainedBytes: 5,
        truncatedBeforeBytes: 0,
        tail: "hello",
      };
      store.complete({
        sessionId: "session-1",
        turnId: "turn-1",
        output: snapshot,
      });
      await store.flush();

      assert.equal(snapshot.detailAvailable, true);
      const restored = await new ProcessOutputStore({ rootDir }).read(
        "session-1",
        "call-1",
      );
      assert.equal(restored?.text, "hello");
      assert.equal(restored?.output.totalBytes, 5);
      assert.equal(restored?.output.detailAvailable, true);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  test("downgrades detail availability instead of growing an unbounded queue", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "rah-process-output-"));
    try {
      const store = new ProcessOutputStore({
        rootDir,
        maxPendingBytesPerItem: 4,
        maxPendingBytes: 4,
      });
      store.append({
        sessionId: "session-2",
        output: {
          itemId: "call-2",
          stream: "combined",
          sequence: 1,
          offsetBytes: 0,
          data: "larger-than-the-queue",
          totalBytes: 21,
        },
      });
      const snapshot: ProcessOutputSnapshot = {
        itemId: "call-2",
        stream: "combined" as const,
        totalBytes: 21,
        retainedBytes: 21,
        truncatedBeforeBytes: 0,
        tail: "larger-than-the-queue",
      };
      store.complete({ sessionId: "session-2", output: snapshot });
      await store.flush();

      assert.equal(snapshot.detailAvailable, false);
      assert.equal(await store.read("session-2", "call-2"), undefined);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  test("expires completed output even while its index is still resident", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "rah-process-output-"));
    let now = 1_000;
    try {
      const store = new ProcessOutputStore({
        rootDir,
        maxAgeMs: 100,
        now: () => now,
      });
      store.append({
        sessionId: "session-expiring",
        output: {
          itemId: "call-expiring",
          stream: "stdout",
          sequence: 1,
          offsetBytes: 0,
          data: "old output",
          totalBytes: 10,
        },
      });
      store.complete({
        sessionId: "session-expiring",
        output: {
          itemId: "call-expiring",
          stream: "stdout",
          totalBytes: 10,
          retainedBytes: 10,
          truncatedBeforeBytes: 0,
          tail: "old output",
        },
      });
      await store.flush();
      assert.equal(
        (await store.read("session-expiring", "call-expiring"))?.text,
        "old output",
      );

      now += 101;
      await store.runMaintenance();

      assert.equal(
        await store.read("session-expiring", "call-expiring"),
        undefined,
      );
      assert.equal(
        await new ProcessOutputStore({ rootDir }).read(
          "session-expiring",
          "call-expiring",
        ),
        undefined,
      );
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  test("enforces a total disk budget for completed process detail", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "rah-process-output-"));
    try {
      const store = new ProcessOutputStore({
        rootDir,
        maxTotalBytes: 1,
      });
      store.append({
        sessionId: "session-budget",
        output: {
          itemId: "call-budget",
          stream: "combined",
          sequence: 1,
          offsetBytes: 0,
          data: "bounded",
          totalBytes: 7,
        },
      });
      store.complete({
        sessionId: "session-budget",
        output: {
          itemId: "call-budget",
          stream: "combined",
          totalBytes: 7,
          retainedBytes: 7,
          truncatedBeforeBytes: 0,
          tail: "bounded",
        },
      });
      await store.flush();
      await store.runMaintenance();

      assert.equal(await store.read("session-budget", "call-budget"), undefined);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });
});

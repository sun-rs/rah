import test from "node:test";
import assert from "node:assert/strict";
import type { PtySessionStats } from "@rah/runtime-protocol";
import {
  comparePtyRuntimeHealth,
  formatPtyBytes,
  formatSignedCount,
  formatSignedPtyBytes,
  sortPtyStatsForDisplay,
  summarizePtyRuntimeHealth,
} from "./settings-runtime-health";

function stat(overrides: Partial<PtySessionStats>): PtySessionStats {
  return {
    sessionId: "pty-a",
    replayChunks: 0,
    replayBytes: 0,
    maxReplayChunks: 2000,
    maxReplayBytes: 8 * 1024 * 1024,
    nextSeq: 1,
    subscriberCount: 0,
    status: "open",
    ...overrides,
  };
}

test("formats PTY replay bytes for compact settings display", () => {
  assert.equal(formatPtyBytes(0), "0 B");
  assert.equal(formatPtyBytes(512), "512 B");
  assert.equal(formatPtyBytes(1536), "1.5 KB");
  assert.equal(formatPtyBytes(2 * 1024 * 1024), "2 MB");
  assert.equal(formatSignedPtyBytes(1536), "+1.5 KB");
  assert.equal(formatSignedPtyBytes(-1024), "-1 KB");
  assert.equal(formatSignedCount(2), "+2");
  assert.equal(formatSignedCount(-1), "-1");
});

test("summarizes PTY runtime health and marks trimmed replay windows", () => {
  const summary = summarizePtyRuntimeHealth([
    stat({
      sessionId: "pty-open",
      replayChunks: 3,
      replayBytes: 1024,
      subscriberCount: 2,
    }),
    stat({
      sessionId: "pty-exited",
      status: "exited",
      replayChunks: 5,
      replayBytes: 4096,
      maxReplayBytes: 4 * 1024,
      subscriberCount: 0,
      droppedBeforeSeq: 12,
    }),
  ]);

  assert.equal(summary.totalSessions, 2);
  assert.equal(summary.openSessions, 1);
  assert.equal(summary.exitedSessions, 1);
  assert.equal(summary.replayBytes, 5120);
  assert.equal(summary.replayChunks, 8);
  assert.equal(summary.subscriberCount, 2);
  assert.equal(summary.trimmedSessions, 1);
  assert.equal(summary.largestReplayBytes, 4096);
  assert.equal(summary.status, "trimmed");
});

test("sorts open PTY sessions first, then by replay size", () => {
  const sorted = sortPtyStatsForDisplay([
    stat({ sessionId: "exited-large", status: "exited", replayBytes: 9000 }),
    stat({ sessionId: "open-small", status: "open", replayBytes: 100 }),
    stat({ sessionId: "open-large", status: "open", replayBytes: 8000 }),
  ]);

  assert.deepEqual(
    sorted.map((item) => item.sessionId),
    ["open-large", "open-small", "exited-large"],
  );
});

test("compares PTY runtime health between refreshes", () => {
  const previous = [
    stat({ sessionId: "pty-a", replayBytes: 1024, replayChunks: 2, subscriberCount: 1 }),
  ];
  const current = [
    stat({ sessionId: "pty-a", replayBytes: 2048, replayChunks: 4, subscriberCount: 2 }),
    stat({ sessionId: "pty-b", replayBytes: 512, replayChunks: 1, subscriberCount: 0 }),
  ];

  assert.deepEqual(comparePtyRuntimeHealth(previous, current), {
    openSessionsDelta: 1,
    replayBytesDelta: 1536,
    replayChunksDelta: 3,
    subscriberCountDelta: 1,
    trimmedSessionsDelta: 0,
  });
  assert.equal(comparePtyRuntimeHealth(null, current), null);
});

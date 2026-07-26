import assert from "node:assert/strict";
import test from "node:test";
import type { RahEvent } from "@rah/runtime-protocol";
import {
  clearPendingEvents,
  queuePendingEvent,
  takePendingEventsForSessions,
} from "./session-store-pending-events";

function event(seq: number, sessionId = "session-1"): RahEvent {
  return {
    id: `event-${seq}`,
    seq,
    ts: "2026-07-25T00:00:00.000Z",
    sessionId,
    source: {
      provider: "codex",
      channel: "structured_live",
      authority: "derived",
    },
    type: "session.updated",
    payload: { patch: { updatedAt: `revision-${seq}` } },
  } as RahEvent;
}

function outputEvent(seq: number, data: string): RahEvent {
  return {
    id: `output-${seq}`,
    seq,
    ts: "2026-07-25T00:00:00.000Z",
    sessionId: "session-output",
    source: {
      provider: "codex",
      channel: "structured_live",
      authority: "derived",
    },
    type: "process.output.appended",
    payload: {
      output: {
        itemId: "process-1",
        stream: "stdout",
        data,
        offsetBytes: seq,
        totalBytes: seq + data.length,
      },
    },
  } as RahEvent;
}

test("pending session events retain only the bounded newest suffix", () => {
  clearPendingEvents();
  for (let seq = 1; seq <= 260; seq += 1) {
    queuePendingEvent(event(seq));
  }
  const replay = takePendingEventsForSessions(new Set(["session-1"]));
  assert.equal(replay.length, 200);
  assert.equal(replay[0]?.seq, 61);
  assert.equal(replay.at(-1)?.seq, 260);
  assert.deepEqual(takePendingEventsForSessions(new Set(["session-1"])), []);
});

test("pending process output is bounded by encoded bytes without retaining empty queues", () => {
  clearPendingEvents();
  for (let seq = 1; seq <= 8; seq += 1) {
    queuePendingEvent(outputEvent(seq, "x".repeat(128 * 1024)));
  }
  const replay = takePendingEventsForSessions(new Set(["session-output"]));
  assert.ok(replay.length > 0);
  assert.ok(replay.length <= 3);

  queuePendingEvent(outputEvent(9, "x".repeat(600 * 1024)));
  assert.deepEqual(
    takePendingEventsForSessions(new Set(["session-output"])),
    [],
  );
});

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type {
  ConversationProjectionDelta,
  RahEvent,
} from "@rah/runtime-protocol";
import { chunkEventReplay } from "./http-server-websocket";

function event(seq: number, body = "event"): RahEvent {
  return {
    id: `event-${seq}`,
    seq,
    ts: "2026-07-25T00:00:00.000Z",
    sessionId: "session-1",
    turnId: "turn-1",
    type: "notification.emitted",
    source: {
      provider: "system",
      channel: "system",
      authority: "authoritative",
    },
    payload: {
      level: "info",
      title: `event-${seq}`,
      body,
    },
  };
}

function delta(seq: number): ConversationProjectionDelta {
  return {
    sessionId: "session-1",
    baseRevision: seq - 1,
    revision: seq,
    sourceSeq: seq,
    upsertTurns: [],
  };
}

describe("event websocket replay budgeting", () => {
  test("chunks retained replay by count and composes contiguous deltas per frame", () => {
    const events = [event(1), event(2), event(3), event(4), event(5)];
    const chunks = chunkEventReplay(
      events,
      (sourceSeq) => delta(sourceSeq),
      { maxEvents: 2, maxBytes: 1_000_000 },
    );

    assert.deepEqual(chunks.map((chunk) => chunk.events.map((value) => value.seq)), [
      [1, 2],
      [3, 4],
      [5],
    ]);
    assert.deepEqual(
      chunks.map((chunk) =>
        chunk.conversationDeltas.map((value) => [
          value.baseRevision,
          value.revision,
          value.sourceSeq,
        ]),
      ),
      [
        [[0, 2, 2]],
        [[2, 4, 4]],
        [[4, 5, 5]],
      ],
    );
  });

  test("starts a new replay frame before the byte budget is exceeded", () => {
    const chunks = chunkEventReplay(
      [event(1, "x".repeat(600)), event(2, "x".repeat(600))],
      () => undefined,
      { maxEvents: 100, maxBytes: 1_000 },
    );

    assert.equal(chunks.length, 2);
    assert.deepEqual(chunks.map((chunk) => chunk.events.length), [1, 1]);
  });
});

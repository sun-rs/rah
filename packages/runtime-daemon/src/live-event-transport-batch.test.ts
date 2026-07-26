import assert from "node:assert/strict";
import test from "node:test";
import type { RahEvent } from "@rah/runtime-protocol";
import { LiveEventTransportBatch } from "./live-event-transport-batch";

function outputEvent(
  seq: number,
  data: string,
): Extract<RahEvent, { type: "process.output.appended" }> {
  return {
    id: `output-${seq}`,
    seq,
    ts: "2026-07-26T00:00:00.000Z",
    sessionId: "session-1",
    turnId: "turn-1",
    type: "process.output.appended",
    source: {
      provider: "codex",
      channel: "structured_live",
      authority: "authoritative",
    },
    payload: {
      output: {
        itemId: "command-1",
        stream: "stdout",
        sequence: seq,
        offsetBytes: seq - 1,
        data,
        totalBytes: seq,
      },
    },
  };
}

function semanticEvent(seq: number): RahEvent {
  return {
    id: `semantic-${seq}`,
    seq,
    ts: "2026-07-26T00:00:00.000Z",
    sessionId: "session-1",
    turnId: "turn-1",
    type: "turn.completed",
    source: {
      provider: "codex",
      channel: "structured_live",
      authority: "authoritative",
    },
    payload: {},
  };
}

test("coalesces a noisy output region without repeated string materialization", () => {
  const batch = new LiveEventTransportBatch({
    maxCoalescedOutputChars: 20_000,
  });
  for (let index = 1; index <= 10_000; index += 1) {
    batch.append(outputEvent(index, "x"));
  }

  assert.equal(batch.eventCount, 1);
  assert.equal(batch.hasUrgentEvents, false);
  const frame = batch.take();
  assert.equal(frame.events.length, 1);
  const output = frame.events[0];
  assert.equal(output?.type, "process.output.appended");
  if (output?.type === "process.output.appended") {
    assert.equal(output.payload.output.data.length, 10_000);
    assert.equal(output.payload.output.totalBytes, 10_000);
    assert.equal(output.payload.output.offsetBytes, 0);
  }
});

test("never coalesces output across a semantic lifecycle boundary", () => {
  const batch = new LiveEventTransportBatch();
  batch.append(outputEvent(1, "a"));
  batch.append(semanticEvent(2));
  batch.append(outputEvent(3, "b"));

  assert.equal(batch.eventCount, 3);
  assert.equal(batch.hasUrgentEvents, true);
  assert.deepEqual(
    batch.take().events.map((event) => event.type),
    [
      "process.output.appended",
      "turn.completed",
      "process.output.appended",
    ],
  );
});

test("retains only a bounded live output tail", () => {
  const batch = new LiveEventTransportBatch({
    maxCoalescedOutputChars: 4,
  });
  for (let index = 1; index <= 8; index += 1) {
    batch.append(outputEvent(index, String(index)));
  }

  const output = batch.take().events[0];
  assert.equal(output?.type, "process.output.appended");
  if (output?.type === "process.output.appended") {
    assert.equal(output.payload.output.data, "5678");
    assert.equal(output.payload.output.offsetBytes, 4);
  }
});

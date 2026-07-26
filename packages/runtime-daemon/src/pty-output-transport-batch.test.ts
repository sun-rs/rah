import assert from "node:assert/strict";
import test from "node:test";
import { PtyOutputTransportBatch } from "./pty-output-transport-batch";

test("materializes a noisy PTY output batch exactly once", () => {
  const batch = new PtyOutputTransportBatch();
  for (let seq = 1; seq <= 10_000; seq += 1) {
    batch.append({
      type: "pty.output",
      sessionId: "session-1",
      seq,
      data: "x",
    });
  }

  assert.equal(batch.charLength, 10_000);
  assert.equal(batch.empty, false);
  assert.deepEqual(batch.take(), {
    type: "pty.output",
    sessionId: "session-1",
    seq: 10_000,
    data: "x".repeat(10_000),
  });
  assert.equal(batch.charLength, 0);
  assert.equal(batch.empty, true);
  assert.equal(batch.take(), null);
});

test("clear discards pending PTY output without materializing it", () => {
  const batch = new PtyOutputTransportBatch();
  batch.append({
    type: "pty.output",
    sessionId: "session-1",
    data: "pending",
  });

  batch.clear();

  assert.equal(batch.empty, true);
  assert.equal(batch.take(), null);
});

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { BoundedProcessOutputAccumulator } from "./bounded-process-output";

describe("BoundedProcessOutputAccumulator", () => {
  test("uses monotonic byte offsets without rebuilding previous output", () => {
    const output = new BoundedProcessOutputAccumulator({
      itemId: "call-1",
      stream: "stdout",
      maxTailBytes: 32,
    });

    assert.deepEqual(output.append("hello"), {
      itemId: "call-1",
      stream: "stdout",
      sequence: 1,
      offsetBytes: 0,
      data: "hello",
      totalBytes: 5,
    });
    assert.deepEqual(output.append("世界"), {
      itemId: "call-1",
      stream: "stdout",
      sequence: 2,
      offsetBytes: 5,
      data: "世界",
      totalBytes: 11,
    });
    assert.deepEqual(output.snapshot(), {
      itemId: "call-1",
      stream: "stdout",
      totalBytes: 11,
      retainedBytes: 11,
      truncatedBeforeBytes: 0,
      tail: "hello世界",
    });
  });

  test("keeps a UTF-8 safe bounded tail for arbitrarily long streams", () => {
    const output = new BoundedProcessOutputAccumulator({
      itemId: "call-2",
      maxTailBytes: 1_024,
    });
    for (let index = 0; index < 100_000; index += 1) {
      output.append(index % 2 === 0 ? "x" : "界");
    }

    const snapshot = output.snapshot(true);
    assert.ok(snapshot.retainedBytes <= 1_024);
    assert.equal(
      snapshot.truncatedBeforeBytes + snapshot.retainedBytes,
      snapshot.totalBytes,
    );
    assert.equal(Buffer.byteLength(snapshot.tail, "utf8"), snapshot.retainedBytes);
    assert.equal(snapshot.detailAvailable, true);
    assert.ok(output.stats().retainedChunks <= 1_024);
  });

  test("does not create events for empty chunks", () => {
    const output = new BoundedProcessOutputAccumulator({ itemId: "call-3" });
    assert.equal(output.append(""), undefined);
    assert.equal(output.hasOutput(), false);
  });
});

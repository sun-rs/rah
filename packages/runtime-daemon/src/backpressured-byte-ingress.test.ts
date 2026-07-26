import assert from "node:assert/strict";
import test from "node:test";

import { BackpressuredByteIngress } from "./backpressured-byte-ingress";

test("time-slices byte consumption and preserves ordering", async () => {
  const consumed: string[] = [];
  const ingress = new BackpressuredByteIngress({
    consume: (chunk) => consumed.push(chunk.toString("utf8")),
    pauseSource: () => undefined,
    resumeSource: () => undefined,
    maxBytesPerSlice: 1,
    maxSliceMs: 100,
  });

  ingress.enqueue(Buffer.from("a"));
  ingress.enqueue(Buffer.from("b"));
  ingress.enqueue(Buffer.from("c"));
  assert.deepEqual(consumed, []);

  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(consumed, ["a"]);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(consumed, ["a", "b"]);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(consumed, ["a", "b", "c"]);
  assert.equal(ingress.isIdle(), true);
});

test("pauses above the high-water mark and resumes below the low-water mark", async () => {
  let pauses = 0;
  let resumes = 0;
  let idleNotifications = 0;
  const ingress = new BackpressuredByteIngress({
    consume: () => undefined,
    pauseSource: () => {
      pauses += 1;
    },
    resumeSource: () => {
      resumes += 1;
    },
    onIdle: () => {
      idleNotifications += 1;
    },
    highWaterBytes: 4,
    lowWaterBytes: 1,
    maxBytesPerSlice: 2,
    maxSliceMs: 100,
  });

  ingress.enqueue(Buffer.from("aa"));
  ingress.enqueue(Buffer.from("bb"));
  ingress.enqueue(Buffer.from("cc"));
  assert.equal(pauses, 1);
  assert.deepEqual(ingress.stats(), {
    queuedBytes: 6,
    queuedChunks: 3,
    sourcePaused: true,
    scheduled: true,
  });

  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(resumes, 0);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(resumes, 0);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(resumes, 1);
  assert.equal(idleNotifications, 1);
  assert.equal(ingress.isIdle(), true);
});

test("splits oversized source chunks without exceeding the slice byte budget", async () => {
  const consumedSizes: number[] = [];
  const ingress = new BackpressuredByteIngress({
    consume: (chunk) => consumedSizes.push(chunk.length),
    pauseSource: () => undefined,
    resumeSource: () => undefined,
    maxBytesPerSlice: 4,
    maxSliceMs: 100,
  });

  ingress.enqueue(Buffer.alloc(10));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(consumedSizes, [4]);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(consumedSizes, [4, 4]);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(consumedSizes, [4, 4, 2]);
});

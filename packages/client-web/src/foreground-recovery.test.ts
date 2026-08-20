import assert from "node:assert/strict";
import test from "node:test";
import {
  foregroundClockWasSuspended,
  foregroundSurfaceHasAttention,
  runForegroundRecoveryLoop,
} from "./foreground-recovery";

test("foreground wake detection distinguishes a suspended clock from ordinary timer drift", () => {
  assert.equal(foregroundClockWasSuspended(1_000, 5_999, 5_000), false);
  assert.equal(foregroundClockWasSuspended(1_000, 6_000, 5_000), true);
  assert.equal(foregroundClockWasSuspended(10_000, 9_000, 5_000), false);
});

test("standalone PWA visibility remains authoritative when iOS does not restore focus", () => {
  assert.equal(
    foregroundSurfaceHasAttention({
      visibilityState: "visible",
      documentHasFocus: false,
      pwaDisplayMode: true,
    }),
    true,
  );
  assert.equal(
    foregroundSurfaceHasAttention({
      visibilityState: "visible",
      documentHasFocus: false,
      pwaDisplayMode: false,
    }),
    false,
  );
  assert.equal(
    foregroundSurfaceHasAttention({
      visibilityState: "hidden",
      documentHasFocus: true,
      pwaDisplayMode: true,
    }),
    false,
  );
});

test("foreground recovery keeps retrying after the initial backoff sequence", async () => {
  const delays: number[] = [];
  let attempts = 0;
  const recovered = await runForegroundRecoveryLoop({
    signal: new AbortController().signal,
    retryDelaysMs: [10, 20, 30],
    isVisible: () => true,
    waitForDelay: async (delayMs) => {
      delays.push(delayMs);
      return true;
    },
    runAttempt: async () => {
      attempts += 1;
      return {
        transportRecovered: attempts >= 2,
        conversationRecovered: attempts >= 7,
      };
    },
  });

  assert.equal(recovered, true);
  assert.equal(attempts, 7);
  assert.deepEqual(delays, [10, 20, 30, 30, 30, 30]);
});

test("foreground recovery revalidates both transport and conversation on every retry", async () => {
  let attempts = 0;
  await runForegroundRecoveryLoop({
    signal: new AbortController().signal,
    retryDelaysMs: [0],
    isVisible: () => true,
    waitForDelay: async () => true,
    runAttempt: async () => {
      attempts += 1;
      return {
        transportRecovered: true,
        conversationRecovered: attempts >= 3,
      };
    },
  });

  assert.equal(attempts, 3);
});

test("foreground recovery keeps retrying without trusting browser online state", async () => {
  let attempts = 0;
  const recovered = await runForegroundRecoveryLoop({
    signal: new AbortController().signal,
    retryDelaysMs: [0],
    isVisible: () => true,
    waitForDelay: async () => true,
    runAttempt: async () => {
      attempts += 1;
      return {
        transportRecovered: attempts >= 4,
        conversationRecovered: attempts >= 4,
      };
    },
  });

  assert.equal(recovered, true);
  assert.equal(attempts, 4);
});

test("foreground recovery stops while waiting when the page is backgrounded", async () => {
  const controller = new AbortController();
  let attempts = 0;
  const recovered = await runForegroundRecoveryLoop({
    signal: controller.signal,
    retryDelaysMs: [10],
    isVisible: () => true,
    waitForDelay: async (_delayMs, signal) => {
      controller.abort();
      return !signal.aborted;
    },
    runAttempt: async () => {
      attempts += 1;
      return { transportRecovered: false, conversationRecovered: false };
    },
  });

  assert.equal(recovered, false);
  assert.equal(attempts, 1);
});

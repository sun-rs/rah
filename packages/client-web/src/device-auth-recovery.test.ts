import assert from "node:assert/strict";
import test from "node:test";
import {
  DEVICE_AUTH_TRUST_HINT_KEY,
  deviceAuthRetryDelay,
  deviceAuthStatusIsFresh,
  deviceAuthStateForFailure,
  deviceAuthStateForStatus,
  readDeviceAuthTrustHint,
  writeDeviceAuthTrustHint,
  type DeviceAuthTrustStorage,
} from "./device-auth-recovery";

test("only an explicit unauthenticated status opens device pairing", () => {
  assert.equal(deviceAuthStateForStatus(true), "trusted");
  assert.equal(deviceAuthStateForStatus(false), "pairing");
  assert.equal(deviceAuthStateForFailure(false), "reconnecting");
  assert.equal(deviceAuthStateForFailure(true), "trusted");
});

test("device auth retries quickly and caps its backoff", () => {
  assert.equal(deviceAuthRetryDelay(0), 750);
  assert.equal(deviceAuthRetryDelay(1), 1_500);
  assert.equal(deviceAuthRetryDelay(2), 3_000);
  assert.equal(deviceAuthRetryDelay(3), 5_000);
  assert.equal(deviceAuthRetryDelay(20), 5_000);
});

test("device auth foreground checks reuse a recent authoritative status", () => {
  assert.equal(deviceAuthStatusIsFresh(undefined, 10_000, 15_000), false);
  assert.equal(deviceAuthStatusIsFresh(10_000, 24_999, 15_000), true);
  assert.equal(deviceAuthStatusIsFresh(10_000, 25_000, 15_000), false);
  assert.equal(deviceAuthStatusIsFresh(10_000, 9_999, 15_000), false);
});

test("the origin trust hint survives a cold client restart without becoming a credential", () => {
  const values = new Map<string, string>();
  const storage: DeviceAuthTrustStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };

  assert.equal(readDeviceAuthTrustHint(storage), false);
  writeDeviceAuthTrustHint(storage, true);
  assert.equal(values.get(DEVICE_AUTH_TRUST_HINT_KEY), "1");
  assert.equal(readDeviceAuthTrustHint(storage), true);

  writeDeviceAuthTrustHint(storage, false);
  assert.equal(values.has(DEVICE_AUTH_TRUST_HINT_KEY), false);
  assert.equal(readDeviceAuthTrustHint(storage), false);
});

test("blocked browser storage never blocks authentication recovery", () => {
  const storage: DeviceAuthTrustStorage = {
    getItem: () => {
      throw new Error("blocked");
    },
    setItem: () => {
      throw new Error("blocked");
    },
    removeItem: () => {
      throw new Error("blocked");
    },
  };

  assert.equal(readDeviceAuthTrustHint(storage), false);
  assert.doesNotThrow(() => writeDeviceAuthTrustHint(storage, true));
  assert.doesNotThrow(() => writeDeviceAuthTrustHint(storage, false));
});

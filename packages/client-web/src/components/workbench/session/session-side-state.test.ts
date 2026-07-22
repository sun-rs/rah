import assert from "node:assert/strict";
import test from "node:test";
import {
  readRememberedSessionSideLayouts,
  readRememberedSessionSideSizing,
  readRememberedSessionSideSurface,
  rememberSessionSideLayouts,
  rememberSessionSideSizing,
  rememberSessionSideSurface,
} from "./session-side-state";

function createStorage() {
  const values = new Map<string, string>();
  return {
    getItem(key: string) {
      return values.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      values.set(key, value);
    },
  };
}

test("Side layout persistence accepts only known layouts", () => {
  const storage = createStorage();
  rememberSessionSideLayouts(storage, {
    parentA: "columns",
    parentB: "stack",
  });

  assert.deepEqual(readRememberedSessionSideLayouts(storage), {
    parentA: "columns",
    parentB: "stack",
  });

  storage.setItem(
    "rah.session-side-layouts.v1",
    JSON.stringify({ parentA: "columns", parentB: "overlay", empty: 1 }),
  );
  assert.deepEqual(readRememberedSessionSideLayouts(storage), {
    parentA: "columns",
  });
});

test("Side mobile surface selection is isolated by parent", () => {
  const storage = createStorage();
  rememberSessionSideSurface(storage, "parentA", "side-a");
  rememberSessionSideSurface(storage, "parentB", "side-b");

  assert.equal(readRememberedSessionSideSurface(storage, "parentA"), "side-a");
  assert.equal(readRememberedSessionSideSurface(storage, "parentB"), "side-b");
  assert.equal(readRememberedSessionSideSurface(storage, "unknown"), "main");
});

test("Side split sizing is isolated by parent and rejects malformed values", () => {
  const storage = createStorage();
  rememberSessionSideSizing(storage, "parentA", {
    mainShare: 0.58,
    sideShares: { "side-a": 0.35, "side-b": 0.65 },
  });

  assert.deepEqual(readRememberedSessionSideSizing(storage, "parentA"), {
    mainShare: 0.58,
    sideShares: { "side-a": 0.35, "side-b": 0.65 },
  });
  assert.equal(readRememberedSessionSideSizing(storage, "unknown"), null);

  storage.setItem(
    "rah.session-side-sizing.v1",
    JSON.stringify({
      parentA: { mainShare: 2, sideShares: { "side-a": 1 } },
      parentB: { mainShare: 0.6, sideShares: { good: 1, zero: 0, bad: "x" } },
    }),
  );
  assert.equal(readRememberedSessionSideSizing(storage, "parentA"), null);
  assert.deepEqual(readRememberedSessionSideSizing(storage, "parentB"), {
    mainShare: 0.6,
    sideShares: { good: 1 },
  });
});

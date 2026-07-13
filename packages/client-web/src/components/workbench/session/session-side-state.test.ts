import assert from "node:assert/strict";
import test from "node:test";
import {
  readRememberedSessionSideLayouts,
  readRememberedSessionSideSurface,
  rememberSessionSideLayouts,
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

import assert from "node:assert/strict";
import { test } from "node:test";
import { sessionStoreSocketCloseDecision } from "./session-store-transport";

test("stale socket close events cannot alter the active transport", () => {
  assert.equal(sessionStoreSocketCloseDecision(false, 1006), "ignore");
  assert.equal(sessionStoreSocketCloseDecision(false, 4001), "ignore");
});

test("only the active socket decides whether to reconnect", () => {
  assert.equal(sessionStoreSocketCloseDecision(true, 1006), "reconnect");
  assert.equal(sessionStoreSocketCloseDecision(true, 4001), "stop");
});

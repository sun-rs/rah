import assert from "node:assert/strict";
import test from "node:test";
import { shouldRequestPtyReplay } from "./terminal-pty-replay-policy";

test("initial replay can be disabled without disabling reconnect catch-up", () => {
  assert.equal(shouldRequestPtyReplay({ initialReplay: false }), false);
  assert.equal(shouldRequestPtyReplay({ initialReplay: true }), true);
  assert.equal(shouldRequestPtyReplay({ initialReplay: false, fromSeq: 42 }), true);
  assert.equal(shouldRequestPtyReplay({ initialReplay: true, fromSeq: 42 }), true);
});

import test from "node:test";
import assert from "node:assert/strict";
import { ptySocketCloseNotice } from "./terminal-socket-close";

test("shows PTY backpressure close reason to the terminal user", () => {
  assert.equal(
    ptySocketCloseNotice(1013, "PTY client is too slow"),
    "[pty disconnected] PTY client is too slow; reconnecting from replay.",
  );
});

test("does not show ordinary socket close notices", () => {
  assert.equal(ptySocketCloseNotice(1000, "normal"), null);
  assert.equal(ptySocketCloseNotice(1006, ""), null);
});

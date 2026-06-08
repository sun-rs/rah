import assert from "node:assert/strict";
import test from "node:test";
import { shouldUseCodexWebSocketTransport } from "./codex-app-server-client";

test("Codex app-server defaults to websocket transport so native TUI attach is possible", () => {
  assert.equal(shouldUseCodexWebSocketTransport(undefined), true);
  assert.equal(shouldUseCodexWebSocketTransport(""), true);
});

test("Codex app-server transport can still be forced for compatibility", () => {
  assert.equal(shouldUseCodexWebSocketTransport("stdio"), false);
  assert.equal(shouldUseCodexWebSocketTransport(" websocket "), true);
  assert.equal(shouldUseCodexWebSocketTransport("ws"), true);
});

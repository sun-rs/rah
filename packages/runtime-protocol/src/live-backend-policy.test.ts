import assert from "node:assert/strict";
import test from "node:test";
import {
  defaultLiveBackendForProvider,
  isCoreLiveProvider,
  isNativeLocalServerProvider,
  isTuiMuxFallbackProvider,
  liveBackendSupportedByProvider,
} from "./live-backend-policy";

test("live backend policy maps core providers to the intended runner families", () => {
  assert.equal(defaultLiveBackendForProvider("codex"), "native_local_server");
  assert.equal(defaultLiveBackendForProvider("opencode"), "native_local_server");
  assert.equal(defaultLiveBackendForProvider("claude"), "zellij_tui");
  assert.equal(defaultLiveBackendForProvider("custom"), undefined);

  assert.equal(isNativeLocalServerProvider("codex"), true);
  assert.equal(isNativeLocalServerProvider("opencode"), true);
  assert.equal(isNativeLocalServerProvider("claude"), false);

  assert.equal(isTuiMuxFallbackProvider("claude"), true);
  assert.equal(isTuiMuxFallbackProvider("codex"), false);

  assert.equal(isCoreLiveProvider("codex"), true);
  assert.equal(isCoreLiveProvider("claude"), true);
  assert.equal(isCoreLiveProvider("custom"), false);
});

test("live backend policy rejects accidental backend/provider drift", () => {
  assert.equal(
    liveBackendSupportedByProvider({ provider: "codex", liveBackend: "native_local_server" }),
    true,
  );
  assert.equal(
    liveBackendSupportedByProvider({ provider: "opencode", liveBackend: "native_local_server" }),
    true,
  );
  assert.equal(
    liveBackendSupportedByProvider({ provider: "claude", liveBackend: "zellij_tui" }),
    true,
  );

  assert.equal(
    liveBackendSupportedByProvider({ provider: "claude", liveBackend: "native_local_server" }),
    false,
  );
  assert.equal(
    liveBackendSupportedByProvider({ provider: "codex", liveBackend: "zellij_tui" }),
    false,
  );
});


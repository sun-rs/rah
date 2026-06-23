import assert from "node:assert/strict";
import test from "node:test";
import {
  claimNativeLocalTuiWarmLease,
  createNativeLocalTuiWarmState,
  nativeLocalTuiSurfaceKey,
  nativeLocalTuiWarmStateIdleExpired,
  releaseNativeLocalTuiWarmLease,
} from "./native-local-tui-warm-lifecycle";

test("native local tui warm lifecycle tracks independent visible surfaces", () => {
  const state = createNativeLocalTuiWarmState();
  claimNativeLocalTuiWarmLease({
    state,
    sessionId: "session-a",
    request: {
      clientId: "web",
      clientKind: "web",
      surfaceId: "pane-1",
      cols: 100.9,
      rows: 30.2,
    },
    nowMs: 100,
    attachedAt: "2026-06-16T00:00:00.000Z",
  });
  claimNativeLocalTuiWarmLease({
    state,
    sessionId: "session-a",
    request: {
      clientId: "web",
      clientKind: "web",
      surfaceId: "pane-2",
      cols: 10,
      rows: 4,
    },
    nowMs: 200,
    attachedAt: "2026-06-16T00:00:01.000Z",
  });

  assert.equal(state.leases.size, 2);
  assert.deepEqual(state.leases.get("pane-2"), {
    sessionId: "session-a",
    surfaceId: "pane-2",
    clientId: "web",
    clientKind: "web",
    cols: 20,
    rows: 8,
    attachedAt: "2026-06-16T00:00:01.000Z",
    lastSeenAtMs: 200,
  });

  releaseNativeLocalTuiWarmLease({
    state,
    request: { clientId: "web", surfaceId: "pane-1" },
    nowMs: 300,
    idleCloseMs: 1_000,
  });
  assert.equal(state.leases.size, 1);
  assert.equal(nativeLocalTuiWarmStateIdleExpired(state, 2_000), false);

  releaseNativeLocalTuiWarmLease({
    state,
    request: { clientId: "web", surfaceId: "pane-2" },
    nowMs: 400,
    idleCloseMs: 1_000,
  });
  assert.equal(state.leases.size, 0);
  assert.equal(state.idleSinceMs, 400);
  assert.equal(state.closeAfterMs, 1_400);
  assert.equal(nativeLocalTuiWarmStateIdleExpired(state, 1_399), false);
  assert.equal(nativeLocalTuiWarmStateIdleExpired(state, 1_400), true);
});

test("native local tui reattach cancels idle close", () => {
  const state = createNativeLocalTuiWarmState();
  claimNativeLocalTuiWarmLease({
    state,
    sessionId: "session-a",
    request: { clientId: "web", clientKind: "web" },
    nowMs: 0,
    attachedAt: "2026-06-16T00:00:00.000Z",
  });
  releaseNativeLocalTuiWarmLease({
    state,
    request: { clientId: "web" },
    nowMs: 10,
    idleCloseMs: 100,
  });
  assert.equal(state.closeAfterMs, 110);

  claimNativeLocalTuiWarmLease({
    state,
    sessionId: "session-a",
    request: { clientId: "web", clientKind: "web" },
    nowMs: 50,
    attachedAt: "2026-06-16T00:00:05.000Z",
  });

  assert.equal(state.leases.size, 1);
  assert.equal(state.idleSinceMs, undefined);
  assert.equal(state.closeAfterMs, undefined);
});

test("native local tui surface key falls back to client id", () => {
  assert.equal(nativeLocalTuiSurfaceKey({ clientId: "web" }), "web");
  assert.equal(
    nativeLocalTuiSurfaceKey({ clientId: "web", surfaceId: "pane-1" }),
    "pane-1",
  );
  assert.equal(
    nativeLocalTuiSurfaceKey({ clientId: "web", surfaceId: "  " }),
    "web",
  );
});

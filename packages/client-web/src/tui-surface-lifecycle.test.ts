import assert from "node:assert/strict";
import test from "node:test";
import {
  activateSessionTuiTerminal,
  PROVIDER_TUI_REPLAY_TAIL_BYTES,
  pruneCouncilTuiCache,
  removeCouncilTuiAgent,
  resolveActiveSessionTuiSurface,
  resetCouncilTuiCache,
  setCouncilTuiDetached,
  shouldReplayInitialSessionTuiOutput,
  TERMINAL_LAYOUT_SETTLE_DELAYS_MS,
  touchCouncilTuiCache,
  warmCouncilTuiCache,
} from "./tui-surface-lifecycle";

test("session tui surface is active only after the current session TUI was opened and not detached", () => {
  const openedTerminalIds = new Set(["session-a"]);
  const closedTerminalIds = new Set<string>();
  assert.deepEqual(
    resolveActiveSessionTuiSurface({
      terminalId: "session-a",
      clientId: "web",
      openedTerminalIds,
      closedTerminalIds,
    }),
    { terminalId: "session-a", clientId: "web" },
  );
  assert.equal(
    resolveActiveSessionTuiSurface({
      terminalId: "session-b",
      clientId: "web",
      openedTerminalIds,
      closedTerminalIds,
    }),
    null,
  );
  assert.equal(
    resolveActiveSessionTuiSurface({
      terminalId: "session-a",
      clientId: "web",
      openedTerminalIds,
      closedTerminalIds: new Set(["session-a"]),
    }),
    null,
  );
});

test("session tui activation reopens a previously closed web TUI client", () => {
  const state = activateSessionTuiTerminal({
    terminalId: "session-a",
    openedTerminalIds: new Set(["session-a"]),
    closedTerminalIds: new Set(["session-a"]),
  });

  assert.equal(state.openedTerminalIds.has("session-a"), true);
  assert.equal(state.closedTerminalIds.has("session-a"), false);
  assert.deepEqual(
    resolveActiveSessionTuiSurface({
      terminalId: "session-a",
      clientId: "web",
      openedTerminalIds: state.openedTerminalIds,
      closedTerminalIds: state.closedTerminalIds,
    }),
    { terminalId: "session-a", clientId: "web" },
  );
});

test("session tui opens with bounded PTY tail replay so remounts restore the current screen", () => {
  assert.equal(shouldReplayInitialSessionTuiOutput({ liveBackend: "native_local_server" }), true);
  assert.equal(shouldReplayInitialSessionTuiOutput({ liveBackend: "tui_mux" }), true);
  assert.equal(shouldReplayInitialSessionTuiOutput({ liveBackend: null }), true);
  assert.equal(PROVIDER_TUI_REPLAY_TAIL_BYTES, 96 * 1024);
});

test("terminal layout settle spans delayed mobile and canvas paints", () => {
  assert.deepEqual([...TERMINAL_LAYOUT_SETTLE_DELAYS_MS], [80, 160, 320, 640, 1_200]);
  assert.equal(TERMINAL_LAYOUT_SETTLE_DELAYS_MS.at(-1)! >= 1_000, true);
});

test("council tui cache keeps at most the warm limit while preserving the active agent", () => {
  let state = resetCouncilTuiCache();
  const liveAgentIds = Array.from({ length: 10 }, (_, index) => `agent-${index + 1}`);
  liveAgentIds.forEach((agentId, index) => {
    state = touchCouncilTuiCache({
      state,
      agentId,
      liveAgentIds,
      now: index + 1,
      activeAgentId: "agent-10",
      warmLimit: 8,
      warmTtlMs: 10_000,
    });
  });

  assert.equal(state.visitedAgentIds.size, 8);
  assert.equal(state.visitedAgentIds.has("agent-1"), false);
  assert.equal(state.visitedAgentIds.has("agent-2"), false);
  assert.equal(state.visitedAgentIds.has("agent-10"), true);
});

test("council tui cache prunes expired inactive agents without removing the active agent", () => {
  let state = resetCouncilTuiCache();
  state = touchCouncilTuiCache({
    state,
    agentId: "agent-a",
    liveAgentIds: ["agent-a", "agent-b"],
    now: 0,
    activeAgentId: "agent-a",
    warmTtlMs: 100,
  });
  state = touchCouncilTuiCache({
    state,
    agentId: "agent-b",
    liveAgentIds: ["agent-a", "agent-b"],
    now: 10,
    activeAgentId: "agent-b",
    warmTtlMs: 100,
  });

  state = pruneCouncilTuiCache({
    state,
    liveAgentIds: ["agent-a", "agent-b"],
    now: 1_000,
    activeAgentId: "agent-b",
    warmTtlMs: 100,
  });

  assert.deepEqual([...state.visitedAgentIds], ["agent-b"]);
});

test("manual council tui detach keeps the agent visited and attachable", () => {
  let state = resetCouncilTuiCache();
  state = touchCouncilTuiCache({
    state,
    agentId: "agent-a",
    liveAgentIds: ["agent-a"],
    now: 1,
  });
  state = setCouncilTuiDetached({ state, agentId: "agent-a", detached: true, now: 2 });
  assert.equal(state.visitedAgentIds.has("agent-a"), true);
  assert.equal(state.detachedAgentIds.has("agent-a"), true);

  state = setCouncilTuiDetached({ state, agentId: "agent-a", detached: false, now: 3 });
  assert.equal(state.detachedAgentIds.has("agent-a"), false);
});

test("weak council tab selection preserves manual detach while strong attach clears it", () => {
  let state = resetCouncilTuiCache();
  state = touchCouncilTuiCache({
    state,
    agentId: "agent-a",
    liveAgentIds: ["agent-a"],
    now: 1,
    attach: true,
  });
  state = setCouncilTuiDetached({ state, agentId: "agent-a", detached: true, now: 2 });

  state = touchCouncilTuiCache({
    state,
    agentId: "agent-a",
    liveAgentIds: ["agent-a"],
    now: 3,
    attach: false,
  });
  assert.equal(state.detachedAgentIds.has("agent-a"), true);

  state = touchCouncilTuiCache({
    state,
    agentId: "agent-a",
    liveAgentIds: ["agent-a"],
    now: 4,
    attach: true,
  });
  assert.equal(state.detachedAgentIds.has("agent-a"), false);
});

test("council initial warm attaches live agents once, then ttl starts from last viewed time", () => {
  let state = resetCouncilTuiCache();
  state = warmCouncilTuiCache({
    state,
    agentIds: ["agent-a", "agent-b"],
    liveAgentIds: ["agent-a", "agent-b"],
    now: 0,
    attach: true,
    activeAgentId: "agent-a",
    warmTtlMs: 100,
  });
  assert.deepEqual([...state.visitedAgentIds], ["agent-a", "agent-b"]);
  assert.equal(state.detachedAgentIds.size, 0);

  // A was watched until t=250, then the user switched to B.
  state = touchCouncilTuiCache({
    state,
    agentId: "agent-a",
    liveAgentIds: ["agent-a", "agent-b"],
    now: 250,
    activeAgentId: "agent-a",
    warmTtlMs: 100,
  });
  state = touchCouncilTuiCache({
    state,
    agentId: "agent-b",
    liveAgentIds: ["agent-a", "agent-b"],
    now: 250,
    activeAgentId: "agent-b",
    warmTtlMs: 100,
  });

  state = pruneCouncilTuiCache({
    state,
    liveAgentIds: ["agent-a", "agent-b"],
    now: 351,
    activeAgentId: "agent-b",
    warmTtlMs: 100,
  });
  assert.deepEqual([...state.visitedAgentIds], ["agent-b"]);

  // B was active for a long time; closing/hiding at t=1_000 starts B's TTL then.
  state = touchCouncilTuiCache({
    state,
    agentId: "agent-b",
    liveAgentIds: ["agent-a", "agent-b"],
    now: 1_000,
    activeAgentId: "agent-b",
    warmTtlMs: 100,
  });
  state = pruneCouncilTuiCache({
    state,
    liveAgentIds: ["agent-a", "agent-b"],
    now: 1_050,
    activeAgentId: null,
    warmTtlMs: 100,
  });
  assert.deepEqual([...state.visitedAgentIds], ["agent-b"]);
  state = pruneCouncilTuiCache({
    state,
    liveAgentIds: ["agent-a", "agent-b"],
    now: 1_101,
    activeAgentId: null,
    warmTtlMs: 100,
  });
  assert.deepEqual([...state.visitedAgentIds], []);
});

test("removed council agents are dropped from all tui cache indexes", () => {
  let state = resetCouncilTuiCache();
  state = touchCouncilTuiCache({
    state,
    agentId: "agent-a",
    liveAgentIds: ["agent-a"],
    now: 1,
  });
  state = setCouncilTuiDetached({ state, agentId: "agent-a", detached: true, now: 2 });
  state = removeCouncilTuiAgent(state, "agent-a");

  assert.equal(state.visitedAgentIds.has("agent-a"), false);
  assert.equal(state.detachedAgentIds.has("agent-a"), false);
  assert.equal(state.touchedAtByAgentId.has("agent-a"), false);
});

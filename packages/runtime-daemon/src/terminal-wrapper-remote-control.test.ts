import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { deriveTerminalWrapperRemoteControlState } from "./terminal-wrapper-remote-control";

describe("terminal wrapper remote control state", () => {
  it("keeps Esc disabled and red while a turn is queued", () => {
    const state = deriveTerminalWrapperRemoteControlState({
      providerLabel: "Codex",
      hasPendingTurn: true,
      hasActiveTurn: false,
      promptState: "prompt_clean",
      cancelRequested: false,
      reclaimRequested: false,
    });

    assert.equal(state.controlAvailable, false);
    assert.equal(state.status, "Queued");
    assert.equal(state.footer, "Queued input will run when ready.");
    assert.equal(state.tone, "danger");
  });

  it("keeps Esc disabled and red while the provider owns the turn", () => {
    const state = deriveTerminalWrapperRemoteControlState({
      providerLabel: "Claude",
      hasPendingTurn: false,
      hasActiveTurn: true,
      promptState: "agent_busy",
      cancelRequested: false,
      reclaimRequested: false,
    });

    assert.equal(state.controlAvailable, false);
    assert.equal(state.status, "Thinking");
    assert.equal(state.footer, "Only after this turn: Esc works.");
    assert.equal(state.tone, "danger");
  });

  it("keeps Esc disabled and red while stop is releasing provider control", () => {
    const state = deriveTerminalWrapperRemoteControlState({
      providerLabel: "Claude",
      hasPendingTurn: false,
      hasActiveTurn: true,
      promptState: "agent_busy",
      cancelRequested: true,
      reclaimRequested: false,
    });

    assert.equal(state.controlAvailable, false);
    assert.equal(state.status, "Stopping");
    assert.equal(state.footer, "Stop requested. Waiting for Claude to release control.");
    assert.equal(state.tone, "danger");
  });

  it("enables Esc and turns green only after every busy reason clears", () => {
    const state = deriveTerminalWrapperRemoteControlState({
      providerLabel: "Codex",
      hasPendingTurn: false,
      hasActiveTurn: false,
      promptState: "prompt_clean",
      cancelRequested: false,
      reclaimRequested: false,
    });

    assert.equal(state.controlAvailable, true);
    assert.equal(state.status, "Waiting for Esc reclaim");
    assert.equal(state.footer, "Press Esc to resume local control.");
    assert.equal(state.tone, "success");
  });
});

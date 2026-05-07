import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  applyLocalTerminalInput,
  nextPromptStateFromActivity,
} from "./native-tui-prompt-state";

describe("native TUI prompt state", () => {
  test("advances prompt state from provider activities", () => {
    assert.equal(
      nextPromptStateFromActivity("prompt_clean", {
        type: "turn_started",
        turnId: "turn-1",
      }),
      "agent_busy",
    );
    assert.equal(
      nextPromptStateFromActivity("agent_busy", {
        type: "turn_completed",
        turnId: "turn-1",
      }),
      "prompt_clean",
    );
    assert.equal(
      nextPromptStateFromActivity("prompt_dirty", {
        type: "turn_started",
        turnId: "turn-1",
      }),
      "prompt_dirty",
    );
    assert.equal(
      nextPromptStateFromActivity("prompt_dirty", {
        type: "turn_completed",
        turnId: "turn-1",
      }),
      "prompt_dirty",
    );
  });

  test("tracks local terminal draft input and submission", () => {
    const tracker = { draftText: "" };

    assert.equal(
      applyLocalTerminalInput({
        tracker,
        promptState: "prompt_clean",
        data: "hello",
      }),
      "prompt_dirty",
    );
    assert.equal(tracker.draftText, "hello");

    assert.equal(
      applyLocalTerminalInput({
        tracker,
        promptState: "prompt_dirty",
        data: "\u007f",
      }),
      "prompt_dirty",
    );
    assert.equal(tracker.draftText, "hell");

    assert.equal(
      applyLocalTerminalInput({
        tracker,
        promptState: "prompt_dirty",
        data: "\r",
      }),
      "agent_busy",
    );
    assert.equal(tracker.draftText, "");
  });

  test("clears local terminal draft with control keys", () => {
    const tracker = { draftText: "" };

    applyLocalTerminalInput({
      tracker,
      promptState: "prompt_clean",
      data: "abc",
    });

    assert.equal(
      applyLocalTerminalInput({
        tracker,
        promptState: "prompt_dirty",
        data: "\u0015",
      }),
      "prompt_clean",
    );
    assert.equal(tracker.draftText, "");
  });

  test("ignores escape-sequence navigation input", () => {
    const tracker = { draftText: "" };

    assert.equal(
      applyLocalTerminalInput({
        tracker,
        promptState: "prompt_clean",
        data: "\u001b[A",
      }),
      "prompt_clean",
    );
    assert.equal(tracker.draftText, "");
  });
});

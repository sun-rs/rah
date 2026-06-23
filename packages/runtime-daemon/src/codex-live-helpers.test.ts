import assert from "node:assert/strict";
import test from "node:test";
import { shouldApplyCodexTranslatedActivity } from "./codex-live-helpers";

test("skips inactive snapshot session state while a live Codex turn is active", () => {
  assert.equal(
    shouldApplyCodexTranslatedActivity({
      activity: { type: "session_state", state: "idle" },
      origin: "snapshot",
      currentTurnId: "turn-live",
    }),
    false,
  );
  assert.equal(
    shouldApplyCodexTranslatedActivity({
      activity: { type: "session_state", state: "failed" },
      origin: "snapshot",
      currentTurnId: "turn-live",
    }),
    false,
  );
});

test("applies active snapshot state and all live notification state", () => {
  assert.equal(
    shouldApplyCodexTranslatedActivity({
      activity: { type: "session_state", state: "running" },
      origin: "snapshot",
      currentTurnId: "turn-live",
    }),
    true,
  );
  assert.equal(
    shouldApplyCodexTranslatedActivity({
      activity: { type: "session_state", state: "waiting_permission" },
      origin: "snapshot",
      currentTurnId: "turn-live",
    }),
    true,
  );
  assert.equal(
    shouldApplyCodexTranslatedActivity({
      activity: { type: "session_state", state: "idle" },
      origin: "notification",
      currentTurnId: "turn-live",
    }),
    true,
  );
  assert.equal(
    shouldApplyCodexTranslatedActivity({
      activity: { type: "session_state", state: "idle" },
      origin: "snapshot",
      currentTurnId: null,
    }),
    true,
  );
});

test("skips session authority events from a different Codex thread", () => {
  assert.equal(
    shouldApplyCodexTranslatedActivity({
      activity: { type: "turn_completed", turnId: "subagent-turn" },
      origin: "notification",
      currentTurnId: "main-turn",
      providerSessionId: "thread-subagent",
      mainProviderSessionId: "thread-main",
    }),
    false,
  );
  assert.equal(
    shouldApplyCodexTranslatedActivity({
      activity: { type: "session_state", state: "idle" },
      origin: "notification",
      currentTurnId: "main-turn",
      providerSessionId: "thread-subagent",
      mainProviderSessionId: "thread-main",
    }),
    false,
  );
  assert.equal(
    shouldApplyCodexTranslatedActivity({
      activity: { type: "runtime_status", status: "finished" },
      origin: "notification",
      currentTurnId: "main-turn",
      providerSessionId: "thread-subagent",
      mainProviderSessionId: "thread-main",
    }),
    false,
  );
});

test("keeps visible subagent observations while filtering only session authority", () => {
  assert.equal(
    shouldApplyCodexTranslatedActivity({
      activity: {
        type: "observation_completed",
        turnId: "subagent-turn",
        observation: {
          id: "subagent-1",
          kind: "subagent.lifecycle",
          status: "completed",
          title: "Subagent activity",
        },
      },
      origin: "notification",
      currentTurnId: "main-turn",
      providerSessionId: "thread-subagent",
      mainProviderSessionId: "thread-main",
    }),
    true,
  );
});

test("skips non-lifecycle activity from different Codex threads", () => {
  assert.equal(
    shouldApplyCodexTranslatedActivity({
      activity: {
        type: "timeline_item",
        turnId: "subagent-turn",
        item: { kind: "user_message", text: "internal prompt" },
      },
      origin: "notification",
      currentTurnId: "main-turn",
      providerSessionId: "thread-subagent",
      mainProviderSessionId: "thread-main",
    }),
    false,
  );
  assert.equal(
    shouldApplyCodexTranslatedActivity({
      activity: {
        type: "tool_call_started",
        turnId: "subagent-turn",
        toolCall: {
          id: "tool-subagent",
          family: "other",
          providerToolName: "read",
          title: "Read",
        },
      },
      origin: "notification",
      currentTurnId: "main-turn",
      providerSessionId: "thread-subagent",
      mainProviderSessionId: "thread-main",
    }),
    false,
  );
});

test("applies main thread lifecycle events", () => {
  assert.equal(
    shouldApplyCodexTranslatedActivity({
      activity: { type: "turn_completed", turnId: "main-turn" },
      origin: "notification",
      currentTurnId: "main-turn",
      providerSessionId: "thread-main",
      mainProviderSessionId: "thread-main",
    }),
    true,
  );
});

test("skips unidentified lifecycle events for a different active turn", () => {
  assert.equal(
    shouldApplyCodexTranslatedActivity({
      activity: { type: "turn_completed", turnId: "subagent-turn" },
      origin: "notification",
      currentTurnId: "main-turn",
    }),
    false,
  );
  assert.equal(
    shouldApplyCodexTranslatedActivity({
      activity: { type: "turn_completed", turnId: "current-turn" },
      origin: "notification",
      currentTurnId: "main-turn",
    }),
    true,
  );
});

test("allows positively identified main-thread lifecycle to recover stale local turn state", () => {
  assert.equal(
    shouldApplyCodexTranslatedActivity({
      activity: { type: "turn_started", turnId: "main-turn-2" },
      origin: "notification",
      currentTurnId: "stale-turn",
      providerSessionId: "thread-main",
      mainProviderSessionId: "thread-main",
    }),
    true,
  );
});

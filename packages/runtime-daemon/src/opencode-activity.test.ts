import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  createOpenCodeActivityState,
  startOpenCodeTurn,
  translateOpenCodeEvent,
} from "./opencode-activity";

function withoutIdentity(activity: unknown): unknown {
  const { identity: _identity, ...rest } = activity as Record<string, unknown>;
  return rest;
}

describe("translateOpenCodeEvent", () => {
  test("maps OpenCode busy and idle status into turn lifecycle", () => {
    const state = createOpenCodeActivityState("session-1");

    const busy = translateOpenCodeEvent(state, {
      type: "session.status",
      properties: {
        sessionID: "session-1",
        status: { type: "busy" },
      },
    });
    const idle = translateOpenCodeEvent(state, {
      type: "session.status",
      properties: {
        sessionID: "session-1",
        status: { type: "idle" },
      },
    });

    assert.equal(busy[0]?.type, "turn_started");
    assert.deepEqual(busy[1], {
      type: "runtime_status",
      status: "thinking",
      turnId: busy[0]?.type === "turn_started" ? busy[0].turnId : undefined,
    });
    assert.deepEqual(idle, [
      {
        type: "runtime_status",
        status: "finished",
        turnId: busy[0]?.type === "turn_started" ? busy[0].turnId : undefined,
      },
      {
        type: "turn_completed",
        turnId: busy[0]?.type === "turn_started" ? busy[0].turnId : undefined,
      },
    ]);
  });

  test("finishes turn on terminal assistant message update", () => {
    const state = createOpenCodeActivityState("session-1");
    const busy = translateOpenCodeEvent(state, {
      type: "session.status",
      properties: {
        sessionID: "session-1",
        status: { type: "busy" },
      },
    });

    const activities = translateOpenCodeEvent(state, {
      type: "message.updated",
      properties: {
        info: {
          id: "assistant-1",
          sessionID: "session-1",
          role: "assistant",
          finish: "stop",
          time: { completed: Date.now() },
        },
      },
    });

    assert.deepEqual(activities, [
      {
        type: "runtime_status",
        status: "finished",
        turnId: busy[0]?.type === "turn_started" ? busy[0].turnId : undefined,
      },
      {
        type: "turn_completed",
        turnId: busy[0]?.type === "turn_started" ? busy[0].turnId : undefined,
      },
    ]);
  });

  test("keeps turn active when assistant message update finishes for tool calls", () => {
    const state = createOpenCodeActivityState("session-1");
    const busy = translateOpenCodeEvent(state, {
      type: "session.status",
      properties: {
        sessionID: "session-1",
        status: { type: "busy" },
      },
    });

    const activities = translateOpenCodeEvent(state, {
      type: "message.updated",
      properties: {
        info: {
          id: "assistant-1",
          sessionID: "session-1",
          role: "assistant",
          finish: "tool-calls",
          time: { completed: Date.now() },
        },
      },
    });

    assert.deepEqual(activities, []);
    assert.equal(
      state.currentTurnId,
      busy[0]?.type === "turn_started" ? busy[0].turnId : undefined,
    );
  });

  test("clears active turn on session error", () => {
    const state = createOpenCodeActivityState("session-1");
    const busy = translateOpenCodeEvent(state, {
      type: "session.status",
      properties: {
        sessionID: "session-1",
        status: { type: "busy" },
      },
    });

    const activities = translateOpenCodeEvent(state, {
      type: "session.error",
      properties: {
        sessionID: "session-1",
        error: { message: "boom" },
      },
    });

    assert.deepEqual(activities, [
      {
        type: "turn_failed",
        turnId: busy[0]?.type === "turn_started" ? busy[0].turnId : undefined,
        error: "boom",
      },
    ]);
    assert.equal(state.currentTurnId, undefined);
  });

  test("preserves assistant markdown text exactly", () => {
    const state = createOpenCodeActivityState("session-1");
    const text = [
      "会涉及抽象，但抽象只应该出现在系统内部。",
      "",
      "- AgentAdapter",
      "- EventModel",
      "",
      "```text",
      "+---+",
      "| UI |",
      "+---+",
      "```",
    ].join("\n");

    translateOpenCodeEvent(state, {
      type: "message.updated",
      properties: {
        info: {
          id: "message-1",
          sessionID: "session-1",
          role: "assistant",
        },
      },
    });
    const activities = translateOpenCodeEvent(state, {
      type: "message.part.updated",
      properties: {
        part: {
          id: "part-1",
          sessionID: "session-1",
          messageID: "message-1",
          type: "text",
          text,
        },
      },
    });

    assert.deepEqual(withoutIdentity(activities[0]!), {
      type: "timeline_item",
      turnId: "opencode:message-1",
      item: {
        kind: "assistant_message",
        text,
        messageId: "message-1",
      },
    });
  });

  test("omits absent optional fields from tool calls and permissions", () => {
    const state = createOpenCodeActivityState("session-1");
    translateOpenCodeEvent(state, {
      type: "message.updated",
      properties: {
        info: {
          id: "message-1",
          sessionID: "session-1",
          role: "assistant",
        },
      },
    });

    const toolActivities = translateOpenCodeEvent(state, {
      type: "message.part.updated",
      properties: {
        part: {
          id: "part-1",
          sessionID: "session-1",
          messageID: "message-1",
          type: "tool",
          callID: "call-1",
          tool: "bash",
          state: { status: "running" },
        },
      },
    });
    const permissionActivities = translateOpenCodeEvent(state, {
      type: "permission.asked",
      properties: {
        id: "permission-1",
        sessionID: "session-1",
        permission: "bash",
      },
    });

    assert.equal(toolActivities[0]?.type, "tool_call_started");
    if (toolActivities[0]?.type === "tool_call_started") {
      assert.equal("input" in toolActivities[0].toolCall, false);
    }
    assert.equal(permissionActivities[0]?.type, "permission_requested");
    if (permissionActivities[0]?.type === "permission_requested") {
      assert.equal("description" in permissionActivities[0].request, false);
    }
  });

  test("does not leak unknown reasoning deltas into assistant text", () => {
    const state = createOpenCodeActivityState("session-1");
    translateOpenCodeEvent(state, {
      type: "message.updated",
      properties: {
        info: {
          id: "assistant-1",
          sessionID: "session-1",
          role: "assistant",
        },
      },
    });

    const unknownDelta = translateOpenCodeEvent(state, {
      type: "message.part.delta",
      properties: {
        sessionID: "session-1",
        messageID: "assistant-1",
        partID: "reasoning-part",
        field: "text",
        delta: "internal reasoning",
      },
    });
    const reasoning = translateOpenCodeEvent(state, {
      type: "message.part.updated",
      properties: {
        part: {
          id: "reasoning-part",
          sessionID: "session-1",
          messageID: "assistant-1",
          type: "reasoning",
          text: "internal reasoning",
        },
      },
    });

    assert.deepEqual(unknownDelta, []);
    assert.deepEqual(withoutIdentity(reasoning[0]!), {
      type: "timeline_item",
      turnId: "opencode:assistant-1",
      item: { kind: "reasoning", text: "internal reasoning" },
    });
  });

  test("web-owned sessions ignore late provider user events after idle", () => {
    const state = createOpenCodeActivityState("session-1", {
      userMessagesStartTurns: false,
      emitUserMessages: false,
    });

    const busy = translateOpenCodeEvent(state, {
      type: "session.status",
      properties: { sessionID: "session-1", status: { type: "busy" } },
    });
    const idle = translateOpenCodeEvent(state, {
      type: "session.status",
      properties: { sessionID: "session-1", status: { type: "idle" } },
    });
    const lateUser = translateOpenCodeEvent(state, {
      type: "message.updated",
      properties: {
        info: {
          id: "user-1",
          sessionID: "session-1",
          role: "user",
        },
      },
    });
    const lateUserPart = translateOpenCodeEvent(state, {
      type: "message.part.updated",
      properties: {
        part: {
          id: "user-part",
          sessionID: "session-1",
          messageID: "user-1",
          type: "text",
          text: "hello",
        },
      },
    });

    assert.equal(busy[0]?.type, "turn_started");
    assert.equal(idle[1]?.type, "turn_completed");
    assert.deepEqual(lateUser, []);
    assert.deepEqual(lateUserPart, []);
  });

  test("web-owned sessions can attach late assistant parts after idle to the original turn", () => {
    const state = createOpenCodeActivityState("session-1");
    const turnId = "00000000-0000-4000-8000-000000000001";
    startOpenCodeTurn(state, turnId);

    const idle = translateOpenCodeEvent(state, {
      type: "session.status",
      properties: { sessionID: "session-1", status: { type: "idle" } },
    });
    state.currentTurnId = turnId;
    const lateAssistantInfo = translateOpenCodeEvent(state, {
      type: "message.updated",
      properties: {
        info: {
          id: "assistant-1",
          sessionID: "session-1",
          role: "assistant",
          finish: "stop",
          time: { completed: Date.now() },
        },
      },
    });
    state.currentTurnId = turnId;
    const lateAssistantPart = translateOpenCodeEvent(state, {
      type: "message.part.updated",
      properties: {
        part: {
          id: "assistant-part",
          sessionID: "session-1",
          messageID: "assistant-1",
          type: "text",
          text: "OK",
        },
      },
    });

    assert.equal(idle[1]?.type, "turn_completed");
    assert.equal(lateAssistantInfo[1]?.type, "turn_completed");
    assert.deepEqual(lateAssistantPart.map((activity) => withoutIdentity(activity)), [
      {
        type: "timeline_item",
        turnId,
        item: {
          kind: "assistant_message",
          text: "OK",
          messageId: "assistant-1",
        },
      },
    ]);
  });

  test("deduplicates running tool updates and completes the same tool entry", () => {
    const state = createOpenCodeActivityState("session-1");
    translateOpenCodeEvent(state, {
      type: "message.updated",
      properties: {
        info: {
          id: "assistant-1",
          sessionID: "session-1",
          role: "assistant",
        },
      },
    });
    const basePart = {
      id: "tool-part",
      sessionID: "session-1",
      messageID: "assistant-1",
      type: "tool",
      tool: "bash",
      callID: "call-1",
    };

    const pending = translateOpenCodeEvent(state, {
      type: "message.part.updated",
      properties: {
        part: {
          ...basePart,
          state: { status: "pending", input: {} },
        },
      },
    });
    const running = translateOpenCodeEvent(state, {
      type: "message.part.updated",
      properties: {
        part: {
          ...basePart,
          state: { status: "running", input: { command: "ls" } },
        },
      },
    });
    const runningOutput = translateOpenCodeEvent(state, {
      type: "message.part.updated",
      properties: {
        part: {
          ...basePart,
          state: {
            status: "running",
            input: { command: "ls" },
            metadata: { output: "file-a\n" },
          },
        },
      },
    });
    const completed = translateOpenCodeEvent(state, {
      type: "message.part.updated",
      properties: {
        part: {
          ...basePart,
          state: {
            status: "completed",
            input: { command: "ls" },
            output: "file-a\n",
            title: "List files",
          },
        },
      },
    });

    assert.deepEqual(pending, []);
    assert.equal(running[0]?.type, "tool_call_started");
    assert.equal(runningOutput[0]?.type, "tool_call_delta");
    assert.equal(completed[0]?.type, "tool_call_completed");
  });

  test("finishes turn on terminal assistant step finish", () => {
    const state = createOpenCodeActivityState("session-1");
    translateOpenCodeEvent(state, {
      type: "message.updated",
      properties: {
        info: {
          id: "assistant-1",
          sessionID: "session-1",
          role: "assistant",
        },
      },
    });

    const activities = translateOpenCodeEvent(state, {
      type: "message.part.updated",
      properties: {
        part: {
          id: "step-finish-1",
          sessionID: "session-1",
          messageID: "assistant-1",
          type: "step-finish",
          reason: "stop",
        },
      },
    });

    assert.deepEqual(activities, [
      {
        type: "turn_step_completed",
        turnId: "opencode:assistant-1",
      },
      {
        type: "runtime_status",
        status: "finished",
        turnId: "opencode:assistant-1",
      },
      {
        type: "turn_completed",
        turnId: "opencode:assistant-1",
      },
    ]);
  });

  test("keeps turn active when assistant step finish asks for tool calls", () => {
    const state = createOpenCodeActivityState("session-1");
    translateOpenCodeEvent(state, {
      type: "message.updated",
      properties: {
        info: {
          id: "assistant-1",
          sessionID: "session-1",
          role: "assistant",
        },
      },
    });

    const activities = translateOpenCodeEvent(state, {
      type: "message.part.updated",
      properties: {
        part: {
          id: "step-finish-1",
          sessionID: "session-1",
          messageID: "assistant-1",
          type: "step-finish",
          reason: "tool-calls",
        },
      },
    });

    assert.deepEqual(activities, [
      {
        type: "turn_step_completed",
        turnId: "opencode:assistant-1",
      },
    ]);
    assert.equal(state.currentTurnId, "opencode:assistant-1");
  });

  test("finishes turn on terminal step finish even when message role is not known yet", () => {
    const state = createOpenCodeActivityState("session-1");
    state.currentTurnId = "turn-1";

    const activities = translateOpenCodeEvent(state, {
      type: "message.part.updated",
      properties: {
        part: {
          id: "step-finish-1",
          sessionID: "session-1",
          messageID: "assistant-1",
          type: "step-finish",
          reason: "stop",
        },
      },
    });

    assert.deepEqual(activities, [
      {
        type: "turn_step_completed",
        turnId: "turn-1",
      },
      {
        type: "runtime_status",
        status: "finished",
        turnId: "turn-1",
      },
      {
        type: "turn_completed",
        turnId: "turn-1",
      },
    ]);
  });
});

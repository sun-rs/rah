import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  createOpenCodeActivityState,
  recordOpenCodeSubmittedUserMessage,
  startOpenCodeTurn,
  translateOpenCodeEvent,
  translateOpenCodeHistory,
  translateOpenCodeMessage,
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

    assert.deepEqual(activities.map(withoutIdentity), [
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

  test("maps OpenCode aborted assistant messages into canceled turns", () => {
    const state = createOpenCodeActivityState("session-1");
    const busy = translateOpenCodeEvent(state, {
      type: "session.status",
      properties: {
        sessionID: "session-1",
        status: { type: "busy" },
      },
    });
    const turnId = busy[0]?.type === "turn_started" ? busy[0].turnId : undefined;

    const activities = translateOpenCodeEvent(state, {
      type: "message.updated",
      properties: {
        info: {
          id: "assistant-aborted",
          sessionID: "session-1",
          role: "assistant",
          time: { completed: Date.now() },
          error: {
            name: "MessageAbortedError",
            data: { message: "Aborted" },
          },
        },
      },
    });

    assert.deepEqual(activities.map(withoutIdentity), [
      {
        type: "turn_canceled",
        turnId,
        reason: "interrupted",
      },
    ]);
  });

  test("emits usage from OpenCode assistant message token accounting", () => {
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
          tokens: {
            input: 100,
            output: 20,
            reasoning: 5,
            cache: { read: 7, write: 3 },
          },
          cost: 0.0123,
        },
      },
    });

    assert.deepEqual(activities[0], {
      type: "usage",
      turnId: busy[0]?.type === "turn_started" ? busy[0].turnId : undefined,
      usage: {
        source: "opencode.message.usage",
        usedTokens: 135,
        inputTokens: 100,
        outputTokens: 20,
        reasoningOutputTokens: 5,
        cachedInputTokens: 7,
        totalCostUsd: 0.0123,
      },
    });
    assert.equal(activities.at(-1)?.type, "turn_completed");
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

  test("uses nested OpenCode session error messages", () => {
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
        error: {
          name: "UnknownError",
          data: {
            message: "Model not found: aaa/wokao.",
          },
        },
      },
    });

    assert.deepEqual(activities, [
      {
        type: "turn_failed",
        turnId: busy[0]?.type === "turn_started" ? busy[0].turnId : undefined,
        error: "Model not found: aaa/wokao.",
      },
    ]);
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

  test("buffers text parts and deltas until their message role is known", () => {
    const state = createOpenCodeActivityState("session-1");
    const earlyText = translateOpenCodeEvent(state, {
      type: "message.part.updated",
      properties: {
        part: {
          id: "part-1",
          sessionID: "session-1",
          messageID: "message-1",
          type: "text",
          text: "hello",
        },
      },
    });
    const earlyDelta = translateOpenCodeEvent(state, {
      type: "message.part.delta",
      properties: {
        sessionID: "session-1",
        messageID: "message-1",
        partID: "part-1",
        field: "text",
        delta: " world",
      },
    });

    assert.deepEqual(earlyText, []);
    assert.deepEqual(earlyDelta, []);
    const message = translateOpenCodeEvent(state, {
      type: "message.updated",
      properties: {
        info: {
          id: "message-1",
          sessionID: "session-1",
          role: "assistant",
        },
      },
    });
    assert.deepEqual(message.map((activity) => withoutIdentity(activity)), [
      {
        type: "timeline_item",
        turnId: "opencode:message-1",
        item: {
          kind: "assistant_message",
          text: "hello",
          messageId: "message-1",
        },
      },
      {
        type: "timeline_item",
        turnId: "opencode:message-1",
        item: {
          kind: "assistant_message",
          text: "hello world",
          messageId: "message-1",
        },
      },
    ]);
  });

  test("buffers OpenCode text deltas until part metadata is known", () => {
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

    const earlyDelta = translateOpenCodeEvent(state, {
      type: "message.part.delta",
      properties: {
        sessionID: "session-1",
        messageID: "assistant-1",
        partID: "text-part",
        field: "text",
        delta: "hello",
      },
    });
    const part = translateOpenCodeEvent(state, {
      type: "message.part.updated",
      properties: {
        part: {
          id: "text-part",
          sessionID: "session-1",
          messageID: "assistant-1",
          type: "text",
        },
      },
    });

    assert.deepEqual(earlyDelta, []);
    assert.deepEqual(part.map((activity) => withoutIdentity(activity)), [
      {
        type: "timeline_item",
        turnId: "opencode:assistant-1",
        item: {
          kind: "assistant_message",
          text: "hello",
          messageId: "assistant-1",
        },
      },
    ]);
  });

  test("emits cumulative OpenCode text deltas for event-first chat", () => {
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
    translateOpenCodeEvent(state, {
      type: "message.part.updated",
      properties: {
        part: {
          id: "text-part",
          sessionID: "session-1",
          messageID: "assistant-1",
          type: "text",
        },
      },
    });

    const first = translateOpenCodeEvent(state, {
      type: "message.part.delta",
      properties: {
        sessionID: "session-1",
        messageID: "assistant-1",
        partID: "text-part",
        field: "text",
        delta: "hello",
      },
    });
    const second = translateOpenCodeEvent(state, {
      type: "message.part.delta",
      properties: {
        sessionID: "session-1",
        messageID: "assistant-1",
        partID: "text-part",
        field: "text",
        delta: " world",
      },
    });

    assert.deepEqual(withoutIdentity(first[0]!), {
      type: "timeline_item",
      turnId: "opencode:assistant-1",
      item: {
        kind: "assistant_message",
        text: "hello",
        messageId: "assistant-1",
      },
    });
    assert.deepEqual(withoutIdentity(second[0]!), {
      type: "timeline_item",
      turnId: "opencode:assistant-1",
      item: {
        kind: "assistant_message",
        text: "hello world",
        messageId: "assistant-1",
      },
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

  test("attaches client ids to the provider user message for web-submitted prompts", () => {
    const state = createOpenCodeActivityState("session-1");
    const turnId = "11111111-1111-4111-8111-111111111111";
    startOpenCodeTurn(state, turnId);
    recordOpenCodeSubmittedUserMessage(state, {
      text: "hello",
      turnId,
      clientMessageId: "client-message-1",
      clientTurnId: "client-turn-1",
    });

    const activities = translateOpenCodeMessage(state, {
      info: {
        id: "msg-user",
        sessionID: "session-1",
        role: "user",
      },
      parts: [
        {
          id: "part-user",
          sessionID: "session-1",
          messageID: "msg-user",
          type: "text",
          text: "hello",
        },
      ],
    });

    const user = activities.find(
      (activity) => activity.type === "timeline_item" && activity.item.kind === "user_message",
    );
    assert.equal(user?.type, "timeline_item");
    if (user?.type === "timeline_item" && user.item.kind === "user_message") {
      assert.equal(user.turnId, turnId);
      assert.equal(user.item.messageId, "msg-user");
      assert.equal(user.item.clientMessageId, "client-message-1");
      assert.equal(user.item.clientTurnId, "client-turn-1");
    }
  });

  test("does not emit provisional OpenCode user bubble before provider message id is known", () => {
    const state = createOpenCodeActivityState("session-1");
    const turnId = "11111111-1111-4111-8111-111111111111";
    startOpenCodeTurn(state, turnId);
    recordOpenCodeSubmittedUserMessage(state, {
      text: "hello",
      turnId,
      clientMessageId: "client-message-1",
      clientTurnId: "client-turn-1",
    });

    const provisional = translateOpenCodeEvent(state, {
      type: "message.part.updated",
      properties: {
        part: {
          id: "part-user-provisional",
          sessionID: "session-1",
          type: "text",
          text: "hello",
        },
      },
    });

    assert.deepEqual(provisional, []);

    const canonical = translateOpenCodeMessage(state, {
      info: {
        id: "msg-user",
        sessionID: "session-1",
        role: "user",
      },
      parts: [
        {
          id: "part-user",
          sessionID: "session-1",
          messageID: "msg-user",
          type: "text",
          text: "hello",
        },
      ],
    });

    const user = canonical.find(
      (activity) => activity.type === "timeline_item" && activity.item.kind === "user_message",
    );
    assert.equal(user?.type, "timeline_item");
    if (user?.type === "timeline_item" && user.item.kind === "user_message") {
      assert.equal(user.item.messageId, "msg-user");
      assert.equal(user.item.clientMessageId, "client-message-1");
      assert.equal(user.item.clientTurnId, "client-turn-1");
    }
  });

  test("drops OpenCode internal system reminder user messages from history", () => {
    const activities = translateOpenCodeMessage(createOpenCodeActivityState("session-1", { origin: "history" }), {
      info: {
        id: "msg-internal",
        sessionID: "session-1",
        role: "user",
      },
      parts: [
        {
          id: "part-internal",
          sessionID: "session-1",
          messageID: "msg-internal",
          type: "text",
          text: [
            "<system-reminder>",
            "[BACKGROUND TASK COMPLETED]",
            "Use `background_output(task_id=\"bg_1\")` to retrieve this result when ready.",
            "</system-reminder>",
            "<!-- OMO_INTERNAL_INITIATOR -->",
          ].join("\n"),
        },
      ],
    });

    assert.deepEqual(activities, []);
  });

  test("keeps ordinary user system-reminder text without OpenCode internal markers", () => {
    const activities = translateOpenCodeMessage(createOpenCodeActivityState("session-1", { origin: "history" }), {
      info: {
        id: "msg-user",
        sessionID: "session-1",
        role: "user",
      },
      parts: [
        {
          id: "part-user",
          sessionID: "session-1",
          messageID: "msg-user",
          type: "text",
          text: [
            "<system-reminder>",
            "Treat this as user-visible text for this test.",
            "</system-reminder>",
          ].join("\n"),
        },
      ],
    });

    assert.equal(activities[0]?.type, "turn_started");
    assert.equal(activities[1]?.type, "timeline_item");
    if (activities[1]?.type === "timeline_item") {
      assert.equal(activities[1].item.kind, "user_message");
    }
  });

  test("drops live OpenCode internal system reminder parts and clears the synthetic turn", () => {
    const state = createOpenCodeActivityState("session-1");
    const message = translateOpenCodeEvent(state, {
      type: "message.updated",
      properties: {
        info: {
          id: "msg-internal",
          sessionID: "session-1",
          role: "user",
        },
      },
    });
    const part = translateOpenCodeEvent(state, {
      type: "message.part.updated",
      properties: {
        part: {
          id: "part-internal",
          sessionID: "session-1",
          messageID: "msg-internal",
          type: "text",
          text: [
            "<system-reminder>",
            "[BACKGROUND TASK COMPLETED]",
            "Use `background_output(task_id=\"bg_1\")` to retrieve this result when ready.",
            "</system-reminder>",
            "<!-- OMO_INTERNAL_INITIATOR -->",
          ].join("\n"),
        },
      },
    });

    assert.equal(message[0]?.type, "turn_started");
    const turnId = message[0]?.type === "turn_started" ? message[0].turnId : undefined;
    assert.deepEqual(part.map(withoutIdentity), [
      {
        type: "runtime_status",
        status: "finished",
        turnId,
      },
      {
        type: "turn_completed",
        turnId,
      },
    ]);
    const completed = part[1];
    assert.equal(completed?.type, "turn_completed");
    if (completed?.type === "turn_completed") {
      assert.equal(completed.identity?.provider, "opencode");
      assert.equal(completed.identity?.providerSessionId, "session-1");
      assert.equal(completed.identity?.turnKey, "message:msg-internal");
      assert.equal(completed.identity?.origin, "live");
      assert.equal(completed.identity?.confidence, "native");
    }
    assert.equal(state.currentTurnId, undefined);
  });

  test("drops live OpenCode internal reminders without clearing an existing real turn", () => {
    const state = createOpenCodeActivityState("session-1");
    const [started] = startOpenCodeTurn(state, "00000000-0000-4000-8000-000000000002");
    const message = translateOpenCodeEvent(state, {
      type: "message.updated",
      properties: {
        info: {
          id: "msg-internal",
          sessionID: "session-1",
          role: "user",
        },
      },
    });
    const part = translateOpenCodeEvent(state, {
      type: "message.part.updated",
      properties: {
        part: {
          id: "part-internal",
          sessionID: "session-1",
          messageID: "msg-internal",
          type: "text",
          text: [
            "<system-reminder>",
            "[BACKGROUND TASK COMPLETED]",
            "</system-reminder>",
            "<!-- OMO_INTERNAL_INITIATOR -->",
          ].join("\n"),
        },
      },
    });

    assert.equal(started?.type, "turn_started");
    assert.deepEqual(message, []);
    assert.deepEqual(part, []);
    assert.equal(state.currentTurnId, "00000000-0000-4000-8000-000000000002");
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

    assert.deepEqual(activities.map(withoutIdentity), [
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

    assert.deepEqual(activities, []);
    assert.equal(state.currentTurnId, "opencode:assistant-1");
  });

  test("deduplicates repeated titled OpenCode step part revisions", () => {
    const state = createOpenCodeActivityState("session-1");
    translateOpenCodeEvent(state, {
      type: "message.updated",
      properties: {
        info: {
          id: "msg-user",
          sessionID: "session-1",
          role: "user",
        },
      },
    });
    translateOpenCodeEvent(state, {
      type: "message.updated",
      properties: {
        info: {
          id: "msg-assistant",
          sessionID: "session-1",
          parentID: "msg-user",
          role: "assistant",
        },
      },
    });

    const firstStart = translateOpenCodeEvent(state, {
      type: "message.part.updated",
      properties: {
        part: {
          id: "step-start-1",
          sessionID: "session-1",
          messageID: "msg-assistant",
          type: "step-start",
          title: "Read files",
        },
      },
    });
    const duplicateStart = translateOpenCodeEvent(state, {
      type: "message.part.updated",
      properties: {
        part: {
          id: "step-start-1",
          sessionID: "session-1",
          messageID: "msg-assistant",
          type: "step-start",
          title: "Read files",
        },
      },
    });
    const firstFinish = translateOpenCodeEvent(state, {
      type: "message.part.updated",
      properties: {
        part: {
          id: "step-finish-1",
          sessionID: "session-1",
          messageID: "msg-assistant",
          type: "step-finish",
          reason: "tool-calls",
        },
      },
    });
    const duplicateFinish = translateOpenCodeEvent(state, {
      type: "message.part.updated",
      properties: {
        part: {
          id: "step-finish-1",
          sessionID: "session-1",
          messageID: "msg-assistant",
          type: "step-finish",
          reason: "tool-calls",
        },
      },
    });

    assert.deepEqual(firstStart, [
      {
        type: "turn_step_started",
        turnId: "opencode:msg-user",
        index: 1,
        title: "Read files",
      },
    ]);
    assert.deepEqual(duplicateStart, []);
    assert.deepEqual(firstFinish, [
      {
        type: "turn_step_completed",
        turnId: "opencode:msg-user",
        index: 1,
        reason: "tool-calls",
      },
    ]);
    assert.deepEqual(duplicateFinish, []);
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

  test("maps stored DB messages with reasoning, tool, step, and usage", () => {
    const activities = translateOpenCodeHistory([
      {
        info: {
          id: "msg-user",
          sessionID: "session-1",
          role: "user",
          time: { created: 1 },
        },
        parts: [
          {
            id: "part-user",
            sessionID: "session-1",
            messageID: "msg-user",
            type: "text",
            text: "OpenCode question",
          },
        ],
      },
      {
        info: {
          id: "msg-assistant",
          sessionID: "session-1",
          role: "assistant",
          parentID: "msg-user",
          finish: "stop",
          time: { created: 2, completed: 3 },
          tokens: {
            input: 10,
            output: 4,
            reasoning: 2,
            cache: { read: 1, write: 1 },
          },
          cost: 0.001,
        },
        parts: [
          {
            id: "part-reasoning",
            sessionID: "session-1",
            messageID: "msg-assistant",
            type: "reasoning",
            text: "OpenCode reasoning",
          },
          {
            id: "part-step-start",
            sessionID: "session-1",
            messageID: "msg-assistant",
            type: "step-start",
          },
          {
            id: "part-tool",
            sessionID: "session-1",
            messageID: "msg-assistant",
            type: "tool",
            callID: "call-1",
            tool: "bash",
            state: {
              status: "completed",
              input: { command: "ls" },
              output: "file-a\n",
              title: "List files",
            },
          },
          {
            id: "part-text",
            sessionID: "session-1",
            messageID: "msg-assistant",
            type: "text",
            text: "OpenCode answer",
          },
          {
            id: "part-step-finish",
            sessionID: "session-1",
            messageID: "msg-assistant",
            type: "step-finish",
            reason: "stop",
          },
        ],
      },
    ]);

    assert.equal(
      activities.some(
        (activity) =>
          activity.type === "timeline_item" &&
          activity.item.kind === "reasoning" &&
          activity.item.text === "OpenCode reasoning",
      ),
      true,
    );
    assert.equal(
      activities.some(
        (activity) =>
          activity.type === "tool_call_completed" &&
          activity.toolCall.providerToolName === "bash" &&
          activity.toolCall.title === "List files",
      ),
      true,
    );
    assert.equal(activities.some((activity) => activity.type === "turn_step_started"), false);
    assert.equal(activities.some((activity) => activity.type === "turn_step_completed"), false);
    assert.equal(
      activities.some(
        (activity) =>
          activity.type === "usage" &&
          activity.usage.source === "opencode.message.usage" &&
          activity.usage.usedTokens === 18,
      ),
      true,
    );
    const timelineItems = activities.filter(
      (activity) => activity.type === "timeline_item",
    );
    assert.equal(timelineItems.length, 3);
    for (const activity of timelineItems) {
      assert.ok(activity.identity?.canonicalItemId);
      assert.equal(activity.identity.provider, "opencode");
      assert.equal(activity.identity.providerSessionId, "session-1");
      assert.equal(activity.identity.origin, "history");
    }
  });

  test("attaches OpenCode model metadata to live Council MCP channel posts", () => {
    const state = createOpenCodeActivityState("session-1");
    translateOpenCodeEvent(state, {
      type: "message.updated",
      properties: {
        info: {
          id: "msg-assistant",
          sessionID: "session-1",
          role: "assistant",
          parentID: "msg-user",
          providerID: "deepseek",
          modelID: "deepseek-v4-pro",
          variant: "low",
          time: { created: 2 },
        },
      },
    });

    const activities = translateOpenCodeEvent(state, {
      type: "message.part.updated",
      properties: {
        part: {
          id: "part-post",
          sessionID: "session-1",
          messageID: "msg-assistant",
          type: "tool",
          callID: "call-post",
          tool: "rah_council_channel_post",
          state: {
            status: "completed",
            input: { council_id: "council-1", content: "Live Council reply" },
            output: JSON.stringify({ ok: true }),
          },
        },
      },
    });

    const assistant = activities.find(
      (activity) =>
        activity.type === "timeline_item" &&
        activity.item.kind === "assistant_message",
    );
    assert.equal(assistant?.type, "timeline_item");
    if (assistant?.type === "timeline_item" && assistant.item.kind === "assistant_message") {
      assert.deepEqual(assistant.item, {
        kind: "assistant_message",
        messageId: "council-mcp:call-post",
        text: "Live Council reply",
        runtimeModel: {
          modelId: "deepseek/deepseek-v4-pro",
          optionId: "low",
          optionKind: "model_variant",
          source: "native",
        },
      });
    }
  });

  test("projects Council MCP channel posts and hides polling tools from OpenCode history", () => {
    const activities = translateOpenCodeHistory([
      {
        info: {
          id: "msg-user",
          sessionID: "session-1",
          role: "user",
          time: { created: 1 },
        },
        parts: [
          {
            id: "part-user",
            sessionID: "session-1",
            messageID: "msg-user",
            type: "text",
            text: "Council prompt",
          },
        ],
      },
      {
        info: {
          id: "msg-assistant",
          sessionID: "session-1",
          role: "assistant",
          parentID: "msg-user",
          providerID: "deepseek",
          modelID: "deepseek-v4-pro",
          variant: "low",
          finish: "stop",
          time: { created: 2, completed: 3 },
        },
        parts: [
          {
            id: "part-wait",
            sessionID: "session-1",
            messageID: "msg-assistant",
            type: "tool",
            callID: "call-wait",
            tool: "rah_council_channel_wait_new",
            state: {
              status: "completed",
              input: { council_id: "council-1" },
              output: JSON.stringify({ ok: true, messages: [] }),
            },
          },
          {
            id: "part-post",
            sessionID: "session-1",
            messageID: "msg-assistant",
            type: "tool",
            callID: "call-post",
            tool: "rah_council_channel_post",
            state: {
              status: "completed",
              input: { council_id: "council-1", content: "Visible Council reply" },
              output: JSON.stringify({ ok: true }),
            },
          },
        ],
      },
    ]);

    assert.equal(
      activities.some((activity) => activity.type === "tool_call_completed"),
      false,
    );
    const assistantMessages = activities.filter(
      (activity) =>
        activity.type === "timeline_item" &&
        activity.item.kind === "assistant_message",
    );
    assert.equal(assistantMessages.length, 1);
    const assistant = assistantMessages[0];
    assert.equal(assistant?.type, "timeline_item");
  if (assistant?.type === "timeline_item" && assistant.item.kind === "assistant_message") {
    assert.equal(assistant.item.text, "Visible Council reply");
    assert.equal(assistant.item.messageId, "council-mcp:call-post");
    assert.deepEqual(assistant.item.runtimeModel, {
        modelId: "deepseek/deepseek-v4-pro",
        optionId: "low",
        optionKind: "model_variant",
        source: "native",
      });
      assert.equal(assistant.identity?.provider, "opencode");
      assert.equal(assistant.identity?.providerSessionId, "session-1");
      assert.equal(assistant.identity?.sourceCursor?.providerEventId, "part-post");
      assert.equal(assistant.identity?.confidence, "derived");
    }
  });

  test("projects Council MCP user messages from channel_wait_new output", () => {
    const activities = translateOpenCodeHistory([
      {
        info: {
          id: "msg-assistant",
          sessionID: "session-1",
          role: "assistant",
          providerID: "deepseek",
          modelID: "deepseek-v4-pro",
          time: { created: 2, completed: 3 },
        },
        parts: [
          {
            id: "part-wait",
            sessionID: "session-1",
            messageID: "msg-assistant",
            type: "tool",
            callID: "call-wait",
            tool: "rah_council_channel_wait_new",
            state: {
              status: "completed",
              input: { council_id: "council-1", since_id: 0 },
              output: JSON.stringify({
                ok: true,
                msg: {
                  id: 42,
                  role: "user",
                  actor: "user",
                  content: "Council prompt",
                },
              }),
            },
          },
        ],
      },
    ]);

    const user = activities.find(
      (activity) =>
        activity.type === "timeline_item" &&
        activity.item.kind === "user_message",
    );
    assert.equal(user?.type, "timeline_item");
    if (user?.type === "timeline_item" && user.item.kind === "user_message") {
      assert.equal(user.item.text, "Council prompt");
      assert.equal(user.item.messageId, "council-mcp:user:42");
      assert.equal(user.identity?.itemKind, "user_message");
      assert.equal(user.identity?.confidence, "derived");
    }
  });

  test("maps stored OpenCode MessageAbortedError into a visible canceled turn", () => {
    const activities = translateOpenCodeHistory([
      {
        info: {
          id: "msg-user",
          sessionID: "session-1",
          role: "user",
          time: { created: 1 },
        },
        parts: [
          {
            id: "part-user",
            sessionID: "session-1",
            messageID: "msg-user",
            type: "text",
            text: "sleep 5",
          },
        ],
      },
      {
        info: {
          id: "msg-assistant-aborted",
          sessionID: "session-1",
          role: "assistant",
          parentID: "msg-user",
          time: { created: 2, completed: 3 },
          error: {
            name: "MessageAbortedError",
            data: { message: "Aborted" },
          },
        },
        parts: [
          {
            id: "part-reasoning",
            sessionID: "session-1",
            messageID: "msg-assistant-aborted",
            type: "reasoning",
            text: "OpenCode partial reasoning",
          },
        ],
      },
    ]);

    assert.equal(
      activities.some(
        (activity) =>
          activity.type === "timeline_item" &&
          activity.item.kind === "reasoning" &&
          activity.item.text === "OpenCode partial reasoning",
      ),
      true,
    );
    assert.deepEqual(
      activities
        .filter((activity) => activity.type === "turn_canceled" || activity.type === "turn_completed")
        .map((activity) => activity.type),
      ["turn_canceled"],
    );
  });

  test("starts a fresh history turn for a later user message even if the previous turn is unfinished", () => {
    const activities = translateOpenCodeHistory([
      {
        info: {
          id: "msg-user-1",
          sessionID: "session-1",
          role: "user",
          time: { created: 1 },
        },
        parts: [
          {
            id: "part-user-1",
            sessionID: "session-1",
            messageID: "msg-user-1",
            type: "text",
            text: "first question",
          },
        ],
      },
      {
        info: {
          id: "msg-assistant-1",
          sessionID: "session-1",
          role: "assistant",
          parentID: "msg-user-1",
          time: { created: 2 },
        },
        parts: [
          {
            id: "part-reasoning-1",
            sessionID: "session-1",
            messageID: "msg-assistant-1",
            type: "reasoning",
            text: "still working",
          },
        ],
      },
      {
        info: {
          id: "msg-user-2",
          sessionID: "session-1",
          role: "user",
          time: { created: 3 },
        },
        parts: [
          {
            id: "part-user-2",
            sessionID: "session-1",
            messageID: "msg-user-2",
            type: "text",
            text: "second question",
          },
        ],
      },
    ]);

    assert.deepEqual(
      activities
        .filter((activity) => activity.type === "turn_started")
        .map((activity) => activity.turnId),
      ["opencode:msg-user-1", "opencode:msg-user-2"],
    );
    const secondUser = activities.find(
      (activity) =>
        activity.type === "timeline_item" &&
        activity.item.kind === "user_message" &&
        activity.item.text === "second question",
    );
    assert.equal(secondUser?.type, "timeline_item");
    assert.equal(secondUser?.turnId, "opencode:msg-user-2");
  });

  test("attaches OpenCode provider model metadata to assistant text parts", () => {
    const activities = translateOpenCodeHistory([
      {
        info: {
          id: "msg-user-model",
          sessionID: "session-1",
          role: "user",
          time: { created: 1 },
        },
        parts: [
          {
            id: "part-user-model",
            sessionID: "session-1",
            messageID: "msg-user-model",
            type: "text",
            text: "which model",
          },
        ],
      },
      {
        info: {
          id: "msg-assistant-model",
          sessionID: "session-1",
          role: "assistant",
          parentID: "msg-user-model",
          providerID: "aihubmix",
          modelID: "grok-4.3",
          variant: "high",
          time: { created: 2, completed: 3 },
          finish: "stop",
        },
        parts: [
          {
            id: "part-assistant-model",
            sessionID: "session-1",
            messageID: "msg-assistant-model",
            type: "text",
            text: "model answer",
          },
        ],
      },
    ]);

    const assistant = activities.find(
      (activity) =>
        activity.type === "timeline_item" &&
        activity.item.kind === "assistant_message" &&
        activity.item.text === "model answer",
    );
    assert.equal(assistant?.type, "timeline_item");
    if (assistant?.type === "timeline_item" && assistant.item.kind === "assistant_message") {
      assert.deepEqual(assistant.item.runtimeModel, {
        modelId: "aihubmix/grok-4.3",
        optionId: "high",
        optionKind: "model_variant",
        source: "native",
      });
    }
  });

  test("attaches OpenCode provider model metadata to reasoning and step-only assistant parts", () => {
    const activities = translateOpenCodeHistory([
      {
        info: {
          id: "msg-user-model",
          sessionID: "session-1",
          role: "user",
          time: { created: 1 },
        },
        parts: [
          {
            id: "part-user-model",
            sessionID: "session-1",
            messageID: "msg-user-model",
            type: "text",
            text: "which model",
          },
        ],
      },
      {
        info: {
          id: "msg-assistant-model",
          sessionID: "session-1",
          role: "assistant",
          parentID: "msg-user-model",
          providerID: "aihubmix",
          modelID: "grok-4.3",
          variant: "high",
          time: { created: 2, completed: 3 },
          finish: "tool-calls",
        },
        parts: [
          {
            id: "part-step-start",
            sessionID: "session-1",
            messageID: "msg-assistant-model",
            type: "step-start",
            title: "Analyze",
          },
          {
            id: "part-reasoning-model",
            sessionID: "session-1",
            messageID: "msg-assistant-model",
            type: "reasoning",
            text: "thinking",
          },
          {
            id: "part-step-finish",
            sessionID: "session-1",
            messageID: "msg-assistant-model",
            type: "step-finish",
            reason: "stop",
          },
        ],
      },
    ]);

    const expectedRuntimeModel = {
      modelId: "aihubmix/grok-4.3",
      optionId: "high",
      optionKind: "model_variant",
      source: "native",
    };
    const step = activities.find((activity) => activity.type === "turn_step_started");
    const reasoning = activities.find(
      (activity) => activity.type === "timeline_item" && activity.item.kind === "reasoning",
    );
    assert.equal(step?.type, "turn_step_started");
    if (step?.type === "turn_step_started") {
      assert.deepEqual(step.runtimeModel, expectedRuntimeModel);
    }
    assert.equal(reasoning?.type, "timeline_item");
    if (reasoning?.type === "timeline_item" && reasoning.item.kind === "reasoning") {
      assert.deepEqual(reasoning.item.runtimeModel, expectedRuntimeModel);
    }
  });

  test("backfills late OpenCode provider model metadata into live reasoning and step entries", () => {
    const state = createOpenCodeActivityState("session-1");
    startOpenCodeTurn(state, "00000000-0000-4000-8000-000000000003");
    translateOpenCodeEvent(state, {
      type: "message.updated",
      properties: {
        info: {
          id: "msg-assistant-model",
          sessionID: "session-1",
          role: "assistant",
        },
      },
    });
    translateOpenCodeEvent(state, {
      type: "message.part.updated",
      properties: {
        part: {
          id: "part-step-start",
          sessionID: "session-1",
          messageID: "msg-assistant-model",
          type: "step-start",
          title: "Analyze",
        },
      },
    });
    translateOpenCodeEvent(state, {
      type: "message.part.updated",
      properties: {
        part: {
          id: "part-reasoning-model",
          sessionID: "session-1",
          messageID: "msg-assistant-model",
          type: "reasoning",
          text: "thinking",
        },
      },
    });

    const updates = translateOpenCodeEvent(state, {
      type: "message.updated",
      properties: {
        info: {
          id: "msg-assistant-model",
          sessionID: "session-1",
          role: "assistant",
          providerID: "aihubmix",
          modelID: "grok-4.3",
          variant: "high",
        },
      },
    });

    const expectedRuntimeModel = {
      modelId: "aihubmix/grok-4.3",
      optionId: "high",
      optionKind: "model_variant",
      source: "native",
    };
    const stepUpdate = updates.find((activity) => activity.type === "turn_step_started");
    const reasoningUpdate = updates.find(
      (activity) => activity.type === "timeline_item_updated" && activity.item.kind === "reasoning",
    );
    assert.equal(stepUpdate?.type, "turn_step_started");
    if (stepUpdate?.type === "turn_step_started") {
      assert.deepEqual(stepUpdate.runtimeModel, expectedRuntimeModel);
    }
    assert.equal(reasoningUpdate?.type, "timeline_item_updated");
    if (reasoningUpdate?.type === "timeline_item_updated" && reasoningUpdate.item.kind === "reasoning") {
      assert.deepEqual(reasoningUpdate.item.runtimeModel, expectedRuntimeModel);
    }
  });
});

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createOpenCodeActivityState, startOpenCodeTurn } from "./opencode-activity";
import { translateOpenCodeAcpSessionUpdate } from "./opencode-acp-activity";

function withoutIdentity(activity: unknown): unknown {
  const { identity: _identity, ...rest } = activity as Record<string, unknown>;
  return rest;
}

describe("translateOpenCodeAcpSessionUpdate", () => {
  test("streams assistant chunks without exposing thought chunks", () => {
    const state = createOpenCodeActivityState("session-1", {
      emitUserMessages: false,
      userMessagesStartTurns: false,
    });
    const turnId = "00000000-0000-4000-8000-000000000001";
    const started = startOpenCodeTurn(state, turnId);
    assert.equal(started.length, 2);

    const thought = translateOpenCodeAcpSessionUpdate(state, {
      sessionId: "session-1",
      update: {
        sessionUpdate: "agent_thought_chunk",
        messageId: "message-1",
        content: { type: "text", text: "internal reasoning" },
      },
    });
    const assistant = translateOpenCodeAcpSessionUpdate(state, {
      sessionId: "session-1",
      update: {
        sessionUpdate: "agent_message_chunk",
        messageId: "message-1",
        content: { type: "text", text: "hello" },
      },
    });

    assert.deepEqual(thought, []);
    assert.equal(assistant[0]?.type, "timeline_item");
    if (assistant[0]?.type === "timeline_item") {
      assert.equal(assistant[0].identity?.providerSessionId, "session-1");
      assert.equal(assistant[0].identity?.itemKey, "message-1");
    }
    assert.deepEqual(assistant.map((activity) => withoutIdentity(activity)), [
      {
        type: "timeline_item",
        turnId,
        item: { kind: "assistant_message", text: "hello", messageId: "message-1" },
      },
    ]);
  });

  test("maps tool progress and completion", () => {
    const state = createOpenCodeActivityState("session-1", {
      emitUserMessages: false,
      userMessagesStartTurns: false,
    });
    const turnId = "00000000-0000-4000-8000-000000000002";
    startOpenCodeTurn(state, turnId);

    const running = translateOpenCodeAcpSessionUpdate(state, {
      sessionId: "session-1",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "tool-1",
        title: "bash",
        kind: "execute",
        status: "in_progress",
        rawInput: { command: "ls -a" },
      },
    });
    const completed = translateOpenCodeAcpSessionUpdate(state, {
      sessionId: "session-1",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "tool-1",
        title: "List files",
        kind: "execute",
        status: "completed",
        rawInput: { command: "ls -a" },
        rawOutput: { output: "file\n", metadata: { exit: 0 } },
      },
    });

    assert.deepEqual(running, [
      {
        type: "tool_call_started",
        turnId,
        toolCall: {
          id: "tool-1",
          family: "shell",
          providerToolName: "bash",
          title: "bash",
          input: { command: "ls -a" },
        },
      },
    ]);
    assert.deepEqual(completed, [
      {
        type: "tool_call_completed",
        turnId,
        toolCall: {
          id: "tool-1",
          family: "shell",
          providerToolName: "List files",
          title: "List files",
          input: { command: "ls -a" },
          result: { output: "file\n", metadata: { exit: 0 } },
          detail: { artifacts: [{ kind: "text", label: "List files", text: "file\n" }] },
        },
      },
    ]);
  });
});

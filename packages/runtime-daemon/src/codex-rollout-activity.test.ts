import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  createCodexRolloutTranslationState,
  finalizeCodexRolloutTranslationState,
  translateCodexRolloutLine,
} from "./codex-rollout-activity";

describe("translateCodexRolloutLine", () => {
  test("maps user messages and agent reasoning into persisted timeline activities", () => {
    const state = createCodexRolloutTranslationState();

    const userActivities = translateCodexRolloutLine(
      {
        timestamp: "2026-04-14T18:00:00.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Fix the bug" }],
        },
      },
      state,
    );

    const reasoningActivities = translateCodexRolloutLine(
      {
        timestamp: "2026-04-14T18:00:01.000Z",
        type: "event_msg",
        payload: {
          type: "agent_reasoning",
          text: "Inspecting files",
        },
      },
      state,
    );

    assert.deepEqual(userActivities, [
      {
        ts: "2026-04-14T18:00:00.000Z",
        channel: "structured_persisted",
        authority: "authoritative",
        raw: {
          timestamp: "2026-04-14T18:00:00.000Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "Fix the bug" }],
          },
        },
        activity: {
          type: "timeline_item",
          item: { kind: "user_message", text: "Fix the bug" },
        },
      },
    ]);

    assert.deepEqual(reasoningActivities, [
      {
        ts: "2026-04-14T18:00:01.000Z",
        channel: "structured_persisted",
        authority: "authoritative",
        raw: {
          timestamp: "2026-04-14T18:00:01.000Z",
          type: "event_msg",
          payload: {
            type: "agent_reasoning",
            text: "Inspecting files",
          },
        },
        activity: {
          type: "timeline_item",
          item: { kind: "reasoning", text: "Inspecting files" },
        },
      },
    ]);
  });

  test("maps exec_command calls into started and completed shell tool activities", () => {
    const state = createCodexRolloutTranslationState();

    const started = translateCodexRolloutLine(
      {
        timestamp: "2026-04-14T18:00:02.000Z",
        type: "response_item",
        payload: {
          type: "function_call",
          name: "exec_command",
          arguments: '{"cmd":"echo hello","workdir":"/workspace/demo"}',
          call_id: "call-1",
        },
      },
      state,
    );

    const completed = translateCodexRolloutLine(
      {
        timestamp: "2026-04-14T18:00:03.000Z",
        type: "response_item",
        payload: {
          type: "function_call_output",
          call_id: "call-1",
          output: "Chunk ID: abc\nWall time: 0.1 seconds\nProcess exited with code 0\nOutput:\nhello",
        },
      },
      state,
    );

    assert.equal(started[0]?.activity.type, "observation_started");
    if (started[0]?.activity.type === "observation_started") {
      assert.equal(started[0].activity.observation.kind, "command.run");
      assert.equal(started[0].activity.observation.subject?.command, "echo hello");
    }
    assert.equal(started[1]?.activity.type, "tool_call_started");
    if (started[1]?.activity.type === "tool_call_started") {
      assert.deepEqual(started[1].activity.toolCall, {
        id: "call-1",
        family: "shell",
        providerToolName: "exec_command",
        title: "Run command",
        input: { command: "echo hello" },
        detail: {
          artifacts: [
            { kind: "command", command: "echo hello", cwd: "/workspace/demo" },
          ],
        },
      });
    }

    assert.equal(completed[0]?.activity.type, "observation_completed");
    if (completed[0]?.activity.type === "observation_completed") {
      assert.equal(completed[0].activity.observation.status, "completed");
      assert.equal(completed[0].activity.observation.exitCode, 0);
    }
    assert.equal(completed[1]?.activity.type, "tool_call_completed");
    if (completed[1]?.activity.type === "tool_call_completed") {
      assert.deepEqual(completed[1].activity.toolCall.result, { exitCode: 0 });
      assert.ok(
        completed[1].activity.toolCall.detail?.artifacts.some(
          (artifact) => artifact.kind === "text" && artifact.text === "hello",
        ),
      );
    }
  });

  test("marks pending shell tools failed when a persisted Codex turn is interrupted", () => {
    const state = createCodexRolloutTranslationState();

    translateCodexRolloutLine(
      {
        timestamp: "2026-04-14T18:00:02.000Z",
        type: "response_item",
        payload: {
          type: "function_call",
          name: "exec_command",
          arguments: '{"cmd":"npm test","workdir":"/workspace/demo"}',
          call_id: "call-interrupted",
        },
      },
      state,
    );

    const interrupted = translateCodexRolloutLine(
      {
        timestamp: "2026-04-14T18:00:03.000Z",
        type: "event_msg",
        payload: {
          type: "turn_aborted",
          reason: "interrupted",
        },
      },
      state,
    );

    assert.deepEqual(interrupted.map((item) => item.activity.type), [
      "observation_failed",
      "tool_call_failed",
      "timeline_item",
    ]);
    const failedTool = interrupted.find((item) => item.activity.type === "tool_call_failed");
    assert.ok(failedTool);
    if (failedTool.activity.type === "tool_call_failed") {
      assert.equal(failedTool.activity.toolCallId, "call-interrupted");
      assert.match(failedTool.activity.error, /interrupted/i);
    }
  });

  test("finalizes unterminated pending shell tools at persisted history EOF", () => {
    const state = createCodexRolloutTranslationState();

    translateCodexRolloutLine(
      {
        timestamp: "2026-04-14T18:00:02.000Z",
        type: "response_item",
        payload: {
          type: "function_call",
          name: "exec_command",
          arguments: '{"cmd":"npm run dev:daemon","workdir":"/workspace/demo"}',
          call_id: "call-eof",
        },
      },
      state,
    );

    const finalized = finalizeCodexRolloutTranslationState(state, {
      timestamp: "2026-04-14T18:00:04.000Z",
    });

    assert.deepEqual(finalized.map((item) => item.activity.type), [
      "observation_failed",
      "tool_call_failed",
      "timeline_item",
    ]);
    assert.equal(state.pendingToolCalls.size, 0);
    const system = finalized.find((item) => item.activity.type === "timeline_item");
    assert.ok(system);
    if (system.activity.type === "timeline_item") {
      assert.deepEqual(system.activity.item, {
        kind: "system",
        text: "Conversation interrupted before this tool completed.",
      });
    }
  });

  test("supports older shell command formats", () => {
    const state = createCodexRolloutTranslationState();
    const started = translateCodexRolloutLine(
      {
        timestamp: "2026-04-14T18:00:02.000Z",
        type: "response_item",
        payload: {
          type: "function_call",
          name: "shell",
          arguments: '{"command":["bash","-lc","ls -la"],"workdir":"/workspace/demo"}',
          call_id: "call-shell",
        },
      },
      state,
    );

    assert.equal(started[0]?.activity.type, "observation_started");
    if (started[0]?.activity.type === "observation_started") {
      assert.equal(started[0].activity.observation.kind, "file.list");
    }
    assert.deepEqual(started[1]?.activity, {
      type: "tool_call_started",
      toolCall: {
        id: "call-shell",
        family: "search",
        providerToolName: "shell",
        title: "List files",
        input: { command: "ls -la" },
        detail: {
          artifacts: [{ kind: "command", command: "ls -la", cwd: "/workspace/demo" }],
        },
      },
    });
  });

  test("maps apply_patch custom tool calls and success outputs", () => {
    const state = createCodexRolloutTranslationState();
    const started = translateCodexRolloutLine(
      {
        timestamp: "2026-04-14T18:00:05.000Z",
        type: "response_item",
        payload: {
          type: "custom_tool_call",
          status: "completed",
          call_id: "patch-1",
          name: "apply_patch",
          input:
            "*** Begin Patch\n*** Update File: /tmp/repo/src/demo.ts\n@@\n-old\n+new\n*** End Patch",
        },
      },
      state,
    );
    const completed = translateCodexRolloutLine(
      {
        timestamp: "2026-04-14T18:00:06.000Z",
        type: "response_item",
        payload: {
          type: "custom_tool_call_output",
          call_id: "patch-1",
          output:
            '{"output":"Success. Updated the following files:\\nM /tmp/repo/src/demo.ts\\n","metadata":{"exit_code":0,"duration_seconds":0.0}}',
        },
      },
      state,
    );

    assert.equal(started[0]?.activity.type, "observation_started");
    if (started[0]?.activity.type === "observation_started") {
      assert.equal(started[0].activity.observation.kind, "patch.apply");
    }
    assert.equal(started[1]?.activity.type, "tool_call_started");
    if (started[1]?.activity.type === "tool_call_started") {
      assert.equal(started[1].activity.toolCall.family, "patch");
      assert.equal(started[1].activity.toolCall.providerToolName, "apply_patch");
    }

    assert.equal(completed[0]?.activity.type, "observation_completed");
    if (completed[0]?.activity.type === "observation_completed") {
      assert.equal(completed[0].activity.observation.kind, "patch.apply");
      assert.equal(completed[0].activity.observation.status, "completed");
    }
    assert.equal(completed[1]?.activity.type, "tool_call_completed");
    if (completed[1]?.activity.type === "tool_call_completed") {
      assert.equal(completed[1].activity.toolCall.family, "patch");
      assert.deepEqual(completed[1].activity.toolCall.result, { exitCode: 0 });
      assert.ok(
        completed[1].activity.toolCall.detail?.artifacts.some(
          (artifact) => artifact.kind === "file_refs",
        ),
      );
    }
  });

  test("maps failed custom tool outputs into tool_call_failed", () => {
    const state = createCodexRolloutTranslationState();
    translateCodexRolloutLine(
      {
        timestamp: "2026-04-14T18:00:05.000Z",
        type: "response_item",
        payload: {
          type: "custom_tool_call",
          status: "completed",
          call_id: "patch-fail",
          name: "apply_patch",
          input: "*** Begin Patch\n*** Update File: /tmp/repo/src/demo.ts\n*** End Patch",
        },
      },
      state,
    );
    const failed = translateCodexRolloutLine(
      {
        timestamp: "2026-04-14T18:00:06.000Z",
        type: "response_item",
        payload: {
          type: "custom_tool_call_output",
          call_id: "patch-fail",
          output: "apply_patch verification failed: bad hunk",
        },
      },
      state,
    );

    assert.equal(failed[0]?.activity.type, "observation_failed");
    if (failed[0]?.activity.type === "observation_failed") {
      assert.equal(failed[0].activity.observation.kind, "patch.apply");
      assert.equal(failed[0].activity.error, "apply_patch verification failed: bad hunk");
    }
    assert.equal(failed[1]?.activity.type, "tool_call_failed");
    if (failed[1]?.activity.type === "tool_call_failed") {
      assert.equal(failed[1].activity.toolCallId, "patch-fail");
      assert.equal(failed[1].activity.error, "apply_patch verification failed: bad hunk");
    }
  });

  test("maps agent_message and reasoning response items into timeline activities", () => {
    const state = createCodexRolloutTranslationState();
    const agentMessage = translateCodexRolloutLine(
      {
        timestamp: "2026-04-14T18:00:07.000Z",
        type: "event_msg",
        payload: {
          type: "agent_message",
          message: "Applied the patch successfully.",
        },
      },
      state,
    );
    const reasoning = translateCodexRolloutLine(
      {
        timestamp: "2026-04-14T18:00:08.000Z",
        type: "response_item",
        payload: {
          type: "reasoning",
          summary: [{ type: "summary_text", text: "Reviewing the patch output" }],
        },
      },
      state,
    );

    assert.deepEqual(agentMessage[0]?.activity, {
      type: "timeline_item",
      item: { kind: "assistant_message", text: "Applied the patch successfully." },
    });
    assert.deepEqual(reasoning[0]?.activity, {
      type: "timeline_item",
      item: { kind: "reasoning", text: "Reviewing the patch output" },
    });
  });

  test("deduplicates persisted agent_message and assistant response_item with matching text", () => {
    const state = createCodexRolloutTranslationState();
    const eventMsg = translateCodexRolloutLine(
      {
        timestamp: "2026-04-18T00:00:00.000Z",
        type: "event_msg",
        payload: {
          type: "agent_message",
          message: "Same answer",
        },
      },
      state,
    );
    const responseItem = translateCodexRolloutLine(
      {
        timestamp: "2026-04-18T00:00:00.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Same answer" }],
        },
      },
      state,
    );

    assert.equal(eventMsg.length, 1);
    assert.equal(responseItem.length, 0);
  });

  test("ignores persisted noise events that should not surface in history feed", () => {
    const state = createCodexRolloutTranslationState();

    const taskStarted = translateCodexRolloutLine(
      {
        timestamp: "2026-04-14T18:00:09.000Z",
        type: "event_msg",
        payload: {
          type: "task_started",
          turn_id: "turn-1",
        },
      },
      state,
    );
    const tokenCount = translateCodexRolloutLine(
      {
        timestamp: "2026-04-14T18:00:10.000Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          info: null,
        },
      },
      state,
    );
    const turnAborted = translateCodexRolloutLine(
      {
        timestamp: "2026-04-14T18:00:10.250Z",
        type: "event_msg",
        payload: {
          type: "turn_aborted",
          turn_id: "turn-1",
          reason: "interrupted",
        },
      },
      state,
    );
    const execCommandEnd = translateCodexRolloutLine(
      {
        timestamp: "2026-04-14T18:00:10.500Z",
        type: "event_msg",
        payload: {
          type: "exec_command_end",
          call_id: "call-1",
          exit_code: 0,
        },
      },
      state,
    );
    const patchApplyEnd = translateCodexRolloutLine(
      {
        timestamp: "2026-04-14T18:00:10.750Z",
        type: "event_msg",
        payload: {
          type: "patch_apply_end",
          success: true,
        },
      },
      state,
    );
    const developerMessage = translateCodexRolloutLine(
      {
        timestamp: "2026-04-14T18:00:11.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "developer",
          content: [{ type: "input_text", text: "internal instructions" }],
        },
      },
      state,
    );
    const encryptedReasoning = translateCodexRolloutLine(
      {
        timestamp: "2026-04-14T18:00:12.000Z",
        type: "response_item",
        payload: {
          type: "reasoning",
          summary: [],
          content: null,
          encrypted_content: "opaque",
        },
      },
      state,
    );

    assert.deepEqual(taskStarted, []);
    assert.deepEqual(tokenCount, []);
    assert.deepEqual(turnAborted, []);
    assert.deepEqual(execCommandEnd, []);
    assert.deepEqual(patchApplyEnd, []);
    assert.deepEqual(developerMessage, []);
    assert.deepEqual(encryptedReasoning, []);
  });

  test("ignores bootstrap user prompts that carry internal instructions and environment context", () => {
    const state = createCodexRolloutTranslationState();
    const bootstrap = translateCodexRolloutLine(
      {
        timestamp: "2026-04-14T18:00:13.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [
            {
              type: "input_text",
              text:
                "# AGENTS.md instructions for /workspace/demo\n\n<INSTRUCTIONS>\ninternal\n</INSTRUCTIONS>\n<environment_context>\n  <cwd>/workspace/demo</cwd>\n</environment_context>",
            },
          ],
        },
      },
      state,
    );

    assert.deepEqual(bootstrap, []);
  });

  test("strips turn_aborted contextual fragments from user messages", () => {
    const state = createCodexRolloutTranslationState();

    const activities = translateCodexRolloutLine(
      {
        timestamp: "2026-04-24T06:10:00.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [
            {
              type: "input_text",
              text:
                "周几?<turn_aborted>\nThe user interrupted the previous turn on purpose.\n</turn_aborted>",
            },
          ],
        },
      },
      state,
    );

    assert.deepEqual(activities.map((item) => item.activity), [
      {
        type: "timeline_item",
        item: { kind: "user_message", text: "周几?" },
      },
    ]);
  });

  test("preserves markdown structure while stripping contextual fragments from assistant messages", () => {
    const state = createCodexRolloutTranslationState();
    const markdown = "会涉及抽象。\n\n- AgentAdapter\n- EventModel\n\n```text\nCouncil\n```";

    const activities = translateCodexRolloutLine(
      {
        timestamp: "2026-04-24T06:11:00.000Z",
        type: "response_item",
        payload: {
          id: "assistant-1",
          type: "message",
          role: "assistant",
          content: [
            {
              type: "output_text",
              text: `${markdown}\n<turn_aborted>hidden</turn_aborted>`,
            },
          ],
        },
      },
      state,
    );

    assert.deepEqual(activities.map((item) => item.activity), [
      {
        type: "message_part_added",
        part: {
          messageId: "assistant-1",
          partId: "assistant-1",
          kind: "text",
          text: markdown,
        },
      },
      {
        type: "timeline_item",
        item: { kind: "assistant_message", text: markdown },
      },
    ]);
  });
});

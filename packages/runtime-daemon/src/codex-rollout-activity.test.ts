import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  createCodexRolloutTranslationState,
  finalizeCodexRolloutTranslationState,
  translateCodexRolloutLine,
} from "./codex-rollout-activity";
import { createCodexTimelineIdentity } from "./codex-timeline-identity";

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

  test("attaches canonical timeline identity to rollout transcript items", () => {
    const state = createCodexRolloutTranslationState({ providerSessionId: "session-1" });

    translateCodexRolloutLine(
      {
        timestamp: "2026-04-14T18:00:00.000Z",
        type: "event_msg",
        payload: {
          type: "task_started",
          turn_id: "turn-1",
        },
      },
      state,
    );
    const user = translateCodexRolloutLine(
      {
        timestamp: "2026-04-14T18:00:01.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "你好" }],
        },
      },
      state,
    ).find((item) => item.activity.type === "timeline_item")?.activity;
    const reasoning = translateCodexRolloutLine(
      {
        timestamp: "2026-04-14T18:00:02.000Z",
        type: "event_msg",
        payload: {
          type: "agent_reasoning",
          text: "Thinking",
        },
      },
      state,
    ).find((item) => item.activity.type === "timeline_item")?.activity;
    const assistant = translateCodexRolloutLine(
      {
        timestamp: "2026-04-14T18:00:03.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "你好。" }],
        },
      },
      state,
    ).find((item) => item.activity.type === "timeline_item")?.activity;

    assert.equal(user?.type, "timeline_item");
    assert.equal(reasoning?.type, "timeline_item");
    assert.equal(assistant?.type, "timeline_item");
    if (user?.type === "timeline_item" && reasoning?.type === "timeline_item" && assistant?.type === "timeline_item") {
      assert.equal(
        user.identity?.canonicalItemId,
        createCodexTimelineIdentity({
          providerSessionId: "session-1",
          turnId: "turn-1",
          itemKind: "user_message",
          itemIndex: 0,
          origin: "live",
        }).canonicalItemId,
      );
      assert.equal(
        reasoning.identity?.canonicalItemId,
        createCodexTimelineIdentity({
          providerSessionId: "session-1",
          turnId: "turn-1",
          itemKind: "reasoning",
          itemIndex: 1,
          origin: "live",
        }).canonicalItemId,
      );
      assert.equal(
        assistant.identity?.canonicalItemId,
        createCodexTimelineIdentity({
          providerSessionId: "session-1",
          turnId: "turn-1",
          itemKind: "assistant_message",
          itemIndex: 2,
          origin: "live",
        }).canonicalItemId,
      );
    }
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

  test("maps nonzero exec_command exits as failed observations without duplicating output as error", () => {
    const state = createCodexRolloutTranslationState();

    translateCodexRolloutLine(
      {
        timestamp: "2026-04-14T18:00:02.000Z",
        type: "response_item",
        payload: {
          type: "function_call",
          name: "exec_command",
          arguments: '{"cmd":"cargo test","workdir":"/workspace/demo"}',
          call_id: "call-fail",
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
          call_id: "call-fail",
          output: "Chunk ID: abc\nWall time: 0.1 seconds\nProcess exited with code 101\nOutput:\ntest failed",
        },
      },
      state,
    );

    assert.equal(completed[0]?.activity.type, "observation_failed");
    if (completed[0]?.activity.type === "observation_failed") {
      assert.equal(completed[0].activity.observation.status, "failed");
      assert.equal(completed[0].activity.observation.exitCode, 101);
      assert.equal(completed[0].activity.error, undefined);
    }
    assert.equal(completed[1]?.activity.type, "tool_call_completed");
    if (completed[1]?.activity.type === "tool_call_completed") {
      assert.deepEqual(completed[1].activity.toolCall.result, { exitCode: 101 });
    }
  });

  test("treats empty search exit 1 as no matches in persisted rollout history", () => {
    const state = createCodexRolloutTranslationState();

    translateCodexRolloutLine(
      {
        timestamp: "2026-04-14T18:00:02.000Z",
        type: "response_item",
        payload: {
          type: "function_call",
          name: "exec_command",
          arguments: '{"cmd":"rg \\"missing-symbol\\" src -n","workdir":"/workspace/demo"}',
          call_id: "call-search-empty",
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
          call_id: "call-search-empty",
          output:
            "Chunk ID: abc\nWall time: 0.1 seconds\nProcess exited with code 1\nOriginal token count: 0\nOutput:\n",
        },
      },
      state,
    );

    assert.equal(completed[0]?.activity.type, "observation_completed");
    if (completed[0]?.activity.type === "observation_completed") {
      assert.equal(completed[0].activity.observation.status, "completed");
      assert.equal(completed[0].activity.observation.kind, "file.search");
      assert.equal(completed[0].activity.observation.summary, "No matches.");
      assert.equal(completed[0].activity.observation.exitCode, undefined);
      assert.deepEqual(completed[0].activity.observation.metrics, {
        rawExitCode: 1,
        semanticStatus: "search_no_matches",
      });
    }
    assert.equal(completed[1]?.activity.type, "tool_call_completed");
    if (completed[1]?.activity.type === "tool_call_completed") {
      assert.deepEqual(completed[1].activity.toolCall.result, { exitCode: 1 });
      assert.equal(completed[1].activity.toolCall.summary, "No matches.");
    }
  });

  test("merges write_stdin polling output into the running exec_command tool call", () => {
    const state = createCodexRolloutTranslationState();

    translateCodexRolloutLine(
      {
        timestamp: "2026-04-14T18:00:02.000Z",
        type: "response_item",
        payload: {
          type: "function_call",
          name: "exec_command",
          arguments: '{"cmd":"npm test","workdir":"/workspace/demo"}',
          call_id: "call-exec",
        },
      },
      state,
    );
    const running = translateCodexRolloutLine(
      {
        timestamp: "2026-04-14T18:00:03.000Z",
        type: "response_item",
        payload: {
          type: "function_call_output",
          call_id: "call-exec",
          output: "Chunk ID: abc\nWall time: 0.1 seconds\nProcess running with session ID 7144",
        },
      },
      state,
    );

    assert.deepEqual(
      running.map((item) => item.activity.type),
      ["observation_completed", "tool_call_completed"],
    );
    const runningTool = running.find((item) => item.activity.type === "tool_call_completed")?.activity;
    assert.equal(runningTool?.type, "tool_call_completed");
    if (runningTool?.type === "tool_call_completed") {
      assert.equal(runningTool.toolCall.id, "call-exec");
      assert.deepEqual(runningTool.toolCall.result, { sessionId: 7144 });
      assert.equal(runningTool.toolCall.summary, "Process running with session ID 7144.");
    }

    const pollStarted = translateCodexRolloutLine(
      {
        timestamp: "2026-04-14T18:00:04.000Z",
        type: "response_item",
        payload: {
          type: "function_call",
          name: "write_stdin",
          arguments: '{"session_id":"7144","chars":"","yield_time_ms":1000}',
          call_id: "call-poll",
        },
      },
      state,
    );
    const pollOutput = translateCodexRolloutLine(
      {
        timestamp: "2026-04-14T18:00:05.000Z",
        type: "response_item",
        payload: {
          type: "function_call_output",
          call_id: "call-poll",
          output: "Chunk ID: def\nWall time: 1.0 seconds\nOutput:\nfirst chunk",
        },
      },
      state,
    );

    assert.deepEqual(pollStarted, []);
    assert.deepEqual(
      pollOutput.map((item) => item.activity.type),
      ["tool_call_delta"],
    );
    const delta = pollOutput[0]?.activity;
    assert.equal(delta?.type, "tool_call_delta");
    if (delta?.type === "tool_call_delta") {
      assert.equal(delta.toolCallId, "call-exec");
      assert.deepEqual(delta.detail.artifacts, [
        { kind: "text", label: "stdout", text: "first chunk" },
      ]);
    }
  });

  test("completes write_stdin terminal polling on the original exec_command tool id", () => {
    const state = createCodexRolloutTranslationState();

    translateCodexRolloutLine(
      {
        timestamp: "2026-04-14T18:00:02.000Z",
        type: "response_item",
        payload: {
          type: "function_call",
          name: "exec_command",
          arguments: '{"cmd":"npm test","workdir":"/workspace/demo"}',
          call_id: "call-exec",
        },
      },
      state,
    );
    translateCodexRolloutLine(
      {
        timestamp: "2026-04-14T18:00:03.000Z",
        type: "response_item",
        payload: {
          type: "function_call_output",
          call_id: "call-exec",
          output: "Chunk ID: abc\nWall time: 0.1 seconds\nProcess running with session ID 7144",
        },
      },
      state,
    );
    translateCodexRolloutLine(
      {
        timestamp: "2026-04-14T18:00:04.000Z",
        type: "response_item",
        payload: {
          type: "function_call",
          name: "write_stdin",
          arguments: '{"session_id":7144,"chars":"","yield_time_ms":1000}',
          call_id: "call-poll-1",
        },
      },
      state,
    );
    translateCodexRolloutLine(
      {
        timestamp: "2026-04-14T18:00:05.000Z",
        type: "response_item",
        payload: {
          type: "function_call_output",
          call_id: "call-poll-1",
          output: "Chunk ID: def\nWall time: 1.0 seconds\nOutput:\nfirst chunk",
        },
      },
      state,
    );
    translateCodexRolloutLine(
      {
        timestamp: "2026-04-14T18:00:06.000Z",
        type: "response_item",
        payload: {
          type: "function_call",
          name: "write_stdin",
          arguments: '{"session_id":7144,"chars":"","yield_time_ms":1000}',
          call_id: "call-poll-2",
        },
      },
      state,
    );
    const completed = translateCodexRolloutLine(
      {
        timestamp: "2026-04-14T18:00:07.000Z",
        type: "response_item",
        payload: {
          type: "function_call_output",
          call_id: "call-poll-2",
          output: "Chunk ID: ghi\nWall time: 1.0 seconds\nProcess exited with code 0\nOutput:\nsecond chunk",
        },
      },
      state,
    );

    assert.deepEqual(
      completed.map((item) => item.activity.type),
      ["observation_completed", "tool_call_completed"],
    );
    const tool = completed.find((item) => item.activity.type === "tool_call_completed")?.activity;
    assert.equal(tool?.type, "tool_call_completed");
    if (tool?.type === "tool_call_completed") {
      assert.equal(tool.toolCall.id, "call-exec");
      assert.deepEqual(tool.toolCall.result, { sessionId: 7144, exitCode: 0 });
      assert.deepEqual(
        tool.toolCall.detail?.artifacts.filter((artifact) => artifact.kind === "text"),
        [{ kind: "text", label: "stdout", text: "first chunksecond chunk" }],
      );
    }
  });

  test("falls back to a terminal session tool id when write_stdin history starts mid-process", () => {
    const state = createCodexRolloutTranslationState();

    const pollStarted = translateCodexRolloutLine(
      {
        timestamp: "2026-04-14T18:00:04.000Z",
        type: "response_item",
        payload: {
          type: "function_call",
          name: "write_stdin",
          arguments: '{"session_id":7144,"chars":"","yield_time_ms":1000}',
          call_id: "call-poll",
        },
      },
      state,
    );
    const pollOutput = translateCodexRolloutLine(
      {
        timestamp: "2026-04-14T18:00:05.000Z",
        type: "response_item",
        payload: {
          type: "function_call_output",
          call_id: "call-poll",
          output: "Chunk ID: def\nWall time: 1.0 seconds\nOutput:\npartial output",
        },
      },
      state,
    );

    assert.deepEqual(pollStarted, []);
    assert.deepEqual(
      pollOutput.map((item) => item.activity.type),
      ["tool_call_started", "tool_call_delta"],
    );
    const started = pollOutput[0]?.activity;
    const delta = pollOutput[1]?.activity;
    assert.equal(started?.type, "tool_call_started");
    assert.equal(delta?.type, "tool_call_delta");
    if (started?.type === "tool_call_started" && delta?.type === "tool_call_delta") {
      assert.equal(started.toolCall.id, "terminal-session-7144");
      assert.equal(started.toolCall.title, "Terminal session");
      assert.equal(delta.toolCallId, "terminal-session-7144");
    }
  });

  test("completes generic tools that return non-text output", () => {
    const state = createCodexRolloutTranslationState();

    translateCodexRolloutLine(
      {
        timestamp: "2026-04-14T18:00:02.000Z",
        type: "response_item",
        payload: {
          type: "function_call",
          name: "view_image",
          arguments: '{"path":"/tmp/screenshot.png"}',
          call_id: "call-image",
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
          call_id: "call-image",
          output: [{ type: "input_image", image_url: "data:image/png;base64,abc" }],
        },
      },
      state,
    );

    assert.deepEqual(completed.map((item) => item.activity.type), ["tool_call_completed"]);
    const tool = completed[0]?.activity;
    assert.equal(tool?.type, "tool_call_completed");
    if (tool?.type === "tool_call_completed") {
      assert.equal(tool.toolCall.id, "call-image");
      assert.equal(tool.toolCall.summary, "Tool returned non-text output.");
    }
  });

  test("does not fail still-running terminal sessions at persisted history EOF", () => {
    const state = createCodexRolloutTranslationState();

    translateCodexRolloutLine(
      {
        timestamp: "2026-04-14T18:00:02.000Z",
        type: "response_item",
        payload: {
          type: "function_call",
          name: "exec_command",
          arguments: '{"cmd":"npm test","workdir":"/workspace/demo"}',
          call_id: "call-exec",
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
          call_id: "call-exec",
          output: "Chunk ID: abc\nWall time: 0.1 seconds\nProcess running with session ID 7144",
        },
      },
      state,
    );

    assert.deepEqual(completed.map((item) => item.activity.type), [
      "observation_completed",
      "tool_call_completed",
    ]);
    const completedTool = completed.find((item) => item.activity.type === "tool_call_completed");
    assert.ok(completedTool);
    if (completedTool.activity.type === "tool_call_completed") {
      assert.equal(completedTool.activity.toolCall.id, "call-exec");
      assert.deepEqual(completedTool.activity.toolCall.result, { sessionId: 7144 });
      assert.match(completedTool.activity.toolCall.summary ?? "", /Process running/);
    }

    const finalized = finalizeCodexRolloutTranslationState(state, {
      timestamp: "2026-04-14T18:00:04.000Z",
    });

    assert.deepEqual(finalized, []);
    assert.equal(state.terminalSessions.size, 0);
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
          turn_id: "turn-interrupted",
          reason: "interrupted",
        },
      },
      state,
    );

    assert.deepEqual(interrupted.map((item) => item.activity.type), [
      "turn_canceled",
      "observation_failed",
      "tool_call_failed",
      "timeline_item",
    ]);
    const canceledTurn = interrupted.find((item) => item.activity.type === "turn_canceled");
    assert.ok(canceledTurn);
    if (canceledTurn.activity.type === "turn_canceled") {
      assert.equal(canceledTurn.activity.turnId, "turn-interrupted");
      assert.equal(canceledTurn.activity.reason, "interrupted");
    }
    const failedTool = interrupted.find((item) => item.activity.type === "tool_call_failed");
    assert.ok(failedTool);
    if (failedTool.activity.type === "tool_call_failed") {
      assert.equal(failedTool.activity.toolCallId, "call-interrupted");
      assert.match(failedTool.activity.error, /interrupted/i);
    }
  });

  test("emits a visible canceled turn activity when Codex aborts a plain chat turn", () => {
    const state = createCodexRolloutTranslationState({ providerSessionId: "thread-1" });

    translateCodexRolloutLine(
      {
        timestamp: "2026-04-14T18:00:01.000Z",
        type: "event_msg",
        payload: {
          type: "task_started",
          turn_id: "turn-plain",
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
          turn_id: "turn-plain",
          reason: "interrupted",
        },
      },
      state,
    );

    assert.deepEqual(interrupted.map((item) => item.activity.type), ["turn_canceled"]);
    const canceledTurn = interrupted[0];
    assert.ok(canceledTurn);
    if (canceledTurn.activity.type === "turn_canceled") {
      assert.equal(canceledTurn.activity.turnId, "turn-plain");
      assert.equal(canceledTurn.activity.reason, "interrupted");
      assert.equal(canceledTurn.activity.identity?.providerSessionId, "thread-1");
      assert.equal(canceledTurn.activity.identity?.turnKey, "turn:turn-plain");
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

  test("maps patch_apply_end event messages into completed patch tools", () => {
    const state = createCodexRolloutTranslationState();

    translateCodexRolloutLine(
      {
        timestamp: "2026-04-14T18:00:02.000Z",
        type: "response_item",
        payload: {
          type: "custom_tool_call",
          name: "apply_patch",
          call_id: "call-patch-end",
          input: "*** Begin Patch\n*** Update File: /workspace/demo.txt\n@@\n-old\n+new\n*** End Patch\n",
        },
      },
      state,
    );
    const completed = translateCodexRolloutLine(
      {
        timestamp: "2026-04-14T18:00:03.000Z",
        type: "event_msg",
        payload: {
          type: "patch_apply_end",
          call_id: "call-patch-end",
          success: true,
          stdout: "Success. Updated the following files:\nM /workspace/demo.txt\n",
          stderr: "",
          changes: {
            "/workspace/demo.txt": { type: "update" },
          },
        },
      },
      state,
    );
    const duplicateOutput = translateCodexRolloutLine(
      {
        timestamp: "2026-04-14T18:00:04.000Z",
        type: "response_item",
        payload: {
          type: "custom_tool_call_output",
          call_id: "call-patch-end",
          output: "Exit code: 0\nWall time: 0 seconds\nOutput:\nSuccess.",
        },
      },
      state,
    );

    assert.deepEqual(completed.map((item) => item.activity.type), [
      "observation_completed",
      "tool_call_completed",
    ]);
    assert.deepEqual(duplicateOutput, []);
  });

  test("maps raw apply_patch process success outputs into completed calls", () => {
    const state = createCodexRolloutTranslationState();
    translateCodexRolloutLine(
      {
        timestamp: "2026-05-27T09:00:05.000Z",
        type: "response_item",
        payload: {
          type: "custom_tool_call",
          status: "completed",
          call_id: "patch-raw-success",
          name: "apply_patch",
          input:
            "*** Begin Patch\n*** Update File: /tmp/repo/docs/demo.md\n@@\n-old\n+new\n*** End Patch",
        },
      },
      state,
    );

    const completed = translateCodexRolloutLine(
      {
        timestamp: "2026-05-27T09:00:06.000Z",
        type: "response_item",
        payload: {
          type: "custom_tool_call_output",
          call_id: "patch-raw-success",
          output:
            "Exit code: 0\nWall time: 0 seconds\nOutput:\nSuccess. Updated the following files:\nM /tmp/repo/docs/demo.md\n",
        },
      },
      state,
    );

    assert.equal(completed[0]?.activity.type, "observation_completed");
    if (completed[0]?.activity.type === "observation_completed") {
      assert.equal(completed[0].activity.observation.kind, "patch.apply");
      assert.equal(completed[0].activity.observation.status, "completed");
      assert.equal(completed[0].activity.observation.exitCode, 0);
      assert.ok(
        completed[0].activity.observation.detail?.artifacts.some(
          (artifact) =>
            artifact.kind === "text" &&
            artifact.label === "stdout" &&
            artifact.text.includes("Success. Updated the following files:"),
        ),
      );
    }

    assert.equal(completed[1]?.activity.type, "tool_call_completed");
    if (completed[1]?.activity.type === "tool_call_completed") {
      assert.equal(completed[1].activity.toolCall.family, "patch");
      assert.deepEqual(completed[1].activity.toolCall.result, { exitCode: 0 });
      assert.ok(
        completed[1].activity.toolCall.detail?.artifacts.some(
          (artifact) =>
            artifact.kind === "file_refs" &&
            artifact.files.includes("/tmp/repo/docs/demo.md"),
        ),
      );
    }
  });

  test("maps raw apply_patch process failures into failed calls", () => {
    const state = createCodexRolloutTranslationState();
    translateCodexRolloutLine(
      {
        timestamp: "2026-05-27T09:01:05.000Z",
        type: "response_item",
        payload: {
          type: "custom_tool_call",
          status: "completed",
          call_id: "patch-raw-fail",
          name: "apply_patch",
          input: "*** Begin Patch\n*** Update File: /tmp/repo/src/demo.ts\n*** End Patch",
        },
      },
      state,
    );

    const failed = translateCodexRolloutLine(
      {
        timestamp: "2026-05-27T09:01:06.000Z",
        type: "response_item",
        payload: {
          type: "custom_tool_call_output",
          call_id: "patch-raw-fail",
          output:
            "Exit code: 1\nWall time: 0 seconds\nOutput:\napply_patch verification failed: bad hunk\n",
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
      assert.equal(failed[1].activity.toolCallId, "patch-raw-fail");
      assert.equal(failed[1].activity.error, "apply_patch verification failed: bad hunk");
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

  test("attaches Codex turn model metadata to persisted assistant replies", () => {
    const state = createCodexRolloutTranslationState();
    translateCodexRolloutLine(
      {
        timestamp: "2026-04-14T18:00:06.000Z",
        type: "turn_context",
        payload: {
          turn_id: "turn-model-1",
          model: "gpt-5.5",
          effort: "xhigh",
        },
      },
      state,
    );

    const agentMessage = translateCodexRolloutLine(
      {
        timestamp: "2026-04-14T18:00:07.000Z",
        type: "event_msg",
        payload: {
          type: "agent_message",
          message: "Model-aware answer.",
        },
      },
      state,
    );

    assert.equal(agentMessage[0]?.activity.type, "timeline_item");
    if (agentMessage[0]?.activity.type === "timeline_item") {
      assert.deepEqual(agentMessage[0].activity.item, {
        kind: "assistant_message",
        text: "Model-aware answer.",
        runtimeModel: {
          modelId: "gpt-5.5",
          optionId: "xhigh",
          optionKind: "reasoning_effort",
          source: "native",
        },
      });
    }
  });

  test("deduplicates persisted agent_message and assistant response_item with matching text", () => {
    const state = createCodexRolloutTranslationState();
    translateCodexRolloutLine(
      {
        timestamp: "2026-04-18T00:00:00.000Z",
        type: "event_msg",
        payload: {
          type: "task_started",
          turn_id: "turn-duplicate",
        },
      },
      state,
    );
    const eventMsg = translateCodexRolloutLine(
      {
        timestamp: "2026-04-18T00:00:01.000Z",
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
        timestamp: "2026-04-18T00:00:01.001Z",
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

  test("deduplicates persisted assistant text when a frozen history window omits task_started", () => {
    const state = createCodexRolloutTranslationState();
    const eventMsg = translateCodexRolloutLine(
      {
        timestamp: "2026-04-18T00:00:01.000Z",
        type: "event_msg",
        payload: {
          type: "agent_message",
          message: "Windowed answer",
        },
      },
      state,
    );
    const responseItem = translateCodexRolloutLine(
      {
        timestamp: "2026-04-18T00:00:01.001Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Windowed answer" }],
        },
      },
      state,
    );

    assert.equal(eventMsg.length, 1);
    assert.equal(responseItem.length, 0);
  });

  test("keeps repeated unscoped assistant text when a user message separates turns", () => {
    const state = createCodexRolloutTranslationState();
    const first = translateCodexRolloutLine(
      {
        timestamp: "2026-04-18T00:00:01.000Z",
        type: "event_msg",
        payload: {
          type: "agent_message",
          message: "Same unscoped answer",
        },
      },
      state,
    );
    const user = translateCodexRolloutLine(
      {
        timestamp: "2026-04-18T00:00:02.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "continue" }],
        },
      },
      state,
    );
    const second = translateCodexRolloutLine(
      {
        timestamp: "2026-04-18T00:00:03.000Z",
        type: "event_msg",
        payload: {
          type: "agent_message",
          message: "Same unscoped answer",
        },
      },
      state,
    );

    assert.equal(first.length, 1);
    assert.equal(user.length, 1);
    assert.equal(second.length, 1);
  });

  test("keeps matching assistant text from separate Codex turns", () => {
    const state = createCodexRolloutTranslationState();
    translateCodexRolloutLine(
      {
        timestamp: "2026-04-18T00:01:00.000Z",
        type: "event_msg",
        payload: {
          type: "task_started",
          turn_id: "turn-one",
        },
      },
      state,
    );
    const first = translateCodexRolloutLine(
      {
        timestamp: "2026-04-18T00:01:01.000Z",
        type: "event_msg",
        payload: {
          type: "agent_message",
          message: "Same answer",
        },
      },
      state,
    );
    translateCodexRolloutLine(
      {
        timestamp: "2026-04-18T00:01:02.000Z",
        type: "event_msg",
        payload: {
          type: "task_complete",
          turn_id: "turn-one",
        },
      },
      state,
    );
    translateCodexRolloutLine(
      {
        timestamp: "2026-04-18T00:02:00.000Z",
        type: "event_msg",
        payload: {
          type: "task_started",
          turn_id: "turn-two",
        },
      },
      state,
    );
    const second = translateCodexRolloutLine(
      {
        timestamp: "2026-04-18T00:02:01.000Z",
        type: "event_msg",
        payload: {
          type: "agent_message",
          message: "Same answer",
        },
      },
      state,
    );

    assert.equal(first.length, 1);
    assert.equal(second.length, 1);
  });

  test("maps persisted Codex web search events into observations", () => {
    const state = createCodexRolloutTranslationState();

    const started = translateCodexRolloutLine(
      {
        timestamp: "2026-05-31T00:00:01.000Z",
        type: "event_msg",
        payload: {
          type: "web_search_begin",
          call_id: "search-1",
        },
      },
      state,
    );
    const completed = translateCodexRolloutLine(
      {
        timestamp: "2026-05-31T00:00:02.000Z",
        type: "event_msg",
        payload: {
          type: "web_search_end",
          call_id: "search-1",
          query: "codex web search events",
          action: {
            type: "search",
            query: "codex web search events",
            queries: null,
          },
        },
      },
      state,
    );

    assert.equal(started.length, 1);
    assert.equal(started[0]?.activity.type, "observation_started");
    assert.equal(started[0]?.activity.observation.kind, "web.search");
    assert.equal(started[0]?.activity.observation.status, "running");
    assert.equal(started[0]?.activity.observation.title, "Web search");
    assert.equal(completed.length, 1);
    assert.equal(completed[0]?.activity.type, "observation_completed");
    assert.equal(completed[0]?.activity.observation.id, "obs-search-1");
    assert.equal(completed[0]?.activity.observation.kind, "web.search");
    assert.equal(completed[0]?.activity.observation.status, "completed");
    assert.equal(completed[0]?.activity.observation.summary, "codex web search events");
  });

  test("maps persisted Codex web_search_call response items into observations", () => {
    const state = createCodexRolloutTranslationState();

    const search = translateCodexRolloutLine(
      {
        timestamp: "2026-06-02T14:19:49.581Z",
        type: "response_item",
        payload: {
          type: "web_search_call",
          status: "completed",
          action: {
            type: "search",
            query: "Sharpe ratio excess return risk free rate definition official",
            queries: [
              "Sharpe ratio excess return risk free rate definition official",
              "CFA Institute Sharpe ratio excess return risk free rate",
            ],
          },
        },
      },
      state,
    );
    const openPage = translateCodexRolloutLine(
      {
        timestamp: "2026-06-02T14:19:50.581Z",
        type: "response_item",
        payload: {
          type: "web_search_call",
          status: "completed",
          action: {
            type: "open_page",
            url: "https://example.com/reference",
          },
        },
      },
      state,
    );
    const failed = translateCodexRolloutLine(
      {
        timestamp: "2026-06-02T14:19:51.581Z",
        type: "response_item",
        payload: {
          type: "web_search_call",
          status: "failed",
          action: {
            type: "find_in_page",
            url: "https://example.com/reference",
            pattern: "Sharpe",
          },
        },
      },
      state,
    );

    assert.equal(search.length, 1);
    assert.equal(search[0]?.activity.type, "observation_completed");
    assert.equal(search[0]?.activity.observation.kind, "web.search");
    assert.equal(search[0]?.activity.observation.status, "completed");
    assert.equal(
      search[0]?.activity.observation.summary,
      "Sharpe ratio excess return risk free rate definition official",
    );
    assert.match(search[0]?.activity.observation.id ?? "", /^obs-web-search-[a-f0-9]{16}$/);

    assert.equal(openPage.length, 1);
    assert.equal(openPage[0]?.activity.type, "observation_completed");
    assert.equal(openPage[0]?.activity.observation.kind, "web.fetch");
    assert.equal(openPage[0]?.activity.observation.title, "Open page");
    assert.equal(openPage[0]?.activity.observation.summary, "https://example.com/reference");

    assert.equal(failed.length, 1);
    assert.equal(failed[0]?.activity.type, "observation_failed");
    assert.equal(failed[0]?.activity.observation.kind, "web.fetch");
    assert.equal(failed[0]?.activity.observation.status, "failed");
    assert.equal(failed[0]?.activity.observation.title, "Find in page");
    assert.equal(failed[0]?.activity.observation.summary, "Sharpe in https://example.com/reference");
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
    const mcpToolCallEnd = translateCodexRolloutLine(
      {
        timestamp: "2026-04-14T18:00:10.875Z",
        type: "event_msg",
        payload: {
          type: "mcp_tool_call_end",
          call_id: "call-mcp",
          invocation: {
            server: "rah_council",
            tool: "channel_wait_new",
            arguments: { council: "council-1", timeout_s: 60 },
          },
          result: { Ok: { content: [] } },
        },
      },
      state,
    );
    const contextCompacted = translateCodexRolloutLine(
      {
        timestamp: "2026-04-14T18:00:10.900Z",
        type: "event_msg",
        payload: {
          type: "context_compacted",
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
    const emptyAgentMessage = translateCodexRolloutLine(
      {
        timestamp: "2026-04-14T18:00:13.000Z",
        type: "event_msg",
        payload: {
          type: "agent_message",
          message: "",
          phase: "final_answer",
        },
      },
      state,
    );
    const emptyAssistantMessage = translateCodexRolloutLine(
      {
        timestamp: "2026-04-14T18:00:14.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "" }],
          phase: "final_answer",
        },
      },
      state,
    );

    assert.deepEqual(taskStarted, []);
    assert.deepEqual(tokenCount, []);
    assert.deepEqual(turnAborted.map((item) => item.activity.type), ["turn_canceled"]);
    assert.deepEqual(execCommandEnd, []);
    assert.deepEqual(patchApplyEnd, []);
    assert.deepEqual(mcpToolCallEnd, []);
    assert.deepEqual(contextCompacted, []);
    assert.deepEqual(developerMessage, []);
    assert.deepEqual(encryptedReasoning, []);
    assert.deepEqual(emptyAgentMessage, []);
    assert.deepEqual(emptyAssistantMessage, []);
  });

  test("hides rah_council MCP polling tool calls from Codex session history feed", () => {
    const state = createCodexRolloutTranslationState();

    const started = translateCodexRolloutLine(
      {
        timestamp: "2026-05-15T02:46:10.100Z",
        type: "response_item",
        payload: {
          type: "function_call",
          name: "channel_wait_new",
          arguments: '{"council":"council-1","since_id":975,"timeout_s":60}',
          call_id: "call-council-wait",
        },
      },
      state,
    );
    const mcpEnd = translateCodexRolloutLine(
      {
        timestamp: "2026-05-15T02:46:10.200Z",
        type: "event_msg",
        payload: {
          type: "mcp_tool_call_end",
          call_id: "call-council-wait",
          invocation: {
            server: "rah_council",
            tool: "channel_wait_new",
            arguments: { council: "council-1", since_id: 975, timeout_s: 60 },
          },
          result: {
            Ok: {
              content: [
                {
                  type: "text",
                  text: '{"ok":true,"timed_out":true}',
                },
              ],
            },
          },
        },
      },
      state,
    );
    const completed = translateCodexRolloutLine(
      {
        timestamp: "2026-05-15T02:46:10.300Z",
        type: "response_item",
        payload: {
          type: "function_call_output",
          call_id: "call-council-wait",
          output: '{"ok":true,"timed_out":true}',
        },
      },
      state,
    );
    const finalized = finalizeCodexRolloutTranslationState(state);

    assert.deepEqual(started, []);
    assert.deepEqual(mcpEnd, []);
    assert.deepEqual(completed, []);
    assert.deepEqual(finalized, []);
  });

  test("projects rah_council channel_post as a Codex assistant timeline message", () => {
    const state = createCodexRolloutTranslationState({
      providerSessionId: "019e2986-bbb3-77a2-9e13-5abc9daf9ee0",
    });
    translateCodexRolloutLine(
      {
        timestamp: "2026-05-15T02:46:10.900Z",
        type: "turn_context",
        payload: {
          turn_id: "turn-council-post",
          model: "gpt-5.5",
          effort: "xhigh",
        },
      },
      state,
    );

    const started = translateCodexRolloutLine(
      {
        timestamp: "2026-05-15T02:46:11.100Z",
        type: "response_item",
        payload: {
          type: "function_call",
          name: "channel_post",
          arguments: JSON.stringify({
            council: "council-1",
            content: "[GPT-5.5-XHigh] 我也读完了。先做一个事实校准。",
          }),
          call_id: "call-council-post",
        },
      },
      state,
    );
    const completed = translateCodexRolloutLine(
      {
        timestamp: "2026-05-15T02:46:11.200Z",
        type: "response_item",
        payload: {
          type: "function_call_output",
          call_id: "call-council-post",
          output: '{"ok":true,"message_id":"msg-1"}',
        },
      },
      state,
    );

    assert.deepEqual(started, []);
    assert.equal(completed.length, 1);
    const projected = completed[0]?.activity;
    assert.equal(projected?.type, "timeline_item");
    if (projected?.type === "timeline_item") {
      assert.deepEqual(projected.item, {
        kind: "assistant_message",
        messageId: "council-mcp:call-council-post",
        text: "[GPT-5.5-XHigh] 我也读完了。先做一个事实校准。",
        runtimeModel: {
          modelId: "gpt-5.5",
          optionId: "xhigh",
          optionKind: "reasoning_effort",
          source: "native",
        },
      });
    }
  });

  test("does not project failed rah_council channel_post calls", () => {
    const state = createCodexRolloutTranslationState();

    translateCodexRolloutLine(
      {
        timestamp: "2026-05-15T02:46:12.100Z",
        type: "response_item",
        payload: {
          type: "function_call",
          name: "mcp__rah_council__channel_post",
          arguments: JSON.stringify({
            council: "council-1",
            content: "这条失败 post 不应该进入 session history。",
          }),
          call_id: "call-council-post-failed",
        },
      },
      state,
    );
    const completed = translateCodexRolloutLine(
      {
        timestamp: "2026-05-15T02:46:12.200Z",
        type: "response_item",
        payload: {
          type: "function_call_output",
          call_id: "call-council-post-failed",
          output: '{"ok":false,"error":"council closed"}',
        },
      },
      state,
    );

    assert.deepEqual(completed, []);
  });

  test("shows Codex goal commands as concise timeline notifications", () => {
    const state = createCodexRolloutTranslationState();
    const activities = translateCodexRolloutLine(
      {
        timestamp: "2026-05-08T01:39:40.111Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "developer",
          content: [
            {
              type: "input_text",
              text: [
                "Continue working toward the active thread goal.",
                "",
                "<untrusted_objective>",
                "让我们做一个简单测试,你执行sleep 5秒即可",
                "</untrusted_objective>",
              ].join("\n"),
            },
          ],
        },
      },
      state,
    );
    assert.deepEqual(activities.map((item) => item.activity), [
      {
        type: "notification",
        level: "info",
        title: "Goal active",
        body: "Objective: 让我们做一个简单测试,你执行sleep 5秒即可",
      },
    ]);
  });

  test("maps persisted Codex thread goal updates into semantic notifications", () => {
    const state = createCodexRolloutTranslationState();
    const active = translateCodexRolloutLine(
      {
        timestamp: "2026-05-20T18:10:33.603Z",
        type: "event_msg",
        payload: {
          type: "thread_goal_updated",
          threadId: "thread-1",
          turnId: "turn-1",
          goal: {
            threadId: "thread-1",
            objective: "Implement the harmless test goal.",
            status: "active",
            tokensUsed: 0,
            timeUsedSeconds: 0,
            createdAt: 1779300633,
            updatedAt: 1779300633,
          },
        },
      },
      state,
    );
    const accountingOnly = translateCodexRolloutLine(
      {
        timestamp: "2026-05-20T18:10:38.328Z",
        type: "event_msg",
        payload: {
          type: "thread_goal_updated",
          threadId: "thread-1",
          turnId: "turn-1",
          goal: {
            threadId: "thread-1",
            objective: "Implement the harmless test goal.",
            status: "active",
            tokensUsed: 3067,
            timeUsedSeconds: 4,
            createdAt: 1779300633,
            updatedAt: 1779300638,
          },
        },
      },
      state,
    );
    const complete = translateCodexRolloutLine(
      {
        timestamp: "2026-05-20T18:11:38.328Z",
        type: "event_msg",
        payload: {
          type: "thread_goal_updated",
          threadId: "thread-1",
          turnId: "turn-1",
          goal: {
            threadId: "thread-1",
            objective: "Implement the harmless test goal.",
            status: "complete",
            tokensUsed: 4096,
            timeUsedSeconds: 65,
            createdAt: 1779300633,
            updatedAt: 1779300698,
          },
        },
      },
      state,
    );

    assert.deepEqual(active.map((item) => item.activity), [
      {
        type: "notification",
        level: "info",
        title: "Goal active",
        body: "Objective: Implement the harmless test goal.",
        turnId: "turn-1",
      },
    ]);
    assert.deepEqual(accountingOnly, []);
    assert.deepEqual(complete.map((item) => item.activity), [
      {
        type: "notification",
        level: "info",
        title: "Goal complete",
        body: "Objective: Implement the harmless test goal.\nUsage: 4096 tokens, 1m 5s",
        turnId: "turn-1",
      },
    ]);
  });

  test("folds Codex goal context prompts out of the visible user transcript", () => {
    const contextText = [
      "<goal_context>",
      "Continue working toward the active thread goal.",
      "",
      "<objective>",
      "Keep making harmless progress.",
      "</objective>",
      "",
      "Budget:",
      "- Tokens used: 3067",
      "</goal_context>",
    ].join("\n");
    const contextOnlyState = createCodexRolloutTranslationState({ providerSessionId: "thread-1" });

    assert.deepEqual(
      translateCodexRolloutLine(
        {
          timestamp: "2026-05-20T18:10:38.347Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: contextText }],
          },
        },
        contextOnlyState,
      ).map((item) => item.activity),
      [
        {
          type: "notification",
          level: "info",
          title: "Goal active",
          body: "Objective: Keep making harmless progress.",
        },
      ],
    );

    const dedupedState = createCodexRolloutTranslationState({ providerSessionId: "thread-1" });
    translateCodexRolloutLine(
      {
        timestamp: "2026-05-20T18:10:33.603Z",
        type: "event_msg",
        payload: {
          type: "thread_goal_updated",
          threadId: "thread-1",
          turnId: "turn-1",
          goal: {
            threadId: "thread-1",
            objective: "Keep making harmless progress.",
            status: "active",
            tokensUsed: 0,
            timeUsedSeconds: 0,
            createdAt: 1779300633,
            updatedAt: 1779300633,
          },
        },
      },
      dedupedState,
    );

    assert.deepEqual(
      translateCodexRolloutLine(
        {
          timestamp: "2026-05-20T18:10:38.347Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: contextText }],
          },
        },
        dedupedState,
      ),
      [],
    );
  });

  test("maps Codex goal cleared events without repeating them", () => {
    const state = createCodexRolloutTranslationState();
    const line = {
      timestamp: "2026-05-20T18:12:00.000Z",
      type: "event_msg",
      payload: {
        type: "thread_goal_cleared",
        threadId: "thread-1",
      },
    };

    assert.deepEqual(translateCodexRolloutLine(line, state).map((item) => item.activity), [
      {
        type: "notification",
        level: "info",
        title: "Goal cleared",
        body: "The active goal was cleared.",
      },
    ]);
    assert.deepEqual(translateCodexRolloutLine(line, state), []);
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

  test("ignores user messages that only contain turn_aborted contextual fragments", () => {
    const state = createCodexRolloutTranslationState();

    const activities = translateCodexRolloutLine(
      {
        timestamp: "2026-04-24T06:10:01.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [
            {
              type: "input_text",
              text:
                "<turn_aborted>\nThe user interrupted the previous turn on purpose.\n</turn_aborted>",
            },
          ],
        },
      },
      state,
    );

    assert.deepEqual(activities, []);
  });

  test("ignores non-text user message payloads without surfacing provider noise", () => {
    const state = createCodexRolloutTranslationState();

    const activities = translateCodexRolloutLine(
      {
        timestamp: "2026-04-24T06:10:02.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_image", image_url: "data:image/png;base64,..." }],
        },
      },
      state,
    );

    assert.deepEqual(activities, []);
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

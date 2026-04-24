import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  CODEX_APP_SERVER_IGNORED_NOTIFICATION_METHODS,
  CODEX_APP_SERVER_NOTIFICATION_METHODS,
  createCodexAppServerTranslationState,
  mapCodexPermissionResolution,
  mapCodexQuestionRequestToActivities,
  translateCodexAppServerNotification,
} from "./codex-app-server-activity";

function hasInvalidStreamObservation(items: ReturnType<typeof translateCodexAppServerNotification>): boolean {
  return items.some(
    (item) =>
      item.activity.type === "observation_completed" &&
      item.activity.observation.kind === "runtime.invalid_stream",
  );
}

const ignoredNotificationMethods = new Set<string>(CODEX_APP_SERVER_IGNORED_NOTIFICATION_METHODS);

describe("translateCodexAppServerNotification", () => {
  test("maps turn lifecycle and usage notifications", () => {
    const state = createCodexAppServerTranslationState();

    const turnStarted = translateCodexAppServerNotification(
      {
        method: "turn/started",
        params: { turn: { id: "turn-1" } },
      },
      state,
    );
    const usage = translateCodexAppServerNotification(
      {
        method: "thread/tokenUsage/updated",
        params: {
          tokenUsage: {
            model_context_window: 1000,
            last: { total_tokens: 100 },
          },
        },
      },
      state,
    );
    const turnCompleted = translateCodexAppServerNotification(
      {
        method: "turn/completed",
        params: { turn: { id: "turn-1", status: "completed" } },
      },
      state,
    );

    assert.deepEqual(turnStarted[0]?.activity, {
      type: "turn_started",
      turnId: "turn-1",
    });
    assert.deepEqual(usage[0]?.activity, {
      type: "usage",
      usage: {
        usedTokens: 100,
        contextWindow: 1000,
        percentRemaining: 90,
      },
    });
    assert.deepEqual(turnCompleted[0]?.activity, {
      type: "turn_completed",
      turnId: "turn-1",
    });
  });

  test("extracts retry count from reconnecting runtime errors", () => {
    const state = createCodexAppServerTranslationState();
    const retry = translateCodexAppServerNotification(
      {
        method: "error",
        params: {
          willRetry: true,
          turnId: "turn-retry",
          error: {
            message: "Reconnecting... 5/5",
          },
        },
      },
      state,
    );

    assert.deepEqual(retry[0]?.activity, {
      type: "runtime_status",
      status: "retrying",
      detail: "Reconnecting... 5/5",
      retryCount: 5,
      turnId: "turn-retry",
    });
  });

  test("maps command start, buffered output, and completion", () => {
    const state = createCodexAppServerTranslationState();

    const started = translateCodexAppServerNotification(
      {
        method: "codex/event/exec_command_begin",
        params: {
          msg: {
            call_id: "call-1",
            command: "echo hello",
            cwd: "/workspace/demo",
          },
        },
      },
      state,
    );
    const delta = translateCodexAppServerNotification(
      {
        method: "codex/event/exec_command_output_delta",
        params: {
          msg: {
            call_id: "call-1",
            chunk: "hello",
          },
        },
      },
      state,
    );
    const completed = translateCodexAppServerNotification(
      {
        method: "codex/event/exec_command_end",
        params: {
          msg: {
            call_id: "call-1",
            exit_code: 0,
          },
        },
      },
      state,
    );

    assert.equal(started[0]?.activity.type, "observation_started");
    if (started[0]?.activity.type === "observation_started") {
      assert.equal(started[0].activity.observation.kind, "command.run");
    }
    assert.equal(started[1]?.activity.type, "tool_call_started");
    if (started[1]?.activity.type === "tool_call_started") {
      assert.equal(started[1].activity.toolCall.family, "shell");
    }
    assert.deepEqual(started[2]?.activity, {
      type: "terminal_output",
      data: "$ echo hello\r\n",
    });
    assert.equal(delta[0]?.activity.type, "observation_updated");
    assert.equal(delta[1]?.activity.type, "tool_call_delta");
    assert.deepEqual(delta[2]?.activity, {
      type: "terminal_output",
      data: "hello",
    });

    assert.equal(completed[0]?.activity.type, "observation_completed");
    if (completed[0]?.activity.type === "observation_completed") {
      assert.equal(completed[0].activity.observation.status, "completed");
    }
    assert.equal(completed[1]?.activity.type, "tool_call_completed");
    if (completed[1]?.activity.type === "tool_call_completed") {
      assert.deepEqual(completed[1].activity.toolCall.result, { exitCode: 0 });
      assert.ok(
        completed[1].activity.toolCall.detail?.artifacts.some(
          (artifact) => artifact.kind === "text" && artifact.label === "stdout",
        ),
      );
    }
    assert.deepEqual(completed[2]?.activity, {
      type: "terminal_output",
      data: "\r\n[exit 0]\r\n$ ",
    });
  });

  test("falls back to aggregated output when command delta chunks are unavailable", () => {
    const state = createCodexAppServerTranslationState();

    translateCodexAppServerNotification(
      {
        method: "codex/event/exec_command_begin",
        params: {
          msg: {
            call_id: "call-2",
            command: "pwd",
          },
        },
      },
      state,
    );
    const completed = translateCodexAppServerNotification(
      {
        method: "codex/event/exec_command_end",
        params: {
          msg: {
            call_id: "call-2",
            exit_code: 0,
            aggregated_output: "/workspace/demo",
          },
        },
      },
      state,
    );

    assert.deepEqual(completed.slice(2).map((item) => item.activity), [
      {
        type: "terminal_output",
        data: "/workspace/demo",
      },
      {
        type: "terminal_output",
        data: "\r\n[exit 0]\r\n$ ",
      },
    ]);
  });

  test("maps patch notifications and plan updates", () => {
    const state = createCodexAppServerTranslationState();

    const plan = translateCodexAppServerNotification(
      {
        method: "turn/plan/updated",
        params: {
          plan: [{ step: "Review files", status: "in_progress" }, { step: "Apply patch" }],
        },
      },
      state,
    );
    const patchStarted = translateCodexAppServerNotification(
      {
        method: "codex/event/patch_apply_begin",
        params: {
          msg: {
            call_id: "patch-1",
          },
        },
      },
      state,
    );
    translateCodexAppServerNotification(
      {
        method: "item/fileChange/outputDelta",
        params: {
          itemId: "patch-1",
          delta: "Success. Updated the following files:\nM src/demo.ts",
        },
      },
      state,
    );
    const patchCompleted = translateCodexAppServerNotification(
      {
        method: "codex/event/patch_apply_end",
        params: {
          msg: {
            call_id: "patch-1",
            success: true,
          },
        },
      },
      state,
    );

    assert.deepEqual(plan[0]?.activity, {
      type: "timeline_item",
      item: { kind: "plan", text: "- Review files\n- Apply patch" },
    });
    assert.equal(patchStarted[0]?.activity.type, "observation_started");
    assert.equal(patchStarted[1]?.activity.type, "tool_call_started");
    assert.equal(patchCompleted[0]?.activity.type, "observation_completed");
    assert.equal(patchCompleted[1]?.activity.type, "tool_call_completed");
  });

  test("maps fileChange items with object-style and alias diff payloads", () => {
    const state = createCodexAppServerTranslationState();

    const translated = translateCodexAppServerNotification(
      {
        method: "item/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            type: "fileChange",
            id: "patch-object-1",
            status: "completed",
            changes: {
              "src/a.ts": { unifiedDiff: "@@\n-old\n+new" },
              "src/b.ts": {
                file_path: "src/b.ts",
                patch: "@@\n-before\n+after",
              },
            },
          },
        },
      },
      state,
    );

    assert.deepEqual(
      translated.map((item) => item.activity.type),
      ["observation_completed", "tool_call_completed"],
    );
    const tool = translated[1]?.activity;
      assert.equal(tool?.type, "tool_call_completed");
    if (tool?.type === "tool_call_completed") {
      assert.equal(tool.toolCall.family, "patch");
      assert.deepEqual(tool.toolCall.input, { files: ["src/a.ts", "src/b.ts"] });
      assert.ok(
        tool.toolCall.detail?.artifacts.some(
          (artifact) => artifact.kind === "diff" && artifact.text.includes("before"),
        ),
      );
    }
  });

  test("ignores internal environment user messages in live notifications", () => {
    const state = createCodexAppServerTranslationState();
    const translated = translateCodexAppServerNotification(
      {
        method: "item/started",
        params: {
          turnId: "turn-1",
          item: {
            type: "userMessage",
            id: "user-env-1",
            content: [
              {
                type: "text",
                text:
                  "<environment_context>\n  <shell>zsh</shell>\n  <current_date>2026-04-18</current_date>\n  <timezone>Asia/Shanghai</timezone>\n</environment_context>Reply with EXACTLY: test",
              },
            ],
          },
        },
      },
      state,
    );

    assert.deepEqual(translated, []);
  });

  test("strips turn_aborted contextual fragments from live user messages", () => {
    const state = createCodexAppServerTranslationState();
    const activities = translateCodexAppServerNotification(
      {
        method: "item/completed",
        params: {
          turnId: "turn-1",
          item: {
            type: "userMessage",
            id: "user-1",
            content: [
              {
                text:
                  "周几?<turn_aborted>\nThe user interrupted the previous turn on purpose.\n</turn_aborted>",
              },
            ],
          },
        },
      },
      state,
    );

    assert.deepEqual(activities.map((item) => item.activity), [
      {
        type: "message_part_added",
        turnId: "turn-1",
        part: {
          messageId: "user-1",
          partId: "user-1",
          kind: "text",
          text: "周几?",
        },
      },
      {
        type: "timeline_item",
        turnId: "turn-1",
        item: {
          kind: "user_message",
          text: "周几?",
          messageId: "user-1",
        },
      },
    ]);
  });

  test("deduplicates item start/completion transcript using app-server item state", () => {
    const state = createCodexAppServerTranslationState();

    const userStarted = translateCodexAppServerNotification(
      {
        method: "item/started",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            type: "userMessage",
            id: "user-1",
            content: [{ type: "text", text: "你是谁" }],
          },
        },
      },
      state,
    );
    const userCompleted = translateCodexAppServerNotification(
      {
        method: "item/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            type: "userMessage",
            id: "user-1",
            content: [{ type: "text", text: "你是谁" }],
          },
        },
      },
      state,
    );
    translateCodexAppServerNotification(
      {
        method: "item/agentMessage/delta",
        params: { threadId: "thread-1", turnId: "turn-1", itemId: "assistant-1", delta: "我是" },
      },
      state,
    );
    const assistantCompleted = translateCodexAppServerNotification(
      {
        method: "item/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            type: "agentMessage",
            id: "assistant-1",
            text: "我是 Codex",
          },
        },
      },
      state,
    );

    assert.deepEqual(
      userStarted.map((item) => item.activity.type),
      ["message_part_added", "timeline_item"],
    );
    assert.deepEqual(userCompleted, []);
    assert.deepEqual(
      assistantCompleted.map((item) => item.activity.type),
      ["message_part_updated"],
    );
  });

  test("deduplicates repeated app-server deltas and reasoning section breaks", () => {
    const state = createCodexAppServerTranslationState();

    const firstAgentDelta = translateCodexAppServerNotification(
      {
        method: "item/agentMessage/delta",
        params: { threadId: "thread-1", turnId: "turn-1", itemId: "assistant-1", delta: "hello" },
      },
      state,
    );
    const repeatedAgentDelta = translateCodexAppServerNotification(
      {
        method: "item/agentMessage/delta",
        params: { threadId: "thread-1", turnId: "turn-1", itemId: "assistant-1", delta: "hello" },
      },
      state,
    );
    const firstReasoningSection = translateCodexAppServerNotification(
      {
        method: "item/reasoning/summaryPartAdded",
        params: { threadId: "thread-1", turnId: "turn-1", itemId: "reason-1", summaryIndex: 0 },
      },
      state,
    );
    const repeatedReasoningSection = translateCodexAppServerNotification(
      {
        method: "item/reasoning/summaryPartAdded",
        params: { threadId: "thread-1", turnId: "turn-1", itemId: "reason-1", summaryIndex: 0 },
      },
      state,
    );
    const firstCommandDelta = translateCodexAppServerNotification(
      {
        method: "item/commandExecution/outputDelta",
        params: { threadId: "thread-1", turnId: "turn-1", itemId: "cmd-1", delta: "stdout" },
      },
      state,
    );
    const repeatedCommandDelta = translateCodexAppServerNotification(
      {
        method: "item/commandExecution/outputDelta",
        params: { threadId: "thread-1", turnId: "turn-1", itemId: "cmd-1", delta: "stdout" },
      },
      state,
    );

    assert.deepEqual(
      firstAgentDelta.map((item) => item.activity.type),
      ["message_part_delta", "timeline_item"],
    );
    assert.deepEqual(repeatedAgentDelta, []);
    assert.deepEqual(
      firstReasoningSection.map((item) => item.activity.type),
      ["message_part_added"],
    );
    assert.deepEqual(repeatedReasoningSection, []);
    assert.deepEqual(
      firstCommandDelta.map((item) => item.activity.type),
      ["tool_call_delta", "terminal_output"],
    );
    assert.deepEqual(repeatedCommandDelta, []);
  });

  test("maps or deliberately ignores every known Codex app-server notification method without invalid fallback", () => {
    const b64 = Buffer.from("hello").toString("base64");
    const run = {
      id: "hook-1",
      eventName: "preToolUse",
      handlerType: "command",
      executionMode: "blocking",
      scope: "local",
      sourcePath: "/workspace/.codex/hooks.json",
      displayOrder: 0,
      status: "completed",
      statusMessage: null,
      startedAt: 1,
      completedAt: 2,
      durationMs: 1,
      entries: [],
    };
    const samples: Record<(typeof CODEX_APP_SERVER_NOTIFICATION_METHODS)[number], { method: string; params?: unknown }> = {
      "error": { method: "error", params: { threadId: "thread-1", turnId: "turn-1", error: { message: "boom" }, willRetry: false } },
      "thread/started": { method: "thread/started", params: { thread: { id: "thread-1" } } },
      "thread/status/changed": { method: "thread/status/changed", params: { threadId: "thread-1", status: { type: "active", activeFlags: ["waitingOnApproval"] } } },
      "thread/archived": { method: "thread/archived", params: { threadId: "thread-1" } },
      "thread/unarchived": { method: "thread/unarchived", params: { threadId: "thread-1" } },
      "thread/closed": { method: "thread/closed", params: { threadId: "thread-1" } },
      "skills/changed": { method: "skills/changed", params: {} },
      "thread/name/updated": { method: "thread/name/updated", params: { threadId: "thread-1", threadName: "Demo" } },
      "thread/tokenUsage/updated": { method: "thread/tokenUsage/updated", params: { threadId: "thread-1", turnId: "turn-1", tokenUsage: { modelContextWindow: 1000, last: { totalTokens: 100 } } } },
      "turn/started": { method: "turn/started", params: { threadId: "thread-1", turn: { id: "turn-1" } } },
      "hook/started": { method: "hook/started", params: { threadId: "thread-1", turnId: "turn-1", run: { ...run, status: "running" } } },
      "turn/completed": { method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } } },
      "hook/completed": { method: "hook/completed", params: { threadId: "thread-1", turnId: "turn-1", run } },
      "turn/diff/updated": { method: "turn/diff/updated", params: { threadId: "thread-1", turnId: "turn-1", diff: "diff --git a/a b/a" } },
      "turn/plan/updated": { method: "turn/plan/updated", params: { threadId: "thread-1", turnId: "turn-1", plan: [{ step: "Inspect", status: "inProgress" }] } },
      "item/started": { method: "item/started", params: { threadId: "thread-1", turnId: "turn-1", item: { type: "commandExecution", id: "cmd-1", command: "echo hello", cwd: "/workspace", status: "inProgress", commandActions: [], aggregatedOutput: null, exitCode: null, durationMs: null } } },
      "item/autoApprovalReview/started": { method: "item/autoApprovalReview/started", params: { threadId: "thread-1", turnId: "turn-1", reviewId: "review-1", targetItemId: "cmd-1", review: {}, action: {} } },
      "item/autoApprovalReview/completed": { method: "item/autoApprovalReview/completed", params: { threadId: "thread-1", turnId: "turn-1", reviewId: "review-1", targetItemId: "cmd-1", review: {}, action: {}, decisionSource: "guardian" } },
      "item/completed": { method: "item/completed", params: { threadId: "thread-1", turnId: "turn-1", item: { type: "commandExecution", id: "cmd-1", command: "echo hello", cwd: "/workspace", status: "completed", commandActions: [], aggregatedOutput: "hello", exitCode: 0, durationMs: 1 } } },
      "rawResponseItem/completed": { method: "rawResponseItem/completed", params: { threadId: "thread-1", turnId: "turn-1", item: { type: "message" } } },
      "item/agentMessage/delta": { method: "item/agentMessage/delta", params: { threadId: "thread-1", turnId: "turn-1", itemId: "msg-1", delta: "hello" } },
      "item/plan/delta": { method: "item/plan/delta", params: { threadId: "thread-1", turnId: "turn-1", itemId: "plan-1", delta: "step" } },
      "command/exec/outputDelta": { method: "command/exec/outputDelta", params: { processId: "proc-1", stream: "stdout", deltaBase64: b64, capReached: false } },
      "item/commandExecution/outputDelta": { method: "item/commandExecution/outputDelta", params: { threadId: "thread-1", turnId: "turn-1", itemId: "cmd-1", delta: "hello" } },
      "item/commandExecution/terminalInteraction": { method: "item/commandExecution/terminalInteraction", params: { threadId: "thread-1", turnId: "turn-1", itemId: "cmd-1", processId: "proc-1", stdin: "y\n" } },
      "item/fileChange/outputDelta": { method: "item/fileChange/outputDelta", params: { threadId: "thread-1", turnId: "turn-1", itemId: "patch-1", delta: "patching" } },
      "serverRequest/resolved": { method: "serverRequest/resolved", params: { threadId: "thread-1", requestId: 1 } },
      "item/mcpToolCall/progress": { method: "item/mcpToolCall/progress", params: { threadId: "thread-1", turnId: "turn-1", itemId: "mcp-1", message: "loading" } },
      "mcpServer/oauthLogin/completed": { method: "mcpServer/oauthLogin/completed", params: { name: "server", success: true, error: null } },
      "mcpServer/startupStatus/updated": { method: "mcpServer/startupStatus/updated", params: { name: "server", status: "ready", error: null } },
      "account/updated": { method: "account/updated", params: { authMode: "chatgpt", planType: "plus" } },
      "account/rateLimits/updated": { method: "account/rateLimits/updated", params: { rateLimits: { limitId: null, limitName: null, primary: null, secondary: null, credits: null, planType: null } } },
      "account/login/completed": { method: "account/login/completed", params: { loginId: "login-1", success: true, error: null } },
      "app/list/updated": { method: "app/list/updated", params: {} },
      "fs/changed": { method: "fs/changed", params: { watchId: "watch-1", changedPaths: ["/workspace/a.ts"] } },
      "item/reasoning/summaryTextDelta": { method: "item/reasoning/summaryTextDelta", params: { threadId: "thread-1", turnId: "turn-1", itemId: "reason-1", delta: "thinking", summaryIndex: 0 } },
      "item/reasoning/summaryPartAdded": { method: "item/reasoning/summaryPartAdded", params: { threadId: "thread-1", turnId: "turn-1", itemId: "reason-1", summaryIndex: 0 } },
      "item/reasoning/textDelta": { method: "item/reasoning/textDelta", params: { threadId: "thread-1", turnId: "turn-1", itemId: "reason-1", delta: "raw", contentIndex: 0 } },
      "thread/compacted": { method: "thread/compacted", params: { threadId: "thread-1", turnId: "turn-1" } },
      "model/rerouted": { method: "model/rerouted", params: { threadId: "thread-1", turnId: "turn-1", fromModel: "a", toModel: "b", reason: "quota" } },
      "deprecationNotice": { method: "deprecationNotice", params: { summary: "Deprecated", details: "Use v2" } },
      "configWarning": { method: "configWarning", params: { summary: "Config warning", details: "Bad config" } },
      "fuzzyFileSearch/sessionUpdated": { method: "fuzzyFileSearch/sessionUpdated", params: { sessionId: "search-1", query: "foo", files: [] } },
      "fuzzyFileSearch/sessionCompleted": { method: "fuzzyFileSearch/sessionCompleted", params: { sessionId: "search-1" } },
      "thread/realtime/started": { method: "thread/realtime/started", params: { threadId: "thread-1", sessionId: "rt-1", version: "v1" } },
      "thread/realtime/itemAdded": { method: "thread/realtime/itemAdded", params: { threadId: "thread-1", item: {} } },
      "thread/realtime/transcript/delta": { method: "thread/realtime/transcript/delta", params: { threadId: "thread-1", role: "assistant", delta: "hi" } },
      "thread/realtime/transcript/done": { method: "thread/realtime/transcript/done", params: { threadId: "thread-1", role: "assistant", text: "hi" } },
      "thread/realtime/outputAudio/delta": { method: "thread/realtime/outputAudio/delta", params: { threadId: "thread-1", audio: { data: "AA==", sampleRate: 24000, numChannels: 1, samplesPerChannel: null, itemId: null } } },
      "thread/realtime/sdp": { method: "thread/realtime/sdp", params: { threadId: "thread-1", sdp: "v=0" } },
      "thread/realtime/error": { method: "thread/realtime/error", params: { threadId: "thread-1", message: "rt error" } },
      "thread/realtime/closed": { method: "thread/realtime/closed", params: { threadId: "thread-1", reason: "done" } },
      "windows/worldWritableWarning": { method: "windows/worldWritableWarning", params: { samplePaths: [], extraCount: 0, failedScan: false } },
      "windowsSandbox/setupCompleted": { method: "windowsSandbox/setupCompleted", params: { mode: "elevated", success: true, error: null } },
    };

    assert.deepEqual(Object.keys(samples).sort(), [...CODEX_APP_SERVER_NOTIFICATION_METHODS].sort());

    for (const method of CODEX_APP_SERVER_NOTIFICATION_METHODS) {
      const state = createCodexAppServerTranslationState();
      const translated = translateCodexAppServerNotification(samples[method], state);
      if (ignoredNotificationMethods.has(method)) {
        assert.equal(translated.length, 0, method);
        continue;
      }
      assert.ok(translated.length > 0, method);
      assert.equal(hasInvalidStreamObservation(translated), false, method);
    }
  });
});

describe("Codex app-server approval mapping", () => {
  test("maps request_user_input requests to a tool call and permission request", () => {
    const activities = mapCodexQuestionRequestToActivities({
      itemId: "question-1",
      questions: [
        {
          id: "drink",
          header: "Drink",
          question: "Which drink do you want?",
          options: [{ label: "Coffee" }, { label: "Tea" }],
        },
      ],
    });

    assert.equal(activities.length, 2);
    assert.equal(activities[0]?.activity.type, "tool_call_started");
    assert.equal(activities[1]?.activity.type, "permission_requested");
  });

  test("maps permission resolution into canonical activity", () => {
    const activity = mapCodexPermissionResolution({
      requestId: "permission-question-1",
      behavior: "allow",
      message: "Approved from client",
      selectedActionId: "allow_for_session",
      decision: "approved_for_session",
      answers: { drink: { answers: ["Coffee"] } },
    });

    assert.deepEqual(activity.activity, {
      type: "permission_resolved",
      resolution: {
        requestId: "permission-question-1",
        behavior: "allow",
        message: "Approved from client",
        selectedActionId: "allow_for_session",
        decision: "approved_for_session",
        answers: { drink: { answers: ["Coffee"] } },
      },
    });
  });
});

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { isCoreWorkbenchEvent } from "@rah/runtime-protocol";
import {
  createAdapterConformanceHarness,
  summarizeRahEvents,
} from "./adapter-conformance-test-utils";
import {
  createCodexAppServerTranslationState,
  translateCodexAppServerNotification,
} from "./codex-app-server-activity";
import {
  createCodexRolloutTranslationState,
  translateCodexRolloutLine,
} from "./codex-rollout-activity";

function applyLiveFixture(
  notifications: Array<{ method: string; params?: unknown }>,
  options: { attachTurnId?: string } = {},
) {
  const harness = createAdapterConformanceHarness({ provider: "codex" });
  const state = createCodexAppServerTranslationState();
  let activeTurnId: string | undefined = options.attachTurnId;
  for (const notification of notifications) {
    const translated = translateCodexAppServerNotification(notification, state).map((item) => {
      if (activeTurnId && item.activity.type !== "turn_started" && supportsTurnId(item.activity) && item.activity.turnId === undefined) {
        return {
          ...item,
          activity: {
            ...item.activity,
            turnId: activeTurnId,
          },
        };
      }
      return item;
    });
    const events = harness.apply(translated);
    for (const event of events) {
      if (event.type === "turn.started") {
        activeTurnId = event.turnId;
      }
      if (
        event.type === "turn.completed" ||
        event.type === "turn.failed" ||
        event.type === "turn.canceled"
      ) {
        activeTurnId = undefined;
      }
    }
  }
  return harness;
}

function supportsTurnId(activity: ReturnType<typeof translateCodexAppServerNotification>[number]["activity"]): activity is typeof activity & { turnId?: string } {
  return [
    "timeline_item",
    "timeline_item_updated",
    "message_part_added",
    "message_part_updated",
    "message_part_delta",
    "message_part_removed",
    "tool_call_started",
    "tool_call_delta",
    "tool_call_completed",
    "tool_call_failed",
    "observation_started",
    "observation_updated",
    "observation_completed",
    "observation_failed",
    "permission_requested",
    "permission_resolved",
    "operation_started",
    "operation_resolved",
    "operation_requested",
    "governance_updated",
    "runtime_status",
    "notification",
    "usage",
  ].includes(activity.type);
}

function applyRolloutFixture(lines: unknown[]) {
  const harness = createAdapterConformanceHarness({ provider: "codex" });
  const state = createCodexRolloutTranslationState();
  for (const line of lines) {
    harness.apply(translateCodexRolloutLine(line, state));
  }
  return harness;
}

function eventTypesAndKinds(harness: ReturnType<typeof applyLiveFixture>) {
  return summarizeRahEvents(harness.events()).map((entry) => ({
    type: entry.type,
    ...("kind" in entry ? { kind: entry.kind } : {}),
    ...("family" in entry ? { family: entry.family } : {}),
  }));
}

describe("Codex reference adapter fixtures", () => {
  test("live and rollout command fixtures produce aligned canonical semantics", () => {
    const live = applyLiveFixture([
      { method: "turn/started", params: { turn: { id: "turn-1" } } },
      {
        method: "codex/event/exec_command_begin",
        params: {
          msg: {
            call_id: "call-1",
            command: "cat package.json",
            cwd: "/workspace/demo",
          },
        },
      },
      {
        method: "codex/event/exec_command_output_delta",
        params: { msg: { call_id: "call-1", chunk: "{}" } },
      },
      {
        method: "codex/event/exec_command_end",
        params: { msg: { call_id: "call-1", exit_code: 0 } },
      },
      { method: "turn/completed", params: { turn: { id: "turn-1", status: "completed" } } },
    ]);
    const rollout = applyRolloutFixture([
      {
        timestamp: "2026-04-15T00:00:00.000Z",
        type: "response_item",
        payload: {
          type: "function_call",
          name: "exec_command",
          call_id: "call-1",
          arguments: '{"cmd":"cat package.json","workdir":"/workspace/demo"}',
        },
      },
      {
        timestamp: "2026-04-15T00:00:01.000Z",
        type: "response_item",
        payload: {
          type: "function_call_output",
          call_id: "call-1",
          output: "Process exited with code 0\nOutput:\n{}",
        },
      },
    ]);

    live.assertConforms({ requireTurnScopedWork: true });
    rollout.assertConforms();

    const liveKinds = eventTypesAndKinds(live).filter((event) =>
      event.type.startsWith("tool.call.") || event.type.startsWith("observation."),
    );
    const rolloutKinds = eventTypesAndKinds(rollout).filter((event) =>
      event.type.startsWith("tool.call.") || event.type.startsWith("observation."),
    );

    assert.deepEqual(
      liveKinds.filter((event) => event.type !== "observation.updated" && event.type !== "tool.call.delta"),
      rolloutKinds,
    );
    assert.ok(
      live.events().some(
        (event) =>
          event.type === "observation.started" &&
          event.payload.observation.kind === "file.read",
      ),
    );
  });

  test("live item fixtures cover command, patch, MCP, web, subagent, media, and compaction", () => {
    const harness = applyLiveFixture([
      { method: "turn/started", params: { turn: { id: "turn-items" } } },
      {
        method: "item/started",
        params: {
          turnId: "turn-items",
          item: {
            type: "mcpToolCall",
            id: "mcp-1",
            server: "filesystem",
            tool: "read_file",
            status: "inProgress",
            arguments: { path: "README.md" },
            result: null,
            error: null,
            durationMs: null,
          },
        },
      },
      {
        method: "item/mcpToolCall/progress",
        params: {
          turnId: "turn-items",
          itemId: "mcp-1",
          message: "reading",
        },
      },
      {
        method: "item/completed",
        params: {
          turnId: "turn-items",
          item: {
            type: "mcpToolCall",
            id: "mcp-1",
            server: "filesystem",
            tool: "read_file",
            status: "completed",
            arguments: { path: "README.md" },
            result: { content: [{ type: "text", text: "ok" }], structuredContent: null, _meta: null },
            error: null,
            durationMs: 10,
          },
        },
      },
      {
        method: "item/completed",
        params: {
          turnId: "turn-items",
          item: {
            type: "fileChange",
            id: "patch-1",
            status: "completed",
            changes: [
              {
                path: "src/demo.ts",
                kind: { type: "update", movePath: null },
                diff: "@@\n-old\n+new",
              },
            ],
          },
        },
      },
      {
        method: "item/completed",
        params: {
          turnId: "turn-items",
          item: {
            type: "webSearch",
            id: "web-1",
            query: "OpenAI Codex app-server",
            action: null,
          },
        },
      },
      {
        method: "item/started",
        params: {
          turnId: "turn-items",
          item: {
            type: "collabAgentToolCall",
            id: "subagent-1",
            tool: "spawnAgent",
            status: "inProgress",
            senderThreadId: "thread-1",
            receiverThreadIds: ["thread-2"],
            prompt: "Inspect files",
            model: "gpt",
            reasoningEffort: "medium",
            agentsStates: {},
          },
        },
      },
      {
        method: "item/completed",
        params: {
          turnId: "turn-items",
          item: {
            type: "imageView",
            id: "image-1",
            path: "/tmp/demo.png",
          },
        },
      },
      {
        method: "item/completed",
        params: {
          turnId: "turn-items",
          item: {
            type: "contextCompaction",
            id: "compact-1",
          },
        },
      },
      { method: "turn/completed", params: { turn: { id: "turn-items", status: "completed" } } },
    ]);

    harness.assertConforms({ requireTurnScopedWork: true });

    const observations = harness.events().flatMap((event) => {
      switch (event.type) {
        case "observation.started":
        case "observation.updated":
        case "observation.completed":
        case "observation.failed":
          return [event.payload.observation.kind];
        default:
          return [];
      }
    });
    assert.ok(observations.includes("mcp.call"));
    assert.ok(observations.includes("patch.apply"));
    assert.ok(observations.includes("web.search"));
    assert.ok(observations.includes("subagent.lifecycle"));
    assert.ok(observations.includes("media.read"));
    assert.ok(
      harness.events().some(
        (event) =>
          event.type === "timeline.item.added" &&
          event.payload.item.kind === "compaction",
      ),
    );
  });

  test("rollout unknown future response items are visible but do not break conformance", () => {
    const harness = applyRolloutFixture([
      {
        timestamp: "2026-04-15T00:00:00.000Z",
        type: "response_item",
        payload: {
          type: "future_codex_item",
          id: "future-1",
          value: true,
        },
      },
    ]);

    harness.assertConforms();
    assert.ok(
      harness.events().some(
        (event) =>
          event.type === "observation.completed" &&
          event.payload.observation.kind === "runtime.invalid_stream" &&
          event.raw !== undefined,
      ),
    );
  });

  test("heuristic Codex fallback events preserve raw provider evidence", () => {
    const liveHarness = applyLiveFixture([
      { method: "turn/started", params: { turn: { id: "turn-future" } } },
      { method: "codex/event/new_future_event", params: { value: true } },
      { method: "turn/completed", params: { turn: { id: "turn-future", status: "completed" } } },
    ]);
    liveHarness.assertConforms({ requireTurnScopedWork: true });
    assert.equal(
      liveHarness
        .events()
        .filter((event) => event.source.authority === "heuristic")
        .every((event) => event.raw !== undefined),
      true,
    );

    const rolloutHarness = applyRolloutFixture([
      {
        timestamp: "2026-04-15T00:00:00.000Z",
        type: "response_item",
        payload: {
          type: "future_codex_item",
          id: "future-1",
          value: true,
        },
      },
    ]);
    rolloutHarness.assertConforms();
    assert.equal(
      rolloutHarness
        .events()
        .filter((event) => event.source.authority === "heuristic")
        .every((event) => event.raw !== undefined),
      true,
    );
  });

  test("rollout real command corpus classifies file, test, build, git, and patch work", () => {
    const commands = [
      {
        id: "read-1",
        command: ["sed", "-n", "1,200p", "tools/build/build_source_pybind.sh"],
        expectedKind: "file.read",
      },
      {
        id: "list-1",
        command: ["ls", "backend/app/services"],
        expectedKind: "file.list",
      },
      {
        id: "search-1",
        command: ["rg", "DataEncryption", "-n", "backend/app"],
        expectedKind: "file.search",
      },
      {
        id: "test-1",
        command: ["bash", "-lc", "cargo test -p solars-ipc"],
        expectedKind: "test.run",
      },
      {
        id: "build-1",
        command: ["bash", "-lc", "cargo check -p solars-ipc"],
        expectedKind: "build.run",
      },
      {
        id: "git-status-1",
        command: ["git", "status", "--short"],
        expectedKind: "git.status",
      },
      {
        id: "git-diff-1",
        command: ["git", "diff", "--", "src/demo.ts"],
        expectedKind: "git.diff",
      },
      {
        id: "patch-shell-1",
        command: [
          "apply_patch",
          "*** Begin Patch\n*** Update File: backend/app/core/dependencies.py\n@@\n-old\n+new\n*** End Patch",
        ],
        expectedKind: "patch.apply",
      },
    ] as const;

    const lines = commands.flatMap((entry, index) => [
      {
        timestamp: `2026-04-15T00:01:${String(index).padStart(2, "0")}.000Z`,
        type: "response_item",
        payload: {
          type: "function_call",
          name: "shell",
          call_id: entry.id,
          arguments: JSON.stringify({ command: entry.command, workdir: "/workspace/demo" }),
        },
      },
      {
        timestamp: `2026-04-15T00:02:${String(index).padStart(2, "0")}.000Z`,
        type: "response_item",
        payload: {
          type: "function_call_output",
          call_id: entry.id,
          output: "Process exited with code 0\nOutput:\nok",
        },
      },
    ]);

    const harness = applyRolloutFixture(lines);
    harness.assertConforms();
    assert.equal(harness.events().every(isCoreWorkbenchEvent), true);

    const startedKinds = harness.events().flatMap((event) =>
      event.type === "observation.started" ? [event.payload.observation.kind] : [],
    );
    assert.deepEqual(startedKinds, commands.map((entry) => entry.expectedKind));

    const patchTool = harness.events().find(
      (event) =>
        event.type === "tool.call.started" &&
        event.payload.toolCall.id === "patch-shell-1",
    );
    assert.equal(patchTool?.type, "tool.call.started");
    if (patchTool?.type === "tool.call.started") {
      assert.equal(patchTool.payload.toolCall.family, "patch");
    }
  });

  test("live errors, retries, usage, and attention stay within hapi/paseo boundary", () => {
    const retryHarness = applyLiveFixture([
      { method: "turn/started", params: { threadId: "thread-1", turn: { id: "turn-retry" } } },
      {
        method: "error",
        params: {
          threadId: "thread-1",
          turnId: "turn-retry",
          willRetry: true,
          error: { message: "transient upstream error" },
        },
      },
      {
        method: "thread/tokenUsage/updated",
        params: {
          threadId: "thread-1",
          turnId: "turn-retry",
          tokenUsage: {
            modelContextWindow: 1000,
            last: {
              totalTokens: 250,
            },
          },
        },
      },
      { method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-retry", status: "completed" } } },
    ]);
    retryHarness.assertConforms({ requireTurnScopedWork: true });
    assert.ok(
      retryHarness.events().some(
        (event) => event.type === "runtime.status" && event.payload.status === "retrying",
      ),
    );
    assert.ok(
      retryHarness.events().some(
        (event) => event.type === "usage.updated" && event.payload.usage.usedTokens === 250,
      ),
    );
    assert.equal(
      retryHarness.events().some((event) => event.type === "attention.required"),
      false,
    );

    const failedHarness = applyLiveFixture([
      { method: "turn/started", params: { threadId: "thread-1", turn: { id: "turn-failed" } } },
      {
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          turn: {
            id: "turn-failed",
            status: "failed",
            error: { message: "context window exceeded" },
          },
        },
      },
    ]);
    failedHarness.assertConforms({ requireTurnScopedWork: true });
    assert.ok(
      failedHarness.events().some(
        (event) =>
          event.type === "attention.required" &&
          event.payload.item.reason === "turn_failed",
      ),
    );
  });
});

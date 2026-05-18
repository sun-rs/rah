import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { TimelineRuntimeModel } from "@rah/runtime-protocol";
import type { FeedEntry } from "../../types";
import { buildAssistantTurnHeaders } from "./assistant-turn-headers";

const TS = "2026-05-12T00:00:00.000Z";

function userEntry(key: string, text: string): FeedEntry {
  return {
    key,
    kind: "timeline",
    item: { kind: "user_message", text },
    ts: TS,
  };
}

function assistantEntry(
  key: string,
  text: string,
  args: { turnId?: string; runtimeModel?: TimelineRuntimeModel } = {},
): FeedEntry {
  return {
    key,
    kind: "timeline",
    item: {
      kind: "assistant_message",
      text,
      ...(args.runtimeModel ? { runtimeModel: args.runtimeModel } : {}),
    },
    ts: TS,
    ...(args.turnId ? { turnId: args.turnId } : {}),
  };
}

function reasoningEntry(
  key: string,
  text: string,
  turnId?: string,
  runtimeModel?: TimelineRuntimeModel,
): FeedEntry {
  return {
    key,
    kind: "timeline",
    item: { kind: "reasoning", text, ...(runtimeModel ? { runtimeModel } : {}) },
    ts: TS,
    ...(turnId ? { turnId } : {}),
  };
}

function toolEntry(key: string, turnId: string): FeedEntry {
  return {
    key,
    kind: "tool_call",
    toolCall: {
      id: key,
      family: "shell",
      providerToolName: "bash",
      title: "Run command",
    },
    status: "running",
    ts: TS,
    turnId,
  };
}

describe("assistant turn headers", () => {
  test("places one header before the first assistant-owned item and backfills model from later bubbles", () => {
    const runtimeModel: TimelineRuntimeModel = {
      modelId: "deepseek/deepseek-v4-pro",
      optionId: "high",
      optionKind: "model_variant",
      source: "native",
    };
    const headers = buildAssistantTurnHeaders([
      userEntry("user-1", "Analyze this"),
      reasoningEntry("reasoning-1", "Thinking", "turn-1"),
      toolEntry("tool-1", "turn-1"),
      assistantEntry("assistant-1", "Answer", { turnId: "turn-1", runtimeModel }),
      assistantEntry("assistant-2", "Follow-up", { turnId: "turn-1" }),
    ]);

    assert.deepEqual(Array.from(headers.keys()), ["reasoning-1"]);
    assert.deepEqual(headers.get("reasoning-1"), runtimeModel);
  });

  test("uses user-message fallback grouping when provider turn ids are absent", () => {
    const headers = buildAssistantTurnHeaders([
      userEntry("user-1", "First"),
      reasoningEntry("reasoning-1", "Thinking"),
      assistantEntry("assistant-1", "Answer"),
      assistantEntry("assistant-2", "More"),
      userEntry("user-2", "Second"),
      assistantEntry("assistant-3", "Next"),
    ]);

    assert.deepEqual(Array.from(headers.keys()), ["reasoning-1", "assistant-3"]);
  });

  test("does not repeat headers when provider turn identities drift inside one visible reply segment", () => {
    const runtimeModel: TimelineRuntimeModel = {
      modelId: "claude-sonnet",
      source: "history",
    };
    const headers = buildAssistantTurnHeaders([
      userEntry("user-1", "First"),
      assistantEntry("assistant-1", "Part 1", { turnId: "turn-a", runtimeModel }),
      assistantEntry("assistant-2", "Part 2", { turnId: "turn-b" }),
      reasoningEntry("reasoning-1", "More thinking", "turn-c"),
    ]);

    assert.deepEqual(Array.from(headers.keys()), ["assistant-1"]);
    assert.deepEqual(headers.get("assistant-1"), runtimeModel);
  });

  test("uses runtime model from reasoning-only assistant segments", () => {
    const runtimeModel: TimelineRuntimeModel = {
      modelId: "aihubmix/grok-4.3",
      optionId: "high",
      optionKind: "model_variant",
      source: "native",
    };
    const headers = buildAssistantTurnHeaders([
      userEntry("user-1", "Inspect this"),
      reasoningEntry("reasoning-1", "Thinking", "turn-1", runtimeModel),
      toolEntry("tool-1", "turn-1"),
    ]);

    assert.deepEqual(Array.from(headers.keys()), ["reasoning-1"]);
    assert.deepEqual(headers.get("reasoning-1"), runtimeModel);
  });

  test("does not treat OpenCode internal system reminders as user turn boundaries", () => {
    const headers = buildAssistantTurnHeaders([
      userEntry("user-1", "First"),
      assistantEntry("assistant-1", "Part 1"),
      userEntry(
        "internal-reminder",
        [
          "<system-reminder>",
          "[BACKGROUND TASK COMPLETED]",
          "Use `background_output(task_id=\"bg_1\")` to retrieve this result when ready.",
          "</system-reminder>",
          "<!-- OMO_INTERNAL_INITIATOR -->",
        ].join("\n"),
      ),
      assistantEntry("assistant-2", "Part 2"),
    ]);

    assert.deepEqual(Array.from(headers.keys()), ["assistant-1"]);
  });

  test("keeps ordinary system-reminder user text as a real turn boundary", () => {
    const headers = buildAssistantTurnHeaders([
      userEntry("user-1", "First"),
      assistantEntry("assistant-1", "Part 1"),
      userEntry(
        "ordinary-reminder",
        [
          "<system-reminder>",
          "Treat this as a user-visible message for this test.",
          "</system-reminder>",
        ].join("\n"),
      ),
      assistantEntry("assistant-2", "Part 2"),
    ]);

    assert.deepEqual(Array.from(headers.keys()), ["assistant-1", "assistant-2"]);
  });

  test("does not create headers for runtime notices or user messages", () => {
    const headers = buildAssistantTurnHeaders([
      userEntry("user-1", "First"),
      {
        key: "runtime-1",
        kind: "runtime_status",
        status: "retrying",
        detail: "Reconnecting",
        retryCount: 1,
        ts: TS,
      },
      {
        key: "notification-1",
        kind: "notification",
        level: "info",
        title: "Info",
        body: "Body",
        ts: TS,
      },
    ]);

    assert.equal(headers.size, 0);
  });
});

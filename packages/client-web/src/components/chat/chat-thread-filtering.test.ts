import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { FeedEntry } from "../../types";
import { visibleFeedEntries } from "./chat-feed-filtering";

const TS = "2026-05-18T00:00:00.000Z";

function reasoningEntry(
  key: string,
  sourceProvider?: Extract<FeedEntry, { kind: "timeline" }>["sourceProvider"],
): FeedEntry {
  return {
    key,
    kind: "timeline",
    item: { kind: "reasoning", text: key },
    ts: TS,
    ...(sourceProvider ? { sourceProvider } : {}),
  };
}

function assistantEntry(key: string, sourceProvider?: Extract<FeedEntry, { kind: "timeline" }>["sourceProvider"]): FeedEntry {
  return {
    key,
    kind: "timeline",
    item: { kind: "assistant_message", text: key },
    ts: TS,
    ...(sourceProvider ? { sourceProvider } : {}),
  };
}

function toolEntry(
  key: string,
  status: Extract<FeedEntry, { kind: "tool_call" }>["status"],
): FeedEntry {
  return {
    key,
    kind: "tool_call",
    status,
    ts: TS,
    toolCall: {
      id: key.replace(/^tool:/, ""),
      family: "shell",
      providerToolName: "exec_command",
      title: "Run command",
    },
  };
}

function observationEntry(
  key: string,
  providerCallId: string,
  status: Extract<FeedEntry, { kind: "observation" }>["status"] = "completed",
): FeedEntry {
  return {
    key,
    kind: "observation",
    status,
    ts: TS,
    observation: {
      id: key.replace(/^obs:/, ""),
      kind: "command.run",
      status,
      title: "Run command",
      subject: { providerCallId },
    },
  };
}

describe("chat thread filtering", () => {
  test("hides OpenCode reasoning when its chat preference is enabled", () => {
    const entries = visibleFeedEntries(
      [
        reasoningEntry("opencode-reasoning", "opencode"),
        reasoningEntry("codex-reasoning", "codex"),
        reasoningEntry("gemini-reasoning", "gemini"),
        assistantEntry("opencode-answer", "opencode"),
      ],
      false,
      true,
    );

    assert.deepEqual(entries.map((entry) => entry.key), [
      "codex-reasoning",
      "gemini-reasoning",
      "opencode-answer",
    ]);
  });

  test("hides Gemini reasoning when its chat preference is enabled", () => {
    const entries = visibleFeedEntries(
      [
        reasoningEntry("gemini-reasoning", "gemini"),
        reasoningEntry("opencode-reasoning", "opencode"),
        assistantEntry("gemini-answer", "gemini"),
      ],
      false,
      false,
      true,
    );

    assert.deepEqual(entries.map((entry) => entry.key), [
      "opencode-reasoning",
      "gemini-answer",
    ]);
  });

  test("uses the session provider as a fallback for older reasoning entries", () => {
    const entries = visibleFeedEntries(
      [reasoningEntry("legacy-reasoning"), assistantEntry("answer")],
      false,
      true,
      false,
      "opencode",
    );

    assert.deepEqual(entries.map((entry) => entry.key), ["answer"]);
  });

  test("uses the Gemini session provider as a fallback for older reasoning entries", () => {
    const entries = visibleFeedEntries(
      [reasoningEntry("legacy-reasoning"), assistantEntry("answer")],
      false,
      false,
      true,
      "gemini",
    );

    assert.deepEqual(entries.map((entry) => entry.key), ["answer"]);
  });

  test("keeps OpenCode reasoning when the chat preference is disabled", () => {
    const entries = visibleFeedEntries([reasoningEntry("opencode-reasoning", "opencode")], false);

    assert.deepEqual(entries.map((entry) => entry.key), ["opencode-reasoning"]);
  });

  test("hides only completed tool calls when the tool preference is enabled", () => {
    const entries = visibleFeedEntries(
      [
        toolEntry("tool:done", "completed"),
        toolEntry("tool:running", "running"),
        toolEntry("tool:failed", "failed"),
      ],
      true,
    );

    assert.deepEqual(entries.map((entry) => entry.key), [
      "tool:running",
      "tool:failed",
    ]);
  });

  test("hides completed tool-backed observations while preserving active ones", () => {
    const entries = visibleFeedEntries(
      [
        observationEntry("obs:done", "done", "completed"),
        observationEntry("obs:running", "running", "running"),
        observationEntry("obs:failed", "failed", "failed"),
      ],
      true,
    );

    assert.deepEqual(entries.map((entry) => entry.key), [
      "obs:running",
      "obs:failed",
    ]);
  });

  test("hides tool-backed observations when their tool card is present", () => {
    const entries = visibleFeedEntries(
      [
        toolEntry("tool:cmd-1", "running"),
        observationEntry("obs:cmd-1", "cmd-1", "running"),
      ],
      false,
    );

    assert.deepEqual(entries.map((entry) => entry.key), ["tool:cmd-1"]);
  });
});

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { FeedEntry } from "../../types";
import { copyableAssistantMessageKeys } from "./assistant-copy-actions";

const TS = "2026-07-09T00:00:00.000Z";

function userEntry(key: string, text = key): FeedEntry {
  return {
    key,
    kind: "timeline",
    item: { kind: "user_message", text },
    ts: TS,
  };
}

function assistantEntry(
  key: string,
  phase?: "commentary" | "final_answer",
): FeedEntry {
  return {
    key,
    kind: "timeline",
    item: { kind: "assistant_message", text: key, ...(phase ? { phase } : {}) },
    ts: TS,
  };
}

function toolEntry(key: string): FeedEntry {
  return {
    key,
    kind: "tool_call",
    status: "completed",
    ts: TS,
    toolCall: {
      id: key,
      family: "shell",
      providerToolName: "exec_command",
      title: "Run command",
    },
  };
}

describe("assistant copy actions", () => {
  test("shows whole-reply copy only on the last assistant message in a user turn", () => {
    const keys = copyableAssistantMessageKeys([
      userEntry("question"),
      assistantEntry("compile-started"),
      toolEntry("cargo-test"),
      assistantEntry("tests-running"),
      assistantEntry("final-answer"),
    ]);

    assert.deepEqual(Array.from(keys), ["final-answer"]);
  });

  test("suppresses the active turn while generation is still running", () => {
    const keys = copyableAssistantMessageKeys(
      [
        userEntry("question"),
        assistantEntry("compile-started"),
        assistantEntry("tests-running"),
      ],
      { generationActive: true },
    );

    assert.deepEqual(Array.from(keys), []);
  });

  test("uses explicit Codex phases instead of promoting commentary to a final reply", () => {
    const keys = copyableAssistantMessageKeys([
      userEntry("question"),
      assistantEntry("commentary", "commentary"),
      assistantEntry("final-answer", "final_answer"),
      assistantEntry("late-commentary", "commentary"),
    ]);

    assert.deepEqual(Array.from(keys), ["final-answer"]);
  });

  test("keeps previous completed turns copyable while a new user turn is thinking", () => {
    const keys = copyableAssistantMessageKeys(
      [
        userEntry("question-1"),
        assistantEntry("answer-1"),
        userEntry("question-2"),
      ],
      { generationActive: true },
    );

    assert.deepEqual(Array.from(keys), ["answer-1"]);
  });

  test("does not treat internal reminders as new user turns", () => {
    const keys = copyableAssistantMessageKeys([
      userEntry("question"),
      assistantEntry("process"),
      userEntry(
        "internal-reminder",
        [
          "<system-reminder>",
          "[BACKGROUND TASK COMPLETED]",
          "</system-reminder>",
          "<!-- OMO_INTERNAL_INITIATOR -->",
        ].join("\n"),
      ),
      assistantEntry("final-answer"),
    ]);

    assert.deepEqual(Array.from(keys), ["final-answer"]);
  });
});

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { FeedEntry } from "../../types";
import {
  buildProcessDetailRows,
  formatAssistantProcessDuration,
} from "./assistant-process-groups";

function assistant(
  key: string,
  ts: string,
  phase?: "commentary" | "final_answer",
): FeedEntry {
  return {
    key,
    kind: "timeline",
    item: { kind: "assistant_message", text: key, ...(phase ? { phase } : {}) },
    ts,
    turnId: "turn-1",
  };
}

function command(key: string, status: "running" | "completed" | "failed" = "completed"): FeedEntry {
  return {
    key,
    kind: "tool_call",
    status,
    ts: "2026-07-10T00:00:02.000Z",
    turnId: "turn-1",
    toolCall: {
      id: key,
      family: "shell",
      providerToolName: "exec_command",
      title: "Run command",
      result: { exitCode: status === "failed" ? 1 : 0 },
    },
  };
}

function reasoning(key: string, text = key): FeedEntry {
  return {
    key,
    kind: "timeline",
    item: { kind: "reasoning", text },
    ts: "2026-07-10T00:00:02.000Z",
    turnId: "turn-1",
  };
}

describe("assistant process groups", () => {
  test("groups consecutive commands and treats a non-zero result as reviewable", () => {
    const rows = buildProcessDetailRows([
      command("command-1"),
      command("command-2", "failed"),
      assistant("commentary", "2026-07-10T00:00:03.000Z", "commentary"),
    ]);

    assert.equal(rows[0]?.kind, "activity_batch");
    if (rows[0]?.kind === "activity_batch") {
      assert.equal(rows[0].activityKind, "command");
      assert.equal(rows[0].entries.length, 2);
      assert.equal(rows[0].failureCount, 0);
      assert.equal(rows[0].issueCount, 1);
    }
    assert.equal(rows[1]?.kind, "entry");
  });

  test("groups consecutive reasoning summaries into one expandable row", () => {
    const rows = buildProcessDetailRows([
      reasoning("reasoning-1", "Inspecting"),
      reasoning("reasoning-2", "Planning"),
      reasoning("reasoning-3", "Inspecting"),
      assistant("commentary", "2026-07-10T00:00:03.000Z", "commentary"),
    ]);

    assert.equal(rows[0]?.kind, "reasoning_batch");
    if (rows[0]?.kind === "reasoning_batch") {
      assert.equal(rows[0].count, 3);
      assert.equal(rows[0].entry.kind, "timeline");
      if (rows[0].entry.kind === "timeline" && rows[0].entry.item.kind === "reasoning") {
        assert.equal(rows[0].entry.item.text, "Inspecting\n\nPlanning");
      }
    }
    assert.equal(rows[1]?.kind, "entry");
  });

  test("formats compact elapsed time", () => {
    assert.equal(formatAssistantProcessDuration(72_655), "1m 12s");
    assert.equal(formatAssistantProcessDuration(9_900), "9s");
    assert.equal(formatAssistantProcessDuration(undefined), null);
  });
});

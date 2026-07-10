import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { FeedEntry } from "../../types";
import {
  buildAssistantProcessRows,
  buildProcessDetailRows,
  formatAssistantProcessDuration,
} from "./assistant-process-groups";

function user(key: string, ts: string): FeedEntry {
  return { key, kind: "timeline", item: { kind: "user_message", text: key }, ts };
}

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
  test("uses Codex phases to fold commentary and tools while keeping the final answer visible", () => {
    const rows = buildAssistantProcessRows(
      [
        user("question", "2026-07-10T00:00:00.000Z"),
        assistant("preamble", "2026-07-10T00:00:01.000Z", "commentary"),
        command("command-1"),
        assistant("final", "2026-07-10T00:01:12.655Z", "final_answer"),
      ],
      { finalAssistantKeys: new Set(), generationActive: false },
    );

    assert.deepEqual(rows.map((row) => row.kind), [
      "feed_entry",
      "assistant_process_group",
      "feed_entry",
    ]);
    const group = rows[1];
    assert.equal(group?.kind, "assistant_process_group");
    if (group?.kind === "assistant_process_group") {
      assert.deepEqual(group.entries.map((entry) => entry.key), ["preamble", "command-1"]);
      assert.equal(group.completed, true);
      assert.equal(group.active, false);
      assert.equal(group.durationMs, 72_655);
    }
  });

  test("falls back to the last assistant message when a provider has no phase", () => {
    const rows = buildAssistantProcessRows(
      [
        user("question", "2026-07-10T00:00:00.000Z"),
        assistant("progress", "2026-07-10T00:00:01.000Z"),
        assistant("answer", "2026-07-10T00:00:02.000Z"),
      ],
      { finalAssistantKeys: new Set(["answer"]), generationActive: false },
    );

    assert.equal(rows[1]?.kind, "assistant_process_group");
    assert.equal(rows[2]?.kind, "feed_entry");
    if (rows[2]?.kind === "feed_entry") {
      assert.equal(rows[2].entry.key, "answer");
    }
  });

  test("keeps the current process group active while generation is running", () => {
    const rows = buildAssistantProcessRows(
      [
        user("question", "2026-07-10T00:00:00.000Z"),
        assistant("progress", "2026-07-10T00:00:01.000Z", "commentary"),
      ],
      { finalAssistantKeys: new Set(), generationActive: true },
    );

    assert.equal(rows[1]?.kind, "assistant_process_group");
    if (rows[1]?.kind === "assistant_process_group") {
      assert.equal(rows[1].completed, false);
      assert.equal(rows[1].active, true);
      assert.equal(rows[1].durationMs, undefined);
    }
  });

  test("keeps commentary expanded when runtime activity settles without a final answer", () => {
    const rows = buildAssistantProcessRows(
      [
        user("question", "2026-07-10T00:00:00.000Z"),
        assistant("progress", "2026-07-10T00:00:01.000Z", "commentary"),
      ],
      { finalAssistantKeys: new Set(), generationActive: false },
    );

    assert.equal(rows[1]?.kind, "assistant_process_group");
    if (rows[1]?.kind === "assistant_process_group") {
      assert.equal(rows[1].completed, false);
      assert.equal(rows[1].active, false);
    }
  });

  test("allows folding as soon as the final answer arrives despite lagging runtime state", () => {
    const rows = buildAssistantProcessRows(
      [
        user("question", "2026-07-10T00:00:00.000Z"),
        assistant("progress", "2026-07-10T00:00:01.000Z", "commentary"),
        assistant("final", "2026-07-10T00:00:03.000Z", "final_answer"),
      ],
      { finalAssistantKeys: new Set(), generationActive: true },
    );

    assert.equal(rows[1]?.kind, "assistant_process_group");
    if (rows[1]?.kind === "assistant_process_group") {
      assert.equal(rows[1].completed, true);
      assert.equal(rows[1].active, false);
      assert.equal(rows[1].durationMs, 3_000);
    }
  });

  test("groups consecutive commands and exposes a failed batch status", () => {
    const rows = buildProcessDetailRows([
      command("command-1"),
      command("command-2", "failed"),
      assistant("commentary", "2026-07-10T00:00:03.000Z", "commentary"),
    ]);

    assert.equal(rows[0]?.kind, "command_batch");
    if (rows[0]?.kind === "command_batch") {
      assert.equal(rows[0].entries.length, 2);
      assert.equal(rows[0].status, "failed");
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

import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CodexTurnDirectoryStore } from "./codex-turn-directory";
import { readCodexTurnHistory } from "./codex-turn-history";
import type { CodexStoredSessionRecord } from "./codex-stored-session-types";

function line(timestamp: string, type: string, payload: Record<string, unknown>): string {
  return JSON.stringify({ timestamp, type, payload });
}

function taskStarted(timestamp: string, turnId: string): string {
  return line(timestamp, "event_msg", { type: "task_started", turn_id: turnId });
}

function userMessage(timestamp: string, text: string): string {
  return line(timestamp, "event_msg", { type: "user_message", message: text });
}

function agentMessage(timestamp: string, text: string, phase: string): string {
  return line(timestamp, "event_msg", { type: "agent_message", message: text, phase });
}

function recordFor(filePath: string, providerSessionId = "codex-thread-1"): CodexStoredSessionRecord {
  return {
    ref: {
      provider: "codex",
      providerSessionId,
      cwd: "/tmp/project",
      rootDir: "/tmp/project",
      title: "Test thread",
      source: "provider_history",
    },
    rolloutPath: filePath,
    archived: false,
  };
}

test("Codex turn directory scans incrementally and applies rollback markers", async () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "rah-turn-directory-"));
  const previousRahHome = process.env.RAH_HOME;
  process.env.RAH_HOME = path.join(tempDir, "rah-home");
  const rolloutPath = path.join(tempDir, "rollout.jsonl");
  const firstRows = [
    taskStarted("2026-07-10T00:00:00.000Z", "turn-1"),
    line("2026-07-10T00:00:00.001Z", "response_item", {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "<environment_context>ignored</environment_context>" }],
    }),
    line("2026-07-10T00:00:00.002Z", "response_item", {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "First question" }],
    }),
    userMessage("2026-07-10T00:00:00.003Z", "First question"),
    line("2026-07-10T00:00:00.500Z", "response_item", {
      type: "function_call_output",
      call_id: "large-tool-output",
      output: "x".repeat(3 * 1024 * 1024),
    }),
    agentMessage("2026-07-10T00:00:01.000Z", "Checking", "commentary"),
    agentMessage("2026-07-10T00:00:02.000Z", "First answer", "final_answer"),
    line("2026-07-10T00:00:02.010Z", "event_msg", {
      type: "task_complete",
      turn_id: "turn-1",
      last_agent_message: "First answer",
      completed_at: 1_783_641_602,
      duration_ms: 2_010,
    }),
    taskStarted("2026-07-10T00:01:00.000Z", "turn-2"),
    userMessage("2026-07-10T00:01:00.001Z", "Second question"),
    line("2026-07-10T00:01:01.000Z", "event_msg", {
      type: "turn_aborted",
      turn_id: "turn-2",
      reason: "interrupted",
      completed_at: 1_783_641_661,
      duration_ms: 1_000,
    }),
  ];
  writeFileSync(rolloutPath, `${firstRows.join("\n")}\n`);
  const store = new CodexTurnDirectoryStore();
  try {
    const record = recordFor(rolloutPath);
    const first = await store.getDirectory("rah-session-1", record);
    assert.equal(first.complete, true);
    assert.deepEqual(
      first.items.map((item) => ({
        id: item.id,
        user: item.userPreview,
        assistant: item.assistantPreview,
        status: item.status,
      })),
      [
        {
          id: "turn-1",
          user: "First question",
          assistant: "First answer",
          status: "completed",
        },
        {
          id: "turn-2",
          user: "Second question",
          assistant: undefined,
          status: "interrupted",
        },
      ],
    );

    appendFileSync(
      rolloutPath,
      `${[
        taskStarted("2026-07-10T00:02:00.000Z", "turn-3"),
        userMessage("2026-07-10T00:02:00.001Z", "Rolled back question"),
        agentMessage("2026-07-10T00:02:01.000Z", "Rolled back answer", "final_answer"),
        line("2026-07-10T00:02:01.001Z", "event_msg", {
          type: "task_complete",
          turn_id: "turn-3",
          last_agent_message: "Rolled back answer",
        }),
        line("2026-07-10T00:02:02.000Z", "event_msg", {
          type: "thread_rolled_back",
          num_turns: 1,
        }),
      ].join("\n")}\n`,
    );
    const second = await store.getDirectory("rah-session-1", record);
    assert.deepEqual(second.items.map((item) => item.id), ["turn-1", "turn-2"]);
    assert.notEqual(second.revision, first.revision);

    const range = await store.getTurnRange(record, "turn-1");
    assert.ok(range);
    const turn = await readCodexTurnHistory({
      sessionId: "rah-session-1",
      turnId: "turn-1",
      record,
      range,
    });
    const timelineTexts = turn.events.flatMap((event) => {
      if (event.type !== "timeline.item.added" && event.type !== "timeline.item.updated") {
        return [];
      }
      const item = event.payload.item;
      return item.kind === "user_message" || item.kind === "assistant_message"
        ? [item.text]
        : [];
    });
    assert.ok(timelineTexts.includes("First question"), JSON.stringify(turn.events));
    assert.ok(timelineTexts.includes("First answer"), JSON.stringify(turn.events));
    assert.equal(timelineTexts.includes("Second question"), false);
    assert.equal(turn.events.every((event) => event.turnId === "turn-1"), true);
    assert.equal(
      turn.events.every((event) => {
        if (event.type !== "timeline.item.added" && event.type !== "timeline.item.updated") {
          return true;
        }
        return event.payload.identity?.turnKey === "turn:turn-1";
      }),
      true,
    );
  } finally {
    await store.shutdown();
    if (previousRahHome === undefined) {
      delete process.env.RAH_HOME;
    } else {
      process.env.RAH_HOME = previousRahHome;
    }
    rmSync(tempDir, { recursive: true, force: true });
  }
});

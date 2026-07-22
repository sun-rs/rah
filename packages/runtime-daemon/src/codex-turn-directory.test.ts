import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CodexTurnDirectoryStore } from "./codex-turn-directory";
import { readCodexConversationTurnDetail } from "./codex-turn-history";
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
    line("2026-07-10T00:00:00.400Z", "response_item", {
      type: "function_call",
      name: "exec_command",
      arguments: '{"cmd":"echo hello","workdir":"/tmp/project"}',
      call_id: "large-tool-output",
    }),
    line("2026-07-10T00:00:00.500Z", "response_item", {
      type: "function_call_output",
      call_id: "large-tool-output",
      output: "x".repeat(3 * 1024 * 1024),
    }),
    line("2026-07-10T00:00:00.600Z", "event_msg", {
      type: "web_search_end",
      call_id: "search-turn-1",
      action: { type: "search", queries: ["turn detail sources"] },
      results: [
        { type: "text_result", title: "Source", url: "https://example.com/source" },
      ],
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
    const turn = await readCodexConversationTurnDetail({
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

    const detail = await readCodexConversationTurnDetail({
      sessionId: "rah-session-1",
      turnId: "turn-1",
      record,
      range,
    });
    const detailJson = JSON.stringify(detail);
    assert.equal(
      detail.events.some((event) => event.type.startsWith("tool.call.")),
      true,
      detailJson,
    );
    assert.equal(
      detail.events.some(
        (event) =>
          event.type === "observation.completed" &&
          event.payload.observation.subject?.urls?.includes("https://example.com/source"),
      ),
      true,
      detailJson,
    );
    assert.equal(detailJson.includes("Checking"), true);
    assert.equal(detailJson.includes("x".repeat(4_096)), false);
    assert.ok((detail.approximateBytes ?? Number.POSITIVE_INFINITY) < 64 * 1024);
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

test("Codex turn directory bounds navigation previews independently from turn detail", async () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "rah-turn-directory-preview-"));
  const previousRahHome = process.env.RAH_HOME;
  process.env.RAH_HOME = path.join(tempDir, "rah-home");
  const rolloutPath = path.join(tempDir, "rollout.jsonl");
  writeFileSync(
    rolloutPath,
    `${[
      taskStarted("2026-07-10T00:00:00.000Z", "turn-preview"),
      userMessage("2026-07-10T00:00:00.001Z", `user-${"u".repeat(300)}`),
      agentMessage("2026-07-10T00:00:01.000Z", `assistant-${"a".repeat(500)}`, "final_answer"),
    ].join("\n")}\n`,
  );
  const store = new CodexTurnDirectoryStore();
  try {
    const directory = await store.getDirectory("rah-session-preview", recordFor(rolloutPath));
    assert.equal(directory.items.length, 1);
    assert.ok((directory.items[0]?.userPreview.length ?? 0) <= 96);
    assert.ok((directory.items[0]?.assistantPreview?.length ?? 0) <= 144);
    assert.equal(JSON.stringify(directory).includes(`user-${"u".repeat(300)}`), false);
    assert.equal(JSON.stringify(directory).includes(`assistant-${"a".repeat(500)}`), false);
    const summary = await store.getSummaryPage(recordFor(rolloutPath), {
      limit: 1,
      sourceSettled: false,
    });
    const turn = summary.data[0] as {
      items: Array<{ type: string; content?: Array<{ text?: string }>; text?: string }>;
    };
    assert.equal(turn.items[0]?.content?.[0]?.text, `user-${"u".repeat(300)}`);
    assert.equal(turn.items[1]?.text, `assistant-${"a".repeat(500)}`);
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

test("Codex indexed summary pages keep official cursor boundaries stable across appends", async () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "rah-turn-summary-page-"));
  const previousRahHome = process.env.RAH_HOME;
  process.env.RAH_HOME = path.join(tempDir, "rah-home");
  const rolloutPath = path.join(tempDir, "rollout.jsonl");
  const completedTurn = (minute: number, turnId: string, question: string, answer: string) => [
    taskStarted(`2026-07-10T00:${String(minute).padStart(2, "0")}:00.000Z`, turnId),
    userMessage(`2026-07-10T00:${String(minute).padStart(2, "0")}:00.001Z`, question),
    agentMessage(`2026-07-10T00:${String(minute).padStart(2, "0")}:01.000Z`, answer, "final_answer"),
    line(`2026-07-10T00:${String(minute).padStart(2, "0")}:01.001Z`, "event_msg", {
      type: "task_complete",
      turn_id: turnId,
      last_agent_message: answer,
    }),
  ];
  writeFileSync(
    rolloutPath,
    `${[
      ...completedTurn(0, "turn-1", "Question one", "Answer one"),
      ...completedTurn(1, "turn-2", "Question two", "Answer two"),
      ...completedTurn(2, "turn-3", "Question three", "Answer three"),
    ].join("\n")}\n`,
  );
  const store = new CodexTurnDirectoryStore();
  try {
    const record = recordFor(rolloutPath);
    const latest = await store.getSummaryPage(record, { limit: 2, sourceSettled: true });
    assert.deepEqual(
      latest.data.map((turn) => (turn as { id: string }).id),
      ["turn-3", "turn-2"],
    );
    assert.ok(latest.nextCursor);

    appendFileSync(
      rolloutPath,
      `${completedTurn(3, "turn-4", "Question four", "Answer four").join("\n")}\n`,
    );
    const older = await store.getSummaryPage(record, {
      cursor: latest.nextCursor ?? undefined,
      limit: 2,
      sourceSettled: true,
    });
    assert.deepEqual(
      older.data.map((turn) => (turn as { id: string }).id),
      ["turn-1"],
    );
    assert.equal(older.nextCursor, null);
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

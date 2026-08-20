import assert from "node:assert/strict";
import {
  appendFileSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type {
  ConversationEvidencePage,
  RahEvent,
} from "@rah/runtime-protocol";
import {
  boundClaudeSummaryPage,
  buildClaudeHistorySummaryPage,
} from "./claude-history-page-worker";
import { readClaudeStoredSessionTurnWindow } from "./claude-session-files";

function event(args: {
  seq: number;
  turnId: string;
  type: RahEvent["type"];
  payload: unknown;
}): RahEvent {
  return {
    id: `event-${args.seq}`,
    sessionId: "session-1",
    seq: args.seq,
    ts: new Date(args.seq * 1000).toISOString(),
    type: args.type,
    source: {
      provider: "claude",
      channel: "structured_persisted",
      authority: "derived",
    },
    turnId: args.turnId,
    payload: args.payload,
  } as RahEvent;
}

function timelineEvent(args: {
  seq: number;
  turnId: string;
  kind: "user_message" | "assistant_message" | "reasoning";
  text: string;
  phase?: "commentary" | "final_answer";
}): RahEvent {
  return event({
    seq: args.seq,
    turnId: args.turnId,
    type: "timeline.item.added",
    payload: {
      item: {
        kind: args.kind,
        text: args.text,
        ...(args.phase ? { phase: args.phase } : {}),
      },
    },
  });
}

function claudeTurn(index: number, payloadBytes = 0): unknown[] {
  return [
    {
      type: "user",
      uuid: `user-${index}`,
      sessionId: "provider-session-1",
      timestamp: new Date(index * 2000).toISOString(),
      message: { content: `question ${index}` },
    },
    {
      type: "assistant",
      uuid: `assistant-${index}`,
      sessionId: "provider-session-1",
      timestamp: new Date(index * 2000 + 1000).toISOString(),
      message: {
        content: [
          {
            type: "text",
            text: `answer ${index}${payloadBytes ? ` ${"x".repeat(payloadBytes)}` : ""}`,
          },
        ],
        stop_reason: "end_turn",
      },
    },
  ];
}

function userMessages(page: ConversationEvidencePage): string[] {
  return page.events.flatMap((entry) => {
    if (
      entry.type === "timeline.item.added" &&
      entry.payload.item.kind === "user_message"
    ) {
      return [entry.payload.item.text];
    }
    return [];
  });
}

function withClaudeTranscript(
  turns: number,
  run: (args: { filePath: string; record: Parameters<typeof buildClaudeHistorySummaryPage>[0]["record"] }) => void,
): void {
  const root = mkdtempSync(path.join(os.tmpdir(), "rah-claude-page-worker-"));
  const filePath = path.join(root, "provider-session-1.jsonl");
  const records = Array.from({ length: turns }, (_, index) =>
    claudeTurn(index + 1),
  ).flat();
  writeFileSync(
    filePath,
    `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
  );
  try {
    run({
      filePath,
      record: {
        filePath,
        ref: {
          provider: "claude",
          providerSessionId: "provider-session-1",
          source: "provider_history",
        },
      },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("Claude summary cursors page by frozen byte boundary across fresh workers and appends", () => {
  withClaudeTranscript(100, ({ filePath, record }) => {
    const initial = buildClaudeHistorySummaryPage({
      kind: "claude-history-summary-page",
      sessionId: "rah-session-1",
      record,
      limit: 3,
    });
    assert.deepEqual(userMessages(initial), ["question 98", "question 99", "question 100"]);
    assert.ok(initial.nextCursor);

    appendFileSync(
      filePath,
      `${claudeTurn(101).map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    );
    const older = buildClaudeHistorySummaryPage({
      kind: "claude-history-summary-page",
      sessionId: "rah-session-1",
      record,
      cursor: initial.nextCursor,
      limit: 3,
    });
    assert.deepEqual(userMessages(older), ["question 95", "question 96", "question 97"]);
    assert.equal(
      new Set([...userMessages(initial), ...userMessages(older)]).size,
      6,
    );
  });
});

test("Claude turn windows read page-local bytes instead of the complete transcript", () => {
  withClaudeTranscript(12_000, ({ filePath, record }) => {
    const page = readClaudeStoredSessionTurnWindow({
      sessionId: "rah-session-1",
      record,
      endOffset: statSync(filePath).size,
      limit: 20,
    });
    const fileBytes = statSync(filePath).size;
    assert.ok(page.nextEndOffset !== undefined);
    assert.ok(
      page.bytesRead < fileBytes / 10,
      `expected page-local reads, got ${page.bytesRead} of ${fileBytes} bytes`,
    );
  });
});

test("history response budgets drop complete old turns instead of partial event prefixes", () => {
  let seq = 1;
  const oldTurnId = "turn-old";
  const newTurnId = "turn-new";
  const events: RahEvent[] = [
    event({ seq: seq++, turnId: oldTurnId, type: "turn.started", payload: {} }),
    timelineEvent({
      seq: seq++,
      turnId: oldTurnId,
      kind: "user_message",
      text: "old question",
    }),
    ...Array.from({ length: 5 }, (_, index) =>
      timelineEvent({
        seq: seq++,
        turnId: oldTurnId,
        kind: "reasoning",
        text: `${index}:${"x".repeat(40 * 1024)}`,
      }),
    ),
    timelineEvent({
      seq: seq++,
      turnId: oldTurnId,
      kind: "assistant_message",
      text: "old answer",
      phase: "final_answer",
    }),
    event({ seq: seq++, turnId: oldTurnId, type: "turn.completed", payload: {} }),
    event({ seq: seq++, turnId: newTurnId, type: "turn.started", payload: {} }),
    timelineEvent({
      seq: seq++,
      turnId: newTurnId,
      kind: "user_message",
      text: "new question",
    }),
    timelineEvent({
      seq: seq++,
      turnId: newTurnId,
      kind: "assistant_message",
      text: "new answer",
      phase: "final_answer",
    }),
    event({ seq: seq++, turnId: newTurnId, type: "turn.completed", payload: {} }),
  ];
  const page = boundClaudeSummaryPage(
    { sessionId: "session-1", events },
    64 * 1024,
  );

  assert.deepEqual(
    [...new Set(page.events.map((entry) => entry.turnId))],
    [newTurnId],
  );
  assert.ok(page.nextCursor, "dropped complete turns must remain pageable");
  assert.ok((page.approximateBytes ?? Infinity) <= 64 * 1024);
});

test("one oversized turn retains its semantic envelope without inventing a cursor", () => {
  let seq = 1;
  const turnId = "turn-large";
  const events: RahEvent[] = [
    event({ seq: seq++, turnId, type: "turn.started", payload: {} }),
    timelineEvent({
      seq: seq++,
      turnId,
      kind: "user_message",
      text: `question:${"q".repeat(80 * 1024)}`,
    }),
    ...Array.from({ length: 8 }, (_, index) =>
      timelineEvent({
        seq: seq++,
        turnId,
        kind: "reasoning",
        text: `${index}:${"r".repeat(48 * 1024)}`,
      }),
    ),
    timelineEvent({
      seq: seq++,
      turnId,
      kind: "assistant_message",
      text: `answer:${"a".repeat(80 * 1024)}`,
      phase: "final_answer",
    }),
    event({ seq: seq++, turnId, type: "turn.completed", payload: {} }),
  ];
  const source: ConversationEvidencePage = {
    sessionId: "session-1",
    events,
    nextCursor: "provider-older-page",
  };
  const page = boundClaudeSummaryPage(source, 64 * 1024);
  const timelineKinds = page.events.flatMap((entry) => {
    if (entry.type !== "timeline.item.added") {
      return [];
    }
    return [entry.payload.item.kind];
  });

  assert.ok(page.events.some((entry) => entry.type === "turn.started"));
  assert.ok(timelineKinds.includes("user_message"));
  assert.ok(timelineKinds.includes("assistant_message"));
  assert.ok(page.events.some((entry) => entry.type === "turn.completed"));
  assert.equal(page.nextCursor, "provider-older-page");
  assert.ok((page.approximateBytes ?? Infinity) <= 64 * 1024);
});

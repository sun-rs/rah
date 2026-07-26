import assert from "node:assert/strict";
import test from "node:test";
import type {
  ConversationEvidencePage,
  RahEvent,
} from "@rah/runtime-protocol";
import { boundClaudeSummaryPage } from "./claude-history-page-worker";

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

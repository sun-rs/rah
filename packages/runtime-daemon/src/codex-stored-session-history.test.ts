import { test } from "node:test";
import assert from "node:assert/strict";
import type { RahEvent } from "@rah/runtime-protocol";
import {
  collapseDuplicateCodexTimelineEvents,
  translateCodexRolloutWindowToHistoryEvents,
} from "./codex-stored-session-history";
import {
  CODEX_CONTEXT_COMPACTION_AGGREGATE_ITEM_KEY,
  createCodexAggregateTimelineIdentity,
} from "./codex-timeline-identity";

const SOURCE = {
  provider: "codex" as const,
  channel: "structured_persisted" as const,
  authority: "authoritative" as const,
};

function compactionEvent(args: {
  id: string;
  seq: number;
  turnId: string;
  eventType?: "timeline.item.added" | "timeline.item.updated";
  status: "started" | "completed";
  count?: number;
  canonicalItemId?: string;
}): RahEvent {
  const identity = args.canonicalItemId
    ? {
        canonicalItemId: args.canonicalItemId,
        canonicalTurnId: `codex:session-1:${args.turnId}`,
        provider: "codex" as const,
        providerSessionId: "session-1",
        turnKey: args.turnId,
        itemKind: "compaction",
        itemKey: args.canonicalItemId,
        origin: "history" as const,
        confidence: "derived" as const,
      }
    : undefined;
  return {
    id: args.id,
    seq: args.seq,
    ts: `2026-07-19T00:00:${String(args.seq).padStart(2, "0")}.000Z`,
    sessionId: "rah-session-1",
    turnId: args.turnId,
    type: args.eventType ?? "timeline.item.added",
    source: SOURCE,
    payload: {
      item: {
        kind: "compaction",
        status: args.status,
        ...(args.count !== undefined ? { count: args.count } : {}),
      },
      ...(identity ? { identity } : {}),
    },
  } as RahEvent;
}

function completedTurnEvent(turnId: string, seq: number): RahEvent {
  return {
    id: `turn-completed-${turnId}`,
    seq,
    ts: `2026-07-19T00:01:${String(seq).padStart(2, "0")}.000Z`,
    sessionId: "rah-session-1",
    turnId,
    type: "turn.completed",
    source: SOURCE,
    payload: {},
  };
}

test("collapses legacy compaction events into one completed summary per turn", () => {
  const collapsed = collapseDuplicateCodexTimelineEvents(
    [
      compactionEvent({
        id: "compaction-1",
        seq: 1,
        turnId: "turn-1",
        status: "started",
        canonicalItemId: "canonical-compaction-1",
      }),
      compactionEvent({
        id: "compaction-2",
        seq: 2,
        turnId: "turn-1",
        status: "started",
        canonicalItemId: "canonical-compaction-2",
      }),
      completedTurnEvent("turn-1", 3),
      compactionEvent({
        id: "compaction-3",
        seq: 4,
        turnId: "turn-2",
        status: "completed",
        canonicalItemId: "canonical-compaction-3",
      }),
    ],
    { providerSessionId: "session-1" },
  );

  const compactions = collapsed.filter(
    (event) =>
      (event.type === "timeline.item.added" || event.type === "timeline.item.updated") &&
      event.payload.item.kind === "compaction",
  );
  assert.equal(compactions.length, 2);
  if (
    compactions[0]?.type !== "timeline.item.added" ||
    compactions[0].payload.item.kind !== "compaction" ||
    compactions[1]?.type !== "timeline.item.added" ||
    compactions[1].payload.item.kind !== "compaction"
  ) {
    assert.fail("expected two retained compaction timeline items");
  }
  assert.deepEqual(compactions[0].payload.item, {
    kind: "compaction",
    status: "completed",
    count: 2,
  });
  assert.deepEqual(compactions[1].payload.item, {
    kind: "compaction",
    status: "completed",
    count: 1,
  });
  const expectedTurnOneIdentity = createCodexAggregateTimelineIdentity({
    providerSessionId: "session-1",
    turnId: "turn-1",
    itemKind: "compaction",
    itemKey: CODEX_CONTEXT_COMPACTION_AGGREGATE_ITEM_KEY,
    origin: "history",
  });
  assert.equal(
    compactions[0].payload.identity?.canonicalItemId,
    expectedTurnOneIdentity.canonicalItemId,
  );
});

test("uses the same aggregate identity for live and stored compactions", () => {
  const liveIdentity = createCodexAggregateTimelineIdentity({
    providerSessionId: "session-1",
    turnId: "turn-1",
    itemKind: "compaction",
    itemKey: CODEX_CONTEXT_COMPACTION_AGGREGATE_ITEM_KEY,
    origin: "live",
  });
  const collapsed = collapseDuplicateCodexTimelineEvents(
    [
      compactionEvent({
        id: "compaction-1",
        seq: 1,
        turnId: "turn-1",
        status: "completed",
        canonicalItemId: "legacy-compaction-identity",
      }),
    ],
    { providerSessionId: "session-1" },
  );
  const stored = collapsed[0];
  if (
    !stored ||
    (stored.type !== "timeline.item.added" && stored.type !== "timeline.item.updated")
  ) {
    assert.fail("expected a retained stored compaction item");
  }
  assert.equal(
    stored.payload.identity?.canonicalItemId,
    liveIdentity.canonicalItemId,
  );
});

test("uses cumulative compaction counts without counting updates as new passes", () => {
  const collapsed = collapseDuplicateCodexTimelineEvents([
    compactionEvent({
      id: "compaction-added",
      seq: 1,
      turnId: "turn-1",
      status: "started",
      count: 1,
      canonicalItemId: "canonical-compaction",
    }),
    compactionEvent({
      id: "compaction-updated-1",
      seq: 2,
      turnId: "turn-1",
      eventType: "timeline.item.updated",
      status: "started",
      count: 2,
      canonicalItemId: "canonical-compaction",
    }),
    compactionEvent({
      id: "compaction-updated-2",
      seq: 3,
      turnId: "turn-1",
      eventType: "timeline.item.updated",
      status: "completed",
      count: 2,
      canonicalItemId: "canonical-compaction",
    }),
  ]);

  const compactions = collapsed.filter(
    (event) =>
      (event.type === "timeline.item.added" || event.type === "timeline.item.updated") &&
      event.payload.item.kind === "compaction",
  );
  assert.equal(compactions.length, 1);
  const compaction = compactions[0];
  if (
    !compaction ||
    (compaction.type !== "timeline.item.added" && compaction.type !== "timeline.item.updated") ||
    compaction.payload.item.kind !== "compaction"
  ) {
    assert.fail("expected one retained compaction timeline item");
  }
  assert.deepEqual(compaction.payload.item, {
    kind: "compaction",
    status: "completed",
    count: 2,
  });
});

test("does not truncate large persisted history windows at the live EventBus limit", () => {
  const lineCount = 2_101;
  const lines = Array.from({ length: lineCount }, (_, index) =>
    JSON.stringify({
      timestamp: new Date(Date.UTC(2026, 6, 19, 0, 0, index)).toISOString(),
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: `History message ${index}` }],
      },
    }),
  );

  const events = translateCodexRolloutWindowToHistoryEvents({
    sessionId: "rah-large-history",
    providerSessionId: "codex-large-history",
    cwd: "/workspace",
    rootDir: "/workspace",
    lines,
  });
  const userMessages = events.filter(
    (event) =>
      event.type === "timeline.item.added" &&
      event.payload.item.kind === "user_message",
  );

  assert.equal(userMessages.length, lineCount);
  assert.equal(
    userMessages[0]?.type === "timeline.item.added" &&
      userMessages[0].payload.item.kind === "user_message"
      ? userMessages[0].payload.item.text
      : undefined,
    "History message 0",
  );
});

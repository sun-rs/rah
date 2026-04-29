import { test } from "node:test";
import assert from "node:assert/strict";
import type { RahEvent, SessionSummary } from "@rah/runtime-protocol";
import { prependHistoryPage, replayEventsIntoProjection } from "./session-store-history";

function summary(): SessionSummary {
  return {
    session: {
      id: "session-1",
      provider: "codex",
      launchSource: "web",
      cwd: "/workspace/rah",
      rootDir: "/workspace/rah",
      runtimeState: "idle",
      capabilities: {
        liveAttach: true,
        structuredTimeline: true,
        livePermissions: true,
        contextUsage: true,
        resumeByProvider: true,
        listProviderSessions: true,
        steerInput: true,
        queuedInput: false,
        modelSwitch: false,
        planMode: false,
        subagents: false,
      },
      createdAt: "2026-04-15T00:00:00.000Z",
      updatedAt: "2026-04-15T00:00:00.000Z",
    },
    attachedClients: [],
    controlLease: { sessionId: "session-1" },
  };
}

function timelineEvent(args: {
  seq: number;
  turnId: string;
  text: string;
  messageId?: string;
}): RahEvent {
  return {
    id: `event-${args.seq}`,
    seq: args.seq,
    ts: `2026-04-15T00:00:${String(args.seq).padStart(2, "0")}.000Z`,
    sessionId: "session-1",
    turnId: args.turnId,
    source: {
      provider: "codex",
      channel: "structured_persisted",
      authority: "authoritative",
    },
    type: "timeline.item.added",
    payload: {
      item: {
        kind: "user_message",
        text: args.text,
        ...(args.messageId ? { messageId: args.messageId } : {}),
      },
    },
  } as RahEvent;
}

test("prependHistoryPage keeps repeated same-text messages from different turns", () => {
  const current = replayEventsIntoProjection(summary(), [
    timelineEvent({ seq: 2, turnId: "turn-2", text: "继续" }),
  ]);

  const next = prependHistoryPage(current, [
    timelineEvent({ seq: 1, turnId: "turn-1", text: "继续" }),
  ]);

  assert.equal(next.feed.length, 2);
  assert.deepEqual(
    next.feed.map((entry) => (entry.kind === "timeline" ? entry.turnId : null)),
    ["turn-1", "turn-2"],
  );
});

test("prependHistoryPage still dedupes matching timeline message identities", () => {
  const current = replayEventsIntoProjection(summary(), [
    timelineEvent({ seq: 2, turnId: "turn-2", text: "继续", messageId: "message-1" }),
  ]);

  const next = prependHistoryPage(current, [
    timelineEvent({ seq: 1, turnId: "turn-1", text: "继续", messageId: "message-1" }),
  ]);

  assert.equal(next.feed.length, 1);
  const [entry] = next.feed;
  assert.equal(entry?.kind, "timeline");
  assert.equal(entry?.kind === "timeline" ? entry.item.kind : null, "user_message");
  assert.equal(
    entry?.kind === "timeline" && entry.item.kind === "user_message"
      ? entry.item.messageId
      : null,
    "message-1",
  );
});

test("prependHistoryPage does not dedupe conflicting message identities", () => {
  const current = replayEventsIntoProjection(summary(), [
    timelineEvent({ seq: 2, turnId: "turn-1", text: "继续", messageId: "message-2" }),
  ]);

  const next = prependHistoryPage(current, [
    timelineEvent({ seq: 1, turnId: "turn-1", text: "继续", messageId: "message-1" }),
  ]);

  assert.equal(next.feed.length, 2);
  assert.deepEqual(
    next.feed.map((entry) =>
      entry.kind === "timeline" && entry.item.kind === "user_message"
        ? entry.item.messageId
        : null,
    ),
    ["message-1", "message-2"],
  );
});

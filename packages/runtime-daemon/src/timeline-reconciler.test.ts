import { test } from "node:test";
import assert from "node:assert/strict";
import type { RahEvent, TimelineIdentity } from "@rah/runtime-protocol";
import { createTimelineIdentity } from "./timeline-identity";
import {
  normalizeTranscriptEvents,
  reconcileTimelineActivity,
  reconcileTurnLifecycleActivity,
  resetTimelineReconcilerForTests,
} from "./timeline-reconciler";

function identity(args: {
  turnId: string;
  itemKey: string;
  origin?: "live" | "history";
}): TimelineIdentity {
  return createTimelineIdentity({
    provider: "codex",
    providerSessionId: "provider-session-1",
    turnKey: `turn:${args.turnId}`,
    itemKind: "assistant_message",
    itemKey: args.itemKey,
    origin: args.origin ?? "live",
    confidence: "derived",
  });
}

function event(args: {
  seq: number;
  type?: "timeline.item.added" | "timeline.item.updated" | "turn.canceled";
  turnId: string;
  identity?: TimelineIdentity;
  text?: string;
}): RahEvent {
  if (args.type === "turn.canceled") {
    return {
      id: `event-${args.seq}`,
      seq: args.seq,
      ts: `2026-05-10T00:00:${String(args.seq).padStart(2, "0")}.000Z`,
      sessionId: "session-1",
      type: "turn.canceled",
      source: {
        provider: "codex",
        channel: "structured_persisted",
        authority: "authoritative",
      },
      payload: { reason: "interrupted" },
      turnId: args.turnId,
    };
  }
  return {
    id: `event-${args.seq}`,
    seq: args.seq,
    ts: `2026-05-10T00:00:${String(args.seq).padStart(2, "0")}.000Z`,
    sessionId: "session-1",
    type: args.type ?? "timeline.item.added",
    source: {
      provider: "codex",
      channel: "structured_persisted",
      authority: "authoritative",
    },
    payload: {
      item: { kind: "assistant_message", text: args.text ?? `answer ${args.seq}` },
      ...(args.identity !== undefined ? { identity: args.identity } : {}),
    },
    turnId: args.turnId,
  };
}

test("timeline reconciler state follows eventBus, not transient services object identity", () => {
  resetTimelineReconcilerForTests();
  const eventBus = {};
  const firstServices = { eventBus };
  const secondServices = { eventBus };
  const sharedIdentity = identity({ turnId: "turn-1", itemKey: "assistant-1" });

  const first = reconcileTimelineActivity(firstServices, "session-1", {
    type: "timeline_item",
    item: { kind: "assistant_message", text: "hello" },
    turnId: "turn-1",
    identity: sharedIdentity,
  });
  const second = reconcileTimelineActivity(secondServices, "session-1", {
    type: "timeline_item",
    item: { kind: "assistant_message", text: "hello" },
    turnId: "turn-1",
    identity: sharedIdentity,
  });

  assert.equal(first?.type, "timeline_item");
  assert.equal(second, null);
});

test("turn lifecycle reconciler dedupes live/history cancel by canonical turn identity", () => {
  resetTimelineReconcilerForTests();
  const services = { eventBus: {} };
  const liveIdentity = identity({ turnId: "provider-turn-1", itemKey: "assistant-1", origin: "live" });
  const historyIdentity = identity({ turnId: "provider-turn-1", itemKey: "assistant-1", origin: "history" });

  reconcileTimelineActivity(services, "session-1", {
    type: "timeline_item",
    item: { kind: "assistant_message", text: "hello" },
    turnId: "live-turn-1",
    identity: liveIdentity,
  });
  const liveCancel = reconcileTurnLifecycleActivity(services, "session-1", {
    type: "turn_canceled",
    turnId: "live-turn-1",
    reason: "interrupted",
  });

  reconcileTimelineActivity(services, "session-1", {
    type: "timeline_item",
    item: { kind: "assistant_message", text: "hello" },
    turnId: "history:turn-1",
    identity: historyIdentity,
  });
  const historyCancel = reconcileTurnLifecycleActivity(services, "session-1", {
    type: "turn_canceled",
    turnId: "history:turn-1",
    reason: "interrupted",
  });

  assert.equal(liveCancel?.identity?.canonicalTurnId, liveIdentity.canonicalTurnId);
  assert.equal(historyCancel, null);
});

test("normalizeTranscriptEvents dedupes cancel notices by canonical turn identity", () => {
  const liveIdentity = identity({ turnId: "provider-turn-1", itemKey: "assistant-1", origin: "live" });
  const historyIdentity = identity({ turnId: "provider-turn-1", itemKey: "assistant-1", origin: "history" });
  const normalized = normalizeTranscriptEvents([
    event({ seq: 1, turnId: "live-turn-1", identity: liveIdentity }),
    event({ seq: 2, type: "turn.canceled", turnId: "live-turn-1" }),
    event({ seq: 3, turnId: "history:turn-1", identity: historyIdentity }),
    event({ seq: 4, type: "turn.canceled", turnId: "history:turn-1" }),
  ]);

  assert.deepEqual(
    normalized.map((item) => item.type),
    ["timeline.item.added", "turn.canceled"],
  );
  const cancel = normalized[1];
  assert.equal(cancel?.type, "turn.canceled");
  if (cancel?.type === "turn.canceled") {
    assert.equal(cancel.payload.identity?.canonicalTurnId, liveIdentity.canonicalTurnId);
  }
});

test("normalizeTranscriptEvents preserves the first item position while applying canonical updates", () => {
  const sharedIdentity = identity({ turnId: "provider-turn-1", itemKey: "assistant-1" });
  const normalized = normalizeTranscriptEvents([
    event({
      seq: 1,
      turnId: "turn-1",
      identity: sharedIdentity,
      text: "partial answer",
    }),
    event({
      seq: 2,
      type: "timeline.item.updated",
      turnId: "turn-1",
      identity: sharedIdentity,
      text: "final answer",
    }),
  ]);

  assert.equal(normalized.length, 1);
  const only = normalized[0];
  assert.equal(only?.type, "timeline.item.updated");
  if (only?.type === "timeline.item.updated") {
    assert.equal(only.payload.item.kind, "assistant_message");
    assert.equal(only.payload.item.kind === "assistant_message" ? only.payload.item.text : null, "final answer");
  }
});

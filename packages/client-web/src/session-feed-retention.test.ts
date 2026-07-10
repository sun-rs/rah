import assert from "node:assert/strict";
import { test } from "node:test";
import type { RahEvent, SessionSummary } from "@rah/runtime-protocol";
import {
  compactRecoverableLiveProjectionFeed,
  LIVE_FEED_RETENTION_TARGET_ENTRIES,
} from "./session-feed-retention";
import { applyEventsToProjectionMap } from "./session-store-projections";
import { initialHistorySyncState, type FeedEntry, type SessionProjection } from "./types";

function summary(options?: {
  providerSessionId?: string;
  readOnly?: boolean;
}): SessionSummary {
  const readOnly = options?.readOnly === true;
  return {
    session: {
      id: "session-1",
      provider: "codex",
      providerSessionId: options?.providerSessionId,
      launchSource: "web",
      status: "running",
      phase: "waiting_input",
      cwd: "/workspace/rah",
      rootDir: "/workspace/rah",
      runtimeState: readOnly ? "stopped" : "idle",
      ptyId: "pty-1",
      capabilities: {
        liveAttach: !readOnly,
        structuredTimeline: true,
        nativeTui: false,
        rawPtyInput: false,
        chatMirror: false,
        structuredControl: !readOnly,
        livePermissions: !readOnly,
        contextUsage: true,
        resumeByProvider: true,
        listProviderSessions: true,
        renameSession: true,
        actions: {
          info: true,
          stop: !readOnly,
          delete: true,
          rename: "native",
        },
        steerInput: !readOnly,
        queuedInput: false,
        modelSwitch: false,
        planMode: false,
        subagents: false,
      },
      createdAt: "2026-06-01T00:00:00.000Z",
      updatedAt: "2026-06-01T00:00:00.000Z",
    },
    attachedClients: [],
    controlLease: { sessionId: "session-1" },
  };
}

function projection(feed: FeedEntry[], options?: Parameters<typeof summary>[0]): SessionProjection {
  return {
    summary: summary(options),
    feed,
    events: [],
    lastSeq: feed.length,
    history: initialHistorySyncState(),
  };
}

function ts(index: number): string {
  return new Date(Date.UTC(2026, 5, 1, 0, 0, index)).toISOString();
}

function timelineEntry(index: number, kind: "assistant_message" | "user_message"): FeedEntry {
  return {
    key: `${kind}:${index}`,
    kind: "timeline",
    item: {
      kind,
      text: `${kind} ${index}`,
      messageId: `${kind}-${index}`,
    },
    ts: ts(index),
    turnId: `turn-${Math.floor(index / 2)}`,
    canonicalItemId: `${kind}-${index}`,
    canonicalTurnId: `turn-${Math.floor(index / 2)}`,
    sourceProvider: "codex",
  };
}

function feedWithUserBoundary(length: number): FeedEntry[] {
  const desiredStart = Math.max(0, length - LIVE_FEED_RETENTION_TARGET_ENTRIES);
  const userBoundary = desiredStart - 10;
  return Array.from({ length }, (_, index) =>
    timelineEntry(index, index === userBoundary ? "user_message" : "assistant_message"),
  );
}

function timelineEvent(index: number, kind: "assistant_message" | "user_message"): RahEvent {
  return {
    id: `event-${index}`,
    seq: index + 1,
    ts: ts(index),
    sessionId: "session-1",
    source: { provider: "codex", channel: "structured_live", authority: "derived" },
    type: "timeline.item.added",
    turnId: `turn-${Math.floor(index / 2)}`,
    payload: {
      item: {
        kind,
        text: `${kind} ${index}`,
        messageId: `${kind}-${index}`,
      },
      identity: {
        canonicalItemId: `${kind}-${index}`,
        canonicalTurnId: `turn-${Math.floor(index / 2)}`,
      },
    },
  };
}

test("compactRecoverableLiveProjectionFeed trims long recoverable live feeds at a user boundary", () => {
  const feed = feedWithUserBoundary(1_000);
  const current = projection(feed, { providerSessionId: "thread-1" });

  const next = compactRecoverableLiveProjectionFeed(current);

  assert.notEqual(next, current);
  assert.equal(next.feed[0]?.key, "user_message:340");
  assert.equal(next.feed.at(-1)?.key, "assistant_message:999");
  assert.equal(next.feed.length, 660);
  assert.equal(next.history.phase, "ready");
  assert.equal(next.history.authoritativeApplied, true);
  assert.equal(next.history.nextCursor, null);
  assert.equal(next.history.nextBeforeTs, ts(340));
});

test("applyEventsToProjectionMap compacts touched live projections after event batches", () => {
  const length = 1_000;
  const desiredStart = Math.max(0, length - LIVE_FEED_RETENTION_TARGET_ENTRIES);
  const userBoundary = desiredStart - 10;
  const current = new Map<string, SessionProjection>([
    ["session-1", projection([], { providerSessionId: "thread-1" })],
  ]);
  const events = Array.from({ length }, (_, index) =>
    timelineEvent(index, index === userBoundary ? "user_message" : "assistant_message"),
  );

  const next = applyEventsToProjectionMap(current, events, {
    updateLastSeq: () => undefined,
    clearBufferedSession: () => undefined,
    queuePendingEvent: () => undefined,
    shouldDeferEvent: () => false,
    queueDeferredEvent: () => undefined,
  });

  const compacted = next.get("session-1");
  assert.ok(compacted);
  assert.equal(compacted.feed.length, 660);
  assert.equal(compacted.feed[0]?.ts, ts(340));
  assert.equal(compacted.history.authoritativeApplied, true);
  assert.equal(compacted.history.nextBeforeTs, ts(340));
});

test("compactRecoverableLiveProjectionFeed leaves read-only history replays intact", () => {
  const current = projection(feedWithUserBoundary(1_000), {
    providerSessionId: "thread-1",
    readOnly: true,
  });

  const next = compactRecoverableLiveProjectionFeed(current);

  assert.equal(next, current);
  assert.equal(next.feed.length, 1_000);
});

test("compactRecoverableLiveProjectionFeed leaves projections without provider sessions intact", () => {
  const current = projection(feedWithUserBoundary(1_000));

  const next = compactRecoverableLiveProjectionFeed(current);

  assert.equal(next, current);
  assert.equal(next.feed.length, 1_000);
});

test("compactRecoverableLiveProjectionFeed does not trim during explicit older-history loads", () => {
  const current: SessionProjection = {
    ...projection(feedWithUserBoundary(1_000), { providerSessionId: "thread-1" }),
    history: {
      ...initialHistorySyncState(),
      phase: "loading",
      generation: 1,
    },
  };

  const next = compactRecoverableLiveProjectionFeed(current);

  assert.equal(next, current);
  assert.equal(next.feed.length, 1_000);
});

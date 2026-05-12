import { test } from "node:test";
import assert from "node:assert/strict";
import type { RahEvent, SessionSummary } from "@rah/runtime-protocol";
import {
  mergeLatestHistoryPage,
  prependHistoryPage,
  replayEventsIntoProjection,
} from "./session-store-history";
import {
  appendOptimisticUserMessage,
  applyEventToProjection,
  markPendingInterruptIntent,
} from "./types";

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
  turnId?: string;
  text: string;
  kind?: "user_message" | "assistant_message" | "reasoning";
  messageId?: string;
  clientMessageId?: string;
  canonicalItemId?: string;
  canonicalTurnId?: string;
  ts?: string;
}): RahEvent {
  const kind = args.kind ?? "user_message";
  return {
    id: `event-${args.seq}`,
    seq: args.seq,
    ts: args.ts ?? `2026-04-15T00:00:${String(args.seq).padStart(2, "0")}.000Z`,
    sessionId: "session-1",
    ...(args.turnId !== undefined ? { turnId: args.turnId } : {}),
    source: {
      provider: "codex",
      channel: "structured_persisted",
      authority: "authoritative",
    },
    type: "timeline.item.added",
    payload: {
      item: {
        kind,
        text: args.text,
        ...(args.messageId && kind !== "reasoning" ? { messageId: args.messageId } : {}),
        ...(args.clientMessageId && kind === "user_message"
          ? { clientMessageId: args.clientMessageId }
          : {}),
      },
      ...(args.canonicalItemId
        ? {
            identity: {
              canonicalItemId: args.canonicalItemId,
              canonicalTurnId: args.canonicalTurnId ?? `canonical:${args.turnId}`,
              provider: "codex",
              providerSessionId: "provider-session-1",
              turnKey: args.turnId ?? `turn:${args.seq}`,
              itemKind: kind,
              itemKey: args.canonicalItemId,
              origin: args.turnId?.startsWith("history:") ? "history" : "live",
              confidence: "derived",
            },
          }
        : {}),
    },
  } as RahEvent;
}

function turnCanceledEvent(args: {
  seq: number;
  turnId?: string;
  canonicalTurnId?: string;
  ts?: string;
}): RahEvent {
  return {
    id: `event-${args.seq}`,
    seq: args.seq,
    ts: args.ts ?? `2026-04-15T00:00:${String(args.seq).padStart(2, "0")}.000Z`,
    sessionId: "session-1",
    ...(args.turnId !== undefined ? { turnId: args.turnId } : {}),
    source: {
      provider: "codex",
      channel: "structured_persisted",
      authority: "authoritative",
    },
    type: "turn.canceled",
    payload: {
      reason: "interrupted",
      ...(args.canonicalTurnId
        ? {
            identity: {
              canonicalTurnId: args.canonicalTurnId,
              provider: "codex",
              providerSessionId: "provider-session-1",
              turnKey: args.turnId ?? args.canonicalTurnId,
              origin: args.turnId?.startsWith("history:") ? "history" : "live",
              confidence: "derived",
            },
          }
        : {}),
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

test("prependHistoryPage dedupes matching canonical timeline identities", () => {
  const current = replayEventsIntoProjection(summary(), [
    timelineEvent({
      seq: 2,
      turnId: "live-turn",
      kind: "reasoning",
      text: "same reasoning",
      canonicalItemId: "canonical-item-1",
    }),
  ]);

  const next = prependHistoryPage(current, [
    timelineEvent({
      seq: 1,
      turnId: "history:session-1:turn-1",
      kind: "reasoning",
      text: "same reasoning",
      canonicalItemId: "canonical-item-1",
    }),
  ]);

  assert.equal(next.feed.length, 1);
  const [entry] = next.feed;
  assert.equal(entry?.kind, "timeline");
  assert.equal(entry?.kind === "timeline" ? entry.canonicalItemId : null, "canonical-item-1");
  assert.equal(entry?.kind === "timeline" ? entry.turnId : null, "history:session-1:turn-1");
});

test("prependHistoryPage preserves repeated same text with different canonical identities", () => {
  const current = replayEventsIntoProjection(summary(), [
    timelineEvent({
      seq: 2,
      turnId: "turn-2",
      text: "继续",
      canonicalItemId: "canonical-item-2",
    }),
  ]);

  const next = prependHistoryPage(current, [
    timelineEvent({
      seq: 1,
      turnId: "turn-1",
      text: "继续",
      canonicalItemId: "canonical-item-1",
    }),
  ]);

  assert.equal(next.feed.length, 2);
  assert.deepEqual(
    next.feed.map((entry) => (entry.kind === "timeline" ? entry.canonicalItemId : null)),
    ["canonical-item-1", "canonical-item-2"],
  );
});

test("mergeLatestHistoryPage consumes optimistic same-text placeholders by count", () => {
  let current = replayEventsIntoProjection(summary(), []);
  current = appendOptimisticUserMessage(current, "继续", {
    clientMessageId: "client-message-1",
    clientTurnId: "client-turn-1",
  });
  current = appendOptimisticUserMessage(current, "继续", {
    clientMessageId: "client-message-2",
    clientTurnId: "client-turn-2",
  });
  current = appendOptimisticUserMessage(current, "继续", {
    clientMessageId: "client-message-3",
    clientTurnId: "client-turn-3",
  });

  const next = mergeLatestHistoryPage(current, [
    timelineEvent({ seq: 1, turnId: "provider-turn-1", text: "继续" }),
    timelineEvent({ seq: 2, turnId: "provider-turn-2", text: "继续" }),
  ]);

  const userMessages = next.feed.filter(
    (entry) => entry.kind === "timeline" && entry.item.kind === "user_message",
  );
  assert.equal(userMessages.length, 3);
  assert.deepEqual(
    userMessages.map((entry) => (entry.kind === "timeline" ? entry.turnId ?? null : null)),
    ["provider-turn-1", "provider-turn-2", null],
  );
});

test("mergeLatestHistoryPage drops stale optimistic placeholders already covered by history", () => {
  let current = replayEventsIntoProjection(summary(), [
    timelineEvent({
      seq: 1,
      turnId: "provider-turn-1",
      text: "blocked while dirty",
      ts: "2026-04-15T00:00:05.000Z",
    }),
  ]);
  current = appendOptimisticUserMessage(current, "blocked while dirty", {
    clientMessageId: "client-message-stale",
    clientTurnId: "client-turn-stale",
  });
  current = {
    ...current,
    feed: current.feed.map((entry) =>
      entry.kind === "timeline" && entry.key.startsWith("optimistic:user:")
        ? { ...entry, ts: "2026-04-15T00:00:04.000Z" }
        : entry,
    ),
  };

  const next = mergeLatestHistoryPage(current, [
    timelineEvent({
      seq: 1,
      turnId: "provider-turn-1",
      text: "blocked while dirty",
      ts: "2026-04-15T00:00:05.000Z",
    }),
  ]);

  const userMessages = next.feed.filter(
    (entry) => entry.kind === "timeline" && entry.item.kind === "user_message",
  );
  assert.equal(userMessages.length, 1);
  assert.equal(
    userMessages[0]?.kind === "timeline" && userMessages[0].item.kind === "user_message"
      ? userMessages[0].item.text
      : null,
    "blocked while dirty",
  );
});

test("mergeLatestHistoryPage keeps newer same-text optimistic placeholders pending", () => {
  let current = replayEventsIntoProjection(summary(), [
    timelineEvent({
      seq: 1,
      turnId: "provider-turn-1",
      text: "继续",
      ts: "2026-04-15T00:00:05.000Z",
    }),
  ]);
  current = appendOptimisticUserMessage(current, "继续", {
    clientMessageId: "client-message-pending",
    clientTurnId: "client-turn-pending",
  });
  current = {
    ...current,
    feed: current.feed.map((entry) =>
      entry.kind === "timeline" && entry.key.startsWith("optimistic:user:")
        ? { ...entry, ts: "2026-04-15T00:00:06.000Z" }
        : entry,
    ),
  };

  const next = mergeLatestHistoryPage(current, [
    timelineEvent({
      seq: 1,
      turnId: "provider-turn-1",
      text: "继续",
      ts: "2026-04-15T00:00:05.000Z",
    }),
  ]);

  const userMessages = next.feed.filter(
    (entry) => entry.kind === "timeline" && entry.item.kind === "user_message",
  );
  assert.equal(userMessages.length, 2);
});

test("prependHistoryPage dedupes weak user echoes once authoritative history arrives", () => {
  const current = replayEventsIntoProjection(summary(), [
    timelineEvent({ seq: 2, turnId: "live-turn", text: "hello" }),
  ]);

  const next = prependHistoryPage(current, [
    timelineEvent({ seq: 1, turnId: "opencode:message-1", text: "hello", messageId: "message-1" }),
  ]);

  assert.equal(next.feed.length, 1);
  assert.deepEqual(
    next.feed.map((entry) =>
      entry.kind === "timeline" && entry.item.kind === "user_message"
        ? entry.item.messageId ?? null
        : null,
    ),
    ["message-1"],
  );
});

test("mergeLatestHistoryPage dedupes provisional OpenCode user echo against canonical history", () => {
  const current = replayEventsIntoProjection(summary(), [
    timelineEvent({
      seq: 2,
      turnId: "client-turn",
      text: "你是谁，你在 build 模式吗",
      clientMessageId: "client-message-1",
    }),
  ]);

  const next = mergeLatestHistoryPage(current, [
    timelineEvent({
      seq: 1,
      turnId: "opencode:message-1",
      text: "你是谁，你在 build 模式吗",
      messageId: "message-1",
      canonicalItemId: "opencode-user-1",
    }),
  ]);

  assert.equal(next.feed.length, 1);
  const [entry] = next.feed;
  assert.equal(entry?.kind, "timeline");
  assert.equal(entry?.kind === "timeline" ? entry.canonicalItemId : null, "opencode-user-1");
  assert.equal(
    entry?.kind === "timeline" && entry.item.kind === "user_message"
      ? entry.item.messageId
      : null,
    "message-1",
  );
});

test("mergeLatestHistoryPage keeps far-apart same-text provisional user turns separate", () => {
  const current = replayEventsIntoProjection(summary(), [
    timelineEvent({
      seq: 10,
      turnId: "client-turn",
      text: "继续",
      clientMessageId: "client-message-1",
    }),
  ]);

  const next = mergeLatestHistoryPage(current, [
    timelineEvent({
      seq: 1,
      turnId: "opencode:message-1",
      text: "继续",
      messageId: "message-1",
      canonicalItemId: "opencode-user-1",
    }),
  ]);

  const userMessages = next.feed.filter(
    (entry) => entry.kind === "timeline" && entry.item.kind === "user_message",
  );
  assert.equal(userMessages.length, 2);
  assert.deepEqual(
    userMessages.map((entry) =>
      entry.kind === "timeline" && entry.item.kind === "user_message"
        ? entry.item.messageId ?? entry.item.clientMessageId ?? null
        : null,
    ),
    ["message-1", "client-message-1"],
  );
});

test("prependHistoryPage upgrades optimistic native TUI user echo with canonical history identity", () => {
  const current = appendOptimisticUserMessage(
    replayEventsIntoProjection(summary(), []),
    "你是谁",
  );

  const next = prependHistoryPage(current, [
    timelineEvent({
      seq: 1,
      text: "你是谁",
      canonicalItemId: "codex-history-user-1",
      canonicalTurnId: "codex-history-turn-1",
      ts: current.feed[0]?.ts,
    }),
  ]);

  assert.equal(next.feed.length, 1);
  const [entry] = next.feed;
  assert.equal(entry?.kind, "timeline");
  assert.equal(entry?.kind === "timeline" ? entry.canonicalItemId : null, "codex-history-user-1");
  assert.equal(entry?.kind === "timeline" ? entry.key : null, "timeline:codex-history-user-1");
});

test("prependHistoryPage leaves identity-less live/history echoes separate", () => {
  const current = replayEventsIntoProjection(summary(), [
    timelineEvent({ seq: 3, turnId: "live-turn", text: "你是谁" }),
    timelineEvent({
      seq: 4,
      turnId: "live-turn",
      kind: "reasoning",
      text: "用户问我是谁，直接回答身份。",
    }),
    timelineEvent({
      seq: 5,
      turnId: "live-turn",
      kind: "assistant_message",
      text: "我是 OpenCode CLI。",
    }),
  ]);

  const next = prependHistoryPage(current, [
    timelineEvent({ seq: 1, turnId: "history:session-1:turn-1", text: "你是谁" }),
    timelineEvent({
      seq: 2,
      turnId: "history:session-1:turn-1",
      kind: "reasoning",
      text: "用户问我是谁，直接回答身份。",
    }),
    timelineEvent({
      seq: 3,
      turnId: "history:session-1:turn-1",
      kind: "assistant_message",
      text: "我是 OpenCode CLI。",
    }),
  ]);

  assert.equal(next.feed.length, 6);
  assert.deepEqual(
    next.feed.map((entry) => (entry.kind === "timeline" ? entry.item.kind : null)),
    [
      "user_message",
      "reasoning",
      "assistant_message",
      "user_message",
      "reasoning",
      "assistant_message",
    ],
  );
  assert.deepEqual(
    next.feed.map((entry) => (entry.kind === "timeline" ? entry.turnId : null)),
    [
      "history:session-1:turn-1",
      "history:session-1:turn-1",
      "history:session-1:turn-1",
      "live-turn",
      "live-turn",
      "live-turn",
    ],
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

test("mergeLatestHistoryPage appends newly persisted assistant tail without showing older-history semantics", () => {
  const current = appendOptimisticUserMessage(
    replayEventsIntoProjection(summary(), []),
    "你是谁",
  );

  const next = mergeLatestHistoryPage(current, [
    timelineEvent({
      seq: 1,
      turnId: "history:session-1:turn-1",
      text: "你是谁",
      messageId: "message-user-1",
      canonicalItemId: "canonical-user-1",
      ts: current.feed[0]?.ts,
    }),
    timelineEvent({
      seq: 2,
      turnId: "history:session-1:turn-1",
      kind: "assistant_message",
      text: "我是 Codex。",
      messageId: "message-assistant-1",
      canonicalItemId: "canonical-assistant-1",
    }),
  ]);

  assert.equal(next.feed.length, 2);
  assert.deepEqual(
    next.feed.map((entry) => (entry.kind === "timeline" ? entry.item.kind : null)),
    ["user_message", "assistant_message"],
  );
  assert.deepEqual(
    next.feed.map((entry) =>
      entry.kind === "timeline" && "text" in entry.item ? entry.item.text : null,
    ),
    ["你是谁", "我是 Codex。"],
  );
  assert.equal(next.history.phase, "ready");
  assert.equal(next.history.authoritativeApplied, true);
});

test("mergeLatestHistoryPage dedupes live interrupt notices against persisted anchored cancels", () => {
  let current = appendOptimisticUserMessage(
    replayEventsIntoProjection(summary(), []),
    "真的吗",
  );
  current = markPendingInterruptIntent(current);
  current = applyEventToProjection(
    current,
    turnCanceledEvent({
      seq: 10,
      ts: "2026-04-15T00:00:10.000Z",
    }),
  );

  const next = mergeLatestHistoryPage(current, [
    timelineEvent({
      seq: 1,
      turnId: "history:session-1:turn-1",
      text: "真的吗",
      canonicalItemId: "canonical-user-1",
      canonicalTurnId: "canonical-turn-1",
      ts: "2026-04-15T00:00:01.000Z",
    }),
    turnCanceledEvent({
      seq: 2,
      turnId: "history:session-1:turn-1",
      canonicalTurnId: "canonical-turn-1",
      ts: "2026-04-15T00:00:02.000Z",
    }),
  ]);

  assert.deepEqual(
    next.feed.map((entry) =>
      entry.kind === "timeline"
        ? `${entry.item.kind}:${"text" in entry.item ? entry.item.text : ""}`
        : entry.kind,
    ),
    ["user_message:真的吗", "notification"],
  );
  const notices = next.feed.filter((entry) => entry.kind === "notification");
  assert.equal(notices.length, 1);
  assert.equal(notices[0]?.kind, "notification");
  assert.equal(notices[0]?.interruptAnchorKey, "timeline:canonical-user-1");
});

test("mergeLatestHistoryPage keeps distinct interrupted turns anchored separately", () => {
  let current = appendOptimisticUserMessage(
    replayEventsIntoProjection(summary(), []),
    "休眠五秒",
  );
  current = markPendingInterruptIntent(current);
  current = applyEventToProjection(current, turnCanceledEvent({ seq: 10 }));
  current = appendOptimisticUserMessage(current, "休眠五秒");
  current = markPendingInterruptIntent(current);
  current = applyEventToProjection(current, turnCanceledEvent({ seq: 11 }));

  const next = mergeLatestHistoryPage(current, [
    timelineEvent({
      seq: 1,
      turnId: "history:session-1:turn-1",
      text: "休眠五秒",
      canonicalItemId: "canonical-user-1",
      canonicalTurnId: "canonical-turn-1",
    }),
    turnCanceledEvent({
      seq: 2,
      turnId: "history:session-1:turn-1",
      canonicalTurnId: "canonical-turn-1",
    }),
    timelineEvent({
      seq: 3,
      turnId: "history:session-1:turn-2",
      text: "休眠五秒",
      canonicalItemId: "canonical-user-2",
      canonicalTurnId: "canonical-turn-2",
    }),
    turnCanceledEvent({
      seq: 4,
      turnId: "history:session-1:turn-2",
      canonicalTurnId: "canonical-turn-2",
    }),
  ]);

  assert.deepEqual(
    next.feed.map((entry) =>
      entry.kind === "timeline"
        ? `${entry.item.kind}:${"text" in entry.item ? entry.item.text : ""}`
        : entry.kind,
    ),
    [
      "user_message:休眠五秒",
      "notification",
      "user_message:休眠五秒",
      "notification",
    ],
  );
  const notices = next.feed.filter((entry) => entry.kind === "notification");
  assert.equal(notices.length, 2);
  assert.deepEqual(
    notices.map((entry) => (entry.kind === "notification" ? entry.interruptAnchorKey : null)),
    ["timeline:canonical-user-1", "timeline:canonical-user-2"],
  );
});

import assert from "node:assert/strict";
import test from "node:test";

import type { SessionQueuedInput } from "@rah/runtime-protocol";

import { conversationFeedWithInputQueue } from "./conversation-feed.js";
import type { FeedEntry } from "./types.js";

function queuedInput(
  overrides: Partial<SessionQueuedInput> = {},
): SessionQueuedInput {
  return {
    clientMessageId: "message-1",
    clientTurnId: "turn-1",
    text: "queued message",
    queuedAt: "2026-07-20T00:00:00.000Z",
    position: 1,
    state: "queued",
    ...overrides,
  } as SessionQueuedInput;
}

function canonicalUserMessage(
  overrides: Partial<Extract<FeedEntry, { kind: "timeline" }>> = {},
): FeedEntry {
  return {
    key: "timeline:user:message-1",
    kind: "timeline",
    item: {
      kind: "user_message",
      text: "queued message",
      clientMessageId: "message-1",
    },
    ts: "2026-07-20T00:00:01.000Z",
    ...overrides,
  };
}

test("keeps a queued input out of the conversation timeline", () => {
  const projected = conversationFeedWithInputQueue([], [queuedInput()]);

  assert.deepEqual(projected, []);
});

test("keeps a submitting input in the composer queue rather than the timeline", () => {
  const projected = conversationFeedWithInputQueue(
    [],
    [queuedInput({ state: "submitting" })],
  );

  assert.deepEqual(projected, []);
});

test("canonical user item replaces the queue projection without duplication", () => {
  const canonical = canonicalUserMessage();
  const projected = conversationFeedWithInputQueue(
    [canonical],
    [queuedInput({ state: "submitting" })],
  );

  assert.deepEqual(projected, [canonical]);
});

test("does not synthesize a second bubble for a distinct queued message", () => {
  const canonical = canonicalUserMessage({
    key: "timeline:user:message-2",
    item: {
      kind: "user_message",
      text: "queued message",
      clientMessageId: "message-2",
    },
  });
  const projected = conversationFeedWithInputQueue(
    [canonical],
    [queuedInput()],
  );

  assert.deepEqual(projected, [canonical]);
});

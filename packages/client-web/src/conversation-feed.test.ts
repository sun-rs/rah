import assert from "node:assert/strict";
import test from "node:test";

import type {
  ConversationTurnProjection,
  SessionQueuedInput,
} from "@rah/runtime-protocol";

import {
  conversationFeedWithInputQueue,
  conversationTurnsToFeed,
  stableConversationLocalFeed,
} from "./conversation-feed.js";
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

test("projects a submitting input into the timeline so refresh cannot hide an owned prompt", () => {
  const projected = conversationFeedWithInputQueue(
    [],
    [queuedInput({ state: "submitting" })],
  );

  assert.equal(projected.length, 1);
  assert.equal(projected[0]?.key, "submitting:user:message-1");
  assert.deepEqual(
    projected[0]?.kind === "timeline" ? projected[0].item : null,
    {
      kind: "user_message",
      text: "queued message",
      clientMessageId: "message-1",
      clientTurnId: "turn-1",
    },
  );
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

test("keeps the chat-local feed stable across process-output-only updates", () => {
  const optimisticUser = canonicalUserMessage({
    key: "optimistic:user:message-1",
  });
  const firstProcessEntry: FeedEntry = {
    key: "tool:command-1",
    kind: "tool_call",
    toolCall: {
      id: "command-1",
      kind: "command",
      title: "Run command",
      detailAvailable: true,
    },
    status: "running",
    ts: "2026-07-20T00:00:02.000Z",
  };
  const updatedProcessEntry: FeedEntry = {
    ...firstProcessEntry,
    status: "completed",
  };

  const first = stableConversationLocalFeed([
    optimisticUser,
    firstProcessEntry,
  ]);
  const afterOutput = stableConversationLocalFeed(
    [optimisticUser, updatedProcessEntry],
    first,
  );

  assert.strictEqual(afterOutput, first);
  assert.deepEqual(afterOutput, [optimisticUser]);

  const replacedOptimisticUser = {
    ...optimisticUser,
    item: {
      ...optimisticUser.item,
      text: "updated optimistic message",
    },
  } satisfies FeedEntry;
  const afterUserChange = stableConversationLocalFeed(
    [replacedOptimisticUser, updatedProcessEntry],
    afterOutput,
  );

  assert.notStrictEqual(afterUserChange, afterOutput);
  assert.deepEqual(afterUserChange, [replacedOptimisticUser]);
});

test("keeps canonical and provider turn identities on historical timeline items", () => {
  const turn: ConversationTurnProjection = {
    id: "canonical-turn-1",
    provider: "codex",
    providerSessionId: "provider-session-1",
    providerTurnId: "provider-turn-1",
    status: "completed",
    statusAuthority: "native",
    startedAt: "2026-07-20T00:00:00.000Z",
    completedAt: "2026-07-20T00:00:01.000Z",
    durationMs: 1_000,
    items: [
      {
        id: "canonical-item-1",
        turnId: "canonical-turn-1",
        providerItemId: "item:0",
        role: "user",
        status: "completed",
        startedAt: "2026-07-20T00:00:00.000Z",
        content: {
          kind: "timeline",
          item: {
            kind: "user_message",
            text: "message with an image",
            imageCount: 1,
          },
        },
        source: {
          provider: "codex",
          channel: "structured_persisted",
          authority: "authoritative",
        },
        revision: 1,
      },
    ],
    failedItemCount: 0,
    itemsView: "summary",
    revision: 1,
  };

  const [entry] = conversationTurnsToFeed([turn]);
  assert.equal(entry?.kind, "timeline");
  if (entry?.kind !== "timeline") {
    return;
  }
  assert.equal(entry.turnId, "provider-turn-1");
  assert.equal(entry.providerTurnId, "provider-turn-1");
  assert.equal(entry.canonicalTurnId, "canonical-turn-1");
});

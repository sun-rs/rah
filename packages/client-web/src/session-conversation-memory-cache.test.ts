import assert from "node:assert/strict";
import { test } from "node:test";
import type { ConversationTurnProjection, SessionSummary } from "@rah/runtime-protocol";
import { createConversationMemoryCache } from "./session-conversation-memory-cache";
import { initialConversationSyncState, type SessionProjection } from "./types";

function projection(
  providerSessionId: string,
  turnIds: string[],
  approximateBytes = 1_024,
): SessionProjection {
  const summary = {
    session: {
      id: `runtime-${providerSessionId}`,
      provider: "codex",
      providerSessionId,
    },
  } as SessionSummary;
  return {
    summary,
    feed: [],
    events: [],
    lastSeq: 0,
    conversation: {
      ...initialConversationSyncState(),
      phase: "ready",
      loadedScope: "history",
      turns: turnIds.map((id) => ({ id }) as ConversationTurnProjection),
      nextCursor: "old-cursor",
      daemonRevision: 17,
      approximateBytes,
      sourceRevision: "source-old",
      loadedAt: "2026-08-15T00:00:00.000Z",
    },
  };
}

test("conversation memory cache restores readable turns as a detached incremental baseline", () => {
  const cache = createConversationMemoryCache();
  cache.rememberProjection(projection("thread-1", ["turn-1", "turn-2"]));

  const restored = cache.restore({ provider: "codex", providerSessionId: "thread-1" });

  assert.deepEqual(restored?.turns.map((turn) => turn.id), ["turn-1", "turn-2"]);
  assert.equal(restored?.phase, "ready");
  assert.equal(restored?.needsRefresh, true);
  assert.equal(restored?.detachedBaseline, true);
  assert.equal(restored?.daemonRevision, null);
  assert.equal(restored?.nextCursor, null);
});

test("conversation memory cache is bounded, expires entries, and never stores empty shells", () => {
  let now = 1_000;
  const cache = createConversationMemoryCache({
    maxEntries: 2,
    maxEntryBytes: 1_000,
    maxTotalBytes: 2_000,
    ttlMs: 100,
    now: () => now,
  });
  cache.rememberProjection(projection("thread-1", ["a", "b", "c", "d"], 4_000));
  cache.rememberProjection(projection("thread-2", ["two"]));
  cache.rememberProjection(projection("thread-3", ["three"]));

  assert.equal(cache.restore({ provider: "codex", providerSessionId: "thread-1" }), undefined);
  assert.equal(cache.inspect().entries, 2);
  assert.deepEqual(
    cache.restore({ provider: "codex", providerSessionId: "thread-2" })?.turns.map(
      (turn) => turn.id,
    ),
    ["two"],
  );

  now += 101;
  assert.equal(cache.restore({ provider: "codex", providerSessionId: "thread-2" }), undefined);
  assert.equal(cache.inspect().entries, 0);
});

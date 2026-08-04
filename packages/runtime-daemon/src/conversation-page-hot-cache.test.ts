import assert from "node:assert/strict";
import { test } from "node:test";
import type { ConversationTurnsPageResponse } from "@rah/runtime-protocol";
import { ConversationPageHotCache } from "./conversation-page-hot-cache";

function page(sessionId: string, id: string, bytes = 128): ConversationTurnsPageResponse {
  return {
    sessionId,
    turns: [],
    revision: 1,
    generatedAt: "2026-08-04T00:00:00.000Z",
    sourceEventCount: 0,
    sourceRevision: id,
    liveRevision: 0,
    approximateBytes: bytes,
  };
}

test("conversation page hot cache requires exact provider and live revisions", () => {
  const cache = new ConversationPageHotCache();
  const address = { sessionId: "session-1", limit: 8 };
  const response = page("session-1", "source-1");
  cache.set(address, { sourceRevision: "source-1", liveRevision: 4 }, response);

  assert.equal(
    cache.get(address, { sourceRevision: "source-1", liveRevision: 4 }),
    response,
  );
  assert.equal(
    cache.get(address, { sourceRevision: "source-2", liveRevision: 4 }),
    undefined,
  );

  cache.set(address, { sourceRevision: "source-2", liveRevision: 4 }, response);
  assert.equal(
    cache.get(address, { sourceRevision: "source-2", liveRevision: 5 }),
    undefined,
  );
});

test("conversation page hot cache is bounded by LRU budget and age", () => {
  let now = 0;
  const cache = new ConversationPageHotCache({
    maxEntryBytes: 200,
    maxBytes: 200,
    maxEntries: 2,
    maxAgeMs: 100,
    now: () => now,
  });
  const version = { sourceRevision: "source", liveRevision: 0 };
  const first = { sessionId: "first", limit: 8 };
  const second = { sessionId: "second", limit: 8 };

  cache.set(first, version, page("first", "source", 120));
  now = 10;
  cache.set(second, version, page("second", "source", 120));
  assert.equal(cache.get(first, version), undefined);
  assert.ok(cache.get(second, version));

  now = 111;
  assert.equal(cache.get(second, version), undefined);
});

test("conversation page hot cache rejects oversized responses", () => {
  const cache = new ConversationPageHotCache({ maxEntryBytes: 100 });
  const address = { sessionId: "session-1", limit: 8 };
  const version = { sourceRevision: "source", liveRevision: 0 };
  cache.set(address, version, page("session-1", "source", 101));
  assert.equal(cache.get(address, version), undefined);
});

test("conversation page hot cache never freezes transient working state", () => {
  const cache = new ConversationPageHotCache();
  const address = { sessionId: "session-1", limit: 8 };
  const version = { sourceRevision: "source", liveRevision: 3 };
  const response = page("session-1", "source");
  response.turns = [
    {
      id: "turn-working",
      provider: "codex",
      status: "in_progress",
      statusAuthority: "native",
      items: [],
      activities: [],
      failedItemCount: 0,
      revision: 1,
    },
  ];
  cache.set(address, version, response);
  assert.equal(cache.get(address, version), undefined);
});

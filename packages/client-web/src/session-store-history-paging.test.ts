import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type { StoredSessionRef } from "@rah/runtime-protocol";
import {
  ensureSessionHistoryLoadedCommand,
  loadOlderHistoryCommand,
  refreshLatestHistoryCommand,
} from "./session-store-history-paging";
import { createStoredHistoryReplayProjection } from "./session-store-session-lifecycle";

const originalFetch = globalThis.fetch;

function storedRef(): StoredSessionRef {
  return {
    provider: "codex",
    providerSessionId: "thread-1",
    cwd: "/tmp/rah",
    rootDir: "/tmp/rah",
    createdAt: "2026-05-07T00:00:00.000Z",
  };
}

function pagingState(projection = createStoredHistoryReplayProjection(storedRef())) {
  return {
    projections: new Map([[projection.summary.session.id, projection]]),
    error: null,
  };
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("history paging skips local stored-history shell projections", async () => {
  const state = pagingState();
  const shellSessionId = [...state.projections.keys()][0]!;
  let loadOlderCalled = false;
  let refreshCalled = false;

  await ensureSessionHistoryLoadedCommand({
    get: () => state,
    sessionId: shellSessionId,
    loadOlderHistory: async () => {
      loadOlderCalled = true;
    },
    refreshLatestHistory: async () => {
      refreshCalled = true;
    },
  });

  assert.equal(loadOlderCalled, false);
  assert.equal(refreshCalled, false);
});

test("direct history refresh and older-page loads skip local stored-history shells", async () => {
  const state = pagingState();
  const shellSessionId = [...state.projections.keys()][0]!;
  let fetchCalled = false;
  globalThis.fetch = (async () => {
    fetchCalled = true;
    throw new Error("local stored-history shells must not request history");
  }) as typeof fetch;
  const set = (
    partial:
      | Partial<typeof state>
      | ((current: typeof state) => Partial<typeof state> | typeof state),
  ) => {
    Object.assign(state, typeof partial === "function" ? partial(state) : partial);
  };

  await refreshLatestHistoryCommand({
    get: () => state,
    set,
    sessionId: shellSessionId,
    historyPageLimit: 60,
  });
  await loadOlderHistoryCommand({
    get: () => state,
    set,
    sessionId: shellSessionId,
    historyPageLimit: 60,
  });

  assert.equal(fetchCalled, false);
});

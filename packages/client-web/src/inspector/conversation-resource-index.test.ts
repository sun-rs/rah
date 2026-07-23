import assert from "node:assert/strict";
import test from "node:test";
import type {
  ConversationOutputProjection,
  ConversationResourceIndexResponse,
  ConversationSourceProjection,
  ConversationTurnProjection,
} from "@rah/runtime-protocol";
import {
  invalidateCachedConversationResourceIndex,
  loadCachedConversationResourceIndex,
  loadConversationResourceIndex,
  readCachedConversationResourceIndex,
  resetConversationResourceIndexCacheForTests,
} from "./conversation-resource-index";

function output(id: string): ConversationOutputProjection {
  return {
    id,
    kind: "file",
    label: `${id}.md`,
    path: `/workspace/${id}.md`,
    confidence: "authoritative",
    sourceItemIds: [id],
    activity: "generated",
  };
}

function source(id: string): ConversationSourceProjection {
  return {
    id,
    kind: "url",
    label: id,
    url: `https://example.com/${id}`,
    confidence: "authoritative",
    sourceItemIds: [id],
    activities: ["fetched"],
  };
}

function turn(
  id: string,
  options: {
    outputs?: ConversationOutputProjection[];
    sources?: ConversationSourceProjection[];
  } = {},
): ConversationTurnProjection {
  return {
    id,
    provider: "codex",
    providerTurnId: `provider-${id}`,
    status: "completed",
    statusAuthority: "native",
    items: [],
    activities: [],
    failedItemCount: 0,
    revision: 1,
    itemsView: "full",
    ...(options.outputs ? { outputs: options.outputs } : {}),
    ...(options.sources ? { sources: options.sources } : {}),
  };
}

function response(
  revision: string,
  options: {
    complete?: boolean;
    outputs?: ConversationOutputProjection[];
    sources?: ConversationSourceProjection[];
    warning?: string;
  } = {},
): ConversationResourceIndexResponse {
  return {
    sessionId: "session-1",
    sourceRevision: revision,
    outputs: options.outputs ?? [],
    sources: options.sources ?? [],
    complete: options.complete ?? true,
    generatedAt: "2026-07-23T00:00:00.000Z",
    ...(options.warning ? { warning: options.warning } : {}),
  };
}

test("loads one detached daemon index and merges visible live resources", async () => {
  const requests: Array<{ sessionId: string; refresh?: boolean }> = [];
  const progress: Array<{ outputs: number; sources: number }> = [];
  const result = await loadConversationResourceIndex({
    sessionId: "session-1",
    seedTurns: [turn("live", { outputs: [output("live-output")] })],
    refresh: true,
    dependencies: {
      readIndex: async (sessionId, options) => {
        requests.push({ sessionId, ...(options?.refresh ? { refresh: true } : {}) });
        return response("revision-1", {
          sources: [source("history-source")],
        });
      },
    },
    onProgress: (index) => {
      progress.push({ outputs: index.outputs.length, sources: index.sources.length });
    },
  });

  assert.deepEqual(requests, [{ sessionId: "session-1", refresh: true }]);
  assert.deepEqual(result.outputs.map((entry) => entry.id), ["live-output"]);
  assert.deepEqual(result.sources.map((entry) => entry.id), ["history-source"]);
  assert.deepEqual(progress, [
    { outputs: 1, sources: 0 },
    { outputs: 1, sources: 1 },
  ]);
});

test("shares one request and reuses a freshly validated client cache", async () => {
  resetConversationResourceIndexCacheForTests();
  let requestCount = 0;
  const dependencies = {
    readIndex: async () => {
      requestCount += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return response("revision-1", {
        outputs: [output("cached-output")],
      });
    },
  };

  const [first, concurrent] = await Promise.all([
    loadCachedConversationResourceIndex({
      sessionId: "cached-session",
      dependencies,
    }),
    loadCachedConversationResourceIndex({
      sessionId: "cached-session",
      dependencies,
    }),
  ]);
  const reused = await loadCachedConversationResourceIndex({
    sessionId: "cached-session",
    dependencies,
  });

  assert.equal(requestCount, 1);
  assert.deepEqual(first.outputs.map((entry) => entry.id), ["cached-output"]);
  assert.deepEqual(concurrent, first);
  assert.deepEqual(reused, first);
  assert.equal(readCachedConversationResourceIndex("cached-session")?.complete, true);
  resetConversationResourceIndexCacheForTests();
});

test("manual invalidation forces a new daemon request", async () => {
  resetConversationResourceIndexCacheForTests();
  const requests: Array<{ refresh?: boolean }> = [];
  const dependencies = {
    readIndex: async (_sessionId: string, options?: { refresh?: boolean }) => {
      requests.push(options?.refresh ? { refresh: true } : {});
      return response(`revision-${requests.length}`, {
        outputs: [output(`output-${requests.length}`)],
      });
    },
  };
  await loadCachedConversationResourceIndex({
    sessionId: "retry-session",
    dependencies,
  });
  invalidateCachedConversationResourceIndex("retry-session");
  const refreshed = await loadCachedConversationResourceIndex({
    sessionId: "retry-session",
    dependencies,
  });

  assert.deepEqual(requests, [{}, { refresh: true }]);
  assert.deepEqual(refreshed.outputs.map((entry) => entry.id), ["output-2"]);
  resetConversationResourceIndexCacheForTests();
});

test("surfaces daemon completeness warnings", async () => {
  resetConversationResourceIndexCacheForTests();
  const warnings: string[] = [];
  const result = await loadCachedConversationResourceIndex({
    sessionId: "warning-session",
    dependencies: {
      readIndex: async () =>
        response("revision-1", {
          complete: false,
          sources: [source("summary-source")],
          warning: "1 historical turn detail was unavailable; summary resources were retained.",
        }),
    },
    onWarning: (warning) => warnings.push(warning),
  });

  assert.deepEqual(result.sources.map((entry) => entry.id), ["summary-source"]);
  assert.deepEqual(warnings, [
    "1 historical turn detail was unavailable; summary resources were retained.",
  ]);
  resetConversationResourceIndexCacheForTests();
});

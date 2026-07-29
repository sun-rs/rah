import assert from "node:assert/strict";
import test from "node:test";
import {
  CONVERSATION_RESOURCE_INDEX_PROTOCOL_VERSION,
  type ConversationOutputProjection,
  type ConversationResourceIndexResponse,
  type ConversationSourceProjection,
} from "@rah/runtime-protocol";
import {
  invalidateCachedConversationResourceIndex,
  loadCachedConversationResourceIndex,
  readCachedConversationResourceIndex,
  resetConversationResourceIndexCacheForTests,
  subscribeConversationResourceIndex,
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

function response(
  revision: string,
  options: {
    complete?: boolean;
    indexing?: boolean;
    outputs?: ConversationOutputProjection[];
    sources?: ConversationSourceProjection[];
    warning?: string;
  } = {},
): ConversationResourceIndexResponse {
  return {
    protocolVersion: CONVERSATION_RESOURCE_INDEX_PROTOCOL_VERSION,
    sessionId: "session-1",
    sourceRevision: revision,
    outputs: options.outputs ?? [],
    sources: options.sources ?? [],
    ...(!options.indexing ? { stable: true } : {}),
    ...(options.indexing ? { indexing: true } : {}),
    complete: options.complete ?? true,
    generatedAt: "2026-07-23T00:00:00.000Z",
    ...(options.warning ? { warning: options.warning } : {}),
  };
}

test("rejects a legacy unversioned resource-index response", async () => {
  resetConversationResourceIndexCacheForTests();
  const legacyResponse = {
    ...response("legacy-revision"),
  } as Partial<ConversationResourceIndexResponse>;
  delete legacyResponse.protocolVersion;

  await assert.rejects(
    loadCachedConversationResourceIndex({
      sessionId: "session-1",
      dependencies: {
        readIndex: async () =>
          legacyResponse as ConversationResourceIndexResponse,
      },
    }),
    /incompatible Outputs\/Sources index protocol/,
  );
  resetConversationResourceIndexCacheForTests();
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

test("manual invalidation preserves the last stable index until refresh commits", async () => {
  resetConversationResourceIndexCacheForTests();
  let releaseRefresh!: () => void;
  const refreshGate = new Promise<void>((resolve) => {
    releaseRefresh = resolve;
  });
  let requestCount = 0;
  const dependencies = {
    readIndex: async () => {
      requestCount += 1;
      if (requestCount === 2) {
        await refreshGate;
      }
      return response(`revision-${requestCount}`, {
        outputs: [output(`output-${requestCount}`)],
      });
    },
  };
  await loadCachedConversationResourceIndex({
    sessionId: "stable-refresh-session",
    dependencies,
  });
  const observedIds: string[][] = [];
  const unsubscribe = subscribeConversationResourceIndex(
    "stable-refresh-session",
    (snapshot) => {
      if (snapshot) {
        observedIds.push(snapshot.index.outputs.map((entry) => entry.id));
      }
    },
  );

  invalidateCachedConversationResourceIndex("stable-refresh-session");
  const refreshing = loadCachedConversationResourceIndex({
    sessionId: "stable-refresh-session",
    dependencies,
  });
  await Promise.resolve();
  assert.deepEqual(
    readCachedConversationResourceIndex(
      "stable-refresh-session",
    )?.index.outputs.map((entry) => entry.id),
    ["output-1"],
  );
  assert.equal(observedIds.some((ids) => ids.length === 0), false);

  releaseRefresh();
  await refreshing;
  assert.deepEqual(observedIds.at(-1), ["output-2"]);
  unsubscribe();
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

test("publishes unknown then validated resource counts to cache observers", async () => {
  resetConversationResourceIndexCacheForTests();
  const validatedStates: boolean[] = [];
  const unsubscribe = subscribeConversationResourceIndex(
    "observed-session",
    (snapshot) => {
      if (snapshot) {
        validatedStates.push(snapshot.validated);
      }
    },
  );
  await loadCachedConversationResourceIndex({
    sessionId: "observed-session",
    dependencies: {
      readIndex: async () =>
        response("revision-observed", {
          outputs: [output("observed-output")],
        }),
    },
  });

  assert.deepEqual(validatedStates, [false, true]);
  assert.equal(
    readCachedConversationResourceIndex("observed-session")?.validated,
    true,
  );
  unsubscribe();
  resetConversationResourceIndexCacheForTests();
});

test("follows progressive daemon work without publishing unstable resource snapshots", async () => {
  resetConversationResourceIndexCacheForTests();
  const responses = [
    response("revision-progressive", {
      complete: false,
      indexing: true,
    }),
    response("revision-progressive", {
      complete: false,
      indexing: true,
      sources: [source("partial-source")],
    }),
    response("revision-progressive", {
      outputs: [output("final-output")],
      sources: [source("partial-source"), source("final-source")],
    }),
  ];
  let requestCount = 0;
  const observedSourceCounts: number[] = [];
  const unsubscribe = subscribeConversationResourceIndex(
    "progressive-session",
    (snapshot) => {
      if (snapshot) {
        observedSourceCounts.push(snapshot.index.sources.length);
      }
    },
  );

  const result = await loadCachedConversationResourceIndex({
    sessionId: "progressive-session",
    dependencies: {
      readIndex: async () =>
        responses[Math.min(requestCount++, responses.length - 1)]!,
    },
  });

  assert.equal(requestCount, 3);
  assert.deepEqual(result.outputs.map((entry) => entry.id), ["final-output"]);
  assert.deepEqual(result.sources.map((entry) => entry.id), [
    "partial-source",
    "final-source",
  ]);
  assert.equal(observedSourceCounts.includes(1), false);
  assert.equal(observedSourceCounts.at(-1), 2);
  assert.equal(
    readCachedConversationResourceIndex("progressive-session")?.validated,
    true,
  );
  unsubscribe();
  resetConversationResourceIndexCacheForTests();
});

test("a cancelled view stops waiting without cancelling the shared request", async () => {
  resetConversationResourceIndexCacheForTests();
  const firstController = new AbortController();
  let requestCount = 0;
  let releaseIndex!: () => void;
  const indexGate = new Promise<void>((resolve) => {
    releaseIndex = resolve;
  });
  const dependencies = {
    readIndex: async (
      _sessionId: string,
      options?: { signal?: AbortSignal },
    ) => {
      requestCount += 1;
      assert.equal(options?.signal?.aborted, false);
      await indexGate;
      return response("revision-reselected", {
        outputs: [output("reselected-output")],
      });
    },
  };
  const cancelled = loadCachedConversationResourceIndex({
    sessionId: "reselected-session",
    signal: firstController.signal,
    dependencies,
  });
  const reselected = loadCachedConversationResourceIndex({
    sessionId: "reselected-session",
    dependencies,
  });

  firstController.abort();
  await assert.rejects(cancelled, { name: "AbortError" });
  releaseIndex();
  const result = await reselected;

  assert.equal(requestCount, 1);
  assert.deepEqual(result.outputs.map((entry) => entry.id), [
    "reselected-output",
  ]);
  resetConversationResourceIndexCacheForTests();
});

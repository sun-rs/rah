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
  loadConversationResourceIndex,
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

test("loads one detached daemon index as the only session resource authority", async () => {
  const requests: Array<{ sessionId: string; refresh?: boolean }> = [];
  const result = await loadConversationResourceIndex({
    sessionId: "session-1",
    refresh: true,
    dependencies: {
      readIndex: async (sessionId, options) => {
        requests.push({ sessionId, ...(options?.refresh ? { refresh: true } : {}) });
        return response("revision-1", {
          outputs: [output("history-output")],
          sources: [source("history-source")],
        });
      },
    },
  });

  assert.deepEqual(requests, [{ sessionId: "session-1", refresh: true }]);
  assert.deepEqual(result.outputs.map((entry) => entry.id), ["history-output"]);
  assert.deepEqual(result.sources.map((entry) => entry.id), ["history-source"]);
});

test("rejects a legacy unversioned resource-index response", async () => {
  const legacyResponse = {
    ...response("legacy-revision"),
  } as Partial<ConversationResourceIndexResponse>;
  delete legacyResponse.protocolVersion;

  await assert.rejects(
    loadConversationResourceIndex({
      sessionId: "session-1",
      dependencies: {
        readIndex: async () =>
          legacyResponse as ConversationResourceIndexResponse,
      },
    }),
    /incompatible Outputs\/Sources index protocol/,
  );
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

test("restarts a shared request cancelled by a previous selected view", async () => {
  resetConversationResourceIndexCacheForTests();
  const firstController = new AbortController();
  let requestCount = 0;
  const dependencies = {
    readIndex: async (
      _sessionId: string,
      options?: { signal?: AbortSignal },
    ) => {
      requestCount += 1;
      if (requestCount === 1) {
        return new Promise<ConversationResourceIndexResponse>((_resolve, reject) => {
          options?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("cancelled", "AbortError")),
            { once: true },
          );
        });
      }
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
  const result = await reselected;

  assert.equal(requestCount, 2);
  assert.deepEqual(result.outputs.map((entry) => entry.id), [
    "reselected-output",
  ]);
  resetConversationResourceIndexCacheForTests();
});

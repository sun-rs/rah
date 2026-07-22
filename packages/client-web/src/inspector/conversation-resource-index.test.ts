import assert from "node:assert/strict";
import test from "node:test";
import type {
  ConversationOutputProjection,
  ConversationSourceProjection,
  ConversationTurnProjection,
  ConversationTurnsPageResponse,
} from "@rah/runtime-protocol";
import { loadConversationResourceIndex } from "./conversation-resource-index";

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
    view?: "summary" | "full";
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
    itemsView: options.view ?? "summary",
    ...(options.outputs ? { outputs: options.outputs } : {}),
    ...(options.sources ? { sources: options.sources } : {}),
  };
}

function page(
  turns: ConversationTurnProjection[],
  nextCursor?: string,
): ConversationTurnsPageResponse {
  return {
    sessionId: "session-1",
    turns,
    revision: 1,
    generatedAt: "2026-07-22T00:00:00.000Z",
    sourceEventCount: 0,
    ...(nextCursor ? { nextCursor } : {}),
  };
}

test("indexes every history page without replacing the visible conversation", async () => {
  const seed = turn("seed", { view: "full", outputs: [output("seed-output")] });
  const firstSummary = turn("first", { sources: [source("stale-summary")] });
  const olderSummary = turn("older", { sources: [source("summary-fallback")] });
  const pageRequests: Array<string | undefined> = [];
  const detailRequests: string[] = [];
  const progress: Array<{ outputs: number; sources: number }> = [];

  const result = await loadConversationResourceIndex({
    sessionId: "session-1",
    seedTurns: [seed],
    dependencies: {
      readTurns: async (_sessionId, options) => {
        pageRequests.push(options.cursor);
        return options.cursor ? page([olderSummary]) : page([firstSummary], "older");
      },
      readTurnDetail: async (_sessionId, options) => {
        detailRequests.push(options.providerTurnId);
        if (options.providerTurnId === "provider-older") {
          throw new Error("detail unavailable");
        }
        return {
          sessionId: "session-1",
          turnId: options.turnId,
          turn: turn("first", {
            view: "full",
            outputs: [output("detail-output")],
            sources: [source("detail-source")],
          }),
        };
      },
    },
    onProgress: (index) => {
      progress.push({ outputs: index.outputs.length, sources: index.sources.length });
    },
  });

  assert.deepEqual(pageRequests, [undefined, "older"]);
  assert.deepEqual(detailRequests.sort(), ["provider-first", "provider-older"]);
  assert.deepEqual(result.outputs.map((entry) => entry.id).sort(), [
    "detail-output",
    "seed-output",
  ]);
  assert.deepEqual(result.sources.map((entry) => entry.id), [
    "detail-source",
    "summary-fallback",
  ]);
  assert.ok(!result.sources.some((entry) => entry.id === "stale-summary"));
  assert.ok(progress.length >= 3);
});

test("reuses full seed turns instead of requesting their detail again", async () => {
  const full = turn("full", { view: "full", sources: [source("seed-source")] });
  let detailRequestCount = 0;
  const result = await loadConversationResourceIndex({
    sessionId: "session-1",
    seedTurns: [full],
    dependencies: {
      readTurns: async () => page([{ ...full, itemsView: "summary" }]),
      readTurnDetail: async () => {
        detailRequestCount += 1;
        throw new Error("must not run");
      },
    },
  });

  assert.equal(detailRequestCount, 0);
  assert.deepEqual(result.sources.map((entry) => entry.id), ["seed-source"]);
});

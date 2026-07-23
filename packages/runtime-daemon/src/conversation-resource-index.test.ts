import assert from "node:assert/strict";
import test from "node:test";
import type {
  ConversationOutputProjection,
  ConversationSourceProjection,
  ConversationTurnProjection,
  ConversationTurnsPageResponse,
} from "@rah/runtime-protocol";
import { ConversationResourceIndexStore } from "./conversation-resource-index";

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
    status?: ConversationTurnProjection["status"];
    revision?: number;
    startedAt?: string;
    completedAt?: string;
  } = {},
): ConversationTurnProjection {
  return {
    id,
    provider: "codex",
    providerTurnId: `provider-${id}`,
    status: options.status ?? "completed",
    statusAuthority: "native",
    ...(options.startedAt ? { startedAt: options.startedAt } : {}),
    ...(options.completedAt ? { completedAt: options.completedAt } : {}),
    items: [],
    activities: [],
    failedItemCount: 0,
    revision: options.revision ?? 1,
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
    generatedAt: "2026-07-23T00:00:00.000Z",
    sourceEventCount: 0,
    ...(nextCursor ? { nextCursor } : {}),
  };
}

test("builds one provider-neutral index across pages and turn details", async () => {
  const store = new ConversationResourceIndexStore();
  const summary = turn("recent", { sources: [source("stale-summary")] });
  const fallback = turn("older", { sources: [source("summary-fallback")] });
  const pageRequests: Array<string | undefined> = [];
  const detailRequests: string[] = [];

  const result = await store.load({
    sessionId: "session-1",
    sourceRevision: "revision-1",
    readTurns: async (cursor) => {
      pageRequests.push(cursor);
      return cursor ? page([fallback]) : page([summary], "older");
    },
    readTurnDetail: async (candidate) => {
      detailRequests.push(candidate.providerTurnId!);
      if (candidate.providerTurnId === "provider-older") {
        return undefined;
      }
      return {
        sessionId: "session-1",
        turnId: candidate.id,
        turn: turn("recent", {
          view: "full",
          outputs: [output("report")],
          sources: [source("detail-source")],
        }),
      };
    },
  });

  assert.deepEqual(pageRequests, [undefined, "older"]);
  assert.deepEqual(detailRequests.sort(), ["provider-older", "provider-recent"]);
  assert.deepEqual(result.outputs.map((entry) => entry.id), ["report"]);
  assert.deepEqual(result.sources.map((entry) => entry.id), [
    "detail-source",
    "summary-fallback",
  ]);
  assert.equal(result.complete, false);
  assert.match(result.warning ?? "", /1 historical turn detail was unavailable/);
});

test("shares requests and invalidates cache when the source revision changes", async () => {
  const store = new ConversationResourceIndexStore();
  let pageRequests = 0;
  const load = (sourceRevision: string) =>
    store.load({
      sessionId: "session-1",
      sourceRevision,
      readTurns: async () => {
        pageRequests += 1;
        await new Promise((resolve) => setTimeout(resolve, 5));
        return page([
          turn(sourceRevision, {
            view: "full",
            outputs: [output(sourceRevision)],
          }),
        ]);
      },
      readTurnDetail: async () => undefined,
    });

  const [first, concurrent] = await Promise.all([load("revision-1"), load("revision-1")]);
  const reused = await load("revision-1");
  const changed = await load("revision-2");

  assert.equal(pageRequests, 2);
  assert.equal(first.outputs[0]?.id, "revision-1");
  assert.deepEqual(concurrent, first);
  assert.deepEqual(reused, first);
  assert.equal(changed.outputs[0]?.id, "revision-2");
});

test("reuses stable turn details and only revalidates the active history tail", async () => {
  const store = new ConversationResourceIndexStore();
  let detailVersion = "v1";
  const detailRequests: string[] = [];
  const stable = turn("stable", {
    startedAt: "2026-07-22T00:00:00.000Z",
    completedAt: "2026-07-22T00:01:00.000Z",
  });
  const tail = turn("tail", {
    startedAt: "2026-07-23T00:00:00.000Z",
    completedAt: "2026-07-23T00:01:00.000Z",
  });
  const load = (sourceRevision: string) =>
    store.load({
      sessionId: "session-1",
      sourceRevision,
      readTurns: async () => page([tail, stable]),
      readTurnDetail: async (candidate) => {
        detailRequests.push(candidate.providerTurnId!);
        return {
          sessionId: "session-1",
          turnId: candidate.id,
          turn: turn(candidate.id, {
            view: "full",
            outputs: [output(`${candidate.id}-${detailVersion}`)],
          }),
        };
      },
    });

  const initial = await load("revision-1");
  detailVersion = "v2";
  const appended = await load("revision-2");

  assert.deepEqual(detailRequests.sort(), [
    "provider-stable",
    "provider-tail",
    "provider-tail",
  ]);
  assert.deepEqual(initial.outputs.map((entry) => entry.id).sort(), [
    "stable-v1",
    "tail-v1",
  ]);
  assert.deepEqual(appended.outputs.map((entry) => entry.id).sort(), [
    "stable-v1",
    "tail-v2",
  ]);
});

test("hydrates only a newly appended turn when stable history is unchanged", async () => {
  const store = new ConversationResourceIndexStore();
  const detailRequests: string[] = [];
  let turns = [
    turn("first", {
      startedAt: "2026-07-22T00:00:00.000Z",
      completedAt: "2026-07-22T00:01:00.000Z",
    }),
  ];
  const load = (sourceRevision: string) =>
    store.load({
      sessionId: "session-1",
      sourceRevision,
      readTurns: async () => page(turns),
      readTurnDetail: async (candidate) => {
        detailRequests.push(candidate.providerTurnId!);
        return {
          sessionId: "session-1",
          turnId: candidate.id,
          turn: turn(candidate.id, {
            view: "full",
            outputs: [output(candidate.id)],
          }),
        };
      },
    });

  await load("revision-1");
  turns = [
    turn("second", {
      startedAt: "2026-07-23T00:00:00.000Z",
      completedAt: "2026-07-23T00:01:00.000Z",
    }),
    ...turns,
  ];
  const appended = await load("revision-2");

  assert.deepEqual(detailRequests, ["provider-first", "provider-second"]);
  assert.deepEqual(appended.outputs.map((entry) => entry.id).sort(), ["first", "second"]);
});

test("an explicit refresh rehydrates every summary turn", async () => {
  const store = new ConversationResourceIndexStore();
  let detailRequests = 0;
  const options = {
    sessionId: "session-1",
    sourceRevision: "revision-1",
    readTurns: async () =>
      page([
        turn("newer", {
          startedAt: "2026-07-23T00:00:00.000Z",
          completedAt: "2026-07-23T00:01:00.000Z",
        }),
        turn("older", {
          startedAt: "2026-07-22T00:00:00.000Z",
          completedAt: "2026-07-22T00:01:00.000Z",
        }),
      ]),
    readTurnDetail: async (candidate: ConversationTurnProjection) => {
      detailRequests += 1;
      return {
        sessionId: "session-1",
        turnId: candidate.id,
        turn: turn(candidate.id, { view: "full" }),
      };
    },
  };

  await store.load(options);
  await store.load(options);
  await store.load({ ...options, refresh: true });

  assert.equal(detailRequests, 4);
});

test("removes stale turn resources after a complete rewritten history scan", async () => {
  const store = new ConversationResourceIndexStore();
  let includeRemoved = true;
  const load = (sourceRevision: string) =>
    store.load({
      sessionId: "session-1",
      sourceRevision,
      readTurns: async () =>
        page([
          turn("kept", {
            view: "full",
            outputs: [output("kept")],
          }),
          ...(includeRemoved
            ? [
                turn("removed", {
                  view: "full",
                  outputs: [output("removed")],
                }),
              ]
            : []),
        ]),
      readTurnDetail: async () => undefined,
    });

  const initial = await load("revision-1");
  includeRemoved = false;
  const rewritten = await load("revision-2");

  assert.deepEqual(initial.outputs.map((entry) => entry.id), ["kept", "removed"]);
  assert.deepEqual(rewritten.outputs.map((entry) => entry.id), ["kept"]);
});

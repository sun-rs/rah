import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type {
  ConversationItemProjection,
  ConversationOutputProjection,
  ConversationResourceIndexResponse,
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
    items?: ConversationItemProjection[];
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
    items: options.items ?? [],
    activities: [],
    failedItemCount: 0,
    revision: options.revision ?? 1,
    itemsView: options.view ?? "summary",
    ...(options.outputs ? { outputs: options.outputs } : {}),
    ...(options.sources ? { sources: options.sources } : {}),
  };
}

function timelineItem(
  id: string,
  turnId: string,
  item: Extract<
    ConversationItemProjection["content"],
    { kind: "timeline" }
  >["item"],
  role: ConversationItemProjection["role"] = "process",
): ConversationItemProjection {
  return {
    id,
    turnId,
    role,
    status: "completed",
    content: { kind: "timeline", item },
    source: {
      provider: "codex",
      channel: "structured_persisted",
      authority: "authoritative",
    },
    revision: 1,
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

function createStore(): ConversationResourceIndexStore {
  return new ConversationResourceIndexStore({ persistenceRoot: false });
}

test("builds one provider-neutral index across pages and turn details", async () => {
  const store = createStore();
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

test("progressive loads return immediately and atomically publish the completed index", async () => {
  const store = createStore();
  let releaseDetail!: () => void;
  const detailGate = new Promise<void>((resolve) => {
    releaseDetail = resolve;
  });
  let detailStarted = false;
  const options = {
    sessionId: "progressive-session",
    sourceRevision: "revision-progressive",
    progressive: true,
    readTurns: async () => page([turn("recent")]),
    readTurnDetail: async (candidate: ConversationTurnProjection) => {
      detailStarted = true;
      await detailGate;
      return {
        sessionId: "progressive-session",
        turnId: candidate.id,
        turn: turn(candidate.id, {
          view: "full" as const,
          outputs: [output("progressive-output")],
        }),
      };
    },
  };

  const initial = await store.load(options);
  assert.equal(initial.indexing, true);
  assert.equal(initial.stable, undefined);
  assert.equal(initial.complete, false);

  while (!detailStarted) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  const pending = await store.load(options);
  assert.equal(pending.indexing, true);

  releaseDetail();
  let completed = await store.load(options);
  while (completed.indexing) {
    await new Promise((resolve) => setImmediate(resolve));
    completed = await store.load(options);
  }
  assert.equal(completed.complete, true);
  assert.equal(completed.stable, true);
  assert.deepEqual(completed.outputs.map((entry) => entry.id), [
    "progressive-output",
  ]);
});

test("hydrates resource-likely history before newer ordinary turns", async () => {
  const store = createStore();
  let releaseOrdinary!: () => void;
  const ordinaryGate = new Promise<void>((resolve) => {
    releaseOrdinary = resolve;
  });
  const detailRequests: string[] = [];
  const likelySource = turn("older-source", {
    startedAt: "2026-07-20T00:00:00.000Z",
    completedAt: "2026-07-20T00:01:00.000Z",
    items: [
      timelineItem(
        "older-source-final",
        "older-source",
        {
          kind: "assistant_message",
          phase: "final_answer",
          text: "See [the primary reference](https://example.com/reference).",
        },
        "final",
      ),
    ],
  });
  const ordinaryTurns = [3, 2, 1].map((ordinal) =>
    turn(`newer-${ordinal}`, {
      startedAt: `2026-07-2${ordinal}T00:00:00.000Z`,
      completedAt: `2026-07-2${ordinal}T00:01:00.000Z`,
    }),
  );
  const options = {
    sessionId: "priority-session",
    sourceRevision: "priority-revision",
    progressive: true,
    readTurns: async () => page([...ordinaryTurns, likelySource]),
    readTurnDetail: async (candidate: ConversationTurnProjection) => {
      detailRequests.push(candidate.id);
      if (candidate.id !== "older-source") {
        await ordinaryGate;
      }
      return {
        sessionId: "priority-session",
        turnId: candidate.id,
        turn: turn(candidate.id, {
          view: "full" as const,
          ...(candidate.id === "older-source"
            ? { sources: [source("priority-source")] }
            : {}),
        }),
      };
    },
  };

  await store.load(options);
  let partial = await store.load(options);
  for (let attempt = 0; attempt < 20 && detailRequests.length === 0; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
    partial = await store.load(options);
  }

  assert.equal(detailRequests[0], "older-source");
  assert.deepEqual(partial.sources, []);
  assert.equal(partial.stable, undefined);
  assert.equal(partial.indexing, true);

  releaseOrdinary();
  let completed = await store.load(options);
  while (completed.indexing) {
    await new Promise((resolve) => setImmediate(resolve));
    completed = await store.load(options);
  }
  assert.equal(completed.complete, true);
  assert.equal(completed.stable, true);
  assert.deepEqual(completed.sources.map((entry) => entry.id), [
    "priority-source",
  ]);
});

test("keeps the last stable snapshot visible while a newer revision is indexing", async () => {
  const store = createStore();
  let currentRevisionOutput = "first";
  const initial = await store.load({
    sessionId: "stable-refresh-session",
    sourceRevision: "revision-1",
    readTurns: async () =>
      page([
        turn("turn-1", {
          view: "full",
          outputs: [output(currentRevisionOutput)],
        }),
      ]),
    readTurnDetail: async () => undefined,
  });
  assert.equal(initial.stable, true);

  let releasePage!: () => void;
  const pageGate = new Promise<void>((resolve) => {
    releasePage = resolve;
  });
  currentRevisionOutput = "second";
  const options = {
    sessionId: "stable-refresh-session",
    sourceRevision: "revision-2",
    progressive: true,
    readTurns: async () => {
      await pageGate;
      return page([
        turn("turn-1", {
          view: "full" as const,
          outputs: [output(currentRevisionOutput)],
        }),
      ]);
    },
    readTurnDetail: async () => undefined,
  };

  const refreshing = await store.load(options);
  assert.equal(refreshing.indexing, true);
  assert.equal(refreshing.stable, true);
  assert.equal(refreshing.sourceRevision, "revision-1");
  assert.deepEqual(refreshing.outputs.map((entry) => entry.id), ["first"]);

  releasePage();
  let completed = await store.load(options);
  while (completed.indexing) {
    await new Promise((resolve) => setImmediate(resolve));
    completed = await store.load(options);
  }
  assert.equal(completed.stable, true);
  assert.equal(completed.sourceRevision, "revision-2");
  assert.deepEqual(completed.outputs.map((entry) => entry.id), ["second"]);
});

test("progressive loads never wait on an older revision that is still indexing", async () => {
  const store = createStore();
  let releaseDetail!: () => void;
  const detailGate = new Promise<void>((resolve) => {
    releaseDetail = resolve;
  });
  let detailStarted = false;
  const firstRevision = {
    sessionId: "externally-active-session",
    sourceRevision: "revision-1",
    progressive: true,
    readTurns: async () => page([turn("recent")]),
    readTurnDetail: async () => {
      detailStarted = true;
      await detailGate;
      return undefined;
    },
  };

  const initial = await store.load(firstRevision);
  assert.equal(initial.indexing, true);
  while (!detailStarted) {
    await new Promise((resolve) => setImmediate(resolve));
  }

  const changedRevision = await Promise.race([
    store.load({
      ...firstRevision,
      sourceRevision: "revision-2",
    }),
    new Promise<never>((_resolve, reject) => {
      setTimeout(
        () => reject(new Error("progressive revision read blocked")),
        100,
      );
    }),
  ]);
  assert.equal(changedRevision.indexing, true);
  assert.equal(changedRevision.sourceRevision, "revision-1");

  releaseDetail();
  let completed = await store.load(firstRevision);
  while (completed.indexing) {
    await new Promise((resolve) => setImmediate(resolve));
    completed = await store.load(firstRevision);
  }
});

test("shares requests and invalidates cache when the source revision changes", async () => {
  const store = createStore();
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
  const store = createStore();
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
  const store = createStore();
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
  const store = createStore();
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
  const store = createStore();
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

test("restores a stable index after daemon restart without rescanning history", async () => {
  const persistenceRoot = await mkdtemp(
    path.join(os.tmpdir(), "rah-resource-index-restart-"),
  );
  try {
    const firstStore = new ConversationResourceIndexStore({
      persistenceRoot,
    });
    const initial = await firstStore.load({
      sessionId: "restart-session",
      sourceRevision: "revision-1",
      readTurns: async () =>
        page([
          turn("persisted", {
            view: "full",
            outputs: [output("persisted-output")],
            sources: [source("persisted-source")],
          }),
        ]),
      readTurnDetail: async () => undefined,
    });
    assert.equal(initial.stable, true);
    await firstStore.flushPersistence();

    let historyReads = 0;
    const restartedStore = new ConversationResourceIndexStore({
      persistenceRoot,
    });
    const restored = await restartedStore.load({
      sessionId: "restart-session",
      sourceRevision: "revision-1",
      readTurns: async () => {
        historyReads += 1;
        throw new Error("stable persisted index unexpectedly rescanned history");
      },
      readTurnDetail: async () => {
        throw new Error("stable persisted index unexpectedly hydrated detail");
      },
    });

    assert.equal(historyReads, 0);
    assert.equal(restored.stable, true);
    assert.deepEqual(restored.outputs.map((entry) => entry.id), [
      "persisted-output",
    ]);
    assert.deepEqual(restored.sources.map((entry) => entry.id), [
      "persisted-source",
    ]);
  } finally {
    await rm(persistenceRoot, { recursive: true, force: true });
  }
});

test("restored turn fingerprints make an appended history incremental", async () => {
  const persistenceRoot = await mkdtemp(
    path.join(os.tmpdir(), "rah-resource-index-append-"),
  );
  try {
    const first = turn("first", {
      startedAt: "2026-07-22T00:00:00.000Z",
      completedAt: "2026-07-22T00:01:00.000Z",
    });
    const initialStore = new ConversationResourceIndexStore({
      persistenceRoot,
    });
    await initialStore.load({
      sessionId: "append-session",
      sourceRevision: "revision-1",
      readTurns: async () => page([first]),
      readTurnDetail: async (candidate) => ({
        sessionId: "append-session",
        turnId: candidate.id,
        turn: turn(candidate.id, {
          view: "full",
          outputs: [output(candidate.id)],
        }),
      }),
    });
    await initialStore.flushPersistence();

    const second = turn("second", {
      startedAt: "2026-07-23T00:00:00.000Z",
      completedAt: "2026-07-23T00:01:00.000Z",
    });
    const detailRequests: string[] = [];
    const restartedStore = new ConversationResourceIndexStore({
      persistenceRoot,
    });
    const appended = await restartedStore.load({
      sessionId: "append-session",
      sourceRevision: "revision-2",
      readTurns: async () => page([second, first]),
      readTurnDetail: async (candidate) => {
        detailRequests.push(candidate.id);
        return {
          sessionId: "append-session",
          turnId: candidate.id,
          turn: turn(candidate.id, {
            view: "full",
            outputs: [output(candidate.id)],
          }),
        };
      },
    });

    assert.deepEqual(detailRequests, ["second"]);
    assert.deepEqual(
      appended.outputs.map((entry) => entry.id).sort(),
      ["first", "second"],
    );
    await restartedStore.flushPersistence();
  } finally {
    await rm(persistenceRoot, { recursive: true, force: true });
  }
});

test("persists a replacement only after its full index commits", async () => {
  const persistenceRoot = await mkdtemp(
    path.join(os.tmpdir(), "rah-resource-index-atomic-"),
  );
  try {
    const writer = new ConversationResourceIndexStore({
      persistenceRoot,
    });
    await writer.load({
      sessionId: "atomic-session",
      sourceRevision: "revision-1",
      readTurns: async () =>
        page([
          turn("tail", {
            view: "full",
            outputs: [output("old-output")],
          }),
        ]),
      readTurnDetail: async () => undefined,
    });
    await writer.flushPersistence();

    let releaseDetail!: () => void;
    const detailGate = new Promise<void>((resolve) => {
      releaseDetail = resolve;
    });
    let detailStarted = false;
    const revisionTwoOptions = {
      sessionId: "atomic-session",
      sourceRevision: "revision-2",
      progressive: true,
      readTurns: async () => page([turn("tail")]),
      readTurnDetail: async (candidate: ConversationTurnProjection) => {
        detailStarted = true;
        await detailGate;
        return {
          sessionId: "atomic-session",
          turnId: candidate.id,
          turn: turn(candidate.id, {
            view: "full" as const,
            outputs: [output("new-output")],
          }),
        };
      },
    };
    const indexing = await writer.load(revisionTwoOptions);
    assert.equal(indexing.indexing, true);
    while (!detailStarted) {
      await new Promise((resolve) => setImmediate(resolve));
    }

    const concurrentReader = new ConversationResourceIndexStore({
      persistenceRoot,
    });
    const persistedDuringIndexing = await concurrentReader.load({
      sessionId: "atomic-session",
      sourceRevision: "revision-1",
      readTurns: async () => {
        throw new Error("the prior stable snapshot should still be on disk");
      },
      readTurnDetail: async () => undefined,
    });
    assert.deepEqual(
      persistedDuringIndexing.outputs.map((entry) => entry.id),
      ["old-output"],
    );

    releaseDetail();
    let completed = await writer.load(revisionTwoOptions);
    while (completed.indexing) {
      await new Promise((resolve) => setImmediate(resolve));
      completed = await writer.load(revisionTwoOptions);
    }
    await writer.flushPersistence();

    const restartedReader = new ConversationResourceIndexStore({
      persistenceRoot,
    });
    const persistedAfterCommit = await restartedReader.load({
      sessionId: "atomic-session",
      sourceRevision: "revision-2",
      readTurns: async () => {
        throw new Error("the replacement stable snapshot should be on disk");
      },
      readTurnDetail: async () => undefined,
    });
    assert.deepEqual(
      persistedAfterCommit.outputs.map((entry) => entry.id),
      ["new-output"],
    );
  } finally {
    await rm(persistenceRoot, { recursive: true, force: true });
  }
});

test("coalesces superseded background persistence for the same session", async () => {
  const persistenceRoot = await mkdtemp(
    path.join(os.tmpdir(), "rah-resource-index-coalesce-"),
  );
  try {
    const writer = new ConversationResourceIndexStore({
      persistenceRoot,
    });
    const writerInternals = writer as unknown as {
      persistStableEntry: (
        sessionId: string,
        entry: {
          sourceRevision: string;
          response: ConversationResourceIndexResponse;
          turns: ReadonlyMap<string, unknown>;
        },
      ) => Promise<void>;
    };
    const originalPersist = writerInternals.persistStableEntry.bind(writer);
    const persistedRevisions: string[] = [];
    let releaseFirstPersist!: () => void;
    const firstPersistGate = new Promise<void>((resolve) => {
      releaseFirstPersist = resolve;
    });
    writerInternals.persistStableEntry = async (sessionId, entry) => {
      persistedRevisions.push(entry.sourceRevision);
      if (persistedRevisions.length === 1) {
        await firstPersistGate;
      }
      await originalPersist(sessionId, entry);
    };

    const loadRevision = async (revision: string) => {
      const options = {
        sessionId: "coalesced-session",
        sourceRevision: revision,
        progressive: true,
        readTurns: async () =>
          page([
            turn(revision, {
              view: "full" as const,
              outputs: [output(revision)],
            }),
          ]),
        readTurnDetail: async () => undefined,
      };
      let result = await writer.load(options);
      while (result.indexing) {
        await new Promise((resolve) => setImmediate(resolve));
        result = await writer.load(options);
      }
      return result;
    };

    await loadRevision("revision-1");
    while (persistedRevisions.length === 0) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    await loadRevision("revision-2");
    await loadRevision("revision-3");
    releaseFirstPersist();
    await writer.flushPersistence();

    assert.deepEqual(persistedRevisions, ["revision-1", "revision-3"]);
    const restartedReader = new ConversationResourceIndexStore({
      persistenceRoot,
    });
    const restored = await restartedReader.load({
      sessionId: "coalesced-session",
      sourceRevision: "revision-3",
      readTurns: async () => {
        throw new Error("the newest coalesced snapshot should be restored");
      },
      readTurnDetail: async () => undefined,
    });
    assert.deepEqual(restored.outputs.map((entry) => entry.id), [
      "revision-3",
    ]);
  } finally {
    await rm(persistenceRoot, { recursive: true, force: true });
  }
});

test("rejects an incompatible persisted protocol instead of publishing legacy data", async () => {
  const persistenceRoot = await mkdtemp(
    path.join(os.tmpdir(), "rah-resource-index-version-"),
  );
  try {
    const initialStore = new ConversationResourceIndexStore({
      persistenceRoot,
    });
    await initialStore.load({
      sessionId: "versioned-session",
      sourceRevision: "revision-1",
      readTurns: async () =>
        page([
          turn("legacy", {
            view: "full",
            outputs: [output("legacy-output")],
          }),
        ]),
      readTurnDetail: async () => undefined,
    });
    await initialStore.flushPersistence();
    const [cacheName] = await readdir(persistenceRoot);
    assert.ok(cacheName);
    const cachePath = path.join(persistenceRoot, cacheName);
    const legacyEnvelope = JSON.parse(await readFile(cachePath, "utf8")) as {
      version: number;
    };
    legacyEnvelope.version = 0;
    await writeFile(cachePath, JSON.stringify(legacyEnvelope), "utf8");

    let historyReads = 0;
    const currentStore = new ConversationResourceIndexStore({
      persistenceRoot,
    });
    const rebuilt = await currentStore.load({
      sessionId: "versioned-session",
      sourceRevision: "revision-1",
      readTurns: async () => {
        historyReads += 1;
        return page([
          turn("current", {
            view: "full",
            outputs: [output("current-output")],
          }),
        ]);
      },
      readTurnDetail: async () => undefined,
    });

    assert.equal(historyReads, 1);
    assert.deepEqual(rebuilt.outputs.map((entry) => entry.id), [
      "current-output",
    ]);
    await currentStore.flushPersistence();
  } finally {
    await rm(persistenceRoot, { recursive: true, force: true });
  }
});

test("rejects a persisted envelope whose committed snapshot revision does not match", async () => {
  const persistenceRoot = await mkdtemp(
    path.join(os.tmpdir(), "rah-resource-index-revision-mismatch-"),
  );
  try {
    const initialStore = new ConversationResourceIndexStore({
      persistenceRoot,
    });
    await initialStore.load({
      sessionId: "mismatched-session",
      sourceRevision: "revision-1",
      readTurns: async () =>
        page([
          turn("stale", {
            view: "full",
            outputs: [output("stale-output")],
          }),
        ]),
      readTurnDetail: async () => undefined,
    });
    await initialStore.flushPersistence();
    const [cacheName] = await readdir(persistenceRoot);
    assert.ok(cacheName);
    const cachePath = path.join(persistenceRoot, cacheName);
    const mismatchedEnvelope = JSON.parse(await readFile(cachePath, "utf8")) as {
      response: { sourceRevision: string };
    };
    mismatchedEnvelope.response.sourceRevision = "different-revision";
    await writeFile(cachePath, JSON.stringify(mismatchedEnvelope), "utf8");

    let historyReads = 0;
    const restartedStore = new ConversationResourceIndexStore({
      persistenceRoot,
    });
    const rebuilt = await restartedStore.load({
      sessionId: "mismatched-session",
      sourceRevision: "revision-1",
      readTurns: async () => {
        historyReads += 1;
        return page([
          turn("current", {
            view: "full",
            outputs: [output("current-output")],
          }),
        ]);
      },
      readTurnDetail: async () => undefined,
    });

    assert.equal(historyReads, 1);
    assert.deepEqual(rebuilt.outputs.map((entry) => entry.id), [
      "current-output",
    ]);
    await restartedStore.flushPersistence();
  } finally {
    await rm(persistenceRoot, { recursive: true, force: true });
  }
});

test("retries a transient first-build failure for the same source revision", async () => {
  const store = createStore();
  let attempts = 0;
  const options = {
    sessionId: "retry-session",
    sourceRevision: "revision-1",
    progressive: true,
    readTurns: async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error("temporary provider read failure");
      }
      return page([
        turn("recovered", {
          view: "full" as const,
          outputs: [output("recovered-output")],
        }),
      ]);
    },
    readTurnDetail: async () => undefined,
  };

  const indexing = await store.load(options);
  assert.equal(indexing.indexing, true);

  await new Promise((resolve) => setImmediate(resolve));
  const retrying = await store.load(options);
  assert.equal(retrying.indexing, true);
  let recovered = await store.load(options);
  while (recovered.indexing) {
    await new Promise((resolve) => setImmediate(resolve));
    recovered = await store.load(options);
  }
  assert.equal(attempts, 2);
  assert.equal(recovered.complete, true);
  assert.deepEqual(recovered.outputs.map((entry) => entry.id), [
    "recovered-output",
  ]);
});

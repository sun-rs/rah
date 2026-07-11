import assert from "node:assert/strict";
import test from "node:test";
import type {
  ConversationItemDetailResponse,
  ConversationItemProjection,
  ConversationProjectionDelta,
  ConversationTurnDetailResponse,
  ConversationTurnProjection,
  ConversationTurnsPageResponse,
} from "@rah/runtime-protocol";
import {
  conversationV2DisplayRows,
  conversationV2FinalAssistantKeys,
  conversationV2TurnsToFeed,
} from "./conversation-v2-feed";
import { resolveConversationV2Enabled } from "./conversation-v2-feature";
import {
  applyConversationV2DeltasToProjectionMap,
  conversationV2LegacyDetailId,
  ensureConversationV2LoadedCommand,
  initializeLiveConversationV2Command,
  loadConversationV2ItemDetailCommand,
  loadConversationV2TurnDetailCommand,
  loadPreferredConversationHistory,
  loadOlderConversationV2Command,
  refreshConversationV2Command,
} from "./session-store-conversation-v2";
import type { SessionProjection } from "./types";

test("Conversation V2 defaults on while preserving explicit rollback controls", () => {
  assert.equal(resolveConversationV2Enabled(null, null), true);
  assert.equal(resolveConversationV2Enabled("1", "0"), true);
  assert.equal(resolveConversationV2Enabled("0", "1"), false);
  assert.equal(resolveConversationV2Enabled(null, "1"), true);
  assert.equal(resolveConversationV2Enabled(null, "0"), false);
});

test("Conversation V2 history avoids legacy double reads and falls back only on failure", async () => {
  const calls: string[] = [];
  const preferred = await loadPreferredConversationHistory({
    conversationV2Enabled: true,
    loadConversationV2: async () => {
      calls.push("v2");
      return true;
    },
    loadLegacy: async () => {
      calls.push("legacy");
    },
  });
  assert.equal(preferred, "conversation_v2");
  assert.deepEqual(calls, ["v2"]);

  calls.length = 0;
  const fallback = await loadPreferredConversationHistory({
    conversationV2Enabled: true,
    loadConversationV2: async () => {
      calls.push("v2");
      return false;
    },
    loadLegacy: async () => {
      calls.push("legacy");
    },
  });
  assert.equal(fallback, "legacy");
  assert.deepEqual(calls, ["v2", "legacy"]);
});

function timelineItem(
  id: string,
  turnId: string,
  role: "user" | "process" | "final",
  text: string,
): ConversationItemProjection {
  return {
    id,
    turnId,
    role,
    status: "completed",
    content: {
      kind: "timeline",
      item: {
        kind: role === "user" ? "user_message" : "assistant_message",
        text,
      },
    },
    source: { provider: "codex", channel: "history", authority: "provider_native" },
    revision: 1,
  };
}

function observationItem(
  id: string,
  turnId: string,
  detailAvailable: boolean,
): ConversationItemProjection {
  return {
    id,
    turnId,
    providerItemId: `provider-${id}`,
    role: "process",
    status: "completed",
    detailAvailable,
    content: {
      kind: "observation",
      observation: {
        id: `native-${id}`,
        kind: "command.run",
        status: "completed",
        title: "Run command",
        detailAvailable,
      },
    },
    source: { provider: "codex", channel: "history", authority: "provider_native" },
    revision: 1,
  };
}

function turn(
  id: string,
  items: ConversationItemProjection[],
  providerTurnId = `provider-${id}`,
): ConversationTurnProjection {
  return {
    id,
    provider: "codex",
    providerTurnId,
    status: "completed",
    statusAuthority: "native",
    items,
    failedItemCount: 0,
    revision: 1,
  };
}

function page(
  turns: ConversationTurnProjection[],
  nextCursor?: string,
  liveRevision = 0,
): ConversationTurnsPageResponse {
  return {
    sessionId: "session-1",
    turns,
    revision: 1,
    liveRevision,
    generatedAt: "2026-07-10T00:00:00.000Z",
    sourceEventCount: turns.length,
    ...(nextCursor ? { nextCursor } : {}),
    approximateBytes: 100,
  };
}

function harness(responses: Array<ConversationTurnsPageResponse | Promise<ConversationTurnsPageResponse>>) {
  let state = {
    projections: new Map<string, SessionProjection>([
      [
        "session-1",
        {
          summary: {} as SessionProjection["summary"],
          feed: [],
          events: [],
          lastSeq: 0,
          history: {
            phase: "idle",
            nextCursor: null,
            nextBeforeTs: null,
            generation: 0,
            authoritativeApplied: false,
            lastError: null,
          },
        },
      ],
    ]),
  };
  const requests: Array<{ cursor?: string; liveOnly?: boolean }> = [];
  const deps = {
    get: () => state,
    set: (
      partial:
        | Partial<typeof state>
        | ((current: typeof state) => Partial<typeof state> | typeof state),
    ) => {
      const resolved = typeof partial === "function" ? partial(state) : partial;
      state = { ...state, ...resolved };
    },
    readTurns: async (
      _sessionId: string,
      options?: { cursor?: string; liveOnly?: boolean },
    ) => {
      requests.push({
        ...(options?.cursor ? { cursor: options.cursor } : {}),
        ...(options?.liveOnly ? { liveOnly: true } : {}),
      });
      const response = responses.shift();
      assert.ok(response);
      return await response;
    },
  };
  return { deps, requests, state: () => state };
}

function delta(
  revision: number,
  baseRevision: number,
  projectedTurn: ConversationTurnProjection,
): ConversationProjectionDelta {
  const { items, ...turnState } = projectedTurn;
  return {
    sessionId: "session-1",
    baseRevision,
    revision,
    upsertTurns: [{ turn: turnState, upsertItems: items }],
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

test("Conversation V2 feed uses explicit process/final roles and canonical detail ids", () => {
  const process = timelineItem("process", "turn-1", "process", "working");
  const final = timelineItem("final", "turn-1", "final", "done");
  const observation = observationItem("observation", "turn-1", true);
  const feed = conversationV2TurnsToFeed([turn("turn-1", [process, final, observation])]);

  assert.equal(
    feed[0]?.kind === "timeline" && feed[0].item.kind === "assistant_message"
      ? feed[0].item.phase
      : null,
    "commentary",
  );
  assert.equal(
    feed[1]?.kind === "timeline" && feed[1].item.kind === "assistant_message"
      ? feed[1].item.phase
      : null,
    "final_answer",
  );
  assert.equal(
    feed[2]?.kind === "observation" ? feed[2].observation.id : null,
    "observation",
  );
});

test("Conversation V2 preserves interrupted process status in the rendered feed", () => {
  const observation: ConversationItemProjection = {
    ...observationItem("observation", "turn-1", false),
    status: "interrupted",
    content: {
      kind: "observation",
      observation: {
        id: "native-observation",
        kind: "command.run",
        status: "running",
        title: "Run command",
      },
    },
  };
  const projectedTurn: ConversationTurnProjection = {
    ...turn("turn-1", [observation]),
    status: "interrupted",
  };

  const [entry] = conversationV2TurnsToFeed([projectedTurn]);
  assert.equal(entry?.kind, "observation");
  if (entry?.kind === "observation") {
    assert.equal(entry.status, "interrupted");
    assert.equal(entry.observation.status, "canceled");
  }
});

test("Conversation V2 display uses canonical turn lifecycle instead of feed inference", () => {
  const projectedTurn: ConversationTurnProjection = {
    ...turn("turn-1", [
      timelineItem("user", "turn-1", "user", "question"),
      timelineItem("process", "turn-1", "process", "working"),
      observationItem("observation", "turn-1", false),
      timelineItem("final", "turn-1", "final", "done"),
    ]),
    finalAnswerItemId: "final",
    startedAt: "2026-07-10T00:00:00.000Z",
    completedAt: "2026-07-10T00:01:00.000Z",
    durationMs: 12_345,
    failedItemCount: 1,
  };
  const feed = conversationV2TurnsToFeed([projectedTurn]);
  const rows = conversationV2DisplayRows([projectedTurn], feed);

  assert.deepEqual(rows.map((row) => row.kind), [
    "feed_entry",
    "assistant_process_group",
    "feed_entry",
  ]);
  const process = rows[1];
  assert.equal(process?.kind, "assistant_process_group");
  if (process?.kind === "assistant_process_group") {
    assert.deepEqual(process.entries.map((entry) => entry.key), [
      "conversation-v2:process",
      "conversation-v2:observation",
    ]);
    assert.equal(process.turnStatus, "completed");
    assert.equal(process.completed, true);
    assert.equal(process.active, false);
    assert.equal(process.durationMs, 12_345);
    assert.equal(process.failedCount, 1);
  }
  assert.deepEqual([...conversationV2FinalAssistantKeys([projectedTurn])], [
    "conversation-v2:final",
  ]);
});

test("Conversation V2 does not promote an in-progress final item into completed reply actions", () => {
  const projectedTurn: ConversationTurnProjection = {
    ...turn("turn-live", [
      timelineItem("process-live", "turn-live", "process", "working"),
      timelineItem("final-live", "turn-live", "final", "not settled"),
    ]),
    status: "in_progress",
    finalAnswerItemId: "final-live",
  };
  const feed = conversationV2TurnsToFeed([projectedTurn]);
  const rows = conversationV2DisplayRows([projectedTurn], feed);
  const process = rows[0];

  assert.equal(process?.kind, "assistant_process_group");
  if (process?.kind === "assistant_process_group") {
    assert.equal(process.turnStatus, "in_progress");
    assert.equal(process.completed, false);
    assert.equal(process.active, true);
  }
  assert.deepEqual([...conversationV2FinalAssistantKeys([projectedTurn])], []);
});

test("Conversation V2 renders a lazy process placeholder for native summary turns", () => {
  const projectedTurn: ConversationTurnProjection = {
    ...turn("turn-summary", [
      timelineItem("user-summary", "turn-summary", "user", "question"),
      timelineItem("final-summary", "turn-summary", "final", "answer"),
    ]),
    itemsView: "summary",
    finalAnswerItemId: "final-summary",
    durationMs: 60_000,
  };
  const rows = conversationV2DisplayRows(
    [projectedTurn],
    conversationV2TurnsToFeed([projectedTurn]),
  );

  assert.deepEqual(rows.map((row) => row.kind), [
    "feed_entry",
    "assistant_process_group",
    "feed_entry",
  ]);
  const process = rows[1];
  assert.equal(process?.kind, "assistant_process_group");
  if (process?.kind === "assistant_process_group") {
    assert.equal(process.turnId, "turn-summary");
    assert.equal(process.detailsAvailable, true);
    assert.deepEqual(process.entries, []);
    assert.equal(process.durationMs, 60_000);
  }
});

test("Conversation V2 store pages older turns, refreshes newer turns, and preserves cursor", async () => {
  const latest = turn("turn-2", [timelineItem("final-2", "turn-2", "final", "two")]);
  const older = turn("turn-1", [timelineItem("final-1", "turn-1", "final", "one")]);
  const newest = turn("turn-3", [timelineItem("final-3", "turn-3", "final", "three")]);
  const testHarness = harness([
    page([latest], "older-cursor"),
    page([older]),
    page([latest, newest], "must-not-reopen-pagination"),
  ]);

  assert.equal(await ensureConversationV2LoadedCommand(testHarness.deps, "session-1"), true);
  assert.equal(await loadOlderConversationV2Command(testHarness.deps, "session-1"), true);
  assert.equal(await refreshConversationV2Command(testHarness.deps, "session-1"), true);

  const conversation = testHarness.state().projections.get("session-1")?.conversationV2;
  assert.deepEqual(conversation?.turns.map((candidate) => candidate.id), [
    "turn-1",
    "turn-2",
    "turn-3",
  ]);
  assert.equal(conversation?.nextCursor, null);
  assert.deepEqual(testHarness.requests, [{}, { cursor: "older-cursor" }, {}]);
});

test("new live sessions initialize from the resident projection without history paging", async () => {
  const testHarness = harness([page([], undefined, 0)]);

  assert.equal(await initializeLiveConversationV2Command(testHarness.deps, "session-1"), true);
  assert.deepEqual(testHarness.requests, [{ liveOnly: true }]);
  assert.equal(
    testHarness.state().projections.get("session-1")?.conversationV2?.phase,
    "ready",
  );
});

test("Conversation V2 serializes resident initialization and a concurrent history load", async () => {
  const resident = deferred<ConversationTurnsPageResponse>();
  const historicalTurn = turn("turn-history", [
    timelineItem("final-history", "turn-history", "final", "history"),
  ]);
  const testHarness = harness([resident.promise, page([historicalTurn])]);

  const initialize = initializeLiveConversationV2Command(testHarness.deps, "session-1");
  const loadHistory = ensureConversationV2LoadedCommand(testHarness.deps, "session-1");
  assert.deepEqual(testHarness.requests, [{ liveOnly: true }]);

  resident.resolve(page([], undefined, 0));
  assert.equal(await initialize, true);
  assert.equal(await loadHistory, true);
  assert.deepEqual(testHarness.requests, [{ liveOnly: true }, {}]);
  const conversation = testHarness.state().projections.get("session-1")?.conversationV2;
  assert.equal(conversation?.loadedScope, "history");
  assert.equal(conversation?.turns[0]?.id, "turn-history");
});

test("Conversation V2 applies deltas that arrive while the HTTP baseline is loading", async () => {
  const response = deferred<ConversationTurnsPageResponse>();
  const testHarness = harness([response.promise]);
  const load = ensureConversationV2LoadedCommand(testHarness.deps, "session-1");
  const liveTurn = turn(
    "turn-live",
    [timelineItem("process-live", "turn-live", "process", "working")],
  );
  testHarness.deps.set((state) => ({
    projections: applyConversationV2DeltasToProjectionMap(
      state.projections,
      [delta(1, 0, liveTurn)],
    ),
  }));
  response.resolve(page([], undefined, 0));

  assert.equal(await load, true);
  const conversation = testHarness.state().projections.get("session-1")?.conversationV2;
  assert.equal(conversation?.daemonRevision, 1);
  assert.equal(conversation?.needsRefresh, false);
  assert.equal(conversation?.turns[0]?.items[0]?.id, "process-live");
});

test("Conversation V2 holds revision gaps and applies the complete chain when it arrives", async () => {
  const initial = turn("turn-live", []);
  const testHarness = harness([page([initial], undefined, 1)]);
  await ensureConversationV2LoadedCommand(testHarness.deps, "session-1");
  const second = turn(
    "turn-live",
    [timelineItem("second", "turn-live", "process", "second")],
  );
  const third = turn(
    "turn-live",
    [timelineItem("third", "turn-live", "final", "third")],
  );

  testHarness.deps.set((state) => ({
    projections: applyConversationV2DeltasToProjectionMap(
      state.projections,
      [delta(3, 2, third)],
    ),
  }));
  let conversation = testHarness.state().projections.get("session-1")?.conversationV2;
  assert.equal(conversation?.daemonRevision, 1);
  assert.equal(conversation?.needsRefresh, true);
  assert.deepEqual(conversation?.turns[0]?.items, []);

  testHarness.deps.set((state) => ({
    projections: applyConversationV2DeltasToProjectionMap(
      state.projections,
      [delta(2, 1, second)],
    ),
  }));
  conversation = testHarness.state().projections.get("session-1")?.conversationV2;
  assert.equal(conversation?.daemonRevision, 3);
  assert.equal(conversation?.needsRefresh, false);
  assert.deepEqual(
    conversation?.turns[0]?.items.map((item) => item.id),
    ["second", "third"],
  );
});

test("Conversation V2 clears an unresolved delta gap from a fresh HTTP baseline", async () => {
  const initial = turn("turn-live", []);
  const recovered = turn(
    "turn-live",
    [timelineItem("recovered", "turn-live", "final", "recovered")],
  );
  const testHarness = harness([
    page([initial], undefined, 1),
    page([recovered], undefined, 3),
  ]);
  await ensureConversationV2LoadedCommand(testHarness.deps, "session-1");
  testHarness.deps.set((state) => ({
    projections: applyConversationV2DeltasToProjectionMap(
      state.projections,
      [delta(3, 2, recovered)],
    ),
  }));

  assert.equal(await refreshConversationV2Command(testHarness.deps, "session-1"), true);
  const conversation = testHarness.state().projections.get("session-1")?.conversationV2;
  assert.equal(conversation?.daemonRevision, 3);
  assert.equal(conversation?.needsRefresh, false);
  assert.deepEqual(conversation?.pendingDeltas, []);
  assert.equal(conversation?.turns[0]?.items[0]?.id, "recovered");
});

test("Conversation V2 retains the native detail id for legacy fallback", async () => {
  const summary = observationItem("observation", "turn-1", true);
  const testHarness = harness([page([turn("turn-1", [summary])])]);
  await ensureConversationV2LoadedCommand(testHarness.deps, "session-1");
  const projection = testHarness.state().projections.get("session-1");
  assert.ok(projection);
  assert.equal(
    conversationV2LegacyDetailId(projection, "observation", "observation"),
    "native-observation",
  );
});

test("Conversation V2 detail request uses opaque native ids and replaces only the canonical item", async () => {
  const summary = observationItem("observation", "turn-1", true);
  const testHarness = harness([page([turn("turn-1", [summary])])]);
  await ensureConversationV2LoadedCommand(testHarness.deps, "session-1");
  const detailRequests: unknown[] = [];
  const detailed: ConversationItemDetailResponse = {
    sessionId: "session-1",
    turnId: "turn-1",
    itemId: "observation",
    item: {
      ...summary,
      content: {
        kind: "observation",
        observation: {
          id: "native-observation",
          kind: "command.run",
          status: "completed",
          title: "Run command",
          detailAvailable: false,
          detail: { artifacts: [{ kind: "text", label: "Output", text: "complete" }] },
        },
      },
      detailAvailable: false,
      revision: 2,
    },
    approximateBytes: 50,
  };
  const loaded = await loadConversationV2ItemDetailCommand(
    {
      ...testHarness.deps,
      readItemDetail: async (sessionId, options) => {
        detailRequests.push({ sessionId, ...options });
        return detailed;
      },
    },
    "session-1",
    "observation",
  );

  assert.equal(loaded, true);
  assert.deepEqual(detailRequests, [
    {
      sessionId: "session-1",
      itemId: "observation",
      providerTurnId: "provider-turn-1",
      providerItemId: "provider-observation",
    },
  ]);
  const item = testHarness.state().projections.get("session-1")?.conversationV2?.turns[0]?.items[0];
  assert.equal(item?.revision, 2);

  const updatedSummary: ConversationItemProjection = {
    ...summary,
    status: "failed",
    revision: 3,
  };
  testHarness.deps.set((state) => ({
    projections: applyConversationV2DeltasToProjectionMap(
      state.projections,
      [delta(1, 0, { ...turn("turn-1", [updatedSummary]), revision: 3 })],
    ),
  }));
  const updated = testHarness.state().projections.get("session-1")?.conversationV2?.turns[0]?.items[0];
  assert.equal(updated?.status, "failed");
  assert.equal(
    updated?.content.kind === "observation"
      ? updated.content.observation.detail?.artifacts[0]?.kind === "text"
        ? updated.content.observation.detail.artifacts[0].text
        : null
      : null,
    "complete",
  );
});

test("Conversation V2 turn detail hydrates process items without replacing the visible exchange", async () => {
  const user = timelineItem("user", "turn-1", "user", "question");
  const final = timelineItem("final", "turn-1", "final", "answer");
  const summaryTurn: ConversationTurnProjection = {
    ...turn("turn-1", [user, final]),
    itemsView: "summary",
    finalAnswerItemId: "final",
  };
  const refreshedFinal = timelineItem("final", "turn-1", "final", "answer refreshed");
  const refreshedSummaryTurn: ConversationTurnProjection = {
    ...summaryTurn,
    items: [user, refreshedFinal],
    revision: 2,
  };
  const testHarness = harness([page([summaryTurn]), page([refreshedSummaryTurn])]);
  await ensureConversationV2LoadedCommand(testHarness.deps, "session-1");
  const process = timelineItem("process", "turn-1", "process", "working");
  const detailRequests: unknown[] = [];
  const detailed: ConversationTurnDetailResponse = {
    sessionId: "session-1",
    turnId: "turn-1",
    turn: {
      ...summaryTurn,
      items: [process],
      itemsView: "full",
      revision: 2,
    },
    approximateBytes: 50,
  };

  const loaded = await loadConversationV2TurnDetailCommand(
    {
      ...testHarness.deps,
      readTurnDetail: async (sessionId, options) => {
        detailRequests.push({ sessionId, ...options });
        return detailed;
      },
    },
    "session-1",
    "turn-1",
  );

  assert.equal(loaded, true);
  assert.deepEqual(detailRequests, [
    {
      sessionId: "session-1",
      turnId: "turn-1",
      providerTurnId: "provider-turn-1",
    },
  ]);
  const hydrated = testHarness.state().projections.get("session-1")?.conversationV2?.turns[0];
  assert.equal(hydrated?.itemsView, "full");
  assert.deepEqual(hydrated?.items.map((item) => item.id), ["user", "process", "final"]);
  assert.equal(hydrated?.items[0], user);
  assert.equal(hydrated?.items[2], final);

  assert.equal(await refreshConversationV2Command(testHarness.deps, "session-1"), true);
  const refreshed = testHarness.state().projections.get("session-1")?.conversationV2?.turns[0];
  assert.equal(refreshed?.itemsView, "full");
  assert.deepEqual(refreshed?.items.map((item) => item.id), ["user", "process", "final"]);
  assert.equal(
    refreshed?.items[2]?.content.kind === "timeline"
      ? refreshed.items[2].content.item.kind === "assistant_message"
        ? refreshed.items[2].content.item.text
        : null
      : null,
    "answer refreshed",
  );
});

test("Conversation V2 keeps hydrated process detail across a live summary delta", async () => {
  const user = timelineItem("user", "turn-1", "user", "question");
  const final = timelineItem("final", "turn-1", "final", "answer");
  const summaryObservation = observationItem("observation", "turn-1", true);
  const summaryTurn: ConversationTurnProjection = {
    ...turn("turn-1", [user, summaryObservation, final]),
    itemsView: "summary",
    finalAnswerItemId: "final",
  };
  const testHarness = harness([page([summaryTurn], undefined, 0)]);
  await ensureConversationV2LoadedCommand(testHarness.deps, "session-1");
  const detailedObservation: ConversationItemProjection = {
    ...summaryObservation,
    content: {
      kind: "observation",
      observation: {
        ...(summaryObservation.content.kind === "observation"
          ? summaryObservation.content.observation
          : {}),
        id: "native-observation",
        kind: "command.run",
        status: "completed",
        title: "Run command",
        detailAvailable: false,
        detail: { artifacts: [{ kind: "text", label: "Output", text: "full detail" }] },
      },
    },
    detailAvailable: false,
    revision: 2,
  };
  await loadConversationV2TurnDetailCommand(
    {
      ...testHarness.deps,
      readTurnDetail: async () => ({
        sessionId: "session-1",
        turnId: "turn-1",
        turn: {
          ...summaryTurn,
          items: [detailedObservation],
          itemsView: "full",
          revision: 2,
        },
      }),
    },
    "session-1",
    "turn-1",
  );

  const failedSummaryObservation: ConversationItemProjection = {
    ...summaryObservation,
    status: "failed",
    content: {
      ...summaryObservation.content,
      ...(summaryObservation.content.kind === "observation"
        ? {
            observation: {
              ...summaryObservation.content.observation,
              status: "failed" as const,
            },
            error: "command failed",
          }
        : {}),
    },
    revision: 3,
  };
  const deltaTurn: ConversationTurnProjection = {
    ...summaryTurn,
    items: [user, failedSummaryObservation, final],
    itemsView: "summary",
    failedItemCount: 1,
    revision: 3,
  };
  testHarness.deps.set((state) => ({
    projections: applyConversationV2DeltasToProjectionMap(
      state.projections,
      [delta(1, 0, deltaTurn)],
    ),
  }));

  const hydrated = testHarness.state().projections.get("session-1")?.conversationV2?.turns[0];
  const observation = hydrated?.items.find((item) => item.id === "observation");
  assert.equal(hydrated?.itemsView, "full");
  assert.equal(observation?.status, "failed");
  assert.equal(
    observation?.content.kind === "observation"
      ? observation.content.observation.detail?.artifacts[0]?.kind === "text"
        ? observation.content.observation.detail.artifacts[0].text
        : null
      : null,
    "full detail",
  );
});

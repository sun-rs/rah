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
import { summarizeConversationActivities } from "@rah/runtime-protocol";
import {
  conversationDisplayRows,
  conversationFinalAssistantKeys,
  conversationTurnsToFeed,
} from "./conversation-feed";
import {
  applyConversationDeltasToProjectionMap,
  ensureConversationLoadedCommand,
  initializeLiveConversationCommand,
  loadConversationItemDetailCommand,
  hydrateConversationTurnByProviderIdCommand,
  loadConversationTurnDetailCommand,
  loadOlderConversationCommand,
  refreshConversationCommand,
} from "./session-store-conversation";
import type { FeedEntry, SessionProjection } from "./types";

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
    activities: summarizeConversationActivities(items),
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
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

test("Conversation feed uses explicit process/final roles and canonical detail ids", () => {
  const process = timelineItem("process", "turn-1", "process", "working");
  const final = timelineItem("final", "turn-1", "final", "done");
  const observation = observationItem("observation", "turn-1", true);
  const feed = conversationTurnsToFeed([turn("turn-1", [process, final, observation])]);

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

test("Conversation renders a local pending user turn immediately and hands off by client id", () => {
  const clientMessageId = "client-message:new-session";
  const optimisticUser: FeedEntry = {
    key: `optimistic:user:${clientMessageId}`,
    kind: "timeline",
    item: {
      kind: "user_message",
      text: "first question",
      clientMessageId,
    },
    ts: "2026-07-10T00:00:00.000Z",
  };
  const liveTurn: ConversationTurnProjection = {
    ...turn("turn-live", [
      {
        ...timelineItem("process-live", "turn-live", "process", "working"),
        status: "running",
      },
    ]),
    status: "in_progress",
    startedAt: "2026-07-10T00:00:01.000Z",
  };

  const pendingFeed = conversationTurnsToFeed([liveTurn], [optimisticUser]);
  assert.equal(pendingFeed.at(-1)?.key, optimisticUser.key);
  assert.deepEqual(
    conversationDisplayRows([liveTurn], pendingFeed).map((row) => row.key),
    [optimisticUser.key, "conversation-process:turn-live"],
  );

  const canonicalUser = timelineItem("user-live", "turn-live", "user", "first question");
  if (canonicalUser.content.kind !== "timeline" || canonicalUser.content.item.kind !== "user_message") {
    assert.fail("expected a user timeline item");
  }
  canonicalUser.content.item.clientMessageId = clientMessageId;
  const canonicalTurn = { ...liveTurn, items: [canonicalUser, ...liveTurn.items] };
  const canonicalFeed = conversationTurnsToFeed([canonicalTurn], [optimisticUser]);

  assert.equal(canonicalFeed.some((entry) => entry.key === optimisticUser.key), false);
  assert.equal(
    canonicalFeed.filter(
      (entry) => entry.kind === "timeline" && entry.item.kind === "user_message",
    ).length,
    1,
  );
});

test("Conversation does not re-render an optimistic key after the live store resolves it", () => {
  const canonicalTurn = turn("turn-live", [
    timelineItem("user-live", "turn-live", "user", "连续提问"),
  ]);
  const resolvedOptimistic: FeedEntry = {
    key: "optimistic:user:client-message-1",
    kind: "timeline",
    item: { kind: "user_message", text: "连续提问" },
    ts: "2026-07-10T00:00:00.000Z",
    turnId: "provider-turn-live",
    canonicalTurnId: "turn-live",
  };

  const feed = conversationTurnsToFeed([canonicalTurn], [resolvedOptimistic]);
  assert.equal(
    feed.filter(
      (entry) => entry.kind === "timeline" && entry.item.kind === "user_message",
    ).length,
    1,
  );
  assert.equal(feed.some((entry) => entry.key === resolvedOptimistic.key), false);
});

test("Conversation leaves queued optimistic questions after the active turn", () => {
  const activeTurn: ConversationTurnProjection = {
    ...turn("turn-active", [
      timelineItem("user-active", "turn-active", "user", "first"),
      timelineItem("process-active", "turn-active", "process", "working"),
    ]),
    status: "in_progress",
    startedAt: "2026-07-10T00:00:00.000Z",
  };
  const queuedUser: FeedEntry = {
    key: "optimistic:user:queued",
    kind: "timeline",
    item: { kind: "user_message", text: "queued" },
    ts: "2026-07-10T00:00:05.000Z",
  };
  const feed = conversationTurnsToFeed([activeTurn], [queuedUser]);

  assert.deepEqual(
    conversationDisplayRows([activeTurn], feed).map((row) => row.key),
    [
      "conversation:user-active",
      "conversation-process:turn-active",
      queuedUser.key,
    ],
  );
});

test("Conversation preserves interrupted process status in the rendered feed", () => {
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

  const [entry] = conversationTurnsToFeed([projectedTurn]);
  assert.equal(entry?.kind, "observation");
  if (entry?.kind === "observation") {
    assert.equal(entry.status, "interrupted");
    assert.equal(entry.observation.status, "canceled");
  }
});

test("Conversation renders interrupted lifecycle when process entries are hidden", () => {
  const projectedTurn: ConversationTurnProjection = {
    ...turn("turn-interrupted", [
      timelineItem("user-interrupted", "turn-interrupted", "user", "question"),
      {
        ...observationItem("observation-interrupted", "turn-interrupted", false),
        status: "completed",
      },
    ]),
    status: "interrupted",
    completedAt: "2026-07-10T00:00:05.000Z",
  };
  const visibleFeed = conversationTurnsToFeed([projectedTurn]).filter(
    (entry) => entry.kind !== "observation",
  );
  const rows = conversationDisplayRows([projectedTurn], visibleFeed);

  assert.deepEqual(rows.map((row) => row.kind), [
    "feed_entry",
    "assistant_process_group",
  ]);
  const process = rows[1];
  assert.equal(process?.kind, "assistant_process_group");
  if (process?.kind === "assistant_process_group") {
    assert.equal(process.entries.length, 0);
    assert.equal(process.turnStatus, "interrupted");
    assert.equal(process.completed, true);
  }
});

test("Conversation display uses canonical turn lifecycle instead of feed inference", () => {
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
    activities: [
      {
        kind: "command",
        totalCount: 1,
        runningCount: 0,
        interruptedCount: 0,
        failureCount: 0,
        issueCount: 1,
      },
    ],
  };
  const feed = conversationTurnsToFeed([projectedTurn]);
  const rows = conversationDisplayRows([projectedTurn], feed);

  assert.deepEqual(rows.map((row) => row.kind), [
    "feed_entry",
    "assistant_process_group",
    "feed_entry",
  ]);
  const process = rows[1];
  assert.equal(process?.kind, "assistant_process_group");
  if (process?.kind === "assistant_process_group") {
    assert.deepEqual(process.entries.map((entry) => entry.key), [
      "conversation:process",
      "conversation:observation",
    ]);
    assert.equal(process.turnStatus, "completed");
    assert.equal(process.completed, true);
    assert.equal(process.active, false);
    assert.equal(process.durationMs, 12_345);
    assert.equal(process.activities[0]?.issueCount, 1);
  }
  assert.deepEqual([...conversationFinalAssistantKeys([projectedTurn])], [
    "conversation:final",
  ]);
});

test("Conversation places canonical outputs directly after the final answer", () => {
  const projectedTurn: ConversationTurnProjection = {
    ...turn("turn-output", [
      timelineItem("user-output", "turn-output", "user", "question"),
      timelineItem("final-output", "turn-output", "final", "done"),
    ]),
    finalAnswerItemId: "final-output",
    outputs: [
      {
        id: "output-report",
        kind: "file",
        label: "report.md",
        path: "/workspace/report.md",
        activity: "written",
        confidence: "authoritative",
        sourceItemIds: ["tool-output"],
      },
    ],
  };
  const rows = conversationDisplayRows(
    [projectedTurn],
    conversationTurnsToFeed([projectedTurn]),
  );

  assert.deepEqual(rows.map((row) => row.kind), [
    "feed_entry",
    "feed_entry",
    "turn_outputs",
  ]);
  assert.equal(rows[2]?.kind, "turn_outputs");
  if (rows[2]?.kind === "turn_outputs") {
    assert.equal(rows[2].outputs[0]?.path, "/workspace/report.md");
  }
});

test("Conversation places authoritative file changes after the owning final answer", () => {
  const projectedTurn: ConversationTurnProjection = {
    ...turn("turn-changes", [
      timelineItem("user-changes", "turn-changes", "user", "question"),
      timelineItem("final-changes", "turn-changes", "final", "done"),
    ]),
    finalAnswerItemId: "final-changes",
    outputs: [
      {
        id: "output-report",
        kind: "file",
        label: "report.md",
        path: "/workspace/report.md",
        activity: "written",
        confidence: "authoritative",
        sourceItemIds: ["tool-output"],
      },
    ],
    fileChanges: {
      files: [
        { path: "src/main.ts", additions: 12, deletions: 3 },
        { path: "src/main.test.ts", additions: 8, deletions: 0 },
      ],
      totalAdditions: 20,
      totalDeletions: 3,
    },
  };
  const rows = conversationDisplayRows(
    [projectedTurn],
    conversationTurnsToFeed([projectedTurn]),
  );

  assert.deepEqual(rows.map((row) => row.kind), [
    "feed_entry",
    "feed_entry",
    "turn_outputs",
    "turn_file_changes",
  ]);
  const fileChanges = rows[3];
  assert.equal(fileChanges?.kind, "turn_file_changes");
  if (fileChanges?.kind === "turn_file_changes") {
    assert.equal(fileChanges.turnId, "turn-changes");
    assert.equal(fileChanges.fileChanges.files.length, 2);
    assert.equal(fileChanges.fileChanges.totalAdditions, 20);
  }
});

test("Conversation does not expose an in-progress turn diff as a completed file card", () => {
  const projectedTurn: ConversationTurnProjection = {
    ...turn("turn-live-changes", [
      timelineItem("user-live-changes", "turn-live-changes", "user", "question"),
      timelineItem("process-live-changes", "turn-live-changes", "process", "editing"),
    ]),
    status: "in_progress",
    fileChanges: {
      files: [{ path: "src/main.ts", additions: 4, deletions: 1 }],
      totalAdditions: 4,
      totalDeletions: 1,
    },
  };
  const rows = conversationDisplayRows(
    [projectedTurn],
    conversationTurnsToFeed([projectedTurn]),
  );

  assert.equal(rows.some((row) => row.kind === "turn_file_changes"), false);
});

test("Conversation exposes final outputs without prematurely exposing an in-progress turn diff", () => {
  const projectedTurn: ConversationTurnProjection = {
    ...turn("turn-live-final", [
      timelineItem("user-live-final", "turn-live-final", "user", "question"),
      timelineItem("final-live-final", "turn-live-final", "final", "done"),
    ]),
    status: "in_progress",
    finalAnswerItemId: "final-live-final",
    outputs: [
      {
        id: "output-live-report",
        kind: "file",
        label: "report.md",
        path: "/workspace/report.md",
        activity: "written",
        confidence: "authoritative",
        sourceItemIds: ["final-live-final"],
      },
    ],
    fileChanges: {
      files: [{ path: "src/main.ts", additions: 4, deletions: 1 }],
      totalAdditions: 4,
      totalDeletions: 1,
    },
  };
  const rows = conversationDisplayRows(
    [projectedTurn],
    conversationTurnsToFeed([projectedTurn]),
  );

  assert.deepEqual(rows.map((row) => row.kind), [
    "feed_entry",
    "feed_entry",
    "turn_outputs",
  ]);
});

test("Conversation settles work as soon as the native final answer arrives", () => {
  const projectedTurn: ConversationTurnProjection = {
    ...turn("turn-live", [
      timelineItem("process-live", "turn-live", "process", "working"),
      timelineItem("final-live", "turn-live", "final", "not settled"),
    ]),
    status: "in_progress",
    finalAnswerItemId: "final-live",
  };
  const feed = conversationTurnsToFeed([projectedTurn]);
  const rows = conversationDisplayRows([projectedTurn], feed);
  const process = rows[0];

  assert.equal(process?.kind, "assistant_process_group");
  if (process?.kind === "assistant_process_group") {
    assert.equal(process.turnStatus, "in_progress");
    assert.equal(process.completed, true);
    assert.equal(process.active, false);
  }
  assert.deepEqual([...conversationFinalAssistantKeys([projectedTurn])], [
    "conversation:final-live",
  ]);
});

test("Conversation keeps active work visible even when completed tools are hidden", () => {
  const projectedTurn: ConversationTurnProjection = {
    ...turn("turn-live", [
      timelineItem("user-live", "turn-live", "user", "question"),
      observationItem("search-live", "turn-live", false),
    ]),
    status: "in_progress",
  };
  const allEntries = conversationTurnsToFeed([projectedTurn]);
  const filteredEntries = allEntries.filter((entry) => entry.kind !== "observation");
  const rows = conversationDisplayRows([projectedTurn], filteredEntries, allEntries);
  const process = rows[1];

  assert.equal(process?.kind, "assistant_process_group");
  if (process?.kind === "assistant_process_group") {
    assert.equal(process.active, true);
    assert.deepEqual(process.entries.map((entry) => entry.key), [
      "conversation:search-live",
    ]);
  }
});

test("Conversation keeps settled Worked details available when completed tools are hidden", () => {
  const projectedTurn: ConversationTurnProjection = {
    ...turn("turn-settled", [
      timelineItem("user-settled", "turn-settled", "user", "question"),
      observationItem("search-settled", "turn-settled", false),
      timelineItem("final-settled", "turn-settled", "final", "answer"),
    ]),
    status: "completed",
    finalAnswerItemId: "final-settled",
  };
  const allEntries = conversationTurnsToFeed([projectedTurn]);
  const filteredEntries = allEntries.filter((entry) => entry.kind !== "observation");
  const rows = conversationDisplayRows([projectedTurn], filteredEntries, allEntries);
  const process = rows[1];

  assert.equal(process?.kind, "assistant_process_group");
  if (process?.kind === "assistant_process_group") {
    assert.equal(process.completed, true);
    assert.equal(process.active, false);
    assert.deepEqual(process.entries.map((entry) => entry.key), [
      "conversation:search-settled",
    ]);
  }
});

test("Conversation restores a lazy Worked row from native summary lifecycle timing", () => {
  const projectedTurn: ConversationTurnProjection = {
    ...turn("turn-summary", [
      timelineItem("user-summary", "turn-summary", "user", "question"),
      timelineItem("final-summary", "turn-summary", "final", "answer"),
    ]),
    itemsView: "summary",
    finalAnswerItemId: "final-summary",
    durationMs: 60_000,
  };
  const rows = conversationDisplayRows(
    [projectedTurn],
    conversationTurnsToFeed([projectedTurn]),
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
    assert.equal(process.completed, true);
    assert.equal(process.active, false);
    assert.deepEqual(process.entries, []);
    assert.equal(process.durationMs, 60_000);
  }
});

test("Conversation store pages older turns, refreshes newer turns, and preserves cursor", async () => {
  const latest = turn("turn-2", [timelineItem("final-2", "turn-2", "final", "two")]);
  const older = turn("turn-1", [timelineItem("final-1", "turn-1", "final", "one")]);
  const newest = turn("turn-3", [timelineItem("final-3", "turn-3", "final", "three")]);
  const testHarness = harness([
    page([latest], "older-cursor"),
    page([older]),
    page([latest, newest], "must-not-reopen-pagination"),
  ]);

  assert.equal(await ensureConversationLoadedCommand(testHarness.deps, "session-1"), true);
  assert.equal(await loadOlderConversationCommand(testHarness.deps, "session-1"), true);
  assert.equal(await refreshConversationCommand(testHarness.deps, "session-1"), true);

  const conversation = testHarness.state().projections.get("session-1")?.conversation;
  assert.deepEqual(conversation?.turns.map((candidate) => candidate.id), [
    "turn-1",
    "turn-2",
    "turn-3",
  ]);
  assert.equal(conversation?.nextCursor, null);
  assert.deepEqual(testHarness.requests, [{}, { cursor: "older-cursor" }, {}]);
});

test("Conversation foreground refresh promotes a stale working reply to the server final state", async () => {
  const staleReply = timelineItem("assistant-reply", "turn-reconnect", "process", "answer");
  staleReply.status = "running";
  const staleTurn: ConversationTurnProjection = {
    ...turn("turn-reconnect", [
      timelineItem("user-reconnect", "turn-reconnect", "user", "question"),
      staleReply,
    ]),
    status: "in_progress",
    finalAnswerItemId: undefined,
  };
  const finalReply: ConversationItemProjection = {
    ...staleReply,
    role: "final",
    status: "completed",
    revision: 2,
  };
  const completedTurn: ConversationTurnProjection = {
    ...turn("turn-reconnect", [
      timelineItem("user-reconnect", "turn-reconnect", "user", "question"),
      finalReply,
    ]),
    finalAnswerItemId: finalReply.id,
    revision: 2,
  };
  const testHarness = harness([
    page([staleTurn], undefined, 1),
    page([completedTurn], undefined, 2),
  ]);

  assert.equal(await ensureConversationLoadedCommand(testHarness.deps, "session-1"), true);
  assert.equal(await ensureConversationLoadedCommand(testHarness.deps, "session-1"), true);
  assert.deepEqual(testHarness.requests, [{}]);

  assert.equal(await refreshConversationCommand(testHarness.deps, "session-1"), true);
  const recovered = testHarness.state().projections.get("session-1")?.conversation?.turns[0];
  assert.equal(recovered?.status, "completed");
  assert.equal(recovered?.finalAnswerItemId, "assistant-reply");
  assert.deepEqual(
    recovered?.items.map((item) => [item.id, item.role, item.status]),
    [
      ["user-reconnect", "user", "completed"],
      ["assistant-reply", "final", "completed"],
    ],
  );
  assert.deepEqual(testHarness.requests, [{}, {}]);
});

test("Conversation replacement refresh owns loading state and ignores the aborted late response", async () => {
  const staleResponse = deferred<ConversationTurnsPageResponse>();
  const finalResponse = deferred<ConversationTurnsPageResponse>();
  const staleTurn = turn("turn-stale", [
    timelineItem("final-stale", "turn-stale", "final", "stale"),
  ]);
  const finalTurn = turn("turn-final", [
    timelineItem("final-current", "turn-final", "final", "current"),
  ]);
  const testHarness = harness([staleResponse.promise, finalResponse.promise]);

  const staleRefresh = refreshConversationCommand(testHarness.deps, "session-1");
  const replacementRefresh = refreshConversationCommand(testHarness.deps, "session-1", {
    replaceActive: true,
  });

  staleResponse.resolve(page([staleTurn], undefined, 1));
  assert.equal(await staleRefresh, false);
  assert.equal(
    testHarness.state().projections.get("session-1")?.conversation?.phase,
    "loading",
  );

  finalResponse.resolve(page([finalTurn], undefined, 2));
  assert.equal(await replacementRefresh, true);
  assert.deepEqual(
    testHarness.state().projections.get("session-1")?.conversation?.turns.map((value) => value.id),
    ["turn-final"],
  );
  assert.equal(
    testHarness.state().projections.get("session-1")?.conversation?.phase,
    "ready",
  );
});

test("suppressed foreground refresh failures preserve the readable conversation", async () => {
  const failedResponse = deferred<ConversationTurnsPageResponse>();
  const existingTurn = turn("turn-existing", [
    timelineItem("final-existing", "turn-existing", "final", "existing"),
  ]);
  const testHarness = harness([
    page([existingTurn], undefined, 1),
    failedResponse.promise,
  ]);

  assert.equal(await ensureConversationLoadedCommand(testHarness.deps, "session-1"), true);
  const refresh = refreshConversationCommand(testHarness.deps, "session-1", {
    suppressError: true,
  });
  failedResponse.reject(new Error("network route unavailable"));

  assert.equal(await refresh, false);
  const conversation = testHarness.state().projections.get("session-1")?.conversation;
  assert.equal(conversation?.phase, "ready");
  assert.equal(conversation?.lastError, null);
  assert.deepEqual(conversation?.turns.map((value) => value.id), ["turn-existing"]);
});

test("unchanged foreground refresh keeps the ready conversation structurally stable", async () => {
  const pendingRefresh = deferred<ConversationTurnsPageResponse>();
  const existingTurn = turn("turn-existing", [
    timelineItem("final-existing", "turn-existing", "final", "existing"),
  ]);
  const testHarness = harness([
    page([existingTurn], undefined, 7),
    pendingRefresh.promise,
  ]);

  assert.equal(await ensureConversationLoadedCommand(testHarness.deps, "session-1"), true);
  const before = testHarness.state().projections.get("session-1")?.conversation;
  const refresh = refreshConversationCommand(testHarness.deps, "session-1", {
    suppressError: true,
  });

  assert.equal(
    testHarness.state().projections.get("session-1")?.conversation?.phase,
    "ready",
  );
  pendingRefresh.resolve(page([existingTurn], undefined, 7));
  assert.equal(await refresh, true);
  assert.equal(
    testHarness.state().projections.get("session-1")?.conversation,
    before,
  );
});

test("new live sessions initialize from the resident projection without history paging", async () => {
  const testHarness = harness([page([], undefined, 0)]);

  assert.equal(await initializeLiveConversationCommand(testHarness.deps, "session-1"), true);
  assert.deepEqual(testHarness.requests, [{ liveOnly: true }]);
  assert.equal(
    testHarness.state().projections.get("session-1")?.conversation?.phase,
    "ready",
  );
});

test("Conversation serializes resident initialization and a concurrent history load", async () => {
  const resident = deferred<ConversationTurnsPageResponse>();
  const historicalTurn = turn("turn-history", [
    timelineItem("final-history", "turn-history", "final", "history"),
  ]);
  const testHarness = harness([resident.promise, page([historicalTurn])]);

  const initialize = initializeLiveConversationCommand(testHarness.deps, "session-1");
  const loadHistory = ensureConversationLoadedCommand(testHarness.deps, "session-1");
  assert.deepEqual(testHarness.requests, [{ liveOnly: true }]);

  resident.resolve(page([], undefined, 0));
  assert.equal(await initialize, true);
  assert.equal(await loadHistory, true);
  assert.deepEqual(testHarness.requests, [{ liveOnly: true }, {}]);
  const conversation = testHarness.state().projections.get("session-1")?.conversation;
  assert.equal(conversation?.loadedScope, "history");
  assert.equal(conversation?.turns[0]?.id, "turn-history");
});

test("Conversation applies deltas that arrive while the HTTP baseline is loading", async () => {
  const response = deferred<ConversationTurnsPageResponse>();
  const testHarness = harness([response.promise]);
  const load = ensureConversationLoadedCommand(testHarness.deps, "session-1");
  const liveTurn = turn(
    "turn-live",
    [timelineItem("process-live", "turn-live", "process", "working")],
  );
  testHarness.deps.set((state) => ({
    projections: applyConversationDeltasToProjectionMap(
      state.projections,
      [delta(1, 0, liveTurn)],
    ),
  }));
  response.resolve(page([], undefined, 0));

  assert.equal(await load, true);
  const conversation = testHarness.state().projections.get("session-1")?.conversation;
  assert.equal(conversation?.daemonRevision, 1);
  assert.equal(conversation?.needsRefresh, false);
  assert.equal(conversation?.turns[0]?.items[0]?.id, "process-live");
});

test("Conversation holds revision gaps and applies the complete chain when it arrives", async () => {
  const initial = turn("turn-live", []);
  const testHarness = harness([page([initial], undefined, 1)]);
  await ensureConversationLoadedCommand(testHarness.deps, "session-1");
  const second = turn(
    "turn-live",
    [timelineItem("second", "turn-live", "process", "second")],
  );
  const third = turn(
    "turn-live",
    [timelineItem("third", "turn-live", "final", "third")],
  );

  testHarness.deps.set((state) => ({
    projections: applyConversationDeltasToProjectionMap(
      state.projections,
      [delta(3, 2, third)],
    ),
  }));
  let conversation = testHarness.state().projections.get("session-1")?.conversation;
  assert.equal(conversation?.daemonRevision, 1);
  assert.equal(conversation?.needsRefresh, true);
  assert.deepEqual(conversation?.turns[0]?.items, []);

  testHarness.deps.set((state) => ({
    projections: applyConversationDeltasToProjectionMap(
      state.projections,
      [delta(2, 1, second)],
    ),
  }));
  conversation = testHarness.state().projections.get("session-1")?.conversation;
  assert.equal(conversation?.daemonRevision, 3);
  assert.equal(conversation?.needsRefresh, false);
  assert.deepEqual(
    conversation?.turns[0]?.items.map((item) => item.id),
    ["second", "third"],
  );
});

test("Conversation clears an unresolved delta gap from a fresh HTTP baseline", async () => {
  const initial = turn("turn-live", []);
  const recovered = turn(
    "turn-live",
    [timelineItem("recovered", "turn-live", "final", "recovered")],
  );
  const testHarness = harness([
    page([initial], undefined, 1),
    page([recovered], undefined, 3),
  ]);
  await ensureConversationLoadedCommand(testHarness.deps, "session-1");
  testHarness.deps.set((state) => ({
    projections: applyConversationDeltasToProjectionMap(
      state.projections,
      [delta(3, 2, recovered)],
    ),
  }));

  assert.equal(await refreshConversationCommand(testHarness.deps, "session-1"), true);
  const conversation = testHarness.state().projections.get("session-1")?.conversation;
  assert.equal(conversation?.daemonRevision, 3);
  assert.equal(conversation?.needsRefresh, false);
  assert.deepEqual(conversation?.pendingDeltas, []);
  assert.equal(conversation?.turns[0]?.items[0]?.id, "recovered");
});

test("Conversation detail request uses opaque native ids and replaces only the canonical item", async () => {
  const summary = observationItem("observation", "turn-1", true);
  const testHarness = harness([page([turn("turn-1", [summary])])]);
  await ensureConversationLoadedCommand(testHarness.deps, "session-1");
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
  const loaded = await loadConversationItemDetailCommand(
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
      turnId: "turn-1",
      providerTurnId: "provider-turn-1",
      providerItemId: "provider-observation",
    },
  ]);
  const item = testHarness.state().projections.get("session-1")?.conversation?.turns[0]?.items[0];
  assert.equal(item?.revision, 2);

  const updatedSummary: ConversationItemProjection = {
    ...summary,
    status: "failed",
    revision: 3,
  };
  testHarness.deps.set((state) => ({
    projections: applyConversationDeltasToProjectionMap(
      state.projections,
      [delta(1, 0, { ...turn("turn-1", [updatedSummary]), revision: 3 })],
    ),
  }));
  const updated = testHarness.state().projections.get("session-1")?.conversation?.turns[0]?.items[0];
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

test("Conversation turn detail hydrates process items without replacing the visible exchange", async () => {
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
  await ensureConversationLoadedCommand(testHarness.deps, "session-1");
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

  const loaded = await loadConversationTurnDetailCommand(
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
  const hydrated = testHarness.state().projections.get("session-1")?.conversation?.turns[0];
  assert.equal(hydrated?.itemsView, "full");
  assert.deepEqual(hydrated?.items.map((item) => item.id), ["user", "process", "final"]);
  assert.equal(hydrated?.items[0], user);
  assert.equal(hydrated?.items[2], final);

  assert.equal(await refreshConversationCommand(testHarness.deps, "session-1"), true);
  const refreshed = testHarness.state().projections.get("session-1")?.conversation?.turns[0];
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

test("Conversation turn detail replaces stale summary resources authoritatively", async () => {
  const user = timelineItem("user", "turn-1", "user", "question");
  const final = timelineItem("final", "turn-1", "final", "answer");
  const summaryTurn: ConversationTurnProjection = {
    ...turn("turn-1", [user, final]),
    itemsView: "summary",
    finalAnswerItemId: "final",
    outputs: [
      {
        id: "stale-output",
        kind: "file",
        label: "main.rs",
        path: "/workspace/src/main.rs",
        confidence: "authoritative",
        sourceItemIds: ["edit-main"],
        activity: "updated",
      },
    ],
    sources: [
      {
        id: "stale-source",
        kind: "file",
        label: "SELECT",
        path: "SELECT",
        confidence: "authoritative",
        sourceItemIds: ["read-query"],
        activities: ["read"],
      },
    ],
    fileChanges: {
      files: [{ path: "src/main.rs", additions: 1, deletions: 0 }],
      totalAdditions: 1,
      totalDeletions: 0,
    },
  };
  const testHarness = harness([page([summaryTurn])]);
  await ensureConversationLoadedCommand(testHarness.deps, "session-1");

  const loaded = await loadConversationTurnDetailCommand(
    {
      ...testHarness.deps,
      readTurnDetail: async () => ({
        sessionId: "session-1",
        turnId: "turn-1",
        turn: {
          ...summaryTurn,
          itemsView: "full",
          outputs: [],
          sources: [],
          revision: 2,
        },
      }),
    },
    "session-1",
    "turn-1",
  );

  assert.equal(loaded, true);
  const hydrated = testHarness.state().projections.get("session-1")?.conversation?.turns[0];
  assert.equal(hydrated?.outputs, undefined);
  assert.equal(hydrated?.sources, undefined);
  assert.deepEqual(hydrated?.fileChanges, summaryTurn.fileChanges);
});

test("Conversation loads an unloaded directory turn directly into the canonical projection", async () => {
  const latest: ConversationTurnProjection = {
    ...turn("turn-latest", [
      timelineItem("user-latest", "turn-latest", "user", "latest question"),
      timelineItem("final-latest", "turn-latest", "final", "latest answer"),
    ]),
    startedAt: "2026-07-10T00:10:00.000Z",
  };
  const testHarness = harness([page([latest])]);
  await ensureConversationLoadedCommand(testHarness.deps, "session-1");
  const older: ConversationTurnProjection = {
    ...turn(
      "provider-turn-old",
      [
        timelineItem("user-old", "provider-turn-old", "user", "old question"),
        timelineItem("final-old", "provider-turn-old", "final", "old answer"),
      ],
      "provider-turn-old",
    ),
    itemsView: "full",
    startedAt: "2026-07-10T00:00:00.000Z",
  };
  const requests: unknown[] = [];

  const loaded = await hydrateConversationTurnByProviderIdCommand(
    {
      ...testHarness.deps,
      readTurnDetail: async (sessionId, options) => {
        requests.push({ sessionId, ...options });
        return {
          sessionId,
          turnId: options.turnId,
          turn: older,
          approximateBytes: 80,
        };
      },
    },
    "session-1",
    "provider-turn-old",
  );

  assert.equal(loaded, true);
  assert.deepEqual(requests, [
    {
      sessionId: "session-1",
      turnId: "provider-turn-old",
      providerTurnId: "provider-turn-old",
    },
  ]);
  assert.deepEqual(
    testHarness.state().projections.get("session-1")?.conversation?.turns.map((item) => item.id),
    ["provider-turn-old", "turn-latest"],
  );
});

test("Conversation replaces colliding summary placeholders with canonical turn detail", async () => {
  const summaryUser = {
    ...timelineItem("summary-user", "turn-1", "user", "question"),
    providerItemId: "item:0",
  };
  const summaryFinal = {
    ...timelineItem("summary-item-1", "turn-1", "final", "answer"),
    providerItemId: "item:1",
  };
  const summaryTurn: ConversationTurnProjection = {
    ...turn("turn-1", [summaryUser, summaryFinal]),
    itemsView: "summary",
    finalAnswerItemId: summaryFinal.id,
  };
  const refreshedSummaryTurn: ConversationTurnProjection = {
    ...summaryTurn,
    items: [summaryUser, { ...summaryFinal, revision: 3 }],
    revision: 3,
  };
  const testHarness = harness([page([summaryTurn]), page([refreshedSummaryTurn])]);
  await ensureConversationLoadedCommand(testHarness.deps, "session-1");

  const detailedUser = {
    ...timelineItem("detail-user", "turn-1", "user", "question"),
    providerItemId: "item:0",
  };
  const detailedProcess = {
    ...timelineItem("summary-item-1", "turn-1", "process", "working"),
    providerItemId: "item:1",
  };
  const detailedFinal = {
    ...timelineItem("detail-final", "turn-1", "final", "answer"),
    providerItemId: "item:144",
  };
  const loaded = await loadConversationTurnDetailCommand(
    {
      ...testHarness.deps,
      readTurnDetail: async () => ({
        sessionId: "session-1",
        turnId: "turn-1",
        turn: {
          ...summaryTurn,
          items: [detailedUser, detailedProcess, detailedFinal],
          itemsView: "full",
          finalAnswerItemId: detailedFinal.id,
          revision: 2,
        },
      }),
    },
    "session-1",
    "turn-1",
  );

  assert.equal(loaded, true);
  const hydrated = testHarness.state().projections.get("session-1")?.conversation?.turns[0];
  assert.deepEqual(hydrated?.items.map((item) => [item.id, item.role]), [
    ["detail-user", "user"],
    ["summary-item-1", "process"],
    ["detail-final", "final"],
  ]);
  assert.equal(hydrated?.finalAnswerItemId, "detail-final");

  assert.equal(await refreshConversationCommand(testHarness.deps, "session-1"), true);
  const refreshed = testHarness.state().projections.get("session-1")?.conversation?.turns[0];
  assert.deepEqual(refreshed?.items.map((item) => [item.id, item.role]), [
    ["detail-user", "user"],
    ["summary-item-1", "process"],
    ["detail-final", "final"],
  ]);
  assert.equal(refreshed?.items.filter((item) => item.role === "final").length, 1);
  assert.equal(refreshed?.finalAnswerItemId, "detail-final");
});

test("Conversation keeps hydrated process detail across a live summary delta", async () => {
  const user = timelineItem("user", "turn-1", "user", "question");
  const final = timelineItem("final", "turn-1", "final", "answer");
  const summaryObservation = observationItem("observation", "turn-1", true);
  const summaryTurn: ConversationTurnProjection = {
    ...turn("turn-1", [user, summaryObservation, final]),
    itemsView: "summary",
    finalAnswerItemId: "final",
  };
  const testHarness = harness([page([summaryTurn], undefined, 0)]);
  await ensureConversationLoadedCommand(testHarness.deps, "session-1");
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
  await loadConversationTurnDetailCommand(
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
    projections: applyConversationDeltasToProjectionMap(
      state.projections,
      [delta(1, 0, deltaTurn)],
    ),
  }));

  const hydrated = testHarness.state().projections.get("session-1")?.conversation?.turns[0];
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

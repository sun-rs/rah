import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type {
  ConversationProjectionDelta,
  ListSessionsResponse,
  RahEvent,
  SessionSummary,
} from "@rah/runtime-protocol";
import {
  BACKGROUND_SYNC_FLUSH_INTERVAL_MS,
  FOREGROUND_SYNC_FLUSH_INTERVAL_MS,
  applyProjectionEventsToSyncState,
  coalesceConversationProjectionDeltas,
  coalesceProjectionEvents,
  recoverFromReplayGapCommand,
  recoverTransportCommand,
  resolveSyncFlushPlan,
  shouldCollectUnreadEventsFromBatch,
  splitProjectionTransportEvents,
  takeSyncEventPrefix,
} from "./session-store-sync";
import { applyEventsToProjectionMap } from "./session-store-projections";
import { createEmptySessionProjection } from "./session-store-session-lifecycle";
import type { SessionProjection } from "./types";

type RecoverArgs = Parameters<typeof recoverTransportCommand>[0];
type RecoverState = ReturnType<RecoverArgs["get"]>;

describe("session sync flush scheduling", () => {
  test("uses the next frame for a foreground batch after an idle period", () => {
    assert.deepEqual(
      resolveSyncFlushPlan({
        hidden: false,
        elapsedSinceLastFlushMs: FOREGROUND_SYNC_FLUSH_INTERVAL_MS,
      }),
      { kind: "frame" },
    );
  });

  test("bounds foreground rendering frequency while preserving the pending batch", () => {
    assert.deepEqual(
      resolveSyncFlushPlan({
        hidden: false,
        elapsedSinceLastFlushMs: 12,
      }),
      {
        kind: "timer",
        delayMs: FOREGROUND_SYNC_FLUSH_INTERVAL_MS - 12,
      },
    );
  });

  test("coalesces background work instead of spinning a zero-delay timer", () => {
    assert.deepEqual(
      resolveSyncFlushPlan({
        hidden: true,
        elapsedSinceLastFlushMs: Number.POSITIVE_INFINITY,
      }),
      {
        kind: "timer",
        delayMs: BACKGROUND_SYNC_FLUSH_INTERVAL_MS,
      },
    );
    assert.ok(BACKGROUND_SYNC_FLUSH_INTERVAL_MS > 0);
  });
});

describe("session sync unread replay ownership", () => {
  test("counts a cursor-based reconnect replay as missed foreground activity", () => {
    assert.equal(
      shouldCollectUnreadEventsFromBatch({
        initial: true,
        replay: true,
        hasReplayCursor: true,
      }),
      true,
    );
  });

  test("keeps a cursorless first-load replay as historical read baseline", () => {
    assert.equal(
      shouldCollectUnreadEventsFromBatch({
        initial: true,
        replay: true,
        hasReplayCursor: false,
      }),
      false,
    );
  });
});

function emptySessionsResponse(): ListSessionsResponse {
  return {
    sessions: [],
    storedSessions: [],
    recentSessions: [],
    workspaceDirs: [],
  };
}

function event(
  seq: number,
  value: Omit<RahEvent, "id" | "seq" | "ts" | "sessionId" | "source">,
  sessionId = "session-1",
): RahEvent {
  return {
    id: `event-${seq}`,
    seq,
    ts: `2026-05-10T00:00:${String(seq).padStart(2, "0")}.000Z`,
    sessionId,
    source: { provider: "codex", channel: "structured_live", authority: "derived" },
    ...value,
  } as RahEvent;
}

function summary(args: {
  id: string;
  providerSessionId?: string;
  readOnlyReplay?: boolean;
}): SessionSummary {
  const readOnlyReplay = args.readOnlyReplay === true;
  return {
    session: {
      id: args.id,
      provider: "codex",
      ...(args.providerSessionId ? { providerSessionId: args.providerSessionId } : {}),
      launchSource: "web",
      status: readOnlyReplay ? "stopped" : "running",
      phase: readOnlyReplay ? "ended" : "ready",
      cwd: "/tmp/rah",
      rootDir: "/tmp/rah",
      runtimeState: "idle",
      ptyId: `pty-${args.id}`,
      capabilities: {
        liveAttach: true,
        structuredTimeline: true,
        nativeTui: false,
        rawPtyInput: false,
        chatMirror: false,
        structuredControl: true,
        livePermissions: !readOnlyReplay,
        contextUsage: false,
        resumeByProvider: true,
        listProviderSessions: true,
        actions: { info: true, stop: true, delete: true, rename: "native" },
        steerInput: !readOnlyReplay,
        queuedInput: false,
        modelSwitch: true,
        planMode: true,
        subagents: false,
      },
      createdAt: "2026-05-10T00:00:00.000Z",
      updatedAt: "2026-05-10T00:00:00.000Z",
    },
    attachedClients: [],
    controlLease: { sessionId: args.id },
  };
}

function applyEventsToMap(
  current: Map<string, SessionProjection>,
  events: RahEvent[],
): Map<string, SessionProjection> {
  return applyEventsToProjectionMap(current, events, {
    updateLastSeq: () => undefined,
    clearPendingSession: () => undefined,
    queuePendingEvent: () => undefined,
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createRecoverHarness(
  listSessions: NonNullable<RecoverArgs["listSessions"]>,
  restartTransport: NonNullable<RecoverArgs["restartTransport"]> = () => undefined,
) {
  let state: RecoverState = {
    projections: new Map<string, SessionProjection>(),
    unreadSessionIds: new Set<string>(),
    selectedSessionId: null,
    workspaceVisibilityVersion: 0,
    sessionTopologyVersion: 0,
    eventStreamOpenRevision: 0,
    pendingSessionAction: null,
    pendingSessionTransition: null,
    error: null,
    workspaceDir: "",
    hiddenWorkspaceDirs: new Set<string>(),
  };
  let applyCalls = 0;
  let restartCalls = 0;
  let restoreCalls = 0;
  let lastApplyOptions: Parameters<RecoverArgs["applySessionsResponse"]>[2];

  const args: RecoverArgs = {
    get: () => state,
    set: (partial) => {
      const patch = typeof partial === "function" ? partial(state) : partial;
      state = { ...state, ...patch };
    },
    applySessionsResponse: (currentState, sessionsResponse, options) => {
      applyCalls += 1;
      lastApplyOptions = options;
      return {
        projections: currentState.projections,
        selectedSessionId: currentState.selectedSessionId,
        workspaceDir: currentState.workspaceDir,
        hiddenWorkspaceDirs: currentState.hiddenWorkspaceDirs,
        workspaceVisibilityVersion: currentState.workspaceVisibilityVersion,
        storedSessions: sessionsResponse.storedSessions,
        recentSessions: sessionsResponse.recentSessions,
        workspaceDirs: sessionsResponse.workspaceDirs,
      };
    },
    restartTransport: (options) => {
      restartCalls += 1;
      return restartTransport(options);
    },
    maybeRestoreLastHistorySelection: async () => {
      restoreCalls += 1;
    },
    listSessions,
  };

  return {
    args,
    getApplyCalls: () => applyCalls,
    getRestartCalls: () => restartCalls,
    getRestoreCalls: () => restoreCalls,
    getLastApplyOptions: () => lastApplyOptions,
  };
}

describe("session store recovery", () => {
  test("replay-gap recovery catches up only selected and visible conversations", async () => {
    const sessionA = createEmptySessionProjection(
      summary({ id: "session-a", providerSessionId: "thread-a" }),
    );
    const sessionB = createEmptySessionProjection(
      summary({ id: "session-b", providerSessionId: "thread-b" }),
    );
    const sessionC = createEmptySessionProjection(
      summary({ id: "session-c", providerSessionId: "thread-c" }),
    );
    let state = {
      projections: new Map([
        ["session-a", sessionA],
        ["session-b", sessionB],
        ["session-c", sessionC],
      ]),
      unreadSessionIds: new Set<string>(),
      visibleSessionIds: new Set(["session-b"]),
      selectedSessionId: "session-a",
      workspaceVisibilityVersion: 0,
      sessionTopologyVersion: 0,
      eventStreamOpenRevision: 0,
      storedSessions: [],
      recentSessions: [],
      pendingSessionTransition: null,
      pendingSessionAction: null,
      error: null,
      workspaceDir: "/tmp/rah",
      hiddenWorkspaceDirs: new Set<string>(),
    };
    const caughtUp: string[] = [];

    await recoverFromReplayGapCommand({
      batch: {
        events: [],
        replayGap: {
          requestedFromSeq: 1,
          oldestAvailableSeq: 10,
          newestAvailableSeq: 20,
        },
      },
      get: () => state,
      set: (partial) => {
        state = {
          ...state,
          ...(typeof partial === "function" ? partial(state) : partial),
        };
      },
      clearPendingEvents: () => undefined,
      updateLastSeq: () => undefined,
      replaceSessionsResponse: (current) => ({
        projections: current.projections,
        selectedSessionId: current.selectedSessionId,
        workspaceDir: current.workspaceDir,
        hiddenWorkspaceDirs: current.hiddenWorkspaceDirs,
        workspaceVisibilityVersion: current.workspaceVisibilityVersion,
        storedSessions: [],
        recentSessions: [],
        workspaceDirs: ["/tmp/rah"],
      }),
      applyEventsToMap: (current) => current,
      ensureConversationLoaded: async (sessionId) => {
        caughtUp.push(sessionId);
      },
      listSessions: async () => emptySessionsResponse(),
    });

    assert.deepEqual(caughtUp.sort(), ["session-a", "session-b"]);
  });

  test("orders, deduplicates, and composes contiguous conversation deltas", () => {
    const projectionDelta = (
      sessionId: string,
      revision: number,
      sourceSeq: number,
    ): ConversationProjectionDelta => ({
      sessionId,
      baseRevision: revision - 1,
      revision,
      sourceSeq,
      upsertTurns: [],
    });
    const deltas = coalesceConversationProjectionDeltas([
      projectionDelta("session-2", 2, 20),
      projectionDelta("session-1", 2, 10),
      projectionDelta("session-1", 1, 9),
      projectionDelta("session-1", 2, 11),
    ]);

    assert.deepEqual(
      deltas.map((delta) => [delta.sessionId, delta.revision, delta.sourceSeq]),
      [
        ["session-1", 2, 11],
        ["session-2", 2, 20],
      ],
    );
  });

  test("coalesces high-frequency timeline updates before projection apply", () => {
    const events = coalesceProjectionEvents([
      event(1, {
        type: "timeline.item.added",
        payload: {
          item: { kind: "assistant_message", text: "a" },
          identity: { canonicalItemId: "item-1" } as never,
        },
      }),
      event(2, {
        type: "timeline.item.updated",
        payload: {
          item: { kind: "assistant_message", text: "ab" },
          identity: { canonicalItemId: "item-1" } as never,
        },
      }),
      event(3, {
        type: "timeline.item.updated",
        payload: {
          item: { kind: "assistant_message", text: "abc" },
          identity: { canonicalItemId: "item-1" } as never,
        },
      }),
      event(4, {
        type: "timeline.item.added",
        payload: {
          item: { kind: "user_message", text: "next" },
          identity: { canonicalItemId: "item-2" } as never,
        },
      }),
    ]);

    assert.equal(events.length, 2);
    assert.equal(events[0]?.seq, 3);
    assert.equal(events[1]?.seq, 4);
  });

  test("coalesces a noisy process tail once and bounds work by bytes", () => {
    const chunks = Array.from({ length: 10_000 }, (_value, index) =>
      event(index + 1, {
        type: "process.output.appended",
        payload: {
          output: {
            itemId: "command-1",
            stream: "combined",
            sequence: index + 1,
            offsetBytes: index,
            data: "x",
            totalBytes: index + 1,
          },
        },
      }),
    );
    const coalesced = coalesceProjectionEvents(chunks);
    assert.equal(coalesced.length, 1);
    assert.equal(
      coalesced[0]?.type === "process.output.appended"
        ? coalesced[0].payload.output.data.length
        : 0,
      10_000,
    );

    const large = (itemId: string, seq: number) =>
      event(seq, {
        type: "process.output.appended",
        payload: {
          output: {
            itemId,
            stream: "combined",
            sequence: 1,
            offsetBytes: 0,
            data: "x".repeat(700 * 1024),
            totalBytes: 700 * 1024,
          },
        },
      });
    const batch = takeSyncEventPrefix(
      [large("command-a", 20_001), large("command-b", 20_002)],
      { maxEvents: 192, maxBytes: 1024 * 1024 },
    );
    assert.equal(batch.selected.length, 1);
    assert.equal(batch.remaining.length, 1);
  });

  test("keeps high-volume output off the global projection data path", () => {
    const output = event(2, {
      type: "process.output.appended",
      payload: {
        output: {
          itemId: "command-1",
          stream: "combined",
          sequence: 1,
          offsetBytes: 0,
          data: "x".repeat(128 * 1024),
          totalBytes: 128 * 1024,
        },
      },
    });
    const semantic = event(3, {
      type: "turn.completed",
      payload: {
        turn: {
          id: "turn-1",
          status: "completed",
        },
      } as never,
    });

    const split = splitProjectionTransportEvents([output, semantic]);

    assert.deepEqual(split.projectionEvents, [semantic]);
    assert.equal(split.dataPlaneSeq, 2);
  });

  test("drops message part events that are never rendered by the feed", () => {
    const events = coalesceProjectionEvents([
      event(1, {
        type: "message.part.delta",
        payload: { part: { messageId: "m1", partId: "p1", kind: "text", delta: "a" } },
      }),
      event(2, {
        type: "message.part.delta",
        payload: { part: { messageId: "m2", partId: "p2", kind: "reasoning", delta: "b" } },
      }),
      event(3, {
        type: "message.part.delta",
        payload: { part: { messageId: "m3", partId: "p3", kind: "unknown" } },
      }),
    ]);

    assert.equal(events.length, 1);
    assert.equal(events[0]?.seq, 3);
  });

  test("keeps the selected history projection while resume close waits for live creation", () => {
    const history = summary({
      id: "history",
      providerSessionId: "thread-1",
      readOnlyReplay: true,
    });
    const historyProjection = createEmptySessionProjection(history);
    historyProjection.summary.session.status = "running";
    historyProjection.summary.session.phase = "starting";
    historyProjection.summary.session.runtimeState = "starting";
    historyProjection.summary.session.capabilities.steerInput = true;
    historyProjection.summary.session.capabilities.livePermissions = true;
    historyProjection.feed = [
      {
        key: "assistant:history-answer",
        kind: "timeline",
        item: { kind: "assistant_message", text: "visible history answer" },
        ts: "2026-05-10T00:00:00.000Z",
      },
    ];

    const next = applyProjectionEventsToSyncState({
      state: {
        projections: new Map([["history", historyProjection]]),
        unreadSessionIds: new Set<string>(),
        selectedSessionId: "history",
        workspaceVisibilityVersion: 0,
        sessionTopologyVersion: 0,
        eventStreamOpenRevision: 0,
        pendingSessionAction: { kind: "resume_history", sessionId: "history" },
        pendingSessionTransition: {
          kind: "resume_history",
          provider: "codex",
          providerSessionId: "thread-1",
        },
        error: null,
      },
      events: [event(10, { type: "session.closed", payload: {} }, "history")],
      applyEventsToMap,
    });

    assert.equal(next.selectedSessionId, "history");
    assert.deepEqual(
      next.projections.get("history")?.feed.map((entry) => entry.key),
      ["assistant:history-answer"],
    );
  });

  test("turns a selected live session into a stopped replay when close arrives", () => {
    const live = summary({ id: "live-stop", providerSessionId: "thread-stop" });
    const projection = createEmptySessionProjection(live);
    projection.feed = [
      {
        key: "assistant:visible-before-stop",
        kind: "timeline",
        item: { kind: "assistant_message", text: "keep this transcript" },
        ts: "2026-05-10T00:00:00.000Z",
      },
    ];
    projection.currentRuntimeStatus = "thinking";

    const next = applyProjectionEventsToSyncState({
      state: {
        projections: new Map([["live-stop", projection]]),
        unreadSessionIds: new Set<string>(),
        selectedSessionId: "live-stop",
        workspaceVisibilityVersion: 0,
        sessionTopologyVersion: 0,
        eventStreamOpenRevision: 0,
        pendingSessionAction: null,
        pendingSessionTransition: null,
        error: null,
      },
      events: [event(10, { type: "session.closed", payload: {} }, "live-stop")],
      applyEventsToMap,
    });

    assert.equal(next.selectedSessionId, "live-stop");
    assert.equal(next.projections.get("live-stop")?.summary.session.status, "stopped");
    assert.equal(next.projections.get("live-stop")?.summary.session.capabilities.steerInput, false);
    assert.equal(next.projections.get("live-stop")?.currentRuntimeStatus, undefined);
    assert.deepEqual(
      next.projections.get("live-stop")?.feed.map((entry) => entry.key),
      ["assistant:visible-before-stop"],
    );
  });

  test("keeps the selected stopped replay across duplicate close delivery", () => {
    const live = summary({ id: "live-stop", providerSessionId: "thread-stop" });
    const projection = createEmptySessionProjection(live);
    projection.feed = [
      {
        key: "assistant:visible-before-stop",
        kind: "timeline",
        item: { kind: "assistant_message", text: "keep this transcript" },
        ts: "2026-05-10T00:00:00.000Z",
      },
    ];
    const baseState = {
      projections: new Map([["live-stop", projection]]),
      unreadSessionIds: new Set<string>(),
      selectedSessionId: "live-stop",
      workspaceVisibilityVersion: 0,
      sessionTopologyVersion: 0,
      eventStreamOpenRevision: 0,
      pendingSessionAction: null,
      pendingSessionTransition: null,
      error: null,
    };

    const first = applyProjectionEventsToSyncState({
      state: baseState,
      events: [event(10, { type: "session.closed", payload: {} }, "live-stop")],
      applyEventsToMap,
    });
    const duplicate = applyProjectionEventsToSyncState({
      state: {
        ...baseState,
        projections: first.projections,
        selectedSessionId: first.selectedSessionId,
        sessionTopologyVersion: first.sessionTopologyVersion,
      },
      events: [event(10, { type: "session.closed", payload: {} }, "live-stop")],
      applyEventsToMap,
    });

    assert.equal(duplicate.selectedSessionId, "live-stop");
    assert.equal(duplicate.projections.get("live-stop")?.summary.session.status, "stopped");
    assert.deepEqual(
      duplicate.projections.get("live-stop")?.feed.map((entry) => entry.key),
      ["assistant:visible-before-stop"],
    );
  });

  test("moves selected history projection to live session when resume live events arrive", () => {
    const history = summary({
      id: "history",
      providerSessionId: "thread-1",
      readOnlyReplay: true,
    });
    const live = summary({
      id: "live",
      providerSessionId: "thread-1",
    });
    const historyProjection = createEmptySessionProjection(history);
    historyProjection.feed = [
      {
        key: "assistant:history-answer",
        kind: "timeline",
        item: { kind: "assistant_message", text: "visible history answer" },
        ts: "2026-05-10T00:00:00.000Z",
      },
    ];

    const next = applyProjectionEventsToSyncState({
      state: {
        projections: new Map([["history", historyProjection]]),
        unreadSessionIds: new Set<string>(),
        selectedSessionId: "history",
        workspaceVisibilityVersion: 0,
        sessionTopologyVersion: 0,
        eventStreamOpenRevision: 0,
        pendingSessionAction: { kind: "resume_history", sessionId: "history" },
        pendingSessionTransition: {
          kind: "resume_history",
          provider: "codex",
          providerSessionId: "thread-1",
        },
        error: null,
      },
      events: [
        event(10, { type: "session.closed", payload: {} }, "history"),
        event(11, { type: "session.created", payload: { session: live.session } }, "live"),
        event(12, { type: "session.started", payload: { session: live.session } }, "live"),
      ],
      applyEventsToMap,
    });

    assert.equal(next.selectedSessionId, "live");
    assert.equal(next.projections.has("history"), false);
    assert.deepEqual(
      next.projections.get("live")?.feed.map((entry) => entry.key),
      ["assistant:history-answer"],
    );
  });

  test("moves a pending Resume to live when close and started arrive in separate flushes", () => {
    const history = summary({
      id: "history-split",
      providerSessionId: "thread-split",
      readOnlyReplay: true,
    });
    const live = summary({
      id: "live-split",
      providerSessionId: "thread-split",
    });
    live.session.phase = "working";
    live.session.runtimeState = "running";
    live.session.nativeTui = {
      terminalId: "live-split",
      viewAvailable: true,
      promptState: "prompt_clean",
      queuedInputCount: 0,
    };
    live.session.capabilities.nativeTui = true;
    live.session.capabilities.rawPtyInput = true;
    const historyProjection = createEmptySessionProjection(history);
    historyProjection.summary.session.status = "running";
    historyProjection.summary.session.phase = "starting";
    historyProjection.summary.session.runtimeState = "starting";
    historyProjection.summary.session.capabilities.steerInput = true;
    historyProjection.summary.session.capabilities.livePermissions = true;
    historyProjection.summary.attachedClients = [
      {
        id: "web-client",
        kind: "web",
        sessionId: "history-split",
        connectionId: "web-connection",
        attachMode: "interactive",
        focus: true,
        lastSeenAt: "2026-05-10T00:00:00.000Z",
      },
    ];
    historyProjection.summary.controlLease = {
      sessionId: "history-split",
      holderClientId: "web-client",
      holderKind: "web",
      grantedAt: "2026-05-10T00:00:00.000Z",
    };
    historyProjection.currentRuntimeStatus = "thinking";
    historyProjection.feed = [
      {
        key: "optimistic:user:split-question",
        kind: "timeline",
        item: {
          kind: "user_message",
          text: "continue after split lifecycle delivery",
          clientMessageId: "split-question",
        },
        ts: "2026-05-10T00:00:01.000Z",
      },
    ];
    const pendingState = {
      projections: new Map([["history-split", historyProjection]]),
      unreadSessionIds: new Set<string>(),
      selectedSessionId: "history-split",
      workspaceVisibilityVersion: 0,
      sessionTopologyVersion: 0,
      eventStreamOpenRevision: 0,
      pendingSessionAction: {
        kind: "resume_history" as const,
        sessionId: "history-split",
      },
      pendingSessionTransition: {
        kind: "resume_history" as const,
        provider: "codex" as const,
        providerSessionId: "thread-split",
      },
      error: null,
    };

    const afterClose = applyProjectionEventsToSyncState({
      state: pendingState,
      events: [
        event(20, { type: "session.closed", payload: {} }, "history-split"),
      ],
      applyEventsToMap,
    });
    assert.equal(afterClose.selectedSessionId, "history-split");
    assert.equal(afterClose.projections.has("history-split"), true);

    const afterStarted = applyProjectionEventsToSyncState({
      state: {
        ...pendingState,
        projections: afterClose.projections,
        selectedSessionId: afterClose.selectedSessionId,
        sessionTopologyVersion: afterClose.sessionTopologyVersion,
      },
      events: [
        event(
          21,
          { type: "session.started", payload: { session: live.session } },
          "live-split",
        ),
        event(
          22,
          { type: "runtime.status", payload: { status: "thinking" } },
          "live-split",
        ),
      ],
      applyEventsToMap,
    });

    assert.equal(afterStarted.selectedSessionId, "live-split");
    assert.equal(afterStarted.projections.has("history-split"), false);
    assert.equal(
      afterStarted.projections.get("live-split")?.summary.session.nativeTui?.viewAvailable,
      true,
    );
    assert.equal(
      afterStarted.projections.get("live-split")?.currentRuntimeStatus,
      "thinking",
    );
    assert.equal(
      afterStarted.projections.get("live-split")?.summary.attachedClients[0]?.sessionId,
      "live-split",
    );
    assert.equal(
      afterStarted.projections.get("live-split")?.summary.controlLease.holderClientId,
      "web-client",
    );
    assert.equal(
      afterStarted.projections.get("live-split")?.summary.controlLease.sessionId,
      "live-split",
    );
    assert.deepEqual(
      afterStarted.projections.get("live-split")?.feed.map((entry) => entry.key),
      ["optimistic:user:split-question"],
    );
  });

  test("coalesces concurrent foreground transport recoveries", async () => {
    let listCalls = 0;
    const pendingListSessions = deferred<ListSessionsResponse>();
    const harness = createRecoverHarness(() => {
      listCalls += 1;
      return pendingListSessions.promise;
    });

    const firstRecovery = recoverTransportCommand(harness.args);
    const secondRecovery = recoverTransportCommand(harness.args);
    await Promise.resolve();

    assert.equal(listCalls, 1);

    pendingListSessions.resolve(emptySessionsResponse());
    await Promise.all([firstRecovery, secondRecovery]);

    assert.equal(harness.getApplyCalls(), 1);
    assert.equal(harness.getRestartCalls(), 1);
    assert.equal(harness.getRestoreCalls(), 1);
  });

  test("restarts the event transport before a slow sessions refresh settles", async () => {
    let requestOptions: Parameters<NonNullable<RecoverArgs["listSessions"]>>[0];
    const pendingListSessions = deferred<ListSessionsResponse>();
    const harness = createRecoverHarness((options) => {
      requestOptions = options;
      return pendingListSessions.promise;
    });

    const recovery = recoverTransportCommand(harness.args);
    await Promise.resolve();

    assert.equal(harness.getRestartCalls(), 1);
    assert.equal(harness.getApplyCalls(), 0);
    assert.equal(requestOptions?.storedSessions, "recent");

    pendingListSessions.resolve(emptySessionsResponse());
    await recovery;

    assert.equal(harness.getApplyCalls(), 1);
    assert.equal(harness.getRestoreCalls(), 1);
  });

  test("preserves the loaded provider catalog during a recent-only foreground refresh", async () => {
    const harness = createRecoverHarness(async () => emptySessionsResponse());
    harness.args.get().storedSessionsCatalogLoaded = true;

    await recoverTransportCommand(harness.args);

    assert.deepEqual(harness.getLastApplyOptions(), {
      workspaceVisibilityVersionAtRequest: 0,
      preserveStoredSessionCatalog: true,
    });
  });

  test("does not finish recovery until both initial replay and session metadata settle", async () => {
    const initialReplay = deferred<void>();
    const pendingListSessions = deferred<ListSessionsResponse>();
    const harness = createRecoverHarness(
      () => pendingListSessions.promise,
      () => initialReplay.promise,
    );

    let settled = false;
    const recovery = recoverTransportCommand(harness.args).then(() => {
      settled = true;
    });
    pendingListSessions.resolve(emptySessionsResponse());
    await Promise.resolve();
    await Promise.resolve();

    assert.equal(settled, false);
    assert.equal(harness.getApplyCalls(), 0);

    initialReplay.resolve();
    await recovery;

    assert.equal(settled, true);
    assert.equal(harness.getApplyCalls(), 1);
    assert.equal(harness.getRestoreCalls(), 1);
  });

  test("replaces a stuck foreground recovery without letting its late response apply", async () => {
    const firstResponse = deferred<ListSessionsResponse>();
    let listCalls = 0;
    const harness = createRecoverHarness(() => {
      listCalls += 1;
      return listCalls === 1
        ? firstResponse.promise
        : Promise.resolve(emptySessionsResponse());
    });

    const firstRecovery = recoverTransportCommand(harness.args);
    await Promise.resolve();
    const replacementRecovery = recoverTransportCommand(harness.args, {
      replaceActive: true,
    });

    await replacementRecovery;
    assert.equal(listCalls, 2);
    assert.equal(harness.getRestartCalls(), 2);
    assert.equal(harness.getApplyCalls(), 1);

    firstResponse.resolve(emptySessionsResponse());
    await assert.rejects(firstRecovery, /aborted/i);

    assert.equal(harness.getApplyCalls(), 1);
    assert.equal(harness.getRestoreCalls(), 1);
  });

  test("does not let stale foreground recovery replace a newer local session topology", async () => {
    let state: RecoverState = {
      projections: new Map<string, SessionProjection>(),
      unreadSessionIds: new Set<string>(),
      selectedSessionId: null,
      workspaceVisibilityVersion: 0,
      sessionTopologyVersion: 0,
      eventStreamOpenRevision: 0,
      pendingSessionAction: null,
      pendingSessionTransition: null,
      error: null,
      workspaceDir: "",
      hiddenWorkspaceDirs: new Set<string>(),
    };
    const live = createEmptySessionProjection(
      summary({ id: "live", providerSessionId: "thread-1" }),
    );
    const args: RecoverArgs = {
      get: () => state,
      set: (partial) => {
        state = {
          ...state,
          ...(typeof partial === "function" ? partial(state) : partial),
        };
      },
      applySessionsResponse: () => {
        throw new Error("stale sessions response should not be applied");
      },
      restartTransport: () => undefined,
      maybeRestoreLastHistorySelection: async () => undefined,
      listSessions: async () => {
        state = {
          ...state,
          projections: new Map([["live", live]]),
          selectedSessionId: "live",
          sessionTopologyVersion: 1,
          eventStreamOpenRevision: state.eventStreamOpenRevision,
        };
        return emptySessionsResponse();
      },
    };

    await recoverTransportCommand(args);

    assert.equal(state.selectedSessionId, "live");
    assert.equal(state.projections.has("live"), true);
    assert.equal(state.error, null);
  });

  test("allows another foreground recovery after the previous one settles", async () => {
    let listCalls = 0;
    const harness = createRecoverHarness(async () => {
      listCalls += 1;
      return emptySessionsResponse();
    });

    await recoverTransportCommand(harness.args);
    await recoverTransportCommand(harness.args);

    assert.equal(listCalls, 2);
    assert.equal(harness.getApplyCalls(), 2);
    assert.equal(harness.getRestartCalls(), 2);
    assert.equal(harness.getRestoreCalls(), 2);
  });
});

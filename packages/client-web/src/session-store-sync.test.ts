import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { ListSessionsResponse, RahEvent, SessionSummary } from "@rah/runtime-protocol";
import {
  applyProjectionEventsToSyncState,
  coalesceProjectionEvents,
  recoverTransportCommand,
} from "./session-store-sync";
import { applyEventsToProjectionMap } from "./session-store-projections";
import { createEmptySessionProjection } from "./session-store-session-lifecycle";
import type { SessionProjection } from "./types";

type RecoverArgs = Parameters<typeof recoverTransportCommand>[0];
type RecoverState = ReturnType<RecoverArgs["get"]>;

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
        renameSession: true,
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
    clearBufferedSession: () => undefined,
    queuePendingEvent: () => undefined,
    shouldDeferEvent: () => false,
    queueDeferredEvent: () => undefined,
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

function createRecoverHarness(listSessions: NonNullable<RecoverArgs["listSessions"]>) {
  let state: RecoverState = {
    projections: new Map<string, SessionProjection>(),
    unreadSessionIds: new Set<string>(),
    selectedSessionId: null,
    workspaceVisibilityVersion: 0,
    sessionTopologyVersion: 0,
    pendingSessionAction: null,
    pendingSessionTransition: null,
    error: null,
    workspaceDir: "",
    hiddenWorkspaceDirs: new Set<string>(),
  };
  let applyCalls = 0;
  let restartCalls = 0;
  let restoreCalls = 0;

  const args: RecoverArgs = {
    get: () => state,
    set: (partial) => {
      const patch = typeof partial === "function" ? partial(state) : partial;
      state = { ...state, ...patch };
    },
    applySessionsResponse: (currentState, sessionsResponse) => {
      applyCalls += 1;
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
    restartTransport: () => {
      restartCalls += 1;
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
  };
}

describe("session store recovery", () => {
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

  test("keeps the selected history projection while claim close waits for live creation", () => {
    const history = summary({
      id: "history",
      providerSessionId: "thread-1",
      readOnlyReplay: true,
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
        pendingSessionAction: { kind: "claim_history", sessionId: "history" },
        pendingSessionTransition: {
          kind: "claim_history",
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

  test("moves selected history projection to live session when claim live events arrive", () => {
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
        pendingSessionAction: { kind: "claim_history", sessionId: "history" },
        pendingSessionTransition: {
          kind: "claim_history",
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

  test("does not let stale foreground recovery replace a newer local session topology", async () => {
    let state: RecoverState = {
      projections: new Map<string, SessionProjection>(),
      unreadSessionIds: new Set<string>(),
      selectedSessionId: null,
      workspaceVisibilityVersion: 0,
      sessionTopologyVersion: 0,
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

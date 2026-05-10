import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { ListSessionsResponse, RahEvent } from "@rah/runtime-protocol";
import { coalesceProjectionEvents, recoverTransportCommand } from "./session-store-sync";
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
): RahEvent {
  return {
    id: `event-${seq}`,
    seq,
    ts: `2026-05-10T00:00:${String(seq).padStart(2, "0")}.000Z`,
    sessionId: "session-1",
    source: { provider: "codex", channel: "structured_live", authority: "derived" },
    ...value,
  } as RahEvent;
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

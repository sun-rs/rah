import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { ListSessionsResponse } from "@rah/runtime-protocol";
import { recoverTransportCommand } from "./session-store-sync";
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

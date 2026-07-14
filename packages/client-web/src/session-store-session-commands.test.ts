import assert from "node:assert/strict";
import { test } from "node:test";

import {
  closeSessionCommand,
  serializeSessionTransportCommand,
} from "./session-store-session-commands";

const originalFetch = globalThis.fetch;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

test("serializes transport commands for one session without blocking another", async () => {
  const first = deferred<string>();
  const order: string[] = [];
  const firstResult = serializeSessionTransportCommand("session-a", async () => {
    order.push("a:first:start");
    const value = await first.promise;
    order.push("a:first:end");
    return value;
  });
  const secondResult = serializeSessionTransportCommand("session-a", async () => {
    order.push("a:second");
    return "second";
  });
  const otherResult = serializeSessionTransportCommand("session-b", async () => {
    order.push("b:first");
    return "other";
  });

  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(order, ["a:first:start", "b:first"]);
  first.resolve("first");
  assert.equal(await firstResult, "first");
  assert.equal(await secondResult, "second");
  assert.equal(await otherResult, "other");
  assert.deepEqual(order, ["a:first:start", "b:first", "a:first:end", "a:second"]);
});

test("a failed command does not poison later commands for the session", async () => {
  const first = deferred<void>();
  const order: string[] = [];
  const failed = serializeSessionTransportCommand("session-failure", async () => {
    order.push("first");
    await first.promise;
  });
  const recovered = serializeSessionTransportCommand("session-failure", async () => {
    order.push("second");
    return "recovered";
  });

  await new Promise((resolve) => setTimeout(resolve, 0));
  first.reject(new Error("expected"));
  await assert.rejects(failed, /expected/);
  assert.equal(await recovered, "recovered");
  assert.deepEqual(order, ["first", "second"]);
});

test("a confirmed stop does not wait for the secondary workbench refresh", async () => {
  type CommandState = ReturnType<Parameters<typeof closeSessionCommand>[0]["get"]>;
  const refresh = deferred<void>();
  let refreshStarted = false;
  let state: CommandState = {
    clientId: "web-user",
    connectionId: "web-connection",
    projections: new Map(),
    unreadSessionIds: new Set(),
    hiddenWorkspaceDirs: new Set(),
    workspaceDirs: [],
    workspaceVisibilityVersion: 0,
    sessionTopologyVersion: 0,
    workspaceDir: "",
    selectedSessionId: null,
    newSessionProvider: "codex",
    pendingSessionTransition: null,
    pendingSessionAction: null,
    storedSessions: [],
    recentSessions: [],
    error: null,
  };
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;

  try {
    await closeSessionCommand({
      get: () => state,
      set: (partial) => {
        const patch = typeof partial === "function" ? partial(state) : partial;
        state = { ...state, ...patch };
      },
      sessionId: "session-1",
      refreshWorkbenchState: () => {
        refreshStarted = true;
        return refresh.promise;
      },
    });
    assert.equal(refreshStarted, true);
  } finally {
    refresh.resolve();
    globalThis.fetch = originalFetch;
  }
});

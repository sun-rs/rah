import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionSummary } from "@rah/runtime-protocol";

import {
  closeSessionCommand,
  deleteQueuedInputCommand,
  sendInputCommand,
  serializeSessionTransportCommand,
  updateQueuedInputCommand,
} from "./session-store-session-commands";
import type { SessionProjection } from "./types";

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

function sessionSummary(): SessionSummary {
  return {
    session: {
      id: "session-queue",
      provider: "codex",
      launchSource: "web",
      cwd: "/workspace/rah",
      rootDir: "/workspace/rah",
      runtimeState: "running",
      capabilities: {
        liveAttach: true,
        structuredTimeline: true,
        livePermissions: true,
        contextUsage: true,
        resumeByProvider: true,
        listProviderSessions: true,
        steerInput: true,
        queuedInput: true,
        modelSwitch: false,
        planMode: false,
        subagents: false,
      },
      createdAt: "2026-07-17T00:00:00.000Z",
      updatedAt: "2026-07-17T00:00:00.000Z",
    },
    attachedClients: [],
    controlLease: { sessionId: "session-queue" },
  };
}

function sessionProjection(lastSeq: number): SessionProjection {
  return {
    summary: sessionSummary(),
    feed: [],
    events: [],
    lastSeq,
  };
}

function sessionSummaryWithQueuedInput(text = "original"): SessionSummary {
  const summary = sessionSummary();
  return {
    ...summary,
    session: {
      ...summary.session,
      inputQueue: [
        {
          clientMessageId: "client-message-1",
          clientTurnId: "client-turn-1",
          text,
          queuedAt: "2026-07-17T00:00:01.000Z",
          position: 1,
        },
      ],
    },
  };
}

function commandState(projection: SessionProjection) {
  type CommandState = ReturnType<Parameters<typeof updateQueuedInputCommand>[0]["get"]>;
  const state: CommandState = {
    clientId: "web-user",
    connectionId: "web-connection",
    projections: new Map([[projection.summary.session.id, projection]]),
    unreadSessionIds: new Set(),
    hiddenWorkspaceDirs: new Set(),
    workspaceDirs: [],
    workspaceVisibilityVersion: 0,
    sessionTopologyVersion: 0,
    workspaceDir: "",
    selectedSessionId: projection.summary.session.id,
    newSessionProvider: "codex",
    pendingSessionTransition: null,
    pendingSessionAction: null,
    storedSessions: [],
    recentSessions: [],
    error: null,
  };
  return state;
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

test("a follow-up submitted during structured work is queued even for a legacy steer policy", async () => {
  const response = deferred<Response>();
  const projection: SessionProjection = {
    ...sessionProjection(10),
    currentRuntimeStatus: "thinking",
  };
  projection.summary.session.inputQueuePolicy = "steer";
  let state = commandState(projection);
  globalThis.fetch = (() => response.promise) as typeof fetch;

  try {
    const sending = sendInputCommand({
      get: () => state,
      set: (partial) => {
        const patch = typeof partial === "function" ? partial(state) : partial;
        state = { ...state, ...patch };
      },
      sessionId: "session-queue",
      text: "follow up",
      attachments: [
        {
          id: "attachment-1",
          kind: "image",
          name: "chart.png",
          mediaType: "image/png",
          size: 128,
        },
      ],
    });

    const queued = state.projections.get("session-queue")?.summary.session.inputQueue;
    assert.equal(queued?.length, 1);
    assert.equal(queued?.[0]?.text, "follow up");
    assert.equal(queued?.[0]?.position, 1);
    assert.deepEqual(queued?.[0]?.attachments?.map((attachment) => attachment.id), [
      "attachment-1",
    ]);
    assert.equal(state.projections.get("session-queue")?.feed.length, 0);

    response.resolve(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    await sending;
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("the first input after startup stays in the transcript instead of the follow-up queue", async () => {
  const response = deferred<Response>();
  const projection: SessionProjection = {
    ...sessionProjection(10),
    currentRuntimeStatus: "thinking",
  };
  projection.summary.session.phase = "starting";
  let state = commandState(projection);
  globalThis.fetch = (() => response.promise) as typeof fetch;

  try {
    const sending = sendInputCommand({
      get: () => state,
      set: (partial) => {
        const patch = typeof partial === "function" ? partial(state) : partial;
        state = { ...state, ...patch };
      },
      sessionId: "session-queue",
      text: "first resumed input",
      clientMessageId: "resume-message",
      clientTurnId: "resume-turn",
      skipOptimisticQueue: true,
    });

    const resumed = state.projections.get("session-queue");
    assert.equal(resumed?.summary.session.inputQueue, undefined);
    assert.equal(resumed?.feed.length, 1);
    assert.equal(
      resumed?.feed[0]?.kind === "timeline" ? resumed.feed[0].item.kind : undefined,
      "user_message",
    );

    response.resolve(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    await sending;
  } finally {
    globalThis.fetch = originalFetch;
  }
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

for (const operation of ["update", "delete"] as const) {
  test(`a failed queued-input ${operation} preserves newer streamed projection state`, async () => {
    const oldProjection = sessionProjection(10);
    const streamedProjection = sessionProjection(11);
    let state = commandState(oldProjection);
    globalThis.fetch = (async () => {
      state = {
        ...state,
        projections: new Map([[streamedProjection.summary.session.id, streamedProjection]]),
      };
      throw new Error("network failed");
    }) as typeof fetch;

    const commandArgs = {
      get: () => state,
      set: (
        partial:
          | Partial<typeof state>
          | ((current: typeof state) => Partial<typeof state> | typeof state),
      ) => {
        const patch = typeof partial === "function" ? partial(state) : partial;
        state = { ...state, ...patch };
      },
      sessionId: "session-queue",
      clientMessageId: "client-message-1",
    };

    try {
      await assert.rejects(
        operation === "update"
          ? updateQueuedInputCommand({ ...commandArgs, text: "updated" })
          : deleteQueuedInputCommand(commandArgs),
        /network failed/,
      );
      assert.equal(state.projections.get("session-queue"), streamedProjection);
      assert.equal(state.projections.get("session-queue")?.lastSeq, 11);
      assert.match(state.error ?? "", /network failed/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
}

for (const operation of ["update", "delete"] as const) {
  test(`a successful queued-input ${operation} cannot restore a queue item already drained by a streamed event`, async () => {
    const queuedProjection: SessionProjection = {
      ...sessionProjection(10),
      summary: sessionSummaryWithQueuedInput(),
    };
    const streamedProjection = sessionProjection(11);
    const staleResponseSummary = sessionSummaryWithQueuedInput(
      operation === "update" ? "updated" : "original",
    );
    let state = commandState(queuedProjection);
    globalThis.fetch = (async () => {
      state = {
        ...state,
        projections: new Map([[streamedProjection.summary.session.id, streamedProjection]]),
      };
      return new Response(JSON.stringify({ session: staleResponseSummary }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const commandArgs = {
      get: () => state,
      set: (
        partial:
          | Partial<typeof state>
          | ((current: typeof state) => Partial<typeof state> | typeof state),
      ) => {
        const patch = typeof partial === "function" ? partial(state) : partial;
        state = { ...state, ...patch };
      },
      sessionId: "session-queue",
      clientMessageId: "client-message-1",
    };

    try {
      if (operation === "update") {
        await updateQueuedInputCommand({ ...commandArgs, text: "updated" });
      } else {
        await deleteQueuedInputCommand(commandArgs);
      }
      const projection = state.projections.get("session-queue");
      assert.equal(projection?.lastSeq, 11);
      assert.deepEqual(projection?.summary.session.inputQueue, undefined);
      assert.equal(state.error, null);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
}

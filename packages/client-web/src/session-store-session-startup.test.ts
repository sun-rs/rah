import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import type {
  ConversationTurnsPageResponse,
  SessionSummary,
  StoredSessionRef,
} from "@rah/runtime-protocol";
import {
  activateHistorySessionCommand,
  cancelPendingSessionStartupCommand,
  forkSessionCommand,
  resumeHistorySessionCommand,
  resumeStoredSessionCommand,
  startSessionCommand,
} from "./session-store-session-startup";
import {
  createEmptySessionProjection,
  storedReplayPlaceholderSessionId,
} from "./session-store-session-lifecycle";
import { initialConversationSyncState, type FeedEntry } from "./types";
import { ensureConversationLoadedCommand } from "./session-store-conversation";

type CapturedRequest = {
  url: string;
  method: string;
  body: unknown;
};

const originalFetch = globalThis.fetch;
const originalWindow = (globalThis as typeof globalThis & { window?: unknown }).window;

function installWebApiMocks(handler: (request: CapturedRequest) => unknown): CapturedRequest[] {
  const requests: CapturedRequest[] = [];
  (globalThis as typeof globalThis & { window?: unknown }).window = {
    localStorage: {
      getItem: () => null,
      setItem: () => undefined,
      removeItem: () => undefined,
    },
    location: {
      hostname: "127.0.0.1",
      origin: "http://127.0.0.1:43112",
      port: "43112",
      protocol: "http:",
    },
  };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = {
      url: String(input),
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(String(init.body)) : null,
    };
    requests.push(request);
    const result = await handler(request);
    if (result instanceof Response) {
      return result;
    }
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return requests;
}

function restoreWebApiMocks(): void {
  globalThis.fetch = originalFetch;
  (globalThis as typeof globalThis & { window?: unknown }).window = originalWindow;
}

function summary(args: {
  id: string;
  provider?: "codex" | "claude" | "opencode";
  providerSessionId?: string;
  cwd?: string;
  rootDir?: string;
  modeId?: string;
  modelId?: string | null;
  reasoningId?: string | null;
  readOnlyReplay?: boolean;
}): SessionSummary {
  const cwd = args.cwd ?? "/tmp/rah";
  const readOnlyReplay = args.readOnlyReplay === true;
  return {
    session: {
      id: args.id,
      provider: args.provider ?? "codex",
      ...(args.providerSessionId ? { providerSessionId: args.providerSessionId } : {}),
      launchSource: "web",
      cwd,
      rootDir: args.rootDir ?? cwd,
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
      mode: {
        currentModeId: args.modeId ?? "on-request/read-only",
        availableModes: [],
        mutable: true,
        source: "native",
      },
      model: {
        currentModelId: args.modelId ?? null,
        currentReasoningId: args.reasoningId ?? null,
        availableModels: [],
        mutable: true,
        source: "native",
      },
      createdAt: "2026-04-29T00:00:00.000Z",
      updatedAt: "2026-04-29T00:00:00.000Z",
    },
    attachedClients: [],
    controlLease: { sessionId: args.id },
  };
}

function startupDeps(
  stateOverrides: Record<string, unknown> = {},
  depOverrides: Record<string, unknown> = {},
) {
  const state = {
    clientId: "web-client",
    connectionId: "web-connection",
    projections: new Map<string, ReturnType<typeof createEmptySessionProjection>>(),
    unreadSessionIds: new Set<string>(),
    hiddenWorkspaceDirs: new Set<string>(),
    workspaceDirs: ["/tmp/rah"],
    workspaceVisibilityVersion: 1,
    sessionTopologyVersion: 0,
    workspaceDir: "/tmp/rah",
    selectedSessionId: null,
    newSessionProvider: "codex",
    pendingSessionTransition: null,
    pendingSessionAction: null,
    storedSessions: [] as StoredSessionRef[],
    recentSessions: [] as StoredSessionRef[],
    error: null,
    ...stateOverrides,
  };
  return {
    get: () => state,
    set: (partial: unknown) => {
      Object.assign(
        state,
        typeof partial === "function" ? partial(state) : partial,
      );
    },
    ensureConversationLoaded: async () => undefined,
    initializeLiveConversationProjection: async () => undefined,
    sendInput: async () => undefined,
    attachSession: async () => undefined,
    resumeStoredSession: async () => undefined,
    applySessionsResponse: () => state,
    adoptExistingProjectionForProviderSession: (projections: typeof state.projections) =>
      projections,
    applyEventsToMap: (current: typeof state.projections) => current,
    takePendingEventsForSessions: () => [],
    confirmCreateMissingWorkspace: async () => true,
    ...depOverrides,
  } as never;
}

beforeEach(() => {
  restoreWebApiMocks();
});

afterEach(() => {
  restoreWebApiMocks();
});

test("fork session command keeps Side children attached without replacing the parent selection", async () => {
  const parent = summary({ id: "parent", providerSessionId: "thread-parent" });
  const side = summary({ id: "side", providerSessionId: "thread-side" });
  side.session.relationship = {
    parentSessionId: "parent",
    parentProviderSessionId: "thread-parent",
    kind: "side",
    workspaceMode: "shared",
    persistence: "ephemeral",
  };
  const deps = startupDeps({
    selectedSessionId: "parent",
    projections: new Map([["parent", createEmptySessionProjection(parent)]]),
  });
  const requests = installWebApiMocks(() => ({ session: side }));

  const sessionId = await forkSessionCommand(deps, "parent", {
    operationId: "side-operation-1",
    kind: "side",
    workspaceMode: "shared",
  });

  assert.equal(sessionId, "side");
  assert.equal(deps.get().selectedSessionId, "parent");
  assert.equal(deps.get().projections.has("side"), true);
  assert.deepEqual(requests[0], {
    url: "http://127.0.0.1:43111/api/sessions/parent/fork",
    method: "POST",
    body: {
      operationId: "side-operation-1",
      kind: "side",
      workspaceMode: "shared",
      attach: {
        client: {
          id: "web-client",
          kind: "web",
          connectionId: "web-connection",
        },
        mode: "interactive",
        claimControl: true,
      },
    },
  });
});

test("fork session command shares one in-flight request for repeated activation", async () => {
  const parent = summary({ id: "parent-flight", providerSessionId: "thread-parent-flight" });
  const side = summary({ id: "side-flight", providerSessionId: "thread-side-flight" });
  side.session.relationship = {
    parentSessionId: "parent-flight",
    parentProviderSessionId: "thread-parent-flight",
    kind: "side",
    workspaceMode: "shared",
    persistence: "ephemeral",
  };
  const deps = startupDeps({
    selectedSessionId: "parent-flight",
    projections: new Map([["parent-flight", createEmptySessionProjection(parent)]]),
  });
  let resolveRequest!: (value: { session: SessionSummary }) => void;
  const pendingResponse = new Promise<{ session: SessionSummary }>((resolve) => {
    resolveRequest = resolve;
  });
  const requests = installWebApiMocks(() => pendingResponse);

  const first = forkSessionCommand(deps, "parent-flight", {
    kind: "side",
    workspaceMode: "shared",
  });
  const duplicate = forkSessionCommand(deps, "parent-flight", {
    kind: "side",
    workspaceMode: "shared",
  });
  assert.equal(requests.length, 1);
  await assert.rejects(
    forkSessionCommand(deps, "parent-flight", {
      kind: "fork",
      workspaceMode: "shared",
    }),
    /branch operation is already running/,
  );

  resolveRequest({ session: side });
  assert.deepEqual(await Promise.all([first, duplicate]), ["side-flight", "side-flight"]);
  assert.equal(requests.length, 1);
});

test("fork session command reuses operationId after an ambiguous transport failure", async () => {
  const parent = summary({ id: "parent-retry", providerSessionId: "thread-parent-retry" });
  const side = summary({ id: "side-retry", providerSessionId: "thread-side-retry" });
  side.session.relationship = {
    parentSessionId: "parent-retry",
    parentProviderSessionId: "thread-parent-retry",
    kind: "side",
    workspaceMode: "shared",
    persistence: "ephemeral",
  };
  const deps = startupDeps({
    selectedSessionId: "parent-retry",
    projections: new Map([["parent-retry", createEmptySessionProjection(parent)]]),
  });
  let attempt = 0;
  const requests = installWebApiMocks(() => {
    attempt += 1;
    if (attempt === 1) {
      return new Response(JSON.stringify({ error: "response lost" }), {
        status: 503,
        headers: { "content-type": "application/json" },
      });
    }
    return { session: side };
  });

  await assert.rejects(
    forkSessionCommand(deps, "parent-retry", {
      kind: "side",
      workspaceMode: "shared",
    }),
    /response lost/,
  );
  const sessionId = await forkSessionCommand(deps, "parent-retry", {
    kind: "side",
    workspaceMode: "shared",
  });

  assert.equal(sessionId, "side-retry");
  assert.equal(requests.length, 2);
  assert.equal(
    (requests[0]?.body as { operationId?: string }).operationId,
    (requests[1]?.body as { operationId?: string }).operationId,
  );
});

test("fork session command selects persistent child tasks", async () => {
  const parent = summary({ id: "parent", providerSessionId: "thread-parent" });
  const child = summary({ id: "fork", providerSessionId: "thread-fork" });
  child.session.relationship = {
    parentSessionId: "parent",
    parentProviderSessionId: "thread-parent",
    kind: "fork",
    workspaceMode: "shared",
    persistence: "persistent",
  };
  const deps = startupDeps({
    selectedSessionId: "parent",
    projections: new Map([["parent", createEmptySessionProjection(parent)]]),
  });
  installWebApiMocks(() => ({ session: child }));

  await forkSessionCommand(deps, "parent", {
    operationId: "fork-operation-1",
    kind: "fork",
    workspaceMode: "shared",
    lastTurnId: "turn-3",
  });

  assert.equal(deps.get().selectedSessionId, "fork");
  assert.equal(deps.get().projections.has("fork"), true);
  assert.equal(deps.get().sessionTopologyVersion, 1);
});

describe("session startup model and mode requests", () => {
  test("new composer input enters a provisional Starting chat before workspace I/O resolves", async () => {
    let resolveWorkspace!: (value: unknown) => void;
    const workspaceGate = new Promise<unknown>((resolve) => {
      resolveWorkspace = resolve;
    });
    installWebApiMocks((request) => {
      if (request.url.includes("/api/fs/list")) return workspaceGate;
      if (request.url.endsWith("/api/sessions/start")) {
        return { session: summary({ id: "started-immediately" }) };
      }
      if (request.url.endsWith("/input")) return { ok: true };
      throw new Error(`Unexpected request ${request.url}`);
    });
    const deps = startupDeps();
    const starting = startSessionCommand(deps, {
      provider: "codex",
      cwd: "/tmp/rah",
      title: "Immediate chat",
      initialInput: "start now",
    });

    const provisionalId = deps.get().selectedSessionId;
    assert.match(provisionalId ?? "", /^starting-session:/);
    const provisional = deps.get().projections.get(provisionalId!);
    assert.equal(provisional?.summary.session.phase, "starting");
    assert.equal(provisional?.summary.session.status, "running");
    assert.equal(provisional?.feed[0]?.kind, "timeline");
    if (provisional?.feed[0]?.kind === "timeline") {
      assert.equal(provisional.feed[0].item.kind, "user_message");
      if (provisional.feed[0].item.kind === "user_message") {
        assert.equal(provisional.feed[0].item.text, "start now");
      }
    }

    resolveWorkspace({ path: "/tmp/rah", entries: [] });
    assert.equal(await starting, "started-immediately");
  });

  test("new session keeps submitted controls visible and completion cannot steal newer navigation", async () => {
    let releaseStart!: () => void;
    const startGate = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    installWebApiMocks(async (request) => {
      if (request.url.includes("/api/fs/list")) {
        return { path: "/tmp/rah", entries: [] };
      }
      if (request.url.endsWith("/api/sessions/start")) {
        await startGate;
        return {
          session: summary({
            id: "started-with-medium",
            provider: "codex",
            cwd: "/tmp/rah",
            modeId: "plan:never/danger-full-access",
            modelId: "gpt-5.6-sol",
            // Simulate the first daemon snapshot racing with launch config.
            reasoningId: "ultra",
          }),
        };
      }
      throw new Error(`Unexpected request ${request.url}`);
    });
    const other = summary({ id: "other-session", cwd: "/tmp/rah" });
    const deps = startupDeps({
      projections: new Map([["other-session", createEmptySessionProjection(other)]]),
      workspaceDirs: ["/tmp/other", "/tmp/rah"],
      workspaceDir: "/tmp/other",
    });

    const starting = startSessionCommand(deps, {
      provider: "codex",
      cwd: "/tmp/rah",
      initialInput: "start with medium",
      modeId: "plan:never/danger-full-access",
      model: "gpt-5.6-sol",
      reasoningId: "medium",
      optionValues: { model_reasoning_effort: "medium" },
    });

    const provisionalId = deps.get().selectedSessionId!;
    const provisional = deps.get().projections.get(provisionalId);
    assert.match(provisionalId, /^starting-session:/);
    assert.equal(provisional?.summary.session.model?.currentModelId, "gpt-5.6-sol");
    assert.equal(provisional?.summary.session.model?.currentReasoningId, "medium");
    assert.equal(
      provisional?.summary.session.mode?.currentModeId,
      "plan:never/danger-full-access",
    );
    assert.deepEqual(provisional?.summary.session.config?.values, {
      model_reasoning_effort: "medium",
    });

    deps.set({ selectedSessionId: "other-session" });
    releaseStart();
    assert.equal(await starting, "started-with-medium");

    const state = deps.get();
    const started = state.projections.get("started-with-medium");
    assert.equal(state.selectedSessionId, "other-session");
    assert.equal(state.workspaceDir, "/tmp/other");
    assert.equal(state.projections.has(provisionalId), false);
    assert.equal(started?.summary.session.model?.currentModelId, "gpt-5.6-sol");
    assert.equal(started?.summary.session.model?.currentReasoningId, "medium");
    assert.equal(
      started?.summary.session.mode?.currentModeId,
      "plan:never/danger-full-access",
    );
  });

  test("the provisional Stop action cancels startup before the initial turn is sent", async () => {
    let releaseStart!: () => void;
    const startGate = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    const requests = installWebApiMocks(async (request) => {
      if (request.url.includes("/api/fs/list")) return { path: "/tmp/rah", entries: [] };
      if (request.url.endsWith("/api/sessions/start")) {
        await startGate;
        return { session: summary({ id: "canceled-real-session" }) };
      }
      if (request.url.endsWith("/api/sessions/canceled-real-session/close")) {
        return { ok: true };
      }
      throw new Error(`Unexpected request ${request.url}`);
    });
    let sendCount = 0;
    const deps = startupDeps({}, {
      sendInput: async () => {
        sendCount += 1;
      },
    });
    const starting = startSessionCommand(deps, {
      provider: "codex",
      cwd: "/tmp/rah",
      initialInput: "do not send",
    });
    const provisionalId = deps.get().selectedSessionId!;
    assert.equal(cancelPendingSessionStartupCommand(deps, provisionalId), true);
    assert.equal(
      deps.get().projections.get(provisionalId)?.summary.session.phase,
      "stopping",
    );

    releaseStart();
    assert.equal(await starting, null);
    assert.equal(sendCount, 0);
    assert.equal(deps.get().projections.has(provisionalId), false);
    assert.equal(
      requests.some((request) =>
        request.url.endsWith("/api/sessions/canceled-real-session/close"),
      ),
      true,
    );
  });

  test("new session sends selected mode, model, and optionValues to the daemon", async () => {
    const requests = installWebApiMocks((request) => {
      if (request.url.includes("/api/fs/list")) {
        return { path: "/tmp/rah", entries: [] };
      }
      if (request.url.endsWith("/api/sessions/start")) {
        const body = request.body as {
          provider: "codex";
          cwd: string;
          modeId?: string;
          model?: string;
          reasoningId?: string;
        };
        return {
          session: summary({
            id: "started",
            provider: body.provider,
            cwd: body.cwd,
            modeId: body.modeId,
            modelId: body.model,
            reasoningId: body.reasoningId,
          }),
        };
      }
      throw new Error(`Unexpected request ${request.url}`);
    });
    const historyLoads: string[] = [];
    const liveProjectionLoads: string[] = [];

    await startSessionCommand(
      startupDeps(
        {},
        {
          ensureConversationLoaded: async (sessionId: string) => {
            historyLoads.push(sessionId);
          },
          initializeLiveConversationProjection: async (sessionId: string) => {
            liveProjectionLoads.push(sessionId);
          },
        },
      ),
      {
        provider: "codex",
        cwd: "/tmp/rah",
        title: "test",
        modeId: "on-request/read-only",
        model: "gpt-5.5",
        reasoningId: "xhigh",
        optionValues: { model_reasoning_effort: "xhigh" },
        initialInput: "",
      },
    );

    const startRequest = requests.find((request) =>
      request.url.endsWith("/api/sessions/start"),
    );
    assert.deepEqual(startRequest?.body, {
      provider: "codex",
      cwd: "/tmp/rah",
      liveBackend: "native_local_server",
      title: "test",
      model: "gpt-5.5",
      optionValues: { model_reasoning_effort: "xhigh" },
      modeId: "on-request/read-only",
      attach: {
        client: {
          id: "web-client",
          kind: "web",
          connectionId: "web-connection",
        },
        mode: "interactive",
        claimControl: true,
      },
    });
    assert.deepEqual(historyLoads, []);
    assert.deepEqual(liveProjectionLoads, ["started"]);
  });

  test("new session submits its text-only first turn atomically with Session startup", async () => {
    let startBody: Record<string, unknown> | null = null;
    installWebApiMocks((request) => {
      if (request.url.includes("/api/fs/list")) {
        return { path: "/tmp/rah", entries: [] };
      }
      if (request.url.endsWith("/api/sessions/start")) {
        startBody = request.body as Record<string, unknown>;
        return {
          session: summary({
            id: "started",
            provider: "codex",
            cwd: "/tmp/rah",
          }),
        };
      }
      throw new Error(`Unexpected request ${request.url}`);
    });

    const calls: string[] = [];
    const deps = startupDeps(
      {},
      {
        initializeLiveConversationProjection: async () => {
          calls.push("conversation");
        },
        sendInput: async () => {
          throw new Error("text-only startup must not issue a second input request");
        },
      },
    );
    const sessionId = await startSessionCommand(
      deps,
      {
        provider: "codex",
        cwd: "/tmp/rah",
        title: "test",
        initialInput: "hello",
        onSessionCreated: (createdSessionId) => {
          calls.push(`created:${createdSessionId}`);
        },
      },
    );

    assert.equal(sessionId, "started");
    assert.deepEqual(calls, ["created:started", "conversation"]);
    const initialInput = startBody?.initialInput as Record<string, unknown>;
    assert.equal(initialInput.text, "hello");
    assert.equal(initialInput.clientId, "web-client");
    assert.match(String(initialInput.clientMessageId), /^client-message:/);
    assert.match(String(initialInput.clientTurnId), /^client-turn:/);
    assert.equal(deps.get().projections.get("started")?.feed.length, 1);
  });

  test("new session sidebar placement uses daemon returned workspace metadata", async () => {
    const requests = installWebApiMocks((request) => {
      if (request.url.includes("/api/fs/list")) {
        return { path: "/tmp/rah-link", entries: [] };
      }
      if (request.url.endsWith("/api/sessions/start")) {
        return {
          session: summary({
            id: "started-normalized",
            provider: "codex",
            cwd: "/tmp/rah-link",
            rootDir: "/private/tmp/rah-real",
          }),
        };
      }
      throw new Error(`Unexpected request ${request.url}`);
    });
    const deps = startupDeps({
      workspaceDirs: ["/tmp/rah"],
      workspaceDir: "/tmp/rah",
    });

    await startSessionCommand(deps, {
      provider: "codex",
      cwd: "/tmp/rah-link",
      title: "test",
    });

    const startRequest = requests.find((request) => request.url.endsWith("/api/sessions/start"));
    assert.equal((startRequest?.body as { cwd?: string } | null)?.cwd, "/tmp/rah-link");
    const state = deps.get();
    assert.equal(state.workspaceDir, "/private/tmp/rah-real");
    assert.deepEqual(state.workspaceDirs, ["/tmp/rah", "/private/tmp/rah-real"]);
    assert.equal(state.selectedSessionId, "started-normalized");
  });

  test("new session selects native local-server backend for providers that support it", async () => {
    const requests = installWebApiMocks((request) => {
      if (request.url.includes("/api/fs/list")) {
        return { path: "/tmp/rah", entries: [] };
      }
      if (request.url.endsWith("/api/sessions/start")) {
        const body = request.body as {
          provider: "codex" | "claude" | "opencode";
          cwd: string;
        };
        return {
          session: summary({
            id: `started-${body.provider}`,
            provider: body.provider,
            cwd: body.cwd,
          }),
        };
      }
      throw new Error(`Unexpected request ${request.url}`);
    });

    for (const provider of ["codex", "claude", "opencode"] as const) {
      await startSessionCommand(
        startupDeps({ newSessionProvider: provider }),
        {
          provider,
          cwd: "/tmp/rah",
          title: `${provider} test`,
          initialInput: "",
        },
      );
    }

    const startRequests = requests.filter((request) =>
      request.url.endsWith("/api/sessions/start"),
    );
    assert.deepEqual(
      startRequests.map((request) => {
        const body = request.body as { provider: string; liveBackend?: string };
        return [body.provider, body.liveBackend ?? null];
      }),
      [
        ["codex", "native_local_server"],
        ["claude", "tui_mux"],
        ["opencode", "native_local_server"],
      ],
    );
  });

  test("resume history sends selected mode, model, and optionValues", async () => {
    const history = summary({
      id: "history",
      provider: "codex",
      providerSessionId: "thread-1",
      cwd: "/tmp/rah",
    });
    const projections = new Map([["history", createEmptySessionProjection(history)]]);
    const requests = installWebApiMocks((request) => {
      if (request.url.includes("/api/fs/list")) {
        return { path: "/tmp/rah", entries: [] };
      }
      if (request.url.endsWith("/api/sessions/resume")) {
        const body = request.body as {
          provider: "codex";
          providerSessionId: string;
          cwd?: string;
          modeId?: string;
          model?: string;
          optionValues?: { model_reasoning_effort?: string };
        };
        return {
          session: summary({
            id: "claimed",
            provider: body.provider,
            providerSessionId: body.providerSessionId,
            cwd: body.cwd,
            modeId: body.modeId,
            modelId: body.model,
            reasoningId: body.optionValues?.model_reasoning_effort,
          }),
        };
      }
      if (request.url.endsWith("/api/sessions/claimed/model")) {
        const body = request.body as {
          modelId: string;
          reasoningId?: string | null;
        };
        return {
          session: summary({
            id: "claimed",
            provider: "codex",
            providerSessionId: "thread-1",
            cwd: "/tmp/rah",
            modeId: "on-request/read-only",
            modelId: body.modelId,
            reasoningId: body.reasoningId,
          }),
        };
      }
      throw new Error(`Unexpected request ${request.url}`);
    });

    await resumeHistorySessionCommand(
      startupDeps({
        projections,
        storedSessions: [
          {
            provider: "codex",
            providerSessionId: "thread-1",
            cwd: "/tmp/rah",
            rootDir: "/tmp/rah",
            createdAt: "2026-04-29T00:00:00.000Z",
          },
        ],
        recentSessions: [],
      }),
      "history",
      {
        modeId: "on-request/read-only",
        modelId: "gpt-5.5",
        reasoningId: "xhigh",
        optionValues: { model_reasoning_effort: "xhigh" },
      },
    );

    const resumeRequest = requests.find((request) =>
      request.url.endsWith("/api/sessions/resume"),
    );
    assert.deepEqual(resumeRequest?.body, {
      provider: "codex",
      providerSessionId: "thread-1",
      liveBackend: "native_local_server",
      model: "gpt-5.5",
      optionValues: { model_reasoning_effort: "xhigh" },
      modeId: "on-request/read-only",
      preferStoredReplay: false,
      historyReplay: "skip",
      historySourceSessionId: "history",
      attach: {
        client: {
          id: "web-client",
          kind: "web",
          connectionId: "web-connection",
        },
        mode: "interactive",
        claimControl: true,
      },
      cwd: "/tmp/rah",
    });

    const redundantModelRequest = requests.find((request) =>
      request.url.endsWith("/api/sessions/claimed/model"),
    );
    assert.equal(redundantModelRequest, undefined);
  });

  test("resume history removes the read-only replay projection for the same provider session", async () => {
    const history = summary({
      id: "history",
      provider: "codex",
      providerSessionId: "thread-1",
      cwd: "/tmp/rah",
      readOnlyReplay: true,
    });
    const projections = new Map([["history", createEmptySessionProjection(history)]]);
    installWebApiMocks((request) => {
      if (request.url.includes("/api/fs/list")) {
        return { path: "/tmp/rah", entries: [] };
      }
      if (request.url.endsWith("/api/sessions/resume")) {
        return {
          session: summary({
            id: "claimed",
            provider: "codex",
            providerSessionId: "thread-1",
            cwd: "/tmp/rah",
          }),
        };
      }
      throw new Error(`Unexpected request ${request.url}`);
    });
    const deps = startupDeps({
      selectedSessionId: "history",
      projections,
      storedSessions: [
        {
          provider: "codex",
          providerSessionId: "thread-1",
          cwd: "/tmp/rah",
          rootDir: "/tmp/rah",
          createdAt: "2026-04-29T00:00:00.000Z",
        },
      ],
      recentSessions: [],
    });

    await resumeHistorySessionCommand(deps, "history");

    const state = (deps as { get: () => {
      projections: Map<string, ReturnType<typeof createEmptySessionProjection>>;
      selectedSessionId: string | null;
    } }).get();
    assert.equal(state.projections.has("history"), false);
    assert.equal(state.projections.has("claimed"), true);
    assert.equal(state.selectedSessionId, "claimed");
  });

  test("resume history reuses the ready canonical turn page without a second history request", async () => {
    const history = summary({
      id: "history",
      provider: "codex",
      providerSessionId: "thread-1",
      cwd: "/tmp/rah",
      readOnlyReplay: true,
    });
    const historyProjection = createEmptySessionProjection(history);
    const preservedTurns = [
      {
        id: "canonical-turn-1",
        provider: "codex" as const,
        providerSessionId: "thread-1",
        providerTurnId: "provider-turn-1",
        status: "completed" as const,
        statusAuthority: "native" as const,
        items: [],
        outputs: [
          {
            id: "output-report",
            kind: "file" as const,
            label: "report.md",
            path: "/tmp/rah/report.md",
            activity: "written" as const,
            confidence: "authoritative" as const,
            sourceItemIds: ["final-report"],
          },
        ],
        fileChanges: {
          files: [{ path: "src/main.ts", additions: 12, deletions: 3 }],
          totalAdditions: 12,
          totalDeletions: 3,
        },
        failedItemCount: 0,
        revision: 7,
      },
    ];
    historyProjection.conversation = {
      ...initialConversationSyncState(),
      phase: "ready",
      loadedScope: "history",
      turns: preservedTurns,
      revision: 7,
      daemonRevision: 7,
      loadedAt: "2026-07-13T00:00:00.000Z",
    };
    let historyRequests = 0;
    installWebApiMocks((request) => {
      if (request.url.includes("/api/fs/list")) {
        return { path: "/tmp/rah", entries: [] };
      }
      if (request.url.endsWith("/api/sessions/resume")) {
        return {
          session: summary({
            id: "claimed",
            provider: "codex",
            providerSessionId: "thread-1",
            cwd: "/tmp/rah",
          }),
        };
      }
      throw new Error(`Unexpected request ${request.url}`);
    });
    const deps = startupDeps(
      {
        projections: new Map([["history", historyProjection]]),
        selectedSessionId: "history",
        storedSessions: [
          {
            provider: "codex",
            providerSessionId: "thread-1",
            cwd: "/tmp/rah",
            rootDir: "/tmp/rah",
          },
        ],
      },
      {
        readTurns: async (): Promise<ConversationTurnsPageResponse> => {
          historyRequests += 1;
          throw new Error("resume must not reload an already-ready history page");
        },
      },
    );

    await resumeHistorySessionCommand(deps, "history");
    assert.equal(await ensureConversationLoadedCommand(deps, "claimed"), true);

    const state = (deps as { get: () => {
      projections: Map<string, ReturnType<typeof createEmptySessionProjection>>;
    } }).get();
    assert.equal(historyRequests, 0);
    assert.equal(state.projections.get("claimed")?.conversation?.turns, preservedTurns);
    const resumedTurn = state.projections.get("claimed")?.conversation?.turns[0];
    assert.equal(resumedTurn?.outputs?.[0]?.path, "/tmp/rah/report.md");
    assert.equal(resumedTurn?.fileChanges?.totalAdditions, 12);
    assert.equal(resumedTurn?.fileChanges?.totalDeletions, 3);
  });

  test("resume immediately reuses the visible history projection and hydrates the claimed session in background", async () => {
    const history = summary({
      id: "history",
      provider: "claude",
      providerSessionId: "claude-thread-1",
      cwd: "/tmp/rah",
    });
    const historyProjection = createEmptySessionProjection(history);
    const visibleTurns = [
      {
        id: "canonical-turn-claude",
        provider: "claude" as const,
        providerSessionId: "claude-thread-1",
        providerTurnId: "provider-turn-claude",
        status: "completed" as const,
        statusAuthority: "native" as const,
        items: [],
        failedItemCount: 0,
        revision: 3,
      },
    ];
    installWebApiMocks((request) => {
      if (request.url.includes("/api/fs/list")) {
        return { path: "/tmp/rah", entries: [] };
      }
      if (request.url.endsWith("/api/sessions/resume")) {
        return {
          session: summary({
            id: "claimed",
            provider: "claude",
            providerSessionId: "claude-thread-1",
            cwd: "/tmp/rah",
          }),
        };
      }
      throw new Error(`Unexpected request ${request.url}`);
    });
    const hydrationCalls: string[] = [];
    let releaseHydration: (() => void) | undefined;
    const hydrationGate = new Promise<void>((resolve) => {
      releaseHydration = resolve;
    });
    const deps = startupDeps(
      {
        projections: new Map([["history", historyProjection]]),
        selectedSessionId: "history",
        storedSessions: [
          {
            provider: "claude",
            providerSessionId: "claude-thread-1",
            cwd: "/tmp/rah",
            rootDir: "/tmp/rah",
          },
        ],
      },
      {
        ensureConversationLoaded: async (sessionId: string) => {
          hydrationCalls.push(sessionId);
          await hydrationGate;
        },
      },
    );

    historyProjection.conversation = {
      ...initialConversationSyncState(),
      phase: "ready",
      loadedScope: "summary",
      turns: visibleTurns,
      revision: 3,
      daemonRevision: 3,
      loadedAt: "2026-07-13T00:00:00.000Z",
    };
    await resumeHistorySessionCommand(deps, "history");

    const state = (deps as {
      get: () => {
        projections: Map<string, ReturnType<typeof createEmptySessionProjection>>;
      };
    }).get();
    assert.equal(state.projections.get("claimed")?.conversation?.turns, visibleTurns);
    assert.deepEqual(hydrationCalls, ["claimed"]);
    assert.equal(state.pendingSessionAction, null);
    releaseHydration?.();
  });

  test("resume history keeps the current history projection visible while resume is pending", async () => {
    const history = summary({
      id: "history",
      provider: "codex",
      providerSessionId: "thread-1",
      cwd: "/tmp/rah",
    });
    const projections = new Map([["history", createEmptySessionProjection(history)]]);
    const deps = startupDeps({
      projections,
      selectedSessionId: "history",
      storedSessions: [
        {
          provider: "codex",
          providerSessionId: "thread-1",
          cwd: "/tmp/rah",
          rootDir: "/tmp/rah",
          createdAt: "2026-04-29T00:00:00.000Z",
        },
      ],
      recentSessions: [],
    });
    installWebApiMocks((request) => {
      if (request.url.includes("/api/fs/list")) {
        return { path: "/tmp/rah", entries: [] };
      }
      if (request.url.endsWith("/api/sessions/resume")) {
        const state = (deps as {
          get: () => {
            selectedSessionId: string | null;
            pendingSessionAction: unknown;
            pendingSessionTransition: unknown;
            projections: Map<string, unknown>;
          };
        }).get();
        assert.equal(state.selectedSessionId, "history");
        assert.equal(state.projections.has("history"), true);
        assert.deepEqual(state.pendingSessionAction, {
          kind: "resume_history",
          sessionId: "history",
          provider: "codex",
          providerSessionId: "thread-1",
        });
        assert.equal(state.pendingSessionTransition, null);
        return {
          session: summary({
            id: "claimed",
            provider: "codex",
            providerSessionId: "thread-1",
            cwd: "/tmp/rah",
          }),
        };
      }
      throw new Error(`Unexpected request ${request.url}`);
    });

    await resumeHistorySessionCommand(deps, "history");
  });

  test("history send shows the user message and Starting state before Resume resolves", async () => {
    const history = summary({
      id: "history-immediate",
      provider: "codex",
      providerSessionId: "thread-immediate",
      cwd: "/tmp/rah",
      readOnlyReplay: true,
    });
    let releaseResume!: () => void;
    const resumeGate = new Promise<void>((resolve) => {
      releaseResume = resolve;
    });
    const sent: Array<{
      sessionId: string;
      text: string;
      skipOptimisticQueue?: boolean;
    }> = [];
    const deps = startupDeps(
      {
        projections: new Map([
          ["history-immediate", createEmptySessionProjection(history)],
        ]),
        selectedSessionId: "history-immediate",
        storedSessions: [
          {
            provider: "codex",
            providerSessionId: "thread-immediate",
            cwd: "/tmp/rah",
            rootDir: "/tmp/rah",
            createdAt: "2026-04-29T00:00:00.000Z",
          },
        ],
        recentSessions: [],
      },
      {
        sendInput: async (
          sessionId: string,
          text: string,
          _attachments: unknown,
          identity: { skipOptimisticQueue?: boolean } | undefined,
        ) => {
          sent.push({
            sessionId,
            text,
            ...(identity?.skipOptimisticQueue === true
              ? { skipOptimisticQueue: true }
              : {}),
          });
        },
      },
    );
    let resumeBody: Record<string, unknown> | null = null;
    installWebApiMocks(async (request) => {
      if (request.url.includes("/api/fs/list")) {
        return { path: "/tmp/rah", entries: [] };
      }
      if (request.url.endsWith("/api/sessions/resume")) {
        resumeBody = request.body as Record<string, unknown>;
        await resumeGate;
        return {
          session: summary({
            id: "claimed-immediate",
            provider: "codex",
            providerSessionId: "thread-immediate",
            cwd: "/tmp/rah",
          }),
        };
      }
      throw new Error(`Unexpected request ${request.url}`);
    });

    const resuming = resumeHistorySessionCommand(deps, "history-immediate", {
      initialInput: "continue immediately",
    });
    const startupProjection = deps.get().projections.get("history-immediate");
    assert.equal(startupProjection?.summary.session.phase, "starting");
    assert.equal(startupProjection?.summary.session.status, "running");
    assert.equal(startupProjection?.summary.session.capabilities.steerInput, true);
    assert.equal(startupProjection?.feed.length, 1);
    if (startupProjection?.feed[0]?.kind === "timeline") {
      assert.equal(startupProjection.feed[0].item.kind, "user_message");
    }
    assert.deepEqual(sent, []);

    releaseResume();
    assert.equal(await resuming, "claimed-immediate");
    assert.deepEqual(sent, []);
    assert.equal(
      (resumeBody?.initialInput as Record<string, unknown>).text,
      "continue immediately",
    );
  });

  test("history resume completion does not steal selection after the user opens another session", async () => {
    const history = summary({
      id: "history-background-resume",
      provider: "codex",
      providerSessionId: "thread-background-resume",
      cwd: "/tmp/rah",
      readOnlyReplay: true,
    });
    const other = summary({
      id: "other-session",
      provider: "codex",
      providerSessionId: "thread-other",
      cwd: "/tmp/rah",
    });
    let releaseResume!: () => void;
    const resumeGate = new Promise<void>((resolve) => {
      releaseResume = resolve;
    });
    const sent: Array<{ sessionId: string; text: string }> = [];
    const deps = startupDeps(
      {
        projections: new Map([
          ["history-background-resume", createEmptySessionProjection(history)],
          ["other-session", createEmptySessionProjection(other)],
        ]),
        selectedSessionId: "history-background-resume",
        storedSessions: [
          {
            provider: "codex",
            providerSessionId: "thread-background-resume",
            cwd: "/tmp/rah",
            rootDir: "/tmp/rah",
            createdAt: "2026-04-29T00:00:00.000Z",
          },
        ],
        recentSessions: [],
      },
      {
        sendInput: async (sessionId: string, text: string) => {
          sent.push({ sessionId, text });
        },
      },
    );
    let resumeBody: Record<string, unknown> | null = null;
    installWebApiMocks(async (request) => {
      if (request.url.includes("/api/fs/list")) {
        return { path: "/tmp/rah", entries: [] };
      }
      if (request.url.endsWith("/api/sessions/resume")) {
        resumeBody = request.body as Record<string, unknown>;
        await resumeGate;
        return {
          session: summary({
            id: "claimed-background-resume",
            provider: "codex",
            providerSessionId: "thread-background-resume",
            cwd: "/tmp/rah",
          }),
        };
      }
      throw new Error(`Unexpected request ${request.url}`);
    });

    const resuming = resumeHistorySessionCommand(deps, "history-background-resume", {
      initialInput: "continue A in the background",
    });
    deps.set({ selectedSessionId: "other-session" });
    releaseResume();

    assert.equal(await resuming, "claimed-background-resume");
    assert.equal(deps.get().selectedSessionId, "other-session");
    assert.equal(deps.get().projections.has("history-background-resume"), false);
    assert.equal(deps.get().projections.has("claimed-background-resume"), true);
    assert.deepEqual(sent, []);
    assert.equal(
      (resumeBody?.initialInput as Record<string, unknown>).text,
      "continue A in the background",
    );
  });

  test("history resume failure restores A without stealing a newer selection of B", async () => {
    const history = summary({
      id: "history-background-failure",
      provider: "codex",
      providerSessionId: "thread-background-failure",
      cwd: "/tmp/rah",
      readOnlyReplay: true,
    });
    const other = summary({
      id: "other-background-failure",
      provider: "codex",
      providerSessionId: "thread-other-background-failure",
      cwd: "/tmp/rah",
    });
    const historyProjection = createEmptySessionProjection(history);
    let releaseResume!: () => void;
    const resumeGate = new Promise<void>((resolve) => {
      releaseResume = resolve;
    });
    const deps = startupDeps({
      projections: new Map([
        ["history-background-failure", historyProjection],
        ["other-background-failure", createEmptySessionProjection(other)],
      ]),
      selectedSessionId: "history-background-failure",
      storedSessions: [
        {
          provider: "codex",
          providerSessionId: "thread-background-failure",
          cwd: "/tmp/rah",
          rootDir: "/tmp/rah",
          createdAt: "2026-04-29T00:00:00.000Z",
        },
      ],
      recentSessions: [],
    });
    installWebApiMocks(async (request) => {
      if (request.url.includes("/api/fs/list")) {
        return { path: "/tmp/rah", entries: [] };
      }
      if (request.url.endsWith("/api/sessions/resume")) {
        await resumeGate;
        return new Response(JSON.stringify({ error: "resume failed" }), {
          status: 500,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`Unexpected request ${request.url}`);
    });

    const resuming = resumeHistorySessionCommand(deps, "history-background-failure", {
      initialInput: "continue A even if startup fails",
    });
    deps.set({ selectedSessionId: "other-background-failure" });
    releaseResume();

    await assert.rejects(resuming, /resume failed/);
    assert.equal(deps.get().selectedSessionId, "other-background-failure");
    assert.equal(
      deps.get().projections.get("history-background-failure"),
      historyProjection,
    );
  });

  test("post-resume control refresh does not steal a newer session selection", async () => {
    const history = summary({
      id: "history-control-refresh",
      provider: "codex",
      providerSessionId: "thread-control-refresh",
      cwd: "/tmp/rah",
      readOnlyReplay: true,
    });
    const other = summary({
      id: "other-control-session",
      provider: "codex",
      providerSessionId: "thread-other-control",
      cwd: "/tmp/rah",
    });
    let releaseModelRefresh!: () => void;
    let markModelRefreshStarted!: () => void;
    const modelRefreshGate = new Promise<void>((resolve) => {
      releaseModelRefresh = resolve;
    });
    const modelRefreshStarted = new Promise<void>((resolve) => {
      markModelRefreshStarted = resolve;
    });
    const deps = startupDeps({
      projections: new Map([
        ["history-control-refresh", createEmptySessionProjection(history)],
        ["other-control-session", createEmptySessionProjection(other)],
      ]),
      selectedSessionId: "history-control-refresh",
      storedSessions: [
        {
          provider: "codex",
          providerSessionId: "thread-control-refresh",
          cwd: "/tmp/rah",
          rootDir: "/tmp/rah",
          createdAt: "2026-04-29T00:00:00.000Z",
        },
      ],
      recentSessions: [],
    });
    installWebApiMocks(async (request) => {
      if (request.url.includes("/api/fs/list")) {
        return { path: "/tmp/rah", entries: [] };
      }
      if (request.url.endsWith("/api/sessions/resume")) {
        return {
          session: summary({
            id: "claimed-control-refresh",
            provider: "codex",
            providerSessionId: "thread-control-refresh",
            cwd: "/tmp/rah",
            modelId: "gpt-old",
          }),
        };
      }
      if (request.url.endsWith("/api/sessions/claimed-control-refresh/model")) {
        markModelRefreshStarted();
        await modelRefreshGate;
        return {
          session: summary({
            id: "claimed-control-refresh",
            provider: "codex",
            providerSessionId: "thread-control-refresh",
            cwd: "/tmp/rah",
            modelId: "gpt-new",
          }),
        };
      }
      throw new Error(`Unexpected request ${request.url}`);
    });

    const resuming = resumeHistorySessionCommand(deps, "history-control-refresh", {
      modelId: "gpt-new",
    });
    await modelRefreshStarted;
    assert.equal(deps.get().selectedSessionId, "claimed-control-refresh");
    deps.set({ selectedSessionId: "other-control-session" });
    releaseModelRefresh();

    assert.equal(await resuming, "claimed-control-refresh");
    assert.equal(deps.get().selectedSessionId, "other-control-session");
  });

  test("atomic history resume failure restores the original replay and removes Starting state", async () => {
    const history = summary({
      id: "history-send-failure",
      provider: "codex",
      providerSessionId: "thread-send-failure",
      cwd: "/tmp/rah",
      readOnlyReplay: true,
    });
    const deps = startupDeps(
      {
        projections: new Map([
          ["history-send-failure", createEmptySessionProjection(history)],
        ]),
        selectedSessionId: "history-send-failure",
        storedSessions: [
          {
            provider: "codex",
            providerSessionId: "thread-send-failure",
            cwd: "/tmp/rah",
            rootDir: "/tmp/rah",
            createdAt: "2026-04-29T00:00:00.000Z",
          },
        ],
        recentSessions: [],
      },
      {},
    );
    installWebApiMocks((request) => {
      if (request.url.includes("/api/fs/list")) {
        return { path: "/tmp/rah", entries: [] };
      }
      if (request.url.endsWith("/api/sessions/resume")) {
        throw new Error("resume+input failed");
      }
      throw new Error(`Unexpected request ${request.url}`);
    });

    await assert.rejects(
      resumeHistorySessionCommand(deps, "history-send-failure", {
        initialInput: "do not leave this behind",
      }),
      /resume\+input failed/,
    );

    const projection = deps.get().projections.get("history-send-failure");
    assert.ok(projection);
    assert.equal(projection.feed.length, 0);
    assert.equal(projection.currentRuntimeStatus, undefined);
  });

  test("concurrent history activation shares one resume operation across surfaces", async () => {
    const history = summary({
      id: "history",
      provider: "codex",
      providerSessionId: "thread-1",
      cwd: "/tmp/rah",
    });
    const projections = new Map([["history", createEmptySessionProjection(history)]]);
    let releaseResume: (() => void) | undefined;
    const resumeGate = new Promise<void>((resolve) => {
      releaseResume = resolve;
    });
    let resumeRequests = 0;
    installWebApiMocks(async (request) => {
      if (request.url.includes("/api/fs/list")) {
        return { path: "/tmp/rah", entries: [] };
      }
      if (request.url.endsWith("/api/sessions/resume")) {
        resumeRequests += 1;
        await resumeGate;
        return {
          session: summary({
            id: "claimed",
            provider: "codex",
            providerSessionId: "thread-1",
            cwd: "/tmp/rah",
          }),
        };
      }
      throw new Error(`Unexpected request ${request.url}`);
    });
    const deps = startupDeps({
      selectedSessionId: "history",
      projections,
      storedSessions: [
        {
          provider: "codex",
          providerSessionId: "thread-1",
          cwd: "/tmp/rah",
          rootDir: "/tmp/rah",
          createdAt: "2026-04-29T00:00:00.000Z",
        },
      ],
      recentSessions: [],
    });

    const mainSurfaceResume = resumeHistorySessionCommand(deps, "history");
    const canvasSurfaceResume = resumeHistorySessionCommand(deps, "history");

    assert.equal(mainSurfaceResume, canvasSurfaceResume);
    releaseResume?.();
    assert.deepEqual(
      await Promise.all([mainSurfaceResume, canvasSurfaceResume]),
      ["claimed", "claimed"],
    );
    assert.equal(resumeRequests, 1);
  });

  test("a send that joins an in-flight history activation is preserved and delivered", async () => {
    const history = summary({
      id: "history-join-send",
      provider: "codex",
      providerSessionId: "thread-join-send",
      cwd: "/tmp/rah",
      readOnlyReplay: true,
    });
    let releaseResume!: () => void;
    const resumeGate = new Promise<void>((resolve) => {
      releaseResume = resolve;
    });
    let resumeRequests = 0;
    const sent: Array<{ sessionId: string; text: string; skipOptimisticQueue?: boolean }> = [];
    const deps = startupDeps(
      {
        selectedSessionId: "history-join-send",
        projections: new Map([
          ["history-join-send", createEmptySessionProjection(history)],
        ]),
        storedSessions: [
          {
            provider: "codex",
            providerSessionId: "thread-join-send",
            cwd: "/tmp/rah",
            rootDir: "/tmp/rah",
          },
        ],
      },
      {
        sendInput: async (
          sessionId: string,
          text: string,
          _attachments: unknown,
          identity: { skipOptimisticQueue?: boolean } | undefined,
        ) => {
          sent.push({
            sessionId,
            text,
            ...(identity?.skipOptimisticQueue ? { skipOptimisticQueue: true } : {}),
          });
        },
      },
    );
    installWebApiMocks(async (request) => {
      if (request.url.includes("/api/fs/list")) {
        return { path: "/tmp/rah", entries: [] };
      }
      if (request.url.endsWith("/api/sessions/resume")) {
        resumeRequests += 1;
        await resumeGate;
        return {
          session: summary({
            id: "claimed-join-send",
            provider: "codex",
            providerSessionId: "thread-join-send",
            cwd: "/tmp/rah",
          }),
        };
      }
      throw new Error(`Unexpected request ${request.url}`);
    });

    const activation = resumeHistorySessionCommand(deps, "history-join-send");
    const send = resumeHistorySessionCommand(deps, "history-join-send", {
      initialInput: "do not lose this question",
    });
    const staged = deps.get().projections.get("history-join-send");
    assert.equal(staged?.summary.session.phase, "starting");
    assert.equal(staged?.feed.length, 1);

    releaseResume();
    assert.deepEqual(await Promise.all([activation, send]), [
      "claimed-join-send",
      "claimed-join-send",
    ]);
    assert.equal(resumeRequests, 1);
    assert.deepEqual(sent, [
      {
        sessionId: "claimed-join-send",
        text: "do not lose this question",
        skipOptimisticQueue: true,
      },
    ]);
  });

  test("a second send during an input-carrying resume is queued after the atomic first input", async () => {
    const history = summary({
      id: "history-two-sends",
      provider: "codex",
      providerSessionId: "thread-two-sends",
      cwd: "/tmp/rah",
      readOnlyReplay: true,
    });
    let releaseResume!: () => void;
    const resumeGate = new Promise<void>((resolve) => {
      releaseResume = resolve;
    });
    const resumeBodies: Array<Record<string, unknown>> = [];
    const sent: Array<{ sessionId: string; text: string }> = [];
    const deps = startupDeps(
      {
        selectedSessionId: "history-two-sends",
        projections: new Map([
          ["history-two-sends", createEmptySessionProjection(history)],
        ]),
        storedSessions: [
          {
            provider: "codex",
            providerSessionId: "thread-two-sends",
            cwd: "/tmp/rah",
            rootDir: "/tmp/rah",
          },
        ],
      },
      {
        sendInput: async (sessionId: string, text: string) => {
          sent.push({ sessionId, text });
        },
      },
    );
    installWebApiMocks(async (request) => {
      if (request.url.includes("/api/fs/list")) {
        return { path: "/tmp/rah", entries: [] };
      }
      if (request.url.endsWith("/api/sessions/resume")) {
        resumeBodies.push(request.body as Record<string, unknown>);
        await resumeGate;
        return {
          session: summary({
            id: "claimed-two-sends",
            provider: "codex",
            providerSessionId: "thread-two-sends",
            cwd: "/tmp/rah",
          }),
        };
      }
      throw new Error(`Unexpected request ${request.url}`);
    });

    const first = resumeHistorySessionCommand(deps, "history-two-sends", {
      initialInput: "first atomic question",
    });
    const second = resumeHistorySessionCommand(deps, "history-two-sends", {
      initialInput: "second queued question",
    });

    releaseResume();
    assert.deepEqual(await Promise.all([first, second]), [
      "claimed-two-sends",
      "claimed-two-sends",
    ]);
    assert.equal(resumeBodies.length, 1);
    assert.equal(
      (resumeBodies[0]?.initialInput as { text?: string } | undefined)?.text,
      "first atomic question",
    );
    assert.deepEqual(sent, [
      { sessionId: "claimed-two-sends", text: "second queued question" },
    ]);
  });

  test("resume history keeps the resumed session when post-resume control update fails", async () => {
    const history = summary({
      id: "history",
      provider: "codex",
      providerSessionId: "thread-1",
      cwd: "/tmp/rah",
    });
    const projections = new Map([["history", createEmptySessionProjection(history)]]);
    installWebApiMocks((request) => {
      if (request.url.includes("/api/fs/list")) {
        return { path: "/tmp/rah", entries: [] };
      }
      if (request.url.endsWith("/api/sessions/resume")) {
        return {
          session: summary({
            id: "claimed",
            provider: "codex",
            providerSessionId: "thread-1",
            cwd: "/tmp/rah",
            modelId: "gpt-5.5",
            reasoningId: "low",
          }),
        };
      }
      if (request.url.endsWith("/api/sessions/claimed/model")) {
        return new Response(JSON.stringify({ error: "model update failed" }), {
          status: 500,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`Unexpected request ${request.url}`);
    });
    const deps = startupDeps({
      selectedSessionId: "history",
      projections,
      storedSessions: [
        {
          provider: "codex",
          providerSessionId: "thread-1",
          cwd: "/tmp/rah",
          rootDir: "/tmp/rah",
          createdAt: "2026-04-29T00:00:00.000Z",
        },
      ],
      recentSessions: [],
    });

    const resumedId = await resumeHistorySessionCommand(
      deps,
      "history",
      {
        modelId: "gpt-5.5",
        reasoningId: "xhigh",
        optionValues: { model_reasoning_effort: "xhigh" },
      },
    );
    const state = (deps as { get: () => { projections: Map<string, unknown>; selectedSessionId: string | null; error: string | null } }).get();

    assert.equal(resumedId, "claimed");
    assert.equal(state.selectedSessionId, "claimed");
    assert.equal(state.projections.has("claimed"), true);
    assert.equal(state.projections.has("history"), false);
    assert.match(state.error ?? "", /Session was resumed/);
  });

  test("resume history selects native local-server backend for providers that support it", async () => {
    const requests = installWebApiMocks((request) => {
      if (request.url.includes("/api/fs/list")) {
        return { path: "/tmp/rah", entries: [] };
      }
      if (request.url.endsWith("/api/sessions/resume")) {
        const body = request.body as {
          provider: "codex" | "claude" | "opencode";
          providerSessionId: string;
          cwd?: string;
        };
        return {
          session: summary({
            id: `claimed-${body.provider}`,
            provider: body.provider,
            providerSessionId: body.providerSessionId,
            cwd: body.cwd,
          }),
        };
      }
      throw new Error(`Unexpected request ${request.url}`);
    });

    for (const provider of ["codex", "claude", "opencode"] as const) {
      const history = summary({
        id: `history-${provider}`,
        provider,
        providerSessionId: `provider-${provider}`,
        cwd: "/tmp/rah",
      });
      const projections = new Map([[history.session.id, createEmptySessionProjection(history)]]);
      await resumeHistorySessionCommand(
        startupDeps({
          projections,
          storedSessions: [
            {
              provider,
              providerSessionId: `provider-${provider}`,
              cwd: "/tmp/rah",
              rootDir: "/tmp/rah",
              createdAt: "2026-04-29T00:00:00.000Z",
            },
          ],
          recentSessions: [],
        }),
        history.session.id,
      );
    }

    const resumeRequests = requests.filter((request) =>
      request.url.endsWith("/api/sessions/resume"),
    );
    assert.deepEqual(
      resumeRequests.map((request) => {
        const body = request.body as { provider: string; liveBackend?: string };
        return [body.provider, body.liveBackend ?? null];
      }),
      [
        ["codex", "native_local_server"],
        ["claude", "tui_mux"],
        ["opencode", "native_local_server"],
      ],
    );
  });

  test("activating stored history opens read-only replay instead of resuming native live", async () => {
    type ResumeStoredOptions = {
      preferStoredReplay?: boolean;
      historyReplay?: "include" | "skip";
      confirmCreateMissingWorkspace?: (dir: string) => Promise<boolean>;
    };
    const ref: StoredSessionRef = {
      provider: "codex",
      providerSessionId: "thread-1",
      cwd: "/tmp/missing-history-workspace",
      rootDir: "/tmp/missing-history-workspace",
      createdAt: "2026-04-29T00:00:00.000Z",
    };
    const confirmCreateMissingWorkspace = async () => {
      throw new Error("history browsing must not ask to create missing workspaces");
    };
    let resumed: {
      ref: StoredSessionRef;
      options?: ResumeStoredOptions;
    } | null = null;
    let attached = false;

    await activateHistorySessionCommand(
      startupDeps(
        {
          storedSessions: [ref],
          recentSessions: [],
        },
        {
          attachSession: async () => {
            attached = true;
          },
          resumeStoredSession: async (nextRef: StoredSessionRef, options: ResumeStoredOptions) => {
            resumed = { ref: nextRef, options };
          },
        },
      ),
      ref,
      { confirmCreateMissingWorkspace },
    );

    assert.equal(attached, false);
    assert.equal(resumed?.ref, ref);
    assert.equal(resumed?.options?.preferStoredReplay, true);
    assert.equal(
      resumed?.options?.confirmCreateMissingWorkspace,
      confirmCreateMissingWorkspace,
    );
  });

  test("activating stored history attaches an existing running session instead of resuming", async () => {
    const live = summary({
      id: "live-existing",
      provider: "opencode",
      providerSessionId: "provider-existing",
      cwd: "/tmp/rah",
    });
    const projections = new Map([["live-existing", createEmptySessionProjection(live)]]);
    const ref: StoredSessionRef = {
      provider: "opencode",
      providerSessionId: "provider-existing",
      cwd: "/tmp/rah",
      rootDir: "/tmp/rah",
      createdAt: "2026-04-29T00:00:00.000Z",
    };
    let attachedSessionId: string | null = null;
    let resumed = false;

    await activateHistorySessionCommand(
      startupDeps(
        {
          projections,
          storedSessions: [ref],
          recentSessions: [],
        },
        {
          attachSession: async (summary: SessionSummary) => {
            attachedSessionId = summary.session.id;
          },
          resumeStoredSession: async () => {
            resumed = true;
          },
        },
      ),
      ref,
    );

    assert.equal(attachedSessionId, "live-existing");
    assert.equal(resumed, false);
  });

  test("resume history asks to create a missing stored workspace before launching", async () => {
    const history = summary({
      id: "history",
      provider: "opencode",
      providerSessionId: "ses-old",
      cwd: "/tmp/missing-old",
    });
    const projections = new Map([["history", createEmptySessionProjection(history)]]);
    const requests = installWebApiMocks((request) => {
      if (request.url.includes("/api/fs/list")) {
        throw new Error("ENOENT");
      }
      if (request.url.endsWith("/api/fs/ensure-dir")) {
        return { path: (request.body as { dir: string }).dir };
      }
      if (request.url.endsWith("/api/sessions/resume")) {
        const body = request.body as {
          provider: "opencode";
          providerSessionId: string;
          cwd?: string;
        };
        return {
          session: summary({
            id: "claimed",
            provider: body.provider,
            providerSessionId: body.providerSessionId,
            cwd: body.cwd,
          }),
        };
      }
      throw new Error(`Unexpected request ${request.url}`);
    });

    await resumeHistorySessionCommand(
      startupDeps(
        {
          projections,
          workspaceDir: "/tmp/current",
          storedSessions: [
            {
              provider: "opencode",
              providerSessionId: "ses-old",
              cwd: "/tmp/missing-old",
              rootDir: "/tmp/missing-old",
              createdAt: "2026-04-29T00:00:00.000Z",
            },
          ],
          recentSessions: [],
        },
        {
          confirmCreateMissingWorkspace: async (dir: string) => dir === "/tmp/missing-old",
        },
      ),
      "history",
    );

    const paths = requests
      .filter((request) => request.url.includes("/api/fs/list"))
      .map((request) => new URL(request.url).searchParams.get("path"));
    assert.deepEqual(paths, ["/tmp/missing-old"]);
    assert.equal(
      requests.some((request) => request.url.endsWith("/api/fs/ensure-dir")),
      true,
    );
    const resumeRequest = requests.find((request) =>
      request.url.endsWith("/api/sessions/resume"),
    );
    assert.deepEqual((resumeRequest?.body as { cwd?: string }).cwd, "/tmp/missing-old");
  });

  test("new session asks to create a missing workspace before launching", async () => {
    const requests = installWebApiMocks((request) => {
      if (request.url.includes("/api/fs/list")) {
        throw new Error("ENOENT");
      }
      if (request.url.endsWith("/api/fs/ensure-dir")) {
        return { path: (request.body as { dir: string }).dir };
      }
      if (request.url.endsWith("/api/sessions/start")) {
        const body = request.body as { provider: "codex"; cwd: string };
        return {
          session: summary({
            id: "started",
            provider: body.provider,
            cwd: body.cwd,
          }),
        };
      }
      throw new Error(`Unexpected request ${request.url}`);
    });

    await startSessionCommand(
      startupDeps({
        workspaceDir: "/tmp/missing",
      }),
      {
        provider: "codex",
        cwd: "/tmp/missing",
        title: "test",
        initialInput: "",
      },
    );

    assert.deepEqual(
      requests.map((request) => request.url.replace(/^http:\/\/127\.0\.0\.1:43111/, "")),
      [
        "/api/fs/list?path=%2Ftmp%2Fmissing",
        "/api/fs/ensure-dir",
        "/api/sessions/start",
      ],
    );
  });

  test("history replay opens without creating a missing workspace", async () => {
    const requests = installWebApiMocks((request) => {
      if (request.url.endsWith("/api/sessions/resume")) {
        const body = request.body as {
          provider: "codex";
          providerSessionId: string;
          cwd?: string;
          liveBackend?: string;
          preferStoredReplay?: boolean;
          attach?: {
            mode?: string;
          };
        };
        return {
          session: summary({
            id: "resumed",
            provider: body.provider,
            providerSessionId: body.providerSessionId,
            cwd: body.cwd,
          }),
        };
      }
      throw new Error(`Unexpected request ${request.url}`);
    });

    await resumeStoredSessionCommand(
      startupDeps(),
      {
        provider: "codex",
        providerSessionId: "thread-1",
        cwd: "/tmp/missing",
        rootDir: "/tmp/missing",
        createdAt: "2026-04-29T00:00:00.000Z",
      },
      { preferStoredReplay: true },
    );

    assert.deepEqual(
      requests.map((request) => request.url.replace(/^http:\/\/127\.0\.0\.1:43111/, "")),
      ["/api/sessions/resume"],
    );
    assert.deepEqual(requests[0]?.body, {
      provider: "codex",
      providerSessionId: "thread-1",
      preferStoredReplay: true,
      attach: {
        client: {
          id: "web-client",
          kind: "web",
          connectionId: "web-connection",
        },
        mode: "observe",
      },
      cwd: "/tmp/missing",
    });
    assert.equal((requests[0]?.body as { liveBackend?: string }).liveBackend, undefined);
  });

  test("history replay does not show the session opening transition", async () => {
    installWebApiMocks((request) => {
      if (request.url.endsWith("/api/sessions/resume")) {
        const body = request.body as {
          provider: "codex";
          providerSessionId: string;
          cwd?: string;
        };
        return {
          session: summary({
            id: "resumed",
            provider: body.provider,
            providerSessionId: body.providerSessionId,
            cwd: body.cwd,
            readOnlyReplay: true,
          }),
        };
      }
      throw new Error(`Unexpected request ${request.url}`);
    });
    const deps = startupDeps();
    const typedDeps = deps as unknown as {
      get: () => { pendingSessionTransition: unknown };
      set: (partial: unknown) => void;
    };
    const set = typedDeps.set;
    const transitions: unknown[] = [];
    typedDeps.set = (partial: unknown) => {
      set(partial);
      transitions.push(typedDeps.get().pendingSessionTransition);
    };

    await resumeStoredSessionCommand(
      deps,
      {
        provider: "codex",
        providerSessionId: "thread-1",
        cwd: "/tmp/missing",
        rootDir: "/tmp/missing",
        createdAt: "2026-04-29T00:00:00.000Z",
      },
      { preferStoredReplay: true },
    );

    assert.equal(
      transitions.some((transition) => transition !== null),
      false,
    );
  });

  test("history replay selects a provisional session before history is read", async () => {
    const ref: StoredSessionRef = {
      provider: "codex",
      providerSessionId: "thread-1",
      cwd: "/tmp/large-history",
      rootDir: "/tmp/large-history",
      title: "Large history",
      preview: "tail preview",
      createdAt: "2026-04-29T00:00:00.000Z",
      updatedAt: "2026-04-30T00:00:00.000Z",
    };
    const deps = startupDeps();
    const provisionalId = storedReplayPlaceholderSessionId(ref);
    let provisionalAtResumeRequest:
      | {
          selectedSessionId: string | null;
          phase: string | undefined;
          title: string | undefined;
        }
      | null = null;
    installWebApiMocks((request) => {
      if (request.url.endsWith("/api/sessions/resume")) {
        const state = (deps as {
          get: () => {
            selectedSessionId: string | null;
            projections: Map<string, ReturnType<typeof createEmptySessionProjection>>;
          };
        }).get();
        const projection = state.projections.get(provisionalId);
        provisionalAtResumeRequest = {
          selectedSessionId: state.selectedSessionId,
          phase: projection?.conversation?.phase,
          title: projection?.summary.session.title,
        };
        return {
          session: summary({
            id: "resumed",
            provider: "codex",
            providerSessionId: "thread-1",
            cwd: "/tmp/large-history",
            readOnlyReplay: true,
          }),
        };
      }
      throw new Error(`Unexpected request ${request.url}`);
    });

    await resumeStoredSessionCommand(deps, ref, { preferStoredReplay: true });

    assert.deepEqual(provisionalAtResumeRequest, {
      selectedSessionId: provisionalId,
      phase: "loading",
      title: "Large history",
    });
    const state = (deps as {
      get: () => {
        selectedSessionId: string | null;
        projections: Map<string, ReturnType<typeof createEmptySessionProjection>>;
      };
    }).get();
    assert.equal(state.projections.has(provisionalId), false);
    assert.equal(state.selectedSessionId, "resumed");
  });

  test("Canvas history recovery keeps a stale provider error local to its pane", async () => {
    const ref: StoredSessionRef = {
      provider: "codex",
      providerSessionId: "missing-canvas-thread",
      cwd: "/tmp/rah",
      rootDir: "/tmp/rah",
      createdAt: "2026-04-29T00:00:00.000Z",
    };
    const deps = startupDeps();
    installWebApiMocks((request) => {
      if (request.url.endsWith("/api/sessions/resume")) {
        return new Response(JSON.stringify({ error: "Unknown Codex session" }), {
          status: 404,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`Unexpected request ${request.url}`);
    });

    await assert.rejects(
      resumeStoredSessionCommand(deps, ref, {
        preferStoredReplay: true,
        suppressGlobalError: true,
      }),
      /Unknown Codex session/,
    );
    assert.equal(deps.get().error, null);
    assert.equal(
      deps.get().projections.get(storedReplayPlaceholderSessionId(ref))?.conversation?.lastError,
      "Unknown Codex session",
    );
  });

  test("resuming history takes control when the provider session is already running", async () => {
    const historySummary = summary({
      id: "history",
      provider: "codex",
      providerSessionId: "thread-running",
      cwd: "/tmp/rah",
    });
    const runningSummary = summary({
      id: "live",
      provider: "codex",
      providerSessionId: "thread-running",
      cwd: "/tmp/rah",
    });
    const attachedSummary: SessionSummary = {
      ...runningSummary,
      attachedClients: [
        {
          id: "web-client",
          kind: "web",
          sessionId: "live",
          connectionId: "web-connection",
          attachMode: "interactive",
          focus: true,
          lastSeenAt: "2026-04-29T00:00:00.000Z",
        },
      ],
      controlLease: {
        sessionId: "live",
        holderClientId: "web-client",
        holderKind: "web",
        grantedAt: "2026-04-29T00:00:00.000Z",
      },
    };
    const projection = createEmptySessionProjection(historySummary);
    const requests = installWebApiMocks((request) => {
      if (request.url.includes("/api/fs/list")) {
        return { path: "/tmp/rah", entries: [] };
      }
      if (request.url.endsWith("/api/sessions/resume")) {
        return new Response(
          JSON.stringify({
            error:
              "Provider session codex:thread-running is already running; attach instead of resume.",
          }),
          { status: 500, headers: { "content-type": "application/json" } },
        );
      }
      if (request.url.endsWith("/api/sessions?storedSessions=recent")) {
        return {
          sessions: [runningSummary],
          storedSessions: [],
          recentSessions: [],
          workspaceDirs: ["/tmp/rah"],
          hiddenWorkspaceDirs: [],
        };
      }
      if (request.url.endsWith("/api/sessions/live/attach")) {
        return { session: attachedSummary };
      }
      throw new Error(`Unexpected request ${request.url}`);
    });
    const deps = startupDeps(
      {
        selectedSessionId: "history",
        projections: new Map([["history", projection]]),
        recentSessions: [
          {
            provider: "codex",
            providerSessionId: "thread-running",
            cwd: "/tmp/rah",
            rootDir: "/tmp/rah",
            createdAt: "2026-04-29T00:00:00.000Z",
          },
        ],
      },
    );

    await resumeHistorySessionCommand(
      deps,
      "history",
    );

    assert.deepEqual(
      requests.map((request) => request.url.replace(/^http:\/\/127\.0\.0\.1:43111/, "")),
      [
        "/api/fs/list?path=%2Ftmp%2Frah",
        "/api/sessions/resume",
        "/api/sessions?storedSessions=recent",
        "/api/sessions/live/attach",
      ],
    );
    const attachRequest = requests.find((request) =>
      request.url.endsWith("/api/sessions/live/attach"),
    );
    assert.deepEqual(attachRequest?.body, {
      client: {
        id: "web-client",
        kind: "web",
        connectionId: "web-connection",
      },
      mode: "interactive",
      claimControl: true,
    });
    const state = (deps as { get: () => {
      projections: Map<string, ReturnType<typeof createEmptySessionProjection>>;
      selectedSessionId: string | null;
    } }).get();
    assert.equal(state.selectedSessionId, "live");
    assert.equal(state.projections.has("history"), false);
    assert.equal(state.projections.get("live")?.summary.controlLease.holderClientId, "web-client");
  });

  test("resuming history uses an existing live projection without calling provider resume", async () => {
    const historySummary = summary({
      id: "history",
      provider: "codex",
      providerSessionId: "thread-running",
      cwd: "/tmp/rah",
      readOnlyReplay: true,
    });
    const liveSummary = summary({
      id: "live",
      provider: "codex",
      providerSessionId: "thread-running",
      cwd: "/tmp/rah",
    });
    const attachedSummary: SessionSummary = {
      ...liveSummary,
      attachedClients: [
        {
          id: "web-client",
          kind: "web",
          sessionId: "live",
          connectionId: "web-connection",
          attachMode: "interactive",
          focus: true,
          lastSeenAt: "2026-04-29T00:00:00.000Z",
        },
      ],
      controlLease: {
        sessionId: "live",
        holderClientId: "web-client",
        holderKind: "web",
        grantedAt: "2026-04-29T00:00:00.000Z",
      },
    };
    const historyProjection = createEmptySessionProjection(historySummary);
    const preservedConversation = {
      ...initialConversationSyncState(),
      phase: "ready" as const,
      loadedScope: "history" as const,
      revision: 7,
    };
    historyProjection.conversation = preservedConversation;
    historyProjection.feed = [
      {
        key: "assistant:history-answer",
        kind: "timeline",
        item: { kind: "assistant_message", text: "visible history answer" },
        ts: "2026-04-29T00:01:00.000Z",
      } as FeedEntry,
    ];
    const liveProjection = createEmptySessionProjection(liveSummary);
    const requests = installWebApiMocks((request) => {
      if (request.url.endsWith("/api/sessions/live/attach")) {
        return { session: attachedSummary };
      }
      throw new Error(`Unexpected request ${request.url}`);
    });
    const deps = startupDeps({
      selectedSessionId: "history",
      projections: new Map([
        ["history", historyProjection],
        ["live", liveProjection],
      ]),
      recentSessions: [
        {
          provider: "codex",
          providerSessionId: "thread-running",
          cwd: "/tmp/rah",
          rootDir: "/tmp/rah",
          createdAt: "2026-04-29T00:00:00.000Z",
        },
      ],
    });

    await resumeHistorySessionCommand(deps, "history");

    assert.deepEqual(
      requests.map((request) => request.url.replace(/^http:\/\/127\.0\.0\.1:43111/, "")),
      ["/api/sessions/live/attach"],
    );
    const state = (deps as { get: () => {
      projections: Map<string, ReturnType<typeof createEmptySessionProjection>>;
      pendingSessionAction: unknown;
      selectedSessionId: string | null;
    } }).get();
    assert.equal(state.selectedSessionId, "live");
    assert.equal(state.pendingSessionAction, null);
    assert.equal(state.projections.has("history"), false);
    assert.deepEqual(
      state.projections.get("live")?.feed.map((entry) => entry.key),
      ["assistant:history-answer"],
    );
    assert.equal(state.projections.get("live")?.summary.controlLease.holderClientId, "web-client");
    assert.equal(state.projections.get("live")?.conversation, preservedConversation);
  });

  test("resuming history selects an already controlled live projection without network calls", async () => {
    const historySummary = summary({
      id: "history",
      provider: "codex",
      providerSessionId: "thread-running",
      cwd: "/tmp/rah",
      readOnlyReplay: true,
    });
    const liveSummary: SessionSummary = {
      ...summary({
        id: "live",
        provider: "codex",
        providerSessionId: "thread-running",
        cwd: "/tmp/rah",
      }),
      attachedClients: [
        {
          id: "web-client",
          kind: "web",
          sessionId: "live",
          connectionId: "web-connection",
          attachMode: "interactive",
          focus: true,
          lastSeenAt: "2026-04-29T00:00:00.000Z",
        },
      ],
      controlLease: {
        sessionId: "live",
        holderClientId: "web-client",
        holderKind: "web",
        grantedAt: "2026-04-29T00:00:00.000Z",
      },
    };
    const requests = installWebApiMocks((request) => {
      throw new Error(`Unexpected request ${request.url}`);
    });
    const deps = startupDeps({
      selectedSessionId: "history",
      projections: new Map([
        ["history", createEmptySessionProjection(historySummary)],
        ["live", createEmptySessionProjection(liveSummary)],
      ]),
      recentSessions: [
        {
          provider: "codex",
          providerSessionId: "thread-running",
          cwd: "/tmp/rah",
          rootDir: "/tmp/rah",
          createdAt: "2026-04-29T00:00:00.000Z",
        },
      ],
    });

    await resumeHistorySessionCommand(deps, "history");

    assert.equal(requests.length, 0);
    const state = (deps as { get: () => {
      projections: Map<string, ReturnType<typeof createEmptySessionProjection>>;
      selectedSessionId: string | null;
    } }).get();
    assert.equal(state.selectedSessionId, "live");
    assert.equal(state.projections.has("history"), false);
  });

  test("resuming an already-running session applies the submitted controls before sending", async () => {
    const historySummary = summary({
      id: "history-config",
      provider: "codex",
      providerSessionId: "thread-running-config",
      cwd: "/tmp/rah",
      readOnlyReplay: true,
    });
    const liveSummary: SessionSummary = {
      ...summary({
        id: "live-config",
        provider: "codex",
        providerSessionId: "thread-running-config",
        cwd: "/tmp/rah",
        modeId: "on-request/read-only",
        modelId: "gpt-old",
        reasoningId: "ultra",
      }),
      attachedClients: [
        {
          id: "web-client",
          kind: "web",
          sessionId: "live-config",
          connectionId: "web-connection",
          attachMode: "interactive",
          focus: true,
          lastSeenAt: "2026-04-29T00:00:00.000Z",
        },
      ],
      controlLease: {
        sessionId: "live-config",
        holderClientId: "web-client",
        holderKind: "web",
        grantedAt: "2026-04-29T00:00:00.000Z",
      },
    };
    const requests = installWebApiMocks((request) => {
      if (request.url.endsWith("/api/sessions/live-config/mode")) {
        return {
          session: summary({
            id: "live-config",
            provider: "codex",
            providerSessionId: "thread-running-config",
            cwd: "/tmp/rah",
            modeId: "never/danger-full-access",
            modelId: "gpt-old",
            reasoningId: "ultra",
          }),
        };
      }
      if (request.url.endsWith("/api/sessions/live-config/model")) {
        return {
          session: summary({
            id: "live-config",
            provider: "codex",
            providerSessionId: "thread-running-config",
            cwd: "/tmp/rah",
            modeId: "never/danger-full-access",
            modelId: "gpt-new",
            reasoningId: "medium",
          }),
        };
      }
      throw new Error(`Unexpected request ${request.url}`);
    });
    const deps = startupDeps({
      selectedSessionId: "history-config",
      projections: new Map([
        ["history-config", createEmptySessionProjection(historySummary)],
        ["live-config", createEmptySessionProjection(liveSummary)],
      ]),
      recentSessions: [
        {
          provider: "codex",
          providerSessionId: "thread-running-config",
          cwd: "/tmp/rah",
          rootDir: "/tmp/rah",
          createdAt: "2026-04-29T00:00:00.000Z",
        },
      ],
    });

    assert.equal(
      await resumeHistorySessionCommand(deps, "history-config", {
        modeId: "never/danger-full-access",
        modelId: "gpt-new",
        reasoningId: "medium",
        optionValues: { model_reasoning_effort: "medium" },
      }),
      "live-config",
    );

    assert.deepEqual(
      requests.map((request) => [
        request.url.replace(/^http:\/\/127\.0\.0\.1:43111/, ""),
        request.body,
      ]),
      [
        [
          "/api/sessions/live-config/mode",
          { modeId: "never/danger-full-access" },
        ],
        [
          "/api/sessions/live-config/model",
          {
            modelId: "gpt-new",
            optionValues: { model_reasoning_effort: "medium" },
          },
        ],
      ],
    );
  });

  test("resuming already-running history preserves the visible replay feed", async () => {
    const historySummary = summary({
      id: "history",
      provider: "codex",
      providerSessionId: "thread-running",
      cwd: "/tmp/rah",
    });
    const runningSummary = summary({
      id: "live",
      provider: "codex",
      providerSessionId: "thread-running",
      cwd: "/tmp/rah",
    });
    const attachedSummary: SessionSummary = {
      ...runningSummary,
      attachedClients: [
        {
          id: "web-client",
          kind: "web",
          sessionId: "live",
          connectionId: "web-connection",
          attachMode: "interactive",
          focus: true,
          lastSeenAt: "2026-04-29T00:00:00.000Z",
        },
      ],
      controlLease: {
        sessionId: "live",
        holderClientId: "web-client",
        holderKind: "web",
        grantedAt: "2026-04-29T00:00:00.000Z",
      },
    };
    const historyProjection = createEmptySessionProjection(historySummary);
    historyProjection.feed = [
      {
        key: "assistant:history-answer",
        kind: "timeline",
        item: { kind: "assistant_message", text: "visible history answer" },
        ts: "2026-04-29T00:01:00.000Z",
      } as FeedEntry,
    ];
    installWebApiMocks((request) => {
      if (request.url.includes("/api/fs/list")) {
        return { path: "/tmp/rah", entries: [] };
      }
      if (request.url.endsWith("/api/sessions/resume")) {
        return new Response(
          JSON.stringify({
            error:
              "Provider session codex:thread-running is already running; attach instead of resume.",
          }),
          { status: 500, headers: { "content-type": "application/json" } },
        );
      }
      if (request.url.endsWith("/api/sessions?storedSessions=recent")) {
        return {
          sessions: [runningSummary],
          storedSessions: [],
          recentSessions: [],
          workspaceDirs: ["/tmp/rah"],
          hiddenWorkspaceDirs: [],
        };
      }
      if (request.url.endsWith("/api/sessions/live/attach")) {
        return { session: attachedSummary };
      }
      throw new Error(`Unexpected request ${request.url}`);
    });
    const deps = startupDeps(
      {
        selectedSessionId: "history",
        projections: new Map([["history", historyProjection]]),
        recentSessions: [
          {
            provider: "codex",
            providerSessionId: "thread-running",
            cwd: "/tmp/rah",
            rootDir: "/tmp/rah",
            createdAt: "2026-04-29T00:00:00.000Z",
          },
        ],
      },
      {
        applySessionsResponse: (current: {
          projections: Map<string, ReturnType<typeof createEmptySessionProjection>>;
        }) => ({
          ...current,
          projections: new Map([["live", createEmptySessionProjection(runningSummary)]]),
          storedSessions: [],
          recentSessions: [],
          workspaceDirs: ["/tmp/rah"],
          hiddenWorkspaceDirs: new Set<string>(),
          workspaceDir: "/tmp/rah",
        }),
      },
    );

    await resumeHistorySessionCommand(deps, "history");

    const state = (deps as { get: () => {
      projections: Map<string, ReturnType<typeof createEmptySessionProjection>>;
      selectedSessionId: string | null;
    } }).get();
    assert.equal(state.selectedSessionId, "live");
    assert.equal(state.projections.has("history"), false);
    assert.deepEqual(
      state.projections.get("live")?.feed.map((entry) => entry.key),
      ["assistant:history-answer"],
    );
    assert.equal(state.projections.get("live")?.summary.controlLease.holderClientId, "web-client");
  });

  test("resuming history does not attach a read-only replay after an already-running response", async () => {
    const historySummary = summary({
      id: "history",
      provider: "codex",
      providerSessionId: "thread-running",
      cwd: "/tmp/rah",
      readOnlyReplay: true,
    });
    const replaySummary = summary({
      id: "replay",
      provider: "codex",
      providerSessionId: "thread-running",
      cwd: "/tmp/rah",
      readOnlyReplay: true,
    });
    const projection = createEmptySessionProjection(historySummary);
    const requests = installWebApiMocks((request) => {
      if (request.url.includes("/api/fs/list")) {
        return { path: "/tmp/rah", entries: [] };
      }
      if (request.url.endsWith("/api/sessions/resume")) {
        return new Response(
          JSON.stringify({
            error:
              "Provider session codex:thread-running is already running; attach instead of resume.",
          }),
          { status: 500, headers: { "content-type": "application/json" } },
        );
      }
      if (request.url.endsWith("/api/sessions?storedSessions=recent")) {
        return {
          sessions: [replaySummary],
          storedSessions: [],
          recentSessions: [],
          workspaceDirs: ["/tmp/rah"],
          hiddenWorkspaceDirs: [],
        };
      }
      throw new Error(`Unexpected request ${request.url}`);
    });
    const deps = startupDeps({
      selectedSessionId: "history",
      projections: new Map([["history", projection]]),
      recentSessions: [
        {
          provider: "codex",
          providerSessionId: "thread-running",
          cwd: "/tmp/rah",
          rootDir: "/tmp/rah",
          createdAt: "2026-04-29T00:00:00.000Z",
        },
      ],
    });

    await assert.rejects(
      resumeHistorySessionCommand(deps, "history"),
      /attach instead of resume/,
    );

    assert.deepEqual(
      requests.map((request) => request.url.replace(/^http:\/\/127\.0\.0\.1:43111/, "")),
      [
        "/api/fs/list?path=%2Ftmp%2Frah",
        "/api/sessions/resume",
        "/api/sessions?storedSessions=recent",
      ],
    );
  });
});

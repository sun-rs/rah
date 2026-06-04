import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import type { SessionSummary, StoredSessionRef } from "@rah/runtime-protocol";
import {
  activateHistorySessionCommand,
  claimHistorySessionCommand,
  resumeStoredSessionCommand,
  startSessionCommand,
} from "./session-store-session-startup";
import { createEmptySessionProjection } from "./session-store-session-lifecycle";

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
    const result = handler(request);
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
  provider?: "codex" | "claude" | "gemini" | "opencode";
  providerSessionId?: string;
  cwd?: string;
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
      rootDir: cwd,
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
    ensureSessionHistoryLoaded: async () => undefined,
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

describe("session startup model and mode requests", () => {
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

    await startSessionCommand(
      startupDeps(
        {},
        {
          ensureSessionHistoryLoaded: async (sessionId: string) => {
            historyLoads.push(sessionId);
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
      reasoningId: "xhigh",
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
  });

  test("new session exposes created session id before initial input finishes", async () => {
    installWebApiMocks((request) => {
      if (request.url.includes("/api/fs/list")) {
        return { path: "/tmp/rah", entries: [] };
      }
      if (request.url.endsWith("/api/sessions/start")) {
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

    await assert.rejects(
      startSessionCommand(
        startupDeps(
          {},
          {
            sendInput: async () => {
              calls.push("send");
              throw new Error("send failed");
            },
          },
        ),
        {
          provider: "codex",
          cwd: "/tmp/rah",
          title: "test",
          initialInput: "hello",
          onSessionCreated: (sessionId) => {
            calls.push(`created:${sessionId}`);
          },
        },
      ),
      /send failed/,
    );

    assert.deepEqual(calls, ["created:started", "send"]);
  });

  test("Gemini new session passes first input as launch initialPrompt", async () => {
    const requests = installWebApiMocks((request) => {
      if (request.url.includes("/api/fs/list")) {
        return { path: "/tmp/rah", entries: [] };
      }
      if (request.url.endsWith("/api/sessions/start")) {
        const body = request.body as { provider: "gemini"; cwd: string };
        return {
          session: summary({
            id: "started-gemini",
            provider: body.provider,
            cwd: body.cwd,
          }),
        };
      }
      throw new Error(`Unexpected request ${request.url}`);
    });
    const calls: string[] = [];

    await startSessionCommand(
      startupDeps(
        { newSessionProvider: "gemini" },
        {
          sendInput: async () => {
            calls.push("send");
            throw new Error("Gemini first prompt should launch with the session.");
          },
        },
      ),
      {
        provider: "gemini",
        cwd: "/tmp/rah",
        title: "hello",
        initialInput: "hello gemini",
        onSessionCreated: (sessionId) => {
          calls.push(`created:${sessionId}`);
        },
      },
    );

    const startRequest = requests.find((request) =>
      request.url.endsWith("/api/sessions/start"),
    );
    const body = startRequest?.body as { initialPrompt?: string; liveBackend?: string };
    assert.equal(body.initialPrompt, "hello gemini");
    assert.equal(body.liveBackend, "tui_mux");
    assert.deepEqual(calls, ["created:started-gemini"]);
  });

  test("new session selects native local-server backend for providers that support it", async () => {
    const requests = installWebApiMocks((request) => {
      if (request.url.includes("/api/fs/list")) {
        return { path: "/tmp/rah", entries: [] };
      }
      if (request.url.endsWith("/api/sessions/start")) {
        const body = request.body as {
          provider: "codex" | "claude" | "gemini" | "opencode";
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

    for (const provider of ["codex", "claude", "gemini", "opencode"] as const) {
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
        ["gemini", "tui_mux"],
        ["opencode", "native_local_server"],
      ],
    );
  });

  test("claim history sends selected mode, model, and optionValues to resume", async () => {
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
          reasoningId?: string | null;
        };
        return {
          session: summary({
            id: "claimed",
            provider: body.provider,
            providerSessionId: body.providerSessionId,
            cwd: body.cwd,
            modeId: body.modeId,
            modelId: body.model,
            reasoningId: body.reasoningId,
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

    await claimHistorySessionCommand(
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
      reasoningId: "xhigh",
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

    const modelRequest = requests.find((request) =>
      request.url.endsWith("/api/sessions/claimed/model"),
    );
    assert.deepEqual(modelRequest?.body, {
      modelId: "gpt-5.5",
      optionValues: { model_reasoning_effort: "xhigh" },
      reasoningId: "xhigh",
    });
  });

  test("claim history removes the read-only replay projection for the same provider session", async () => {
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

    await claimHistorySessionCommand(deps, "history");

    const state = (deps as { get: () => {
      projections: Map<string, ReturnType<typeof createEmptySessionProjection>>;
      selectedSessionId: string | null;
    } }).get();
    assert.equal(state.projections.has("history"), false);
    assert.equal(state.projections.has("claimed"), true);
    assert.equal(state.selectedSessionId, "claimed");
  });

  test("claim history keeps the claimed session when post-claim control update fails", async () => {
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
            reasoningId: "xhigh",
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

    const claimedId = await claimHistorySessionCommand(
      deps,
      "history",
      {
        modelId: "gpt-5.5",
        reasoningId: "xhigh",
        optionValues: { model_reasoning_effort: "xhigh" },
      },
    );
    const state = (deps as { get: () => { projections: Map<string, unknown>; selectedSessionId: string | null; error: string | null } }).get();

    assert.equal(claimedId, "claimed");
    assert.equal(state.selectedSessionId, "claimed");
    assert.equal(state.projections.has("claimed"), true);
    assert.equal(state.projections.has("history"), false);
    assert.match(state.error ?? "", /Session was claimed/);
  });

  test("claim history selects native local-server backend for providers that support it", async () => {
    const requests = installWebApiMocks((request) => {
      if (request.url.includes("/api/fs/list")) {
        return { path: "/tmp/rah", entries: [] };
      }
      if (request.url.endsWith("/api/sessions/resume")) {
        const body = request.body as {
          provider: "codex" | "claude" | "gemini" | "opencode";
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

    for (const provider of ["codex", "claude", "gemini", "opencode"] as const) {
      const history = summary({
        id: `history-${provider}`,
        provider,
        providerSessionId: `provider-${provider}`,
        cwd: "/tmp/rah",
      });
      const projections = new Map([[history.session.id, createEmptySessionProjection(history)]]);
      await claimHistorySessionCommand(
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
        ["gemini", "tui_mux"],
        ["opencode", "native_local_server"],
      ],
    );
  });

  test("activating stored history opens read-only replay instead of claiming native live", async () => {
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

  test("claim history asks to create a missing stored workspace before launching", async () => {
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

    await claimHistorySessionCommand(
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

  test("claiming history claims control when the provider session is already running", async () => {
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
      if (request.url.endsWith("/api/sessions")) {
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

    await claimHistorySessionCommand(
      deps,
      "history",
    );

    assert.deepEqual(
      requests.map((request) => request.url.replace(/^http:\/\/127\.0\.0\.1:43111/, "")),
      [
        "/api/fs/list?path=%2Ftmp%2Frah",
        "/api/sessions/resume",
        "/api/sessions",
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

  test("claiming history does not attach a read-only replay after an already-running response", async () => {
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
      if (request.url.endsWith("/api/sessions")) {
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
      claimHistorySessionCommand(deps, "history"),
      /attach instead of resume/,
    );

    assert.deepEqual(
      requests.map((request) => request.url.replace(/^http:\/\/127\.0\.0\.1:43111/, "")),
      [
        "/api/fs/list?path=%2Ftmp%2Frah",
        "/api/sessions/resume",
        "/api/sessions",
      ],
    );
  });
});

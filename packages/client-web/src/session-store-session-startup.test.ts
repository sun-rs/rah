import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import type { SessionSummary, StoredSessionRef } from "@rah/runtime-protocol";
import {
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
    return new Response(JSON.stringify(handler(request)), {
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
  provider?: "codex" | "claude" | "kimi" | "gemini" | "opencode";
  providerSessionId?: string;
  cwd?: string;
  modeId?: string;
  modelId?: string | null;
  reasoningId?: string | null;
}): SessionSummary {
  const cwd = args.cwd ?? "/tmp/rah";
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
        livePermissions: true,
        contextUsage: false,
        resumeByProvider: true,
        listProviderSessions: true,
        renameSession: true,
        actions: { info: true, archive: true, delete: true, rename: "native" },
        steerInput: true,
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

function startupDeps(stateOverrides: Record<string, unknown> = {}) {
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

    await startSessionCommand(startupDeps(), {
      provider: "codex",
      cwd: "/tmp/rah",
      title: "test",
      modeId: "on-request/read-only",
      model: "gpt-5.5",
      reasoningId: "xhigh",
      optionValues: { model_reasoning_effort: "xhigh" },
      initialInput: "",
    });

    const startRequest = requests.find((request) =>
      request.url.endsWith("/api/sessions/start"),
    );
    assert.deepEqual(startRequest?.body, {
      provider: "codex",
      cwd: "/tmp/rah",
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

  test("history resume asks to create a missing workspace before launching", async () => {
    const requests = installWebApiMocks((request) => {
      if (request.url.includes("/api/fs/list")) {
        throw new Error("ENOENT");
      }
      if (request.url.endsWith("/api/fs/ensure-dir")) {
        return { path: (request.body as { dir: string }).dir };
      }
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
      [
        "/api/fs/list?path=%2Ftmp%2Fmissing",
        "/api/fs/ensure-dir",
        "/api/sessions/resume",
      ],
    );
  });
});

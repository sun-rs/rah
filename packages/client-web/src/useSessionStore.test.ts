import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type {
  ProviderModelCatalog,
  RahEvent,
  SessionSummary,
  StoredSessionRef,
} from "@rah/runtime-protocol";
import * as api from "./api";
import {
  applyStoredSessionsDeltaToRecent,
  coerceSelectedSessionId,
  computeUnreadSessionIds,
  findDaemonRunningSessionForStoredRef,
  providerModelCatalogKey,
  readOrCreateClientId,
  readOrCreateConnectionId,
  reconcileVisibleWorkspaceSelection,
  resolveHistoryActivationMode,
  resolveHiddenWorkspaceDirsFromSessionsResponse,
  useSessionStore,
} from "./useSessionStore";
import { activateHistorySessionCommand } from "./session-store-session-startup";
import {
  applyEventsToProjectionMap,
  updateSessionSummaryInProjectionMap,
} from "./session-store-projections";
import { type SessionProjection } from "./types";

const originalFetch = globalThis.fetch;
const originalWindow = (globalThis as typeof globalThis & { window?: unknown }).window;

async function waitForCondition(predicate: () => boolean, message: string): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) {
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  assert.fail(message);
}

function providerCatalog(
  provider: "opencode",
  modelId: string,
  fetchedAt: string,
): ProviderModelCatalog {
  return {
    provider,
    currentModelId: modelId,
    models: [{ id: modelId, name: modelId }],
    fetchedAt,
    source: "native",
    freshness: "authoritative",
  };
}

test("stored-session discovery deltas keep the bounded Recent catalog current", () => {
  const current = Array.from({ length: 15 }, (_, index): StoredSessionRef => ({
    provider: "codex",
    providerSessionId: `existing-${index}`,
    source: "provider_history",
    updatedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
  }));
  const next = applyStoredSessionsDeltaToRecent(current, {
    remove: [{ provider: "codex", providerSessionId: "existing-14" }],
    upsert: [
      {
        provider: "opencode",
        providerSessionId: "newest",
        source: "provider_history",
        updatedAt: "2026-02-01T00:00:00.000Z",
      },
    ],
  });

  assert.equal(next.length, 15);
  assert.equal(next[0]?.providerSessionId, "newest");
  assert.ok(!next.some((session) => session.providerSessionId === "existing-14"));
});

describe("provider model catalog isolation", () => {
  test("keeps independently discovered catalogs scoped to provider and workspace", async () => {
    (globalThis as typeof globalThis & { window?: unknown }).window = undefined;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      const cwd = url.searchParams.get("cwd") ?? "default";
      const modelId = cwd.endsWith("/a") ? "model-a" : "model-b";
      return new Response(
        JSON.stringify({
          catalog: providerCatalog("opencode", modelId, "2026-07-14T00:00:00.000Z"),
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;
    useSessionStore.setState({ modelCatalogs: {} });

    try {
      await Promise.all([
        useSessionStore.getState().loadProviderModels("opencode", {
          cwd: "/workspace/a",
          forceRefresh: true,
        }),
        useSessionStore.getState().loadProviderModels("opencode", {
          cwd: "/workspace/b",
          forceRefresh: true,
        }),
      ]);

      const catalogs = useSessionStore.getState().modelCatalogs;
      assert.equal(
        catalogs[providerModelCatalogKey("opencode", "/workspace/a")]?.catalog?.currentModelId,
        "model-a",
      );
      assert.equal(
        catalogs[providerModelCatalogKey("opencode", "/workspace/b")]?.catalog?.currentModelId,
        "model-b",
      );
    } finally {
      globalThis.fetch = originalFetch;
      (globalThis as typeof globalThis & { window?: unknown }).window = originalWindow;
      useSessionStore.setState({ modelCatalogs: {} });
    }
  });

  test("does not let an older request overwrite a newer authoritative catalog", async () => {
    (globalThis as typeof globalThis & { window?: unknown }).window = undefined;
    let resolveResponse: ((response: Response) => void) | undefined;
    globalThis.fetch = (() =>
      new Promise<Response>((resolve) => {
        resolveResponse = resolve;
      })) as typeof fetch;
    useSessionStore.setState({ modelCatalogs: {} });

    try {
      const pending = useSessionStore.getState().loadProviderModels("opencode", {
        cwd: "/workspace/a",
        forceRefresh: true,
      });
      await Promise.resolve();
      useSessionStore.getState().rememberProviderModelCatalog(
        "opencode",
        providerCatalog("opencode", "new-model", "2026-07-14T00:01:00.000Z"),
        { cwd: "/workspace/a" },
      );
      assert.ok(resolveResponse);
      resolveResponse(
        new Response(
          JSON.stringify({
            catalog: providerCatalog("opencode", "stale-model", "2026-07-14T00:00:00.000Z"),
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
      await pending;

      assert.equal(
        useSessionStore.getState().modelCatalogs[
          providerModelCatalogKey("opencode", "/workspace/a")
        ]?.catalog?.currentModelId,
        "new-model",
      );
    } finally {
      globalThis.fetch = originalFetch;
      (globalThis as typeof globalThis & { window?: unknown }).window = originalWindow;
      useSessionStore.setState({ modelCatalogs: {} });
    }
  });
});

function installLocalStorageMock() {
  const store = new Map<string, string>();
  (globalThis as typeof globalThis & { window?: unknown }).window = {
    localStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        store.set(key, value);
      },
      removeItem: (key: string) => {
        store.delete(key);
      },
    },
  };
}

function withMockedNow<T>(iso: string, run: () => T): T {
  const originalNow = Date.now;
  Date.now = () => Date.parse(iso);
  try {
    return run();
  } finally {
    Date.now = originalNow;
  }
}

function sessionSummary(rootDir: string): SessionSummary {
  return {
    session: {
      id: `session:${rootDir}`,
      provider: "codex",
      providerSessionId: `provider:${rootDir}`,
      launchSource: "web",
      cwd: rootDir,
      rootDir,
      runtimeState: "running",
      ptyId: `pty:${rootDir}`,
      capabilities: {
        liveAttach: true,
        structuredTimeline: true,
        livePermissions: true,
        contextUsage: true,
        resumeByProvider: true,
        listProviderSessions: true,
        steerInput: true,
        queuedInput: false,
        modelSwitch: false,
        planMode: false,
        subagents: false,
      },
      createdAt: "2026-04-21T00:00:00.000Z",
      updatedAt: "2026-04-21T00:00:00.000Z",
    },
    attachedClients: [],
    controlLease: { sessionId: `session:${rootDir}` },
  };
}

function event(type: RahEvent["type"], sessionId: string): RahEvent {
  return {
    id: `${type}:${sessionId}`,
    seq: 1,
    ts: "2026-04-21T00:00:00.000Z",
    sessionId,
    type,
    source: {
      provider: "codex",
      channel: "structured_live",
      authority: "derived",
    },
    payload: {},
  } as RahEvent;
}

function projection(rootDir: string): SessionProjection {
  return {
    summary: sessionSummary(rootDir),
    feed: [],
    events: [],
    lastSeq: 0,
  };
}

function liveStoredSessionRef(rootDir: string): StoredSessionRef {
  return {
    provider: "codex",
    providerSessionId: `provider:${rootDir}`,
    rootDir,
    cwd: rootDir,
    title: rootDir,
  };
}

describe("workspace response reconciliation", () => {
  test("workspace mutation APIs preserve the requested stored session catalog mode", async () => {
    const urls: string[] = [];
    (globalThis as typeof globalThis & { window?: unknown }).window = undefined;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return new Response(
        JSON.stringify({
          sessions: [],
          storedSessions: [],
          recentSessions: [],
          workspaceDirs: [],
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    }) as typeof fetch;

    try {
      await api.selectWorkspace({ dir: "/workspace/a" }, { storedSessions: "recent" });
      await api.addWorkspace({ dir: "/workspace/b" }, { storedSessions: "all" });
      await api.removeWorkspace({ dir: "/workspace/c" }, { storedSessions: "recent" });
    } finally {
      globalThis.fetch = originalFetch;
      (globalThis as typeof globalThis & { window?: unknown }).window = originalWindow;
    }

    assert.deepEqual(
      urls.map((url) => new URL(url).pathname + new URL(url).search),
      [
        "/api/workspaces/select?storedSessions=recent",
        "/api/workspaces/add?storedSessions=all",
        "/api/workspaces/remove?storedSessions=recent",
      ],
    );
  });

  test("clears stale runtime status when a refreshed session summary is idle", () => {
    const running = projection("/workspace/rah");
    const current = new Map([
      [
        running.summary.session.id,
        {
          ...running,
          currentRuntimeStatus: "thinking" as const,
        },
      ],
    ]);
    const idleSummary: SessionSummary = {
      ...running.summary,
      session: {
        ...running.summary.session,
        runtimeState: "idle",
        updatedAt: "2026-04-21T00:00:01.000Z",
      },
    };

    const next = updateSessionSummaryInProjectionMap(current, idleSummary);
    assert.equal(next.get(running.summary.session.id)?.summary.session.runtimeState, "idle");
    assert.equal(next.get(running.summary.session.id)?.currentRuntimeStatus, undefined);
  });

  test("keeps hidden deletions filtered when an older response still includes them", () => {
    const reconciled = reconcileVisibleWorkspaceSelection({
      workspaceDirs: ["/workspace/a", "/workspace/b", "/workspace/c"],
      sessions: [sessionSummary("/workspace/c")],
      storedSessions: [],
      activeWorkspaceDir: "/workspace/a",
      currentWorkspaceDir: "",
      hiddenWorkspaceDirs: ["/workspace/a", "/workspace/b"],
    });

    assert.deepEqual(reconciled.workspaceDirs, ["/workspace/c"]);
    assert.equal(reconciled.workspaceDir, "/workspace/c");
  });

  test("falls back to empty selection when every visible workspace is hidden", () => {
    const reconciled = reconcileVisibleWorkspaceSelection({
      workspaceDirs: ["/workspace/a"],
      sessions: [],
      storedSessions: [] as StoredSessionRef[],
      activeWorkspaceDir: "/workspace/a",
      currentWorkspaceDir: "/workspace/a",
      hiddenWorkspaceDirs: ["/workspace/a"],
    });

    assert.deepEqual(reconciled.workspaceDirs, []);
    assert.equal(reconciled.workspaceDir, "");
  });

  test("keeps a newer local workspace visibility mutation when an older response arrives late", () => {
    const hiddenWorkspaceDirs = resolveHiddenWorkspaceDirsFromSessionsResponse({
      currentHiddenWorkspaceDirs: new Set(["/workspace/a"]),
      currentWorkspaceVisibilityVersion: 2,
      workspaceVisibilityVersionAtRequest: 1,
      hiddenWorkspaces: [],
    });

    assert.deepEqual([...hiddenWorkspaceDirs], ["/workspace/a"]);
  });

  test("accepts daemon hidden workspaces when the response matches the latest visibility version", () => {
    const hiddenWorkspaceDirs = resolveHiddenWorkspaceDirsFromSessionsResponse({
      currentHiddenWorkspaceDirs: new Set<string>(),
      currentWorkspaceVisibilityVersion: 3,
      workspaceVisibilityVersionAtRequest: 3,
      hiddenWorkspaces: ["/workspace/a"],
    });

    assert.deepEqual([...hiddenWorkspaceDirs], ["/workspace/a"]);
  });

  test("keeps Chats All catalog loading isolated from left sidebar workspaces", async () => {
    const originalState = useSessionStore.getState();
    const urls: string[] = [];
    (globalThis as typeof globalThis & { window?: unknown }).window = undefined;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return new Response(
        JSON.stringify({
          sessions: [],
          storedSessions: [
            {
              provider: "codex",
              providerSessionId: "provider:/workspace/all-only",
              rootDir: "/workspace/all-only",
              cwd: "/workspace/all-only",
              title: "All-only session",
            },
          ],
          recentSessions: [],
          workspaceDirs: ["/workspace/current", "/workspace/all-only"],
          activeWorkspaceDir: "/workspace/all-only",
          hiddenWorkspaces: [],
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    }) as typeof fetch;
    useSessionStore.setState({
      projections: new Map(),
      storedSessions: [],
      recentSessions: [],
      storedSessionsCatalogLoaded: false,
      workspaceDirs: ["/workspace/current"],
      hiddenWorkspaceDirs: new Set<string>(),
      workspaceVisibilityVersion: 0,
      workspaceDir: "/workspace/current",
      selectedSessionId: null,
      pendingSessionAction: null,
      sessionTopologyVersion: 0,
    });

    try {
      await useSessionStore.getState().loadStoredSessionsCatalog();

      const state = useSessionStore.getState();
      assert.deepEqual(urls.map((url) => new URL(url).pathname + new URL(url).search), [
        "/api/sessions?storedSessions=all",
      ]);
      assert.deepEqual(state.workspaceDirs, ["/workspace/current"]);
      assert.equal(state.workspaceDir, "/workspace/current");
      assert.equal(state.storedSessionsCatalogLoaded, true);
      assert.equal(state.storedSessions[0]?.rootDir, "/workspace/all-only");
    } finally {
      globalThis.fetch = originalFetch;
      (globalThis as typeof globalThis & { window?: unknown }).window = originalWindow;
      useSessionStore.setState(originalState, true);
    }
  });

  test("reuses a clean Chats All catalog and refreshes it only when marked dirty", async () => {
    const originalState = useSessionStore.getState();
    const urls: string[] = [];
    let responseIndex = 0;
    const storedResponses: StoredSessionRef[][] = [
      [
        {
          provider: "codex",
          providerSessionId: "older",
          rootDir: "/workspace/current",
          cwd: "/workspace/current",
          title: "Older session",
          source: "provider_history",
        },
      ],
      [
        {
          provider: "codex",
          providerSessionId: "new-after-restart",
          rootDir: "/workspace/current",
          cwd: "/workspace/current",
          title: "New after restart",
          historyMeta: { lines: 12 },
          source: "provider_history",
        },
      ],
    ];
    (globalThis as typeof globalThis & { window?: unknown }).window = undefined;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      urls.push(String(input));
      const storedSessions = storedResponses[Math.min(responseIndex, storedResponses.length - 1)]!;
      responseIndex += 1;
      return new Response(
        JSON.stringify({
          sessions: [],
          storedSessions,
          recentSessions: [],
          workspaceDirs: ["/workspace/current"],
          activeWorkspaceDir: "/workspace/current",
          hiddenWorkspaces: [],
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    }) as typeof fetch;
    useSessionStore.setState({
      projections: new Map(),
      storedSessions: [],
      recentSessions: [],
      storedSessionsCatalogLoaded: false,
      storedSessionsCatalogDirty: false,
      workspaceDirs: ["/workspace/current"],
      hiddenWorkspaceDirs: new Set<string>(),
      workspaceVisibilityVersion: 0,
      workspaceDir: "/workspace/current",
      selectedSessionId: null,
      pendingSessionAction: null,
      sessionTopologyVersion: 0,
    });

    try {
      await useSessionStore.getState().loadStoredSessionsCatalog();
      assert.deepEqual(urls.map((url) => new URL(url).pathname + new URL(url).search), [
        "/api/sessions?storedSessions=all",
      ]);
      assert.deepEqual(
        useSessionStore.getState().storedSessions.map((session) => session.providerSessionId),
        ["older"],
      );

      await useSessionStore.getState().loadStoredSessionsCatalog();
      assert.deepEqual(urls.map((url) => new URL(url).pathname + new URL(url).search), [
        "/api/sessions?storedSessions=all",
      ]);

      useSessionStore.setState({ storedSessionsCatalogDirty: true });
      await useSessionStore.getState().loadStoredSessionsCatalog();

      assert.deepEqual(urls.map((url) => new URL(url).pathname + new URL(url).search), [
        "/api/sessions?storedSessions=all",
        "/api/sessions?storedSessions=all",
      ]);
      const state = useSessionStore.getState();
      assert.equal(state.storedSessionsCatalogLoaded, true);
      assert.deepEqual(
        state.storedSessions.map((session) => session.providerSessionId),
        ["new-after-restart"],
      );
      assert.equal(state.storedSessions[0]?.historyMeta?.lines, 12);
    } finally {
      globalThis.fetch = originalFetch;
      (globalThis as typeof globalThis & { window?: unknown }).window = originalWindow;
      useSessionStore.setState(originalState, true);
    }
  });

  test("normal workbench refresh remains recent-only after Chats All has been loaded", async () => {
    const originalState = useSessionStore.getState();
    const urls: string[] = [];
    const existingAllRef: StoredSessionRef = {
      provider: "codex",
      providerSessionId: "all-only",
      rootDir: "/workspace/archive",
      cwd: "/workspace/archive",
      title: "All only",
      source: "provider_history",
    };
    const recentRef: StoredSessionRef = {
      provider: "claude",
      providerSessionId: "recent-one",
      rootDir: "/workspace/current",
      cwd: "/workspace/current",
      title: "Recent one",
      lastUsedAt: "2026-04-21T00:02:00.000Z",
      source: "provider_history",
    };
    (globalThis as typeof globalThis & { window?: unknown }).window = undefined;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return new Response(
        JSON.stringify({
          sessions: [],
          storedSessions: [recentRef],
          recentSessions: [recentRef],
          workspaceDirs: ["/workspace/current"],
          activeWorkspaceDir: "/workspace/current",
          hiddenWorkspaces: [],
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    }) as typeof fetch;
    useSessionStore.setState({
      projections: new Map(),
      storedSessions: [existingAllRef],
      recentSessions: [],
      storedSessionsCatalogLoaded: true,
      storedSessionsCatalogDirty: false,
      workspaceDirs: ["/workspace/current"],
      hiddenWorkspaceDirs: new Set<string>(),
      workspaceVisibilityVersion: 0,
      workspaceDir: "/workspace/current",
      selectedSessionId: null,
      pendingSessionAction: null,
      sessionTopologyVersion: 0,
    });

    try {
      await useSessionStore.getState().refreshWorkbenchState();

      assert.deepEqual(urls.map((url) => new URL(url).pathname + new URL(url).search), [
        "/api/sessions?storedSessions=recent",
      ]);
      assert.deepEqual(
        useSessionStore.getState().storedSessions.map((session) => session.providerSessionId),
        ["recent-one", "all-only"],
      );
    } finally {
      globalThis.fetch = originalFetch;
      (globalThis as typeof globalThis & { window?: unknown }).window = originalWindow;
      useSessionStore.setState(originalState, true);
    }
  });

  test("dirty Chats All catalog updates from stored-session delta before falling back to full", async () => {
    const originalState = useSessionStore.getState();
    const urls: string[] = [];
    const olderRef: StoredSessionRef = {
      provider: "codex",
      providerSessionId: "older",
      rootDir: "/workspace/current",
      cwd: "/workspace/current",
      title: "Older session",
      lastUsedAt: "2026-04-21T00:01:00.000Z",
      source: "provider_history",
    };
    const nextRef: StoredSessionRef = {
      provider: "opencode",
      providerSessionId: "new-delta",
      rootDir: "/workspace/current",
      cwd: "/workspace/current",
      title: "New from delta",
      lastUsedAt: "2026-04-21T00:02:00.000Z",
      historyMeta: { lines: 9 },
      source: "provider_history",
    };
    (globalThis as typeof globalThis & { window?: unknown }).window = undefined;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      urls.push(url.pathname + url.search);
      if (url.pathname === "/api/sessions/stored-delta") {
        assert.equal(url.searchParams.get("since"), "7");
        return new Response(
          JSON.stringify({
            fromRevision: 7,
            revision: 8,
            upsert: [nextRef],
            remove: [{ provider: "codex", providerSessionId: "older" }],
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }
      throw new Error(`Unexpected request ${url.pathname}${url.search}`);
    }) as typeof fetch;
    useSessionStore.setState({
      projections: new Map(),
      storedSessions: [olderRef],
      recentSessions: [],
      storedSessionsCatalogLoaded: true,
      storedSessionsCatalogDirty: true,
      storedSessionsCatalogRevision: 7,
      workspaceDirs: ["/workspace/current"],
      hiddenWorkspaceDirs: new Set<string>(),
      workspaceVisibilityVersion: 0,
      workspaceDir: "/workspace/current",
      selectedSessionId: null,
      pendingSessionAction: null,
      sessionTopologyVersion: 0,
    });

    try {
      await useSessionStore.getState().loadStoredSessionsCatalog();

      assert.deepEqual(urls, ["/api/sessions/stored-delta?since=7"]);
      const state = useSessionStore.getState();
      assert.equal(state.storedSessionsCatalogDirty, false);
      assert.equal(state.storedSessionsCatalogRevision, 8);
      assert.deepEqual(
        state.storedSessions.map((session) => [session.provider, session.providerSessionId, session.historyMeta?.lines]),
        [["opencode", "new-delta", 9]],
      );
    } finally {
      globalThis.fetch = originalFetch;
      (globalThis as typeof globalThis & { window?: unknown }).window = originalWindow;
      useSessionStore.setState(originalState, true);
    }
  });

  test("dirty Chats All catalog falls back to full load when delta requires reset", async () => {
    const originalState = useSessionStore.getState();
    const urls: string[] = [];
    const rebuiltRef: StoredSessionRef = {
      provider: "codex",
      providerSessionId: "rebuilt",
      rootDir: "/workspace/current",
      cwd: "/workspace/current",
      title: "Rebuilt session",
      source: "provider_history",
    };
    (globalThis as typeof globalThis & { window?: unknown }).window = undefined;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      urls.push(url.pathname + url.search);
      if (url.pathname === "/api/sessions/stored-delta") {
        return new Response(
          JSON.stringify({
            fromRevision: 2,
            revision: 5,
            upsert: [],
            remove: [],
            resetRequired: true,
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }
      if (url.pathname === "/api/sessions") {
        return new Response(
          JSON.stringify({
            sessions: [],
            storedSessions: [rebuiltRef],
            recentSessions: [rebuiltRef],
            storedSessionsRevision: 5,
            workspaceDirs: ["/workspace/current"],
            activeWorkspaceDir: "/workspace/current",
            hiddenWorkspaces: [],
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }
      throw new Error(`Unexpected request ${url.pathname}${url.search}`);
    }) as typeof fetch;
    useSessionStore.setState({
      projections: new Map(),
      storedSessions: [],
      recentSessions: [],
      storedSessionsCatalogLoaded: true,
      storedSessionsCatalogDirty: true,
      storedSessionsCatalogRevision: 2,
      workspaceDirs: ["/workspace/current"],
      hiddenWorkspaceDirs: new Set<string>(),
      workspaceVisibilityVersion: 0,
      workspaceDir: "/workspace/current",
      selectedSessionId: null,
      pendingSessionAction: null,
      sessionTopologyVersion: 0,
    });

    try {
      await useSessionStore.getState().loadStoredSessionsCatalog();

      assert.deepEqual(urls, [
        "/api/sessions/stored-delta?since=2",
        "/api/sessions?storedSessions=all",
      ]);
      const state = useSessionStore.getState();
      assert.equal(state.storedSessionsCatalogDirty, false);
      assert.equal(state.storedSessionsCatalogRevision, 5);
      assert.deepEqual(
        state.storedSessions.map((session) => session.providerSessionId),
        ["rebuilt"],
      );
    } finally {
      globalThis.fetch = originalFetch;
      (globalThis as typeof globalThis & { window?: unknown }).window = originalWindow;
      useSessionStore.setState(originalState, true);
    }
  });

  test("new stop All refresh and delete keep catalog accurate without background all reloads", async () => {
    const originalState = useSessionStore.getState();
    const urls: string[] = [];
    const liveSummary: SessionSummary = {
      session: {
        id: "live-created-session",
        provider: "codex",
        providerSessionId: "provider-created-session",
        launchSource: "web",
        cwd: "/workspace/current",
        rootDir: "/workspace/current",
        title: "Created session",
        runtimeState: "idle",
        ptyId: "pty-created-session",
        capabilities: {
          liveAttach: true,
          structuredTimeline: true,
          livePermissions: true,
          contextUsage: true,
          resumeByProvider: true,
          listProviderSessions: true,
          steerInput: true,
          queuedInput: false,
          modelSwitch: false,
          planMode: false,
          subagents: false,
        },
        createdAt: "2026-04-21T00:00:00.000Z",
        updatedAt: "2026-04-21T00:00:00.000Z",
      },
      attachedClients: [],
      controlLease: {
        sessionId: "live-created-session",
        holderClientId: "web-user",
      },
    };
    const stoppedRef: StoredSessionRef = {
      provider: "codex",
      providerSessionId: "provider-created-session",
      rootDir: "/workspace/current",
      cwd: "/workspace/current",
      title: "Created session",
      updatedAt: "2026-04-21T00:01:00.000Z",
      lastUsedAt: "2026-04-21T00:01:00.000Z",
      historyMeta: { lines: 12, bytes: 2048 },
      source: "provider_history",
    };
    const listResponseWithStopped = {
      sessions: [],
      storedSessions: [stoppedRef],
      recentSessions: [stoppedRef],
      workspaceDirs: ["/workspace/current"],
      activeWorkspaceDir: "/workspace/current",
      hiddenWorkspaces: [],
    };
    const emptyListResponse = {
      sessions: [],
      storedSessions: [],
      recentSessions: [],
      workspaceDirs: ["/workspace/current"],
      activeWorkspaceDir: "/workspace/current",
      hiddenWorkspaces: [],
    };
    (globalThis as typeof globalThis & { window?: unknown }).window = undefined;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      urls.push(`${method} ${url.pathname}${url.search}`);
      if (method === "GET" && url.pathname === "/api/fs/list") {
        return new Response(
          JSON.stringify({
            path: "/workspace/current",
            entries: [],
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }
      if (method === "POST" && url.pathname === "/api/sessions/start") {
        return new Response(JSON.stringify({ session: liveSummary }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (method === "POST" && url.pathname === "/api/sessions/live-created-session/close") {
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (method === "GET" && url.pathname === "/api/sessions") {
        return new Response(JSON.stringify(listResponseWithStopped), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (method === "POST" && url.pathname === "/api/history/sessions/remove") {
        return new Response(JSON.stringify(emptyListResponse), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`Unexpected request ${method} ${url.pathname}${url.search}`);
    }) as typeof fetch;
    useSessionStore.setState({
      projections: new Map(),
      storedSessions: [],
      recentSessions: [],
      storedSessionsCatalogLoaded: true,
      storedSessionsCatalogDirty: false,
      workspaceDirs: ["/workspace/current"],
      hiddenWorkspaceDirs: new Set<string>(),
      workspaceVisibilityVersion: 0,
      workspaceDir: "/workspace/current",
      selectedSessionId: null,
      pendingSessionAction: null,
      sessionTopologyVersion: 0,
      newSessionProvider: "codex",
    });

    try {
      const sessionId = await useSessionStore.getState().startSession({
        provider: "codex",
        cwd: "/workspace/current",
        title: "Created session",
      });
      assert.equal(sessionId, "live-created-session");

      await useSessionStore.getState().closeSession("live-created-session");
      assert.deepEqual(
        useSessionStore.getState().recentSessions.map((session) => session.providerSessionId),
        ["provider-created-session"],
      );
      await waitForCondition(
        () => useSessionStore.getState().recentSessions[0]?.historyMeta?.lines === 12,
        "stopped session metadata refresh did not complete",
      );

      await useSessionStore.getState().loadStoredSessionsCatalog();
      assert.deepEqual(
        useSessionStore.getState().storedSessions.map((session) => [
          session.providerSessionId,
          session.historyMeta?.lines,
        ]),
        [["provider-created-session", 12]],
      );

      await useSessionStore.getState().removeHistorySession(stoppedRef);
      assert.deepEqual(useSessionStore.getState().storedSessions, []);
      assert.deepEqual(useSessionStore.getState().recentSessions, []);

      assert.deepEqual(urls, [
        "GET /api/fs/list?path=%2Fworkspace%2Fcurrent",
        "POST /api/sessions/start",
        "GET /api/sessions/live-created-session/conversation/turns?limit=20&liveOnly=true",
        "POST /api/sessions/live-created-session/close",
        "GET /api/sessions?storedSessions=recent",
        "POST /api/history/sessions/remove?storedSessions=recent",
      ]);
    } finally {
      globalThis.fetch = originalFetch;
      (globalThis as typeof globalThis & { window?: unknown }).window = originalWindow;
      useSessionStore.setState(originalState, true);
    }
  });

  test("keeps a just-stopped local history ref visible across a normal refresh", async () => {
    const originalState = useSessionStore.getState();
    const stoppedRef: StoredSessionRef = {
      provider: "codex",
      providerSessionId: "just-stopped",
      rootDir: "/workspace/current",
      cwd: "/workspace/current",
      title: "Just stopped",
      updatedAt: "2026-04-21T00:00:00.000Z",
      lastUsedAt: "2026-04-21T00:00:00.000Z",
      source: "previous_running",
    };
    (globalThis as typeof globalThis & { window?: unknown }).window = undefined;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          sessions: [],
          storedSessions: [],
          recentSessions: [],
          workspaceDirs: ["/workspace/current"],
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      )) as typeof fetch;
    useSessionStore.setState({
      projections: new Map(),
      storedSessions: [stoppedRef],
      recentSessions: [stoppedRef],
      storedSessionsCatalogLoaded: false,
      workspaceDirs: ["/workspace/current"],
      hiddenWorkspaceDirs: new Set<string>(),
      workspaceVisibilityVersion: 0,
      workspaceDir: "/workspace/current",
      selectedSessionId: null,
      pendingSessionAction: null,
      sessionTopologyVersion: 0,
    });

    try {
      await useSessionStore.getState().refreshWorkbenchState({ storedSessions: "recent" });

      const state = useSessionStore.getState();
      assert.equal(state.storedSessions[0]?.providerSessionId, "just-stopped");
      assert.equal(state.recentSessions[0]?.providerSessionId, "just-stopped");
    } finally {
      globalThis.fetch = originalFetch;
      (globalThis as typeof globalThis & { window?: unknown }).window = originalWindow;
      useSessionStore.setState(originalState, true);
    }
  });

  test("removing one history session preserves other local just-stopped refs", async () => {
    const originalState = useSessionStore.getState();
    const removedRef: StoredSessionRef = {
      provider: "codex",
      providerSessionId: "remove-me",
      rootDir: "/workspace/current",
      cwd: "/workspace/current",
      source: "previous_running",
    };
    const keptRef: StoredSessionRef = {
      provider: "codex",
      providerSessionId: "keep-me",
      rootDir: "/workspace/current",
      cwd: "/workspace/current",
      source: "previous_running",
    };
    (globalThis as typeof globalThis & { window?: unknown }).window = undefined;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          sessions: [],
          storedSessions: [],
          recentSessions: [],
          workspaceDirs: ["/workspace/current"],
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      )) as typeof fetch;
    useSessionStore.setState({
      projections: new Map(),
      storedSessions: [removedRef, keptRef],
      recentSessions: [removedRef, keptRef],
      storedSessionsCatalogLoaded: false,
      workspaceDirs: ["/workspace/current"],
      hiddenWorkspaceDirs: new Set<string>(),
      workspaceVisibilityVersion: 0,
      workspaceDir: "/workspace/current",
      selectedSessionId: null,
      pendingSessionAction: null,
      sessionTopologyVersion: 0,
    });

    try {
      await useSessionStore.getState().removeHistorySession(removedRef);

      const state = useSessionStore.getState();
      assert.deepEqual(
        state.storedSessions.map((session) => session.providerSessionId),
        ["keep-me"],
      );
      assert.deepEqual(
        state.recentSessions.map((session) => session.providerSessionId),
        ["keep-me"],
      );
    } finally {
      globalThis.fetch = originalFetch;
      (globalThis as typeof globalThis & { window?: unknown }).window = originalWindow;
      useSessionStore.setState(originalState, true);
    }
  });

  test("marks unselected sessions unread for meaningful events and clears the selected session", () => {
    const unread = computeUnreadSessionIds(
      new Set<string>(["session:selected"]),
      new Set<string>(["session:selected"]),
      [
        event("timeline.item.added", "session:other"),
        event("tool.call.completed", "session:other"),
        event("timeline.item.added", "session:selected"),
      ],
    );

    assert.deepEqual([...unread], ["session:other"]);
  });

  test("uses visible sessions instead of stale selection to suppress unread", () => {
    const unread = computeUnreadSessionIds(
      new Set<string>(),
      new Set<string>(["session:visible"]),
      [
        event("timeline.item.added", "session:stale-selected"),
        event("timeline.item.added", "session:visible"),
      ],
    );

    assert.deepEqual([...unread], ["session:stale-selected"]);
  });

  test("rebuilds unread from this browser last-seen state after foreground catch-up", () => {
    const originalState = useSessionStore.getState();
    installLocalStorageMock();
    try {
      const unreadProjection = projection("/workspace/unread");
      unreadProjection.feed = [
        {
          key: "assistant:unread",
          kind: "timeline",
          item: { kind: "assistant_message", text: "new reply" },
          ts: "2026-04-21T00:01:00.000Z",
        },
      ];
      const visibleProjection = projection("/workspace/visible");
      visibleProjection.feed = [
        {
          key: "assistant:visible",
          kind: "timeline",
          item: { kind: "assistant_message", text: "visible reply" },
          ts: "2026-04-21T00:02:00.000Z",
        },
      ];
      useSessionStore.setState({
        ...originalState,
        projections: new Map([
          [unreadProjection.summary.session.id, unreadProjection],
          [visibleProjection.summary.session.id, visibleProjection],
        ]),
        unreadSessionIds: new Set<string>(),
      });

      withMockedNow("2026-04-21T00:00:30.000Z", () => {
        useSessionStore
          .getState()
          .reconcileUnreadFromLastSeen([visibleProjection.summary.session.id]);
      });

      assert.deepEqual(
        [...useSessionStore.getState().unreadSessionIds],
        [unreadProjection.summary.session.id],
      );

      useSessionStore.getState().markSessionsRead([unreadProjection.summary.session.id]);

      assert.deepEqual([...useSessionStore.getState().unreadSessionIds], []);
    } finally {
      useSessionStore.setState(originalState, true);
      (globalThis as typeof globalThis & { window?: unknown }).window = originalWindow;
    }
  });

  test("does not mark stale transcript history unread on a fresh browser baseline", () => {
    const originalState = useSessionStore.getState();
    installLocalStorageMock();
    try {
      const staleProjection = projection("/workspace/stale");
      staleProjection.feed = [
        {
          key: "assistant:stale",
          kind: "timeline",
          item: { kind: "assistant_message", text: "old reply" },
          ts: "2026-04-21T00:01:00.000Z",
        },
      ];
      useSessionStore.setState({
        ...originalState,
        projections: new Map([[staleProjection.summary.session.id, staleProjection]]),
        unreadSessionIds: new Set<string>(),
      });

      withMockedNow("2026-04-21T00:05:00.000Z", () => {
        useSessionStore.getState().reconcileUnreadFromLastSeen([]);
      });

      assert.deepEqual([...useSessionStore.getState().unreadSessionIds], []);
    } finally {
      useSessionStore.setState(originalState, true);
      (globalThis as typeof globalThis & { window?: unknown }).window = originalWindow;
    }
  });

  test("keeps selectedSessionId as the only selection truth", () => {
    const projections = new Map<string, SessionProjection>([
      ["session:/workspace/a", projection("/workspace/a")],
      ["session:/workspace/b", projection("/workspace/b")],
    ]);

    assert.equal(coerceSelectedSessionId(projections, "session:/workspace/a"), "session:/workspace/a");
    assert.equal(coerceSelectedSessionId(projections, null), null);
    assert.equal(coerceSelectedSessionId(projections, "session:/workspace/missing"), null);
  });

  test("finds an existing daemon running session for a stored history entry", () => {
    const projections = new Map<string, SessionProjection>([
      ["session:/workspace/a", projection("/workspace/a")],
    ]);

    assert.equal(
      findDaemonRunningSessionForStoredRef(projections, liveStoredSessionRef("/workspace/a"))?.session.id,
      "session:/workspace/a",
    );
    assert.equal(
      findDaemonRunningSessionForStoredRef(projections, liveStoredSessionRef("/workspace/missing")),
      null,
    );
  });

  test("creates a projection immediately when a new running session arrives over the event stream", () => {
    const next = applyEventsToProjectionMap(
      new Map(),
      [
        {
          id: "session-started:new-live",
          seq: 1,
          ts: "2026-04-21T00:00:00.000Z",
          sessionId: "session:new-live",
          type: "session.started",
          source: {
            provider: "codex",
            channel: "structured_live",
            authority: "authoritative",
          },
          payload: {
            session: sessionSummary("/workspace/new-live").session,
          },
        } as RahEvent,
      ],
      {
        updateLastSeq: () => undefined,
        clearPendingSession: () => undefined,
        queuePendingEvent: () => undefined,
      },
    );

    assert.equal(next.get("session:new-live")?.summary.session.rootDir, "/workspace/new-live");
  });

  test("resolves history activation as select, attach, or resume", () => {
    const controlled = sessionSummary("/workspace/controlled");
    controlled.attachedClients = [
      {
        id: "web-current",
        kind: "web",
        sessionId: controlled.session.id,
        connectionId: "web-current",
        attachMode: "interactive",
        focus: true,
        lastSeenAt: controlled.session.updatedAt,
      },
    ];
    controlled.controlLease = {
      sessionId: controlled.session.id,
      holderClientId: "web-current",
      holderKind: "web",
      grantedAt: controlled.session.updatedAt,
    };

    const uncontrolled = sessionSummary("/workspace/uncontrolled");
    uncontrolled.attachedClients = [
      {
        id: "web-other",
        kind: "web",
        sessionId: uncontrolled.session.id,
        connectionId: "web-other",
        attachMode: "interactive",
        focus: true,
        lastSeenAt: uncontrolled.session.updatedAt,
      },
    ];
    uncontrolled.controlLease = {
      sessionId: uncontrolled.session.id,
      holderClientId: "web-other",
      holderKind: "web",
      grantedAt: uncontrolled.session.updatedAt,
    };

    assert.equal(
      resolveHistoryActivationMode({
        existingRunningSummary: controlled,
        clientId: "web-current",
      }),
      "select",
    );
    assert.equal(
      resolveHistoryActivationMode({
        existingRunningSummary: uncontrolled,
        clientId: "web-current",
      }),
      "attach",
    );
    assert.equal(
      resolveHistoryActivationMode({
        existingRunningSummary: null,
        clientId: "web-current",
      }),
      "resume",
    );
  });

  test("loads history when activating an already selected live projection from history", async () => {
    type ActivateDeps = Parameters<typeof activateHistorySessionCommand>[0];
    let historyLoadSessionId: string | null = null;
    const existingProjection = projection("/workspace/a");
    existingProjection.summary.attachedClients = [
      {
        id: "web-current",
        kind: "web",
        sessionId: existingProjection.summary.session.id,
        connectionId: "web-current",
        attachMode: "interactive",
        focus: true,
        lastSeenAt: existingProjection.summary.session.updatedAt,
      },
    ];
    existingProjection.summary.controlLease = {
      sessionId: existingProjection.summary.session.id,
      holderClientId: "web-current",
      holderKind: "web",
      grantedAt: existingProjection.summary.session.updatedAt,
    };
    let state = {
      clientId: "web-current",
      connectionId: "web-current",
      projections: new Map<string, SessionProjection>([
        ["session:/workspace/a", existingProjection],
      ]),
      unreadSessionIds: new Set<string>(),
      hiddenWorkspaceDirs: new Set<string>(),
      workspaceDirs: ["/workspace/a"],
      workspaceVisibilityVersion: 0,
      workspaceDir: "/workspace/a",
      selectedSessionId: null as string | null,
      newSessionProvider: "codex" as const,
      pendingSessionTransition: null,
      pendingSessionAction: null,
      storedSessions: [liveStoredSessionRef("/workspace/a")],
      recentSessions: [],
      error: null,
    };
    const deps: ActivateDeps = {
      get: () => state,
      set: (partial) => {
        const patch = typeof partial === "function" ? partial(state) : partial;
        state = { ...state, ...patch };
      },
      ensureConversationLoaded: async (sessionId) => {
        historyLoadSessionId = sessionId;
      },
      sendInput: async () => undefined,
      attachSession: async () => undefined,
      resumeStoredSession: async () => undefined,
      applySessionsResponse: (current) => ({
        ...current,
        storedSessions: state.storedSessions,
        recentSessions: state.recentSessions,
        workspaceDirs: state.workspaceDirs,
      }),
      adoptExistingProjectionForProviderSession: (projections) => projections,
      applyEventsToMap: (projections) => projections,
      takePendingEventsForSessions: () => [],
      confirmCreateMissingWorkspace: async () => true,
    };

    await activateHistorySessionCommand(deps, liveStoredSessionRef("/workspace/a"));

    assert.equal(state.selectedSessionId, "session:/workspace/a");
    assert.equal(historyLoadSessionId, "session:/workspace/a");
  });

  test("uses one shared web client id across tabs and devices", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem(key: string) {
        return values.get(key) ?? null;
      },
      setItem(key: string, value: string) {
        values.set(key, value);
      },
    };

    const first = readOrCreateClientId(storage);
    const second = readOrCreateClientId(storage);

    assert.equal(first, second);
    assert.equal(first, "web-user");
  });

  test("reuses the same web connection id across refreshes within one browser tab", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem(key: string) {
        return values.get(key) ?? null;
      },
      setItem(key: string, value: string) {
        values.set(key, value);
      },
    };

    const first = readOrCreateConnectionId(storage);
    const second = readOrCreateConnectionId(storage);

    assert.equal(first, second);
    assert.match(first, /^web-/);
  });
});

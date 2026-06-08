import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { RahEvent, SessionSummary, StoredSessionRef } from "@rah/runtime-protocol";
import * as api from "./api";
import {
  coerceSelectedSessionId,
  computeUnreadSessionIds,
  findDaemonRunningSessionForStoredRef,
  readOrCreateClientId,
  readOrCreateConnectionId,
  reconcileVisibleWorkspaceSelection,
  resolveHistoryActivationMode,
  resolveHiddenWorkspaceDirsFromSessionsResponse,
} from "./useSessionStore";
import { activateHistorySessionCommand } from "./session-store-session-startup";
import {
  adoptExistingProjectionForProviderSession,
  applyEventsToProjectionMap,
  applySessionsResponse,
  updateSessionSummaryInProjectionMap,
} from "./session-store-projections";
import {
  initialHistorySyncState,
  mergeHistoryItemDetailIntoProjection,
  type SessionProjection,
} from "./types";

const originalFetch = globalThis.fetch;
const originalWindow = (globalThis as typeof globalThis & { window?: unknown }).window;

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
    history: initialHistorySyncState(),
  };
}

function readOnlyHistoryProjection(rootDir: string): SessionProjection {
  const current = projection(rootDir);
  const { ptyId: _ptyId, ...sessionWithoutPty } = current.summary.session;
  return {
    ...current,
    summary: {
      ...current.summary,
      session: {
        ...sessionWithoutPty,
        status: "stopped",
        phase: "ended",
        runtimeState: "stopped",
        capabilities: {
          ...current.summary.session.capabilities,
          steerInput: false,
          livePermissions: false,
        },
      },
      attachedClients: [],
      controlLease: { sessionId: current.summary.session.id },
    },
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

  test("marks unselected sessions unread for meaningful events and clears the selected session", () => {
    const unread = computeUnreadSessionIds(
      new Set<string>(["session:selected"]),
      "session:selected",
      [
        event("timeline.item.added", "session:other"),
        event("tool.call.completed", "session:other"),
        event("timeline.item.added", "session:selected"),
      ],
    );

    assert.deepEqual([...unread], ["session:other"]);
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

  test("preserves selected read-only history projections across live session refreshes", () => {
    const history = readOnlyHistoryProjection("/workspace/history");
    const live = projection("/workspace/live");
    const state = {
      projections: new Map<string, SessionProjection>([
        [history.summary.session.id, history],
        [live.summary.session.id, live],
      ]),
      workspaceDir: "/workspace/history",
      selectedSessionId: history.summary.session.id,
      hiddenWorkspaceDirs: new Set<string>(),
      workspaceVisibilityVersion: 0,
    };
    const next = applySessionsResponse(
      state,
      {
        sessions: [live.summary],
        storedSessions: [],
        recentSessions: [],
        workspaceDirs: ["/workspace/live"],
      },
      {
        updateLastSeq: () => undefined,
        clearBufferedSession: () => undefined,
        queuePendingEvent: () => undefined,
        shouldDeferEvent: () => false,
        queueDeferredEvent: () => undefined,
        takePendingEventsForSessions: () => [],
      },
    );

    assert.equal(next.selectedSessionId, history.summary.session.id);
    assert.equal(next.projections.get(history.summary.session.id), history);
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
        clearBufferedSession: () => undefined,
        queuePendingEvent: () => undefined,
        shouldDeferEvent: () => false,
        queueDeferredEvent: () => undefined,
      },
    );

    assert.equal(next.get("session:new-live")?.summary.session.rootDir, "/workspace/new-live");
  });

  test("can preserve a read-only history projection while claim replaces it", () => {
    const history = readOnlyHistoryProjection("/workspace/history");
    const current = new Map([[history.summary.session.id, history]]);
    const next = applyEventsToProjectionMap(
      current,
      [event("session.closed", history.summary.session.id)],
      {
        updateLastSeq: () => undefined,
        clearBufferedSession: () => undefined,
        queuePendingEvent: () => undefined,
        shouldDeferEvent: () => false,
        queueDeferredEvent: () => undefined,
        shouldPreserveClosedSession: (_event, projection) => projection === history,
      },
    );

    assert.equal(next.get(history.summary.session.id), history);
  });

  test("resets read-only history event cursor when adopting a live session", () => {
    const history = {
      ...readOnlyHistoryProjection("/workspace/history"),
      lastSeq: 1_000_000_111,
      history: {
        phase: "ready" as const,
        nextCursor: "cursor-from-history",
        nextBeforeTs: "2026-04-20T00:00:00.000Z",
        generation: 2,
        authoritativeApplied: true,
        lastError: null,
      },
    };
    const liveSummary: SessionSummary = {
      ...sessionSummary("/workspace/live"),
      session: {
        ...sessionSummary("/workspace/live").session,
        providerSessionId: history.summary.session.providerSessionId,
      },
    };
    const adopted = adoptExistingProjectionForProviderSession(
      new Map([[history.summary.session.id, history]]),
      liveSummary,
    );
    const liveEvent: RahEvent = {
      id: "live-assistant-update",
      seq: 2,
      ts: "2026-04-21T00:00:02.000Z",
      sessionId: liveSummary.session.id,
      type: "timeline.item.updated",
      source: {
        provider: "codex",
        channel: "structured_live",
        authority: "derived",
      },
      payload: {
        item: {
          kind: "assistant_message",
          text: "live reply",
        },
        identity: {
          canonicalItemId: "live-assistant-1",
          provider: "codex",
          origin: "live",
          confidence: "derived",
        },
      },
    };

    const next = applyEventsToProjectionMap(adopted, [liveEvent], {
      updateLastSeq: () => undefined,
      clearBufferedSession: () => undefined,
      queuePendingEvent: () => undefined,
      shouldDeferEvent: () => false,
      queueDeferredEvent: () => undefined,
    });

    assert.equal(adopted.get(liveSummary.session.id)?.lastSeq, 0);
    assert.deepEqual(adopted.get(liveSummary.session.id)?.history, initialHistorySyncState());
    assert.equal(
      next.get(liveSummary.session.id)?.feed.some(
        (entry) =>
          entry.kind === "timeline" &&
          entry.item.kind === "assistant_message" &&
          entry.item.text === "live reply",
      ),
      true,
    );
  });

  test("merges history item detail even when its original seq is already behind projection", () => {
    const current: SessionProjection = {
      ...projection("/workspace/history"),
      lastSeq: 1_000_000_111,
      feed: [
        {
          key: "tool:tool-1",
          kind: "tool_call",
          toolCall: {
            id: "tool-1",
            family: "shell",
            providerToolName: "exec_command",
            title: "Run command",
            detailAvailable: true,
            detailSizeBytes: 42,
          },
          status: "completed",
          ts: "2026-04-21T00:00:01.000Z",
        },
      ],
    };
    const detailEvent: RahEvent = {
      id: "tool-detail",
      seq: 1,
      ts: "2026-04-21T00:00:01.000Z",
      sessionId: current.summary.session.id,
      type: "tool.call.completed",
      source: {
        provider: "codex",
        channel: "structured_persisted",
        authority: "authoritative",
      },
      payload: {
        toolCall: {
          id: "tool-1",
          family: "shell",
          providerToolName: "exec_command",
          title: "Run command",
          detail: {
            artifacts: [{ kind: "text", label: "stdout", text: "full output" }],
          },
        },
      },
    };

    const next = mergeHistoryItemDetailIntoProjection(current, [detailEvent]);
    const entry = next.feed[0];

    assert.equal(next.lastSeq, current.lastSeq);
    assert.equal(entry?.kind, "tool_call");
    if (entry?.kind !== "tool_call") {
      assert.fail("Expected tool call entry.");
    }
    assert.equal(entry.toolCall.detail?.artifacts[0]?.kind, "text");
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
      ensureSessionHistoryLoaded: async (sessionId) => {
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

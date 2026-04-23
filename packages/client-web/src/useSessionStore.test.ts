import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { RahEvent, SessionSummary, StoredSessionRef } from "@rah/runtime-protocol";
import {
  coerceSelectedSessionId,
  computeUnreadSessionIds,
  findDaemonLiveSessionForStoredRef,
  readOrCreateClientId,
  readOrCreateConnectionId,
  reconcileVisibleWorkspaceSelection,
  resolveHistoryActivationMode,
  resolveHiddenWorkspaceDirsFromSessionsResponse,
} from "./useSessionStore";
import { initialHistorySyncState, type SessionProjection } from "./types";

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

  test("finds an existing daemon live session for a stored history entry", () => {
    const projections = new Map<string, SessionProjection>([
      ["session:/workspace/a", projection("/workspace/a")],
    ]);

    assert.equal(
      findDaemonLiveSessionForStoredRef(projections, liveStoredSessionRef("/workspace/a"))?.session.id,
      "session:/workspace/a",
    );
    assert.equal(
      findDaemonLiveSessionForStoredRef(projections, liveStoredSessionRef("/workspace/missing")),
      null,
    );
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
        existingLiveSummary: controlled,
        clientId: "web-current",
      }),
      "select",
    );
    assert.equal(
      resolveHistoryActivationMode({
        existingLiveSummary: uncontrolled,
        clientId: "web-current",
      }),
      "attach",
    );
    assert.equal(
      resolveHistoryActivationMode({
        existingLiveSummary: null,
        clientId: "web-current",
      }),
      "resume",
    );
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

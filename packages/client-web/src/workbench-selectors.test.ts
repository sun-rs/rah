import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { SessionSummary, StoredSessionRef } from "@rah/runtime-protocol";
import { initialHistorySyncState, type FeedEntry, type SessionProjection } from "./types";
import {
  derivePrimaryPaneState,
  deriveWorkbenchSessionCollections,
  isSessionAttachedToClient,
} from "./workbench-selectors";
import type { PendingSessionTransition } from "./session-transition-contract";

function baseSummary(): SessionSummary {
  return {
    session: {
      id: "session-1",
      provider: "opencode",
      providerSessionId: "provider-1",
      launchSource: "web",
      cwd: "/workspace/rah",
      rootDir: "/workspace/rah",
      runtimeState: "running",
      ptyId: "pty-1",
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
      createdAt: "2026-04-15T00:00:00.000Z",
      updatedAt: "2026-04-15T00:00:00.000Z",
    },
    attachedClients: [],
    controlLease: { sessionId: "session-1" },
  };
}

function projection(summary: SessionSummary, feed: FeedEntry[] = []): SessionProjection {
  return {
    summary,
    feed,
    events: [],
    lastSeq: 0,
    history: initialHistorySyncState(),
  };
}

function messageEntry(
  sessionId: string,
  kind: "user_message" | "assistant_message",
  text: string,
  ts: string,
): FeedEntry {
  return {
    key: `${sessionId}:${kind}:${ts}`,
    kind: "timeline",
    item: { kind, text },
    ts,
  } as FeedEntry;
}

function controlledSummary(args: {
  id: string;
  clientId: string;
  rootDir: string;
  updatedAt?: string;
}): SessionSummary {
  return {
    ...baseSummary(),
    session: {
      ...baseSummary().session,
      id: args.id,
      providerSessionId: `${args.id}-provider`,
      rootDir: args.rootDir,
      cwd: args.rootDir,
      updatedAt: args.updatedAt ?? baseSummary().session.updatedAt,
    },
    attachedClients: [
      {
        id: args.clientId,
        kind: "web",
        sessionId: args.id,
        connectionId: args.clientId,
        attachMode: "interactive",
        focus: true,
        lastSeenAt: args.updatedAt ?? baseSummary().session.updatedAt,
      },
    ],
    controlLease: {
      sessionId: args.id,
      holderClientId: args.clientId,
      holderKind: "web",
      grantedAt: args.updatedAt ?? baseSummary().session.updatedAt,
    },
  };
}

function uncontrolledSummary(args: {
  id: string;
  clientId: string;
  otherClientId: string;
  rootDir: string;
}): SessionSummary {
  return {
    ...baseSummary(),
    session: {
      ...baseSummary().session,
      id: args.id,
      providerSessionId: `${args.id}-provider`,
      rootDir: args.rootDir,
      cwd: args.rootDir,
    },
    attachedClients: [
      {
        id: args.otherClientId,
        kind: "web",
        sessionId: args.id,
        connectionId: args.otherClientId,
        attachMode: "interactive",
        focus: true,
        lastSeenAt: baseSummary().session.updatedAt,
      },
    ],
    controlLease: {
      sessionId: args.id,
      holderClientId: args.otherClientId,
      holderKind: "web",
      grantedAt: baseSummary().session.updatedAt,
    },
  };
}

describe("workbench selectors", () => {
  test("treats shared web client attachment as stable across connection ids", () => {
    const summary = controlledSummary({
      id: "web-live",
      clientId: "web-user",
      rootDir: "/workspace/one",
    });
    summary.attachedClients[0] = {
      ...summary.attachedClients[0]!,
      connectionId: "web-old-connection",
    };

    assert.equal(isSessionAttachedToClient(summary, "web-user"), true);
    assert.equal(isSessionAttachedToClient(summary, "web-new-connection"), false);
  });

  test("sidebar contract includes all daemon running sessions while keeping controlled subsets narrow", () => {
    const clientId = "web-current";
    const controlled = controlledSummary({
      id: "controlled-1",
      clientId,
      rootDir: "/workspace/one",
    });
    const uncontrolled = uncontrolledSummary({
      id: "uncontrolled-1",
      clientId,
      otherClientId: "web-other",
      rootDir: "/workspace/two",
    });
    const projections = new Map([
      [controlled.session.id, projection(controlled)],
      [uncontrolled.session.id, projection(uncontrolled)],
    ]);

    const collections = deriveWorkbenchSessionCollections({
      projections,
      clientId,
      workspaceDirs: ["/workspace/one", "/workspace/two"],
      storedSessions: [],
      workspaceDir: "/workspace/one",
      workspaceSortMode: "created",
    });

    assert.deepEqual(
      collections.controlledRunningSessionEntries.map((entry) => entry.summary.session.id),
      ["controlled-1"],
    );
    assert.equal(
      collections.daemonRunningSessionByProviderSessionId.get("uncontrolled-1-provider")?.session.id,
      "uncontrolled-1",
    );
    assert.equal(
      collections.controlledRunningSessionByProviderSessionId.get("uncontrolled-1-provider"),
      undefined,
    );
    assert.deepEqual(
      collections.workspaceSections.flatMap((section) =>
        section.sessions.map((session) => session.session.id),
      ),
      ["controlled-1", "uncontrolled-1"],
    );
    assert.equal(
      collections.workspaceSections.find(
        (section) => section.workspace.directory === "/workspace/two",
      )?.sessions.length,
      1,
    );
    assert.equal(
      collections.workspaceSections.find(
        (section) => section.workspace.directory === "/workspace/two",
      )?.workspace.hasBlockingRunningSessions,
      true,
    );
  });

  test("uses visible session activity for updated workspace ordering", () => {
    const clientId = "web-current";
    const backgroundRefresh = controlledSummary({
      id: "background-refresh",
      clientId,
      rootDir: "/workspace/one",
      updatedAt: "2026-05-01T10:59:00.000Z",
    });
    const humanActivity = controlledSummary({
      id: "human-activity",
      clientId,
      rootDir: "/workspace/two",
      updatedAt: "2026-05-01T10:02:00.000Z",
    });

    const collections = deriveWorkbenchSessionCollections({
      projections: new Map([
        [
          backgroundRefresh.session.id,
          projection(backgroundRefresh, [
            messageEntry(
              backgroundRefresh.session.id,
              "assistant_message",
              "older answer",
              "2026-05-01T10:01:00.000Z",
            ),
          ]),
        ],
        [
          humanActivity.session.id,
          projection(humanActivity, [
            messageEntry(
              humanActivity.session.id,
              "user_message",
              "newer question",
              "2026-05-01T10:10:00.000Z",
            ),
          ]),
        ],
      ]),
      clientId,
      workspaceDirs: ["/workspace/one", "/workspace/two"],
      storedSessions: [],
      workspaceDir: "/workspace/one",
      workspaceSortMode: "updated",
    });

    assert.equal(
      collections.runningSessionActivityAtById.get("background-refresh"),
      "2026-05-01T10:01:00.000Z",
    );
    assert.deepEqual(
      collections.sortedWorkspaceInfos.map((workspace) => workspace.directory),
      ["/workspace/two", "/workspace/one"],
    );
    assert.deepEqual(
      collections.workspaceSections.flatMap((section) =>
        section.sessions.map((session) => session.session.id),
      ),
      ["human-activity", "background-refresh"],
    );
  });

  test("ignores stored history activity when sorting live sidebar workspaces", () => {
    const clientId = "web-current";
    const liveValar = controlledSummary({
      id: "live-valar",
      clientId,
      rootDir: "/workspace/repos/valar",
      updatedAt: "2026-05-01T10:10:00.000Z",
    });
    const newerStoredCodeSession: StoredSessionRef = {
      provider: "codex",
      providerSessionId: "stored-code",
      cwd: "/workspace/code",
      rootDir: "/workspace/code",
      title: "newer archived session",
      updatedAt: "2026-05-01T10:59:00.000Z",
      lastUsedAt: "2026-05-01T10:59:00.000Z",
      source: "provider_history",
    };

    const collections = deriveWorkbenchSessionCollections({
      projections: new Map([
        [
          liveValar.session.id,
          projection(liveValar, [
            messageEntry(
              liveValar.session.id,
              "assistant_message",
              "live reply",
              "2026-05-01T10:10:00.000Z",
            ),
          ]),
        ],
      ]),
      clientId,
      workspaceDirs: ["/workspace/code", "/workspace/repos/valar"],
      storedSessions: [newerStoredCodeSession],
      workspaceDir: "/workspace/repos/valar",
      workspaceSortMode: "updated",
    });

    assert.deepEqual(
      collections.sortedWorkspaceInfos.map((workspace) => workspace.directory),
      ["/workspace/repos/valar", "/workspace/code"],
    );
  });

  test("seeds live workspace ordering from matching stored history before feed loads", () => {
    const clientId = "web-current";
    const liveValar = controlledSummary({
      id: "live-valar",
      clientId,
      rootDir: "/workspace/repos/valar",
      updatedAt: "2026-05-01T10:01:00.000Z",
    });
    liveValar.session.provider = "codex";
    liveValar.session.providerSessionId = "codex-valar";
    const liveSolars = controlledSummary({
      id: "live-solars",
      clientId,
      rootDir: "/workspace/code/solars",
      updatedAt: "2026-05-01T10:20:00.000Z",
    });
    liveSolars.session.provider = "codex";
    liveSolars.session.providerSessionId = "codex-solars";

    const storedValar: StoredSessionRef = {
      provider: "codex",
      providerSessionId: "codex-valar",
      cwd: "/workspace/repos/valar",
      rootDir: "/workspace/repos/valar",
      title: "valar",
      updatedAt: "2026-05-01T10:15:00.000Z",
      source: "provider_history",
    };
    const storedSolars: StoredSessionRef = {
      provider: "codex",
      providerSessionId: "codex-solars",
      cwd: "/workspace/code/solars",
      rootDir: "/workspace/code/solars",
      title: "solars",
      updatedAt: "2026-05-01T10:05:00.000Z",
      source: "provider_history",
    };

    const initial = deriveWorkbenchSessionCollections({
      projections: new Map([
        [liveValar.session.id, projection(liveValar)],
        [liveSolars.session.id, projection(liveSolars)],
      ]),
      clientId,
      workspaceDirs: ["/workspace/repos/valar", "/workspace/code/solars"],
      storedSessions: [storedSolars, storedValar],
      workspaceDir: "/workspace/code/solars",
      workspaceSortMode: "updated",
    });

    assert.deepEqual(
      initial.sortedWorkspaceInfos.map((workspace) => workspace.directory),
      ["/workspace/repos/valar", "/workspace/code/solars"],
    );
    assert.equal(
      initial.runningSessionActivityAtById.get("live-valar"),
      "2026-05-01T10:15:00.000Z",
    );

    const afterHistoryTailLoads = deriveWorkbenchSessionCollections({
      projections: new Map([
        [
          liveValar.session.id,
          projection(liveValar, [
            messageEntry(
              liveValar.session.id,
              "assistant_message",
              "latest valar reply",
              "2026-05-01T10:15:00.000Z",
            ),
          ]),
        ],
        [
          liveSolars.session.id,
          projection(liveSolars, [
            messageEntry(
              liveSolars.session.id,
              "assistant_message",
              "latest solars reply",
              "2026-05-01T10:05:00.000Z",
            ),
          ]),
        ],
      ]),
      clientId,
      workspaceDirs: ["/workspace/repos/valar", "/workspace/code/solars"],
      storedSessions: [storedSolars, storedValar],
      workspaceDir: "/workspace/code/solars",
      workspaceSortMode: "updated",
    });

    assert.deepEqual(
      afterHistoryTailLoads.sortedWorkspaceInfos.map((workspace) => workspace.directory),
      initial.sortedWorkspaceInfos.map((workspace) => workspace.directory),
    );

    const withNewLiveMessage = deriveWorkbenchSessionCollections({
      projections: new Map([
        [
          liveValar.session.id,
          projection(liveValar, [
            messageEntry(
              liveValar.session.id,
              "assistant_message",
              "new live valar reply",
              "2026-05-01T10:25:00.000Z",
            ),
          ]),
        ],
        [liveSolars.session.id, projection(liveSolars)],
      ]),
      clientId,
      workspaceDirs: ["/workspace/repos/valar", "/workspace/code/solars"],
      storedSessions: [storedSolars, storedValar],
      workspaceDir: "/workspace/code/solars",
      workspaceSortMode: "updated",
    });

    assert.equal(
      withNewLiveMessage.runningSessionActivityAtById.get("live-valar"),
      "2026-05-01T10:25:00.000Z",
    );
  });

  test("excludes exited native TUI sessions from running collections", () => {
    const clientId = "web-current";
    const stopped = controlledSummary({
      id: "stopped-native",
      clientId,
      rootDir: "/workspace/one",
    });
    stopped.session.liveBackend = "native_tui";
    stopped.session.runtimeState = "stopped";
    stopped.session.capabilities = {
      ...stopped.session.capabilities,
      steerInput: false,
      rawPtyInput: false,
      liveAttach: false,
    };
    const active = controlledSummary({
      id: "active-native",
      clientId,
      rootDir: "/workspace/one",
    });
    active.session.liveBackend = "native_tui";

    const collections = deriveWorkbenchSessionCollections({
      projections: new Map([
        [stopped.session.id, projection(stopped)],
        [active.session.id, projection(active)],
      ]),
      clientId,
      workspaceDirs: ["/workspace/one"],
      storedSessions: [],
      workspaceDir: "/workspace/one",
      workspaceSortMode: "created",
    });

    assert.deepEqual(
      collections.runningSessionEntries.map((entry) => entry.summary.session.id),
      ["active-native"],
    );
  });

  test("prefers active surface over opening and falls back to opening then empty", () => {
    const pendingTransition: PendingSessionTransition = {
      kind: "history",
      provider: "opencode",
      title: "Restoring",
      cwd: "/workspace/rah",
    };

    assert.equal(
      derivePrimaryPaneState({
        selectedSummary: baseSummary(),
        pendingSessionTransition: pendingTransition,
      }).kind,
      "active",
    );

    const launchOpening = derivePrimaryPaneState({
      selectedSummary: null,
      pendingSessionTransition: {
        kind: "new",
        provider: "codex",
        cwd: "/workspace/new",
        title: "New session",
      },
    });
    assert.equal(launchOpening.kind, "opening");
    assert.equal(launchOpening.openingSession?.kind, "new");
    assert.equal(launchOpening.openingSession?.provider, "codex");

    const claimFallback = derivePrimaryPaneState({
      selectedSummary: null,
      pendingSessionTransition: {
        kind: "claim_history",
        provider: "codex",
        providerSessionId: "thread-1",
        title: "Claiming history",
      },
    });
    assert.equal(claimFallback.kind, "opening");
    assert.equal(claimFallback.openingSession?.kind, "claim_history");

    assert.equal(
      derivePrimaryPaneState({
        selectedSummary: null,
        pendingSessionTransition: null,
      }).kind,
      "empty",
    );
  });
});

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { SessionSummary } from "@rah/runtime-protocol";
import { initialHistorySyncState, type SessionProjection } from "./types";
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

function projection(summary: SessionSummary): SessionProjection {
  return {
    summary,
    feed: [],
    events: [],
    lastSeq: 0,
    history: initialHistorySyncState(),
  };
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

    assert.equal(
      derivePrimaryPaneState({
        selectedSummary: null,
        pendingSessionTransition: null,
      }).kind,
      "empty",
    );
  });
});

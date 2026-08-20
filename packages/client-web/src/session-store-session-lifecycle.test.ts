import { test } from "node:test";
import assert from "node:assert/strict";
import type { SessionSummary } from "@rah/runtime-protocol";
import {
  applyClosedSessionState,
  isPendingResumeProjectionTransferTarget,
  mergeResumedHistoryProjection,
  mergeStartedSessionProjection,
} from "./session-store-session-lifecycle";
import { type FeedEntry, type SessionProjection } from "./types";

function summary(): SessionSummary {
  return {
    session: {
      id: "session-1",
      provider: "codex",
      providerSessionId: "provider-1",
      launchSource: "web",
      status: "running",
      phase: "ready",
      cwd: "/workspace/rah",
      rootDir: "/workspace/rah",
      runtimeState: "idle",
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
      createdAt: "2026-05-01T10:00:00.000Z",
      updatedAt: "2026-05-01T10:59:00.000Z",
    },
    attachedClients: [],
    controlLease: { sessionId: "session-1" },
  };
}

function projection(sessionSummary: SessionSummary): SessionProjection {
  return {
    summary: sessionSummary,
    feed: [
      {
        key: "assistant:answer",
        kind: "timeline",
        item: { kind: "assistant_message", text: "done" },
        ts: "2026-05-01T10:04:00.000Z",
      } as FeedEntry,
      {
        key: "runtime:status",
        kind: "runtime_status",
        status: "thinking",
        ts: "2026-05-01T10:59:00.000Z",
      } as FeedEntry,
    ],
    events: [],
    lastSeq: 0,
  };
}

test("defers automatic history loading for the live target of a pending Resume transfer", () => {
  const history = summary();
  history.session.id = "history";
  const live: SessionSummary = {
    ...summary(),
    session: {
      ...summary().session,
      id: "live",
    },
  };
  const state = {
    projections: new Map([
      ["history", projection(history)],
      ["live", projection(live)],
    ]),
    pendingSessionAction: {
      kind: "resume_history" as const,
      sessionId: "history",
      provider: "codex" as const,
      providerSessionId: "provider-1",
    },
  };

  assert.equal(isPendingResumeProjectionTransferTarget(state, "history"), false);
  assert.equal(isPendingResumeProjectionTransferTarget(state, "live"), true);
  state.projections.delete("history");
  assert.equal(isPendingResumeProjectionTransferTarget(state, "live"), true);
  live.session.providerSessionId = "provider-2";
  assert.equal(isPendingResumeProjectionTransferTarget(state, "live"), false);
});

test("resume HTTP completion cannot roll an event-fresh live projection backwards", () => {
  const preservedSummary = summary();
  preservedSummary.session.id = "history";
  preservedSummary.session.status = "stopped";
  preservedSummary.session.phase = "ended";
  preservedSummary.session.runtimeState = "stopped";
  const preserved = projection(preservedSummary);

  const eventSummary = summary();
  eventSummary.session.id = "live";
  eventSummary.session.status = "running";
  eventSummary.session.phase = "working";
  eventSummary.session.runtimeState = "running";
  eventSummary.session.updatedAt = "2026-05-01T11:00:02.000Z";
  eventSummary.session.nativeTui = {
    terminalId: "live",
    viewAvailable: true,
    promptState: "prompt_clean",
    queuedInputCount: 0,
  };
  eventSummary.session.capabilities.nativeTui = true;
  eventSummary.attachedClients = [];
  eventSummary.controlLease = { sessionId: "live" };
  const live = projection(eventSummary);
  live.lastSeq = 42;
  live.currentRuntimeStatus = "thinking";

  const responseSummary = summary();
  responseSummary.session.id = "live";
  responseSummary.session.status = "running";
  responseSummary.session.phase = "ready";
  responseSummary.session.runtimeState = "idle";
  // Equal timestamps are possible because lifecycle mutations can share a
  // millisecond. A projection with applied event sequence still wins the tie.
  responseSummary.session.updatedAt = "2026-05-01T11:00:02.000Z";
  delete responseSummary.session.nativeTui;
  responseSummary.session.capabilities.nativeTui = false;
  responseSummary.attachedClients = [
    {
      id: "web-client",
      kind: "web",
      sessionId: "live",
      connectionId: "web-connection",
      attachMode: "interactive",
      focus: true,
      lastSeenAt: "2026-05-01T11:00:03.000Z",
    },
  ];
  responseSummary.controlLease = {
    sessionId: "live",
    holderClientId: "web-client",
    holderKind: "web",
    grantedAt: "2026-05-01T11:00:03.000Z",
  };

  const merged = mergeResumedHistoryProjection(
    responseSummary,
    preserved,
    live,
  );

  assert.equal(merged.summary.session.phase, "working");
  assert.equal(merged.summary.session.runtimeState, "running");
  assert.equal(merged.summary.session.nativeTui?.viewAvailable, true);
  assert.equal(merged.summary.attachedClients[0]?.id, "web-client");
  assert.equal(merged.summary.controlLease.holderClientId, "web-client");
  assert.equal(merged.currentRuntimeStatus, "thinking");
});

test("New Task handoff keeps the canonical live conversation over a temporary projection error", () => {
  const provisionalSummary = summary();
  provisionalSummary.session.id = "starting-session:client-1";
  provisionalSummary.session.providerSessionId = undefined;
  provisionalSummary.session.phase = "starting";
  const provisional = projection(provisionalSummary);
  provisional.conversation = {
    phase: "error",
    loadedScope: "live",
    turns: [],
    nextCursor: null,
    revision: 1,
    daemonRevision: null,
    pendingDeltas: [],
    needsRefresh: false,
    approximateBytes: 0,
    sourceRevision: null,
    loadedAt: null,
    lastError: "temporary Session not found",
  };

  const liveSummary = summary();
  liveSummary.session.id = "live";
  const live = projection(liveSummary);
  live.conversation = {
    phase: "ready",
    loadedScope: "live",
    turns: [
      {
        id: "turn-1",
        provider: "codex",
        status: "completed",
        statusAuthority: "native",
        identityConfidence: "authoritative",
        items: [],
        activities: [],
        failedItemCount: 0,
      },
    ],
    nextCursor: null,
    revision: 4,
    daemonRevision: 4,
    pendingDeltas: [],
    needsRefresh: false,
    approximateBytes: 512,
    sourceRevision: null,
    loadedAt: "2026-05-01T11:00:00.000Z",
    lastError: null,
  };

  const merged = mergeStartedSessionProjection(liveSummary, provisional, live);

  assert.equal(merged.conversation, live.conversation);
  assert.equal(merged.conversation?.turns[0]?.id, "turn-1");
  assert.equal(merged.conversation?.lastError, null);
});

test("remembers closed sessions using visible conversation activity, not runtime updatedAt", () => {
  const sessionSummary = summary();
  const next = applyClosedSessionState(
    {
      projections: new Map([[sessionSummary.session.id, projection(sessionSummary)]]),
      unreadSessionIds: new Set(),
      hiddenWorkspaceDirs: new Set(),
      workspaceDirs: ["/workspace/rah"],
      workspaceVisibilityVersion: 0,
      workspaceDir: "/workspace/rah",
      selectedSessionId: sessionSummary.session.id,
      newSessionProvider: "codex",
      error: null,
      pendingSessionTransition: null,
      pendingSessionAction: null,
      storedSessions: [],
      recentSessions: [],
    },
    sessionSummary.session.id,
    sessionSummary,
  );

  assert.equal(next.recentSessions[0]?.lastUsedAt, "2026-05-01T10:04:00.000Z");
  assert.equal(next.storedSessions[0]?.updatedAt, "2026-05-01T10:04:00.000Z");
  assert.equal(next.selectedSessionId, "session-1");
  assert.equal(next.projections.get("session-1")?.summary.session.status, "stopped");
  assert.equal(next.projections.get("session-1")?.summary.session.phase, "ended");
  assert.equal(
    next.projections.get("session-1")?.summary.session.capabilities.steerInput,
    false,
  );
  assert.deepEqual(
    next.projections.get("session-1")?.feed.map((entry) => entry.key),
    ["assistant:answer", "runtime:status"],
  );
  assert.equal(next.projections.get("session-1")?.currentRuntimeStatus, undefined);
});

test("removes a stopped live projection when it was not the selected chat", () => {
  const sessionSummary = summary();
  const next = applyClosedSessionState(
    {
      projections: new Map([[sessionSummary.session.id, projection(sessionSummary)]]),
      unreadSessionIds: new Set(),
      hiddenWorkspaceDirs: new Set(),
      workspaceDirs: ["/workspace/rah"],
      workspaceVisibilityVersion: 0,
      sessionTopologyVersion: 0,
      workspaceDir: "/workspace/rah",
      selectedSessionId: "another-session",
      newSessionProvider: "codex",
      error: null,
      pendingSessionTransition: null,
      pendingSessionAction: null,
      storedSessions: [],
      recentSessions: [],
    },
    sessionSummary.session.id,
    sessionSummary,
  );

  assert.equal(next.projections.has(sessionSummary.session.id), false);
  assert.equal(next.selectedSessionId, "another-session");
});

test("keeps the selected stopped chat when the close event removed it before the HTTP response", () => {
  const sessionSummary = summary();
  const originalProjection = projection(sessionSummary);
  const next = applyClosedSessionState(
    {
      projections: new Map(),
      unreadSessionIds: new Set(),
      hiddenWorkspaceDirs: new Set(),
      workspaceDirs: ["/workspace/rah"],
      workspaceVisibilityVersion: 0,
      sessionTopologyVersion: 1,
      workspaceDir: "/workspace/rah",
      selectedSessionId: sessionSummary.session.id,
      newSessionProvider: "codex",
      error: null,
      pendingSessionTransition: null,
      pendingSessionAction: null,
      storedSessions: [],
      recentSessions: [],
    },
    sessionSummary.session.id,
    sessionSummary,
    originalProjection,
  );

  assert.equal(next.selectedSessionId, sessionSummary.session.id);
  assert.equal(next.projections.get(sessionSummary.session.id)?.summary.session.status, "stopped");
  assert.equal(next.projections.get(sessionSummary.session.id)?.feed[0]?.key, "assistant:answer");
});

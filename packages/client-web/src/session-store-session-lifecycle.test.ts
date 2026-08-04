import { test } from "node:test";
import assert from "node:assert/strict";
import type { SessionSummary } from "@rah/runtime-protocol";
import {
  applyClosedSessionState,
  isPendingResumeProjectionTransferTarget,
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

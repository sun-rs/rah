import { test } from "node:test";
import assert from "node:assert/strict";
import type { SessionSummary } from "@rah/runtime-protocol";
import { applyClosedSessionState } from "./session-store-session-lifecycle";
import { initialHistorySyncState, type FeedEntry, type SessionProjection } from "./types";

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
    history: initialHistorySyncState(),
  };
}

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
});

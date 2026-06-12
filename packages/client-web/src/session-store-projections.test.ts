import assert from "node:assert/strict";
import { test } from "node:test";
import type { ListSessionsResponse, SessionSummary, StoredSessionRef } from "@rah/runtime-protocol";
import {
  createPendingStoredReplayProjection,
  storedReplayPlaceholderSessionId,
} from "./session-store-session-lifecycle";
import { replaceSessionsResponse } from "./session-store-projections";
import type { SessionProjection } from "./types";

function sessionsResponse(sessions: SessionSummary[] = []): ListSessionsResponse {
  return {
    sessions,
    storedSessions: [],
    recentSessions: [],
    workspaceDirs: ["/tmp/rah"],
  };
}

function summary(id: string, providerSessionId: string): SessionSummary {
  return {
    session: {
      id,
      provider: "codex",
      providerSessionId,
      launchSource: "web",
      status: "stopped",
      phase: "ended",
      cwd: "/tmp/rah",
      rootDir: "/tmp/rah",
      runtimeState: "stopped",
      ptyId: `pty-${id}`,
      capabilities: {
        liveAttach: false,
        structuredTimeline: true,
        nativeTui: false,
        rawPtyInput: false,
        chatMirror: false,
        structuredControl: false,
        livePermissions: false,
        contextUsage: false,
        resumeByProvider: true,
        listProviderSessions: true,
        renameSession: true,
        actions: { info: true, stop: false, delete: true, rename: "native" },
        steerInput: false,
        queuedInput: false,
        modelSwitch: false,
        planMode: false,
        subagents: false,
      },
      createdAt: "2026-06-06T12:00:00.000Z",
      updatedAt: "2026-06-06T12:00:00.000Z",
    },
    attachedClients: [],
    controlLease: { sessionId: id },
  };
}

test("replaceSessionsResponse keeps a pending stored replay projection until the server returns it", () => {
  const ref: StoredSessionRef = {
    provider: "codex",
    providerSessionId: "thread-1",
    cwd: "/tmp/rah",
    rootDir: "/tmp/rah",
    title: "Large history",
  };
  const provisionalId = storedReplayPlaceholderSessionId(ref);
  const projections = new Map<string, SessionProjection>([
    [provisionalId, createPendingStoredReplayProjection(ref)],
  ]);

  const next = replaceSessionsResponse(
    {
      projections,
      workspaceDir: "/tmp/rah",
      selectedSessionId: provisionalId,
      hiddenWorkspaceDirs: new Set<string>(),
      workspaceVisibilityVersion: 0,
    },
    sessionsResponse(),
  );

  assert.equal(next.projections.has(provisionalId), true);
  assert.equal(next.selectedSessionId, provisionalId);
});

test("replaceSessionsResponse drops pending stored replay projection once the real replay exists", () => {
  const ref: StoredSessionRef = {
    provider: "codex",
    providerSessionId: "thread-1",
    cwd: "/tmp/rah",
    rootDir: "/tmp/rah",
  };
  const provisionalId = storedReplayPlaceholderSessionId(ref);
  const projections = new Map<string, SessionProjection>([
    [provisionalId, createPendingStoredReplayProjection(ref)],
  ]);

  const next = replaceSessionsResponse(
    {
      projections,
      workspaceDir: "/tmp/rah",
      selectedSessionId: provisionalId,
      hiddenWorkspaceDirs: new Set<string>(),
      workspaceVisibilityVersion: 0,
    },
    sessionsResponse([summary("real-replay", "thread-1")]),
  );

  assert.equal(next.projections.has(provisionalId), false);
  assert.equal(next.projections.has("real-replay"), true);
  assert.equal(next.selectedSessionId, "real-replay");
});

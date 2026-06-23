import assert from "node:assert/strict";
import { test } from "node:test";
import type { ListSessionsResponse, SessionSummary, StoredSessionRef } from "@rah/runtime-protocol";
import {
  createPendingStoredReplayProjection,
  storedReplayPlaceholderSessionId,
} from "./session-store-session-lifecycle";
import { applySessionsResponse, replaceSessionsResponse } from "./session-store-projections";
import type { SessionProjection } from "./types";

function sessionsResponse(
  sessions: SessionSummary[] = [],
  workspaceDirs: string[] = ["/tmp/rah"],
): ListSessionsResponse {
  return {
    sessions,
    storedSessions: [],
    recentSessions: [],
    workspaceDirs,
  };
}

function summary(
  id: string,
  providerSessionId: string,
  options?: {
    rootDir?: string;
    running?: boolean;
  },
): SessionSummary {
  const rootDir = options?.rootDir ?? "/tmp/rah";
  const running = options?.running === true;
  return {
    session: {
      id,
      provider: "codex",
      providerSessionId,
      launchSource: "web",
      status: running ? "running" : "stopped",
      phase: running ? "waiting_input" : "ended",
      cwd: rootDir,
      rootDir,
      runtimeState: running ? "idle" : "stopped",
      ptyId: `pty-${id}`,
      capabilities: {
        liveAttach: running,
        structuredTimeline: true,
        nativeTui: false,
        rawPtyInput: false,
        chatMirror: false,
        structuredControl: running,
        livePermissions: running,
        contextUsage: false,
        resumeByProvider: true,
        listProviderSessions: true,
        renameSession: true,
        actions: { info: true, stop: running, delete: true, rename: "native" },
        steerInput: running,
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

const replayNoop = {
  takePendingEventsForSessions: () => [],
  updateLastSeq: () => undefined,
  clearBufferedSession: () => undefined,
  queuePendingEvent: () => undefined,
  shouldDeferEvent: () => false,
  queueDeferredEvent: () => undefined,
};

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

test("applySessionsResponse derives missing workspace dirs from running session projections", () => {
  const next = applySessionsResponse(
    {
      projections: new Map<string, SessionProjection>(),
      workspaceDir: "/workspace/existing",
      selectedSessionId: null,
      hiddenWorkspaceDirs: new Set<string>(),
      workspaceVisibilityVersion: 0,
    },
    sessionsResponse(
      [summary("new-session", "thread-new", { rootDir: "/workspace/new", running: true })],
      ["/workspace/existing"],
    ),
    replayNoop,
  );

  assert.deepEqual(next.workspaceDirs, ["/workspace/existing", "/workspace/new"]);
});

test("replaceSessionsResponse derives missing workspace dirs from running session projections", () => {
  const next = replaceSessionsResponse(
    {
      projections: new Map<string, SessionProjection>(),
      workspaceDir: "/workspace/existing",
      selectedSessionId: null,
      hiddenWorkspaceDirs: new Set<string>(),
      workspaceVisibilityVersion: 0,
    },
    sessionsResponse(
      [summary("new-session", "thread-new", { rootDir: "/workspace/new", running: true })],
      ["/workspace/existing"],
    ),
  );

  assert.deepEqual(next.workspaceDirs, ["/workspace/existing", "/workspace/new"]);
});

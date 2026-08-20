import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  ListSessionsResponse,
  RahEvent,
  SessionSummary,
  StoredSessionRef,
} from "@rah/runtime-protocol";
import {
  createPendingStoredReplayProjection,
  storedReplayPlaceholderSessionId,
} from "./session-store-session-lifecycle";
import {
  applyEventsToProjectionMap,
  applySessionsResponse,
  replaceSessionsResponse,
} from "./session-store-projections";
import { appendOptimisticUserMessage, type SessionProjection } from "./types";

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
  clearPendingSession: () => undefined,
  queuePendingEvent: () => undefined,
};

function projectionWithQueuedInput(
  state: "queued" | "submitting" = "queued",
): SessionProjection {
  const queuedSummary = summary("queued-session", "queued-thread", { running: true });
  queuedSummary.session.capabilities.queuedInput = true;
  queuedSummary.session.inputQueue = [
    {
      clientMessageId: "queued-message",
      clientTurnId: "queued-turn",
      text: "Follow-up question",
      queuedAt: "2026-06-06T12:01:00.000Z",
      position: 0,
      state,
    },
  ];
  return appendOptimisticUserMessage(
    {
      summary: queuedSummary,
      feed: [],
      events: [],
      lastSeq: 0,
    },
    "Follow-up question",
    {
      clientMessageId: "queued-message",
      clientTurnId: "queued-turn",
    },
  );
}

test("process output advances the replay cursor without invalidating projections", () => {
  const currentProjection = projectionWithQueuedInput();
  const current = new Map([
    [currentProjection.summary.session.id, currentProjection],
  ]);
  let lastSeq = 0;
  let queued = false;
  const outputEvent = {
    id: "event-42",
    seq: 42,
    ts: "2026-06-06T12:02:00.000Z",
    sessionId: currentProjection.summary.session.id,
    turnId: "turn-1",
    source: {
      provider: "codex",
      channel: "structured_live",
      authority: "derived",
    },
    type: "process.output.appended",
    payload: {
      output: {
        itemId: "command-1",
        stream: "combined",
        sequence: 1,
        offsetBytes: 0,
        data: "noisy output",
        totalBytes: 12,
      },
    },
  } satisfies RahEvent;

  const next = applyEventsToProjectionMap(current, [outputEvent], {
    updateLastSeq: (seq) => {
      lastSeq = seq;
    },
    clearPendingSession: () => undefined,
    queuePendingEvent: () => {
      queued = true;
    },
  });

  assert.strictEqual(next, current);
  assert.strictEqual(next.get(currentProjection.summary.session.id), currentProjection);
  assert.equal(lastSeq, 42);
  assert.equal(queued, false);
});

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

test("authoritative refreshes cannot erase a local Starting chat", () => {
  const provisionalId = "starting-session:local-1";
  const pendingSummary = summary(provisionalId, "not-yet-created", { running: true });
  delete pendingSummary.session.providerSessionId;
  pendingSummary.session.phase = "starting";
  pendingSummary.session.runtimeState = "starting";
  const pendingProjection: SessionProjection = {
    summary: pendingSummary,
    feed: [],
    events: [],
    lastSeq: 0,
    pendingStartupConfiguration: {
      modelId: "gpt-5.6-sol",
      reasoningId: "medium",
      optionValues: { model_reasoning_effort: "medium" },
    },
  };
  const state = {
    projections: new Map([[provisionalId, pendingProjection]]),
    workspaceDir: "/tmp/rah",
    selectedSessionId: provisionalId,
    hiddenWorkspaceDirs: new Set<string>(),
    workspaceVisibilityVersion: 0,
  };

  const merged = applySessionsResponse(state, sessionsResponse(), replayNoop);
  const replaced = replaceSessionsResponse(state, sessionsResponse());

  for (const next of [merged, replaced]) {
    assert.strictEqual(next.projections.get(provisionalId), pendingProjection);
    assert.equal(next.selectedSessionId, provisionalId);
  }
});

test("refresh keeps the selected loaded stopped replay in memory", () => {
  const ref: StoredSessionRef = {
    provider: "codex",
    providerSessionId: "thread-loaded",
    cwd: "/tmp/rah",
    rootDir: "/tmp/rah",
    title: "Loaded history",
  };
  const replay = createPendingStoredReplayProjection(ref);
  replay.conversation = {
    phase: "ready",
    loadedScope: "history",
    turns: [],
    nextCursor: null,
    revision: 1,
    daemonRevision: 1,
    pendingDeltas: [],
    needsRefresh: false,
    approximateBytes: 128,
    sourceRevision: "source-1",
    loadedAt: "2026-06-06T12:00:00.000Z",
    lastError: null,
  };
  const projections = new Map<string, SessionProjection>([[replay.summary.session.id, replay]]);

  const next = replaceSessionsResponse(
    {
      projections,
      workspaceDir: "/tmp/rah",
      selectedSessionId: replay.summary.session.id,
      hiddenWorkspaceDirs: new Set<string>(),
      workspaceVisibilityVersion: 0,
    },
    sessionsResponse(),
  );

  assert.strictEqual(next.projections.get(replay.summary.session.id), replay);
  assert.equal(next.selectedSessionId, replay.summary.session.id);
});

test("replay-gap replacement keeps rendered Conversation while rebuilding raw projections", () => {
  const current = projectionWithQueuedInput();
  current.feed.push({
    key: "raw-feed",
    kind: "notification",
    level: "info",
    title: "raw",
    body: "must be rebuilt",
    ts: "2026-06-06T12:02:00.000Z",
  });
  current.conversation = {
    phase: "ready",
    loadedScope: "history",
    turns: [{ id: "cached-turn" } as never],
    nextCursor: "older-cursor",
    revision: 4,
    daemonRevision: 7,
    pendingDeltas: [],
    needsRefresh: false,
    approximateBytes: 512,
    sourceRevision: "source-1",
    loadedAt: "2026-06-06T12:00:00.000Z",
    lastError: null,
  };

  const next = replaceSessionsResponse(
    {
      projections: new Map([[current.summary.session.id, current]]),
      workspaceDir: "/tmp/rah",
      selectedSessionId: null,
      hiddenWorkspaceDirs: new Set<string>(),
      workspaceVisibilityVersion: 0,
    },
    sessionsResponse([summary("queued-session", "queued-thread", { running: true })]),
  );
  const replaced = next.projections.get("queued-session");

  assert.deepEqual(replaced?.feed, []);
  assert.deepEqual(replaced?.conversation?.turns.map((turn) => turn.id), ["cached-turn"]);
  assert.equal(replaced?.conversation?.needsRefresh, true);
  assert.equal(replaced?.conversation?.daemonRevision, 7);
  assert.equal(replaced?.conversation?.detachedBaseline, undefined);
});

test("replay-gap runtime rekey keeps a readable tail without reusing runtime cursors", () => {
  const existing = createPendingStoredReplayProjection({
    provider: "codex",
    providerSessionId: "thread-rekey",
    cwd: "/tmp/rah",
  });
  existing.summary = summary("old-runtime", "thread-rekey", { running: true });
  existing.conversation = {
    phase: "ready",
    loadedScope: "history",
    turns: [{ id: "cached-turn" } as never],
    nextCursor: "old-runtime-cursor",
    revision: 4,
    daemonRevision: 7,
    pendingDeltas: [],
    needsRefresh: false,
    approximateBytes: 512,
    sourceRevision: "source-1",
    loadedAt: "2026-06-06T12:00:00.000Z",
    lastError: null,
  };

  const next = replaceSessionsResponse(
    {
      projections: new Map([["old-runtime", existing]]),
      workspaceDir: "/tmp/rah",
      selectedSessionId: "old-runtime",
      hiddenWorkspaceDirs: new Set<string>(),
      workspaceVisibilityVersion: 0,
    },
    sessionsResponse([summary("new-runtime", "thread-rekey", { running: true })]),
  );
  const replacement = next.projections.get("new-runtime")?.conversation;

  assert.equal(next.selectedSessionId, "new-runtime");
  assert.deepEqual(replacement?.turns.map((turn) => turn.id), ["cached-turn"]);
  assert.equal(replacement?.phase, "ready");
  assert.equal(replacement?.daemonRevision, null);
  assert.equal(replacement?.nextCursor, null);
  assert.equal(replacement?.detachedBaseline, true);
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

test("stored Codex replay advertises native Fork and Side without worktree support", () => {
  const projection = createPendingStoredReplayProjection({
    provider: "codex",
    providerSessionId: "thread-history-branching",
    cwd: "/workspace/demo",
  });

  assert.deepEqual(projection.summary.session.capabilities.branching, {
    sameWorkspace: true,
    worktree: false,
    side: true,
  });
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

test("replaceSessionsResponse preserves a submitting input across a stale replay-gap rebuild", () => {
  const projection = projectionWithQueuedInput("submitting");
  const freshSummary = summary("queued-session", "queued-thread", { running: true });
  freshSummary.session.capabilities.queuedInput = true;

  const next = replaceSessionsResponse(
    {
      projections: new Map([["queued-session", projection]]),
      workspaceDir: "/tmp/rah",
      selectedSessionId: "queued-session",
      hiddenWorkspaceDirs: new Set<string>(),
      workspaceVisibilityVersion: 0,
    },
    sessionsResponse([freshSummary]),
  );

  assert.deepEqual(next.projections.get("queued-session")?.summary.session.inputQueue, [
    projection.summary.session.inputQueue?.[0],
  ]);
  assert.deepEqual(next.projections.get("queued-session")?.feed, []);
});

test("turn-bound optimistic guidance remains unresolved until canonical acceptance", () => {
  const projection = projectionWithQueuedInput("submitting");
  projection.feed = projection.feed.map((entry) =>
    entry.kind === "timeline" && entry.item.kind === "user_message"
      ? {
          ...entry,
          canonicalTurnId: "active-canonical-turn",
          providerTurnId: "active-provider-turn",
          turnId: "active-provider-turn",
        }
      : entry,
  );
  const freshSummary = summary("queued-session", "queued-thread", { running: true });
  freshSummary.session.capabilities.queuedInput = true;

  const next = applySessionsResponse(
    {
      projections: new Map([["queued-session", projection]]),
      workspaceDir: "/tmp/rah",
      selectedSessionId: "queued-session",
      hiddenWorkspaceDirs: new Set<string>(),
      workspaceVisibilityVersion: 0,
    },
    sessionsResponse([freshSummary]),
    replayNoop,
  );

  assert.deepEqual(next.projections.get("queued-session")?.summary.session.inputQueue, [
    projection.summary.session.inputQueue?.[0],
  ]);
});

test("replaceSessionsResponse cannot resurrect a queue item after canonical handoff", () => {
  const projection = projectionWithQueuedInput();
  projection.feed = projection.feed.map((entry) =>
    entry.kind === "timeline" && entry.item.kind === "user_message"
      ? {
          ...entry,
          sourceProvider: "codex",
          canonicalItemId: "canonical-user-message",
          canonicalTurnId: "canonical-turn",
          turnId: "canonical-turn",
          item: {
            ...entry.item,
            messageId: "provider-user-message",
          },
        }
      : entry,
  );
  const staleSummary = summary("queued-session", "queued-thread", { running: true });
  staleSummary.session.capabilities.queuedInput = true;
  staleSummary.session.inputQueue = projection.summary.session.inputQueue;

  const next = replaceSessionsResponse(
    {
      projections: new Map([["queued-session", projection]]),
      workspaceDir: "/tmp/rah",
      selectedSessionId: "queued-session",
      hiddenWorkspaceDirs: new Set<string>(),
      workspaceVisibilityVersion: 0,
    },
    sessionsResponse([staleSummary]),
  );

  assert.equal(
    next.projections.get("queued-session")?.summary.session.inputQueue,
    undefined,
  );
});

test("applySessionsResponse preserves a queued input omitted by a stale summary", () => {
  const projection = projectionWithQueuedInput("submitting");
  const freshSummary = summary("queued-session", "queued-thread", { running: true });
  freshSummary.session.capabilities.queuedInput = true;

  const next = applySessionsResponse(
    {
      projections: new Map([["queued-session", projection]]),
      workspaceDir: "/tmp/rah",
      selectedSessionId: "queued-session",
      hiddenWorkspaceDirs: new Set<string>(),
      workspaceVisibilityVersion: 0,
    },
    sessionsResponse([freshSummary]),
    replayNoop,
  );

  assert.deepEqual(next.projections.get("queued-session")?.summary.session.inputQueue, [
    projection.summary.session.inputQueue?.[0],
  ]);
});

test("applySessionsResponse does not preserve an unrepresented stale queue item", () => {
  const projection = projectionWithQueuedInput();
  projection.feed = [];
  const freshSummary = summary("queued-session", "queued-thread", { running: true });
  freshSummary.session.capabilities.queuedInput = true;

  const next = applySessionsResponse(
    {
      projections: new Map([["queued-session", projection]]),
      workspaceDir: "/tmp/rah",
      selectedSessionId: "queued-session",
      hiddenWorkspaceDirs: new Set<string>(),
      workspaceVisibilityVersion: 0,
    },
    sessionsResponse([freshSummary]),
    replayNoop,
  );

  assert.equal(
    next.projections.get("queued-session")?.summary.session.inputQueue,
    undefined,
  );
});

test("applySessionsResponse cannot resurrect a queue item after canonical handoff", () => {
  const projection = projectionWithQueuedInput();
  projection.feed = projection.feed.map((entry) =>
    entry.kind === "timeline" && entry.item.kind === "user_message"
      ? {
          ...entry,
          sourceProvider: "codex",
          canonicalItemId: "canonical-user-message",
          canonicalTurnId: "canonical-turn",
          turnId: "canonical-turn",
          item: {
            ...entry.item,
            messageId: "provider-user-message",
          },
        }
      : entry,
  );
  const staleSummary = summary("queued-session", "queued-thread", { running: true });
  staleSummary.session.capabilities.queuedInput = true;
  staleSummary.session.inputQueue = projection.summary.session.inputQueue;

  const next = applySessionsResponse(
    {
      projections: new Map([["queued-session", projection]]),
      workspaceDir: "/tmp/rah",
      selectedSessionId: "queued-session",
      hiddenWorkspaceDirs: new Set<string>(),
      workspaceVisibilityVersion: 0,
    },
    sessionsResponse([staleSummary]),
    replayNoop,
  );

  assert.equal(
    next.projections.get("queued-session")?.summary.session.inputQueue,
    undefined,
  );
});

test("applySessionsResponse keeps submitting state without duplicating the queue item", () => {
  const projection = projectionWithQueuedInput("submitting");
  const staleSummary = summary("queued-session", "queued-thread", { running: true });
  staleSummary.session.capabilities.queuedInput = true;
  staleSummary.session.inputQueue = [
    {
      ...projection.summary.session.inputQueue![0]!,
      state: "queued",
    },
  ];

  const next = applySessionsResponse(
    {
      projections: new Map([["queued-session", projection]]),
      workspaceDir: "/tmp/rah",
      selectedSessionId: "queued-session",
      hiddenWorkspaceDirs: new Set<string>(),
      workspaceVisibilityVersion: 0,
    },
    sessionsResponse([staleSummary]),
    replayNoop,
  );

  const queue = next.projections.get("queued-session")?.summary.session.inputQueue;
  assert.equal(queue?.length, 1);
  assert.equal(queue?.[0]?.clientMessageId, "queued-message");
  assert.equal(queue?.[0]?.state, "submitting");
});

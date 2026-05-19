import { test } from "node:test";
import assert from "node:assert/strict";
import type { CouncilSnapshot, StoredSessionRef } from "@rah/runtime-protocol";
import {
  dedupeStoredSessionsByIdentity,
  filterStoppedRecentSessions,
  groupAllStoredSessionsByDirectory,
  sessionIdentityKey,
} from "./session-history-grouping";
import {
  defaultRunningCouncilId,
  splitCouncils,
} from "./council/CouncilsBrowser";

function storedSession(overrides: Partial<StoredSessionRef> & Pick<StoredSessionRef, "provider" | "providerSessionId">): StoredSessionRef {
  return {
    provider: overrides.provider,
    providerSessionId: overrides.providerSessionId,
    source: overrides.source ?? "provider_history",
    ...(overrides.cwd ? { cwd: overrides.cwd } : {}),
    ...(overrides.rootDir ? { rootDir: overrides.rootDir } : {}),
    ...(overrides.title ? { title: overrides.title } : {}),
    ...(overrides.preview ? { preview: overrides.preview } : {}),
    ...(overrides.createdAt ? { createdAt: overrides.createdAt } : {}),
    ...(overrides.updatedAt ? { updatedAt: overrides.updatedAt } : {}),
    ...(overrides.lastUsedAt ? { lastUsedAt: overrides.lastUsedAt } : {}),
  };
}

function council(overrides: {
  id: string;
  title: string;
  workspace: string;
  status: CouncilSnapshot["status"];
  phase?: CouncilSnapshot["phase"];
  updatedAt: string;
  messageAt?: string;
  agentLabel?: string;
}): CouncilSnapshot {
  return {
    id: overrides.id,
    title: overrides.title,
    workspace: overrides.workspace,
    status: overrides.status,
    phase: overrides.phase ?? (overrides.status === "running" ? "ready" : "ended"),
    createdAt: "2026-05-01T00:00:00.000Z",
    updatedAt: overrides.updatedAt,
    agents: [
      {
        id: `${overrides.id}-agent`,
        councilId: overrides.id,
        provider: "codex",
        label: overrides.agentLabel ?? "codex",
        status: "idle",
        updatedAt: overrides.updatedAt,
      },
    ],
    messages: overrides.messageAt
      ? [
          {
            id: 1,
            councilId: overrides.id,
            actorId: "user",
            role: "user",
            parts: [{ kind: "text", text: "hello" }],
            createdAt: overrides.messageAt,
          },
        ]
      : [],
  };
}

test("dedupes identical sessions by provider and providerSessionId", () => {
  const sessions: StoredSessionRef[] = [
    storedSession({
      provider: "opencode",
      providerSessionId: "session-1",
      source: "previous_running",
      title: "stale title",
      updatedAt: "2026-04-20T10:00:00.000Z",
    }),
    storedSession({
      provider: "opencode",
      providerSessionId: "session-1",
      source: "provider_history",
      rootDir: "/Users/sun/Code/solars",
      cwd: "/Users/sun/Code/solars",
      title: "better title",
      updatedAt: "2026-04-20T10:01:00.000Z",
    }),
  ];

  const deduped = dedupeStoredSessionsByIdentity(sessions);
  assert.equal(deduped.length, 1);
  assert.equal(deduped[0]?.title, "better title");
  assert.equal(deduped[0]?.rootDir, "/Users/sun/Code/solars");
});

test("groups deduped sessions and counts each session only once per workspace", () => {
  const groups = groupAllStoredSessionsByDirectory([
    storedSession({
      provider: "opencode",
      providerSessionId: "session-1",
      source: "previous_running",
      title: "duplicate stale",
      updatedAt: "2026-04-20T10:00:00.000Z",
    }),
    storedSession({
      provider: "opencode",
      providerSessionId: "session-1",
      source: "provider_history",
      rootDir: "/Users/sun/Code/solars",
      cwd: "/Users/sun/Code/solars",
      title: "session one",
      updatedAt: "2026-04-20T10:01:00.000Z",
    }),
    storedSession({
      provider: "codex",
      providerSessionId: "session-2",
      rootDir: "/Users/sun/Code/solars",
      cwd: "/Users/sun/Code/solars",
      title: "session two",
      updatedAt: "2026-04-20T10:02:00.000Z",
    }),
  ]);

  assert.equal(groups.length, 1);
  assert.equal(groups[0]?.directory, "/Users/sun/Code/solars");
  assert.equal(groups[0]?.items.length, 2);
  assert.deepEqual(
    groups[0]?.items.map((session) => session.providerSessionId).sort(),
    ["session-1", "session-2"],
  );
});

test("preserves filesystem root as a real history workspace", () => {
  const groups = groupAllStoredSessionsByDirectory([
    storedSession({
      provider: "codex",
      providerSessionId: "root-session",
      rootDir: "/",
      cwd: "/",
      updatedAt: "2026-04-20T10:00:00.000Z",
    }),
  ]);

  assert.equal(groups.length, 1);
  assert.equal(groups[0]?.directory, "/");
});

test("sorts history workspaces by earliest session createdAt while keeping items newest-first", () => {
  const groups = groupAllStoredSessionsByDirectory(
    [
      storedSession({
        provider: "codex",
        providerSessionId: "session-1",
        rootDir: "/Users/sun/Code/zeta",
        cwd: "/Users/sun/Code/zeta",
        title: "older zeta",
        createdAt: "2026-04-20T10:00:00.000Z",
        updatedAt: "2026-04-20T10:00:00.000Z",
      }),
      storedSession({
        provider: "codex",
        providerSessionId: "session-2",
        rootDir: "/Users/sun/Code/alpha",
        cwd: "/Users/sun/Code/alpha",
        title: "alpha session",
        createdAt: "2026-04-21T10:00:00.000Z",
        updatedAt: "2026-04-20T10:02:00.000Z",
      }),
      storedSession({
        provider: "codex",
        providerSessionId: "session-3",
        rootDir: "/Users/sun/Code/zeta",
        cwd: "/Users/sun/Code/zeta",
        title: "newer zeta",
        createdAt: "2026-04-22T10:00:00.000Z",
        updatedAt: "2026-04-20T10:03:00.000Z",
      }),
    ],
    {
      workspaceSortMode: "created",
    },
  );

  assert.deepEqual(
    groups.map((group) => group.directory),
    ["/Users/sun/Code/zeta", "/Users/sun/Code/alpha"],
  );
  assert.deepEqual(
    groups[0]?.items.map((session) => session.providerSessionId),
    ["session-3", "session-1"],
  );
});

test("sorts grouped sessions by lastUsedAt before updatedAt", () => {
  const groups = groupAllStoredSessionsByDirectory([
    storedSession({
      provider: "codex",
      providerSessionId: "recently-used",
      rootDir: "/Users/sun/Code/rah",
      cwd: "/Users/sun/Code/rah",
      updatedAt: "2026-04-20T10:00:00.000Z",
      lastUsedAt: "2026-04-20T10:10:00.000Z",
    }),
    storedSession({
      provider: "codex",
      providerSessionId: "recently-updated",
      rootDir: "/Users/sun/Code/rah",
      cwd: "/Users/sun/Code/rah",
      updatedAt: "2026-04-20T10:05:00.000Z",
      lastUsedAt: "2026-04-20T10:01:00.000Z",
    }),
  ]);

  assert.deepEqual(
    groups[0]?.items.map((session) => session.providerSessionId),
    ["recently-used", "recently-updated"],
  );
});

test("recent chats are stopped and omit current running identities", () => {
  const liveDuplicate = storedSession({
    provider: "codex",
    providerSessionId: "live-1",
    rootDir: "/Users/sun/Code/rah",
  });
  const recentOnly = storedSession({
    provider: "claude",
    providerSessionId: "recent-1",
    rootDir: "/Users/sun/Code/rah",
  });

  assert.deepEqual(
    filterStoppedRecentSessions(
      [liveDuplicate, recentOnly],
      new Set([sessionIdentityKey(liveDuplicate)]),
    ).map((session) => session.providerSessionId),
    ["recent-1"],
  );
});

test("splits councils for the Chats council tab", () => {
  const councils = [
    council({
      id: "old-running",
      title: "Old running",
      workspace: "/Users/sun/Code/rah",
      status: "running",
      updatedAt: "2026-05-01T10:00:00.000Z",
    }),
    council({
      id: "new-running",
      title: "New running",
      workspace: "/Users/sun/Code/valar",
      status: "running",
      updatedAt: "2026-05-01T10:01:00.000Z",
      messageAt: "2026-05-01T10:03:00.000Z",
    }),
    council({
      id: "stopped-council",
      title: "Stopped council",
      workspace: "/Users/sun/Code/rah",
      status: "stopped",
      updatedAt: "2026-05-01T10:02:00.000Z",
    }),
  ];

  const split = splitCouncils(councils);
  assert.deepEqual(split.activeCouncils.map((council) => council.id), ["new-running", "old-running"]);
  assert.deepEqual(split.historyCouncils.map((council) => council.id), ["stopped-council"]);
  assert.equal(defaultRunningCouncilId(councils), "new-running");
});

test("filters councils by workspace and agent metadata", () => {
  const councils = [
    council({
      id: "codex-council",
      title: "Planner",
      workspace: "/Users/sun/Code/rah",
      status: "running",
      updatedAt: "2026-05-01T10:00:00.000Z",
      agentLabel: "Architect",
    }),
    council({
      id: "gemini-council",
      title: "Review",
      workspace: "/Users/sun/Code/valar",
      status: "stopped",
      updatedAt: "2026-05-01T10:01:00.000Z",
      agentLabel: "Critic",
    }),
  ];

  assert.deepEqual(
    splitCouncils(councils, "valar").historyCouncils.map((council) => council.id),
    ["gemini-council"],
  );
  assert.deepEqual(
    splitCouncils(councils, "architect").activeCouncils.map((council) => council.id),
    ["codex-council"],
  );
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { CouncilSnapshot, StoredSessionRef } from "@rah/runtime-protocol";
import {
  dedupeStoredSessionsByIdentity,
  filterSessionHistoryGroups,
  filterStoppedRecentSessions,
  groupAllStoredSessionsByDirectory,
  sessionMatchesMaxLineCount,
  sessionIdentityKey,
} from "./session-history-grouping";
import {
  councilConversationSubtitle,
  councilLineLabel,
  defaultRunningCouncilId,
  reconcileCouncilSelection,
  splitCouncils,
} from "./council/CouncilsBrowser";
import { chooseChatListSubtitle } from "./chat-list-display";

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
    ...(overrides.historyMeta ? { historyMeta: overrides.historyMeta } : {}),
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
  messages?: CouncilSnapshot["messages"];
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
    messages: overrides.messages ?? (overrides.messageAt
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
      : []),
  };
}

function readSource(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
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

test("line-count filtering only matches sessions with known lines below the limit", () => {
  const small = storedSession({
    provider: "codex",
    providerSessionId: "small",
    historyMeta: { lines: 8, bytes: 1024 },
  });
  const large = storedSession({
    provider: "codex",
    providerSessionId: "large",
    historyMeta: { lines: 40, bytes: 4096 },
  });
  const unknown = storedSession({
    provider: "codex",
    providerSessionId: "unknown",
  });

  assert.equal(sessionMatchesMaxLineCount(small, 10), true);
  assert.equal(sessionMatchesMaxLineCount(large, 10), false);
  assert.equal(sessionMatchesMaxLineCount(unknown, 10), false);
  assert.equal(sessionMatchesMaxLineCount(unknown, null), true);
});

test("filtered workspace deletion candidates honor provider and line-count filters", () => {
  const groups = groupAllStoredSessionsByDirectory([
    storedSession({
      provider: "codex",
      providerSessionId: "codex-small",
      rootDir: "/Users/sun/Code/solars",
      cwd: "/Users/sun/Code/solars",
      title: "small codex",
      updatedAt: "2026-04-20T10:00:00.000Z",
      historyMeta: { lines: 5 },
    }),
    storedSession({
      provider: "codex",
      providerSessionId: "codex-large",
      rootDir: "/Users/sun/Code/solars",
      cwd: "/Users/sun/Code/solars",
      title: "large codex",
      updatedAt: "2026-04-20T10:01:00.000Z",
      historyMeta: { lines: 50 },
    }),
    storedSession({
      provider: "gemini",
      providerSessionId: "gemini-small",
      rootDir: "/Users/sun/Code/solars",
      cwd: "/Users/sun/Code/solars",
      title: "small gemini",
      updatedAt: "2026-04-20T10:02:00.000Z",
      historyMeta: { lines: 4 },
    }),
    storedSession({
      provider: "codex",
      providerSessionId: "codex-unknown-lines",
      rootDir: "/Users/sun/Code/solars",
      cwd: "/Users/sun/Code/solars",
      title: "unknown lines",
      updatedAt: "2026-04-20T10:03:00.000Z",
    }),
  ]);

  const filtered = filterSessionHistoryGroups(groups, {
    maxLineCount: 10,
    matchesProvider: (session) => session.provider === "codex",
    matchesSessionQuery: () => true,
  });

  assert.equal(filtered.length, 1);
  assert.deepEqual(
    filtered[0]?.items.map((session) => session.providerSessionId),
    ["codex-small"],
  );
});

test("Chats All filters do not mutate workspace expansion state", () => {
  const source = readSource("./components/SessionHistoryDialog.tsx");
  assert.doesNotMatch(source, /setExpandedGroups\(new Set\(filteredGroups/);
  assert.doesNotMatch(source, /setVisibleItemCounts\(\s*new Map\(filteredGroups/s);
  assert.doesNotMatch(source, /requestAnimationFrame\(\(\) => setOpen\(false\)\)/);
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

test("defaults Council entry to the latest running chat with messages", () => {
  const councils = [
    council({
      id: "blank-running",
      title: "Blank running",
      workspace: "/Users/sun/Code/rah",
      status: "running",
      updatedAt: "2026-05-01T10:10:00.000Z",
    }),
    council({
      id: "older-chat-running",
      title: "Older chat running",
      workspace: "/Users/sun/Code/rah",
      status: "running",
      updatedAt: "2026-05-01T10:00:00.000Z",
      messageAt: "2026-05-01T10:03:00.000Z",
    }),
    council({
      id: "newer-chat-running",
      title: "Newer chat running",
      workspace: "/Users/sun/Code/rah",
      status: "running",
      updatedAt: "2026-05-01T10:01:00.000Z",
      messageAt: "2026-05-01T10:05:00.000Z",
    }),
  ];

  assert.equal(defaultRunningCouncilId(councils), "newer-chat-running");
});

test("reconciles Council selection without replacing explicit history browsing", () => {
  const councils = [
    council({
      id: "active-council",
      title: "Active council",
      workspace: "/Users/sun/Code/rah",
      status: "running",
      updatedAt: "2026-05-01T10:00:00.000Z",
      messageAt: "2026-05-01T10:05:00.000Z",
    }),
    council({
      id: "stopped-council",
      title: "Stopped council",
      workspace: "/Users/sun/Code/rah",
      status: "stopped",
      updatedAt: "2026-05-01T10:02:00.000Z",
    }),
  ];

  assert.equal(reconcileCouncilSelection(null, councils, { allowRunningDefault: true }), "active-council");
  assert.equal(reconcileCouncilSelection("stopped-council", councils), "stopped-council");
  assert.equal(reconcileCouncilSelection("missing-council", councils), null);
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

test("derives council browser subtitle from stable visible messages", () => {
  const snapshot = council({
    id: "preview-council",
    title: "Preview",
    workspace: "/Users/sun/Code/rah",
    status: "running",
    updatedAt: "2026-05-01T10:00:00.000Z",
    agentLabel: "Reviewer",
    messages: [
      {
        id: 1,
        councilId: "preview-council",
        actorId: "user",
        role: "user",
        parts: [{ kind: "text", text: "please review" }],
        createdAt: "2026-05-01T10:01:00.000Z",
      },
      {
        id: 2,
        councilId: "preview-council",
        actorId: "preview-council-agent",
        role: "system",
        parts: [{ kind: "text", text: "preview-council-agent listening" }],
        createdAt: "2026-05-01T10:02:00.000Z",
      },
      {
        id: 3,
        councilId: "preview-council",
        actorId: "preview-council-agent",
        role: "agent",
        parts: [{ kind: "text", text: "Looks good.\nShip it." }],
        createdAt: "2026-05-01T10:03:00.000Z",
      },
    ],
  });

  assert.equal(councilConversationSubtitle(snapshot), "You: please review");
});

test("derives council browser subtitle and line count from metadata when only tail is loaded", () => {
  const snapshot = council({
    id: "preview-council",
    title: "Preview",
    workspace: "/Users/sun/Code/rah",
    status: "running",
    updatedAt: "2026-05-01T10:00:00.000Z",
    agentLabel: "Reviewer",
    messages: [
      {
        id: 20,
        councilId: "preview-council",
        actorId: "preview-council-agent",
        role: "agent",
        parts: [{ kind: "text", text: "tail answer" }],
        createdAt: "2026-05-01T10:20:00.000Z",
      },
    ],
  });
  snapshot.meta = {
    messageCount: 20,
    firstUserMessage: {
      id: 1,
      role: "user",
      actorId: "user",
      text: "please review from the beginning",
      createdAt: "2026-05-01T10:01:00.000Z",
    },
    lastContentMessage: {
      id: 20,
      role: "agent",
      actorId: "preview-council-agent",
      text: "tail answer",
      createdAt: "2026-05-01T10:20:00.000Z",
    },
    lastMessage: {
      id: 20,
      role: "agent",
      actorId: "preview-council-agent",
      text: "tail answer",
      createdAt: "2026-05-01T10:20:00.000Z",
    },
  };
  snapshot.messageWindow = {
    total: 20,
    loaded: 1,
    hasMoreBefore: true,
    nextBeforeMessageId: 20,
  };

  assert.equal(councilConversationSubtitle(snapshot), "You: please review from the beginning");
  assert.equal(councilLineLabel(snapshot), "20 lines");
});

test("sorts councils by user and agent activity instead of background system updates", () => {
  const noisy = council({
    id: "background-noise",
    title: "Background noise",
    workspace: "/Users/sun/Code/rah",
    status: "running",
    updatedAt: "2026-05-01T10:59:00.000Z",
    messages: [
      {
        id: 10,
        councilId: "background-noise",
        actorId: "system",
        role: "system",
        parts: [{ kind: "text", text: "agent listening" }],
        createdAt: "2026-05-01T10:59:00.000Z",
      },
    ],
  });
  noisy.meta = {
    messageCount: 10,
    lastMessage: {
      id: 10,
      role: "system",
      actorId: "system",
      text: "agent listening",
      createdAt: "2026-05-01T10:59:00.000Z",
    },
  };
  const humanActivity = council({
    id: "human-activity",
    title: "Human activity",
    workspace: "/Users/sun/Code/rah",
    status: "running",
    updatedAt: "2026-05-01T10:10:00.000Z",
    messageAt: "2026-05-01T10:10:00.000Z",
  });

  assert.deepEqual(
    splitCouncils([noisy, humanActivity]).activeCouncils.map((item) => item.id),
    ["human-activity", "background-noise"],
  );
});

test("uses the first council agent reply when the title already contains the user message", () => {
  const snapshot = council({
    id: "preview-council",
    title: "please review",
    workspace: "/Users/sun/Code/rah",
    status: "running",
    updatedAt: "2026-05-01T10:00:00.000Z",
    agentLabel: "Reviewer",
    messages: [
      {
        id: 1,
        councilId: "preview-council",
        actorId: "user",
        role: "user",
        parts: [{ kind: "text", text: "please review" }],
        createdAt: "2026-05-01T10:01:00.000Z",
      },
      {
        id: 2,
        councilId: "preview-council",
        actorId: "preview-council-agent",
        role: "agent",
        parts: [{ kind: "text", text: "Looks good.\nShip it." }],
        createdAt: "2026-05-01T10:03:00.000Z",
      },
      {
        id: 3,
        councilId: "preview-council",
        actorId: "preview-council-agent",
        role: "agent",
        parts: [{ kind: "text", text: "Later update" }],
        createdAt: "2026-05-01T10:04:00.000Z",
      },
    ],
  });

  assert.equal(councilConversationSubtitle(snapshot), "Reviewer: Looks good. Ship it.");
});

test("skips duplicate chat subtitles", () => {
  assert.equal(
    chooseChatListSubtitle("你是谁", [{ text: " 你是谁 " }, { text: "我是 RAH。" }]),
    "我是 RAH。",
  );
});

test("filters councils by browser subtitle text", () => {
  const councils = [
    council({
      id: "matching-council",
      title: "Planner",
      workspace: "/Users/sun/Code/rah",
      status: "running",
      updatedAt: "2026-05-01T10:00:00.000Z",
      messages: [
        {
          id: 1,
          councilId: "matching-council",
          actorId: "user",
          role: "user",
          parts: [{ kind: "text", text: "handoff summary is ready" }],
          createdAt: "2026-05-01T10:01:00.000Z",
        },
      ],
    }),
    council({
      id: "other-council",
      title: "Other",
      workspace: "/Users/sun/Code/rah",
      status: "running",
      updatedAt: "2026-05-01T10:02:00.000Z",
    }),
  ];

  assert.deepEqual(
    splitCouncils(councils, "handoff").activeCouncils.map((council) => council.id),
    ["matching-council"],
  );
});

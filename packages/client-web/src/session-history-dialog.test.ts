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
  councilConversationSubtitle,
  councilLineLabel,
  defaultRunningCouncilId,
  reconcileCouncilSelection,
  splitCouncils,
} from "./council/CouncilsBrowser";
import {
  mergeCouncilLatestMessagesPage,
  mergeCouncilLists,
  mergeCouncilSnapshot,
  shouldHydrateLatestCouncilMessages,
} from "./council/council-message-window";
import { chooseChatListSubtitle } from "./chat-list-display";
import {
  shouldLoadAllStoredSessionsForDialog,
  shouldLoadCouncilsForDialog,
} from "./session-history-dialog-model";

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

test("Chats dialog only loads the full history catalog from the All tab", () => {
  assert.equal(shouldLoadAllStoredSessionsForDialog(false, "all"), false);
  assert.equal(shouldLoadAllStoredSessionsForDialog(true, "active"), false);
  assert.equal(shouldLoadAllStoredSessionsForDialog(true, "council"), false);
  assert.equal(shouldLoadAllStoredSessionsForDialog(true, "all"), true);
});

test("Chats dialog only loads Council catalog from the Council tab", () => {
  assert.equal(shouldLoadCouncilsForDialog(false, "council"), false);
  assert.equal(shouldLoadCouncilsForDialog(true, "active"), false);
  assert.equal(shouldLoadCouncilsForDialog(true, "all"), false);
  assert.equal(shouldLoadCouncilsForDialog(true, "council"), true);
});

test("active Council refresh preserves already loaded history Councils", () => {
  const active = council({
    id: "running-council",
    title: "Running council",
    workspace: "/Users/sun/Code/rah",
    status: "running",
    updatedAt: "2026-05-01T10:10:00.000Z",
  });
  const history = council({
    id: "stopped-council",
    title: "Stopped council",
    workspace: "/Users/sun/Code/rah",
    status: "stopped",
    updatedAt: "2026-05-01T09:10:00.000Z",
  });

  assert.deepEqual(
    mergeCouncilLists([history], [active], { preserveMissing: true }).map((entry) => entry.id),
    ["running-council", "stopped-council"],
  );
  assert.deepEqual(
    mergeCouncilLists([history], [active]).map((entry) => entry.id),
    ["running-council"],
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

test("defaults Council entry from summary metadata when messages are not hydrated", () => {
  const councils = [
    council({
      id: "blank-running",
      title: "Blank running",
      workspace: "/Users/sun/Code/rah",
      status: "running",
      updatedAt: "2026-05-01T10:10:00.000Z",
    }),
    {
      ...council({
        id: "summary-running",
        title: "Summary running",
        workspace: "/Users/sun/Code/rah",
        status: "running",
        updatedAt: "2026-05-01T10:01:00.000Z",
      }),
      meta: {
        messageCount: 4,
        lastContentMessage: {
          id: 4,
          role: "agent" as const,
          actorId: "summary-running-agent",
          text: "latest summary reply",
          createdAt: "2026-05-01T10:20:00.000Z",
        },
      },
      messageWindow: {
        total: 4,
        loaded: 0,
        hasMoreBefore: true,
      },
    },
  ];

  assert.equal(defaultRunningCouncilId(councils), "summary-running");
});

test("summary-only Council refresh preserves hydrated messages and older cursor", () => {
  const hydrated = {
    ...council({
      id: "hydrated",
      title: "Hydrated",
      workspace: "/Users/sun/Code/rah",
      status: "running",
      updatedAt: "2026-05-01T10:00:00.000Z",
      messages: [
        {
          id: 5,
          councilId: "hydrated",
          actorId: "user",
          role: "user" as const,
          parts: [{ kind: "text" as const, text: "loaded" }],
          createdAt: "2026-05-01T10:01:00.000Z",
        },
      ],
    }),
    messageWindow: {
      total: 8,
      loaded: 1,
      hasMoreBefore: true,
      nextBeforeMessageId: 5,
    },
  };
  const summary = {
    ...hydrated,
    messages: [],
    meta: {
      messageCount: 9,
      lastContentMessage: {
        id: 9,
        role: "agent" as const,
        actorId: "hydrated-agent",
        text: "new summary",
        createdAt: "2026-05-01T10:02:00.000Z",
      },
    },
    messageWindow: {
      total: 9,
      loaded: 0,
      hasMoreBefore: true,
    },
  };

  const merged = mergeCouncilSnapshot(hydrated, summary);
  assert.equal(merged.messages.length, 1);
  assert.equal(merged.messageWindow?.total, 9);
  assert.equal(merged.messageWindow?.loaded, 1);
  assert.equal(merged.messageWindow?.hasMoreBefore, true);
  assert.equal(merged.messageWindow?.nextBeforeMessageId, 5);
  assert.equal(shouldHydrateLatestCouncilMessages(merged), true);
});

test("Council latest message hydration appends missed foreground messages without resetting older cursor", () => {
  const hydrated = {
    ...council({
      id: "hydrated",
      title: "Hydrated",
      workspace: "/Users/sun/Code/rah",
      status: "running",
      updatedAt: "2026-05-01T10:00:00.000Z",
      messages: [
        {
          id: 1,
          councilId: "hydrated",
          actorId: "user",
          role: "user" as const,
          parts: [{ kind: "text" as const, text: "old loaded" }],
          createdAt: "2026-05-01T10:01:00.000Z",
        },
        {
          id: 2,
          councilId: "hydrated",
          actorId: "hydrated-agent",
          role: "agent" as const,
          parts: [{ kind: "text" as const, text: "old reply" }],
          createdAt: "2026-05-01T10:02:00.000Z",
        },
      ],
    }),
    meta: {
      messageCount: 4,
      lastMessage: {
        id: 4,
        role: "agent" as const,
        actorId: "hydrated-agent",
        text: "missed reply",
        createdAt: "2026-05-01T10:04:00.000Z",
      },
    },
    messageWindow: {
      total: 4,
      loaded: 2,
      hasMoreBefore: false,
    },
  };

  assert.equal(shouldHydrateLatestCouncilMessages(hydrated), true);
  const merged = mergeCouncilLatestMessagesPage(hydrated, {
    councilId: "hydrated",
    total: 4,
    hasMoreBefore: true,
    nextBeforeMessageId: 3,
    messages: [
      {
        id: 3,
        councilId: "hydrated",
        actorId: "hydrated-agent",
        role: "system" as const,
        parts: [{ kind: "text" as const, text: "hydrated-agent sent" }],
        createdAt: "2026-05-01T10:03:00.000Z",
      },
      {
        id: 4,
        councilId: "hydrated",
        actorId: "hydrated-agent",
        role: "agent" as const,
        parts: [{ kind: "text" as const, text: "missed reply" }],
        createdAt: "2026-05-01T10:04:00.000Z",
      },
    ],
  });

  assert.deepEqual(merged.messages.map((message) => message.id), [1, 2, 3, 4]);
  assert.equal(merged.messageWindow?.total, 4);
  assert.equal(merged.messageWindow?.loaded, 4);
  assert.equal(merged.messageWindow?.hasMoreBefore, false);
  assert.equal(shouldHydrateLatestCouncilMessages(merged), false);
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

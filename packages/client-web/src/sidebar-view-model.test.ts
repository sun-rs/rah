import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { CouncilSnapshot, SessionSummary, StoredSessionRef } from "@rah/runtime-protocol";
import { conversationStateFromRuntimeState } from "@rah/runtime-protocol";
import {
  deriveSidebarCouncilViewModels,
  deriveSidebarWorkspaceViewModels,
  partitionSidebarPinnedItems,
} from "./sidebar-view-model";
import { formatCompactRelativeTime, formatRelativeTime, type WorkspaceSection } from "./session-browser";
import { mergeCouncilLists } from "./council/council-message-window";
import { reconcilePinnedSidebarItems } from "./hooks/useWorkbenchSidebarPreferences";

function session(args: {
  id: string;
  provider?: SessionSummary["session"]["provider"];
  providerSessionId?: string;
  runtimeState?: SessionSummary["session"]["runtimeState"];
  phase?: SessionSummary["session"]["phase"];
  updatedAt?: string;
  origin?: SessionSummary["session"]["origin"];
}): SessionSummary {
  const conversationState = conversationStateFromRuntimeState(args.runtimeState ?? "running");
  return {
    session: {
      id: args.id,
      provider: args.provider ?? "opencode",
      providerSessionId: args.providerSessionId ?? `${args.id}-provider`,
      launchSource: "web",
      cwd: "/workspace/rah",
      rootDir: "/workspace/rah",
      ...conversationState,
      ...(args.phase ? { phase: args.phase } : {}),
      runtimeState: args.runtimeState ?? "running",
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
      updatedAt: args.updatedAt ?? "2026-04-15T00:00:00.000Z",
      title: args.id,
      ...(args.origin ? { origin: args.origin } : {}),
    },
    attachedClients: [],
    controlLease: { sessionId: args.id },
  };
}

function storedSession(args: {
  id: string;
  provider?: StoredSessionRef["provider"];
  updatedAt?: string;
  lastUsedAt?: string;
  archived?: "native" | "overlay";
}): StoredSessionRef {
  return {
    provider: args.provider ?? "opencode",
    providerSessionId: args.id,
    cwd: "/workspace/rah",
    rootDir: "/workspace/rah",
    title: args.id,
    updatedAt: args.updatedAt ?? "2026-04-15T00:00:00.000Z",
    ...(args.lastUsedAt ? { lastUsedAt: args.lastUsedAt } : {}),
    ...(args.archived === "native"
      ? { providerState: { archived: true } }
      : args.archived === "overlay"
        ? { libraryState: { placement: "archive", backend: "rah_overlay" } }
        : {}),
  };
}

function workspaceSection(sessions: SessionSummary[], directory = "/workspace/rah"): WorkspaceSection {
  return {
    workspace: {
      directory,
      displayName: directory,
      latestUpdatedAt: "2026-04-15T00:00:00.000Z",
      runningCount: sessions.length,
      hasRunningItem: true,
      hasBlockingRunningSessions: true,
    },
    sessions,
  };
}

function council(args: {
  id: string;
  workspace?: string;
  status?: CouncilSnapshot["status"];
  phase?: CouncilSnapshot["phase"];
  createdAt?: string;
  updatedAt?: string;
  messages?: CouncilSnapshot["messages"];
}): CouncilSnapshot {
  return {
    id: args.id,
    title: args.id,
    workspace: args.workspace ?? "/workspace/rah",
    status: args.status ?? "running",
    phase: args.phase ?? "ready",
    createdAt: args.createdAt ?? "2026-04-15T00:00:00.000Z",
    updatedAt: args.updatedAt ?? "2026-04-15T00:00:00.000Z",
    agents: [],
    messages: args.messages ?? [],
  };
}

describe("sidebar view model", () => {
  test("uses compact sidebar relative times", () => {
    assert.equal(formatCompactRelativeTime(new Date().toISOString()), "just");
    assert.equal(
      formatCompactRelativeTime(new Date(Date.now() - 32 * 60 * 1000 - 5_000).toISOString()),
      "32m",
    );
  });

  test("formats relative times through the shared display protocol", () => {
    const nowMs = Date.parse("2026-05-01T10:32:05.000Z");
    const value = "2026-05-01T10:00:00.000Z";

    assert.equal(formatRelativeTime(value, { format: "long", nowMs }), "32m ago");
    assert.equal(formatRelativeTime(value, { format: "compact", nowMs }), "32m");
    assert.equal(
      formatRelativeTime("2026-05-01T10:31:30.000Z", { format: "compact", nowMs }),
      "just",
    );
  });

  test("marks configured sessions as pinned without changing workspace recency order", () => {
    const items = deriveSidebarWorkspaceViewModels({
      workspaceSections: [workspaceSection([session({ id: "a" }), session({ id: "b" })])],
      selectedWorkspaceDir: "/workspace/rah",
      selectedSessionId: null,
      unreadSessionIds: new Set(),
      runtimeStatusBySessionId: new Map(),
      pinnedItems: [{ workspaceDir: "/workspace/rah", itemKey: "session:b" }],
    });

    assert.deepEqual(items[0]?.sessions.map((entry) => entry.id), ["a", "b"]);
    assert.equal(items[0]?.sessions[1]?.pinned, true);
    assert.equal(items[0]?.selected, true);
  });

  test("pins running and stopped sessions by stable provider identity", () => {
    const storedSessions = [
      storedSession({ id: "codex-stopped", provider: "codex" }),
      storedSession({ id: "claude-stopped", provider: "claude" }),
      storedSession({ id: "opencode-stopped", provider: "opencode" }),
    ];
    const pinnedItems = storedSessions.map((entry) => ({
      workspaceDir: "/workspace/rah",
      itemKey: `session:${entry.provider}:${entry.providerSessionId}`,
    }));
    const items = deriveSidebarWorkspaceViewModels({
      workspaceSections: [workspaceSection([
        session({ id: "runtime", provider: "codex", providerSessionId: "codex-live" }),
      ])],
      storedSessions,
      selectedWorkspaceDir: "/workspace/rah",
      selectedSessionId: null,
      unreadSessionIds: new Set(),
      runtimeStatusBySessionId: new Map(),
      pinnedItems: [
        ...pinnedItems,
        { workspaceDir: "/workspace/rah", itemKey: "session:codex:codex-live" },
      ],
    });

    assert.deepEqual(
      items[0]?.sessions.map((entry) => [entry.provider, entry.pinned, entry.pinItemKey]),
      [
        ["codex", true, "session:codex:codex-live"],
        ["codex", true, "session:codex:codex-stopped"],
        ["claude", true, "session:claude:claude-stopped"],
        ["opencode", true, "session:opencode:opencode-stopped"],
      ],
    );

    const partition = partitionSidebarPinnedItems(items, [
      ...pinnedItems,
      { workspaceDir: "/workspace/rah", itemKey: "session:codex:codex-live" },
    ]);
    assert.equal(partition.pinnedItems.length, 4);
    assert.deepEqual(partition.workspaces[0]?.sessions, []);
  });

  test("selects the session row without also selecting its workspace row", () => {
    const items = deriveSidebarWorkspaceViewModels({
      workspaceSections: [workspaceSection([session({ id: "selected-session" })])],
      selectedWorkspaceDir: "/workspace/rah",
      selectedSessionId: "selected-session",
      selectedCouncilId: null,
      unreadSessionIds: new Set(),
      runtimeStatusBySessionId: new Map(),
      pinnedItems: [],
    });

    assert.equal(items[0]?.selected, false);
    assert.equal(items[0]?.sessions[0]?.selected, true);
  });

  test("merges stopped workspace sessions, excludes archives, and dedupes running identities", () => {
    const items = deriveSidebarWorkspaceViewModels({
      workspaceSections: [
        workspaceSection([
          session({
            id: "runtime",
            providerSessionId: "shared-provider-session",
            updatedAt: "2026-04-15T00:04:00.000Z",
          }),
        ]),
      ],
      storedSessions: [
        storedSession({ id: "shared-provider-session", updatedAt: "2026-04-15T00:05:00.000Z" }),
        storedSession({ id: "stopped", updatedAt: "2026-04-15T00:03:00.000Z" }),
        storedSession({ id: "native-archive", archived: "native" }),
        storedSession({ id: "overlay-archive", archived: "overlay" }),
      ],
      selectedWorkspaceDir: "/workspace/rah",
      selectedSessionId: null,
      selectedStoredSessionKey: "opencode:stopped",
      unreadSessionIds: new Set(),
      runtimeStatusBySessionId: new Map(),
      pinnedItems: [],
    });

    assert.deepEqual(
      items[0]?.sessions.map((entry) => entry.id),
      ["runtime", "stored:opencode:stopped"],
    );
    assert.equal(items[0]?.sessions[0]?.running, true);
    assert.equal(items[0]?.sessions[1]?.running, false);
    assert.equal(items[0]?.sessions[1]?.statusLabel, "");
    assert.equal(items[0]?.sessions[1]?.selected, true);
    assert.equal(items[0]?.selected, false);
  });

  test("does not reorder stopped sessions when navigation-only last-used time changes", () => {
    const items = deriveSidebarWorkspaceViewModels({
      workspaceSections: [workspaceSection([])],
      storedSessions: [
        storedSession({
          id: "newer-conversation",
          updatedAt: "2026-04-15T00:02:00.000Z",
          lastUsedAt: "2026-04-15T00:02:00.000Z",
        }),
        storedSession({
          id: "recently-opened-older-conversation",
          updatedAt: "2026-04-15T00:01:00.000Z",
          lastUsedAt: "2026-04-15T00:10:00.000Z",
        }),
      ],
      selectedWorkspaceDir: "/workspace/rah",
      selectedSessionId: null,
      unreadSessionIds: new Set(),
      runtimeStatusBySessionId: new Map(),
      pinnedItems: [],
    });

    assert.deepEqual(
      items[0]?.sessions.map((entry) => entry.storedRef?.providerSessionId),
      ["newer-conversation", "recently-opened-older-conversation"],
    );
  });

  test("selection and navigation metadata cannot change row identity, count, or order", () => {
    const storedSessions = [
      storedSession({
        id: "newer-conversation",
        updatedAt: "2026-04-15T00:02:00.000Z",
        lastUsedAt: "2026-04-15T00:02:00.000Z",
      }),
      storedSession({
        id: "older-conversation",
        updatedAt: "2026-04-15T00:01:00.000Z",
        lastUsedAt: "2026-04-15T00:01:00.000Z",
      }),
    ];
    const derive = (
      sessions: StoredSessionRef[],
      selectedStoredSessionKey: string | null,
    ) => deriveSidebarWorkspaceViewModels({
      workspaceSections: [workspaceSection([])],
      storedSessions: sessions,
      selectedWorkspaceDir: "/workspace/rah",
      selectedSessionId: null,
      selectedStoredSessionKey,
      unreadSessionIds: new Set(),
      runtimeStatusBySessionId: new Map(),
      pinnedItems: [],
    })[0]!.sessions.map((entry) => ({
      stableKey: entry.stableKey,
      id: entry.id,
      selected: entry.selected,
    }));

    const before = derive(storedSessions, null);
    const after = derive([
      storedSessions[0]!,
      { ...storedSessions[1]!, lastUsedAt: "2026-04-15T00:10:00.000Z" },
    ], "opencode:older-conversation");

    assert.deepEqual(
      after.map(({ stableKey, id }) => ({ stableKey, id })),
      before.map(({ stableKey, id }) => ({ stableKey, id })),
    );
    assert.deepEqual(after.map((entry) => entry.selected), [false, true]);
  });

  test("selects the Council row without also selecting its workspace row", () => {
    const workspaceSections = [workspaceSection([])];
    const items = deriveSidebarWorkspaceViewModels({
      workspaceSections,
      selectedWorkspaceDir: "/workspace/rah",
      selectedSessionId: null,
      selectedCouncilId: "selected-council",
      unreadSessionIds: new Set(),
      runtimeStatusBySessionId: new Map(),
      pinnedItems: [],
    });
    const councilItems = deriveSidebarCouncilViewModels({
      workspaceSections,
      selectedCouncilId: "selected-council",
      councils: [council({ id: "selected-council" })],
    });

    assert.equal(items[0]?.selected, false);
    assert.equal(councilItems[0]?.selected, true);
  });

  test("uses session summary updates when loaded feed activity is stale", () => {
    const freshUpdatedAt = new Date(Date.now() - 5 * 60_000).toISOString();
    const staleFeedActivityAt = new Date(Date.now() - 9 * 60 * 60_000).toISOString();
    const staleFeed = session({
      id: "stale-feed",
      updatedAt: freshUpdatedAt,
    });
    const older = session({
      id: "older",
      updatedAt: new Date(Date.now() - 20 * 60_000).toISOString(),
    });

    const items = deriveSidebarWorkspaceViewModels({
      workspaceSections: [workspaceSection([older, staleFeed])],
      selectedWorkspaceDir: "/workspace/rah",
      selectedSessionId: null,
      unreadSessionIds: new Set(),
      runtimeStatusBySessionId: new Map(),
      pinnedItems: [],
      runningSessionActivityAtById: new Map([
        ["stale-feed", staleFeedActivityAt],
        ["older", new Date(Date.now() - 20 * 60_000).toISOString()],
      ]),
    });

    assert.equal(
      items[0]?.sessions.find((entry) => entry.id === "stale-feed")?.updatedAtLabel,
      "5m",
    );
  });

  test("uses error > working > unread > running precedence", () => {
    const failed = session({ id: "failed", runtimeState: "failed" });
    const approval = session({ id: "approval", runtimeState: "waiting_permission" });
    const thinking = session({ id: "thinking", runtimeState: "idle" });
    const unread = session({ id: "unread", runtimeState: "idle" });
    const ready = session({ id: "ready", runtimeState: "idle" });

    const items = deriveSidebarWorkspaceViewModels({
      workspaceSections: [workspaceSection([failed, approval, thinking, unread, ready])],
      selectedWorkspaceDir: "/workspace/rah",
      selectedSessionId: "ready",
      unreadSessionIds: new Set(["unread"]),
      runtimeStatusBySessionId: new Map([
        ["thinking", "thinking"],
      ]),
      pinnedItems: [],
    });

    const sessions = items[0]?.sessions ?? [];
    assert.equal(sessions.find((entry) => entry.id === "failed")?.status, "error");
    assert.equal(sessions.find((entry) => entry.id === "approval")?.status, "working");
    assert.equal(sessions.find((entry) => entry.id === "thinking")?.status, "working");
    assert.equal(sessions.find((entry) => entry.id === "unread")?.status, "unread");
    assert.equal(sessions.find((entry) => entry.id === "ready")?.status, "running");
  });

  test("uses session conversation activity for sidebar recency when available", () => {
    const items = deriveSidebarWorkspaceViewModels({
      workspaceSections: [workspaceSection([
        session({
          id: "background-refresh",
          updatedAt: "2026-05-01T10:59:00.000Z",
        }),
        session({
          id: "human-activity",
          updatedAt: "2026-05-01T10:02:00.000Z",
        }),
      ])],
      selectedWorkspaceDir: "/workspace/rah",
      selectedSessionId: null,
      unreadSessionIds: new Set(),
      runtimeStatusBySessionId: new Map(),
      pinnedItems: [],
      runningSessionActivityAtById: new Map([
        ["background-refresh", "2026-05-01T10:01:00.000Z"],
        ["human-activity", "2026-05-01T10:10:00.000Z"],
      ]),
    });

    assert.deepEqual(
      items[0]?.sessions.map((entry) => entry.id),
      ["human-activity", "background-refresh"],
    );
  });

  test("defensively excludes Council agent sessions from workspace rows", () => {
    const items = deriveSidebarWorkspaceViewModels({
      workspaceSections: [workspaceSection([
        session({
          id: "council-agent",
          origin: {
            kind: "council",
            councilId: "council-1",
            councilTitle: "Council",
            agentId: "agent-1",
            agentLabel: "Agent",
          },
        }),
      ])],
      selectedWorkspaceDir: "/workspace/rah",
      selectedSessionId: null,
      unreadSessionIds: new Set(),
      runtimeStatusBySessionId: new Map(),
      pinnedItems: [],
    });

    assert.deepEqual(items[0]?.sessions, []);
  });

  test("keeps running Councils out of workspace models and projects them independently", () => {
    const workspaceSections = [
      workspaceSection([session({ id: "session-1" })], "/workspace/rah"),
    ];
    const workspaces = deriveSidebarWorkspaceViewModels({
      workspaceSections,
      selectedWorkspaceDir: "/workspace/rah",
      selectedSessionId: null,
      selectedCouncilId: "council-1",
      unreadSessionIds: new Set(),
      runtimeStatusBySessionId: new Map(),
      pinnedItems: [],
    });
    const councilItems = deriveSidebarCouncilViewModels({
      workspaceSections,
      selectedCouncilId: "council-1",
      councils: [
        council({ id: "council-1", status: "running", phase: "ready" }),
        council({ id: "stopped-council", status: "stopped" }),
        council({ id: "other-council", workspace: "/workspace/not-added" }),
      ],
    });

    assert.deepEqual(workspaces[0]?.items.map((item) => item.id), ["session-1"]);
    assert.equal(workspaces[0]?.selected, false);
    assert.deepEqual(
      councilItems.map((item) => item.id).sort(),
      ["council-1", "other-council"],
    );
    assert.equal(councilItems.find((item) => item.id === "council-1")?.selected, true);
    assert.equal(
      councilItems.find((item) => item.id === "other-council")?.workspaceDir,
      "/workspace/not-added",
    );
  });

  test("uses visible Council chat activity for independent sidebar recency", () => {
    const items = deriveSidebarCouncilViewModels({
      workspaceSections: [workspaceSection([], "/workspace/rah")],
      selectedCouncilId: null,
      councils: [
        council({
          id: "status-refresh",
          createdAt: "2026-04-15T00:00:00.000Z",
          updatedAt: "2026-04-15T00:10:00.000Z",
          messages: [
            {
              id: 1,
              councilId: "status-refresh",
              actorId: "system",
              role: "system",
              parts: [{ kind: "text", text: "agent listening" }],
              createdAt: "2026-04-15T00:10:00.000Z",
            },
          ],
        }),
        council({
          id: "user-chat",
          createdAt: "2026-04-15T00:00:00.000Z",
          updatedAt: "2026-04-15T00:02:00.000Z",
          messages: [
            {
              id: 2,
              councilId: "user-chat",
              actorId: "user",
              role: "user",
              parts: [{ kind: "text", text: "real task" }],
              createdAt: "2026-04-15T00:02:00.000Z",
            },
          ],
        }),
      ],
    });

    assert.deepEqual(items.map((entry) => entry.id), ["user-chat", "status-refresh"]);
  });

  test("ignores legacy Council pins without hiding the independent Council row", () => {
    const workspaceSections = [
      workspaceSection([session({ id: "agent" })], "/workspace/rah"),
    ];
    const legacyCouncilPin = {
      workspaceDir: "/workspace/rah",
      itemKey: "council:council-1",
    };
    const workspaces = deriveSidebarWorkspaceViewModels({
      workspaceSections,
      selectedWorkspaceDir: "/workspace/rah",
      selectedSessionId: null,
      selectedCouncilId: null,
      unreadSessionIds: new Set(),
      runtimeStatusBySessionId: new Map(),
      pinnedItems: [legacyCouncilPin],
    });
    const partition = partitionSidebarPinnedItems(workspaces, [legacyCouncilPin]);
    const councilItems = deriveSidebarCouncilViewModels({
      workspaceSections,
      selectedCouncilId: null,
      councils: [council({ id: "council-1", workspace: "/workspace/rah" })],
    });

    assert.deepEqual(partition.pinnedItems, []);
    assert.deepEqual(partition.workspaces[0]?.items.map((entry) => entry.id), ["agent"]);
    assert.deepEqual(councilItems.map((entry) => entry.id), ["council-1"]);
    assert.equal("pinned" in councilItems[0]!, false);
  });

  test("globally sorts independent running Councils across workspace boundaries", () => {
    const workspaceSections = [
      workspaceSection([], "/workspace/one"),
      workspaceSection([], "/workspace/two"),
    ];
    const items = deriveSidebarCouncilViewModels({
      workspaceSections,
      selectedCouncilId: null,
      councils: [
        council({
          id: "older-council",
          workspace: "/workspace/one",
          messages: [{
            id: 1,
            councilId: "older-council",
            actorId: "user",
            role: "user",
            parts: [{ kind: "text", text: "older" }],
            createdAt: "2026-04-15T00:01:00.000Z",
          }],
        }),
        council({
          id: "newer-council",
          workspace: "/workspace/two",
          messages: [{
            id: 2,
            councilId: "newer-council",
            actorId: "user",
            role: "user",
            parts: [{ kind: "text", text: "newer" }],
            createdAt: "2026-04-15T00:02:00.000Z",
          }],
        }),
        council({
          id: "stopped-council",
          workspace: "/workspace/one",
          status: "stopped",
          phase: "ended",
        }),
      ],
    });

    assert.deepEqual(
      items.map((item) => [item.workspaceDir, item.id]),
      [
        ["/workspace/two", "newer-council"],
        ["/workspace/one", "older-council"],
      ],
    );
  });

  test("drops legacy Council pins even before session inventories are ready", () => {
    const refs = [
      { workspaceDir: "/workspace/rah", itemKey: "session:session-1" },
      { workspaceDir: "/workspace/rah", itemKey: "council:council-1" },
    ];

    assert.deepEqual(
      reconcilePinnedSidebarItems(refs, [], [], {
        sessions: false,
        storedSessions: false,
      }),
      [refs[0]],
    );
    assert.deepEqual(
      reconcilePinnedSidebarItems(refs, [], [], {
        sessions: true,
        storedSessions: false,
      }),
      [],
    );
  });

  test("prunes stale pins only after loaded inventories prove they no longer exist", () => {
    const refs = [
      { workspaceDir: "/workspace/rah", itemKey: "session:session-1" },
      { workspaceDir: "/workspace/rah", itemKey: "council:council-1" },
    ];
    const sections = [workspaceSection([session({ id: "session-1" })])];

    assert.deepEqual(
      reconcilePinnedSidebarItems(refs, sections, [], {
        sessions: true,
        storedSessions: true,
      }),
      [refs[0]],
    );
    assert.deepEqual(
      reconcilePinnedSidebarItems(refs, [workspaceSection([])], [], {
        sessions: true,
        storedSessions: true,
      }),
      [],
    );
  });

  test("reconciles provider-identity pins against the stored catalog", () => {
    const ref = {
      workspaceDir: "/workspace/rah",
      itemKey: "session:claude:stored-claude",
    };
    const stored = storedSession({ id: "stored-claude", provider: "claude" });

    assert.deepEqual(
      reconcilePinnedSidebarItems(
        [ref],
        [workspaceSection([])],
        [stored],
        { sessions: true, storedSessions: true },
      ),
      [ref],
    );
    assert.deepEqual(
      reconcilePinnedSidebarItems(
        [ref],
        [workspaceSection([])],
        [],
        { sessions: true, storedSessions: true },
      ),
      [],
    );
  });

  test("does not project Council-owned MCP listener sessions into workspaces", () => {
    const items = deriveSidebarWorkspaceViewModels({
      workspaceSections: [workspaceSection([
        session({
          id: "council-agent",
          runtimeState: "running",
          phase: "working",
          origin: {
            kind: "council",
            councilId: "council-1",
            councilTitle: "Council",
            agentId: "agent-1",
            agentLabel: "Agent",
          },
        }),
      ])],
      selectedWorkspaceDir: "/workspace/rah",
      selectedSessionId: null,
      unreadSessionIds: new Set(),
      runtimeStatusBySessionId: new Map([["council-agent", "thinking"]]),
      pinnedItems: [],
    });

    assert.deepEqual(items[0]?.sessions, []);
  });

  test("projects unread and failed running Councils through the shared status protocol", () => {
    const workspaceSections = [workspaceSection([])];
    const failedCouncil = council({ id: "failed-council" });
    failedCouncil.error = "transport disconnected";
    const items = deriveSidebarCouncilViewModels({
      workspaceSections,
      selectedCouncilId: null,
      unreadCouncilIds: new Set(["unread-council"]),
      councils: [
        council({ id: "working-council", phase: "working" }),
        council({ id: "unread-council", phase: "ready" }),
        failedCouncil,
        council({ id: "running-council", phase: "ready" }),
      ],
    });

    assert.equal(items.find((entry) => entry.id === "working-council")?.status, "working");
    assert.equal(items.find((entry) => entry.id === "unread-council")?.status, "unread");
    assert.equal(items.find((entry) => entry.id === "failed-council")?.status, "error");
    assert.equal(items.find((entry) => entry.id === "running-council")?.status, "running");
  });

  test("preserves locally active Councils across stale list refreshes", () => {
    const active = council({ id: "active-council", status: "running", phase: "starting" });
    const stopped = council({ id: "stopped-council", status: "stopped", phase: "ended" });
    const incoming = [council({ id: "older-council", status: "stopped", phase: "ended" })];

    const merged = mergeCouncilLists([active, stopped], incoming);

    assert.deepEqual(
      merged.map((entry) => entry.id),
      ["older-council", "active-council"],
    );
    assert.equal(merged.find((entry) => entry.id === "active-council")?.status, "running");
    assert.equal(merged.some((entry) => entry.id === "stopped-council"), false);
  });
});

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { CouncilSnapshot, SessionSummary } from "@rah/runtime-protocol";
import { conversationStateFromRuntimeState } from "@rah/runtime-protocol";
import { deriveSidebarWorkspaceViewModels } from "./sidebar-view-model";
import { formatCompactRelativeTime, type WorkspaceSection } from "./session-browser";

function session(args: {
  id: string;
  runtimeState?: SessionSummary["session"]["runtimeState"];
  phase?: SessionSummary["session"]["phase"];
  updatedAt?: string;
  origin?: SessionSummary["session"]["origin"];
}): SessionSummary {
  const conversationState = conversationStateFromRuntimeState(args.runtimeState ?? "running");
  return {
    session: {
      id: args.id,
      provider: "opencode",
      providerSessionId: `${args.id}-provider`,
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

  test("pins the configured session first inside a workspace", () => {
    const items = deriveSidebarWorkspaceViewModels({
      workspaceSections: [workspaceSection([session({ id: "a" }), session({ id: "b" })])],
      selectedWorkspaceDir: "/workspace/rah",
      selectedSessionId: null,
      unreadSessionIds: new Set(),
      runtimeStatusBySessionId: new Map(),
      pinnedSessionIdByWorkspace: {
        "/workspace/rah": "b",
      },
    });

    assert.deepEqual(items[0]?.sessions.map((entry) => entry.id), ["b", "a"]);
    assert.equal(items[0]?.sessions[0]?.pinned, true);
    assert.equal(items[0]?.selected, true);
  });

  test("uses waiting permission > working > unread > ready precedence", () => {
    const approval = session({ id: "approval", runtimeState: "waiting_permission" });
    const thinking = session({ id: "thinking", runtimeState: "idle" });
    const unread = session({ id: "unread", runtimeState: "idle" });
    const ready = session({ id: "ready", runtimeState: "idle" });

    const items = deriveSidebarWorkspaceViewModels({
      workspaceSections: [workspaceSection([approval, thinking, unread, ready])],
      selectedWorkspaceDir: "/workspace/rah",
      selectedSessionId: "ready",
      unreadSessionIds: new Set(["unread"]),
      runtimeStatusBySessionId: new Map([
        ["thinking", "thinking"],
      ]),
      pinnedSessionIdByWorkspace: {},
    });

    const sessions = items[0]?.sessions ?? [];
    assert.equal(sessions.find((entry) => entry.id === "approval")?.status, "waiting_permission");
    assert.equal(sessions.find((entry) => entry.id === "thinking")?.status, "working");
    assert.equal(sessions.find((entry) => entry.id === "unread")?.status, "unread");
    assert.equal(sessions.find((entry) => entry.id === "ready")?.status, "ready");
  });

  test("projects council session origin for sidebar styling", () => {
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
      pinnedSessionIdByWorkspace: {},
    });

    assert.equal(items[0]?.sessions[0]?.originKind, "council");
  });

  test("projects live Councils into their owning workspace", () => {
    const items = deriveSidebarWorkspaceViewModels({
      workspaceSections: [workspaceSection([session({ id: "session-1" })])],
      selectedWorkspaceDir: "/workspace/rah",
      selectedSessionId: null,
      selectedCouncilId: "council-1",
      unreadSessionIds: new Set(),
      runtimeStatusBySessionId: new Map(),
      pinnedSessionIdByWorkspace: {},
      councils: [
        council({ id: "council-1", status: "running", phase: "ready" }),
        council({ id: "archived-council", status: "stopped" }),
        council({ id: "other-council", workspace: "/workspace/other" }),
      ],
    });

    assert.deepEqual(items[0]?.councils.map((council) => council.id), ["council-1"]);
    assert.equal(items[0]?.councils[0]?.statusLabel, "ready");
    assert.equal(items[0]?.councils[0]?.selected, true);
    assert.deepEqual(
      items[0]?.items.map((item) => item.kind),
      ["session", "council"],
    );
  });

  test("does not duplicate nested workspace Councils or reorder on selection", () => {
    const items = deriveSidebarWorkspaceViewModels({
      workspaceSections: [
        workspaceSection([], "/workspace"),
        workspaceSection([session({ id: "agent" })], "/workspace/rah"),
      ],
      selectedWorkspaceDir: "/workspace/rah",
      selectedSessionId: null,
      selectedCouncilId: "council-1",
      unreadSessionIds: new Set(),
      runtimeStatusBySessionId: new Map(),
      pinnedSessionIdByWorkspace: {},
      councils: [
        council({
          id: "council-1",
          workspace: "/workspace/rah",
          updatedAt: "2026-04-15T00:01:00.000Z",
        }),
      ],
    });

    assert.deepEqual(items[0]?.councils.map((entry) => entry.id), []);
    assert.deepEqual(items[1]?.councils.map((entry) => entry.id), ["council-1"]);
    assert.deepEqual(
      items[1]?.items.map((entry) => entry.id),
      ["agent", "council-1"],
    );
  });

  test("uses visible Council chat activity for sidebar recency", () => {
    const items = deriveSidebarWorkspaceViewModels({
      workspaceSections: [workspaceSection([], "/workspace/rah")],
      selectedWorkspaceDir: "/workspace/rah",
      selectedSessionId: null,
      selectedCouncilId: null,
      unreadSessionIds: new Set(),
      runtimeStatusBySessionId: new Map(),
      pinnedSessionIdByWorkspace: {},
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

    assert.deepEqual(items[0]?.councils.map((entry) => entry.id), ["user-chat", "status-refresh"]);
  });

  test("pins Council rows with the same workspace pin affordance as sessions", () => {
    const items = deriveSidebarWorkspaceViewModels({
      workspaceSections: [workspaceSection([session({ id: "agent" })], "/workspace/rah")],
      selectedWorkspaceDir: "/workspace/rah",
      selectedSessionId: null,
      selectedCouncilId: null,
      unreadSessionIds: new Set(),
      runtimeStatusBySessionId: new Map(),
      pinnedSessionIdByWorkspace: {
        "/workspace/rah": "council:council-1",
      },
      councils: [
        council({
          id: "council-1",
          workspace: "/workspace/rah",
          messages: [
            {
              id: 1,
              councilId: "council-1",
              actorId: "user",
              role: "user",
              parts: [{ kind: "text", text: "real task" }],
              createdAt: "2026-04-15T00:02:00.000Z",
            },
          ],
        }),
      ],
    });

    assert.equal(items[0]?.councils[0]?.pinned, true);
    assert.deepEqual(items[0]?.items.map((entry) => entry.id), ["council-1", "agent"]);
  });

  test("does not mark Council-owned sessions working for MCP listener activity", () => {
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
      pinnedSessionIdByWorkspace: {},
    });

    assert.equal(items[0]?.sessions[0]?.status, "ready");
  });
});

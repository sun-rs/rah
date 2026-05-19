import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { CouncilRoomSnapshot, SessionSummary } from "@rah/runtime-protocol";
import { conversationStateFromRuntimeState } from "@rah/runtime-protocol";
import { deriveSidebarWorkspaceViewModels } from "./sidebar-view-model";
import type { WorkspaceSection } from "./session-browser";

function session(args: {
  id: string;
  runtimeState?: SessionSummary["session"]["runtimeState"];
  updatedAt?: string;
  origin?: SessionSummary["session"]["origin"];
}): SessionSummary {
  return {
    session: {
      id: args.id,
      provider: "opencode",
      providerSessionId: `${args.id}-provider`,
      launchSource: "web",
      cwd: "/workspace/rah",
      rootDir: "/workspace/rah",
      ...conversationStateFromRuntimeState(args.runtimeState ?? "running"),
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

function workspaceSection(sessions: SessionSummary[]): WorkspaceSection {
  return {
    workspace: {
      directory: "/workspace/rah",
      displayName: "workspace/rah",
      latestUpdatedAt: "2026-04-15T00:00:00.000Z",
      runningCount: sessions.length,
      hasRunningItem: true,
      hasBlockingRunningSessions: true,
    },
    sessions,
  };
}

function councilRoom(args: {
  id: string;
  workspace?: string;
  status?: CouncilRoomSnapshot["room"]["status"];
  phase?: CouncilRoomSnapshot["room"]["phase"];
  updatedAt?: string;
}): CouncilRoomSnapshot {
  return {
    room: {
      id: args.id,
      title: args.id,
      workspace: args.workspace ?? "/workspace/rah",
      status: args.status ?? "running",
      phase: args.phase ?? "ready",
      createdAt: "2026-04-15T00:00:00.000Z",
      updatedAt: args.updatedAt ?? "2026-04-15T00:00:00.000Z",
    },
    agents: [],
    messages: [],
  };
}

describe("sidebar view model", () => {
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
            roomId: "room-1",
            roomTitle: "Room",
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

  test("projects live council rooms into their owning workspace", () => {
    const items = deriveSidebarWorkspaceViewModels({
      workspaceSections: [workspaceSection([session({ id: "session-1" })])],
      selectedWorkspaceDir: "/workspace/rah",
      selectedSessionId: null,
      selectedCouncilRoomId: "room-1",
      unreadSessionIds: new Set(),
      runtimeStatusBySessionId: new Map(),
      pinnedSessionIdByWorkspace: {},
      councilRooms: [
        councilRoom({ id: "room-1", status: "running", phase: "ready" }),
        councilRoom({ id: "archived-room", status: "stopped" }),
        councilRoom({ id: "other-room", workspace: "/workspace/other" }),
      ],
    });

    assert.deepEqual(items[0]?.councilRooms.map((room) => room.id), ["room-1"]);
    assert.equal(items[0]?.councilRooms[0]?.statusLabel, "ready");
    assert.equal(items[0]?.councilRooms[0]?.selected, true);
    assert.deepEqual(
      items[0]?.items.map((item) => item.kind),
      ["council_room", "session"],
    );
  });
});

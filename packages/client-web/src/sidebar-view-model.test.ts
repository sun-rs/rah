import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { SessionSummary } from "@rah/runtime-protocol";
import { deriveSidebarWorkspaceViewModels } from "./sidebar-view-model";
import type { WorkspaceSection } from "./session-browser";

function session(args: {
  id: string;
  runtimeState?: SessionSummary["session"]["runtimeState"];
  updatedAt?: string;
}): SessionSummary {
  return {
    session: {
      id: args.id,
      provider: "kimi",
      providerSessionId: `${args.id}-provider`,
      launchSource: "web",
      cwd: "/workspace/rah",
      rootDir: "/workspace/rah",
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
      liveCount: sessions.length,
      hasRunningItem: true,
      hasBlockingLiveSessions: true,
    },
    sessions,
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

  test("uses approval > thinking > unread > ready precedence", () => {
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
    assert.equal(sessions.find((entry) => entry.id === "approval")?.status, "approval");
    assert.equal(sessions.find((entry) => entry.id === "thinking")?.status, "thinking");
    assert.equal(sessions.find((entry) => entry.id === "unread")?.status, "unread");
    assert.equal(sessions.find((entry) => entry.id === "ready")?.status, "ready");
  });
});

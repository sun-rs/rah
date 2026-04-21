import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { SessionSummary, StoredSessionRef } from "@rah/runtime-protocol";
import { reconcileVisibleWorkspaceSelection } from "./useSessionStore";

function sessionSummary(rootDir: string): SessionSummary {
  return {
    session: {
      id: `session:${rootDir}`,
      provider: "codex",
      providerSessionId: `provider:${rootDir}`,
      launchSource: "web",
      cwd: rootDir,
      rootDir,
      runtimeState: "running",
      ptyId: `pty:${rootDir}`,
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
      createdAt: "2026-04-21T00:00:00.000Z",
      updatedAt: "2026-04-21T00:00:00.000Z",
    },
    attachedClients: [],
    controlLease: { sessionId: `session:${rootDir}` },
  };
}

describe("workspace response reconciliation", () => {
  test("keeps hidden deletions filtered when an older response still includes them", () => {
    const reconciled = reconcileVisibleWorkspaceSelection({
      workspaceDirs: ["/workspace/a", "/workspace/b", "/workspace/c"],
      sessions: [sessionSummary("/workspace/c")],
      storedSessions: [],
      activeWorkspaceDir: "/workspace/a",
      currentWorkspaceDir: "",
      hiddenWorkspaceDirs: ["/workspace/a", "/workspace/b"],
    });

    assert.deepEqual(reconciled.workspaceDirs, ["/workspace/c"]);
    assert.equal(reconciled.workspaceDir, "/workspace/c");
  });

  test("falls back to empty selection when every visible workspace is hidden", () => {
    const reconciled = reconcileVisibleWorkspaceSelection({
      workspaceDirs: ["/workspace/a"],
      sessions: [],
      storedSessions: [] as StoredSessionRef[],
      activeWorkspaceDir: "/workspace/a",
      currentWorkspaceDir: "/workspace/a",
      hiddenWorkspaceDirs: ["/workspace/a"],
    });

    assert.deepEqual(reconciled.workspaceDirs, []);
    assert.equal(reconciled.workspaceDir, "");
  });
});

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { StoredSessionRef } from "@rah/runtime-protocol";
import { buildSessionsResponse } from "./runtime-session-list";
import type { StoredSessionState } from "./session-store";

function storedSessionState(providerSessionId: string): StoredSessionState {
  return {
    session: {
      id: "live-session-1",
      provider: "codex",
      providerSessionId,
      launchSource: "web",
      cwd: "/workspace/demo",
      rootDir: "/workspace/demo",
      status: "running",
      phase: "working",
      runtimeState: "running",
      ptyId: "pty-live-session-1",
      capabilities: {
        liveAttach: true,
        structuredTimeline: true,
        nativeTui: false,
        rawPtyInput: false,
        chatMirror: false,
        structuredControl: true,
        livePermissions: false,
        contextUsage: false,
        resumeByProvider: true,
        listProviderSessions: true,
        steerInput: true,
        queuedInput: false,
        renameSession: true,
        actions: {
          info: true,
          stop: true,
          delete: true,
          rename: "native",
        },
        modelSwitch: false,
        planMode: false,
        subagents: false,
      },
      title: "Live title",
      preview: "still open",
      createdAt: "2025-07-19T22:21:00.000Z",
      updatedAt: "2025-07-19T22:22:00.000Z",
    },
    clients: [],
    controlLease: {
      sessionId: "live-session-1",
    },
    usage: {
      usedTokens: 0,
      contextWindow: 1_000_000,
      percentUsed: 0,
      percentRemaining: 100,
    },
  };
}

function storedRef(providerSessionId: string): StoredSessionRef {
  return {
    provider: "codex",
    providerSessionId,
    cwd: "/workspace/demo",
    rootDir: "/workspace/demo",
    title: "History title",
    preview: "stored preview",
    updatedAt: "2025-07-19T22:21:00.000Z",
    source: "provider_history",
  };
}

describe("buildSessionsResponse", () => {
  test("keeps provider-backed running sessions visible in stored history", () => {
    const response = buildSessionsResponse({
      liveStates: [storedSessionState("session-1")],
      discoveredStoredSessions: [storedRef("session-1")],
      remembered: {
        rememberedSessions: [],
        rememberedRecentSessions: [],
      rememberedWorkspaceDirs: ["/workspace/demo"],
      rememberedHiddenWorkspaces: [],
      rememberedHiddenSessionKeys: [],
      rememberedSessionTitleOverrides: {},
    },
      isClosingSession: () => false,
    });

    assert.ok(
      response.sessions.some(
        (entry) =>
          entry.session.provider === "codex" &&
          entry.session.providerSessionId === "session-1",
      ),
    );
    assert.ok(
      response.storedSessions.some(
        (entry) =>
          entry.provider === "codex" &&
          entry.providerSessionId === "session-1" &&
          entry.title === "History title",
      ),
    );
  });

  test("uses user title overrides for running sessions even when provider history is stale", () => {
    const response = buildSessionsResponse({
      liveStates: [storedSessionState("session-renamed")],
      discoveredStoredSessions: [storedRef("session-renamed")],
      remembered: {
        rememberedSessions: [],
        rememberedRecentSessions: [],
        rememberedWorkspaceDirs: ["/workspace/demo"],
        rememberedHiddenWorkspaces: [],
        rememberedHiddenSessionKeys: [],
        rememberedSessionTitleOverrides: {
          "codex:session-renamed": "Manual rename",
        },
      },
      isClosingSession: () => false,
    });

    assert.equal(response.sessions[0]?.session.title, "Manual rename");
    assert.equal(response.storedSessions[0]?.title, "Manual rename");
    assert.equal(response.recentSessions[0]?.title, "Manual rename");
  });

  test("builds recent sessions from the global provider history order", () => {
    const response = buildSessionsResponse({
      liveStates: [],
      discoveredStoredSessions: [
        {
          ...storedRef("external-new"),
          title: "External new",
          updatedAt: "2026-04-29T10:00:00.000Z",
        },
        {
          ...storedRef("rah-known"),
          title: "Provider title",
          updatedAt: "2026-04-28T10:00:00.000Z",
        },
        {
          ...storedRef("external-old"),
          title: "External old",
          updatedAt: "2026-04-27T10:00:00.000Z",
        },
      ],
      remembered: {
        rememberedSessions: [],
        rememberedRecentSessions: [
          {
            provider: "codex",
            providerSessionId: "rah-known",
            cwd: "/workspace/demo",
            rootDir: "/workspace/demo",
            title: "Remembered title",
            updatedAt: "2026-04-28T09:00:00.000Z",
            lastUsedAt: "2026-04-29T09:00:00.000Z",
            source: "previous_running",
          },
        ],
        rememberedWorkspaceDirs: ["/workspace/demo"],
        rememberedHiddenWorkspaces: [],
        rememberedHiddenSessionKeys: [],
        rememberedSessionTitleOverrides: {},
      },
      isClosingSession: () => false,
    });

    assert.deepEqual(
      response.recentSessions.map((session) => session.providerSessionId),
      ["external-new", "rah-known", "external-old"],
    );
    assert.equal(response.recentSessions[1]?.title, "Provider title");
    assert.equal(response.recentSessions[1]?.lastUsedAt, "2026-04-29T09:00:00.000Z");
  });

  test("can return only recent stored sessions for lightweight app bootstrap", () => {
    const storedSessions = Array.from({ length: 20 }, (_, index) => ({
      ...storedRef(`session-${index}`),
      updatedAt: `2026-04-${String(index + 1).padStart(2, "0")}T10:00:00.000Z`,
    }));

    const response = buildSessionsResponse({
      liveStates: [],
      discoveredStoredSessions: storedSessions,
      remembered: {
        rememberedSessions: [],
        rememberedRecentSessions: [],
        rememberedWorkspaceDirs: ["/workspace/demo"],
        rememberedHiddenWorkspaces: [],
        rememberedHiddenSessionKeys: [],
        rememberedSessionTitleOverrides: {},
      },
      isClosingSession: () => false,
      storedSessionsMode: "recent",
    });

    assert.equal(response.recentSessions.length, 15);
    assert.deepEqual(response.storedSessions, response.recentSessions);
    assert.deepEqual(
      response.storedSessions.map((session) => session.providerSessionId),
      Array.from({ length: 15 }, (_, index) => `session-${19 - index}`),
    );
  });

  test("uses running session conversation activity for recent timestamps", () => {
    const liveState = storedSessionState("live-activity");
    liveState.session.updatedAt = "2026-05-19T10:30:00.000Z";
    liveState.conversationActivityAt = "2026-05-19T10:05:00.000Z";

    const response = buildSessionsResponse({
      liveStates: [liveState],
      discoveredStoredSessions: [],
      remembered: {
        rememberedSessions: [],
        rememberedRecentSessions: [],
        rememberedWorkspaceDirs: ["/workspace/demo"],
        rememberedHiddenWorkspaces: [],
        rememberedHiddenSessionKeys: [],
        rememberedSessionTitleOverrides: {},
      },
      isClosingSession: () => false,
    });

    assert.equal(response.recentSessions[0]?.providerSessionId, "live-activity");
    assert.equal(response.recentSessions[0]?.updatedAt, "2026-05-19T10:05:00.000Z");
    assert.equal(response.recentSessions[0]?.lastUsedAt, "2026-05-19T10:05:00.000Z");
  });

  test("filters internal native TUI launch probe sessions from user-facing lists", () => {
    const probeWorkspace = "/repo/rah/test-results/native-real-tui-workspaces/codex";
    const normalWorkspace = "/workspace/demo";
    const probeSession: StoredSessionRef = {
      ...storedRef("probe-session"),
      cwd: probeWorkspace,
      rootDir: probeWorkspace,
      title: "Internal probe",
      updatedAt: "2026-05-03T10:00:00.000Z",
    };
    const normalSession: StoredSessionRef = {
      ...storedRef("normal-session"),
      cwd: normalWorkspace,
      rootDir: normalWorkspace,
      title: "Normal session",
      updatedAt: "2026-05-03T09:00:00.000Z",
    };
    const probeLiveState = storedSessionState("probe-live");
    probeLiveState.session.cwd = probeWorkspace;
    probeLiveState.session.rootDir = probeWorkspace;

    const response = buildSessionsResponse({
      liveStates: [probeLiveState],
      discoveredStoredSessions: [probeSession, normalSession],
      remembered: {
        rememberedSessions: [probeSession],
        rememberedRecentSessions: [probeSession],
        rememberedWorkspaceDirs: [probeWorkspace, normalWorkspace],
        rememberedHiddenWorkspaces: [probeWorkspace],
        rememberedActiveWorkspaceDir: probeWorkspace,
        rememberedHiddenSessionKeys: [],
        rememberedSessionTitleOverrides: {},
      },
      isClosingSession: () => false,
    });

    assert.deepEqual(
      response.storedSessions.map((session) => session.providerSessionId),
      ["normal-session"],
    );
    assert.deepEqual(
      response.recentSessions.map((session) => session.providerSessionId),
      ["normal-session"],
    );
    assert.deepEqual(response.workspaceDirs, [normalWorkspace]);
    assert.deepEqual(response.hiddenWorkspaces, []);
    assert.equal(response.activeWorkspaceDir, undefined);
    assert.deepEqual(response.sessions, []);
  });

  test("dedupes workspace dirs by resolved symlink path even when the child directory is gone", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "rah-workspace-symlink-"));
    try {
      const target = path.join(root, "target");
      const alias = path.join(root, "alias");
      mkdirSync(target);
      symlinkSync(target, alias, "dir");
      const aliasWorkspace = path.join(alias, "crates", "AI", "synapse");
      const targetWorkspace = path.join(target, "crates", "AI", "synapse");

      const response = buildSessionsResponse({
        liveStates: [],
        discoveredStoredSessions: [],
        remembered: {
          rememberedSessions: [],
          rememberedRecentSessions: [],
          rememberedWorkspaceDirs: [aliasWorkspace, targetWorkspace],
          rememberedHiddenWorkspaces: [],
          rememberedHiddenSessionKeys: [],
          rememberedSessionTitleOverrides: {},
        },
        isClosingSession: () => false,
      });

      assert.deepEqual(response.workspaceDirs, [aliasWorkspace]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

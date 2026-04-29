import { describe, test } from "node:test";
import assert from "node:assert/strict";
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
      runtimeState: "running",
      ptyId: "pty-live-session-1",
      capabilities: {
        liveAttach: true,
        structuredTimeline: true,
        livePermissions: false,
        contextUsage: false,
        resumeByProvider: true,
        listProviderSessions: true,
        steerInput: true,
        queuedInput: false,
        renameSession: true,
        actions: {
          info: true,
          archive: true,
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
  test("keeps provider-backed live sessions visible in stored history", () => {
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
            source: "previous_live",
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
});

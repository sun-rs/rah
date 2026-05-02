import test from "node:test";
import assert from "node:assert/strict";
import type { SessionSummary } from "@rah/runtime-protocol";
import { canSessionArchive, isSessionControlLocked } from "./session-capabilities";

function summaryWithArchiveCapability(archive: boolean): SessionSummary {
  return {
    session: {
      id: "session-1",
      provider: "codex",
      launchSource: "web",
      cwd: "/workspace/rah",
      rootDir: "/workspace/rah",
      runtimeState: "idle",
      ptyId: "pty-1",
      capabilities: {
        liveAttach: true,
        structuredTimeline: true,
        livePermissions: true,
        contextUsage: true,
        resumeByProvider: true,
        listProviderSessions: true,
        renameSession: false,
        actions: {
          info: true,
          archive,
          delete: false,
          rename: "none",
        },
        steerInput: true,
        queuedInput: false,
        modelSwitch: false,
        planMode: false,
        subagents: false,
      },
      createdAt: "2026-04-15T00:00:00.000Z",
      updatedAt: "2026-04-15T00:00:00.000Z",
    },
    attachedClients: [],
    controlLease: { sessionId: "session-1" },
  };
}

test("canSessionArchive follows the provider action capability", () => {
  assert.equal(canSessionArchive(summaryWithArchiveCapability(true)), true);
  assert.equal(canSessionArchive(summaryWithArchiveCapability(false)), false);
});

test("session controls are unlocked after failed and stopped states", () => {
  const summary = summaryWithArchiveCapability(true);
  assert.equal(
    isSessionControlLocked({
      ...summary,
      session: { ...summary.session, runtimeState: "running" },
    }),
    true,
  );
  assert.equal(
    isSessionControlLocked({
      ...summary,
      session: { ...summary.session, runtimeState: "waiting_permission" },
    }),
    true,
  );
  assert.equal(
    isSessionControlLocked({
      ...summary,
      session: { ...summary.session, runtimeState: "failed" },
    }),
    false,
  );
  assert.equal(
    isSessionControlLocked({
      ...summary,
      session: { ...summary.session, runtimeState: "stopped" },
    }),
    false,
  );
});

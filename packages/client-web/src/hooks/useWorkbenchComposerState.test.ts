import assert from "node:assert/strict";
import test from "node:test";
import type { SessionSummary } from "@rah/runtime-protocol";
import {
  composerDraftKey,
  updateComposerDraftMap,
} from "./useWorkbenchComposerState";

function summary(id: string, providerSessionId: string): SessionSummary {
  return {
    session: {
      id,
      provider: "codex",
      providerSessionId,
      launchSource: "web",
      status: "running",
      phase: "ready",
      cwd: "/tmp/rah",
      rootDir: "/tmp/rah",
      runtimeState: "idle",
      ptyId: id,
      capabilities: {
        liveAttach: true,
        structuredTimeline: true,
        nativeTui: false,
        rawPtyInput: false,
        chatMirror: false,
        structuredControl: true,
        livePermissions: true,
        contextUsage: true,
        resumeByProvider: true,
        listProviderSessions: true,
        actions: { info: true, stop: true, delete: true, rename: "native" },
        steerInput: true,
        queuedInput: true,
        modelSwitch: true,
        planMode: true,
        subagents: true,
      },
      createdAt: "2026-07-21T00:00:00.000Z",
      updatedAt: "2026-07-21T00:00:00.000Z",
    },
    attachedClients: [],
    controlLease: { sessionId: id },
  };
}

test("composer drafts remain isolated by provider session across runtime id changes", () => {
  const keyA = composerDraftKey(summary("runtime-a", "provider-a"));
  const keyB = composerDraftKey(summary("runtime-b", "provider-b"));
  const resumedKeyA = composerDraftKey(summary("runtime-a-resumed", "provider-a"));
  assert.ok(keyA);
  assert.ok(keyB);
  let drafts: Record<string, string> = {};
  drafts = updateComposerDraftMap(drafts, keyA, "unfinished A");
  drafts = updateComposerDraftMap(drafts, keyB, "unfinished B");

  assert.equal(drafts[keyA], "unfinished A");
  assert.equal(drafts[keyB], "unfinished B");
  assert.equal(resumedKeyA, keyA);
  assert.equal(drafts[resumedKeyA!], "unfinished A");
});

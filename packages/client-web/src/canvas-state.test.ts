import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionSummary, StoredSessionRef } from "@rah/runtime-protocol";
import {
  applyCanvasPaneTarget,
  createCanvasLayoutRatios,
  createEmptyCanvasTargets,
  resolveCanvasLiveUniquenessKey,
  resolveCanvasTargetProjection,
  type CanvasPaneTarget,
} from "./canvas-state";
import { createEmptySessionProjection } from "./session-store-session-lifecycle";

function summary(args: {
  id: string;
  provider?: "codex" | "opencode";
  providerSessionId?: string;
  readOnlyReplay?: boolean;
}): SessionSummary {
  const providerSessionId = args.providerSessionId ?? `${args.id}-provider`;
  const readOnlyReplay = args.readOnlyReplay === true;
  return {
    session: {
      id: args.id,
      provider: args.provider ?? "codex",
      providerSessionId,
      launchSource: "web",
      cwd: "/tmp/rah",
      rootDir: "/tmp/rah",
      runtimeState: "idle",
      capabilities: {
        liveAttach: true,
        structuredTimeline: true,
        nativeTui: !readOnlyReplay,
        rawPtyInput: !readOnlyReplay,
        chatMirror: true,
        structuredControl: false,
        livePermissions: !readOnlyReplay,
        contextUsage: false,
        resumeByProvider: true,
        listProviderSessions: true,
        renameSession: false,
        actions: { info: true, archive: true, delete: false, rename: "none" },
        steerInput: !readOnlyReplay,
        queuedInput: true,
        modelSwitch: false,
        planMode: false,
        subagents: false,
      },
      createdAt: "2026-05-07T00:00:00.000Z",
      updatedAt: "2026-05-07T00:00:00.000Z",
    },
    attachedClients: [],
    controlLease: { sessionId: args.id },
  };
}

function ref(provider: "codex" | "opencode", providerSessionId: string): StoredSessionRef {
  return {
    provider,
    providerSessionId,
    cwd: "/tmp/rah",
    rootDir: "/tmp/rah",
    createdAt: "2026-05-07T00:00:00.000Z",
  };
}

function projections(...summaries: SessionSummary[]) {
  return new Map(
    summaries.map((sessionSummary) => [
      sessionSummary.session.id,
      createEmptySessionProjection(sessionSummary),
    ] as const),
  );
}

test("canvas layout ratios match visible pane count", () => {
  assert.deepEqual(createCanvasLayoutRatios("two-horizontal"), [1, 1]);
  assert.deepEqual(createCanvasLayoutRatios("two-vertical"), [1, 1]);
  assert.deepEqual(createCanvasLayoutRatios("three-horizontal"), [1, 1, 1]);
  assert.deepEqual(createCanvasLayoutRatios("four-grid"), [1, 1, 1, 1]);
});

test("canvas panes keep a live session unique across panes", () => {
  const live = summary({ id: "live-1", providerSessionId: "provider-1" });
  const current = createEmptyCanvasTargets();
  current["canvas-1"] = { kind: "session", sessionId: "live-1" };

  const next = applyCanvasPaneTarget(
    current,
    "canvas-2",
    { kind: "session", sessionId: "live-1" },
    projections(live),
  );

  assert.deepEqual(next["canvas-1"], { kind: "empty" });
  assert.deepEqual(next["canvas-2"], { kind: "session", sessionId: "live-1" });
  assert.deepEqual(current["canvas-1"], { kind: "session", sessionId: "live-1" });
});

test("canvas stored live target also evicts an existing live pane", () => {
  const live = summary({ id: "live-1", provider: "opencode", providerSessionId: "provider-1" });
  const storedTarget: CanvasPaneTarget = {
    kind: "stored",
    ref: ref("opencode", "provider-1"),
  };
  const current = createEmptyCanvasTargets();
  current["canvas-1"] = { kind: "session", sessionId: "live-1" };

  const next = applyCanvasPaneTarget(
    current,
    "canvas-2",
    storedTarget,
    projections(live),
  );

  assert.deepEqual(next["canvas-1"], { kind: "empty" });
  assert.deepEqual(next["canvas-2"], storedTarget);
});

test("canvas read-only history replay can appear in multiple panes", () => {
  const replay = summary({
    id: "history-1",
    providerSessionId: "provider-1",
    readOnlyReplay: true,
  });
  const current = createEmptyCanvasTargets();
  current["canvas-1"] = { kind: "session", sessionId: "history-1" };

  const next = applyCanvasPaneTarget(
    current,
    "canvas-2",
    { kind: "session", sessionId: "history-1" },
    projections(replay),
  );

  assert.deepEqual(next["canvas-1"], { kind: "session", sessionId: "history-1" });
  assert.deepEqual(next["canvas-2"], { kind: "session", sessionId: "history-1" });
  assert.equal(
    resolveCanvasLiveUniquenessKey({ kind: "session", sessionId: "history-1" }, projections(replay)),
    null,
  );
});

test("canvas stored refs resolve to existing projections by provider identity", () => {
  const live = summary({ id: "live-1", provider: "opencode", providerSessionId: "provider-1" });
  const resolved = resolveCanvasTargetProjection(
    { kind: "stored", ref: ref("opencode", "provider-1") },
    projections(live),
  );

  assert.equal(resolved?.summary.session.id, "live-1");
});

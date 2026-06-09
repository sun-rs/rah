import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionSummary, StoredSessionRef } from "@rah/runtime-protocol";
import {
  applyCanvasPaneTarget,
  clearCanvasTargetsForStoredSession,
  createCanvasLayoutRatios,
  createDefaultCanvasRightPanelsOpen,
  createEmptyCanvasTargets,
  getCanvasVisiblePaneIds,
  hasAnyCanvasPaneTarget,
  isCanvasStoredTargetClaimPending,
  normalizeRememberedCanvasState,
  readRememberedCanvasState,
  rememberCanvasState,
  replaceCanvasSessionTargetWithStoredRef,
  resolveCanvasClaimedSessionId,
  resolveCanvasRunningUniquenessKey,
  resolveCanvasTargetProjection,
  shouldInitializeCanvasPaneFromSelection,
  type CanvasPaneTarget,
} from "./canvas-state";
import { createEmptySessionProjection } from "./session-store-session-lifecycle";

function summary(args: {
  id: string;
  provider?: SessionSummary["session"]["provider"];
  providerSessionId?: string;
  readOnlyReplay?: boolean;
  structuredLiveEvents?: boolean;
}): SessionSummary {
  const providerSessionId = args.providerSessionId ?? `${args.id}-provider`;
  const readOnlyReplay = args.readOnlyReplay === true;
  const structuredLiveEvents = args.structuredLiveEvents ?? true;
  return {
    session: {
      id: args.id,
      provider: args.provider ?? "codex",
      providerSessionId,
      launchSource: "web",
      liveBackend: "native_local_server",
      cwd: "/tmp/rah",
      rootDir: "/tmp/rah",
      runtimeState: "idle",
      runtime: {
        structuredLiveEvents,
        features: {
          structuredLiveEvents: structuredLiveEvents ? "available" : "unsupported",
        },
      },
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
        actions: { info: true, stop: true, delete: false, rename: "none" },
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

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key: string) => values.get(key) ?? null,
    key: (index: number) => [...values.keys()][index] ?? null,
    removeItem: (key: string) => values.delete(key),
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
}

test("canvas layout ratios match visible pane count", () => {
  assert.deepEqual(createCanvasLayoutRatios("two-horizontal"), [1, 1]);
  assert.deepEqual(createCanvasLayoutRatios("two-vertical"), [1, 1]);
  assert.deepEqual(createCanvasLayoutRatios("three-horizontal"), [1, 1, 1]);
  assert.deepEqual(createCanvasLayoutRatios("four-grid"), [1, 1, 1, 1]);
});

test("canvas layouts reveal fixed ordered pane slots without clearing hidden targets", () => {
  assert.deepEqual(getCanvasVisiblePaneIds("two-horizontal"), ["canvas-1", "canvas-2"]);
  assert.deepEqual(getCanvasVisiblePaneIds("two-vertical"), ["canvas-1", "canvas-2"]);
  assert.deepEqual(getCanvasVisiblePaneIds("three-horizontal"), [
    "canvas-1",
    "canvas-2",
    "canvas-3",
  ]);
  assert.deepEqual(getCanvasVisiblePaneIds("four-grid"), [
    "canvas-1",
    "canvas-2",
    "canvas-3",
    "canvas-4",
  ]);
  assert.deepEqual(getCanvasVisiblePaneIds("two-horizontal", "canvas-4"), ["canvas-4"]);
});

test("canvas clear all availability is based on all fixed pane slots", () => {
  const targets = createEmptyCanvasTargets();
  assert.equal(hasAnyCanvasPaneTarget(targets), false);

  targets["canvas-3"] = { kind: "stored", ref: ref("codex", "hidden-history") };
  assert.equal(hasAnyCanvasPaneTarget(targets), true);
});

test("canvas entry only initializes empty panes from the global selection", () => {
  assert.equal(shouldInitializeCanvasPaneFromSelection({ kind: "empty" }), true);
  assert.equal(
    shouldInitializeCanvasPaneFromSelection({ kind: "session", sessionId: "live-1" }),
    false,
  );
  assert.equal(
    shouldInitializeCanvasPaneFromSelection({ kind: "stored", ref: ref("codex", "history-1") }),
    false,
  );
  assert.equal(
    shouldInitializeCanvasPaneFromSelection({ kind: "council", councilId: "council-1" }),
    false,
  );
  assert.equal(shouldInitializeCanvasPaneFromSelection({ kind: "new" }), false);
});

test("canvas state persistence stores only pane targets and layout chrome", () => {
  const storage = memoryStorage();
  const state = normalizeRememberedCanvasState({
    layout: "three-horizontal",
    activePaneId: "canvas-3",
    ratios: [1, 2, 1],
    targets: {
      "canvas-1": { kind: "session", sessionId: "live-1" },
      "canvas-2": { kind: "stored", ref: ref("codex", "history-1") },
      "canvas-3": { kind: "council", councilId: "council-1" },
      "canvas-4": { kind: "new" },
    },
    rightPanelsOpen: {
      "canvas-1": false,
      "canvas-2": true,
      "canvas-3": false,
      "canvas-4": true,
    },
  });

  rememberCanvasState(storage, state);

  assert.deepEqual(readRememberedCanvasState(storage), state);
});

test("canvas state persistence sanitizes invalid saved values", () => {
  assert.deepEqual(
    normalizeRememberedCanvasState({
      layout: "unknown",
      activePaneId: "canvas-4",
      ratios: [1],
      targets: {
        "canvas-1": { kind: "session" },
        "canvas-2": { kind: "session", sessionId: "live-2" },
      },
      rightPanelsOpen: { "canvas-1": false, "canvas-3": true },
    }),
    {
      layout: "two-horizontal",
      activePaneId: "canvas-1",
      ratios: [1, 1],
      targets: {
        ...createEmptyCanvasTargets(),
        "canvas-2": { kind: "session", sessionId: "live-2" },
      },
      rightPanelsOpen: {
        ...createDefaultCanvasRightPanelsOpen(),
        "canvas-1": false,
      },
    },
  );
});

test("canvas panes keep a running session unique across panes", () => {
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

test("canvas stored running target also evicts an existing running pane", () => {
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
    resolveCanvasRunningUniquenessKey({ kind: "session", sessionId: "history-1" }, projections(replay)),
    null,
  );
});

test("canvas keeps a council unique across panes", () => {
  const current = createEmptyCanvasTargets();
  current["canvas-1"] = { kind: "council", councilId: "council-1" };

  const next = applyCanvasPaneTarget(
    current,
    "canvas-2",
    { kind: "council", councilId: "council-1" },
    projections(),
  );

  assert.deepEqual(next["canvas-1"], { kind: "empty" });
  assert.deepEqual(next["canvas-2"], { kind: "council", councilId: "council-1" });
  assert.equal(
    resolveCanvasRunningUniquenessKey({ kind: "council", councilId: "council-1" }, projections()),
    "council:council-1",
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

test("canvas stored refs prefer live projections over read-only history replays", () => {
  const history = summary({
    id: "history-1",
    provider: "codex",
    providerSessionId: "provider-1",
    readOnlyReplay: true,
  });
  const live = summary({ id: "live-1", provider: "codex", providerSessionId: "provider-1" });
  const resolved = resolveCanvasTargetProjection(
    { kind: "stored", ref: ref("codex", "provider-1") },
    projections(history, live),
  );

  assert.equal(resolved?.summary.session.id, "live-1");
});

test("canvas claim resolution prefers a live projection over a read-only history id", () => {
  const history = summary({
    id: "history-1",
    provider: "codex",
    providerSessionId: "provider-1",
    readOnlyReplay: true,
  });
  const live = summary({ id: "live-1", provider: "codex", providerSessionId: "provider-1" });
  const resolved = resolveCanvasClaimedSessionId(
    projections(history, live),
    "history-1",
    ref("codex", "provider-1"),
  );

  assert.equal(resolved, "live-1");
});

test("canvas claim resolution can recover a live projection when the claim return is empty", () => {
  const live = summary({ id: "live-1", provider: "opencode", providerSessionId: "provider-1" });
  const resolved = resolveCanvasClaimedSessionId(
    projections(live),
    null,
    ref("opencode", "provider-1"),
  );

  assert.equal(resolved, "live-1");
});

test("canvas claim resolution prefers provider-matched live projection over unknown claim id", () => {
  const live = summary({ id: "live-1", provider: "codex", providerSessionId: "provider-1" });
  const resolved = resolveCanvasClaimedSessionId(
    projections(live),
    "history-1",
    ref("codex", "provider-1"),
  );

  assert.equal(resolved, "live-1");
});

test("canvas claim resolution does not rebind to an explicit read-only history projection", () => {
  const history = summary({
    id: "history-1",
    provider: "codex",
    providerSessionId: "provider-1",
    readOnlyReplay: true,
  });
  const resolved = resolveCanvasClaimedSessionId(
    projections(history),
    "history-1",
    ref("codex", "provider-1"),
  );

  assert.equal(resolved, null);
});

test("canvas stored target claim detection matches only the claimed provider session", () => {
  const target: CanvasPaneTarget = { kind: "stored", ref: ref("codex", "provider-1") };

  assert.equal(
    isCanvasStoredTargetClaimPending(target, [
      { kind: "claim_history", provider: "codex", providerSessionId: "provider-1" },
    ]),
    true,
  );
  assert.equal(
    isCanvasStoredTargetClaimPending(target, [
      { kind: "history", provider: "codex", providerSessionId: "provider-1" },
      { kind: "claim_history", provider: "opencode", providerSessionId: "provider-1" },
      { kind: "claim_history", provider: "codex", providerSessionId: "provider-2" },
    ]),
    false,
  );
  assert.equal(
    isCanvasStoredTargetClaimPending({ kind: "session", sessionId: "history-1" }, [
      { kind: "claim_history", provider: "codex", providerSessionId: "provider-1" },
    ]),
    false,
  );
});

test("stopping a canvas session converts its pane target to stored history", () => {
  const current = createEmptyCanvasTargets();
  current["canvas-1"] = { kind: "session", sessionId: "live-1" };
  current["canvas-2"] = { kind: "session", sessionId: "live-2" };
  const stoppedRef = ref("codex", "provider-1");

  const next = replaceCanvasSessionTargetWithStoredRef(current, "live-1", stoppedRef);

  assert.deepEqual(next["canvas-1"], { kind: "stored", ref: stoppedRef });
  assert.deepEqual(next["canvas-2"], { kind: "session", sessionId: "live-2" });
});

test("deleting a stored session clears matching canvas targets", () => {
  const current = createEmptyCanvasTargets();
  current["canvas-1"] = { kind: "stored", ref: ref("codex", "provider-1") };
  current["canvas-2"] = { kind: "session", sessionId: "live-1" };
  current["canvas-3"] = { kind: "stored", ref: ref("opencode", "provider-2") };

  const next = clearCanvasTargetsForStoredSession(
    current,
    { provider: "codex", providerSessionId: "provider-1" },
    { sessionId: "live-1" },
  );

  assert.deepEqual(next["canvas-1"], { kind: "empty" });
  assert.deepEqual(next["canvas-2"], { kind: "empty" });
  assert.deepEqual(next["canvas-3"], { kind: "stored", ref: ref("opencode", "provider-2") });
});

import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionSummary, StoredSessionRef } from "@rah/runtime-protocol";
import {
  applyCanvasPaneTarget,
  canvasPaneLabel,
  canvasRestorableTargetKey,
  canvasOpeningTransitionForTarget,
  canvasStoredRefKey,
  clearCanvasCouncilTargets,
  clearCanvasSessionTargets,
  clearCanvasTargetsForStoredSession,
  createCanvasSessionTarget,
  createDefaultCanvasRightPanelsOpen,
  createEmptyCanvasTargets,
  enrichCanvasSessionTargets,
  getCanvasVisiblePaneIds,
  hasAnyCanvasPaneTarget,
  LEGACY_CANVAS_STATE_STORAGE_KEY,
  MOBILE_CANVAS_LAYOUT,
  normalizeRememberedCanvasState,
  readRememberedCanvasState,
  rememberCanvasState,
  resolveCanvasPaneRemovalSelection,
  resolveCanvasLayoutSelection,
  resolveCanvasResumedSessionId,
  resolveCanvasRunningUniquenessKey,
  resolveCanvasTargetProjection,
  resolveCanvasVisibleSessionId,
  shouldUseMobileCanvasLayout,
  type CanvasPaneTarget,
} from "./canvas-state";
import {
  canvasLayoutPaneIds,
  createCanvasGridLayout,
  createCanvasPresetLayout,
  deriveCanvasSplitJunctions,
  getCanvasGridDimensions,
  removeCanvasLayoutPane,
  splitCanvasLayoutPane,
  updateCanvasSplitRatio,
} from "./canvas-layout";
import { createEmptySessionProjection } from "./session-store-session-lifecycle";

function summary(args: {
  id: string;
  provider?: "codex" | "opencode";
  providerSessionId?: string;
  readOnlyReplay?: boolean;
  status?: "running" | "stopped";
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
      status: args.status ?? "running",
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

test("canvas grid layouts reveal fixed ordered pane slots", () => {
  assert.deepEqual(canvasLayoutPaneIds(createCanvasGridLayout(2, 1)), [
    "canvas-1",
    "canvas-2",
  ]);
  assert.deepEqual(canvasLayoutPaneIds(createCanvasGridLayout(2, 3)), [
    "canvas-1",
    "canvas-2",
    "canvas-3",
    "canvas-4",
    "canvas-5",
    "canvas-6",
  ]);
  assert.deepEqual(canvasLayoutPaneIds(createCanvasGridLayout(4, 2)), [
    "canvas-1",
    "canvas-2",
    "canvas-3",
    "canvas-4",
    "canvas-5",
    "canvas-6",
    "canvas-7",
    "canvas-8",
  ]);
});

test("canvas divider markers describe bars, T junctions, and grid crosses", () => {
  assert.equal(deriveCanvasSplitJunctions(createCanvasGridLayout(2, 1)).size, 0);
  assert.equal(deriveCanvasSplitJunctions(createCanvasGridLayout(1, 2)).size, 0);

  const topTwoBottomOne = splitCanvasLayoutPane(
    createCanvasGridLayout(1, 2),
    "canvas-1",
    "horizontal",
  );
  assert.ok(topTwoBottomOne);
  const tJunctions = [...deriveCanvasSplitJunctions(topTwoBottomOne.layout).values()].flat();
  assert.deepEqual(tJunctions, [{
    position: 0.5,
    directions: { left: true, right: true, up: true, down: false },
  }]);

  const fourGridJunctions = [...deriveCanvasSplitJunctions(createCanvasGridLayout(2, 2)).values()].flat();
  assert.deepEqual(fourGridJunctions, [{
    position: 0.5,
    directions: { left: true, right: true, up: true, down: true },
  }]);

  const eightGridJunctions = [...deriveCanvasSplitJunctions(createCanvasGridLayout(4, 2)).values()].flat();
  assert.equal(eightGridJunctions.length, 3);
  assert.deepEqual(
    eightGridJunctions.map((junction) => junction.directions),
    Array.from({ length: 3 }, () => ({ left: true, right: true, up: true, down: true })),
  );
});

test("canvas layouts reveal fixed ordered pane slots without clearing hidden targets", () => {
  assert.deepEqual(getCanvasVisiblePaneIds(createCanvasPresetLayout("two-horizontal")), [
    "canvas-1",
    "canvas-2",
  ]);
  assert.deepEqual(getCanvasVisiblePaneIds(createCanvasPresetLayout("two-vertical")), [
    "canvas-1",
    "canvas-2",
  ]);
  assert.deepEqual(getCanvasVisiblePaneIds(createCanvasPresetLayout("three-horizontal")), [
    "canvas-1",
    "canvas-2",
    "canvas-3",
  ]);
  assert.deepEqual(getCanvasVisiblePaneIds(createCanvasPresetLayout("four-grid")), [
    "canvas-1",
    "canvas-2",
    "canvas-3",
    "canvas-4",
  ]);
  assert.deepEqual(
    getCanvasVisiblePaneIds(createCanvasPresetLayout("two-horizontal"), "canvas-4"),
    ["canvas-4"],
  );
  assert.equal(canvasPaneLabel("canvas-1"), "Pane 1");
  assert.equal(canvasPaneLabel("canvas-8"), "Pane 8");
});

test("mobile canvas policy uses only stacked two-pane layout", () => {
  assert.equal(shouldUseMobileCanvasLayout(699), true);
  assert.equal(shouldUseMobileCanvasLayout(700), false);
  assert.deepEqual(getCanvasVisiblePaneIds(MOBILE_CANVAS_LAYOUT), ["canvas-1", "canvas-2"]);
  assert.deepEqual(getCanvasGridDimensions(MOBILE_CANVAS_LAYOUT), { columns: 1, rows: 2 });
});

test("canvas pane expansion supports equal columns and local asymmetric splits", () => {
  const equalColumns = splitCanvasLayoutPane(
    createCanvasGridLayout(2, 1),
    "canvas-2",
    "horizontal",
  );
  assert.ok(equalColumns);
  assert.deepEqual(getCanvasGridDimensions(equalColumns.layout), { columns: 3, rows: 1 });
  assert.equal(equalColumns.newPaneId, "canvas-3");

  const asymmetric = splitCanvasLayoutPane(
    createCanvasGridLayout(2, 1),
    "canvas-1",
    "vertical",
  );
  assert.ok(asymmetric);
  assert.deepEqual(canvasLayoutPaneIds(asymmetric.layout), ["canvas-1", "canvas-3", "canvas-2"]);
  assert.equal(getCanvasGridDimensions(asymmetric.layout), null);
});

test("canvas pane removal collapses any selected leaf and keeps a one-pane minimum", () => {
  const threeColumns = createCanvasGridLayout(3, 1);
  const removed = removeCanvasLayoutPane(threeColumns, "canvas-3");
  assert.ok(removed);
  assert.deepEqual(canvasLayoutPaneIds(removed), ["canvas-1", "canvas-2"]);

  const removedMiddle = removeCanvasLayoutPane(threeColumns, "canvas-2");
  assert.ok(removedMiddle);
  assert.deepEqual(canvasLayoutPaneIds(removedMiddle), ["canvas-1", "canvas-3"]);

  const asymmetric = splitCanvasLayoutPane(
    createCanvasGridLayout(2, 1),
    "canvas-1",
    "vertical",
  );
  assert.ok(asymmetric);
  const collapsed = removeCanvasLayoutPane(asymmetric.layout, "canvas-3");
  assert.ok(collapsed);
  assert.deepEqual(canvasLayoutPaneIds(collapsed), ["canvas-1", "canvas-2"]);

  const singlePane = removeCanvasLayoutPane(createCanvasGridLayout(2, 1), "canvas-1");
  assert.deepEqual(singlePane, { kind: "pane", paneId: "canvas-2" });
  assert.equal(removeCanvasLayoutPane(singlePane!, "canvas-2"), null);
  assert.equal(removeCanvasLayoutPane(threeColumns, "canvas-8"), null);
});

test("canvas pane removal keeps a deterministic active pane and maximizes the last pane", () => {
  assert.deepEqual(
    resolveCanvasPaneRemovalSelection(["canvas-2"], 0, "canvas-1"),
    {
      activePaneId: "canvas-2",
      maximizedPaneId: "canvas-2",
    },
  );
  assert.deepEqual(
    resolveCanvasPaneRemovalSelection(["canvas-1", "canvas-3"], 1, "canvas-1"),
    {
      activePaneId: "canvas-1",
      maximizedPaneId: null,
    },
  );
  assert.deepEqual(
    resolveCanvasPaneRemovalSelection(["canvas-1", "canvas-3"], 1, "canvas-2"),
    {
      activePaneId: "canvas-3",
      maximizedPaneId: null,
    },
  );
});

test("explicit canvas layouts override the previous maximize state", () => {
  assert.deepEqual(
    resolveCanvasLayoutSelection({ kind: "pane", paneId: "canvas-2" }, "canvas-1"),
    {
      activePaneId: "canvas-2",
      maximizedPaneId: "canvas-2",
    },
  );
  assert.deepEqual(
    resolveCanvasLayoutSelection(createCanvasGridLayout(2, 1), "canvas-1"),
    {
      activePaneId: "canvas-1",
      maximizedPaneId: null,
    },
  );
});

test("canvas split ratios update only the selected split", () => {
  const layout = createCanvasGridLayout(2, 1);
  assert.equal(layout.kind, "split");
  if (layout.kind !== "split") return;
  const updated = updateCanvasSplitRatio(layout, layout.id, 0.7);
  assert.equal(updated.kind, "split");
  if (updated.kind !== "split") return;
  assert.equal(updated.ratio, 0.7);
});

test("canvas clear all availability is based on all fixed pane slots", () => {
  const targets = createEmptyCanvasTargets();
  assert.equal(hasAnyCanvasPaneTarget(targets), false);

  targets["canvas-8"] = { kind: "stored", ref: ref("codex", "hidden-history") };
  assert.equal(hasAnyCanvasPaneTarget(targets), true);
});

test("canvas resuming stored targets suppresses automatic history activation", () => {
  const storedRef = ref("codex", "resuming-provider-session");
  const transition = canvasOpeningTransitionForTarget(
    { kind: "stored", ref: storedRef },
    null,
    null,
    new Set([canvasStoredRefKey(storedRef)]),
  );

  assert.equal(transition?.kind, "resume_history");
  assert.equal(transition?.providerSessionId, "resuming-provider-session");
});

test("canvas local resume state survives unrelated global resume transitions", () => {
  const storedRef = ref("codex", "pane-provider-session");
  const transition = canvasOpeningTransitionForTarget(
    { kind: "stored", ref: storedRef },
    { kind: "resume_history", sessionId: "other-history" },
    {
      kind: "resume_history",
      provider: "codex",
      providerSessionId: "other-provider-session",
    },
    new Set([canvasStoredRefKey(storedRef)]),
  );

  assert.equal(transition?.kind, "resume_history");
  assert.equal(transition?.providerSessionId, "pane-provider-session");
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

test("canvas session targets retain a stable provider identity across daemon restarts", () => {
  const original = summary({ id: "runtime-before-restart", providerSessionId: "thread-stable" });
  const target = createCanvasSessionTarget(
    "runtime-before-restart",
    projections(original),
  );
  assert.equal(target.kind, "session");
  if (target.kind !== "session") return;
  assert.equal(target.ref?.providerSessionId, "thread-stable");

  const replacement = summary({ id: "runtime-after-restart", providerSessionId: "thread-stable" });
  assert.equal(
    resolveCanvasTargetProjection(target, projections(replacement))?.summary.session.id,
    "runtime-after-restart",
  );
});

test("canvas enriches runtime-only bindings as soon as their projection arrives", () => {
  const targets = createEmptyCanvasTargets();
  targets["canvas-1"] = { kind: "session", sessionId: "runtime-1" };
  const next = enrichCanvasSessionTargets(
    targets,
    projections(summary({ id: "runtime-1", providerSessionId: "thread-1" })),
  );

  assert.equal(next["canvas-1"].kind, "session");
  assert.equal(
    next["canvas-1"].kind === "session"
      ? next["canvas-1"].ref?.providerSessionId
      : undefined,
    "thread-1",
  );
});

test("canvas state preserves a single remaining pane and activates that pane", () => {
  const state = normalizeRememberedCanvasState({
    layout: { kind: "pane", paneId: "canvas-4" },
    activePaneId: "canvas-1",
    targets: {
      "canvas-4": { kind: "stored", ref: ref("codex", "history-4") },
    },
  });

  assert.deepEqual(state.layout, { kind: "pane", paneId: "canvas-4" });
  assert.equal(state.activePaneId, "canvas-4");
  assert.deepEqual(state.targets["canvas-4"], {
    kind: "stored",
    ref: ref("codex", "history-4"),
  });
});

test("canvas state reads and migrates the legacy v1 storage key", () => {
  const storage = memoryStorage();
  storage.setItem(
    LEGACY_CANVAS_STATE_STORAGE_KEY,
    JSON.stringify({
      layout: "four-grid",
      ratios: [2, 1, 3, 1],
      activePaneId: "canvas-4",
      targets: { "canvas-4": { kind: "new" } },
    }),
  );

  const state = readRememberedCanvasState(storage);
  assert.ok(state);
  assert.deepEqual(canvasLayoutPaneIds(state.layout), [
    "canvas-1",
    "canvas-2",
    "canvas-3",
    "canvas-4",
  ]);
  assert.deepEqual(state.targets["canvas-4"], { kind: "new" });
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
      layout: createCanvasGridLayout(2, 1),
      activePaneId: "canvas-1",
      targets: {
        ...createEmptyCanvasTargets(),
        "canvas-2": { kind: "session", sessionId: "live-2" },
      },
      rightPanelsOpen: {
        ...createDefaultCanvasRightPanelsOpen(),
        "canvas-1": false,
        "canvas-3": true,
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

test("canvas stored refs expose the resolved session as a visible session", () => {
  const history = summary({
    id: "history-1",
    provider: "codex",
    providerSessionId: "provider-1",
    readOnlyReplay: true,
  });
  const live = summary({ id: "live-1", provider: "codex", providerSessionId: "provider-1" });

  assert.equal(
    resolveCanvasVisibleSessionId(
      { kind: "stored", ref: ref("codex", "provider-1") },
      projections(history, live),
    ),
    "live-1",
  );
  assert.equal(
    resolveCanvasVisibleSessionId(
      { kind: "stored", ref: ref("codex", "missing-provider") },
      projections(history, live),
    ),
    null,
  );
});

test("canvas never exposes an unresolved remembered runtime id as visible", () => {
  assert.equal(
    resolveCanvasVisibleSessionId(
      { kind: "session", sessionId: "deleted-runtime" },
      projections(),
    ),
    null,
  );
});

test("canvas resume resolution prefers a live projection over a read-only history id", () => {
  const history = summary({
    id: "history-1",
    provider: "codex",
    providerSessionId: "provider-1",
    readOnlyReplay: true,
  });
  const live = summary({ id: "live-1", provider: "codex", providerSessionId: "provider-1" });
  const resolved = resolveCanvasResumedSessionId(
    projections(history, live),
    "history-1",
    ref("codex", "provider-1"),
  );

  assert.equal(resolved, "live-1");
});

test("canvas resume resolution can recover a live projection when the resume result is empty", () => {
  const live = summary({ id: "live-1", provider: "opencode", providerSessionId: "provider-1" });
  const resolved = resolveCanvasResumedSessionId(
    projections(live),
    null,
    ref("opencode", "provider-1"),
  );

  assert.equal(resolved, "live-1");
});

test("canvas resume resolution prefers provider-matched live projection over unknown resume id", () => {
  const live = summary({ id: "live-1", provider: "codex", providerSessionId: "provider-1" });
  const resolved = resolveCanvasResumedSessionId(
    projections(live),
    "history-1",
    ref("codex", "provider-1"),
  );

  assert.equal(resolved, "live-1");
});

test("canvas resume resolution does not rebind to an explicit read-only history projection", () => {
  const history = summary({
    id: "history-1",
    provider: "codex",
    providerSessionId: "provider-1",
    readOnlyReplay: true,
  });
  const resolved = resolveCanvasResumedSessionId(
    projections(history),
    "history-1",
    ref("codex", "provider-1"),
  );

  assert.equal(resolved, null);
});

test("stopping a canvas session clears its pane target", () => {
  const current = createEmptyCanvasTargets();
  current["canvas-1"] = { kind: "session", sessionId: "live-1" };
  current["canvas-2"] = { kind: "session", sessionId: "live-2" };

  const next = clearCanvasSessionTargets(current, "live-1");

  assert.deepEqual(next["canvas-1"], { kind: "empty" });
  assert.deepEqual(next["canvas-2"], { kind: "session", sessionId: "live-2" });
});

test("canvas restore failures share one identity across stored and enriched session targets", () => {
  const storedRef = ref("codex", "provider-1");

  assert.equal(
    canvasRestorableTargetKey({ kind: "stored", ref: storedRef }),
    "codex:provider-1",
  );
  assert.equal(
    canvasRestorableTargetKey({ kind: "session", sessionId: "live-1", ref: storedRef }),
    "codex:provider-1",
  );
  assert.equal(
    canvasRestorableTargetKey({ kind: "session", sessionId: "live-1" }),
    null,
  );
});

test("stopping a canvas council clears its pane target", () => {
  const current = createEmptyCanvasTargets();
  current["canvas-1"] = { kind: "council", councilId: "council-1" };
  current["canvas-2"] = { kind: "council", councilId: "council-2" };

  const next = clearCanvasCouncilTargets(current, "council-1");

  assert.deepEqual(next["canvas-1"], { kind: "empty" });
  assert.deepEqual(next["canvas-2"], { kind: "council", councilId: "council-2" });
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

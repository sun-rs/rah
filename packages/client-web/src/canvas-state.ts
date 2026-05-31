import type { StoredSessionRef } from "@rah/runtime-protocol";
import { isReadOnlyReplay } from "./session-capabilities";
import type { CanvasLayout } from "./components/workbench/canvas/CanvasWorkbench";
import type { SessionProjection } from "./types";

export type CanvasPaneId = "canvas-1" | "canvas-2" | "canvas-3" | "canvas-4";

export type CanvasPaneTarget =
  | { kind: "empty" }
  | { kind: "new" }
  | { kind: "council"; councilId: string }
  | { kind: "session"; sessionId: string }
  | { kind: "stored"; ref: StoredSessionRef };

export const CANVAS_PANE_IDS: CanvasPaneId[] = [
  "canvas-1",
  "canvas-2",
  "canvas-3",
  "canvas-4",
];

export const CANVAS_LAYOUT_PANE_COUNT: Record<CanvasLayout, number> = {
  "two-horizontal": 2,
  "two-vertical": 2,
  "three-horizontal": 3,
  "four-grid": 4,
};

export const CANVAS_STATE_STORAGE_KEY = "rah-canvas-state-v1";

export type RememberedCanvasState = {
  layout: CanvasLayout;
  ratios: number[];
  activePaneId: CanvasPaneId;
  targets: Record<CanvasPaneId, CanvasPaneTarget>;
  rightPanelsOpen: Record<CanvasPaneId, boolean>;
};

export function createEmptyCanvasTargets(): Record<CanvasPaneId, CanvasPaneTarget> {
  return {
    "canvas-1": { kind: "empty" },
    "canvas-2": { kind: "empty" },
    "canvas-3": { kind: "empty" },
    "canvas-4": { kind: "empty" },
  };
}

export function createDefaultCanvasRightPanelsOpen(): Record<CanvasPaneId, boolean> {
  return {
    "canvas-1": true,
    "canvas-2": true,
    "canvas-3": true,
    "canvas-4": true,
  };
}

export function createCanvasLayoutRatios(layout: CanvasLayout): number[] {
  return Array.from({ length: CANVAS_LAYOUT_PANE_COUNT[layout] }, () => 1);
}

function isCanvasLayout(value: unknown): value is CanvasLayout {
  return (
    value === "two-horizontal" ||
    value === "two-vertical" ||
    value === "three-horizontal" ||
    value === "four-grid"
  );
}

function isCanvasPaneId(value: unknown): value is CanvasPaneId {
  return typeof value === "string" && CANVAS_PANE_IDS.includes(value as CanvasPaneId);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStoredSessionRef(value: unknown): value is StoredSessionRef {
  return (
    isRecord(value) &&
    typeof value.provider === "string" &&
    typeof value.providerSessionId === "string"
  );
}

function normalizeCanvasPaneTarget(value: unknown): CanvasPaneTarget {
  if (!isRecord(value) || typeof value.kind !== "string") {
    return { kind: "empty" };
  }
  if (value.kind === "empty" || value.kind === "new") {
    return { kind: value.kind };
  }
  if (value.kind === "session" && typeof value.sessionId === "string") {
    return { kind: "session", sessionId: value.sessionId };
  }
  if (value.kind === "council" && typeof value.councilId === "string") {
    return { kind: "council", councilId: value.councilId };
  }
  if (value.kind === "stored" && isStoredSessionRef(value.ref)) {
    return { kind: "stored", ref: value.ref };
  }
  return { kind: "empty" };
}

function normalizeCanvasTargets(value: unknown): Record<CanvasPaneId, CanvasPaneTarget> {
  const targets = createEmptyCanvasTargets();
  if (!isRecord(value)) {
    return targets;
  }
  for (const paneId of CANVAS_PANE_IDS) {
    targets[paneId] = normalizeCanvasPaneTarget(value[paneId]);
  }
  return targets;
}

function normalizeCanvasRatios(value: unknown, layout: CanvasLayout): number[] {
  const expectedLength = CANVAS_LAYOUT_PANE_COUNT[layout];
  if (!Array.isArray(value) || value.length !== expectedLength) {
    return createCanvasLayoutRatios(layout);
  }
  const ratios = value.map((item) =>
    typeof item === "number" && Number.isFinite(item) && item > 0 ? item : 1,
  );
  const total = ratios.reduce((sum, item) => sum + item, 0);
  return total > 0 ? ratios : createCanvasLayoutRatios(layout);
}

function normalizeCanvasRightPanelsOpen(value: unknown): Record<CanvasPaneId, boolean> {
  const result = createDefaultCanvasRightPanelsOpen();
  if (!isRecord(value)) {
    return result;
  }
  for (const paneId of CANVAS_PANE_IDS) {
    if (typeof value[paneId] === "boolean") {
      result[paneId] = value[paneId];
    }
  }
  return result;
}

export function normalizeRememberedCanvasState(value: unknown): RememberedCanvasState {
  const record = isRecord(value) ? value : {};
  const layout = isCanvasLayout(record.layout) ? record.layout : "two-horizontal";
  const activePaneId = isCanvasPaneId(record.activePaneId) ? record.activePaneId : "canvas-1";
  const visiblePaneIds = CANVAS_PANE_IDS.slice(0, CANVAS_LAYOUT_PANE_COUNT[layout]);
  return {
    layout,
    activePaneId: visiblePaneIds.includes(activePaneId) ? activePaneId : "canvas-1",
    ratios: normalizeCanvasRatios(record.ratios, layout),
    targets: normalizeCanvasTargets(record.targets),
    rightPanelsOpen: normalizeCanvasRightPanelsOpen(record.rightPanelsOpen),
  };
}

export function readRememberedCanvasState(storage: Storage | undefined): RememberedCanvasState | null {
  if (!storage) {
    return null;
  }
  try {
    const raw = storage.getItem(CANVAS_STATE_STORAGE_KEY);
    return raw ? normalizeRememberedCanvasState(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

export function rememberCanvasState(
  storage: Storage | undefined,
  state: RememberedCanvasState,
): void {
  if (!storage) {
    return;
  }
  try {
    storage.setItem(CANVAS_STATE_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Persistence is best-effort; canvas itself remains fully usable without it.
  }
}

export function shouldInitializeCanvasPaneFromSelection(target: CanvasPaneTarget): boolean {
  return target.kind === "empty";
}

export function resolveCanvasTargetProjection(
  target: CanvasPaneTarget,
  projections: Map<string, SessionProjection>,
): SessionProjection | null {
  if (target.kind === "session") {
    return projections.get(target.sessionId) ?? null;
  }
  if (target.kind === "stored") {
    for (const projection of projections.values()) {
      if (
        projection.summary.session.provider === target.ref.provider &&
        projection.summary.session.providerSessionId === target.ref.providerSessionId
      ) {
        return projection;
      }
    }
  }
  return null;
}

export function resolveCanvasRunningUniquenessKey(
  target: CanvasPaneTarget,
  projections: Map<string, SessionProjection>,
): string | null {
  if (target.kind === "session") {
    const projection = projections.get(target.sessionId);
    return projection && isReadOnlyReplay(projection.summary) ? null : target.sessionId;
  }
  if (target.kind !== "stored") {
    return target.kind === "council" ? `council:${target.councilId}` : null;
  }
  const projection = resolveCanvasTargetProjection(target, projections);
  if (!projection || isReadOnlyReplay(projection.summary)) {
    return null;
  }
  return projection.summary.session.id;
}

export function applyCanvasPaneTarget(
  current: Record<CanvasPaneId, CanvasPaneTarget>,
  paneId: CanvasPaneId,
  target: CanvasPaneTarget,
  projections: Map<string, SessionProjection>,
): Record<CanvasPaneId, CanvasPaneTarget> {
  const next = { ...current, [paneId]: target };
  const targetLiveKey = resolveCanvasRunningUniquenessKey(target, projections);
  if (!targetLiveKey) {
    return next;
  }
  for (const id of CANVAS_PANE_IDS) {
    if (id !== paneId && resolveCanvasRunningUniquenessKey(current[id], projections) === targetLiveKey) {
      next[id] = { kind: "empty" };
    }
  }
  return next;
}

export function canvasTargetMatchesStoredSession(
  target: CanvasPaneTarget,
  session: Pick<StoredSessionRef, "provider" | "providerSessionId">,
): boolean {
  return (
    target.kind === "stored" &&
    target.ref.provider === session.provider &&
    target.ref.providerSessionId === session.providerSessionId
  );
}

export function replaceCanvasSessionTargetWithStoredRef(
  current: Record<CanvasPaneId, CanvasPaneTarget>,
  sessionId: string,
  ref: StoredSessionRef,
): Record<CanvasPaneId, CanvasPaneTarget> {
  let changed = false;
  const next = { ...current };
  for (const paneId of CANVAS_PANE_IDS) {
    const target = current[paneId];
    if (target.kind === "session" && target.sessionId === sessionId) {
      next[paneId] = { kind: "stored", ref };
      changed = true;
    }
  }
  return changed ? next : current;
}

export function clearCanvasTargetsForStoredSession(
  current: Record<CanvasPaneId, CanvasPaneTarget>,
  session: Pick<StoredSessionRef, "provider" | "providerSessionId">,
  options?: { sessionId?: string | null },
): Record<CanvasPaneId, CanvasPaneTarget> {
  let changed = false;
  const next = { ...current };
  for (const paneId of CANVAS_PANE_IDS) {
    const target = current[paneId];
    const matchesSessionId =
      target.kind === "session" &&
      options?.sessionId !== undefined &&
      options.sessionId !== null &&
      target.sessionId === options.sessionId;
    if (matchesSessionId || canvasTargetMatchesStoredSession(target, session)) {
      next[paneId] = { kind: "empty" };
      changed = true;
    }
  }
  return changed ? next : current;
}

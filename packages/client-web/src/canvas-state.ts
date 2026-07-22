import type { StoredSessionRef } from "@rah/runtime-protocol";
import { isReadOnlyReplay } from "./session-capabilities";
import {
  createPendingStoredSessionTransition,
  type PendingSessionTransition,
} from "./session-transition-contract";
import type { SessionProjection } from "./types";
import { COMPACT_MAX_WIDTH_PX } from "./responsive-layout";
import {
  CANVAS_PANE_IDS,
  canvasLayoutPaneIds,
  createCanvasGridLayout,
  migrateLegacyCanvasLayout,
  normalizeCanvasLayout,
  type CanvasLayoutNode,
  type CanvasPaneId,
} from "./canvas-layout";

export { CANVAS_PANE_IDS } from "./canvas-layout";
export type { CanvasLayoutNode, CanvasPaneId } from "./canvas-layout";

export type CanvasPaneTarget =
  | { kind: "empty" }
  | { kind: "new" }
  | { kind: "council"; councilId: string }
  | { kind: "session"; sessionId: string; ref?: StoredSessionRef }
  | { kind: "stored"; ref: StoredSessionRef };

export type CanvasPendingSessionAction = {
  kind: "attach_session" | "claim_control" | "resume_history";
  sessionId: string;
};

export function canvasPaneLabel(paneId: CanvasPaneId): string {
  return `Pane ${CANVAS_PANE_IDS.indexOf(paneId) + 1}`;
}

export const MOBILE_CANVAS_MAX_WIDTH_PX = COMPACT_MAX_WIDTH_PX;
export const MOBILE_CANVAS_LAYOUT: CanvasLayoutNode = createCanvasGridLayout(1, 2);

export const CANVAS_STATE_STORAGE_KEY = "rah-canvas-state-v2";
export const LEGACY_CANVAS_STATE_STORAGE_KEY = "rah-canvas-state-v1";

export function shouldUseMobileCanvasLayout(viewportWidthPx: number): boolean {
  return Number.isFinite(viewportWidthPx) && viewportWidthPx <= MOBILE_CANVAS_MAX_WIDTH_PX;
}

export type RememberedCanvasState = {
  layout: CanvasLayoutNode;
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
    "canvas-5": { kind: "empty" },
    "canvas-6": { kind: "empty" },
    "canvas-7": { kind: "empty" },
    "canvas-8": { kind: "empty" },
  };
}

export function createDefaultCanvasRightPanelsOpen(): Record<CanvasPaneId, boolean> {
  return {
    "canvas-1": false,
    "canvas-2": false,
    "canvas-3": false,
    "canvas-4": false,
    "canvas-5": false,
    "canvas-6": false,
    "canvas-7": false,
    "canvas-8": false,
  };
}

export function getCanvasVisiblePaneIds(
  layout: CanvasLayoutNode,
  maximizedPaneId?: CanvasPaneId | null,
): CanvasPaneId[] {
  return maximizedPaneId ? [maximizedPaneId] : canvasLayoutPaneIds(layout);
}

export function resolveCanvasLayoutSelection(
  layout: CanvasLayoutNode,
  activePaneId: CanvasPaneId,
): { activePaneId: CanvasPaneId; maximizedPaneId: CanvasPaneId | null } {
  const paneIds = canvasLayoutPaneIds(layout);
  const onlyPaneId = paneIds.length === 1 ? paneIds[0] : undefined;
  return {
    activePaneId: paneIds.includes(activePaneId)
      ? activePaneId
      : (paneIds[0] ?? "canvas-1"),
    maximizedPaneId: onlyPaneId ?? null,
  };
}

export function resolveCanvasPaneRemovalSelection(
  nextPaneIds: readonly CanvasPaneId[],
  removedPaneIndex: number,
  activePaneId: CanvasPaneId,
): { activePaneId: CanvasPaneId; maximizedPaneId: CanvasPaneId | null } {
  const onlyPaneId = nextPaneIds.length === 1 ? nextPaneIds[0] : undefined;
  if (onlyPaneId) {
    return { activePaneId: onlyPaneId, maximizedPaneId: onlyPaneId };
  }
  if (nextPaneIds.includes(activePaneId)) {
    return { activePaneId, maximizedPaneId: null };
  }
  const adjacentIndex = Math.min(
    Math.max(removedPaneIndex, 0),
    Math.max(0, nextPaneIds.length - 1),
  );
  return {
    activePaneId: nextPaneIds[adjacentIndex] ?? "canvas-1",
    maximizedPaneId: null,
  };
}

export function hasAnyCanvasPaneTarget(
  targets: Record<CanvasPaneId, CanvasPaneTarget>,
): boolean {
  return CANVAS_PANE_IDS.some((paneId) => targets[paneId].kind !== "empty");
}

export function canvasStoredRefKey(
  ref: Pick<StoredSessionRef, "provider" | "providerSessionId">,
): string {
  return `${ref.provider}:${ref.providerSessionId}`;
}

export function canvasRestorableTargetKey(target: CanvasPaneTarget): string | null {
  if (target.kind === "stored") {
    return canvasStoredRefKey(target.ref);
  }
  if (target.kind === "session" && target.ref) {
    return canvasStoredRefKey(target.ref);
  }
  return null;
}

export function canvasOpeningTransitionForTarget(
  target: CanvasPaneTarget,
  pendingSessionAction: CanvasPendingSessionAction | null,
  pendingSessionTransition: PendingSessionTransition | null,
  canvasResumingStoredKeys: ReadonlySet<string> = new Set(),
): PendingSessionTransition | null {
  if (!pendingSessionTransition) {
    if (
      target.kind === "stored" &&
      canvasResumingStoredKeys.has(canvasStoredRefKey(target.ref))
    ) {
      return createPendingStoredSessionTransition(target.ref, "resume_history");
    }
    return null;
  }
  if (
    target.kind === "session" &&
    pendingSessionTransition.kind === "resume_history" &&
    pendingSessionAction?.kind === "resume_history" &&
    pendingSessionAction.sessionId === target.sessionId
  ) {
    return pendingSessionTransition;
  }
  if (
    target.kind === "stored" &&
    pendingSessionTransition.provider === target.ref.provider &&
    pendingSessionTransition.providerSessionId === target.ref.providerSessionId
  ) {
    return pendingSessionTransition;
  }
  if (
    target.kind === "stored" &&
    canvasResumingStoredKeys.has(canvasStoredRefKey(target.ref))
  ) {
    return createPendingStoredSessionTransition(target.ref, "resume_history");
  }
  return null;
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
    return {
      kind: "session",
      sessionId: value.sessionId,
      ...(isStoredSessionRef(value.ref) ? { ref: value.ref } : {}),
    };
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
  const layout =
    normalizeCanvasLayout(record.layout) ??
    migrateLegacyCanvasLayout(record.layout, record.ratios) ??
    createCanvasGridLayout(2, 1);
  const activePaneId = isCanvasPaneId(record.activePaneId) ? record.activePaneId : "canvas-1";
  const visiblePaneIds = canvasLayoutPaneIds(layout);
  return {
    layout,
    activePaneId: visiblePaneIds.includes(activePaneId)
      ? activePaneId
      : (visiblePaneIds[0] ?? "canvas-1"),
    targets: normalizeCanvasTargets(record.targets),
    rightPanelsOpen: normalizeCanvasRightPanelsOpen(record.rightPanelsOpen),
  };
}

export function readRememberedCanvasState(storage: Storage | undefined): RememberedCanvasState | null {
  if (!storage) {
    return null;
  }
  try {
    const raw =
      storage.getItem(CANVAS_STATE_STORAGE_KEY) ??
      storage.getItem(LEGACY_CANVAS_STATE_STORAGE_KEY);
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

export function resolveCanvasTargetProjection(
  target: CanvasPaneTarget,
  projections: Map<string, SessionProjection>,
): SessionProjection | null {
  if (target.kind === "session") {
    return (
      projections.get(target.sessionId) ??
      (target.ref ? resolveCanvasStoredTargetProjection(projections, target.ref) : null)
    );
  }
  if (target.kind === "stored") {
    return resolveCanvasStoredTargetProjection(projections, target.ref);
  }
  return null;
}

export function resolveCanvasVisibleSessionId(
  target: CanvasPaneTarget,
  projections: Map<string, SessionProjection>,
): string | null {
  if (target.kind === "session") {
    return resolveCanvasTargetProjection(target, projections)?.summary.session.id ?? target.sessionId;
  }
  if (target.kind === "stored") {
    return resolveCanvasTargetProjection(target, projections)?.summary.session.id ?? null;
  }
  return null;
}

function canvasProjectionMatchesStoredRef(
  projection: SessionProjection,
  ref: Pick<StoredSessionRef, "provider" | "providerSessionId">,
): boolean {
  return (
    projection.summary.session.provider === ref.provider &&
    projection.summary.session.providerSessionId === ref.providerSessionId
  );
}

export function resolveCanvasStoredTargetProjection(
  projections: Map<string, SessionProjection>,
  ref: Pick<StoredSessionRef, "provider" | "providerSessionId">,
): SessionProjection | null {
  let replayProjection: SessionProjection | null = null;
  for (const projection of projections.values()) {
    if (!canvasProjectionMatchesStoredRef(projection, ref)) {
      continue;
    }
    if (!isReadOnlyReplay(projection.summary)) {
      return projection;
    }
    replayProjection ??= projection;
  }
  return replayProjection;
}

export function resolveCanvasLiveSessionIdForStoredRef(
  projections: Map<string, SessionProjection>,
  ref: Pick<StoredSessionRef, "provider" | "providerSessionId"> | null | undefined,
): string | null {
  if (!ref) {
    return null;
  }
  const projection = resolveCanvasStoredTargetProjection(projections, ref);
  return projection && !isReadOnlyReplay(projection.summary) ? projection.summary.session.id : null;
}

export function resolveCanvasResumedSessionId(
  projections: Map<string, SessionProjection>,
  resumedSessionId: string | null | undefined,
  ref: Pick<StoredSessionRef, "provider" | "providerSessionId"> | null | undefined,
): string | null {
  const liveSessionId = resolveCanvasLiveSessionIdForStoredRef(projections, ref);
  if (liveSessionId) {
    return liveSessionId;
  }
  if (!resumedSessionId) {
    return null;
  }
  const resumedProjection = projections.get(resumedSessionId);
  return resumedProjection && isReadOnlyReplay(resumedProjection.summary) ? null : resumedSessionId;
}

export function resolveCanvasRunningUniquenessKey(
  target: CanvasPaneTarget,
  projections: Map<string, SessionProjection>,
): string | null {
  if (target.kind === "session") {
    const projection = resolveCanvasTargetProjection(target, projections);
    if (!projection || isReadOnlyReplay(projection.summary)) {
      return null;
    }
    return projection.summary.session.id;
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
  const ref =
    target.kind === "stored"
      ? target.ref
      : target.kind === "session"
        ? target.ref
        : undefined;
  return (
    ref?.provider === session.provider &&
    ref.providerSessionId === session.providerSessionId
  );
}

function canvasStoredRefFromProjection(projection: SessionProjection): StoredSessionRef | null {
  const session = projection.summary.session;
  if (!session.providerSessionId) {
    return null;
  }
  return {
    provider: session.provider,
    providerSessionId: session.providerSessionId,
    ...(session.cwd ? { cwd: session.cwd } : {}),
    ...(session.title ? { title: session.title } : {}),
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    source: isReadOnlyReplay(projection.summary) ? "provider_history" : "previous_running",
  };
}

export function createCanvasSessionTarget(
  sessionId: string,
  projections: Map<string, SessionProjection>,
): CanvasPaneTarget {
  const projection = projections.get(sessionId);
  const ref = projection ? canvasStoredRefFromProjection(projection) : null;
  return {
    kind: "session",
    sessionId,
    ...(ref ? { ref } : {}),
  };
}

export function enrichCanvasSessionTargets(
  current: Record<CanvasPaneId, CanvasPaneTarget>,
  projections: Map<string, SessionProjection>,
): Record<CanvasPaneId, CanvasPaneTarget> {
  let changed = false;
  const next = { ...current };
  for (const paneId of CANVAS_PANE_IDS) {
    const target = current[paneId];
    if (target.kind !== "session" || target.ref) {
      continue;
    }
    const projection = projections.get(target.sessionId);
    const ref = projection ? canvasStoredRefFromProjection(projection) : null;
    if (!ref) {
      continue;
    }
    next[paneId] = { ...target, ref };
    changed = true;
  }
  return changed ? next : current;
}

export function clearCanvasSessionTargets(
  current: Record<CanvasPaneId, CanvasPaneTarget>,
  sessionId: string,
): Record<CanvasPaneId, CanvasPaneTarget> {
  let changed = false;
  const next = { ...current };
  for (const paneId of CANVAS_PANE_IDS) {
    const target = current[paneId];
    if (target.kind === "session" && target.sessionId === sessionId) {
      next[paneId] = { kind: "empty" };
      changed = true;
    }
  }
  return changed ? next : current;
}

export function clearCanvasCouncilTargets(
  current: Record<CanvasPaneId, CanvasPaneTarget>,
  councilId: string,
): Record<CanvasPaneId, CanvasPaneTarget> {
  let changed = false;
  const next = { ...current };
  for (const paneId of CANVAS_PANE_IDS) {
    const target = current[paneId];
    if (target.kind === "council" && target.councilId === councilId) {
      next[paneId] = { kind: "empty" };
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

import type { StoredSessionRef } from "@rah/runtime-protocol";
import { isReadOnlyReplay } from "./session-capabilities";
import type { CanvasLayout } from "./components/workbench/canvas/CanvasWorkbench";
import type { SessionProjection } from "./types";

export type CanvasPaneId = "canvas-1" | "canvas-2" | "canvas-3" | "canvas-4";

export type CanvasPaneTarget =
  | { kind: "empty" }
  | { kind: "new" }
  | { kind: "council_room"; roomId: string }
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

export function createEmptyCanvasTargets(): Record<CanvasPaneId, CanvasPaneTarget> {
  return {
    "canvas-1": { kind: "empty" },
    "canvas-2": { kind: "empty" },
    "canvas-3": { kind: "empty" },
    "canvas-4": { kind: "empty" },
  };
}

export function createCanvasLayoutRatios(layout: CanvasLayout): number[] {
  return Array.from({ length: CANVAS_LAYOUT_PANE_COUNT[layout] }, () => 1);
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
    return target.kind === "council_room" ? `council_room:${target.roomId}` : null;
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

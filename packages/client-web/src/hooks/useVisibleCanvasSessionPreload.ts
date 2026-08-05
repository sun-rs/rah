import { useEffect, useMemo } from "react";
import {
  resolveCanvasTargetProjection,
  type CanvasPaneId,
  type CanvasPaneTarget,
} from "../canvas-state";
import { preloadSelectedSessionView } from "../session-view-preload";
import type { SessionProjection } from "../types";

type CanvasSessionPreloadTarget = {
  sessionId: string;
  workspaceRoot: string;
};

/** Owns the shared Chat/Inspector preload for every visible Canvas Session. */
export function useVisibleCanvasSessionPreload(args: {
  active: boolean;
  paneIds: readonly CanvasPaneId[];
  paneKey: string;
  paneTargets: Record<CanvasPaneId, CanvasPaneTarget>;
  projections: Map<string, SessionProjection>;
  fallbackWorkspaceRoot: string;
  ensureConversationLoaded: (sessionId: string) => Promise<unknown>;
}): void {
  const targetKey = useMemo(() => {
    if (!args.active) {
      return "[]";
    }
    const seen = new Set<string>();
    const targets: CanvasSessionPreloadTarget[] = [];
    for (const paneId of args.paneIds) {
      const projection = resolveCanvasTargetProjection(
        args.paneTargets[paneId],
        args.projections,
      );
      if (!projection || seen.has(projection.summary.session.id)) {
        continue;
      }
      const workspaceRoot =
        projection.summary.session.rootDir ||
        projection.summary.session.cwd ||
        args.fallbackWorkspaceRoot;
      if (!workspaceRoot) {
        continue;
      }
      seen.add(projection.summary.session.id);
      targets.push({
        sessionId: projection.summary.session.id,
        workspaceRoot,
      });
    }
    return JSON.stringify(targets);
  }, [
    args.active,
    args.fallbackWorkspaceRoot,
    args.paneKey,
    args.paneTargets,
    args.projections,
  ]);

  useEffect(() => {
    const targets = JSON.parse(targetKey) as CanvasSessionPreloadTarget[];
    if (!args.active || targets.length === 0) {
      return;
    }
    const controller = new AbortController();
    for (const target of targets) {
      void preloadSelectedSessionView({
        sessionId: target.sessionId,
        workspaceRoot: target.workspaceRoot,
        signal: controller.signal,
        ensureConversationLoaded: args.ensureConversationLoaded,
      }).catch(() => {
        // Each pane retains its normal Chat/Inspector retry surface. This hook
        // only guarantees that every visible shared cache has one owner.
      });
    }
    return () => controller.abort();
  }, [args.active, args.ensureConversationLoaded, targetKey]);
}

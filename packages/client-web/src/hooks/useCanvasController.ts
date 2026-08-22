import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { StoredSessionRef } from "@rah/runtime-protocol";
import type { SessionProjection } from "../types";
import type { WorkbenchMode } from "./useWorkbenchPageController";
import type { FileDetailSelection } from "../inspector/shared";
import {
  applyCanvasPaneTarget,
  canvasRestorableTargetKey,
  canvasStoredRefKey,
  createDefaultCanvasRightPanelsOpen,
  createEmptyCanvasTargets,
  enrichCanvasSessionTargets,
  getCanvasVisiblePaneIds,
  MOBILE_CANVAS_LAYOUT,
  readRememberedCanvasState,
  rememberCanvasState,
  resolveCanvasLayoutSelection,
  resolveCanvasPaneRemovalSelection,
  shouldUseMobileCanvasLayout,
  type CanvasPendingSessionAction,
  type CanvasPaneId,
  type CanvasPaneTarget,
} from "../canvas-state";
import {
  canvasLayoutPaneIds,
  createCanvasGridLayout,
  removeCanvasLayoutPane,
  splitCanvasLayoutPane,
  type CanvasLayoutNode,
  type CanvasSplitAxis,
} from "../canvas-layout";

export type CanvasPaneFilePreview = {
  requestId: number;
  sessionId: string;
  workspaceRoot: string;
  selection: FileDetailSelection;
  collapsed: boolean;
  presentation: "auto" | "windowed" | "maximized";
};

export function activateCanvasPaneFilePreview(
  current: CanvasPaneFilePreview | undefined,
  requestId: number,
  sessionId: string,
  workspaceRoot: string,
  path: string,
): CanvasPaneFilePreview {
  return {
    requestId,
    sessionId,
    workspaceRoot,
    selection: { path, source: "local", sessionId },
    collapsed: false,
    presentation: current?.presentation ?? "auto",
  };
}

export function useCanvasController(options: {
  projections: Map<string, SessionProjection>;
  viewportWidthPx: number;
  workbenchMode: WorkbenchMode;
}) {
  const rememberedState = useMemo(
    () =>
      typeof window === "undefined"
        ? null
        : readRememberedCanvasState(window.localStorage),
    [],
  );
  const [canvasLayout, setCanvasLayoutState] = useState<CanvasLayoutNode>(
    () => rememberedState?.layout ?? createCanvasGridLayout(2, 1),
  );
  const [canvasMaximizedPaneId, setCanvasMaximizedPaneId] =
    useState<CanvasPaneId | null>(null);
  const [activeCanvasPaneId, setActiveCanvasPaneId] = useState<CanvasPaneId>(
    () => rememberedState?.activePaneId ?? "canvas-1",
  );
  const [mobileCanvasLayout, setMobileCanvasLayoutState] = useState<CanvasLayoutNode>(
    () => MOBILE_CANVAS_LAYOUT,
  );
  const [canvasPaneTargets, setCanvasPaneTargets] = useState<
    Record<CanvasPaneId, CanvasPaneTarget>
  >(() => rememberedState?.targets ?? createEmptyCanvasTargets());
  const [canvasPaneRightPanelsOpen, setCanvasPaneRightPanelsOpen] = useState<
    Record<CanvasPaneId, boolean>
  >(() => rememberedState?.rightPanelsOpen ?? createDefaultCanvasRightPanelsOpen());
  const [canvasPaneFilePreviews, setCanvasPaneFilePreviews] = useState<
    Partial<Record<CanvasPaneId, CanvasPaneFilePreview>>
  >({});
  const canvasFilePreviewRequestIdRef = useRef(0);
  const canvasStoredActivationInFlightRef = useRef<Set<string>>(new Set());
  const canvasResumingStoredKeysRef = useRef<Set<string>>(new Set());
  const [canvasResumingStoredKeys, setCanvasResumingStoredKeys] = useState<Set<string>>(
    () => new Set(),
  );
  const [canvasPendingSessionActions, setCanvasPendingSessionActions] = useState<
    Record<string, CanvasPendingSessionAction>
  >({});
  const [canvasRestoreErrors, setCanvasRestoreErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    rememberCanvasState(
      typeof window === "undefined" ? undefined : window.localStorage,
      {
        layout: canvasLayout,
        activePaneId: activeCanvasPaneId,
        targets: canvasPaneTargets,
        rightPanelsOpen: canvasPaneRightPanelsOpen,
      },
    );
  }, [
    activeCanvasPaneId,
    canvasLayout,
    canvasPaneRightPanelsOpen,
    canvasPaneTargets,
  ]);

  useEffect(() => {
    setCanvasPaneTargets((current) => enrichCanvasSessionTargets(current, options.projections));
  }, [options.projections]);

  useEffect(() => {
    setCanvasPaneFilePreviews((current) => {
      let changed = false;
      const next = { ...current };
      for (const paneId of Object.keys(current) as CanvasPaneId[]) {
        const target = canvasPaneTargets[paneId];
        if (target.kind !== "session" && target.kind !== "stored") {
          delete next[paneId];
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [canvasPaneTargets]);

  const mobileCanvasLayoutOnly = shouldUseMobileCanvasLayout(options.viewportWidthPx);
  const effectiveCanvasLayout = mobileCanvasLayoutOnly ? mobileCanvasLayout : canvasLayout;
  const visibleCanvasPaneIds = getCanvasVisiblePaneIds(
    effectiveCanvasLayout,
    canvasMaximizedPaneId,
  );

  useEffect(() => {
    if (
      !mobileCanvasLayoutOnly ||
      options.workbenchMode !== "canvas" ||
      canvasMaximizedPaneId
    ) {
      return;
    }
    if (!getCanvasVisiblePaneIds(mobileCanvasLayout).includes(activeCanvasPaneId)) {
      setActiveCanvasPaneId("canvas-1");
    }
  }, [
    activeCanvasPaneId,
    canvasMaximizedPaneId,
    mobileCanvasLayout,
    mobileCanvasLayoutOnly,
    options.workbenchMode,
  ]);

  const setCanvasPaneRightPanelOpen = useCallback((paneId: CanvasPaneId, open: boolean) => {
    setCanvasPaneRightPanelsOpen((current) => ({
      ...current,
      [paneId]: open,
    }));
  }, []);

  const toggleCanvasPaneRightPanel = useCallback((paneId: CanvasPaneId) => {
    setCanvasPaneRightPanelsOpen((current) => ({
      ...current,
      [paneId]: !current[paneId],
    }));
  }, []);

  const openCanvasPaneFilePreview = useCallback(
    (
      paneId: CanvasPaneId,
      sessionId: string,
      workspaceRoot: string,
      path: string,
    ) => {
      canvasFilePreviewRequestIdRef.current += 1;
      const requestId = canvasFilePreviewRequestIdRef.current;
      setCanvasPaneFilePreviews((current) => ({
        ...current,
        [paneId]: activateCanvasPaneFilePreview(
          current[paneId],
          requestId,
          sessionId,
          workspaceRoot,
          path,
        ),
      }));
      // Local-file controls stop click propagation so text selection remains
      // stable. Claim the pane here instead of relying on the pane frame click.
      setActiveCanvasPaneId(paneId);
    },
    [],
  );

  const closeCanvasPaneFilePreview = useCallback((paneId: CanvasPaneId) => {
    setCanvasPaneFilePreviews((current) => {
      if (!current[paneId]) {
        return current;
      }
      const next = { ...current };
      delete next[paneId];
      return next;
    });
  }, []);

  const setCanvasPaneFilePreviewCollapsed = useCallback(
    (paneId: CanvasPaneId, collapsed: boolean) => {
      setCanvasPaneFilePreviews((current) => {
        const preview = current[paneId];
        return preview
          ? { ...current, [paneId]: { ...preview, collapsed } }
          : current;
      });
    },
    [],
  );

  const setCanvasPaneFilePreviewPresentation = useCallback(
    (paneId: CanvasPaneId, presentation: "windowed" | "maximized") => {
      setCanvasPaneFilePreviews((current) => {
        const preview = current[paneId];
        return preview
          ? { ...current, [paneId]: { ...preview, presentation } }
          : current;
      });
    },
    [],
  );

  const clearAllCanvasPaneFilePreviews = useCallback(() => {
    setCanvasPaneFilePreviews({});
  }, []);

  const markCanvasResumePending = useCallback((sessionId: string, ref: StoredSessionRef) => {
    const key = canvasStoredRefKey(ref);
    canvasResumingStoredKeysRef.current.add(key);
    setCanvasResumingStoredKeys((current) => {
      if (current.has(key)) {
        return current;
      }
      const next = new Set(current);
      next.add(key);
      return next;
    });
    setCanvasPendingSessionActions((current) => {
      if (current[sessionId]?.kind === "resume_history") {
        return current;
      }
      return {
        ...current,
        [sessionId]: { kind: "resume_history", sessionId },
      };
    });
  }, []);

  const clearCanvasResumePending = useCallback((sessionId: string, ref: StoredSessionRef) => {
    const key = canvasStoredRefKey(ref);
    canvasResumingStoredKeysRef.current.delete(key);
    setCanvasResumingStoredKeys((current) => {
      if (!current.has(key)) {
        return current;
      }
      const next = new Set(current);
      next.delete(key);
      return next;
    });
    setCanvasPendingSessionActions((current) => {
      if (!current[sessionId]) {
        return current;
      }
      const next = { ...current };
      delete next[sessionId];
      return next;
    });
  }, []);

  const reconcileCanvasLayoutSelection = useCallback((layout: CanvasLayoutNode) => {
    const selection = resolveCanvasLayoutSelection(layout, activeCanvasPaneId);
    setActiveCanvasPaneId(selection.activePaneId);
    setCanvasMaximizedPaneId(selection.maximizedPaneId);
  }, [activeCanvasPaneId]);

  const setCanvasLayout = useCallback((layout: CanvasLayoutNode) => {
    setCanvasLayoutState(layout);
    reconcileCanvasLayoutSelection(layout);
  }, [reconcileCanvasLayoutSelection]);

  const setMobileCanvasLayout = useCallback((layout: CanvasLayoutNode) => {
    setMobileCanvasLayoutState(layout);
    reconcileCanvasLayoutSelection(layout);
  }, [reconcileCanvasLayoutSelection]);

  const splitCanvasPane = useCallback((paneId: CanvasPaneId, axis: CanvasSplitAxis) => {
    if (mobileCanvasLayoutOnly) {
      return;
    }
    const split = splitCanvasLayoutPane(canvasLayout, paneId, axis);
    if (!split) {
      return;
    }
    setCanvasLayoutState(split.layout);
    setCanvasMaximizedPaneId(null);
    setActiveCanvasPaneId(split.newPaneId);
  }, [canvasLayout, mobileCanvasLayoutOnly]);

  const removeCanvasPane = useCallback((paneId: CanvasPaneId) => {
    const currentLayout = mobileCanvasLayoutOnly ? mobileCanvasLayout : canvasLayout;
    const previousVisiblePaneIds = canvasLayoutPaneIds(currentLayout);
    const removedIndex = previousVisiblePaneIds.indexOf(paneId);
    const nextLayout = removeCanvasLayoutPane(currentLayout, paneId);
    if (!nextLayout) {
      return false;
    }
    const nextVisiblePaneIds = canvasLayoutPaneIds(nextLayout);
    if (mobileCanvasLayoutOnly) {
      setMobileCanvasLayoutState(nextLayout);
    } else {
      setCanvasLayoutState(nextLayout);
    }
    const nextSelection = resolveCanvasPaneRemovalSelection(
      nextVisiblePaneIds,
      removedIndex,
      activeCanvasPaneId,
    );
    setCanvasMaximizedPaneId(nextSelection.maximizedPaneId);
    setCanvasPaneTargets((current) => ({
      ...current,
      [paneId]: { kind: "empty" },
    }));
    setCanvasPaneRightPanelsOpen((current) => ({
      ...current,
      [paneId]: false,
    }));
    setCanvasPaneFilePreviews((current) => {
      if (!current[paneId]) {
        return current;
      }
      const next = { ...current };
      delete next[paneId];
      return next;
    });
    setActiveCanvasPaneId(nextSelection.activePaneId);
    return true;
  }, [
    activeCanvasPaneId,
    canvasLayout,
    mobileCanvasLayout,
    mobileCanvasLayoutOnly,
  ]);

  const setCanvasPaneTarget = useCallback((paneId: CanvasPaneId, target: CanvasPaneTarget) => {
    const restoreKey = canvasRestorableTargetKey(target);
    if (restoreKey) {
      setCanvasRestoreErrors((current) => {
        if (!current[restoreKey]) {
          return current;
        }
        const next = { ...current };
        delete next[restoreKey];
        return next;
      });
    }
    setCanvasPaneTargets((current) =>
      applyCanvasPaneTarget(current, paneId, target, options.projections),
    );
    setCanvasPaneFilePreviews((current) => {
      if (!current[paneId]) {
        return current;
      }
      const next = { ...current };
      delete next[paneId];
      return next;
    });
    setActiveCanvasPaneId(paneId);
  }, [options.projections]);

  const reportCanvasRestoreError = useCallback(
    (target: CanvasPaneTarget, message: string) => {
      const restoreKey = canvasRestorableTargetKey(target);
      if (!restoreKey) {
        return;
      }
      setCanvasRestoreErrors((current) =>
        current[restoreKey] === message
          ? current
          : { ...current, [restoreKey]: message },
      );
    },
    [],
  );

  const clearCanvasRestoreError = useCallback((target: CanvasPaneTarget) => {
    const restoreKey = canvasRestorableTargetKey(target);
    if (!restoreKey) {
      return;
    }
    setCanvasRestoreErrors((current) => {
      if (!current[restoreKey]) {
        return current;
      }
      const next = { ...current };
      delete next[restoreKey];
      return next;
    });
  }, []);

  const toggleCanvasPaneMaximize = useCallback((paneId: CanvasPaneId) => {
    setActiveCanvasPaneId(paneId);
    setCanvasMaximizedPaneId((current) => (current === paneId ? null : paneId));
  }, []);

  return {
    canvasLayout,
    canvasMaximizedPaneId,
    activeCanvasPaneId,
    mobileCanvasLayout,
    canvasPaneTargets,
    canvasPaneRightPanelsOpen,
    canvasPaneFilePreviews,
    canvasStoredActivationInFlightRef,
    canvasResumingStoredKeysRef,
    canvasResumingStoredKeys,
    canvasPendingSessionActions,
    canvasRestoreErrors,
    mobileCanvasLayoutOnly,
    effectiveCanvasLayout,
    visibleCanvasPaneIds,
    setActiveCanvasPaneId,
    setMobileCanvasLayout,
    setCanvasPaneTargets,
    setCanvasMaximizedPaneId,
    setCanvasPendingSessionActions,
    setCanvasPaneRightPanelOpen,
    toggleCanvasPaneRightPanel,
    openCanvasPaneFilePreview,
    closeCanvasPaneFilePreview,
    setCanvasPaneFilePreviewCollapsed,
    setCanvasPaneFilePreviewPresentation,
    clearAllCanvasPaneFilePreviews,
    markCanvasResumePending,
    clearCanvasResumePending,
    setCanvasLayout,
    splitCanvasPane,
    removeCanvasPane,
    setCanvasPaneTarget,
    reportCanvasRestoreError,
    clearCanvasRestoreError,
    toggleCanvasPaneMaximize,
  };
}

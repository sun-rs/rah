import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type { CanvasPaneTarget } from "../canvas-state";
import { canvasStoredRefKey } from "../canvas-state";
import {
  useReviewOverlay,
  type ReviewOverlayOwner,
} from "../inspector/ReviewOverlay";
import type { WorkbenchMode } from "./useWorkbenchPageController";

export type LinkedFilePreview = {
  path: string;
  sessionId: string | null;
  workspaceRoot: string;
};

type InspectionLifecycleOptions = {
  mode: WorkbenchMode;
  selectedSessionId: string | null;
  selectedCouncilId: string | null;
  selectedWorkspaceDir: string | null;
  activeCanvasPaneId: string;
  activeCanvasTarget: CanvasPaneTarget;
  activeCanvasSessionId: string | null;
  settingsOpen: boolean;
  terminalOpen: boolean;
  fileReferenceOpen: boolean;
  workspacePickerOpen: boolean;
  newCouncilDialogOpen: boolean;
  clearCanvasPaneFilePreviews: () => void;
};

function canvasTargetContextKey(target: CanvasPaneTarget): string {
  switch (target.kind) {
    case "session":
      return target.ref
        ? `thread:${canvasStoredRefKey(target.ref)}`
        : `session:${target.sessionId}`;
    case "stored":
      return `thread:${canvasStoredRefKey(target.ref)}`;
    case "council":
      return `council:${target.councilId}`;
    default:
      return target.kind;
  }
}

export function workbenchInspectionContextKey(
  options: Omit<InspectionLifecycleOptions, "clearCanvasPaneFilePreviews">,
): string {
  const pageKey =
    options.mode === "canvas"
      ? `canvas:${options.activeCanvasPaneId}:${canvasTargetContextKey(options.activeCanvasTarget)}`
      : options.mode === "council"
        ? `council:${options.selectedCouncilId ?? "landing"}`
        : options.selectedSessionId
          ? `session:${options.selectedSessionId}`
          : `workspace:${options.selectedWorkspaceDir ?? "home"}`;
  const takeoverKey = [
    options.settingsOpen && "settings",
    options.terminalOpen && "terminal",
    options.fileReferenceOpen && "file-reference",
    options.workspacePickerOpen && "workspace-picker",
    options.newCouncilDialogOpen && "new-council",
  ]
    .filter(Boolean)
    .join(",");
  return `${pageKey}|${takeoverKey || "content"}`;
}

export function inspectionContextReviewOwner(
  options: Omit<InspectionLifecycleOptions, "clearCanvasPaneFilePreviews">,
): ReviewOverlayOwner {
  if (
    options.settingsOpen ||
    options.terminalOpen ||
    options.fileReferenceOpen ||
    options.workspacePickerOpen ||
    options.newCouncilDialogOpen
  ) {
    return null;
  }
  if (options.mode === "canvas") {
    return options.activeCanvasSessionId
      ? { kind: "session", sessionId: options.activeCanvasSessionId }
      : null;
  }
  if (options.mode === "council") {
    return null;
  }
  if (options.selectedSessionId) {
    return { kind: "session", sessionId: options.selectedSessionId };
  }
  return options.selectedWorkspaceDir
    ? { kind: "workspace", workspaceRoot: options.selectedWorkspaceDir }
    : null;
}

export function inspectionContextClearsCanvasPreviews(
  options: Omit<InspectionLifecycleOptions, "clearCanvasPaneFilePreviews">,
): boolean {
  return (
    options.mode !== "canvas" ||
    options.settingsOpen ||
    options.terminalOpen ||
    options.fileReferenceOpen ||
    options.workspacePickerOpen ||
    options.newCouncilDialogOpen
  );
}

export function useWorkbenchInspectionLifecycle(options: InspectionLifecycleOptions) {
  const { retainReviewForOwner } = useReviewOverlay();
  const [linkedFilePreview, setLinkedFilePreview] =
    useState<LinkedFilePreview | null>(null);
  const {
    clearCanvasPaneFilePreviews,
    ...lifecycleOptions
  } = options;
  const contextKey = workbenchInspectionContextKey(lifecycleOptions);
  const previousContextKeyRef = useRef(contextKey);

  useLayoutEffect(() => {
    if (previousContextKeyRef.current === contextKey) {
      return;
    }
    previousContextKeyRef.current = contextKey;
    setLinkedFilePreview(null);
    retainReviewForOwner(inspectionContextReviewOwner(lifecycleOptions));
    if (inspectionContextClearsCanvasPreviews(lifecycleOptions)) {
      clearCanvasPaneFilePreviews();
    }
  }, [clearCanvasPaneFilePreviews, contextKey, retainReviewForOwner]);

  const openLinkedFilePreview = useCallback((preview: LinkedFilePreview) => {
    setLinkedFilePreview(preview);
  }, []);
  const closeLinkedFilePreview = useCallback(() => {
    setLinkedFilePreview(null);
  }, []);

  return {
    linkedFilePreview,
    openLinkedFilePreview,
    closeLinkedFilePreview,
  };
}

import * as React from "react";
import { FileText, Maximize2, X } from "lucide-react";
import type {
  CanvasPaneFilePreview,
} from "../../../hooks/useCanvasController";
import {
  InspectorFileDetailDialog,
  type PaneWindowVerticalGeometry,
} from "../../../inspector/InspectorFileDetailDialog";
import { FilePreviewDialogErrorBoundary } from "../dialogs/FilePreviewDialogErrorBoundary";

export const CANVAS_PANE_FILE_VIEWER_MIN_WINDOW_WIDTH = 560;
export const CANVAS_PANE_FILE_VIEWER_MIN_WINDOW_HEIGHT = 480;

type PaneSize = { width: number; height: number };

export function resolveCanvasPaneFileViewerPresentation(
  preference: CanvasPaneFilePreview["presentation"],
  paneSize: PaneSize,
): "windowed" | "maximized" {
  if (preference === "windowed" || preference === "maximized") {
    return preference;
  }
  return paneSize.width >= CANVAS_PANE_FILE_VIEWER_MIN_WINDOW_WIDTH &&
    paneSize.height >= CANVAS_PANE_FILE_VIEWER_MIN_WINDOW_HEIGHT
    ? "windowed"
    : "maximized";
}

export function CanvasPaneFileViewer(props: {
  preview: CanvasPaneFilePreview;
  onCollapsedChange: (collapsed: boolean) => void;
  onPresentationChange: (presentation: "windowed" | "maximized") => void;
  onClose: () => void;
}) {
  const hostRef = React.useRef<HTMLDivElement>(null);
  const [paneSize, setPaneSize] = React.useState<PaneSize>({ width: 0, height: 0 });
  const [paneWindowGeometry, setPaneWindowGeometry] =
    React.useState<PaneWindowVerticalGeometry | null>(null);
  const fileName =
    props.preview.selection.path.split("/").pop() || props.preview.selection.path;
  const presentation = resolveCanvasPaneFileViewerPresentation(
    props.preview.presentation,
    paneSize,
  );

  React.useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) {
      return;
    }
    const updateSize = () => {
      const next = host.getBoundingClientRect();
      setPaneSize((current) =>
        current.width === next.width && current.height === next.height
          ? current
          : { width: next.width, height: next.height },
      );
    };
    updateSize();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", updateSize);
      return () => window.removeEventListener("resize", updateSize);
    }
    const observer = new ResizeObserver(updateSize);
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  if (props.preview.collapsed) {
    return (
      <div
        ref={hostRef}
        data-canvas-pane-file-viewer-presentation={presentation}
        data-canvas-pane-file-viewer-request-id={props.preview.requestId}
        className="pointer-events-none absolute inset-0 z-[30]"
      >
        <div
          data-testid="canvas-pane-file-viewer-collapsed"
          className="pointer-events-auto absolute right-2 top-10 flex h-9 max-w-[calc(100%-1rem)] items-center overflow-hidden rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] shadow-lg"
        >
          <button
            type="button"
            className="flex min-w-0 flex-1 items-center gap-2 px-3 text-xs font-medium text-[var(--app-fg)]"
            onClick={() => props.onCollapsedChange(false)}
            aria-label={`Expand file viewer for ${fileName}`}
            title={props.preview.selection.path}
          >
            <FileText size={14} className="shrink-0 text-[var(--app-hint)]" />
            <span className="truncate">{fileName}</span>
            <Maximize2 size={13} className="shrink-0 text-[var(--app-hint)]" />
          </button>
          <button
            type="button"
            className="inline-flex h-9 w-9 shrink-0 items-center justify-center border-l border-[var(--app-border)] text-[var(--app-hint)] hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)]"
            onClick={props.onClose}
            aria-label={`Close file viewer for ${fileName}`}
            title="Close file viewer"
          >
            <X size={14} />
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      ref={hostRef}
      data-testid="canvas-pane-file-viewer-host"
      data-canvas-pane-file-viewer-presentation={presentation}
      data-canvas-pane-file-viewer-request-id={props.preview.requestId}
      className="pointer-events-none absolute inset-0 z-[30]"
    >
      <FilePreviewDialogErrorBoundary
        resetKey={`canvas-file:${props.preview.requestId}:${props.preview.selection.path}`}
        presentation={presentation === "windowed" ? "pane-window" : "pane"}
        onClose={props.onClose}
      >
        <InspectorFileDetailDialog
          sessionId={props.preview.sessionId}
          workspaceRoot={props.preview.workspaceRoot}
          selection={props.preview.selection}
          presentation={presentation === "windowed" ? "pane-window" : "pane"}
          paneWindowGeometry={paneWindowGeometry}
          onPaneWindowGeometryChange={setPaneWindowGeometry}
          onCollapse={() => props.onCollapsedChange(true)}
          onPresentationChange={(next) =>
            props.onPresentationChange(next === "pane-window" ? "windowed" : "maximized")
          }
          onRefreshChanges={() => undefined}
          onClose={props.onClose}
        />
      </FilePreviewDialogErrorBoundary>
    </div>
  );
}

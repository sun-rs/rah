import type { PointerEvent as ReactPointerEvent, ReactNode } from "react";
import {
  Columns2,
  Columns3,
  Eraser,
  Grid2X2,
  Maximize2,
  Minus,
  Minimize2,
  Rows2,
} from "lucide-react";
import {
  canvasLayoutPaneCount,
  createCanvasGridLayout,
  createCanvasPresetLayout,
  deriveCanvasSplitJunctions,
  getCanvasLayoutPresetId,
  MAX_CANVAS_PANES,
  updateCanvasSplitRatio,
  type CanvasGridDimensions,
  type CanvasLayoutNode,
  type CanvasLayoutPresetId,
  type CanvasPaneId,
  type CanvasSplitAxis,
  type CanvasSplitJunctionDirections,
} from "../../../canvas-layout";
import {
  HEADER_ACTION_ICON_SIZE,
  HEADER_ICON_BUTTON_CLASS,
  HEADER_SEGMENTED_BUTTON_ACTIVE_CLASS,
  HEADER_SEGMENTED_BUTTON_BASE_CLASS,
  HEADER_SEGMENTED_BUTTON_INACTIVE_CLASS,
  HEADER_SEGMENTED_CONTROL_CLASS,
  HEADER_SEGMENTED_LABEL_CLASS,
} from "../header-button-styles";
import { ConversationHeader } from "../shells/ConversationHeader";
import { CanvasLayoutDesigner, CanvasPaneSplitButton } from "./CanvasLayoutControls";
import {
  readCanvasSessionDragTarget,
  type CanvasSessionDragTarget,
} from "./canvas-session-drag";

export type CanvasPaneView = {
  id: CanvasPaneId;
  label: string;
  active: boolean;
  clearable: boolean;
};

const LAYOUT_OPTIONS: Array<{
  id: CanvasLayoutPresetId;
  label: string;
  title: string;
  icon: typeof Columns2;
}> = [
  { id: "two-horizontal", label: "2", title: "Two panes side by side", icon: Columns2 },
  { id: "two-vertical", label: "2", title: "Two panes stacked", icon: Rows2 },
  { id: "three-horizontal", label: "3", title: "Three panes", icon: Columns3 },
  { id: "four-grid", label: "4", title: "Four panes", icon: Grid2X2 },
];

function CanvasDividerMarker(props: {
  axis: CanvasSplitAxis;
  position: number;
  directions?: CanvasSplitJunctionDirections;
}) {
  const directions = props.directions ?? (
    props.axis === "horizontal"
      ? { left: false, right: false, up: true, down: true }
      : { left: true, right: true, up: false, down: false }
  );
  const style = props.axis === "horizontal"
    ? { left: "50%", top: `${props.position * 100}%` }
    : { left: `${props.position * 100}%`, top: "50%" };
  const armClassName =
    "pointer-events-none absolute bg-[var(--app-hint)]/20 transition-colors duration-150 group-hover:bg-[var(--app-hint)]/45";
  return (
    <span
      className="pointer-events-none absolute h-6 w-6 -translate-x-1/2 -translate-y-1/2"
      style={style}
      aria-hidden="true"
    >
      {directions.left ? (
        <span className={`${armClassName} right-1/2 top-1/2 h-px w-2.5 -translate-y-1/2`} />
      ) : null}
      {directions.right ? (
        <span className={`${armClassName} left-1/2 top-1/2 h-px w-2.5 -translate-y-1/2`} />
      ) : null}
      {directions.up ? (
        <span className={`${armClassName} bottom-1/2 left-1/2 h-2.5 w-px -translate-x-1/2`} />
      ) : null}
      {directions.down ? (
        <span className={`${armClassName} left-1/2 top-1/2 h-2.5 w-px -translate-x-1/2`} />
      ) : null}
    </span>
  );
}

function createFrameCommit<T>(commit: (value: T) => void) {
  let frameId: number | null = null;
  let pendingValue: T | null = null;

  const flush = () => {
    frameId = null;
    const value = pendingValue;
    pendingValue = null;
    if (value !== null) {
      commit(value);
    }
  };

  return {
    schedule(value: T) {
      pendingValue = value;
      if (frameId === null) {
        frameId = window.requestAnimationFrame(flush);
      }
    },
    finish() {
      if (frameId !== null) {
        window.cancelAnimationFrame(frameId);
        frameId = null;
      }
      flush();
    },
  };
}

export function CanvasWorkbench(props: {
  panes: CanvasPaneView[];
  layout: CanvasLayoutNode;
  layoutEditingDisabled?: boolean;
  maximizedPaneId: CanvasPaneId | null;
  sidebarOpen: boolean;
  showLeftSidebarControls: boolean;
  onLayoutChange: (layout: CanvasLayoutNode) => void;
  onOpenLeft: () => void;
  onExpandSidebar: () => void;
  onActivatePane: (paneId: CanvasPaneId) => void;
  onToggleMaximize: (paneId: CanvasPaneId) => void;
  onSplitPane: (paneId: CanvasPaneId, axis: CanvasSplitAxis) => void;
  onRemovePane: (paneId: CanvasPaneId) => void;
  onClearPane: (paneId: CanvasPaneId) => void;
  onClearAllPanes: () => void;
  clearAllPanesDisabled: boolean;
  onExitCanvas: () => void;
  onDropSession: (paneId: CanvasPaneId, target: CanvasSessionDragTarget) => void;
  onDropCouncil: (paneId: CanvasPaneId, councilId: string) => void;
  renderPane: (paneId: CanvasPaneId) => ReactNode;
}) {
  const panesById = new Map(props.panes.map((pane) => [pane.id, pane] as const));
  const paneCount = canvasLayoutPaneCount(props.layout);
  const activePreset = getCanvasLayoutPresetId(props.layout);
  const splitJunctions = deriveCanvasSplitJunctions(props.layout);
  const layoutOptions = props.layoutEditingDisabled
    ? LAYOUT_OPTIONS.filter((option) => option.id === "two-vertical")
    : LAYOUT_OPTIONS;

  const startSplitResize = (
    splitNodeId: string,
    axis: CanvasSplitAxis,
    startRatio: number,
    event: ReactPointerEvent<HTMLDivElement>,
  ) => {
    if (props.maximizedPaneId) {
      return;
    }
    const container = event.currentTarget.parentElement;
    if (!container) {
      return;
    }

    event.preventDefault();
    const rect = container.getBoundingClientRect();
    const startX = event.clientX;
    const startY = event.clientY;
    const layoutCommit = createFrameCommit(props.onLayoutChange);

    const onPointerMove = (moveEvent: PointerEvent) => {
      const basis = axis === "horizontal" ? rect.width : rect.height;
      const deltaPixels =
        axis === "horizontal" ? moveEvent.clientX - startX : moveEvent.clientY - startY;
      layoutCommit.schedule(
        updateCanvasSplitRatio(props.layout, splitNodeId, startRatio + deltaPixels / Math.max(1, basis)),
      );
    };

    const onPointerUp = () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);
      layoutCommit.finish();
    };

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp, { once: true });
    window.addEventListener("pointercancel", onPointerUp, { once: true });
  };

  const renderFrame = (pane: CanvasPaneView) => (
    <section
      key={pane.id}
      data-canvas-pane-id={pane.id}
      className={`relative min-h-0 min-w-0 flex-1 overflow-hidden rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] transition-colors ${
        pane.active ? "z-[1]" : ""
      }`}
      onClick={() => props.onActivatePane(pane.id)}
      onDragOver={(event) => {
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
      }}
      onDrop={(event) => {
        event.preventDefault();
        const sessionTarget = readCanvasSessionDragTarget(event.dataTransfer);
        if (sessionTarget) {
          props.onDropSession(pane.id, sessionTarget);
          return;
        }
        const councilId = event.dataTransfer.getData("application/x-rah-council-id");
        if (councilId) {
          props.onDropCouncil(pane.id, councilId);
        }
      }}
    >
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex h-8 shrink-0 items-center justify-between gap-2 border-b border-[var(--app-border)] bg-[var(--app-subtle-bg)] px-2">
          <button
            type="button"
            className="min-w-0 flex-1 truncate text-left text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--app-hint)]"
            onClick={() => props.onActivatePane(pane.id)}
          >
            {pane.label}
          </button>
          <div className="flex shrink-0 items-center gap-1">
            {pane.clearable ? (
              <button
                type="button"
                className="inline-flex h-6 w-6 items-center justify-center rounded-md text-[var(--app-hint)] transition-colors hover:bg-[var(--app-bg)] hover:text-[var(--app-fg)]"
                onClick={(event) => {
                  event.stopPropagation();
                  props.onClearPane(pane.id);
                }}
                aria-label="Clear pane content"
                title="Clear pane content"
              >
                <Eraser size={13} />
              </button>
            ) : null}
            {!props.layoutEditingDisabled ? (
              <CanvasPaneSplitButton
                disabled={paneCount >= MAX_CANVAS_PANES}
                onSplit={(axis) => props.onSplitPane(pane.id, axis)}
              />
            ) : null}
            {paneCount > 1 ? (
              <button
                type="button"
                className="inline-flex h-6 w-6 items-center justify-center rounded-md text-[var(--app-hint)] transition-colors hover:bg-[var(--app-bg)] hover:text-[var(--app-fg)]"
                onClick={(event) => {
                  event.stopPropagation();
                  props.onToggleMaximize(pane.id);
                }}
                aria-label={props.maximizedPaneId === pane.id ? "Restore panes" : "Maximize pane"}
                title={props.maximizedPaneId === pane.id ? "Restore panes" : "Maximize pane"}
              >
                {props.maximizedPaneId === pane.id ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
              </button>
            ) : null}
            {paneCount > 1 ? (
              <button
                type="button"
                className="inline-flex h-6 w-6 items-center justify-center rounded-md text-[var(--app-hint)] transition-colors hover:bg-[var(--app-bg)] hover:text-[var(--app-fg)]"
                onClick={(event) => {
                  event.stopPropagation();
                  props.onRemovePane(pane.id);
                }}
                aria-label="Remove pane"
                title="Remove pane"
              >
                <Minus size={13} />
              </button>
            ) : null}
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-hidden">{props.renderPane(pane.id)}</div>
      </div>
      {pane.active ? (
        <div className="pointer-events-none absolute inset-0 z-[20] rounded-lg ring-1 ring-inset ring-sky-400/70" />
      ) : null}
    </section>
  );

  const renderLayout = (layout: CanvasLayoutNode): ReactNode => {
    if (layout.kind === "pane") {
      const pane = panesById.get(layout.paneId);
      return pane ? renderFrame(pane) : null;
    }
    const horizontal = layout.axis === "horizontal";
    return (
      <div
        key={layout.id}
        data-canvas-split-id={layout.id}
        data-canvas-split-axis={layout.axis}
        className={`flex h-full w-full min-h-0 min-w-0 flex-1 ${horizontal ? "flex-row" : "flex-col"}`}
      >
        <div
          className="flex min-h-0 min-w-0"
          style={{ flex: `${layout.ratio} 1 0` }}
        >
          {renderLayout(layout.first)}
        </div>
        <div
          className={`group relative z-[2] shrink-0 touch-none ${
            horizontal ? "w-2 cursor-col-resize" : "h-2 cursor-row-resize"
          }`}
          onPointerDown={(event) =>
            startSplitResize(layout.id, layout.axis, layout.ratio, event)
          }
          title={horizontal ? "Drag to resize columns" : "Drag to resize rows"}
        >
          {(splitJunctions.get(layout.id) ?? [{ position: 0.5 }]).map((junction, index) => (
            <CanvasDividerMarker
              key={`${layout.id}:${index}`}
              axis={layout.axis}
              position={junction.position}
              {...("directions" in junction ? { directions: junction.directions } : {})}
            />
          ))}
        </div>
        <div
          className="flex min-h-0 min-w-0"
          style={{ flex: `${1 - layout.ratio} 1 0` }}
        >
          {renderLayout(layout.second)}
        </div>
      </div>
    );
  };

  const selectGrid = (dimensions: CanvasGridDimensions) => {
    props.onLayoutChange(createCanvasGridLayout(dimensions.columns, dimensions.rows));
  };

  return (
    <div
      data-canvas-pane-count={paneCount}
      className="flex h-full min-h-0 flex-1 flex-col bg-[var(--app-bg)]"
    >
      <ConversationHeader
        sidebarOpen={props.sidebarOpen}
        showLeftSidebarControls={props.showLeftSidebarControls}
        onOpenLeft={props.onOpenLeft}
        onExpandSidebar={props.onExpandSidebar}
        backgroundClassName="bg-[var(--app-bg)]/85"
        presentation="page"
        identity={<Grid2X2 size={18} strokeWidth={1.7} aria-hidden="true" />}
        title="Canvas"
        titleText="Canvas"
        actions={
          <>
            <div className={HEADER_SEGMENTED_CONTROL_CLASS}>
              {layoutOptions.map((layout) => {
                const Icon = layout.icon;
                return (
                  <button
                    key={layout.id}
                    type="button"
                    className={`${HEADER_SEGMENTED_BUTTON_BASE_CLASS} gap-1 max-[699px]:gap-0 ${
                      activePreset === layout.id && !props.maximizedPaneId
                        ? HEADER_SEGMENTED_BUTTON_ACTIVE_CLASS
                        : HEADER_SEGMENTED_BUTTON_INACTIVE_CLASS
                    }`}
                    onClick={() => props.onLayoutChange(createCanvasPresetLayout(layout.id))}
                    title={layout.title}
                  >
                    <Icon size={14} />
                    <span className={`${HEADER_SEGMENTED_LABEL_CLASS} max-[699px]:hidden`}>
                      {layout.label}
                    </span>
                  </button>
                );
              })}
            </div>
            {!props.layoutEditingDisabled ? (
              <CanvasLayoutDesigner layout={props.layout} onSelect={selectGrid} />
            ) : null}
            <button
              type="button"
              className={HEADER_ICON_BUTTON_CLASS}
              onClick={props.onClearAllPanes}
              disabled={props.clearAllPanesDisabled}
              aria-label="Clear all canvas panes"
              title="Clear all panes"
            >
              <Eraser size={HEADER_ACTION_ICON_SIZE} aria-hidden="true" />
            </button>
          </>
        }
        closeAction={{
          ariaLabel: "Close canvas view",
          title: "Close canvas view",
          label: "Close",
          onClick: props.onExitCanvas,
        }}
      />

      <div className="flex min-h-0 flex-1 overflow-hidden p-2 max-[699px]:p-1">
        {props.maximizedPaneId && props.panes[0]
          ? renderFrame(props.panes[0])
          : renderLayout(props.layout)}
      </div>
    </div>
  );
}

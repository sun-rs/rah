import { useRef } from "react";
import type { ReactNode, PointerEvent as ReactPointerEvent } from "react";
import { Columns2, Columns3, Eraser, EyeOff, Grid2X2, Maximize2, Menu, Minimize2, Rows2 } from "lucide-react";

export type CanvasPaneView = {
  id: string;
  label: string;
  active: boolean;
  clearable: boolean;
};

export type CanvasLayout = "two-horizontal" | "two-vertical" | "three-horizontal" | "four-grid";

const LAYOUT_OPTIONS: Array<{
  id: CanvasLayout;
  label: string;
  title: string;
  icon: typeof Columns2;
}> = [
  { id: "two-horizontal", label: "2", title: "Two panes side by side", icon: Columns2 },
  { id: "two-vertical", label: "2", title: "Two panes stacked", icon: Rows2 },
  { id: "three-horizontal", label: "3", title: "Three panes", icon: Columns3 },
  { id: "four-grid", label: "4", title: "Four panes", icon: Grid2X2 },
];

export function CanvasWorkbench(props: {
  panes: CanvasPaneView[];
  layout: CanvasLayout;
  maximizedPaneId: string | null;
  ratios: number[];
  sidebarOpen: boolean;
  onLayoutChange: (layout: CanvasLayout) => void;
  onResizeRatios: (ratios: number[]) => void;
  onExpandSidebar: () => void;
  onActivatePane: (paneId: string) => void;
  onToggleMaximize: (paneId: string) => void;
  onClearPane: (paneId: string) => void;
  onExitCanvas: () => void;
  onDropSession: (paneId: string, sessionId: string) => void;
  renderPaneToolbar: (paneId: string) => ReactNode;
  renderPane: (paneId: string) => ReactNode;
}) {
  const linearRef = useRef<HTMLDivElement | null>(null);
  const gridRef = useRef<HTMLDivElement | null>(null);

  const startLinearResize = (
    axis: "column" | "row",
    dividerIndex: number,
    event: ReactPointerEvent<HTMLDivElement>,
  ) => {
    if (props.layout === "four-grid" || props.maximizedPaneId) return;
    const container = linearRef.current;
    if (!container) return;

    event.preventDefault();
    const rect = container.getBoundingClientRect();
    const startX = event.clientX;
    const startY = event.clientY;
    const startRatios = [...props.ratios];

    const onPointerMove = (moveEvent: PointerEvent) => {
      const totalPair = startRatios[dividerIndex]! + startRatios[dividerIndex + 1]!;
      const basis = axis === "column" ? rect.width : rect.height;
      const deltaPixels =
        axis === "column" ? moveEvent.clientX - startX : moveEvent.clientY - startY;
      const deltaUnits = (deltaPixels / Math.max(basis, 1)) * props.panes.length;
      const min = 0.28;
      const nextLeft = Math.max(min, Math.min(totalPair - min, startRatios[dividerIndex]! + deltaUnits));
      const next = [...startRatios];
      next[dividerIndex] = nextLeft;
      next[dividerIndex + 1] = totalPair - nextLeft;
      props.onResizeRatios(next);
    };

    const onPointerUp = () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
    };

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp, { once: true });
  };

  const startGridResize = (
    axis: "column" | "row",
    event: ReactPointerEvent<HTMLDivElement>,
  ) => {
    if (props.layout !== "four-grid" || props.maximizedPaneId) return;
    const container = gridRef.current;
    if (!container) return;

    event.preventDefault();
    const rect = container.getBoundingClientRect();
    const startX = event.clientX;
    const startY = event.clientY;
    const startRatios = [...props.ratios];
    const firstIndex = axis === "column" ? 0 : 2;
    const secondIndex = axis === "column" ? 1 : 3;

    const onPointerMove = (moveEvent: PointerEvent) => {
      const totalPair =
        (startRatios[firstIndex] ?? 1) + (startRatios[secondIndex] ?? 1);
      const deltaPixels =
        axis === "column" ? moveEvent.clientX - startX : moveEvent.clientY - startY;
      const basis = axis === "column" ? rect.width : rect.height;
      const deltaUnits = (deltaPixels / Math.max(basis, 1)) * 2;
      const min = 0.35;
      const nextFirst = Math.max(
        min,
        Math.min(totalPair - min, (startRatios[firstIndex] ?? 1) + deltaUnits),
      );
      const next = [...startRatios];
      next[firstIndex] = nextFirst;
      next[secondIndex] = totalPair - nextFirst;
      props.onResizeRatios(next);
    };

    const onPointerUp = () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
    };

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp, { once: true });
  };

  const renderFrame = (pane: CanvasPaneView) => (
    <section
      key={pane.id}
      className={`min-h-0 min-w-0 flex-1 overflow-hidden rounded-xl border bg-[var(--app-bg)] shadow-sm transition-colors ${
        pane.active
          ? "border-primary/60 ring-1 ring-primary/30"
          : "border-[var(--app-border)]"
      }`}
      onClick={() => props.onActivatePane(pane.id)}
      onDragOver={(event) => {
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
      }}
      onDrop={(event) => {
        event.preventDefault();
        const sessionId = event.dataTransfer.getData("application/x-rah-session-id");
        if (sessionId) {
          props.onDropSession(pane.id, sessionId);
        }
      }}
    >
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex h-9 shrink-0 items-center justify-between gap-2 border-b border-[var(--app-border)] bg-[var(--app-subtle-bg)] px-2">
          <button
            type="button"
            className="min-w-0 flex-1 truncate text-left text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--app-hint)]"
            onClick={() => props.onActivatePane(pane.id)}
          >
            {pane.label}
          </button>
          <div className="flex shrink-0 items-center gap-1">
            {props.renderPaneToolbar(pane.id)}
            <button
              type="button"
              className="inline-flex h-7 w-7 items-center justify-center rounded-md text-[var(--app-hint)] transition-colors hover:bg-[var(--app-bg)] hover:text-[var(--app-fg)]"
              onClick={(event) => {
                event.stopPropagation();
                props.onToggleMaximize(pane.id);
              }}
              aria-label={props.maximizedPaneId === pane.id ? "Restore panes" : "Maximize pane"}
              title={props.maximizedPaneId === pane.id ? "Restore panes" : "Maximize pane"}
            >
              {props.maximizedPaneId === pane.id ? (
                <Minimize2 size={14} />
              ) : (
                <Maximize2 size={14} />
              )}
            </button>
            {pane.clearable ? (
            <button
              type="button"
              className="inline-flex h-7 w-7 items-center justify-center rounded-md text-[var(--app-hint)] transition-colors hover:bg-[var(--app-bg)] hover:text-[var(--app-fg)]"
              onClick={(event) => {
                event.stopPropagation();
                props.onClearPane(pane.id);
              }}
              aria-label="Clear pane content"
              title="Clear pane content"
            >
              <Eraser size={14} />
            </button>
            ) : null}
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-hidden">{props.renderPane(pane.id)}</div>
      </div>
    </section>
  );

  return (
    <div className="hidden h-full min-h-0 flex-1 flex-col bg-[var(--app-bg)] min-[700px]:flex">
      <header className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-[var(--app-border)] bg-[var(--app-bg)]/85 px-4 backdrop-blur-sm">
        <div className="flex min-w-0 items-center gap-2">
          {!props.sidebarOpen ? (
            <button
              type="button"
              className="hidden h-7 w-7 shrink-0 items-center justify-center rounded-md text-[var(--app-hint)] transition-colors hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)] min-[700px]:inline-flex"
              onClick={props.onExpandSidebar}
              aria-label="Expand sidebar"
              title="Expand sidebar"
            >
              <Menu size={16} />
            </button>
          ) : null}
          <div className="min-w-0">
            <div className="text-sm font-semibold text-[var(--app-fg)]">Canvas</div>
            <div className="truncate text-xs text-[var(--app-hint)]">
              Split sessions. Hide without closing live work.
            </div>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <div className="flex items-center gap-1 rounded-lg border border-[var(--app-border)] bg-[var(--app-subtle-bg)] p-1">
            {LAYOUT_OPTIONS.map((layout) => {
              const Icon = layout.icon;
              return (
              <button
                key={layout.id}
                type="button"
                className={`inline-flex h-8 items-center gap-1 rounded-md px-2 text-xs font-medium transition-colors ${
                  props.layout === layout.id && !props.maximizedPaneId
                    ? "bg-[var(--app-bg)] text-[var(--app-fg)] shadow-sm"
                    : "text-[var(--app-hint)] hover:text-[var(--app-fg)]"
                }`}
                onClick={() => props.onLayoutChange(layout.id)}
                title={layout.title}
              >
                <Icon size={14} />
                <span>{layout.label}</span>
              </button>
              );
            })}
          </div>
          <button
            type="button"
            className="inline-flex h-9 items-center gap-2 rounded-lg border border-[var(--app-border)] px-3 text-xs font-medium text-[var(--app-hint)] transition-colors hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)]"
            onClick={props.onExitCanvas}
            title="Hide canvas"
          >
            <EyeOff size={14} />
            Hide
          </button>
        </div>
      </header>

      <div className="min-h-0 flex-1 p-3">
        {props.maximizedPaneId ? (
          <div className="flex h-full min-h-0">
            {props.panes[0] ? renderFrame(props.panes[0]) : null}
          </div>
        ) : props.layout === "four-grid" ? (
          <div
            ref={gridRef}
            className="grid h-full min-h-0"
            style={{
              gridTemplateColumns: `${props.ratios[0] ?? 1}fr 0.75rem ${props.ratios[1] ?? 1}fr`,
              gridTemplateRows: `${props.ratios[2] ?? 1}fr 0.75rem ${props.ratios[3] ?? 1}fr`,
            }}
          >
            <div className="flex min-h-0 min-w-0" style={{ gridColumn: 1, gridRow: 1 }}>
              {props.panes[0] ? renderFrame(props.panes[0]) : null}
            </div>
            <div
              className="group flex cursor-col-resize items-center justify-center"
              style={{ gridColumn: 2, gridRow: "1 / 4" }}
              onPointerDown={(event) => startGridResize("column", event)}
              title="Drag to resize columns"
            >
              <div className="h-16 w-1 rounded-full bg-[var(--app-border)] transition-colors group-hover:bg-primary/50" />
            </div>
            <div className="flex min-h-0 min-w-0" style={{ gridColumn: 3, gridRow: 1 }}>
              {props.panes[1] ? renderFrame(props.panes[1]) : null}
            </div>
            <div
              className="group flex cursor-row-resize items-center justify-center"
              style={{ gridColumn: "1 / 4", gridRow: 2 }}
              onPointerDown={(event) => startGridResize("row", event)}
              title="Drag to resize rows"
            >
              <div className="h-1 w-16 rounded-full bg-[var(--app-border)] transition-colors group-hover:bg-primary/50" />
            </div>
            <div className="flex min-h-0 min-w-0" style={{ gridColumn: 1, gridRow: 3 }}>
              {props.panes[2] ? renderFrame(props.panes[2]) : null}
            </div>
            <div className="flex min-h-0 min-w-0" style={{ gridColumn: 3, gridRow: 3 }}>
              {props.panes[3] ? renderFrame(props.panes[3]) : null}
            </div>
          </div>
        ) : props.layout === "two-vertical" ? (
          <div ref={linearRef} className="flex h-full min-h-0 flex-col">
            {props.panes.map((pane, index) => (
              <div key={pane.id} className="flex min-h-0 flex-col" style={{ flex: `${props.ratios[index] ?? 1} 1 0` }}>
                {renderFrame(pane)}
                {index < props.panes.length - 1 ? (
                  <div
                    className="group flex h-3 shrink-0 cursor-row-resize items-center justify-center"
                    onPointerDown={(event) => startLinearResize("row", index, event)}
                    title="Drag to resize"
                  >
                    <div className="h-1 w-16 rounded-full bg-[var(--app-border)] transition-colors group-hover:bg-primary/50" />
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        ) : (
          <div ref={linearRef} className="flex h-full min-h-0">
            {props.panes.map((pane, index) => (
              <div key={pane.id} className="flex min-w-0" style={{ flex: `${props.ratios[index] ?? 1} 1 0` }}>
                {renderFrame(pane)}
                {index < props.panes.length - 1 ? (
                  <div
                    className="group flex w-3 shrink-0 cursor-col-resize items-center justify-center"
                    onPointerDown={(event) => startLinearResize("column", index, event)}
                    title="Drag to resize"
                  >
                    <div className="h-16 w-1 rounded-full bg-[var(--app-border)] transition-colors group-hover:bg-primary/50" />
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

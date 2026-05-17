import { SquareTerminal } from "lucide-react";
import type { InspectorTab } from "./shared";

export function InspectorHeader(props: {
  workspaceRoot: string;
  activeTab: InspectorTab;
  changeCount: number;
  onTabChange: (tab: InspectorTab) => void;
  onOpenTerminal?: () => void;
}) {
  return (
    <>
      <div className="flex h-14 shrink-0 items-center gap-3 border-b border-[var(--app-border)] px-4 pr-14">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-[var(--app-fg)]">Inspector</div>
          <div className="truncate text-xs text-[var(--app-hint)]" title={props.workspaceRoot}>
            {props.workspaceRoot}
          </div>
        </div>
        {props.onOpenTerminal ? (
          <button
            type="button"
            className="icon-click-feedback inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-[var(--app-hint)] transition-colors hover:bg-[var(--app-bg)] hover:text-[var(--app-fg)]"
            onClick={props.onOpenTerminal}
            aria-label="Open terminal"
            title="Open terminal"
          >
            <SquareTerminal size={16} />
          </button>
        ) : null}
      </div>
      <div className="shrink-0 px-3 py-2">
        <div className="overflow-x-auto rah-scroll-panel scrollbar-stable">
          <div className="grid min-w-full grid-cols-2 gap-2 rounded-lg bg-[var(--app-subtle-bg)] p-1">
            <button
              type="button"
              className={`min-w-[5.5rem] overflow-hidden rounded-md px-3 py-2 text-sm font-medium text-ellipsis whitespace-nowrap transition-colors ${
                props.activeTab === "changes"
                  ? "bg-[var(--app-bg)] text-[var(--app-fg)] shadow-sm"
                  : "text-[var(--app-hint)] hover:text-[var(--app-fg)]"
              }`}
              onClick={() => props.onTabChange("changes")}
            >
              Changes {props.changeCount > 0 ? `(${props.changeCount})` : ""}
            </button>
            <button
              type="button"
              className={`min-w-[5.5rem] overflow-hidden rounded-md px-3 py-2 text-sm font-medium text-ellipsis whitespace-nowrap transition-colors ${
                props.activeTab === "files"
                  ? "bg-[var(--app-bg)] text-[var(--app-fg)] shadow-sm"
                  : "text-[var(--app-hint)] hover:text-[var(--app-fg)]"
              }`}
              onClick={() => props.onTabChange("files")}
            >
              Files
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

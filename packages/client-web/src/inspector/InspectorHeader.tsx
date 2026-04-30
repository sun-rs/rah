import { SquareTerminal } from "lucide-react";
import type { InspectorTab } from "./shared";

export function InspectorHeader(props: {
  workspaceRoot: string;
  activeTab: InspectorTab;
  changeCount: number;
  eventCount: number;
  hasSession: boolean;
  onTabChange: (tab: InspectorTab) => void;
  onOpenTerminal?: () => void;
}) {
  return (
    <>
      <div className="h-14 shrink-0 px-4 pr-12 flex items-center justify-between">
        <div className="min-w-0">
          <div className="text-sm font-medium text-[var(--app-fg)]">Inspector</div>
          <div className="truncate text-xs text-[var(--app-hint)]">{props.workspaceRoot}</div>
        </div>
        <div className="flex items-center gap-1">
          {props.onOpenTerminal ? (
            <button
              type="button"
              className="inline-flex h-7 w-7 items-center justify-center rounded-md text-[var(--app-hint)] transition-colors hover:bg-[var(--app-bg)] hover:text-[var(--app-fg)]"
              onClick={props.onOpenTerminal}
              aria-label="Open terminal"
              title="Open terminal"
            >
              <SquareTerminal size={16} />
            </button>
          ) : null}
        </div>
      </div>
      <div className="shrink-0 px-3 py-2">
        <div className="overflow-x-auto custom-scrollbar scrollbar-stable">
          <div className="inline-flex min-w-full items-center gap-0.5 rounded-lg bg-[var(--app-bg)] p-0.5">
            <button
              type="button"
              className={`min-w-[5.5rem] flex-1 overflow-hidden rounded-md px-2 py-1 text-xs font-medium text-ellipsis whitespace-nowrap transition-colors ${
                props.activeTab === "changes"
                  ? "bg-[var(--app-subtle-bg)] text-[var(--app-fg)]"
                  : "text-[var(--app-hint)] hover:bg-[var(--app-subtle-bg)]/50 hover:text-[var(--app-fg)]"
              }`}
              onClick={() => props.onTabChange("changes")}
            >
              Changes {props.changeCount > 0 ? `(${props.changeCount})` : ""}
            </button>
            <button
              type="button"
              className={`min-w-[5.5rem] flex-1 overflow-hidden rounded-md px-2 py-1 text-xs font-medium text-ellipsis whitespace-nowrap transition-colors ${
                props.activeTab === "files"
                  ? "bg-[var(--app-subtle-bg)] text-[var(--app-fg)]"
                  : "text-[var(--app-hint)] hover:bg-[var(--app-subtle-bg)]/50 hover:text-[var(--app-fg)]"
              }`}
              onClick={() => props.onTabChange("files")}
            >
              Files
            </button>
            {props.hasSession ? (
              <button
                type="button"
                className={`min-w-[5.5rem] flex-1 overflow-hidden rounded-md px-2 py-1 text-xs font-medium text-ellipsis whitespace-nowrap transition-colors ${
                  props.activeTab === "events"
                    ? "bg-[var(--app-subtle-bg)] text-[var(--app-fg)]"
                    : "text-[var(--app-hint)] hover:bg-[var(--app-subtle-bg)]/50 hover:text-[var(--app-fg)]"
                }`}
                onClick={() => props.onTabChange("events")}
              >
                Events {props.eventCount > 0 ? `(${props.eventCount})` : ""}
              </button>
            ) : null}
          </div>
        </div>
      </div>
    </>
  );
}

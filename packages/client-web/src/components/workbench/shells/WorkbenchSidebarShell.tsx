import type { PointerEvent as ReactPointerEvent, ReactNode } from "react";
import type { SessionSummary, StoredSessionRef } from "@rah/runtime-protocol";
import { DesktopWorkbenchSidebarHeader } from "../actions/DesktopWorkbenchSidebarHeader";
import { MobileWorkbenchHeaderActions } from "../actions/MobileWorkbenchHeaderActions";
import { Sheet } from "../../Sheet";
import type { WorkspaceSortMode } from "../../../session-browser";

export function WorkbenchSidebarShell(props: {
  sidebarOpen: boolean;
  sidebarWidth: number;
  isResizing: boolean;
  leftOpen: boolean;
  onLeftOpenChange: (open: boolean) => void;
  onResizeStart: (event: ReactPointerEvent<HTMLDivElement>) => void;
  sidebarContent: ReactNode;
  storedSessions: StoredSessionRef[];
  recentSessions: StoredSessionRef[];
  liveSessions: SessionSummary[];
  workspaceSortMode: WorkspaceSortMode;
  onWorkspaceSortModeChange: (value: WorkspaceSortMode) => void;
  onDesktopHome: () => void;
  onMobileHome: () => void;
  onActivateHistory: (ref: StoredSessionRef) => void;
  onRemoveHistorySession: (session: Pick<StoredSessionRef, "provider" | "providerSessionId">) => void;
  onRemoveHistoryWorkspace: (workspaceDir: string) => void;
  onOpenSettings: () => void;
  onCollapseSidebar: () => void;
}) {
  return (
    <>
      <aside
        className="hidden md:flex flex-col bg-[var(--app-subtle-bg)] shrink-0 transition-[width] duration-200 overflow-hidden"
        style={{ width: props.sidebarOpen ? props.sidebarWidth : 0 }}
      >
        <div className="h-14 px-4 flex items-center justify-between shrink-0">
          {props.sidebarOpen ? (
            <DesktopWorkbenchSidebarHeader
              storedSessions={props.storedSessions}
              recentSessions={props.recentSessions}
              liveSessions={props.liveSessions}
              workspaceSortMode={props.workspaceSortMode}
              onWorkspaceSortModeChange={props.onWorkspaceSortModeChange}
              onHome={props.onDesktopHome}
              onActivateHistory={props.onActivateHistory}
              onRemoveHistorySession={props.onRemoveHistorySession}
              onRemoveHistoryWorkspace={props.onRemoveHistoryWorkspace}
              onOpenSettings={props.onOpenSettings}
              onCollapseSidebar={props.onCollapseSidebar}
            />
          ) : null}
        </div>
        <div className="flex-1 overflow-y-auto custom-scrollbar p-3">{props.sidebarContent}</div>
      </aside>

      {props.sidebarOpen ? (
        <div
          className={`hidden md:block resize-handle ${props.isResizing ? "dragging" : ""}`}
          onPointerDown={props.onResizeStart}
        />
      ) : null}

      <Sheet
        open={props.leftOpen}
        onOpenChange={props.onLeftOpenChange}
        side="left"
        title="Workbench"
        headerRight={
          <MobileWorkbenchHeaderActions
            storedSessions={props.storedSessions}
            recentSessions={props.recentSessions}
            liveSessions={props.liveSessions}
            workspaceSortMode={props.workspaceSortMode}
            onWorkspaceSortModeChange={props.onWorkspaceSortModeChange}
            onHome={props.onMobileHome}
            onActivateHistory={props.onActivateHistory}
            onRemoveHistorySession={props.onRemoveHistorySession}
            onRemoveHistoryWorkspace={props.onRemoveHistoryWorkspace}
            onOpenSettings={props.onOpenSettings}
          />
        }
      >
        <div className="p-3">{props.sidebarContent}</div>
      </Sheet>
    </>
  );
}

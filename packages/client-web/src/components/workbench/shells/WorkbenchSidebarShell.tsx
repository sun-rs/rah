import { type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import type { CouncilRoomSnapshot, SessionSummary, StoredSessionRef } from "@rah/runtime-protocol";
import { DesktopWorkbenchSidebarHeader } from "../actions/DesktopWorkbenchSidebarHeader";
import { MobileWorkbenchHeaderActions } from "../actions/MobileWorkbenchHeaderActions";
import { Sheet } from "../../Sheet";
import { OverlayScrollArea } from "../../OverlayScrollArea";
import { SIDEBAR_LAYOUT } from "../../../sidebar-layout-contract";
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
  runningSessions: SessionSummary[];
  councilRooms: readonly CouncilRoomSnapshot[];
  selectedCouncilRoomId?: string | null | undefined;
  workspaceSortMode: WorkspaceSortMode;
  onWorkspaceSortModeChange: (value: WorkspaceSortMode) => void;
  canvasActive: boolean;
  councilActive: boolean;
  mobileCanvasEnabled: boolean;
  onOpenCouncil: () => void;
  onDesktopToggleCanvas: () => void;
  onMobileToggleCanvas: () => void;
  onActivateHistory: (ref: StoredSessionRef) => void;
  onActivateRunning: (sessionId: string) => void;
  onActivateCouncilRoom: (roomId: string) => void;
  onRefreshCouncilRooms: () => void | Promise<void>;
  onRemoveCouncilRoom: (roomId: string) => void | Promise<void>;
  onRemoveHistorySession: (session: Pick<StoredSessionRef, "provider" | "providerSessionId">) => void;
  onRemoveHistoryWorkspace: (workspaceDir: string) => void;
  onHome: () => void;
  onOpenSettings: () => void;
  onCollapseSidebar: () => void;
}) {
  return (
    <>
      <aside
        className="hidden md:flex flex-col bg-[var(--app-subtle-bg)] shrink-0 transition-[width] duration-200 overflow-hidden"
        style={{ width: props.sidebarOpen ? props.sidebarWidth : 0 }}
      >
        <div className="h-14 pl-4 pr-2 flex items-center gap-4 shrink-0">
          {props.sidebarOpen ? (
            <DesktopWorkbenchSidebarHeader
              storedSessions={props.storedSessions}
              recentSessions={props.recentSessions}
              runningSessions={props.runningSessions}
              councilRooms={props.councilRooms}
              selectedCouncilRoomId={props.selectedCouncilRoomId}
              workspaceSortMode={props.workspaceSortMode}
              onWorkspaceSortModeChange={props.onWorkspaceSortModeChange}
              canvasActive={props.canvasActive}
              councilActive={props.councilActive}
              onOpenCouncil={props.onOpenCouncil}
              onToggleCanvas={props.onDesktopToggleCanvas}
              onActivateHistory={props.onActivateHistory}
              onActivateRunning={props.onActivateRunning}
              onActivateCouncilRoom={props.onActivateCouncilRoom}
              onRefreshCouncilRooms={props.onRefreshCouncilRooms}
              onRemoveCouncilRoom={props.onRemoveCouncilRoom}
              onRemoveHistorySession={props.onRemoveHistorySession}
              onRemoveHistoryWorkspace={props.onRemoveHistoryWorkspace}
              onHome={props.onHome}
              onOpenSettings={props.onOpenSettings}
              onCollapseSidebar={props.onCollapseSidebar}
            />
          ) : null}
        </div>
        <OverlayScrollArea
          className={SIDEBAR_LAYOUT.sidebarScrollShellClassName}
          viewportClassName={SIDEBAR_LAYOUT.sidebarScrollClassName}
          trackClassName={SIDEBAR_LAYOUT.sidebarScrollTrackClassName}
          thumbClassName={SIDEBAR_LAYOUT.sidebarScrollThumbClassName}
        >
          {props.sidebarContent}
        </OverlayScrollArea>
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
        title={
          <button
            type="button"
            onClick={props.onHome}
            className="icon-click-feedback rounded-md px-1 text-sm font-semibold text-[var(--app-fg)] transition-colors hover:bg-[var(--app-bg)]"
            aria-label="Home"
            title="Home"
          >
            RAH
          </button>
        }
        headerRight={
          <MobileWorkbenchHeaderActions
            storedSessions={props.storedSessions}
            recentSessions={props.recentSessions}
            runningSessions={props.runningSessions}
            councilRooms={props.councilRooms}
            selectedCouncilRoomId={props.selectedCouncilRoomId}
            workspaceSortMode={props.workspaceSortMode}
            onWorkspaceSortModeChange={props.onWorkspaceSortModeChange}
            canvasActive={props.canvasActive}
            councilActive={props.councilActive}
            canvasEnabled={props.mobileCanvasEnabled}
            onOpenCouncil={props.onOpenCouncil}
            onToggleCanvas={props.onMobileToggleCanvas}
            onActivateHistory={props.onActivateHistory}
            onActivateRunning={props.onActivateRunning}
            onActivateCouncilRoom={props.onActivateCouncilRoom}
            onRefreshCouncilRooms={props.onRefreshCouncilRooms}
            onRemoveCouncilRoom={props.onRemoveCouncilRoom}
            onRemoveHistorySession={props.onRemoveHistorySession}
            onRemoveHistoryWorkspace={props.onRemoveHistoryWorkspace}
            onOpenSettings={props.onOpenSettings}
          />
        }
      >
        <div className={SIDEBAR_LAYOUT.sidebarSheetContentClassName}>{props.sidebarContent}</div>
      </Sheet>
    </>
  );
}

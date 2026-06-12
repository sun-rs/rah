import { type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import type { CouncilSnapshot, SessionSummary, StoredSessionRef } from "@rah/runtime-protocol";
import { House, Menu } from "lucide-react";
import { DesktopWorkbenchSidebarHeader } from "../actions/DesktopWorkbenchSidebarHeader";
import { MobileWorkbenchHeaderActions } from "../actions/MobileWorkbenchHeaderActions";
import { Sheet } from "../../Sheet";
import { OverlayScrollArea } from "../../OverlayScrollArea";
import { SIDEBAR_LAYOUT } from "../../../sidebar-layout-contract";
import type { WorkspaceSortMode } from "../../../session-browser";
import {
  HEADER_EDGE_TOGGLE_BUTTON_CLASS,
  HEADER_EDGE_TOGGLE_ICON_SIZE,
} from "../header-button-styles";

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
  runningSessionActivityAtById?: ReadonlyMap<string, string> | undefined;
  councils: readonly CouncilSnapshot[];
  selectedCouncilId?: string | null | undefined;
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
  onActivateCouncil: (councilId: string) => void;
  onLoadStoredSessions: () => void | Promise<void>;
  onRefreshCouncils: () => void | Promise<void>;
  onRenameCouncil: (council: CouncilSnapshot) => void;
  onRemoveCouncil: (councilId: string) => void | Promise<void>;
  onRemoveHistorySession: (session: Pick<StoredSessionRef, "provider" | "providerSessionId">) => void;
  onRemoveHistoryWorkspace: (workspaceDir: string, sessions: readonly StoredSessionRef[]) => void;
  onHome: () => void;
  onOpenSettings: () => void;
  onCollapseSidebar: () => void;
}) {
  return (
    <>
      <aside
        className={`hidden md:flex flex-col bg-[var(--app-subtle-bg)] shrink-0 transition-[width] ${
          props.isResizing ? "duration-0" : "duration-200"
        } overflow-hidden`}
        style={{
          width: props.sidebarOpen ? `var(--rah-sidebar-width, ${props.sidebarWidth}px)` : 0,
        }}
      >
        <div className="rah-sidebar-header h-14 px-2 flex min-w-0 items-center shrink-0">
          {props.sidebarOpen ? (
            <>
              <button
                type="button"
                className={HEADER_EDGE_TOGGLE_BUTTON_CLASS}
                onClick={props.onCollapseSidebar}
                aria-label="Collapse sidebar"
                title="Collapse sidebar"
              >
                <Menu size={HEADER_EDGE_TOGGLE_ICON_SIZE} />
              </button>
              <DesktopWorkbenchSidebarHeader
                storedSessions={props.storedSessions}
                recentSessions={props.recentSessions}
                runningSessions={props.runningSessions}
                runningSessionActivityAtById={props.runningSessionActivityAtById}
                councils={props.councils}
                selectedCouncilId={props.selectedCouncilId}
                workspaceSortMode={props.workspaceSortMode}
                onWorkspaceSortModeChange={props.onWorkspaceSortModeChange}
                canvasActive={props.canvasActive}
                councilActive={props.councilActive}
                onOpenCouncil={props.onOpenCouncil}
                onToggleCanvas={props.onDesktopToggleCanvas}
                onActivateHistory={props.onActivateHistory}
                onActivateRunning={props.onActivateRunning}
                onActivateCouncil={props.onActivateCouncil}
                onLoadStoredSessions={props.onLoadStoredSessions}
                onRefreshCouncils={props.onRefreshCouncils}
                onRenameCouncil={props.onRenameCouncil}
                onRemoveCouncil={props.onRemoveCouncil}
                onRemoveHistorySession={props.onRemoveHistorySession}
                onRemoveHistoryWorkspace={props.onRemoveHistoryWorkspace}
                onHome={props.onHome}
                onOpenSettings={props.onOpenSettings}
              />
            </>
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
        headerLayout="inline"
        closePlacement="start"
        viewportClassName="md:hidden"
        title={
          <button
            type="button"
            onClick={props.onHome}
            className="icon-click-feedback inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-[var(--app-hint)] transition-colors hover:bg-[var(--app-bg)] hover:text-[var(--app-fg)]"
            aria-label="Home"
            title="Home"
          >
            <House size={17} />
          </button>
        }
        headerRight={
          <MobileWorkbenchHeaderActions
            storedSessions={props.storedSessions}
            recentSessions={props.recentSessions}
            runningSessions={props.runningSessions}
            runningSessionActivityAtById={props.runningSessionActivityAtById}
            councils={props.councils}
            selectedCouncilId={props.selectedCouncilId}
            workspaceSortMode={props.workspaceSortMode}
            onWorkspaceSortModeChange={props.onWorkspaceSortModeChange}
            canvasActive={props.canvasActive}
            councilActive={props.councilActive}
            canvasEnabled={props.mobileCanvasEnabled}
            onOpenCouncil={props.onOpenCouncil}
            onToggleCanvas={props.onMobileToggleCanvas}
            onActivateHistory={props.onActivateHistory}
            onActivateRunning={props.onActivateRunning}
            onActivateCouncil={props.onActivateCouncil}
            onLoadStoredSessions={props.onLoadStoredSessions}
            onRefreshCouncils={props.onRefreshCouncils}
            onRenameCouncil={props.onRenameCouncil}
            onRemoveCouncil={props.onRemoveCouncil}
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

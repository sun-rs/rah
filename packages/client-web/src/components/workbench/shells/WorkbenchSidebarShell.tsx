import { type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import type { CouncilSnapshot, SessionSummary, StoredSessionRef } from "@rah/runtime-protocol";
import { Menu } from "lucide-react";
import {
  WorkbenchSidebarNavigation,
  WorkbenchSidebarSettingsAction,
} from "../actions/WorkbenchSidebarNavigation";
import { Sheet } from "../../Sheet";
import { OverlayScrollArea } from "../../OverlayScrollArea";
import { SIDEBAR_LAYOUT } from "../../../sidebar-layout-contract";
import type { WorkspaceSortMode } from "../../../session-browser";
import {
  HEADER_EDGE_TOGGLE_BUTTON_BASE_CLASS,
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
  homeActive: boolean;
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
  onArchiveHistorySession: (session: Pick<StoredSessionRef, "provider" | "providerSessionId">) => void;
  onRestoreHistorySession: (session: Pick<StoredSessionRef, "provider" | "providerSessionId">) => void;
  onRemoveHistoryWorkspace: (workspaceDir: string, sessions: readonly StoredSessionRef[]) => void;
  onHome: () => void;
  onOpenSettings: () => void;
  onCollapseSidebar: () => void;
  onExpandSidebar: () => void;
}) {
  const commonNavigationProps = {
    storedSessions: props.storedSessions,
    recentSessions: props.recentSessions,
    runningSessions: props.runningSessions,
    runningSessionActivityAtById: props.runningSessionActivityAtById,
    councils: props.councils,
    selectedCouncilId: props.selectedCouncilId,
    workspaceSortMode: props.workspaceSortMode,
    onWorkspaceSortModeChange: props.onWorkspaceSortModeChange,
    homeActive: props.homeActive,
    canvasActive: props.canvasActive,
    councilActive: props.councilActive,
    onLoadStoredSessions: props.onLoadStoredSessions,
    onRefreshCouncils: props.onRefreshCouncils,
    onRenameCouncil: props.onRenameCouncil,
    onRemoveCouncil: props.onRemoveCouncil,
    onRemoveHistorySession: props.onRemoveHistorySession,
    onArchiveHistorySession: props.onArchiveHistorySession,
    onRestoreHistorySession: props.onRestoreHistorySession,
    onRemoveHistoryWorkspace: props.onRemoveHistoryWorkspace,
  };
  const closeMobileSidebar = () => props.onLeftOpenChange(false);
  const runMobileAction = (action: () => void) => {
    action();
    closeMobileSidebar();
  };

  return (
    <>
      <button
        type="button"
        className={`${HEADER_EDGE_TOGGLE_BUTTON_BASE_CLASS} fixed left-2 top-2 z-40 hidden md:inline-flex`}
        onClick={props.sidebarOpen ? props.onCollapseSidebar : props.onExpandSidebar}
        aria-label={props.sidebarOpen ? "Collapse sidebar" : "Expand sidebar"}
        title={props.sidebarOpen ? "Collapse sidebar" : "Expand sidebar"}
      >
        <Menu size={HEADER_EDGE_TOGGLE_ICON_SIZE} />
      </button>
      <aside
        data-sidebar-open={props.sidebarOpen ? "true" : "false"}
        className={`rah-workbench-sidebar hidden shrink-0 flex-col overflow-hidden md:flex ${
          props.isResizing ? "" : "transition-[width] duration-150 ease-out"
        }`}
        style={{
          width: props.sidebarOpen ? `var(--rah-sidebar-width, ${props.sidebarWidth}px)` : 0,
        }}
      >
        <div className="rah-sidebar-header flex h-12 min-w-0 shrink-0 items-center pl-12 pr-2">
          {props.sidebarOpen ? (
            <span className="truncate text-[13px] font-semibold text-[var(--app-fg)]">RAH</span>
          ) : null}
        </div>
        {props.sidebarOpen ? (
          <WorkbenchSidebarNavigation
            {...commonNavigationProps}
            onOpenCouncil={props.onOpenCouncil}
            onToggleCanvas={props.onDesktopToggleCanvas}
            onActivateHistory={props.onActivateHistory}
            onActivateRunning={props.onActivateRunning}
            onActivateCouncil={props.onActivateCouncil}
            onHome={props.onHome}
          />
        ) : null}
        <OverlayScrollArea
          className={SIDEBAR_LAYOUT.sidebarScrollShellClassName}
          viewportClassName={SIDEBAR_LAYOUT.sidebarScrollClassName}
          trackClassName={SIDEBAR_LAYOUT.sidebarScrollTrackClassName}
          thumbClassName={SIDEBAR_LAYOUT.sidebarScrollThumbClassName}
        >
          {props.sidebarContent}
        </OverlayScrollArea>
        {props.sidebarOpen ? (
          <WorkbenchSidebarSettingsAction onOpenSettings={props.onOpenSettings} />
        ) : null}
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
        viewportClassName="md:!hidden"
        title={<span>RAH</span>}
        bodyClassName="flex min-h-0 flex-1 flex-col overflow-hidden"
      >
        <WorkbenchSidebarNavigation
          {...commonNavigationProps}
          canvasEnabled={props.mobileCanvasEnabled}
          onOpenCouncil={() => runMobileAction(props.onOpenCouncil)}
          onToggleCanvas={() => runMobileAction(props.onMobileToggleCanvas)}
          onActivateHistory={(ref) => runMobileAction(() => props.onActivateHistory(ref))}
          onActivateRunning={(sessionId) =>
            runMobileAction(() => props.onActivateRunning(sessionId))
          }
          onActivateCouncil={(councilId) =>
            runMobileAction(() => props.onActivateCouncil(councilId))
          }
          onHome={() => runMobileAction(props.onHome)}
        />
        <div
          className={`min-h-0 flex-1 overflow-y-auto overscroll-y-contain rah-scroll-panel rah-scroll-panel-y ${SIDEBAR_LAYOUT.sidebarSheetContentClassName}`}
        >
          {props.sidebarContent}
        </div>
        <WorkbenchSidebarSettingsAction
          onOpenSettings={() => runMobileAction(props.onOpenSettings)}
        />
      </Sheet>
    </>
  );
}

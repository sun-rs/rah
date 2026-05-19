import type { CouncilRoomSnapshot, SessionSummary, StoredSessionRef } from "@rah/runtime-protocol";
import { Columns3, Menu, MessageCircleMore, Settings, UsersRound } from "lucide-react";
import { SessionHistoryDialog } from "../../SessionHistoryDialog";
import type { WorkspaceSortMode } from "../../../session-browser";

const headerButtonClassName =
  "icon-click-feedback inline-flex h-8 w-8 items-center justify-center rounded-md active:bg-[var(--app-bg)]";
const headerIconSize = 18;

export function DesktopWorkbenchSidebarHeader(props: {
  storedSessions: StoredSessionRef[];
  recentSessions: StoredSessionRef[];
  runningSessions: SessionSummary[];
  councilRooms: readonly CouncilRoomSnapshot[];
  selectedCouncilRoomId?: string | null | undefined;
  workspaceSortMode: WorkspaceSortMode;
  onWorkspaceSortModeChange: (value: WorkspaceSortMode) => void;
  canvasActive: boolean;
  councilActive: boolean;
  onOpenCouncil: () => void;
  onToggleCanvas: () => void;
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
      <button
        type="button"
        onClick={props.onHome}
        className="icon-click-feedback shrink-0 rounded-md px-1 text-lg font-semibold tracking-tight text-[var(--app-fg)] transition-colors hover:bg-[var(--app-bg)]"
        aria-label="Home"
        title="Home"
      >
        RAH
      </button>
      <div className="ml-auto flex shrink-0 items-center gap-0.5">
        <button
          type="button"
          className={`${headerButtonClassName} ${
            props.councilActive
              ? "bg-[var(--app-bg)] text-[var(--app-fg)]"
              : "text-[var(--app-hint)] hover:bg-[var(--app-bg)] hover:text-[var(--app-fg)]"
          }`}
          onClick={props.onOpenCouncil}
          aria-label={props.councilActive ? "Hide council" : "Open council"}
          title={props.councilActive ? "Hide council" : "Council"}
        >
          <UsersRound size={headerIconSize} />
        </button>
        <button
          type="button"
          className={`${headerButtonClassName} ${
            props.canvasActive
              ? "bg-[var(--app-bg)] text-[var(--app-fg)]"
              : "text-[var(--app-hint)] hover:bg-[var(--app-bg)] hover:text-[var(--app-fg)]"
          }`}
          onClick={props.onToggleCanvas}
          aria-label={props.canvasActive ? "Exit canvas" : "Open canvas"}
          title={props.canvasActive ? "Exit canvas" : "Canvas"}
        >
          <Columns3 size={headerIconSize} />
        </button>
        <SessionHistoryDialog
          storedSessions={props.storedSessions}
          recentSessions={props.recentSessions}
          runningSessions={props.runningSessions}
          councilRooms={props.councilRooms}
          selectedCouncilRoomId={props.selectedCouncilRoomId}
          workspaceSortMode={props.workspaceSortMode}
          onWorkspaceSortModeChange={props.onWorkspaceSortModeChange}
          onActivate={props.onActivateHistory}
          onActivateRunning={props.onActivateRunning}
          onActivateCouncilRoom={props.onActivateCouncilRoom}
          onRefreshCouncilRooms={props.onRefreshCouncilRooms}
          onRemoveCouncilRoom={props.onRemoveCouncilRoom}
          onRemoveSession={props.onRemoveHistorySession}
          onRemoveWorkspace={props.onRemoveHistoryWorkspace}
        >
          <button
            type="button"
            className={`${headerButtonClassName} text-[var(--app-hint)] hover:bg-[var(--app-bg)] hover:text-[var(--app-fg)]`}
            aria-label="Chats"
            title="Chats"
          >
            <MessageCircleMore size={headerIconSize} />
          </button>
        </SessionHistoryDialog>
        <button
          type="button"
          className={`${headerButtonClassName} text-[var(--app-hint)] hover:bg-[var(--app-bg)] hover:text-[var(--app-fg)]`}
          onClick={props.onOpenSettings}
          aria-label="Open settings"
          title="Settings"
        >
          <Settings size={headerIconSize} />
        </button>
        <button
          type="button"
          className={`${headerButtonClassName} text-[var(--app-hint)] hover:bg-[var(--app-bg)] hover:text-[var(--app-fg)]`}
          onClick={props.onCollapseSidebar}
          aria-label="Collapse sidebar"
          title="Collapse sidebar"
        >
          <Menu size={headerIconSize} />
        </button>
      </div>
    </>
  );
}

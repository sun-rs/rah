import type { CouncilSnapshot, SessionSummary, StoredSessionRef } from "@rah/runtime-protocol";
import { Columns3, MessageCircleMore, Settings, SquarePen } from "lucide-react";
import { SessionHistoryDialog } from "../../SessionHistoryDialog";
import { CouncilLogo } from "../../CouncilLogo";
import type { WorkspaceSortMode } from "../../../session-browser";

const NAV_ITEM_CLASS =
  "flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-[14px] font-medium text-[var(--app-fg)] transition-colors hover:bg-[var(--app-bg)]/60";
const NAV_ITEM_ACTIVE_CLASS =
  "bg-[color:color-mix(in_oklab,var(--app-bg)_76%,var(--app-border)_24%)]";
const NAV_ICON_CLASS = "inline-flex h-5 w-5 shrink-0 items-center justify-center";

export function WorkbenchSidebarNavigation(props: {
  storedSessions: StoredSessionRef[];
  recentSessions: StoredSessionRef[];
  runningSessions: SessionSummary[];
  runningSessionActivityAtById?: ReadonlyMap<string, string> | undefined;
  councils: readonly CouncilSnapshot[];
  selectedCouncilId?: string | null | undefined;
  workspaceSortMode: WorkspaceSortMode;
  onWorkspaceSortModeChange: (value: WorkspaceSortMode) => void;
  homeActive: boolean;
  canvasActive: boolean;
  councilActive: boolean;
  canvasEnabled?: boolean;
  onOpenCouncil: () => void;
  onToggleCanvas: () => void;
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
}) {
  const canvasEnabled = props.canvasEnabled ?? true;
  return (
    <nav className="shrink-0 space-y-0.5 px-2 pb-2" aria-label="Primary navigation">
      <button
        type="button"
        aria-label="New task"
        onClick={props.onHome}
        className={`${NAV_ITEM_CLASS} ${props.homeActive ? NAV_ITEM_ACTIVE_CLASS : ""}`}
      >
        <span className={NAV_ICON_CLASS}><SquarePen size={16} /></span>
        <span>New task</span>
      </button>
      <button
        type="button"
        aria-label="Council"
        className={`${NAV_ITEM_CLASS} ${props.councilActive ? NAV_ITEM_ACTIVE_CLASS : ""}`}
        onClick={props.onOpenCouncil}
      >
        <span className={NAV_ICON_CLASS}>
          <CouncilLogo className="h-4 w-4" tone="black" variant="bare" />
        </span>
        <span>Council</span>
      </button>
      <button
        type="button"
        aria-label="Canvas"
        className={`${NAV_ITEM_CLASS} ${props.canvasActive ? NAV_ITEM_ACTIVE_CLASS : ""} ${
          canvasEnabled ? "" : "cursor-not-allowed opacity-35 hover:bg-transparent"
        }`}
        onClick={canvasEnabled ? props.onToggleCanvas : undefined}
        disabled={!canvasEnabled}
        title={canvasEnabled ? undefined : "Canvas needs a wider screen"}
      >
        <span className={NAV_ICON_CLASS}><Columns3 size={16} /></span>
        <span>Canvas</span>
      </button>
      <SessionHistoryDialog
        storedSessions={props.storedSessions}
        recentSessions={props.recentSessions}
        runningSessions={props.runningSessions}
        runningSessionActivityAtById={props.runningSessionActivityAtById}
        councils={props.councils}
        selectedCouncilId={props.selectedCouncilId}
        workspaceSortMode={props.workspaceSortMode}
        onWorkspaceSortModeChange={props.onWorkspaceSortModeChange}
        onActivate={props.onActivateHistory}
        onActivateRunning={props.onActivateRunning}
        onActivateCouncil={props.onActivateCouncil}
        onLoadStoredSessions={props.onLoadStoredSessions}
        onRefreshCouncils={props.onRefreshCouncils}
        onRenameCouncil={props.onRenameCouncil}
        onRemoveCouncil={props.onRemoveCouncil}
        onRemoveSession={props.onRemoveHistorySession}
        onArchiveSession={props.onArchiveHistorySession}
        onRestoreSession={props.onRestoreHistorySession}
        onRemoveWorkspace={props.onRemoveHistoryWorkspace}
      >
        <button type="button" className={NAV_ITEM_CLASS} aria-label="Chats">
          <span className={NAV_ICON_CLASS}><MessageCircleMore size={16} /></span>
          <span>Chats</span>
        </button>
      </SessionHistoryDialog>
    </nav>
  );
}

export function WorkbenchSidebarSettingsAction(props: {
  onOpenSettings: () => void;
}) {
  return (
    <div className="shrink-0 border-t border-[var(--app-border)] px-2 py-1">
      <button
        type="button"
        className={NAV_ITEM_CLASS}
        aria-label="Settings"
        onClick={props.onOpenSettings}
      >
        <span className={NAV_ICON_CLASS}><Settings size={16} /></span>
        <span>Settings</span>
      </button>
    </div>
  );
}

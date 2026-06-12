import type { CouncilSnapshot, StoredSessionRef, SessionSummary } from "@rah/runtime-protocol";
import { Columns3, MessageCircleMore, Settings, UsersRound } from "lucide-react";
import { SessionHistoryDialog } from "../../SessionHistoryDialog";
import type { WorkspaceSortMode } from "../../../session-browser";

const headerButtonClassName =
  "icon-click-feedback inline-flex h-8 w-8 items-center justify-center rounded-md active:bg-[var(--app-bg)]";
const headerIconSize = 17;

export function MobileWorkbenchHeaderActions(props: {
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
  canvasEnabled: boolean;
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
  onRemoveHistoryWorkspace: (workspaceDir: string, sessions: readonly StoredSessionRef[]) => void;
  onOpenSettings: () => void;
}) {
  return (
    <div className="flex items-center gap-1">
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
        } ${props.canvasEnabled ? "" : "cursor-not-allowed opacity-35 hover:bg-transparent hover:text-[var(--app-hint)]"}`}
        onClick={props.canvasEnabled ? props.onToggleCanvas : undefined}
        disabled={!props.canvasEnabled}
        aria-label={props.canvasActive ? "Exit canvas" : "Open canvas"}
        title={props.canvasEnabled ? (props.canvasActive ? "Exit canvas" : "Canvas") : "Canvas needs a wider screen"}
      >
        <Columns3 size={headerIconSize} />
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
    </div>
  );
}

import type { CouncilSnapshot, StoredSessionRef, SessionSummary } from "@rah/runtime-protocol";
import { Columns3, MessageCircleMore, Settings } from "lucide-react";
import { SessionHistoryDialog } from "../../SessionHistoryDialog";
import { CouncilLogo } from "../../CouncilLogo";
import type { WorkspaceSortMode } from "../../../session-browser";
import {
  SIDEBAR_HEADER_ICON_BUTTON_CLASS,
  SIDEBAR_HEADER_ICON_SIZE,
  SIDEBAR_HEADER_LOGO_CLASS,
} from "../header-button-styles";

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
        className={`${SIDEBAR_HEADER_ICON_BUTTON_CLASS} ${
          props.councilActive
            ? "bg-[var(--app-bg)] text-[var(--app-fg)]"
            : ""
        }`}
        onClick={props.onOpenCouncil}
        aria-label={props.councilActive ? "Hide council" : "Open council"}
        title={props.councilActive ? "Hide council" : "Council"}
      >
        <CouncilLogo className={SIDEBAR_HEADER_LOGO_CLASS} tone="black" variant="bare" />
      </button>
      <button
        type="button"
        className={`${SIDEBAR_HEADER_ICON_BUTTON_CLASS} ${
          props.canvasActive
            ? "bg-[var(--app-bg)] text-[var(--app-fg)]"
            : ""
        } ${props.canvasEnabled ? "" : "cursor-not-allowed opacity-35 hover:bg-transparent hover:text-[var(--app-hint)]"}`}
        onClick={props.canvasEnabled ? props.onToggleCanvas : undefined}
        disabled={!props.canvasEnabled}
        aria-label={props.canvasActive ? "Exit canvas" : "Open canvas"}
        title={props.canvasEnabled ? (props.canvasActive ? "Exit canvas" : "Canvas") : "Canvas needs a wider screen"}
      >
        <Columns3 size={SIDEBAR_HEADER_ICON_SIZE} />
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
          className={SIDEBAR_HEADER_ICON_BUTTON_CLASS}
          aria-label="Chats"
          title="Chats"
        >
          <MessageCircleMore size={SIDEBAR_HEADER_ICON_SIZE} />
        </button>
      </SessionHistoryDialog>
      <button
        type="button"
        className={SIDEBAR_HEADER_ICON_BUTTON_CLASS}
        onClick={props.onOpenSettings}
        aria-label="Open settings"
        title="Settings"
      >
        <Settings size={SIDEBAR_HEADER_ICON_SIZE} />
      </button>
    </div>
  );
}

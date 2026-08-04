import type { CouncilSnapshot, SessionSummary, StoredSessionRef } from "@rah/runtime-protocol";
import { Columns3, MessageCircleMore, Settings, SquarePen } from "lucide-react";
import { Suspense, lazy, useState } from "react";
import { CouncilLogo } from "../../CouncilLogo";
import type { WorkspaceSortMode } from "../../../session-browser";
import { importWithStaleReload } from "../../../lazy-module-reload";
import {
  SIDEBAR_LAYOUT,
  SIDEBAR_VISUAL_PROTOCOL,
} from "../../../sidebar-layout-contract";

const loadSessionHistoryDialog = () =>
  importWithStaleReload(() => import("../../SessionHistoryDialog"));
const SessionHistoryDialog = lazy(async () => ({
  default: (await loadSessionHistoryDialog()).SessionHistoryDialog,
}));

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
  const [chatsOpen, setChatsOpen] = useState(false);
  const chatsButton = (
    <button
      type="button"
      className={SIDEBAR_LAYOUT.navigationItemClassName}
      aria-label="Chats"
      aria-expanded={chatsOpen}
      onClick={() => setChatsOpen(true)}
    >
      <span className={SIDEBAR_LAYOUT.navigationIconClassName}>
        <MessageCircleMore size={SIDEBAR_VISUAL_PROTOCOL.navigationIconPx} strokeWidth={1.75} />
      </span>
      <span>Chats</span>
    </button>
  );
  return (
    <nav className={SIDEBAR_LAYOUT.navigationClassName} aria-label="Primary navigation">
      <button
        type="button"
        aria-label="New task"
        onClick={props.onHome}
        className={`${SIDEBAR_LAYOUT.navigationItemClassName} ${
          props.homeActive ? SIDEBAR_LAYOUT.navigationItemActiveClassName : ""
        }`}
      >
        <span className={SIDEBAR_LAYOUT.navigationIconClassName}>
          <SquarePen size={SIDEBAR_VISUAL_PROTOCOL.navigationIconPx} strokeWidth={1.75} />
        </span>
        <span>New task</span>
      </button>
      <button
        type="button"
        aria-label="Council"
        className={`${SIDEBAR_LAYOUT.navigationItemClassName} ${
          props.councilActive ? SIDEBAR_LAYOUT.navigationItemActiveClassName : ""
        }`}
        onClick={props.onOpenCouncil}
      >
        <span className={SIDEBAR_LAYOUT.navigationIconClassName}>
          <CouncilLogo
            className={SIDEBAR_LAYOUT.navigationCouncilIconClassName}
            tone="black"
            variant="bare"
          />
        </span>
        <span>Council</span>
      </button>
      <button
        type="button"
        aria-label="Canvas"
        className={`${SIDEBAR_LAYOUT.navigationItemClassName} ${
          props.canvasActive ? SIDEBAR_LAYOUT.navigationItemActiveClassName : ""
        } ${
          canvasEnabled ? "" : "cursor-not-allowed opacity-35 hover:bg-transparent"
        }`}
        onClick={canvasEnabled ? props.onToggleCanvas : undefined}
        disabled={!canvasEnabled}
        title={canvasEnabled ? undefined : "Canvas needs a wider screen"}
      >
        <span className={SIDEBAR_LAYOUT.navigationIconClassName}>
          <Columns3 size={SIDEBAR_VISUAL_PROTOCOL.navigationIconPx} strokeWidth={1.75} />
        </span>
        <span>Canvas</span>
      </button>
      {chatsOpen ? (
        <Suspense fallback={chatsButton}>
          <SessionHistoryDialog
            open
            onOpenChange={setChatsOpen}
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
            {chatsButton}
          </SessionHistoryDialog>
        </Suspense>
      ) : chatsButton}
    </nav>
  );
}

export function WorkbenchSidebarSettingsAction(props: {
  onOpenSettings: () => void;
}) {
  return (
    <div className={SIDEBAR_LAYOUT.settingsClassName}>
      <button
        type="button"
        className={SIDEBAR_LAYOUT.navigationItemClassName}
        aria-label="Settings"
        onClick={props.onOpenSettings}
      >
        <span className={SIDEBAR_LAYOUT.navigationIconClassName}>
          <Settings size={SIDEBAR_VISUAL_PROTOCOL.navigationIconPx} strokeWidth={1.75} />
        </span>
        <span>Settings</span>
      </button>
    </div>
  );
}

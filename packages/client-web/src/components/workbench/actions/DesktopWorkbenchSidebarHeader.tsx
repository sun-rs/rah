import type { SessionSummary, StoredSessionRef } from "@rah/runtime-protocol";
import { Columns3, History, Home, Menu, Settings } from "lucide-react";
import { SessionHistoryDialog } from "../../SessionHistoryDialog";
import type { WorkspaceSortMode } from "../../../session-browser";

const headerButtonClassName =
  "icon-click-feedback inline-flex h-10 w-10 items-center justify-center rounded-md active:bg-[var(--app-bg)]";

export function DesktopWorkbenchSidebarHeader(props: {
  storedSessions: StoredSessionRef[];
  recentSessions: StoredSessionRef[];
  liveSessions: SessionSummary[];
  workspaceSortMode: WorkspaceSortMode;
  onWorkspaceSortModeChange: (value: WorkspaceSortMode) => void;
  canvasActive: boolean;
  onHome: () => void;
  onToggleCanvas: () => void;
  onActivateHistory: (ref: StoredSessionRef) => void;
  onActivateLive: (sessionId: string) => void;
  onRemoveHistorySession: (session: Pick<StoredSessionRef, "provider" | "providerSessionId">) => void;
  onRemoveHistoryWorkspace: (workspaceDir: string) => void;
  onOpenSettings: () => void;
  onCollapseSidebar: () => void;
}) {
  return (
    <>
      <div className="shrink-0 text-lg font-semibold tracking-tight">RAH</div>
      <div className="flex items-center gap-1 shrink-0">
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
          <Columns3 size={16} />
        </button>
        <button
          type="button"
          className={`${headerButtonClassName} text-[var(--app-hint)] hover:bg-[var(--app-bg)] hover:text-[var(--app-fg)]`}
          onClick={props.onHome}
          aria-label="Home"
          title="Home"
        >
          <Home size={16} />
        </button>
        <SessionHistoryDialog
          storedSessions={props.storedSessions}
          recentSessions={props.recentSessions}
          liveSessions={props.liveSessions}
          workspaceSortMode={props.workspaceSortMode}
          onWorkspaceSortModeChange={props.onWorkspaceSortModeChange}
          onActivate={props.onActivateHistory}
          onActivateLive={props.onActivateLive}
          onRemoveSession={props.onRemoveHistorySession}
          onRemoveWorkspace={props.onRemoveHistoryWorkspace}
        >
          <button
            type="button"
            className={`${headerButtonClassName} text-[var(--app-hint)] hover:bg-[var(--app-bg)] hover:text-[var(--app-fg)]`}
            aria-label="Sessions"
            title="Sessions"
          >
            <History size={18} />
          </button>
        </SessionHistoryDialog>
        <button
          type="button"
          className={`${headerButtonClassName} text-[var(--app-hint)] hover:bg-[var(--app-bg)] hover:text-[var(--app-fg)]`}
          onClick={props.onOpenSettings}
          aria-label="Open settings"
          title="Settings"
        >
          <Settings size={16} />
        </button>
        <button
          type="button"
          className={`${headerButtonClassName} text-[var(--app-hint)] hover:bg-[var(--app-bg)] hover:text-[var(--app-fg)]`}
          onClick={props.onCollapseSidebar}
          aria-label="Collapse sidebar"
          title="Collapse sidebar"
        >
          <Menu size={18} />
        </button>
      </div>
    </>
  );
}

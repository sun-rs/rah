import type { StoredSessionRef, SessionSummary } from "@rah/runtime-protocol";
import { History, Home, Settings } from "lucide-react";
import { SessionHistoryDialog } from "../../SessionHistoryDialog";

export function MobileWorkbenchHeaderActions(props: {
  storedSessions: StoredSessionRef[];
  recentSessions: StoredSessionRef[];
  liveSessions: SessionSummary[];
  onHome: () => void;
  onActivateHistory: (ref: StoredSessionRef) => void;
  onRemoveHistorySession: (session: Pick<StoredSessionRef, "provider" | "providerSessionId">) => void;
  onRemoveHistoryWorkspace: (workspaceDir: string) => void;
  onOpenSettings: () => void;
}) {
  return (
    <div className="flex items-center gap-1">
      <button
        type="button"
        className="inline-flex h-9 w-9 items-center justify-center rounded-md text-[var(--app-hint)] hover:bg-[var(--app-bg)] hover:text-[var(--app-fg)] transition-colors"
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
        onActivate={props.onActivateHistory}
        onRemoveSession={props.onRemoveHistorySession}
        onRemoveWorkspace={props.onRemoveHistoryWorkspace}
      >
        <button
          type="button"
          className="inline-flex h-9 w-9 items-center justify-center rounded-md text-[var(--app-hint)] hover:bg-[var(--app-bg)] hover:text-[var(--app-fg)] transition-colors"
          aria-label="Session history"
          title="Session history"
        >
          <History size={18} />
        </button>
      </SessionHistoryDialog>
      <button
        type="button"
        className="inline-flex h-9 w-9 items-center justify-center rounded-md text-[var(--app-hint)] hover:bg-[var(--app-bg)] hover:text-[var(--app-fg)] transition-colors"
        onClick={props.onOpenSettings}
        aria-label="Open settings"
        title="Settings"
      >
        <Settings size={16} />
      </button>
    </div>
  );
}

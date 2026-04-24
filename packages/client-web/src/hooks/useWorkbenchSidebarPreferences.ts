import { useEffect, useMemo, useState } from "react";
import type { WorkspaceSortMode, WorkspaceSection } from "../session-browser";

const WORKSPACE_SORT_MODE_KEY = "rah.workspace-sort-mode";
const HISTORY_WORKSPACE_SORT_MODE_KEY = "rah.history-workspace-sort-mode";
const PINNED_WORKSPACE_SESSION_KEY = "rah.pinned-session-by-workspace";

function readWorkspaceSortMode(): WorkspaceSortMode {
  if (typeof window === "undefined") {
    return "created";
  }
  try {
    const value = window.localStorage.getItem(WORKSPACE_SORT_MODE_KEY);
    return value === "updated" ? "updated" : "created";
  } catch {
    return "created";
  }
}

function readHistoryWorkspaceSortMode(): WorkspaceSortMode {
  if (typeof window === "undefined") {
    return "updated";
  }
  try {
    const value = window.localStorage.getItem(HISTORY_WORKSPACE_SORT_MODE_KEY);
    return value === "created" ? "created" : "updated";
  } catch {
    return "updated";
  }
}

function readPinnedWorkspaceSessions(): Record<string, string> {
  if (typeof window === "undefined") {
    return {};
  }
  try {
    const raw = window.localStorage.getItem(PINNED_WORKSPACE_SESSION_KEY);
    if (!raw) {
      return {};
    }
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, string] =>
          typeof entry[0] === "string" && typeof entry[1] === "string",
      ),
    );
  } catch {
    return {};
  }
}

export function useWorkbenchSidebarPreferences(workspaceSections: WorkspaceSection[]) {
  const [pinnedSessionIdByWorkspace, setPinnedSessionIdByWorkspace] =
    useState<Record<string, string>>(() => readPinnedWorkspaceSessions());

  const sanitizedPinnedSessionIdByWorkspace = useMemo(
    () =>
      Object.fromEntries(
        Object.entries(pinnedSessionIdByWorkspace).filter(([workspaceDir, sessionId]) =>
          workspaceSections.some(
            (section) =>
              section.workspace.directory === workspaceDir &&
              section.sessions.some((session) => session.session.id === sessionId),
          ),
        ),
      ),
    [pinnedSessionIdByWorkspace, workspaceSections],
  );

  useEffect(() => {
    try {
      window.localStorage.setItem(
        PINNED_WORKSPACE_SESSION_KEY,
        JSON.stringify(sanitizedPinnedSessionIdByWorkspace),
      );
    } catch {
      // ignore
    }
  }, [sanitizedPinnedSessionIdByWorkspace]);

  const togglePinnedSession = (workspaceDir: string, sessionId: string) => {
    setPinnedSessionIdByWorkspace((current) => {
      if (current[workspaceDir] === sessionId) {
        const next = { ...current };
        delete next[workspaceDir];
        return next;
      }
      return {
        ...current,
        [workspaceDir]: sessionId,
      };
    });
  };

  return {
    sanitizedPinnedSessionIdByWorkspace,
    togglePinnedSession,
  };
}

export function useWorkspaceSortModeState() {
  const [workspaceSortMode, setWorkspaceSortMode] = useState<WorkspaceSortMode>(() =>
    readWorkspaceSortMode(),
  );

  useEffect(() => {
    try {
      window.localStorage.setItem(WORKSPACE_SORT_MODE_KEY, workspaceSortMode);
    } catch {
      // ignore
    }
  }, [workspaceSortMode]);

  return {
    setWorkspaceSortMode,
    workspaceSortMode,
  };
}

export function useHistoryWorkspaceSortModeState() {
  const [workspaceSortMode, setWorkspaceSortMode] = useState<WorkspaceSortMode>(() =>
    readHistoryWorkspaceSortMode(),
  );

  useEffect(() => {
    try {
      window.localStorage.setItem(HISTORY_WORKSPACE_SORT_MODE_KEY, workspaceSortMode);
    } catch {
      // ignore
    }
  }, [workspaceSortMode]);

  return {
    setWorkspaceSortMode,
    workspaceSortMode,
  };
}

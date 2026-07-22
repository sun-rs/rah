import { useEffect, useMemo, useState } from "react";
import type { StoredSessionRef } from "@rah/runtime-protocol";
import { findOwningWorkspace, type WorkspaceSortMode, type WorkspaceSection } from "../session-browser";
import type { SidebarPinnedItemRef } from "../sidebar-view-model";

const WORKSPACE_SORT_MODE_KEY = "rah.workspace-sort-mode";
const HISTORY_WORKSPACE_SORT_MODE_KEY = "rah.history-workspace-sort-mode";

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

function isPinnedWorkspaceItemAvailable(
  workspaceSections: WorkspaceSection[],
  storedSessions: readonly StoredSessionRef[],
  workspaceDir: string,
  itemKey: string,
): boolean {
  const section = workspaceSections.find((candidate) => candidate.workspace.directory === workspaceDir);
  if (!section) {
    return false;
  }
  const providerIdentityMatch = /^session:(codex|claude|opencode):(.+)$/.exec(itemKey);
  if (providerIdentityMatch) {
    const provider = providerIdentityMatch[1] as StoredSessionRef["provider"];
    const providerSessionId = providerIdentityMatch[2]!;
    if (section.sessions.some(
      (session) =>
        session.session.provider === provider &&
        session.session.providerSessionId === providerSessionId,
    )) {
      return true;
    }
    const workspaceDirs = workspaceSections.map(
      (candidate) => candidate.workspace.directory,
    );
    return storedSessions.some(
      (session) =>
        session.provider === provider &&
        session.providerSessionId === providerSessionId &&
        findOwningWorkspace(workspaceDirs, session.rootDir || session.cwd) === workspaceDir,
    );
  }
  const sessionId = itemKey.startsWith("session:")
    ? itemKey.slice("session:".length)
    : itemKey;
  return section.sessions.some((session) => session.session.id === sessionId);
}

export function reconcilePinnedSidebarItems(
  pinnedItems: readonly SidebarPinnedItemRef[],
  workspaceSections: WorkspaceSection[],
  storedSessions: readonly StoredSessionRef[],
  inventoryReady: { sessions: boolean; storedSessions: boolean },
): SidebarPinnedItemRef[] {
  return pinnedItems.filter(({ workspaceDir, itemKey }) => {
    if (itemKey.startsWith("council:")) {
      return false;
    }
    const inventoryLoaded = /^session:(codex|claude|opencode):/.test(itemKey)
      ? inventoryReady.storedSessions
      : inventoryReady.sessions;
    return !inventoryLoaded || isPinnedWorkspaceItemAvailable(
      workspaceSections,
      storedSessions,
      workspaceDir,
      itemKey,
    );
  });
}

export function useWorkbenchSidebarPreferences(
  pinnedSidebarItems: readonly SidebarPinnedItemRef[],
  workspaceSections: WorkspaceSection[],
  storedSessions: readonly StoredSessionRef[] = [],
  inventoryReady: { sessions: boolean; storedSessions: boolean } = {
    sessions: true,
    storedSessions: true,
  },
  setPinnedSidebarItem?: (workspaceDir: string, itemKey: string, pinned: boolean) => Promise<void>,
) {
  const sanitizedPinnedSidebarItems = useMemo(
    () => reconcilePinnedSidebarItems(
      pinnedSidebarItems,
      workspaceSections,
      storedSessions,
      inventoryReady,
    ),
    [
      inventoryReady.sessions,
      inventoryReady.storedSessions,
      pinnedSidebarItems,
      storedSessions,
      workspaceSections,
    ],
  );

  const togglePinnedSidebarItem = (workspaceDir: string, itemKey: string) => {
    const pinned = !pinnedSidebarItems.some(
      (item) => item.workspaceDir === workspaceDir && item.itemKey === itemKey,
    );
    void setPinnedSidebarItem?.(workspaceDir, itemKey, pinned);
  };

  return {
    sanitizedPinnedSidebarItems,
    togglePinnedSidebarItem,
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

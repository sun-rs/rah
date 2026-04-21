import type { SessionSummary, StoredSessionRef } from "@rah/runtime-protocol";
import { isReadOnlyReplay } from "./session-capabilities";

export type SessionDirectoryGroup<T> = {
  key: string;
  directory: string;
  displayName: string;
  items: T[];
  latestUpdatedAt: string;
  hasRunningItem: boolean;
};

function normalizePath(value: string | undefined): string | null {
  if (!value) {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const withoutTrailing = trimmed.replace(/[\\/]+$/, "");
  if (withoutTrailing.startsWith("/private/var/")) {
    return withoutTrailing.slice("/private".length);
  }
  return withoutTrailing;
}

export function matchesWorkspace(path: string | undefined, workspaceDir: string): boolean {
  const normalizedPath = normalizePath(path);
  const normalizedWorkspace = normalizePath(workspaceDir);
  if (!normalizedWorkspace) {
    return false;
  }
  if (!normalizedPath) {
    return false;
  }
  return (
    normalizedPath === normalizedWorkspace ||
    normalizedPath.startsWith(`${normalizedWorkspace}/`) ||
    normalizedPath.startsWith(`${normalizedWorkspace}\\`)
  );
}

export function deriveWorkspaceOptions(
  sessions: SessionSummary[],
  storedSessions: StoredSessionRef[],
): string[] {
  const values = new Set<string>();
  for (const session of sessions) {
    const candidate = normalizePath(session.session.rootDir || session.session.cwd);
    if (candidate) {
      values.add(candidate);
    }
  }
  for (const stored of storedSessions) {
    const candidate = normalizePath(stored.rootDir || stored.cwd);
    if (candidate) {
      values.add(candidate);
    }
  }
  return [...values].sort((a, b) => a.localeCompare(b));
}

export interface WorkspaceInfo {
  directory: string;
  displayName: string;
  latestUpdatedAt: string;
  liveCount: number;
  hasRunningItem: boolean;
  hasBlockingLiveSessions: boolean;
}

export interface WorkspaceSection {
  workspace: WorkspaceInfo;
  sessions: SessionSummary[];
}

function findOwningWorkspace(
  workspaceDirs: readonly string[],
  sessionPath: string | undefined,
): string | null {
  const normalizedPath = normalizePath(sessionPath);
  if (!normalizedPath) {
    return null;
  }
  const sorted = [...workspaceDirs]
    .map(normalizePath)
    .filter((value): value is string => Boolean(value))
    .sort((a, b) => b.length - a.length);
  for (const workspaceDir of sorted) {
    if (matchesWorkspace(normalizedPath, workspaceDir)) {
      return workspaceDir;
    }
  }
  return null;
}

export function deriveWorkspaceInfos(
  workspaceDirs: string[],
  sessions: SessionSummary[],
  storedSessions: StoredSessionRef[],
): WorkspaceInfo[] {
  const map = new Map<
    string,
    {
      directory: string;
      displayName: string;
      latestUpdatedAt: string;
      liveCount: number;
      hasRunningItem: boolean;
      hasBlockingLiveSessions: boolean;
    }
  >();

  for (const workspaceDir of workspaceDirs) {
    const directory = normalizePath(workspaceDir);
    if (!directory) continue;
    map.set(directory, {
      directory,
      displayName: getDirectoryDisplayName(directory),
      latestUpdatedAt: "",
      liveCount: 0,
      hasRunningItem: false,
      hasBlockingLiveSessions: false,
    });
  }

  for (const session of sessions) {
    const isInteractiveLiveSession = !isReadOnlyReplay(session);
    if (isInteractiveLiveSession) {
      for (const workspace of map.values()) {
        if (matchesWorkspace(session.session.rootDir || session.session.cwd, workspace.directory)) {
          workspace.hasBlockingLiveSessions = true;
        }
      }
    }

    const owner = findOwningWorkspace(workspaceDirs, session.session.rootDir || session.session.cwd);
    if (!owner) continue;
    const updatedAt = session.session.updatedAt;
    const isRunning =
      session.session.runtimeState !== "idle" && session.session.runtimeState !== "stopped";
    const workspace = map.get(owner);
    if (!workspace) {
      continue;
    }
    if (isInteractiveLiveSession) {
      workspace.liveCount += 1;
    }
    if (updatedAt > workspace.latestUpdatedAt) {
      workspace.latestUpdatedAt = updatedAt;
    }
    if (isRunning) {
      workspace.hasRunningItem = true;
    }
  }

  for (const stored of storedSessions) {
    const owner = findOwningWorkspace(workspaceDirs, stored.rootDir || stored.cwd);
    if (!owner) continue;
    const updatedAt = stored.updatedAt ?? "";
    const workspace = map.get(owner);
    if (!workspace) {
      continue;
    }
    if (updatedAt > workspace.latestUpdatedAt) {
      workspace.latestUpdatedAt = updatedAt;
    }
  }

  return [...map.values()].sort((a, b) => {
    if (a.liveCount !== b.liveCount) {
      return b.liveCount - a.liveCount;
    }
    return b.latestUpdatedAt.localeCompare(a.latestUpdatedAt);
  });
}

export function deriveWorkspaceSections(
  workspaces: WorkspaceInfo[],
  liveSessions: SessionSummary[],
): WorkspaceSection[] {
  const byWorkspace = new Map<string, SessionSummary[]>(
    workspaces.map((workspace) => [workspace.directory, []]),
  );

  for (const session of liveSessions) {
    const owner = findOwningWorkspace(
      workspaces.map((workspace) => workspace.directory),
      session.session.rootDir || session.session.cwd,
    );
    if (!owner) {
      continue;
    }
    byWorkspace.get(owner)?.push(session);
  }

  return workspaces.map((workspace) => ({
    workspace,
    sessions: [...(byWorkspace.get(workspace.directory) ?? [])].sort((a, b) =>
      b.session.updatedAt.localeCompare(a.session.updatedAt),
    ),
  }));
}

export function getDirectoryDisplayName(directory: string): string {
  const parts = directory.split(/[\\/]+/).filter(Boolean);
  if (parts.length === 0) {
    return directory;
  }
  if (parts.length === 1) {
    return parts[0]!;
  }
  return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
}

export function getRelativeDirectoryLabel(directory: string, workspaceDir: string): string {
  const normalizedDirectory = normalizePath(directory);
  const normalizedWorkspace = normalizePath(workspaceDir);
  if (!normalizedDirectory || !normalizedWorkspace) {
    return directory;
  }
  if (normalizedDirectory === normalizedWorkspace) {
    return ".";
  }
  if (normalizedDirectory.startsWith(`${normalizedWorkspace}/`)) {
    return normalizedDirectory.slice(normalizedWorkspace.length + 1);
  }
  if (normalizedDirectory.startsWith(`${normalizedWorkspace}\\`)) {
    return normalizedDirectory.slice(normalizedWorkspace.length + 1);
  }
  return normalizedDirectory;
}

export function groupLiveSessionsByDirectory(
  sessions: SessionSummary[],
  workspaceDir: string,
): SessionDirectoryGroup<SessionSummary>[] {
  const groups = new Map<string, SessionDirectoryGroup<SessionSummary>>();
  for (const session of sessions) {
    const directory = normalizePath(session.session.rootDir || session.session.cwd);
    if (!directory || !matchesWorkspace(directory, workspaceDir)) {
      continue;
    }
    const existing = groups.get(directory);
    const isRunning = session.session.runtimeState !== "idle" && session.session.runtimeState !== "stopped";
    if (existing) {
      existing.items.push(session);
      if (session.session.updatedAt > existing.latestUpdatedAt) {
        existing.latestUpdatedAt = session.session.updatedAt;
      }
      if (isRunning) {
        existing.hasRunningItem = true;
      }
    } else {
      groups.set(directory, {
        key: `live:${directory}`,
        directory,
        displayName: getDirectoryDisplayName(directory),
        items: [session],
        latestUpdatedAt: session.session.updatedAt,
        hasRunningItem: isRunning,
      });
    }
  }
  return [...groups.values()]
    .map((group) => ({
      ...group,
      items: [...group.items].sort((a, b) =>
        b.session.updatedAt.localeCompare(a.session.updatedAt),
      ),
    }))
    .sort((a, b) => {
      if (a.hasRunningItem !== b.hasRunningItem) {
        return a.hasRunningItem ? -1 : 1;
      }
      return b.latestUpdatedAt.localeCompare(a.latestUpdatedAt);
    });
}

export function groupStoredSessionsByDirectory(
  sessions: StoredSessionRef[],
  workspaceDir: string,
): SessionDirectoryGroup<StoredSessionRef>[] {
  const groups = new Map<string, SessionDirectoryGroup<StoredSessionRef>>();
  for (const session of sessions) {
    const directory = normalizePath(session.rootDir || session.cwd);
    if (!directory || !matchesWorkspace(directory, workspaceDir)) {
      continue;
    }
    const updatedAt = session.updatedAt ?? "";
    const existing = groups.get(directory);
    if (existing) {
      existing.items.push(session);
      if (updatedAt > existing.latestUpdatedAt) {
        existing.latestUpdatedAt = updatedAt;
      }
    } else {
      groups.set(directory, {
        key: `stored:${directory}`,
        directory,
        displayName: getDirectoryDisplayName(directory),
        items: [session],
        latestUpdatedAt: updatedAt,
        hasRunningItem: false,
      });
    }
  }
  return [...groups.values()]
    .map((group) => ({
      ...group,
      items: [...group.items].sort((a, b) =>
        (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""),
      ),
    }))
    .sort((a, b) => b.latestUpdatedAt.localeCompare(a.latestUpdatedAt));
}

export function formatRelativeTime(value: string | undefined): string | null {
  if (!value) {
    return null;
  }
  const date = new Date(value);
  const ms = date.getTime();
  if (!Number.isFinite(ms)) {
    return null;
  }
  const delta = Date.now() - ms;
  if (delta < 60_000) {
    return "just now";
  }
  const minutes = Math.floor(delta / 60_000);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }
  const days = Math.floor(hours / 24);
  if (days < 7) {
    return `${days}d ago`;
  }
  return date.toLocaleDateString();
}

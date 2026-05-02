import type { StoredSessionRef } from "@rah/runtime-protocol";
import { getDirectoryDisplayName, type WorkspaceSortMode } from "./session-browser";

export type SessionHistoryGroup = {
  directory: string;
  displayName: string;
  isWorkspaceGroup: boolean;
  items: StoredSessionRef[];
  earliestCreatedAt: string;
  latestUpdatedAt: string;
};

export function sessionIdentityKey(
  session: Pick<StoredSessionRef, "provider" | "providerSessionId">,
): string {
  return `${session.provider}:${session.providerSessionId}`;
}

export function normalizeHistorySessionPath(value: string | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const withoutTrailing =
    /^[/\\]+$/.test(trimmed) || /^[A-Za-z]:[\\/]?$/.test(trimmed)
      ? trimmed
      : trimmed.replace(/[\\/]+$/, "");
  if (withoutTrailing.startsWith("/private/var/")) {
    return withoutTrailing.slice("/private".length);
  }
  return withoutTrailing;
}

function storedSessionQualityScore(session: StoredSessionRef): number {
  return [
    session.source === "provider_history" ? 8 : 0,
    session.rootDir ? 4 : 0,
    session.cwd ? 2 : 0,
    session.title ? 2 : 0,
    session.preview ? 1 : 0,
    session.createdAt ? 1 : 0,
    session.updatedAt ? 1 : 0,
    session.lastUsedAt ? 1 : 0,
  ].reduce((sum, value) => sum + value, 0);
}

function compareStoredSessionQuality(left: StoredSessionRef, right: StoredSessionRef): number {
  const scoreDelta = storedSessionQualityScore(left) - storedSessionQualityScore(right);
  if (scoreDelta !== 0) {
    return scoreDelta;
  }
  return (left.lastUsedAt ?? left.updatedAt ?? "").localeCompare(
    right.lastUsedAt ?? right.updatedAt ?? "",
  );
}

function effectiveSessionCreatedAt(session: StoredSessionRef): string {
  return session.createdAt ?? session.updatedAt ?? session.lastUsedAt ?? "";
}

function effectiveSessionUpdatedAt(session: StoredSessionRef): string {
  return session.lastUsedAt ?? session.updatedAt ?? "";
}

export function dedupeStoredSessionsByIdentity(sessions: StoredSessionRef[]): StoredSessionRef[] {
  const deduped = new Map<string, StoredSessionRef>();
  for (const session of sessions) {
    const key = sessionIdentityKey(session);
    const existing = deduped.get(key);
    if (!existing || compareStoredSessionQuality(session, existing) > 0) {
      deduped.set(key, session);
    }
  }
  return [...deduped.values()];
}

export function groupAllStoredSessionsByDirectory(
  sessions: StoredSessionRef[],
  options?: {
    workspaceSortMode?: WorkspaceSortMode;
    workspaceDirs?: readonly string[];
  },
): SessionHistoryGroup[] {
  const groups = new Map<string, SessionHistoryGroup>();

  for (const session of dedupeStoredSessionsByIdentity(sessions)) {
    const directory = normalizeHistorySessionPath(session.rootDir || session.cwd);
    const groupKey = directory ?? "__no_workspace__";
    const displayName = directory ? getDirectoryDisplayName(directory) : "No workspace";
    const createdAt = effectiveSessionCreatedAt(session);
    const updatedAt = effectiveSessionUpdatedAt(session);
    const existing = groups.get(groupKey);
    if (existing) {
      existing.items.push(session);
      if (!existing.earliestCreatedAt || (createdAt && createdAt < existing.earliestCreatedAt)) {
        existing.earliestCreatedAt = createdAt;
      }
      if (updatedAt > existing.latestUpdatedAt) {
        existing.latestUpdatedAt = updatedAt;
      }
    } else {
      groups.set(groupKey, {
        directory: directory ?? "",
        displayName,
        isWorkspaceGroup: Boolean(directory),
        items: [session],
        earliestCreatedAt: createdAt,
        latestUpdatedAt: updatedAt,
      });
    }
  }

  const grouped = [...groups.values()]
    .map((group) => ({
      ...group,
      items: [...group.items].sort((a, b) => {
        if ((a.source === "previous_live") !== (b.source === "previous_live")) {
          return a.source === "previous_live" ? -1 : 1;
        }
        return (b.lastUsedAt ?? b.updatedAt ?? "").localeCompare(a.lastUsedAt ?? a.updatedAt ?? "");
      }),
    }));

  const workspaceSortMode = options?.workspaceSortMode ?? "updated";
  if (workspaceSortMode === "created") {
    return grouped.sort((left, right) => {
      if (left.isWorkspaceGroup !== right.isWorkspaceGroup) {
        return left.isWorkspaceGroup ? -1 : 1;
      }
      if (left.earliestCreatedAt !== right.earliestCreatedAt) {
        if (!left.earliestCreatedAt) {
          return 1;
        }
        if (!right.earliestCreatedAt) {
          return -1;
        }
        return left.earliestCreatedAt.localeCompare(right.earliestCreatedAt);
      }
      if (left.isWorkspaceGroup !== right.isWorkspaceGroup) {
        return left.isWorkspaceGroup ? -1 : 1;
      }
      return compareByLatestUpdated(left, right);
    });
  }

  return grouped.sort(compareByLatestUpdated);
}

function compareByLatestUpdated(left: SessionHistoryGroup, right: SessionHistoryGroup): number {
  return right.latestUpdatedAt.localeCompare(left.latestUpdatedAt);
}

import type { SessionSummary, StoredSessionRef } from "@rah/runtime-protocol";
import { isReadOnlyReplay } from "./session-capabilities";
import type { SessionProjection } from "./types";

export function normalizeWorkspaceDirectory(value: string | undefined): string | null {
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

export function sameWorkspaceDirectory(a: string | undefined, b: string | undefined): boolean {
  const left = normalizeWorkspaceDirectory(a);
  const right = normalizeWorkspaceDirectory(b);
  return left !== null && right !== null && left === right;
}

export function isHiddenWorkspace(
  hiddenWorkspaceDirs: ReadonlySet<string>,
  dir: string | undefined,
): boolean {
  const normalized = normalizeWorkspaceDirectory(dir);
  return normalized !== null && hiddenWorkspaceDirs.has(normalized);
}

export function hideWorkspace(
  hiddenWorkspaceDirs: ReadonlySet<string>,
  dir: string,
): Set<string> {
  const normalized = normalizeWorkspaceDirectory(dir);
  if (!normalized) {
    return new Set(hiddenWorkspaceDirs);
  }
  const next = new Set(hiddenWorkspaceDirs);
  next.add(normalized);
  return next;
}

export function revealWorkspace(
  hiddenWorkspaceDirs: ReadonlySet<string>,
  dir: string | undefined,
): Set<string> {
  const normalized = normalizeWorkspaceDirectory(dir);
  if (!normalized) {
    return new Set(hiddenWorkspaceDirs);
  }
  const next = new Set(hiddenWorkspaceDirs);
  next.delete(normalized);
  return next;
}

export function revealWorkspaceCandidates(
  hiddenWorkspaceDirs: ReadonlySet<string>,
  ...dirs: Array<string | undefined>
): Set<string> {
  let next = new Set(hiddenWorkspaceDirs);
  for (const dir of dirs) {
    next = revealWorkspace(next, dir);
  }
  return next;
}

function filterHiddenWorkspaceDirs(
  hiddenWorkspaceDirs: ReadonlySet<string>,
  workspaceDirs: readonly string[],
): string[] {
  return workspaceDirs.filter((dir) => !isHiddenWorkspace(hiddenWorkspaceDirs, dir));
}

export function appendVisibleWorkspaceDir(
  hiddenWorkspaceDirs: ReadonlySet<string>,
  workspaceDirs: readonly string[],
  dir: string | undefined,
): string[] {
  const visibleWorkspaceDirs = filterHiddenWorkspaceDirs(hiddenWorkspaceDirs, workspaceDirs);
  const normalized = normalizeWorkspaceDirectory(dir);
  if (!normalized || isHiddenWorkspace(hiddenWorkspaceDirs, normalized)) {
    return visibleWorkspaceDirs;
  }
  if (visibleWorkspaceDirs.some((workspaceDir) => sameWorkspaceDirectory(workspaceDir, normalized))) {
    return visibleWorkspaceDirs;
  }
  return [...visibleWorkspaceDirs, normalized];
}

function normalizeHiddenWorkspaceDirs(hiddenWorkspaces: readonly string[] | undefined): Set<string> {
  return new Set(
    (hiddenWorkspaces ?? []).map((dir) => normalizeWorkspaceDirectory(dir)).filter(
      (dir): dir is string => dir !== null,
    ),
  );
}

export function resolveHiddenWorkspaceDirsFromSessionsResponse(args: {
  currentHiddenWorkspaceDirs: ReadonlySet<string>;
  currentWorkspaceVisibilityVersion: number;
  workspaceVisibilityVersionAtRequest: number;
  hiddenWorkspaces: readonly string[] | undefined;
}): Set<string> {
  const serverHiddenWorkspaceDirs = normalizeHiddenWorkspaceDirs(args.hiddenWorkspaces);
  if (args.currentWorkspaceVisibilityVersion > args.workspaceVisibilityVersionAtRequest) {
    return new Set(args.currentHiddenWorkspaceDirs);
  }
  return serverHiddenWorkspaceDirs;
}

function inferWorkspaceDirectory(
  workspaceDirs: string[],
  sessions: SessionSummary[],
  storedSessions: StoredSessionRef[],
  rememberedActiveWorkspaceDir: string | undefined,
  fallback: string,
): string {
  if (rememberedActiveWorkspaceDir?.trim()) {
    return rememberedActiveWorkspaceDir;
  }
  const liveCandidate = sessions[0]?.session.rootDir ?? sessions[0]?.session.cwd;
  if (liveCandidate) {
    return liveCandidate;
  }
  const storedCandidate = storedSessions[0]?.rootDir ?? storedSessions[0]?.cwd;
  if (storedCandidate) {
    return storedCandidate;
  }
  if (workspaceDirs[0]) {
    return workspaceDirs[0];
  }
  return fallback;
}

export function reconcileVisibleWorkspaceSelection(args: {
  workspaceDirs: string[];
  sessions: SessionSummary[];
  storedSessions: StoredSessionRef[];
  activeWorkspaceDir: string | undefined;
  currentWorkspaceDir: string;
  hiddenWorkspaceDirs: Iterable<string> | undefined;
}): {
  workspaceDirs: string[];
  workspaceDir: string;
} {
  const hiddenWorkspaceDirs = new Set(
    [...(args.hiddenWorkspaceDirs ?? [])]
      .map((dir) => normalizeWorkspaceDirectory(dir))
      .filter((dir): dir is string => dir !== null),
  );
  const isHidden = (dir: string | undefined): boolean => {
    const normalized = normalizeWorkspaceDirectory(dir);
    return normalized !== null && hiddenWorkspaceDirs.has(normalized);
  };
  const workspaceDirs = args.workspaceDirs.filter((dir) => !isHidden(dir));
  const currentWorkspaceDir = isHidden(args.currentWorkspaceDir) ? "" : args.currentWorkspaceDir;
  const activeWorkspaceDir = isHidden(args.activeWorkspaceDir)
    ? undefined
    : args.activeWorkspaceDir;
  const workspaceDir = currentWorkspaceDir.trim()
    ? currentWorkspaceDir
    : inferWorkspaceDirectory(
        workspaceDirs,
        args.sessions,
        args.storedSessions,
        activeWorkspaceDir,
        currentWorkspaceDir,
      );
  return {
    workspaceDirs,
    workspaceDir,
  };
}

export function coerceSelectedSessionId(
  projections: Map<string, SessionProjection>,
  currentSelectedId: string | null,
): string | null {
  const current = currentSelectedId ? projections.get(currentSelectedId) ?? null : null;
  if (current) {
    return current.summary.session.id;
  }
  return null;
}

export function findDaemonLiveSessionForStoredRef(
  projections: Map<string, SessionProjection>,
  ref: StoredSessionRef,
): SessionSummary | null {
  for (const projection of projections.values()) {
    const summary = projection.summary;
    if (isReadOnlyReplay(summary)) {
      continue;
    }
    if (
      summary.session.provider === ref.provider &&
      summary.session.providerSessionId === ref.providerSessionId
    ) {
      return summary;
    }
  }
  return null;
}

export function resolveHistoryActivationMode(args: {
  existingLiveSummary: SessionSummary | null;
  clientId: string;
}): "select" | "attach" | "resume" {
  if (!args.existingLiveSummary) {
    return "resume";
  }
  const currentClientControlsSession =
    args.existingLiveSummary.controlLease.holderClientId === args.clientId &&
    args.existingLiveSummary.attachedClients.some((client) => client.id === args.clientId);
  return currentClientControlsSession ? "select" : "attach";
}

export function mergeStoredSessionRefs(
  current: StoredSessionRef[],
  incoming: StoredSessionRef,
): StoredSessionRef[] {
  const next = new Map(
    current.map((entry) => [`${entry.provider}:${entry.providerSessionId}`, entry] as const),
  );
  next.set(`${incoming.provider}:${incoming.providerSessionId}`, incoming);
  return [...next.values()].sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
}

export function mergeRecentSessionRefs(
  current: StoredSessionRef[],
  incoming: StoredSessionRef,
): StoredSessionRef[] {
  const next = new Map(
    current.map((entry) => [`${entry.provider}:${entry.providerSessionId}`, entry] as const),
  );
  next.set(`${incoming.provider}:${incoming.providerSessionId}`, incoming);
  return [...next.values()]
    .sort((a, b) => (b.lastUsedAt ?? b.updatedAt ?? "").localeCompare(a.lastUsedAt ?? a.updatedAt ?? ""))
    .slice(0, 15);
}

import type { SessionSummary, StoredSessionRef } from "@rah/runtime-protocol";
import type { PendingSessionTransition } from "./session-transition-contract";
import {
  appendVisibleWorkspaceDir,
  mergeRecentSessionRefs,
  mergeStoredSessionRefs,
  revealWorkspaceCandidates,
} from "./session-store-workspace";
import { initialHistorySyncState, type SessionProjection } from "./types";

type LifecycleState = {
  projections: Map<string, SessionProjection>;
  unreadSessionIds: Set<string>;
  hiddenWorkspaceDirs: Set<string>;
  workspaceDirs: string[];
  workspaceVisibilityVersion: number;
  workspaceDir: string;
  selectedSessionId: string | null;
  newSessionProvider: "codex" | "claude" | "kimi" | "gemini" | "opencode";
  error: string | null;
  pendingSessionTransition: PendingSessionTransition | null;
  pendingSessionAction:
    | {
        kind: "attach_session" | "claim_control" | "claim_history";
        sessionId: string;
      }
    | null;
  storedSessions: StoredSessionRef[];
  recentSessions: StoredSessionRef[];
};

export function createEmptySessionProjection(summary: SessionSummary): SessionProjection {
  return {
    summary,
    feed: [],
    events: [],
    lastSeq: 0,
    history: initialHistorySyncState(),
  };
}

export function applyStartedSessionState(
  current: LifecycleState,
  responseSession: SessionSummary,
  args: {
    cwd: string;
    provider?: LifecycleState["newSessionProvider"];
    projections: Map<string, SessionProjection>;
  },
): Partial<LifecycleState> {
  const nextHiddenWorkspaceDirs = revealWorkspaceCandidates(current.hiddenWorkspaceDirs, args.cwd);
  const workspaceVisibilityVersion = current.workspaceVisibilityVersion + 1;
  args.projections.set(responseSession.session.id, createEmptySessionProjection(responseSession));
  return {
    projections: args.projections,
    unreadSessionIds: new Set(
      [...current.unreadSessionIds].filter((sessionId) => sessionId !== responseSession.session.id),
    ),
    hiddenWorkspaceDirs: nextHiddenWorkspaceDirs,
    workspaceDirs: appendVisibleWorkspaceDir(
      nextHiddenWorkspaceDirs,
      current.workspaceDirs,
      args.cwd,
    ),
    workspaceVisibilityVersion,
    workspaceDir: args.cwd,
    ...(args.provider ? { newSessionProvider: args.provider } : {}),
    selectedSessionId: responseSession.session.id,
    pendingSessionTransition: null,
    error: null,
  };
}

export function applyAttachedSessionState(
  current: LifecycleState,
  responseSession: SessionSummary,
  summary: SessionSummary,
): Partial<LifecycleState> {
  const unreadSessionIds = new Set(current.unreadSessionIds);
  unreadSessionIds.delete(summary.session.id);
  const targetDir = responseSession.session.rootDir || responseSession.session.cwd;
  const nextHiddenWorkspaceDirs = targetDir
    ? revealWorkspaceCandidates(current.hiddenWorkspaceDirs, targetDir)
    : current.hiddenWorkspaceDirs;
  return {
    selectedSessionId: responseSession.session.id,
    unreadSessionIds,
    hiddenWorkspaceDirs: nextHiddenWorkspaceDirs,
    workspaceDirs: targetDir
      ? appendVisibleWorkspaceDir(nextHiddenWorkspaceDirs, current.workspaceDirs, targetDir)
      : current.workspaceDirs,
    workspaceVisibilityVersion: targetDir
      ? current.workspaceVisibilityVersion + 1
      : current.workspaceVisibilityVersion,
    workspaceDir: targetDir ?? current.workspaceDir,
    pendingSessionAction: null,
    error: null,
  };
}

export function applyResumedStoredSessionState(
  current: LifecycleState,
  responseSession: SessionSummary,
  ref: Pick<StoredSessionRef, "rootDir" | "cwd">,
  args: {
    projections: Map<string, SessionProjection>;
    replayProjection?: SessionProjection;
  },
): Partial<LifecycleState> {
  const nextHiddenWorkspaceDirs = revealWorkspaceCandidates(
    current.hiddenWorkspaceDirs,
    ref.rootDir,
    ref.cwd,
  );
  const workspaceVisibilityVersion = current.workspaceVisibilityVersion + 1;
  args.projections.set(
    responseSession.session.id,
    args.replayProjection ?? createEmptySessionProjection(responseSession),
  );
  return {
    projections: args.projections,
    unreadSessionIds: new Set(
      [...current.unreadSessionIds].filter((sessionId) => sessionId !== responseSession.session.id),
    ),
    hiddenWorkspaceDirs: nextHiddenWorkspaceDirs,
    workspaceDirs: appendVisibleWorkspaceDir(
      nextHiddenWorkspaceDirs,
      current.workspaceDirs,
      ref.rootDir ?? ref.cwd,
    ),
    workspaceVisibilityVersion,
    workspaceDir: ref.rootDir ?? ref.cwd ?? current.workspaceDir,
    selectedSessionId: responseSession.session.id,
    pendingSessionTransition: null,
    error: null,
  };
}

export function applyClaimedHistorySessionState(
  current: LifecycleState,
  responseSession: SessionSummary,
  sessionId: string,
  preservedProjection: SessionProjection,
  ref: Pick<StoredSessionRef, "rootDir" | "cwd">,
  projections: Map<string, SessionProjection>,
): Partial<LifecycleState> {
  const nextHiddenWorkspaceDirs = revealWorkspaceCandidates(
    current.hiddenWorkspaceDirs,
    ref.rootDir,
    ref.cwd,
  );
  const workspaceVisibilityVersion = current.workspaceVisibilityVersion + 1;
  projections.delete(sessionId);
  projections.set(responseSession.session.id, {
    ...preservedProjection,
    summary: responseSession,
  });
  return {
    projections,
    unreadSessionIds: new Set(
      [...current.unreadSessionIds].filter(
        (sessionIdValue) =>
          sessionIdValue !== sessionId && sessionIdValue !== responseSession.session.id,
      ),
    ),
    hiddenWorkspaceDirs: nextHiddenWorkspaceDirs,
    workspaceDirs: appendVisibleWorkspaceDir(
      nextHiddenWorkspaceDirs,
      current.workspaceDirs,
      ref.rootDir ?? ref.cwd,
    ),
    workspaceVisibilityVersion,
    workspaceDir: ref.rootDir ?? ref.cwd ?? current.workspaceDir,
    selectedSessionId: responseSession.session.id,
    pendingSessionAction: null,
    pendingSessionTransition: null,
    error: null,
  };
}

export function applyClosedSessionState(
  current: LifecycleState,
  sessionId: string,
  summary: SessionSummary | null,
): LifecycleState {
  const nextState: Partial<LifecycleState> = {
    projections: new Map(
      [...current.projections.entries()].filter(([id]) => id !== sessionId),
    ),
    unreadSessionIds: new Set(
      [...current.unreadSessionIds].filter((id) => id !== sessionId),
    ),
    selectedSessionId: current.selectedSessionId === sessionId ? null : current.selectedSessionId,
    error: null,
  };
  const providerSessionId = summary?.session.providerSessionId;
  if (summary && providerSessionId) {
    const remembered = {
      provider: summary.session.provider,
      providerSessionId,
      ...(summary.session.cwd ? { cwd: summary.session.cwd } : {}),
      ...(summary.session.rootDir ? { rootDir: summary.session.rootDir } : {}),
      ...(summary.session.title ? { title: summary.session.title } : {}),
      ...(summary.session.preview ? { preview: summary.session.preview } : {}),
      updatedAt: summary.session.updatedAt,
      lastUsedAt: summary.session.updatedAt,
      source: "previous_live" as const,
    };
    nextState.storedSessions = mergeStoredSessionRefs(current.storedSessions, remembered);
    nextState.recentSessions = mergeRecentSessionRefs(current.recentSessions, remembered);
  }
  return nextState as LifecycleState;
}

export function buildFallbackStoredSessionRef(
  summary: SessionSummary,
  recentSessions: StoredSessionRef[],
  storedSessions: StoredSessionRef[],
): StoredSessionRef | null {
  const providerSessionId = summary.session.providerSessionId;
  if (!providerSessionId) {
    return null;
  }
  return (
    storedSessions.find(
      (entry) =>
        entry.provider === summary.session.provider &&
        entry.providerSessionId === providerSessionId,
    ) ??
    recentSessions.find(
      (entry) =>
        entry.provider === summary.session.provider &&
        entry.providerSessionId === providerSessionId,
    ) ?? {
      provider: summary.session.provider,
      providerSessionId,
      ...(summary.session.cwd ? { cwd: summary.session.cwd } : {}),
      ...(summary.session.rootDir ? { rootDir: summary.session.rootDir } : {}),
      ...(summary.session.title ? { title: summary.session.title } : {}),
      ...(summary.session.preview ? { preview: summary.session.preview } : {}),
    }
  );
}

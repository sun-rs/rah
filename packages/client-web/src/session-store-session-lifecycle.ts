import type { SessionSummary, StoredSessionRef } from "@rah/runtime-protocol";
import type { PendingSessionTransition } from "./session-transition-contract";
import {
  appendVisibleWorkspaceDir,
  mergeRecentSessionRefs,
  mergeStoredSessionRefs,
  revealWorkspaceCandidates,
} from "./session-store-workspace";
import { deriveSessionConversationActivityAt } from "./session-conversation-activity";
import { initialHistorySyncState, type SessionProjection } from "./types";
import { isReadOnlyReplay } from "./session-capabilities";
import { rebindReadOnlyProjectionToLiveSession } from "./session-store-projections";
import { storedHistoryReplaySessionId } from "./stored-history-replay";

export {
  isStoredHistoryReplayShellSummary,
  storedHistoryReplaySessionId,
} from "./stored-history-replay";

type LifecycleState = {
  projections: Map<string, SessionProjection>;
  unreadSessionIds: Set<string>;
  hiddenWorkspaceDirs: Set<string>;
  workspaceDirs: string[];
  workspaceVisibilityVersion: number;
  workspaceDir: string;
  selectedSessionId: string | null;
  newSessionProvider: "codex" | "claude" | "gemini" | "opencode";
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

export function createStoredHistoryReplayProjection(ref: StoredSessionRef): SessionProjection {
  const sessionId = storedHistoryReplaySessionId(ref);
  const updatedAt =
    ref.lastUsedAt ??
    ref.updatedAt ??
    ref.createdAt ??
    "1970-01-01T00:00:00.000Z";
  const createdAt = ref.createdAt ?? updatedAt;
  const cwd = ref.cwd ?? ref.rootDir ?? "";
  const rootDir = ref.rootDir ?? ref.cwd ?? cwd;
  return createEmptySessionProjection({
    session: {
      id: sessionId,
      provider: ref.provider,
      providerSessionId: ref.providerSessionId,
      launchSource: "web",
      status: "stopped",
      phase: "ended",
      cwd,
      rootDir,
      runtimeState: "stopped",
      runtime: {
        kind: "stored_history",
        protocolStability: "project_native",
        liveSource: "provider_history",
        tuiRole: "none",
        structuredLiveEvents: false,
        tuiContinuity: false,
        features: {
          structuredLiveEvents: "unsupported",
          structuredControl: "unsupported",
          historyBackfill: "available",
          tuiClientContinuity: "unsupported",
          crossClientSync: "unsupported",
          prelaunchConfig: "unsupported",
          runtimeConfig: "unsupported",
          interrupt: "unsupported",
          stopLifecycle: "unsupported",
        },
      },
      ptyId: sessionId,
      ...(ref.title ? { title: ref.title } : {}),
      ...(ref.preview ? { preview: ref.preview } : {}),
      capabilities: {
        liveAttach: false,
        structuredTimeline: false,
        nativeTui: false,
        rawPtyInput: false,
        chatMirror: false,
        structuredControl: false,
        livePermissions: false,
        contextUsage: false,
        resumeByProvider: true,
        listProviderSessions: true,
        renameSession: false,
        actions: { info: true, stop: false, delete: false, rename: "none" },
        steerInput: false,
        queuedInput: false,
        modelSwitch: false,
        planMode: false,
        subagents: false,
      },
      createdAt,
      updatedAt,
    },
    attachedClients: [],
    controlLease: { sessionId },
  });
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
  projections.set(
    responseSession.session.id,
    isReadOnlyReplay(preservedProjection.summary)
      ? rebindReadOnlyProjectionToLiveSession(preservedProjection, responseSession)
      : {
          ...preservedProjection,
          summary: responseSession,
        },
  );
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
    const projection = current.projections.get(sessionId);
    const activityAt = projection
      ? deriveSessionConversationActivityAt(projection)
      : summary.session.updatedAt;
    const remembered = {
      provider: summary.session.provider,
      providerSessionId,
      ...(summary.session.cwd ? { cwd: summary.session.cwd } : {}),
      ...(summary.session.rootDir ? { rootDir: summary.session.rootDir } : {}),
      ...(summary.session.title ? { title: summary.session.title } : {}),
      ...(summary.session.preview ? { preview: summary.session.preview } : {}),
      createdAt: summary.session.createdAt,
      updatedAt: activityAt,
      lastUsedAt: activityAt,
      source: "previous_running" as const,
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
      createdAt: summary.session.createdAt,
    }
  );
}

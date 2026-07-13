import type { SessionSummary, StoredSessionRef } from "@rah/runtime-protocol";
import type { PendingSessionTransition } from "./session-transition-contract";
import {
  appendVisibleWorkspaceDir,
  mergeRecentSessionRefs,
  mergeStoredSessionRefs,
  revealWorkspaceCandidates,
} from "./session-store-workspace";
import { deriveSessionConversationActivityAt } from "./session-conversation-activity";
import { initialConversationSyncState, type SessionProjection } from "./types";

type LifecycleState = {
  projections: Map<string, SessionProjection>;
  unreadSessionIds: Set<string>;
  hiddenWorkspaceDirs: Set<string>;
  workspaceDirs: string[];
  workspaceVisibilityVersion: number;
  sessionTopologyVersion: number;
  workspaceDir: string;
  selectedSessionId: string | null;
  newSessionProvider: "codex" | "claude" | "opencode";
  error: string | null;
  pendingSessionTransition: PendingSessionTransition | null;
  pendingSessionAction:
    | {
        kind: "attach_session" | "claim_control" | "resume_history";
        sessionId: string;
        provider?: SessionSummary["session"]["provider"];
        providerSessionId?: string;
      }
    | null;
  storedSessions: StoredSessionRef[];
  recentSessions: StoredSessionRef[];
};

function applySessionWorkspacePlacement(
  current: Pick<
    LifecycleState,
    "hiddenWorkspaceDirs" | "workspaceDirs" | "workspaceVisibilityVersion" | "workspaceDir"
  >,
  ...workspaceCandidates: Array<string | undefined>
): Pick<
  LifecycleState,
  "hiddenWorkspaceDirs" | "workspaceDirs" | "workspaceVisibilityVersion" | "workspaceDir"
> {
  const targetDir = workspaceCandidates.find((dir) => dir?.trim());
  const hiddenWorkspaceDirs = revealWorkspaceCandidates(
    current.hiddenWorkspaceDirs,
    ...workspaceCandidates,
  );
  if (!targetDir) {
    return {
      hiddenWorkspaceDirs,
      workspaceDirs: current.workspaceDirs,
      workspaceVisibilityVersion: current.workspaceVisibilityVersion,
      workspaceDir: current.workspaceDir,
    };
  }
  return {
    hiddenWorkspaceDirs,
    workspaceDirs: appendVisibleWorkspaceDir(
      hiddenWorkspaceDirs,
      current.workspaceDirs,
      targetDir,
    ),
    workspaceVisibilityVersion: current.workspaceVisibilityVersion + 1,
    workspaceDir: targetDir,
  };
}

export function createEmptySessionProjection(summary: SessionSummary): SessionProjection {
  return {
    summary,
    feed: [],
    events: [],
    lastSeq: 0,
  };
}

export function isPendingResumeProjectionTransferTarget(
  state: Pick<LifecycleState, "projections" | "pendingSessionAction">,
  sessionId: string,
): boolean {
  const pending = state.pendingSessionAction;
  if (
    pending?.kind !== "resume_history" ||
    pending.sessionId === sessionId
  ) {
    return false;
  }
  const source = state.projections.get(pending.sessionId)?.summary.session;
  const target = state.projections.get(sessionId)?.summary.session;
  const provider = pending.provider ?? source?.provider;
  const providerSessionId = pending.providerSessionId ?? source?.providerSessionId;
  return Boolean(
    provider &&
      providerSessionId &&
      target?.providerSessionId &&
      provider === target.provider &&
      providerSessionId === target.providerSessionId,
  );
}

export function storedReplayPlaceholderSessionId(
  ref: Pick<StoredSessionRef, "provider" | "providerSessionId">,
): string {
  return `history:${ref.provider}:${ref.providerSessionId}`;
}

function storedReplayCapabilities(provider: StoredSessionRef["provider"]): SessionSummary["session"]["capabilities"] {
  const rename = provider === "opencode" ? "none" : "native";
  return {
    liveAttach: false,
    structuredTimeline: true,
    nativeTui: false,
    rawPtyInput: false,
    chatMirror: false,
    structuredControl: false,
    livePermissions: false,
    contextUsage: false,
    resumeByProvider: true,
    listProviderSessions: true,
    actions: {
      info: true,
      stop: false,
      ...(provider === "codex" ? { archive: true } : {}),
      delete: true,
      rename,
    },
    steerInput: false,
    queuedInput: false,
    modelSwitch: false,
    planMode: false,
    subagents: false,
    ...(provider === "codex"
      ? { branching: { sameWorkspace: true, worktree: false, side: true } }
      : {}),
  };
}

export function createPendingStoredReplayProjection(ref: StoredSessionRef): SessionProjection {
  const now = new Date().toISOString();
  const sessionId = storedReplayPlaceholderSessionId(ref);
  const cwd = ref.cwd ?? ref.rootDir ?? "";
  const rootDir = ref.rootDir ?? ref.cwd ?? cwd;
  const createdAt = ref.createdAt ?? ref.updatedAt ?? ref.lastUsedAt ?? now;
  const updatedAt = ref.lastUsedAt ?? ref.updatedAt ?? ref.createdAt ?? now;
  return {
    summary: {
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
        capabilities: storedReplayCapabilities(ref.provider),
        createdAt,
        updatedAt,
      },
      attachedClients: [],
      controlLease: { sessionId },
    },
    feed: [],
    events: [],
    lastSeq: 0,
    conversation: {
      ...initialConversationSyncState(),
      phase: "loading",
      loadedScope: "history",
    },
  };
}

export function applyPendingStoredReplaySessionState(
  current: LifecycleState,
  ref: StoredSessionRef,
): Partial<LifecycleState> {
  const projection = createPendingStoredReplayProjection(ref);
  const workspacePlacement = applySessionWorkspacePlacement(
    current,
    ref.rootDir,
    ref.cwd,
  );
  const next = new Map(current.projections);
  next.set(projection.summary.session.id, projection);
  return {
    projections: next,
    unreadSessionIds: new Set(
      [...current.unreadSessionIds].filter(
        (sessionId) => sessionId !== projection.summary.session.id,
      ),
    ),
    ...workspacePlacement,
    sessionTopologyVersion: current.sessionTopologyVersion + 1,
    selectedSessionId: projection.summary.session.id,
    pendingSessionTransition: null,
    error: null,
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
  const workspacePlacement = applySessionWorkspacePlacement(
    current,
    responseSession.session.rootDir,
    responseSession.session.cwd,
    args.cwd,
  );
  args.projections.set(responseSession.session.id, createEmptySessionProjection(responseSession));
  return {
    projections: args.projections,
    unreadSessionIds: new Set(
      [...current.unreadSessionIds].filter((sessionId) => sessionId !== responseSession.session.id),
    ),
    ...workspacePlacement,
    sessionTopologyVersion: current.sessionTopologyVersion + 1,
    ...(args.provider ? { newSessionProvider: args.provider } : {}),
    selectedSessionId: responseSession.session.id,
    pendingSessionTransition: null,
    error: null,
  };
}

export function applyForkedSessionState(
  current: LifecycleState,
  responseSession: SessionSummary,
  args: {
    projections: Map<string, SessionProjection>;
    selectChild: boolean;
  },
): Partial<LifecycleState> {
  args.projections.set(responseSession.session.id, createEmptySessionProjection(responseSession));
  const unreadSessionIds = new Set(current.unreadSessionIds);
  unreadSessionIds.delete(responseSession.session.id);
  if (!args.selectChild) {
    return {
      projections: args.projections,
      unreadSessionIds,
      sessionTopologyVersion: current.sessionTopologyVersion + 1,
      error: null,
    };
  }
  const workspacePlacement = applySessionWorkspacePlacement(
    current,
    responseSession.session.rootDir,
    responseSession.session.cwd,
  );
  return {
    projections: args.projections,
    unreadSessionIds,
    ...workspacePlacement,
    sessionTopologyVersion: current.sessionTopologyVersion + 1,
    selectedSessionId: responseSession.session.id,
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
  const workspacePlacement = applySessionWorkspacePlacement(
    current,
    responseSession.session.rootDir,
    responseSession.session.cwd,
  );
  return {
    selectedSessionId: responseSession.session.id,
    unreadSessionIds,
    ...workspacePlacement,
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
    replaceSessionId?: string;
    selectSession?: boolean;
  },
): Partial<LifecycleState> {
  const workspacePlacement = applySessionWorkspacePlacement(
    current,
    responseSession.session.rootDir,
    responseSession.session.cwd,
    ref.rootDir,
    ref.cwd,
  );
  if (args.replaceSessionId) {
    args.projections.delete(args.replaceSessionId);
  }
  args.projections.set(
    responseSession.session.id,
    args.replayProjection ?? createEmptySessionProjection(responseSession),
  );
  return {
    projections: args.projections,
    unreadSessionIds: new Set(
      [...current.unreadSessionIds].filter((sessionId) => sessionId !== responseSession.session.id),
    ),
    ...workspacePlacement,
    sessionTopologyVersion: current.sessionTopologyVersion + 1,
    selectedSessionId:
      args.selectSession === false ? current.selectedSessionId : responseSession.session.id,
    pendingSessionTransition: null,
    error: null,
  };
}

export function mergeResumedHistoryProjection(
  responseSession: SessionSummary,
  preservedProjection: SessionProjection,
  liveProjection?: SessionProjection,
): SessionProjection {
  const feedByKey = new Map(preservedProjection.feed.map((entry) => [entry.key, entry] as const));
  for (const entry of liveProjection?.feed ?? []) {
    feedByKey.set(entry.key, entry);
  }
  const eventsById = new Map(preservedProjection.events.map((event) => [event.id, event] as const));
  for (const event of liveProjection?.events ?? []) {
    eventsById.set(event.id, event);
  }
  const pendingInterrupt =
    liveProjection?.pendingInterrupt ?? preservedProjection.pendingInterrupt;
  const conversation =
    preservedProjection.conversation ?? liveProjection?.conversation;
  const turnDirectory =
    preservedProjection.turnDirectory ?? liveProjection?.turnDirectory;
  return {
    ...(liveProjection ?? preservedProjection),
    feed: [...feedByKey.values()],
    events: [...eventsById.values()].sort((left, right) => left.seq - right.seq),
    lastSeq: Math.max(liveProjection?.lastSeq ?? 0, preservedProjection.lastSeq),
    ...(conversation ? { conversation } : {}),
    ...(turnDirectory ? { turnDirectory } : {}),
    ...(pendingInterrupt ? { pendingInterrupt } : {}),
    ...(liveProjection?.currentRuntimeStatus
      ? { currentRuntimeStatus: liveProjection.currentRuntimeStatus }
      : preservedProjection.currentRuntimeStatus
        ? { currentRuntimeStatus: preservedProjection.currentRuntimeStatus }
        : {}),
    summary: responseSession,
  };
}

export function applyResumedHistorySessionState(
  current: LifecycleState,
  responseSession: SessionSummary,
  sessionId: string,
  preservedProjection: SessionProjection,
  ref: Pick<StoredSessionRef, "rootDir" | "cwd">,
  projections: Map<string, SessionProjection>,
): Partial<LifecycleState> {
  const workspacePlacement = applySessionWorkspacePlacement(
    current,
    responseSession.session.rootDir,
    responseSession.session.cwd,
    ref.rootDir,
    ref.cwd,
  );
  projections.delete(sessionId);
  projections.set(
    responseSession.session.id,
    mergeResumedHistoryProjection(
      responseSession,
      preservedProjection,
      projections.get(responseSession.session.id),
    ),
  );
  return {
    projections,
    unreadSessionIds: new Set(
      [...current.unreadSessionIds].filter(
        (sessionIdValue) =>
          sessionIdValue !== sessionId && sessionIdValue !== responseSession.session.id,
      ),
    ),
    ...workspacePlacement,
    sessionTopologyVersion: current.sessionTopologyVersion + 1,
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
    sessionTopologyVersion: current.sessionTopologyVersion + 1,
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

export function resolveStoredSessionRef(
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

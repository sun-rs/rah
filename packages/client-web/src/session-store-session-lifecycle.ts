import type { SessionSummary, StoredSessionRef } from "@rah/runtime-protocol";
import type { PendingSessionTransition } from "./session-transition-contract";
import {
  appendVisibleWorkspaceDir,
  mergeRecentSessionRefs,
  mergeStoredSessionRefs,
  revealWorkspaceCandidates,
} from "./session-store-workspace";
import { deriveSessionConversationActivityAt } from "./session-conversation-activity";
import {
  initialConversationSyncState,
  type ConversationSyncState,
  type SessionProjection,
} from "./types";

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

function storedReplayRuntime(): NonNullable<SessionSummary["session"]["runtime"]> {
  return {
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
  };
}

function wasLiveBeforeClose(summary: SessionSummary): boolean {
  return Boolean(
    summary.session.providerSessionId &&
      summary.session.status === "running" &&
      (summary.session.capabilities.liveAttach ||
        summary.session.capabilities.steerInput ||
        summary.session.capabilities.livePermissions),
  );
}

/**
 * Keep the already-rendered transcript when a selected live runtime stops.
 * The runtime identity remains stable only until navigation; capabilities are
 * downgraded atomically so the same composer becomes Resume-on-send.
 */
export function createStoppedReplayProjection(
  projection: SessionProjection,
  closedSummary: SessionSummary = projection.summary,
): SessionProjection {
  const session = {
    ...projection.summary.session,
    status: "stopped" as const,
    phase: "ended" as const,
    runtimeState: "stopped" as const,
    runtime: storedReplayRuntime(),
    capabilities: storedReplayCapabilities(closedSummary.session.provider),
    updatedAt: closedSummary.session.updatedAt,
  };
  delete session.liveBackend;
  delete session.runtimeDiagnostics;
  delete session.nativeTui;
  delete session.inputQueue;
  delete session.inputQueuePolicy;
  delete session.mux;
  delete session.pid;

  const next: SessionProjection = {
    ...projection,
    summary: {
      session,
      attachedClients: [],
      controlLease: { sessionId: session.id },
    },
  };
  delete next.currentRuntimeStatus;
  delete next.pendingInterrupt;
  return next;
}

export function createPendingStoredReplayProjection(
  ref: StoredSessionRef,
  cachedConversation?: ConversationSyncState,
): SessionProjection {
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
        ...(ref.modelProvider ? { modelProvider: ref.modelProvider } : {}),
        launchSource: "web",
        status: "stopped",
        phase: "ended",
        cwd,
        rootDir,
        runtimeState: "stopped",
        runtime: storedReplayRuntime(),
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
    conversation:
      cachedConversation ?? {
        ...initialConversationSyncState(),
        phase: "loading",
        loadedScope: "history",
      },
  };
}

export function applyPendingStoredReplaySessionState(
  current: LifecycleState,
  ref: StoredSessionRef,
  cachedConversation?: ConversationSyncState,
): Partial<LifecycleState> {
  const projection = createPendingStoredReplayProjection(ref, cachedConversation);
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
    selectSession?: boolean;
  },
): Partial<LifecycleState> {
  const nextWorkspacePlacement = applySessionWorkspacePlacement(
    current,
    responseSession.session.rootDir,
    responseSession.session.cwd,
    args.cwd,
  );
  const workspacePlacement =
    args.selectSession === false
      ? { ...nextWorkspacePlacement, workspaceDir: current.workspaceDir }
      : nextWorkspacePlacement;
  args.projections.set(responseSession.session.id, createEmptySessionProjection(responseSession));
  return {
    projections: args.projections,
    unreadSessionIds: new Set(
      [...current.unreadSessionIds].filter((sessionId) => sessionId !== responseSession.session.id),
    ),
    ...workspacePlacement,
    sessionTopologyVersion: current.sessionTopologyVersion + 1,
    ...(args.provider ? { newSessionProvider: args.provider } : {}),
    selectedSessionId:
      args.selectSession === false
        ? current.selectedSessionId
        : responseSession.session.id,
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

function mergeSessionProjectionHandoff(
  responseSession: SessionSummary,
  preservedProjection: SessionProjection,
  liveProjection?: SessionProjection,
  conversationAuthority: "preserved" | "live" = "preserved",
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
    conversationAuthority === "live"
      ? liveProjection?.conversation ?? preservedProjection.conversation
      : preservedProjection.conversation ?? liveProjection?.conversation;
  const turnDirectory =
    conversationAuthority === "live"
      ? liveProjection?.turnDirectory ?? preservedProjection.turnDirectory
      : preservedProjection.turnDirectory ?? liveProjection?.turnDirectory;
  const pendingStartupConfiguration =
    preservedProjection.pendingStartupConfiguration ??
    liveProjection?.pendingStartupConfiguration;
  const responseUpdatedAt = responseSession.session.updatedAt;
  const liveUpdatedAt = liveProjection?.summary.session.updatedAt;
  const liveHasProjectedEvents = (liveProjection?.lastSeq ?? 0) > 0;
  const responseSessionIsFreshest =
    liveUpdatedAt === undefined ||
    responseUpdatedAt > liveUpdatedAt ||
    (responseUpdatedAt === liveUpdatedAt && !liveHasProjectedEvents);
  const freshestSummary = responseSessionIsFreshest
    ? responseSession
    : liveProjection!.summary;
  const otherSummary = responseSessionIsFreshest
    ? liveProjection?.summary
    : responseSession;
  const attachedClientsSource =
    responseSession.attachedClients.length > 0
      ? responseSession.attachedClients
      : (liveProjection?.summary.attachedClients.length ?? 0) > 0
        ? liveProjection!.summary.attachedClients
        : preservedProjection.summary.attachedClients;
  const controlLeaseSource =
    responseSession.controlLease.holderClientId !== undefined
      ? responseSession.controlLease
      : liveProjection?.summary.controlLease.holderClientId !== undefined
        ? liveProjection.summary.controlLease
        : preservedProjection.summary.controlLease;
  const targetSessionId = freshestSummary.session.id;
  // Activation HTTP completion and lifecycle events race on independent
  // transports. Never let a later-arriving but older HTTP snapshot erase a
  // Working phase or native-TUI capabilities already projected from events.
  // Attachment/control metadata is merged separately because those events do
  // not advance ManagedSession.updatedAt.
  const summary: SessionSummary = {
    ...(otherSummary ?? {}),
    ...freshestSummary,
    session: freshestSummary.session,
    // The preserved projection owns the browser attachment while the daemon is
    // still allocating the target live identity. Lifecycle events can reveal
    // that identity before the activation response carries its attachment
    // snapshot. Preserve the ownership, but rebind it to the target runtime so
    // header Stop and native-TUI controls become live in the same event flush.
    attachedClients: attachedClientsSource.map((client) => ({
      ...client,
      sessionId: targetSessionId,
    })),
    controlLease: {
      ...controlLeaseSource,
      sessionId: targetSessionId,
    },
  };
  return {
    ...(liveProjection ?? preservedProjection),
    feed: [...feedByKey.values()],
    events: [...eventsById.values()].sort((left, right) => left.seq - right.seq),
    lastSeq: Math.max(liveProjection?.lastSeq ?? 0, preservedProjection.lastSeq),
    ...(conversation ? { conversation } : {}),
    ...(turnDirectory ? { turnDirectory } : {}),
    ...(pendingInterrupt ? { pendingInterrupt } : {}),
    ...(pendingStartupConfiguration ? { pendingStartupConfiguration } : {}),
    ...(liveProjection?.currentRuntimeStatus
      ? { currentRuntimeStatus: liveProjection.currentRuntimeStatus }
      : preservedProjection.currentRuntimeStatus
        ? { currentRuntimeStatus: preservedProjection.currentRuntimeStatus }
        : {}),
    summary,
  };
}

/**
 * Hand a provisional New Task projection to the daemon-created Session.
 * The provisional projection owns the optimistic draft and selected controls;
 * the live projection owns canonical conversation state already received over
 * the event stream. A failed history request for the temporary id therefore
 * cannot overwrite an accepted provider reply.
 */
export function mergeStartedSessionProjection(
  responseSession: SessionSummary,
  provisionalProjection: SessionProjection,
  liveProjection?: SessionProjection,
): SessionProjection {
  return mergeSessionProjectionHandoff(
    responseSession,
    provisionalProjection,
    liveProjection,
    "live",
  );
}

/**
 * Resume keeps the fully paged stopped transcript as its baseline while live
 * lifecycle state is transferred onto the new runtime identity.
 */
export function mergeResumedHistoryProjection(
  responseSession: SessionSummary,
  preservedProjection: SessionProjection,
  liveProjection?: SessionProjection,
): SessionProjection {
  return mergeSessionProjectionHandoff(
    responseSession,
    preservedProjection,
    liveProjection,
    "preserved",
  );
}

export function applyResumedHistorySessionState(
  current: LifecycleState,
  responseSession: SessionSummary,
  sessionId: string,
  preservedProjection: SessionProjection,
  ref: Pick<StoredSessionRef, "rootDir" | "cwd">,
  projections: Map<string, SessionProjection>,
): Partial<LifecycleState> {
  const resumedSessionId = responseSession.session.id;
  const selectionFollowsResume =
    current.selectedSessionId === sessionId ||
    current.selectedSessionId === resumedSessionId;
  const workspacePlacement = applySessionWorkspacePlacement(
    current,
    responseSession.session.rootDir,
    responseSession.session.cwd,
    ref.rootDir,
    ref.cwd,
  );
  projections.delete(sessionId);
  projections.set(
    resumedSessionId,
    mergeResumedHistoryProjection(
      responseSession,
      preservedProjection,
      projections.get(resumedSessionId),
    ),
  );
  return {
    projections,
    unreadSessionIds: new Set(
      [...current.unreadSessionIds].filter(
        (sessionIdValue) =>
          sessionIdValue !== sessionId &&
          (!selectionFollowsResume || sessionIdValue !== resumedSessionId),
      ),
    ),
    ...workspacePlacement,
    sessionTopologyVersion: current.sessionTopologyVersion + 1,
    selectedSessionId: selectionFollowsResume
      ? resumedSessionId
      : current.selectedSessionId,
    pendingSessionAction: null,
    pendingSessionTransition: null,
    error: null,
  };
}

export function applyClosedSessionState(
  current: LifecycleState,
  sessionId: string,
  summary: SessionSummary | null,
  fallbackProjection?: SessionProjection,
): LifecycleState {
  const projection = current.projections.get(sessionId) ?? fallbackProjection;
  const closingSummary = summary ?? projection?.summary ?? null;
  const preserveSelectedReplay = Boolean(
    projection &&
      closingSummary &&
      current.selectedSessionId === sessionId &&
      wasLiveBeforeClose(closingSummary),
  );
  const projections = new Map(current.projections);
  if (preserveSelectedReplay && projection && closingSummary) {
    projections.set(sessionId, createStoppedReplayProjection(projection, closingSummary));
  } else {
    projections.delete(sessionId);
  }
  const nextState: Partial<LifecycleState> = {
    projections,
    unreadSessionIds: new Set(
      [...current.unreadSessionIds].filter((id) => id !== sessionId),
    ),
    selectedSessionId:
      current.selectedSessionId === sessionId && !preserveSelectedReplay
        ? null
        : current.selectedSessionId,
    sessionTopologyVersion: current.sessionTopologyVersion + 1,
    error: null,
  };
  const providerSessionId = closingSummary?.session.providerSessionId;
  if (closingSummary && providerSessionId) {
    const activityAt = projection
      ? deriveSessionConversationActivityAt(projection)
      : closingSummary.session.updatedAt;
    const remembered = {
      provider: closingSummary.session.provider,
      providerSessionId,
      ...(closingSummary.session.cwd ? { cwd: closingSummary.session.cwd } : {}),
      ...(closingSummary.session.rootDir ? { rootDir: closingSummary.session.rootDir } : {}),
      ...(closingSummary.session.title ? { title: closingSummary.session.title } : {}),
      ...(closingSummary.session.preview ? { preview: closingSummary.session.preview } : {}),
      createdAt: closingSummary.session.createdAt,
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

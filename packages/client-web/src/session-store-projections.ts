import type {
  RahEvent,
  SessionQueuedInput,
  WorkbenchPinnedItemRef,
} from "@rah/runtime-protocol";
import {
  coerceSelectedSessionId,
  deriveVisibleWorkspaceDirs,
  reconcileVisibleWorkspaceSelection,
  resolveHiddenWorkspaceDirsFromSessionsResponse,
} from "./session-store-workspace";
import { isReadOnlyReplay } from "./session-capabilities";
import { compactRecoverableLiveProjectionFeed } from "./session-feed-retention";
import {
  applyEventToProjection,
  createSessionMap,
  type SessionProjection,
  type SessionsResponse,
} from "./types";

function sessionSummaryIsActivelyRunning(summary: SessionProjection["summary"]): boolean {
  return summary.session.status === "running" && [
    "starting",
    "working",
    "stopping",
  ].includes(summary.session.phase);
}

function queuedInputFeedState(projection: SessionProjection): {
  unresolved: Set<string>;
  canonical: Set<string>;
} {
  const unresolved = new Set<string>();
  const canonical = new Set<string>();
  for (const entry of projection.feed) {
    if (entry.kind !== "timeline" || entry.item.kind !== "user_message") {
      continue;
    }
    const clientMessageId = entry.item.clientMessageId;
    if (!clientMessageId) {
      continue;
    }
    const isUnresolvedOptimisticMessage =
      entry.key === `optimistic:user:${clientMessageId}` &&
      entry.sourceProvider === undefined &&
      entry.canonicalItemId === undefined &&
      entry.canonicalTurnId === undefined &&
      entry.providerTurnId === undefined &&
      entry.turnId === undefined &&
      entry.item.messageId === undefined;
    if (isUnresolvedOptimisticMessage && !canonical.has(clientMessageId)) {
      unresolved.add(clientMessageId);
      continue;
    }
    canonical.add(clientMessageId);
    unresolved.delete(clientMessageId);
  }
  return { unresolved, canonical };
}

function queuedInputState(input: SessionQueuedInput): "queued" | "submitting" {
  return input.state ?? "queued";
}

function reconcileFreshSummaryInputQueue(
  projection: SessionProjection,
  summary: SessionProjection["summary"],
): SessionProjection["summary"] {
  const currentQueue = projection.summary.session.inputQueue ?? [];
  const freshQueue = summary.session.inputQueue ?? [];
  if (currentQueue.length === 0 && freshQueue.length === 0) {
    return summary;
  }

  const { unresolved, canonical } = queuedInputFeedState(projection);
  const currentById = new Map(
    currentQueue.map((input) => [input.clientMessageId, input] as const),
  );
  const mergedById = new Map<string, SessionQueuedInput>();

  for (const freshInput of freshQueue) {
    if (canonical.has(freshInput.clientMessageId)) {
      continue;
    }
    const currentInput = currentById.get(freshInput.clientMessageId);
    const preserveSubmittingState =
      unresolved.has(freshInput.clientMessageId) &&
      currentInput !== undefined &&
      queuedInputState(currentInput) === "submitting" &&
      queuedInputState(freshInput) !== "submitting";
    mergedById.set(
      freshInput.clientMessageId,
      preserveSubmittingState
        ? { ...freshInput, state: "submitting" }
        : freshInput,
    );
  }

  for (const currentInput of currentQueue) {
    if (
      unresolved.has(currentInput.clientMessageId) &&
      !canonical.has(currentInput.clientMessageId) &&
      !mergedById.has(currentInput.clientMessageId)
    ) {
      mergedById.set(currentInput.clientMessageId, currentInput);
    }
  }

  const inputQueue = [...mergedById.values()]
    .sort(
      (left, right) =>
        left.queuedAt.localeCompare(right.queuedAt) ||
        left.position - right.position ||
        left.clientMessageId.localeCompare(right.clientMessageId),
    )
    .map((input, position) =>
      input.position === position ? input : { ...input, position },
    );

  if (inputQueue.length === 0) {
    const { inputQueue: _inputQueue, ...session } = summary.session;
    return { ...summary, session };
  }
  return {
    ...summary,
    session: {
      ...summary.session,
      inputQueue,
    },
  };
}

function projectionWithFreshSummary(
  projection: SessionProjection,
  summary: SessionProjection["summary"],
): SessionProjection {
  const reconciledSummary = reconcileFreshSummaryInputQueue(projection, summary);
  const next: SessionProjection = { ...projection, summary: reconciledSummary };
  if (!sessionSummaryIsActivelyRunning(reconciledSummary)) {
    delete next.currentRuntimeStatus;
  }
  return next;
}

function reconcileReplacementInputQueues(
  next: Map<string, SessionProjection>,
  current: Map<string, SessionProjection>,
): Map<string, SessionProjection> {
  let result = next;
  for (const [sessionId, existing] of current) {
    const fresh = next.get(sessionId);
    if (!fresh) {
      continue;
    }
    const summary = reconcileFreshSummaryInputQueue(existing, fresh.summary);
    if (summary === fresh.summary) {
      continue;
    }
    if (result === next) {
      result = new Map(next);
    }
    result.set(sessionId, { ...fresh, summary });
  }
  return result;
}

function providerSessionKey(summary: SessionProjection["summary"]): string | null {
  const providerSessionId = summary.session.providerSessionId;
  if (!providerSessionId) {
    return null;
  }
  return `${summary.session.provider}:${providerSessionId}`;
}

function isPendingStoredReplayProjection(
  sessionId: string,
  projection: SessionProjection,
): boolean {
  return (
    sessionId.startsWith("history:") &&
    projection.summary.session.runtime?.kind === "stored_history" &&
    projection.conversation?.phase === "loading"
  );
}

function preservePendingStoredReplayProjections(
  next: Map<string, SessionProjection>,
  current: Map<string, SessionProjection>,
): Map<string, SessionProjection> {
  const serverProviderSessions = new Set(
    [...next.values()]
      .map((projection) => providerSessionKey(projection.summary))
      .filter((key): key is string => key !== null),
  );
  let result = next;
  for (const [sessionId, projection] of current) {
    if (!isPendingStoredReplayProjection(sessionId, projection)) {
      continue;
    }
    const key = providerSessionKey(projection.summary);
    if (key && serverProviderSessions.has(key)) {
      continue;
    }
    if (result === next) {
      result = new Map(next);
    }
    result.set(sessionId, projection);
  }
  return result;
}

function isInteractiveRunningProjection(projection: SessionProjection): boolean {
  return projection.summary.session.status === "running" && !isReadOnlyReplay(projection.summary);
}

function interactiveRunningWorkspaceRoots(
  projections: ReadonlyMap<string, SessionProjection>,
): Array<string | undefined> {
  const roots: Array<string | undefined> = [];
  for (const projection of projections.values()) {
    if (!isInteractiveRunningProjection(projection)) {
      continue;
    }
    roots.push(projection.summary.session.rootDir || projection.summary.session.cwd);
  }
  return roots;
}

function coerceSelectedProjectionId(
  projections: Map<string, SessionProjection>,
  current: Map<string, SessionProjection>,
  selectedSessionId: string | null,
): string | null {
  const direct = coerceSelectedSessionId(projections, selectedSessionId);
  if (direct || !selectedSessionId) {
    return direct;
  }
  const selected = current.get(selectedSessionId);
  const selectedKey = selected ? providerSessionKey(selected.summary) : null;
  if (!selectedKey) {
    return null;
  }
  for (const projection of projections.values()) {
    if (providerSessionKey(projection.summary) === selectedKey) {
      return projection.summary.session.id;
    }
  }
  return null;
}

type ProjectionStateSlice = {
  projections: Map<string, SessionProjection>;
  pinnedSidebarItems?: WorkbenchPinnedItemRef[];
  workspaceDir: string;
  selectedSessionId: string | null;
  hiddenWorkspaceDirs: Set<string>;
  workspaceVisibilityVersion: number;
};

type ProjectionEventHandling = {
  updateLastSeq: (seq: number) => void;
  clearPendingSession: (sessionId: string) => void;
  queuePendingEvent: (event: RahEvent) => void;
};

type ProjectionReplay = {
  takePendingEventsForSessions: (sessionIds: Set<string>) => RahEvent[];
} & ProjectionEventHandling;

function shouldMarkSessionUnread(event: RahEvent): boolean {
  switch (event.type) {
    case "timeline.item.added":
    case "timeline.item.updated":
    case "message.part.added":
    case "message.part.updated":
    case "message.part.delta":
    case "tool.call.completed":
    case "tool.call.failed":
    case "observation.completed":
    case "observation.failed":
    case "permission.requested":
    case "notification.emitted":
    case "turn.completed":
    case "turn.failed":
    case "turn.canceled":
      return true;
    case "session.side.state.changed":
      return event.payload.state === "expired" || event.payload.state === "cleanup_failed";
    default:
      return false;
  }
}

export function computeUnreadSessionIds(
  currentUnreadSessionIds: ReadonlySet<string>,
  visibleSessionIds: ReadonlySet<string>,
  events: readonly RahEvent[],
): Set<string> {
  const nextUnreadSessionIds = new Set(currentUnreadSessionIds);
  for (const event of events) {
    if (event.type === "session.closed") {
      nextUnreadSessionIds.delete(event.sessionId);
      continue;
    }
    if (!visibleSessionIds.has(event.sessionId) && shouldMarkSessionUnread(event)) {
      nextUnreadSessionIds.add(event.sessionId);
    }
  }
  for (const sessionId of visibleSessionIds) {
    nextUnreadSessionIds.delete(sessionId);
  }
  return nextUnreadSessionIds;
}

export function applyEventBatchToProjection(
  projection: SessionProjection,
  events: RahEvent[],
): SessionProjection {
  let next = projection;
  for (const event of [...events].sort((a, b) => a.seq - b.seq)) {
    next = applyEventToProjection(next, event);
  }
  return compactRecoverableLiveProjectionFeed(next);
}

function createProjectionFromSessionEvent(
  event: Extract<RahEvent, { type: "session.created" | "session.started" }>,
): SessionProjection {
  return {
    summary: {
      session: event.payload.session,
      attachedClients: [],
      controlLease: { sessionId: event.payload.session.id },
    },
    feed: [],
    events: [],
    lastSeq: 0,
  };
}

export function adoptExistingProjectionForProviderSession(
  projections: Map<string, SessionProjection>,
  summary: SessionProjection["summary"],
): Map<string, SessionProjection> {
  const providerSessionId = summary.session.providerSessionId;
  if (!providerSessionId) {
    return projections;
  }
  const existingEntry = [...projections.entries()].find(
    ([sessionId, projection]) =>
      sessionId !== summary.session.id &&
      projection.summary.session.provider === summary.session.provider &&
      projection.summary.session.providerSessionId === providerSessionId,
  );
  if (!existingEntry) {
    return projections;
  }
  const [existingSessionId, existingProjection] = existingEntry;
  const next = new Map(projections);
  next.delete(existingSessionId);
  next.set(summary.session.id, {
    ...existingProjection,
    summary,
  });
  return next;
}

export function updateSessionSummaryInProjectionMap(
  projections: Map<string, SessionProjection>,
  summary: SessionProjection["summary"],
): Map<string, SessionProjection> {
  const next = new Map(projections);
  const projection = next.get(summary.session.id);
  if (projection) {
    next.set(summary.session.id, projectionWithFreshSummary(projection, summary));
  }
  return next;
}

export function applyEventsToProjectionMap(
  current: Map<string, SessionProjection>,
  events: RahEvent[],
  handling: ProjectionEventHandling,
): Map<string, SessionProjection> {
  if (events.length === 0) {
    return current;
  }
  let next = current;
  const writable = () => {
    if (next === current) {
      next = new Map(current);
    }
    return next;
  };
  const touchedSessionIds = new Set<string>();
  for (const event of [...events].sort((a, b) => a.seq - b.seq)) {
    handling.updateLastSeq(event.seq);
    // Incremental process output is a lossy data-plane stream. The canonical
    // conversation and final process snapshot own rendered state, so copying
    // it into the global projection map would only invalidate the entire app
    // for every stdout batch.
    if (event.type === "process.output.appended") {
      continue;
    }
    if (event.type === "session.closed") {
      if (next.has(event.sessionId)) {
        writable().delete(event.sessionId);
      }
      handling.clearPendingSession(event.sessionId);
      continue;
    }
    let projection = next.get(event.sessionId);
    if (
      !projection &&
      (event.type === "session.created" || event.type === "session.started")
    ) {
      projection = createProjectionFromSessionEvent(event);
      writable().set(event.sessionId, projection);
    }
    if (!projection) {
      handling.queuePendingEvent(event);
      continue;
    }
    writable().set(event.sessionId, applyEventToProjection(projection, event));
    touchedSessionIds.add(event.sessionId);
  }
  for (const sessionId of touchedSessionIds) {
    const projection = next.get(sessionId);
    if (!projection) {
      continue;
    }
    const compacted = compactRecoverableLiveProjectionFeed(projection);
    if (compacted !== projection) {
      writable().set(sessionId, compacted);
    }
  }
  return next;
}

export function mergeSessionsIntoProjections(
  current: Map<string, SessionProjection>,
  sessionsResponse: SessionsResponse,
  replay: ProjectionReplay,
): Map<string, SessionProjection> {
  const sessionMap = createSessionMap(sessionsResponse);
  let next = new Map(sessionMap.sessions);
  for (const [sessionId, existing] of current) {
    const fresh = next.get(sessionId);
    if (fresh) {
      next.set(sessionId, projectionWithFreshSummary(existing, fresh.summary));
    }
  }
  next = preservePendingStoredReplayProjections(next, current);
  return applyEventsToProjectionMap(
    next,
    replay.takePendingEventsForSessions(new Set(next.keys())),
    replay,
  );
}

export function applySessionsResponse(
  state: ProjectionStateSlice,
  sessionsResponse: SessionsResponse,
  replay: ProjectionReplay,
  options?: {
    workspaceVisibilityVersionAtRequest?: number;
  },
): Pick<
  ProjectionStateSlice,
  | "projections"
  | "hiddenWorkspaceDirs"
  | "workspaceVisibilityVersion"
  | "workspaceDir"
  | "selectedSessionId"
> & {
  storedSessions: SessionsResponse["storedSessions"];
  recentSessions: SessionsResponse["recentSessions"];
  workspaceDirs: string[];
  pinnedSidebarItems: WorkbenchPinnedItemRef[];
} {
  const projections = mergeSessionsIntoProjections(state.projections, sessionsResponse, replay);
  const hiddenWorkspaceDirs = resolveHiddenWorkspaceDirsFromSessionsResponse({
    currentHiddenWorkspaceDirs: state.hiddenWorkspaceDirs,
    currentWorkspaceVisibilityVersion: state.workspaceVisibilityVersion,
    workspaceVisibilityVersionAtRequest:
      options?.workspaceVisibilityVersionAtRequest ?? state.workspaceVisibilityVersion,
    hiddenWorkspaces: sessionsResponse.hiddenWorkspaces,
  });
  const workspaceDirs = deriveVisibleWorkspaceDirs({
    explicitWorkspaceDirs: sessionsResponse.workspaceDirs,
    inferredWorkspaceDirs: interactiveRunningWorkspaceRoots(projections),
    hiddenWorkspaceDirs,
  });
  const workspace = reconcileVisibleWorkspaceSelection({
    workspaceDirs,
    sessions: sessionsResponse.sessions,
    storedSessions: sessionsResponse.storedSessions,
    activeWorkspaceDir: sessionsResponse.activeWorkspaceDir,
    currentWorkspaceDir: state.workspaceDir,
    hiddenWorkspaceDirs,
  });
  return {
    projections,
    storedSessions: sessionsResponse.storedSessions,
    recentSessions: sessionsResponse.recentSessions,
    pinnedSidebarItems: (sessionsResponse.pinnedSidebarItems ?? []).map((item) => ({ ...item })),
    workspaceDirs: workspace.workspaceDirs,
    hiddenWorkspaceDirs,
    workspaceVisibilityVersion: state.workspaceVisibilityVersion,
    workspaceDir: workspace.workspaceDir,
    selectedSessionId: coerceSelectedProjectionId(
      projections,
      state.projections,
      state.selectedSessionId,
    ),
  };
}

export function replaceSessionsResponse(
  state: Pick<
    ProjectionStateSlice,
    | "projections"
    | "workspaceDir"
    | "selectedSessionId"
    | "hiddenWorkspaceDirs"
    | "workspaceVisibilityVersion"
  >,
  sessionsResponse: SessionsResponse,
  options?: {
    workspaceVisibilityVersionAtRequest?: number;
  },
): Pick<
  ProjectionStateSlice,
  | "projections"
  | "hiddenWorkspaceDirs"
  | "workspaceVisibilityVersion"
  | "workspaceDir"
  | "selectedSessionId"
> & {
  storedSessions: SessionsResponse["storedSessions"];
  recentSessions: SessionsResponse["recentSessions"];
  workspaceDirs: string[];
} {
  const hiddenWorkspaceDirs = resolveHiddenWorkspaceDirsFromSessionsResponse({
    currentHiddenWorkspaceDirs: state.hiddenWorkspaceDirs,
    currentWorkspaceVisibilityVersion: state.workspaceVisibilityVersion,
    workspaceVisibilityVersionAtRequest:
      options?.workspaceVisibilityVersionAtRequest ?? state.workspaceVisibilityVersion,
    hiddenWorkspaces: sessionsResponse.hiddenWorkspaces,
  });
  const sessionMap = createSessionMap(sessionsResponse);
  const projections = preservePendingStoredReplayProjections(
    reconcileReplacementInputQueues(sessionMap.sessions, state.projections),
    state.projections,
  );
  const workspaceDirs = deriveVisibleWorkspaceDirs({
    explicitWorkspaceDirs: sessionsResponse.workspaceDirs,
    inferredWorkspaceDirs: interactiveRunningWorkspaceRoots(projections),
    hiddenWorkspaceDirs,
  });
  const workspace = reconcileVisibleWorkspaceSelection({
    workspaceDirs,
    sessions: sessionsResponse.sessions,
    storedSessions: sessionsResponse.storedSessions,
    activeWorkspaceDir: sessionsResponse.activeWorkspaceDir,
    currentWorkspaceDir: state.workspaceDir,
    hiddenWorkspaceDirs,
  });
  return {
    projections,
    storedSessions: sessionsResponse.storedSessions,
    recentSessions: sessionsResponse.recentSessions,
    workspaceDirs: workspace.workspaceDirs,
    hiddenWorkspaceDirs,
    workspaceVisibilityVersion: state.workspaceVisibilityVersion,
    workspaceDir: workspace.workspaceDir,
    selectedSessionId: coerceSelectedProjectionId(
      projections,
      state.projections,
      state.selectedSessionId,
    ),
  };
}

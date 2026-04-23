import type { RahEvent } from "@rah/runtime-protocol";
import {
  coerceSelectedSessionId,
  reconcileVisibleWorkspaceSelection,
  resolveHiddenWorkspaceDirsFromSessionsResponse,
} from "./session-store-workspace";
import {
  applyEventToProjection,
  createSessionMap,
  initialHistorySyncState,
  type SessionProjection,
  type SessionsResponse,
} from "./types";

type ProjectionStateSlice = {
  projections: Map<string, SessionProjection>;
  workspaceDir: string;
  selectedSessionId: string | null;
  hiddenWorkspaceDirs: Set<string>;
  workspaceVisibilityVersion: number;
};

type ProjectionEventHandling = {
  updateLastSeq: (seq: number) => void;
  clearBufferedSession: (sessionId: string) => void;
  queuePendingEvent: (event: RahEvent) => void;
  shouldDeferEvent: (projection: SessionProjection, event: RahEvent) => boolean;
  queueDeferredEvent: (event: RahEvent) => void;
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
    case "attention.required":
    case "notification.emitted":
    case "turn.completed":
    case "turn.failed":
    case "turn.canceled":
      return true;
    default:
      return false;
  }
}

export function computeUnreadSessionIds(
  currentUnreadSessionIds: ReadonlySet<string>,
  selectedSessionId: string | null,
  events: readonly RahEvent[],
): Set<string> {
  const nextUnreadSessionIds = new Set(currentUnreadSessionIds);
  for (const event of events) {
    if (event.type === "session.closed") {
      nextUnreadSessionIds.delete(event.sessionId);
      continue;
    }
    if (selectedSessionId !== event.sessionId && shouldMarkSessionUnread(event)) {
      nextUnreadSessionIds.add(event.sessionId);
    }
  }
  if (selectedSessionId) {
    nextUnreadSessionIds.delete(selectedSessionId);
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
  return next;
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
    history: initialHistorySyncState(),
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
    next.set(summary.session.id, { ...projection, summary });
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
  const next = new Map(current);
  for (const event of [...events].sort((a, b) => a.seq - b.seq)) {
    handling.updateLastSeq(event.seq);
    if (event.type === "session.closed") {
      next.delete(event.sessionId);
      handling.clearBufferedSession(event.sessionId);
      continue;
    }
    let projection = next.get(event.sessionId);
    if (
      !projection &&
      (event.type === "session.created" || event.type === "session.started")
    ) {
      projection = createProjectionFromSessionEvent(event);
      next.set(event.sessionId, projection);
    }
    if (!projection) {
      handling.queuePendingEvent(event);
      continue;
    }
    if (handling.shouldDeferEvent(projection, event)) {
      handling.queueDeferredEvent(event);
      continue;
    }
    next.set(event.sessionId, applyEventToProjection(projection, event));
  }
  return next;
}

export function mergeSessionsIntoProjections(
  current: Map<string, SessionProjection>,
  sessionsResponse: SessionsResponse,
  replay: ProjectionReplay,
): Map<string, SessionProjection> {
  const sessionMap = createSessionMap(sessionsResponse);
  const next = new Map(sessionMap.sessions);
  for (const [sessionId, existing] of current) {
    const fresh = next.get(sessionId);
    if (fresh) {
      next.set(sessionId, {
        ...existing,
        summary: fresh.summary,
      });
    }
  }
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
} {
  const projections = mergeSessionsIntoProjections(state.projections, sessionsResponse, replay);
  const hiddenWorkspaceDirs = resolveHiddenWorkspaceDirsFromSessionsResponse({
    currentHiddenWorkspaceDirs: state.hiddenWorkspaceDirs,
    currentWorkspaceVisibilityVersion: state.workspaceVisibilityVersion,
    workspaceVisibilityVersionAtRequest:
      options?.workspaceVisibilityVersionAtRequest ?? state.workspaceVisibilityVersion,
    hiddenWorkspaces: sessionsResponse.hiddenWorkspaces,
  });
  const workspace = reconcileVisibleWorkspaceSelection({
    workspaceDirs: sessionsResponse.workspaceDirs,
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
    selectedSessionId: coerceSelectedSessionId(projections, state.selectedSessionId),
  };
}

export function replaceSessionsResponse(
  state: Pick<
    ProjectionStateSlice,
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
  const workspace = reconcileVisibleWorkspaceSelection({
    workspaceDirs: sessionsResponse.workspaceDirs,
    sessions: sessionsResponse.sessions,
    storedSessions: sessionsResponse.storedSessions,
    activeWorkspaceDir: sessionsResponse.activeWorkspaceDir,
    currentWorkspaceDir: state.workspaceDir,
    hiddenWorkspaceDirs,
  });
  const sessionMap = createSessionMap(sessionsResponse);
  return {
    projections: sessionMap.sessions,
    storedSessions: sessionsResponse.storedSessions,
    recentSessions: sessionsResponse.recentSessions,
    workspaceDirs: workspace.workspaceDirs,
    hiddenWorkspaceDirs,
    workspaceVisibilityVersion: state.workspaceVisibilityVersion,
    workspaceDir: workspace.workspaceDir,
    selectedSessionId: coerceSelectedSessionId(sessionMap.sessions, state.selectedSessionId),
  };
}

import type { EventBatch, RahEvent } from "@rah/runtime-protocol";
import * as api from "./api";
import { isReadOnlyReplay } from "./session-capabilities";
import { readErrorMessage } from "./session-store-bootstrap";
import { mergeClaimedHistoryProjection } from "./session-store-session-lifecycle";
import { connectSessionStoreTransport } from "./session-store-transport";
import type { PendingSessionTransition } from "./session-transition-contract";
import type { SessionProjection } from "./types";

let recoverTransportInFlight: Promise<void> | null = null;

type SessionSyncState = {
  projections: Map<string, SessionProjection>;
  unreadSessionIds: Set<string>;
  selectedSessionId: string | null;
  workspaceVisibilityVersion: number;
  sessionTopologyVersion: number;
  pendingSessionTransition: PendingSessionTransition | null;
  pendingSessionAction:
    | {
        kind: "attach_session" | "claim_control" | "claim_history";
        sessionId: string;
      }
    | null;
  error: string | null;
};

type SessionSyncSetState = (
  partial:
    | Partial<SessionSyncState>
    | ((state: SessionSyncState) => Partial<SessionSyncState> | SessionSyncState),
) => void;

function hiddenMessagePartEvent(event: RahEvent): boolean {
  if (
    event.type !== "message.part.added" &&
    event.type !== "message.part.updated" &&
    event.type !== "message.part.delta"
  ) {
    return false;
  }
  const kind = event.payload.part.kind;
  return kind === "text" || kind === "reasoning" || kind === "step";
}

function timelineCoalesceKey(event: RahEvent): string | null {
  if (event.type !== "timeline.item.added" && event.type !== "timeline.item.updated") {
    return null;
  }
  const canonicalItemId = event.payload.identity?.canonicalItemId;
  return canonicalItemId ? `timeline:${canonicalItemId}` : null;
}

export function coalesceProjectionEvents(events: RahEvent[]): RahEvent[] {
  const result: RahEvent[] = [];
  const indexByKey = new Map<string, number>();

  for (const event of events) {
    if (hiddenMessagePartEvent(event)) {
      continue;
    }
    const key = timelineCoalesceKey(event);
    if (key) {
      const existingIndex = indexByKey.get(key);
      if (existingIndex !== undefined) {
        result[existingIndex] = event;
        continue;
      }
      indexByKey.set(key, result.length);
    }
    result.push(event);
  }

  return result;
}

function selectedClaimedReplayClosedByEvents(
  state: SessionSyncState,
  events: readonly RahEvent[],
): SessionProjection | null {
  const pendingAction = state.pendingSessionAction;
  if (
    pendingAction?.kind !== "claim_history" ||
    pendingAction.sessionId !== state.selectedSessionId
  ) {
    return null;
  }
  const selectedProjection = state.projections.get(pendingAction.sessionId);
  if (!selectedProjection || !isReadOnlyReplay(selectedProjection.summary)) {
    return null;
  }
  return events.some(
    (event) =>
      event.type === "session.closed" &&
      event.sessionId === selectedProjection.summary.session.id,
  )
    ? selectedProjection
    : null;
}

function findLiveProjectionForReplay(
  projections: ReadonlyMap<string, SessionProjection>,
  replayProjection: SessionProjection,
): SessionProjection | null {
  const providerSessionId = replayProjection.summary.session.providerSessionId;
  if (!providerSessionId) {
    return null;
  }
  for (const projection of projections.values()) {
    if (
      projection.summary.session.id !== replayProjection.summary.session.id &&
      projection.summary.session.provider === replayProjection.summary.session.provider &&
      projection.summary.session.providerSessionId === providerSessionId &&
      !isReadOnlyReplay(projection.summary)
    ) {
      return projection;
    }
  }
  return null;
}

function eventsMayChangeSessionTopology(events: readonly RahEvent[]): boolean {
  return events.some(
    (event) =>
      event.type === "session.created" ||
      event.type === "session.started" ||
      event.type === "session.closed",
  );
}

export function applyProjectionEventsToSyncState(args: {
  state: SessionSyncState;
  events: RahEvent[];
  applyEventsToMap: (
    current: Map<string, SessionProjection>,
    events: RahEvent[],
  ) => Map<string, SessionProjection>;
}): Pick<SessionSyncState, "projections" | "selectedSessionId" | "sessionTopologyVersion"> {
  const claimedReplay = selectedClaimedReplayClosedByEvents(args.state, args.events);
  const projections = args.applyEventsToMap(args.state.projections, args.events);
  const sessionTopologyVersion = eventsMayChangeSessionTopology(args.events)
    ? args.state.sessionTopologyVersion + 1
    : args.state.sessionTopologyVersion;
  if (!claimedReplay) {
    return {
      projections,
      selectedSessionId: args.state.selectedSessionId,
      sessionTopologyVersion,
    };
  }
  const liveProjection = findLiveProjectionForReplay(projections, claimedReplay);
  if (liveProjection) {
    const next = new Map(projections);
    next.set(
      liveProjection.summary.session.id,
      mergeClaimedHistoryProjection(
        liveProjection.summary,
        claimedReplay,
        liveProjection,
      ),
    );
    return {
      projections: next,
      selectedSessionId: liveProjection.summary.session.id,
      sessionTopologyVersion,
    };
  }
  const next = new Map(projections);
  next.set(claimedReplay.summary.session.id, claimedReplay);
  return {
    projections: next,
    selectedSessionId: claimedReplay.summary.session.id,
    sessionTopologyVersion,
  };
}

function shouldSkipSessionsResponse(
  state: SessionSyncState,
  sessionTopologyVersionAtRequest: number,
): boolean {
  return (
    state.sessionTopologyVersion !== sessionTopologyVersionAtRequest ||
    state.pendingSessionAction?.kind === "claim_history"
  );
}

export async function recoverFromReplayGapCommand(args: {
  batch: EventBatch;
  get: () => SessionSyncState;
  set: SessionSyncSetState;
  clearHistoryBootstrapBuffers: () => void;
  updateLastSeq: (seq: number) => void;
  replaceSessionsResponse: (
    state: Pick<
      SessionSyncState,
      "projections" | "selectedSessionId" | "workspaceVisibilityVersion"
    > & {
      workspaceDir: string;
      hiddenWorkspaceDirs: Set<string>;
    },
    sessionsResponse: Awaited<ReturnType<typeof api.listSessions>>,
    options?: { workspaceVisibilityVersionAtRequest?: number },
  ) => {
    projections: Map<string, SessionProjection>;
    selectedSessionId: string | null;
    workspaceDir: string;
    hiddenWorkspaceDirs: Set<string>;
    workspaceVisibilityVersion: number;
    storedSessions: unknown;
    recentSessions: unknown;
    workspaceDirs: string[];
  };
  applyEventsToMap: (
    current: Map<string, SessionProjection>,
    events: RahEvent[],
  ) => Map<string, SessionProjection>;
  ensureSessionHistoryLoaded: (sessionId: string) => Promise<void>;
}) {
  args.clearHistoryBootstrapBuffers();
  if (
    args.batch.replayGap?.newestAvailableSeq !== null &&
    args.batch.replayGap?.newestAvailableSeq !== undefined
  ) {
    args.updateLastSeq(args.batch.replayGap.newestAvailableSeq);
  }
  const workspaceVisibilityVersionAtRequest = args.get().workspaceVisibilityVersion;
  const sessionTopologyVersionAtRequest = args.get().sessionTopologyVersion;
  const sessionsResponse = await api.listSessions();
  args.set((state) => {
    if (shouldSkipSessionsResponse(state, sessionTopologyVersionAtRequest)) {
      const projectionState = applyProjectionEventsToSyncState({
        state,
        events: args.batch.events,
        applyEventsToMap: args.applyEventsToMap,
      });
      return {
        ...projectionState,
        error:
          `Event stream replay gap detected. Requested seq ${args.batch.replayGap?.requestedFromSeq ?? "unknown"}, ` +
          `oldest available ${args.batch.replayGap?.oldestAvailableSeq ?? "unknown"}. Session views kept the latest local session state.`,
      };
    }
    const nextState = args.replaceSessionsResponse(state as never, sessionsResponse, {
      workspaceVisibilityVersionAtRequest,
    });
    const projectionState = applyProjectionEventsToSyncState({
      state: { ...state, ...nextState } as SessionSyncState,
      events: args.batch.events,
      applyEventsToMap: args.applyEventsToMap,
    });
    return {
      ...nextState,
      ...projectionState,
      error:
        `Event stream replay gap detected. Requested seq ${args.batch.replayGap?.requestedFromSeq ?? "unknown"}, ` +
        `oldest available ${args.batch.replayGap?.oldestAvailableSeq ?? "unknown"}. Session views were rebuilt from current state.`,
    };
  });
  const selectedSessionId = args.get().selectedSessionId;
  if (selectedSessionId) {
    void args.ensureSessionHistoryLoaded(selectedSessionId);
  }
}

export function connectStoreSyncTransport(args: {
  getReplayFromSeq: () => number | undefined;
  isInitialLoaded: () => boolean;
  set: SessionSyncSetState;
  getNotificationProjections: () => ReadonlyMap<string, SessionProjection>;
  applyEventsToMap: (
    current: Map<string, SessionProjection>,
    events: RahEvent[],
  ) => Map<string, SessionProjection>;
  computeUnreadSessionIds: (
    currentUnreadSessionIds: ReadonlySet<string>,
    selectedSessionId: string | null,
    events: readonly RahEvent[],
  ) => Set<string>;
  notifyUnreadEvents?: (args: {
    projections: ReadonlyMap<string, SessionProjection>;
    events: readonly RahEvent[];
  }) => void;
  recoverFromReplayGap: (batch: EventBatch) => Promise<void>;
  refreshWorkbenchState: (events: RahEvent[]) => Promise<void>;
}) {
  let pendingProjectionEvents: RahEvent[] = [];
  let pendingUnreadEvents: RahEvent[] = [];
  let pendingFlush: { kind: "frame" | "timer"; id: number } | null = null;

  const flushPendingEvents = () => {
    if (pendingFlush !== null) {
      if (pendingFlush.kind === "frame") {
        window.cancelAnimationFrame(pendingFlush.id);
      } else {
        window.clearTimeout(pendingFlush.id);
      }
      pendingFlush = null;
    }
    if (pendingProjectionEvents.length === 0) {
      pendingUnreadEvents = [];
      return;
    }
    const projectionEvents = coalesceProjectionEvents(pendingProjectionEvents);
    const unreadEvents = coalesceProjectionEvents(pendingUnreadEvents);
    pendingProjectionEvents = [];
    pendingUnreadEvents = [];
    if (unreadEvents.length > 0) {
      args.notifyUnreadEvents?.({
        projections: args.getNotificationProjections(),
        events: unreadEvents,
      });
    }
    args.set((state) => {
      const projectionState = applyProjectionEventsToSyncState({
        state,
        events: projectionEvents,
        applyEventsToMap: args.applyEventsToMap,
      });
      return {
        ...projectionState,
        unreadSessionIds:
          unreadEvents.length === 0
            ? state.unreadSessionIds
            : args.computeUnreadSessionIds(
                state.unreadSessionIds,
                projectionState.selectedSessionId,
                unreadEvents,
              ),
        error: state.error === "Events socket failed" ? null : state.error,
      };
    });
  };

  const schedulePendingEventFlush = () => {
    if (pendingFlush !== null) {
      return;
    }
    const runFlush = () => {
      pendingFlush = null;
      flushPendingEvents();
    };
    if (typeof document !== "undefined" && document.visibilityState === "hidden") {
      pendingFlush = { kind: "timer", id: window.setTimeout(runFlush, 0) };
      return;
    }
    pendingFlush = { kind: "frame", id: window.requestAnimationFrame(runFlush) };
  };

  const promotePendingFlushToBackgroundTimer = () => {
    if (
      pendingFlush?.kind !== "frame" ||
      typeof document === "undefined" ||
      document.visibilityState !== "hidden"
    ) {
      return;
    }
    window.cancelAnimationFrame(pendingFlush.id);
    pendingFlush = {
      kind: "timer",
      id: window.setTimeout(() => {
        pendingFlush = null;
        flushPendingEvents();
      }, 0),
    };
  };

  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", promotePendingFlushToBackgroundTimer);
  }

  connectSessionStoreTransport({
    getReplayFromSeq: args.getReplayFromSeq,
    isInitialLoaded: args.isInitialLoaded,
    onBatch: (batch) => {
      const projectionEvents =
        batch.events?.filter((event) => event.type !== "session.discovery") ?? [];
      if (projectionEvents.length === 0) {
        return;
      }
      pendingProjectionEvents = [...pendingProjectionEvents, ...projectionEvents];
      if (!batch.initial) {
        pendingUnreadEvents = [...pendingUnreadEvents, ...projectionEvents];
      }
      schedulePendingEventFlush();
    },
    onError: (error) => {
      args.set({ error: error.message });
    },
    onOpen: () => {
      args.set((state) => ({
        error: state.error === "Events socket failed" ? null : state.error,
      }));
    },
    onReplayGap: (batch) => {
      flushPendingEvents();
      void args.recoverFromReplayGap(batch);
    },
    onStoredSessionsRefresh: (events) => {
      void args.refreshWorkbenchState(events);
    },
  });
}

export async function recoverTransportCommand(args: {
  get: () => SessionSyncState & {
    workspaceDir: string;
    hiddenWorkspaceDirs: Set<string>;
  };
  set: SessionSyncSetState;
  applySessionsResponse: (
    state: Pick<
      SessionSyncState,
      "projections" | "selectedSessionId" | "workspaceVisibilityVersion"
    > & {
      workspaceDir: string;
      hiddenWorkspaceDirs: Set<string>;
    },
    sessionsResponse: Awaited<ReturnType<typeof api.listSessions>>,
    options?: { workspaceVisibilityVersionAtRequest?: number },
  ) => {
    projections: Map<string, SessionProjection>;
    selectedSessionId: string | null;
    workspaceDir: string;
    hiddenWorkspaceDirs: Set<string>;
    workspaceVisibilityVersion: number;
    storedSessions: unknown;
    recentSessions: unknown;
    workspaceDirs: string[];
  };
  restartTransport: () => void;
  maybeRestoreLastHistorySelection: (
    sessionsResponse: Awaited<ReturnType<typeof api.listSessions>>,
  ) => Promise<void>;
  listSessions?: typeof api.listSessions;
}) {
  if (recoverTransportInFlight) {
    return recoverTransportInFlight;
  }
  recoverTransportInFlight = recoverTransportCommandInner(args).finally(() => {
    recoverTransportInFlight = null;
  });
  return recoverTransportInFlight;
}

async function recoverTransportCommandInner(args: {
  get: () => SessionSyncState & {
    workspaceDir: string;
    hiddenWorkspaceDirs: Set<string>;
  };
  set: SessionSyncSetState;
  applySessionsResponse: (
    state: Pick<
      SessionSyncState,
      "projections" | "selectedSessionId" | "workspaceVisibilityVersion"
    > & {
      workspaceDir: string;
      hiddenWorkspaceDirs: Set<string>;
    },
    sessionsResponse: Awaited<ReturnType<typeof api.listSessions>>,
    options?: { workspaceVisibilityVersionAtRequest?: number },
  ) => {
    projections: Map<string, SessionProjection>;
    selectedSessionId: string | null;
    workspaceDir: string;
    hiddenWorkspaceDirs: Set<string>;
    workspaceVisibilityVersion: number;
    storedSessions: unknown;
    recentSessions: unknown;
    workspaceDirs: string[];
  };
  restartTransport: () => void;
  maybeRestoreLastHistorySelection: (
    sessionsResponse: Awaited<ReturnType<typeof api.listSessions>>,
  ) => Promise<void>;
  listSessions?: typeof api.listSessions;
}) {
  try {
    const requestState = args.get();
    const workspaceVisibilityVersionAtRequest = requestState.workspaceVisibilityVersion;
    const sessionTopologyVersionAtRequest = requestState.sessionTopologyVersion;
    const sessionsResponse = await (args.listSessions ?? api.listSessions)();
    args.set((state) => {
      if (shouldSkipSessionsResponse(state, sessionTopologyVersionAtRequest)) {
        return { error: null };
      }
      return {
        ...args.applySessionsResponse(state as never, sessionsResponse, {
          workspaceVisibilityVersionAtRequest,
        }),
        error: null,
      };
    });
    args.restartTransport();
    await args.maybeRestoreLastHistorySelection(sessionsResponse);
  } catch (error) {
    args.set({ error: readErrorMessage(error) });
    throw error;
  }
}

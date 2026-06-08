import type { EventBatch, RahEvent } from "@rah/runtime-protocol";
import * as api from "./api";
import { readErrorMessage } from "./session-store-bootstrap";
import { connectSessionStoreTransport } from "./session-store-transport";
import {
  connectedTransportStatus,
  nextReconnectTransportStatus,
  offlineTransportStatus,
  syncingTransportStatus,
  type TransportStatus,
} from "./transport-status";
import type { SessionProjection } from "./types";

let recoverTransportInFlight: Promise<void> | null = null;

type SessionSyncState = {
  projections: Map<string, SessionProjection>;
  unreadSessionIds: Set<string>;
  selectedSessionId: string | null;
  workspaceVisibilityVersion: number;
  error: string | null;
  transportStatus: TransportStatus;
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

export function maxEventSeq(events: readonly RahEvent[]): number | null {
  let maxSeq: number | null = null;
  for (const event of events) {
    maxSeq = maxSeq === null ? event.seq : Math.max(maxSeq, event.seq);
  }
  return maxSeq;
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
  const sessionsResponse = await api.listSessions({ storedSessions: "recent" });
  args.set((state) => {
    const nextState = args.replaceSessionsResponse(state as never, sessionsResponse, {
      workspaceVisibilityVersionAtRequest,
    });
    return {
      ...nextState,
      projections: args.applyEventsToMap(nextState.projections, args.batch.events),
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
  updateLastSeq: (seq: number) => void;
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
  refreshWorkbenchState: () => Promise<void>;
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
    args.set((state) => ({
      projections: args.applyEventsToMap(state.projections, projectionEvents),
      unreadSessionIds:
        unreadEvents.length === 0
          ? state.unreadSessionIds
          : args.computeUnreadSessionIds(
              state.unreadSessionIds,
              state.selectedSessionId,
              unreadEvents,
            ),
      error: state.error === "Events socket failed" ? null : state.error,
      transportStatus: connectedTransportStatus(),
    }));
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
      const newestSeq = maxEventSeq(projectionEvents);
      if (newestSeq !== null) {
        args.updateLastSeq(newestSeq);
      }
      pendingProjectionEvents = [...pendingProjectionEvents, ...projectionEvents];
      if (!batch.initial) {
        pendingUnreadEvents = [...pendingUnreadEvents, ...projectionEvents];
      }
      schedulePendingEventFlush();
    },
    onError: (error) => {
      args.set((state) => ({
        transportStatus: nextReconnectTransportStatus(state.transportStatus, error.message),
      }));
    },
    onOpen: () => {
      args.set((state) => ({
        error: state.error === "Events socket failed" ? null : state.error,
        transportStatus: connectedTransportStatus(),
      }));
    },
    onReconnectScheduled: () => {
      args.set((state) => ({
        transportStatus: nextReconnectTransportStatus(state.transportStatus),
      }));
    },
    onReplayGap: (batch) => {
      flushPendingEvents();
      void args.recoverFromReplayGap(batch);
    },
    onStoredSessionsRefresh: () => {
      void args.refreshWorkbenchState();
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
  markTransportRecoveryStarted(args.set);
  if (recoverTransportInFlight) {
    return recoverTransportInFlight;
  }
  recoverTransportInFlight = recoverTransportCommandInner(args).finally(() => {
    recoverTransportInFlight = null;
  });
  return recoverTransportInFlight;
}

function markTransportRecoveryStarted(set: SessionSyncSetState): void {
  set((state) => ({
    error: state.error === "Events socket failed" ? null : state.error,
    transportStatus: syncingTransportStatus(),
  }));
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
    const workspaceVisibilityVersionAtRequest = args.get().workspaceVisibilityVersion;
    const sessionsResponse = await (args.listSessions ?? api.listSessions)({
      storedSessions: "recent",
    });
    args.set((state) => ({
      ...args.applySessionsResponse(state as never, sessionsResponse, {
        workspaceVisibilityVersionAtRequest,
      }),
      error: null,
      transportStatus: connectedTransportStatus(),
    }));
    args.restartTransport();
    await args.maybeRestoreLastHistorySelection(sessionsResponse);
  } catch (error) {
    const message = readErrorMessage(error);
    args.set((state) => ({
      transportStatus: offlineTransportStatus(state.transportStatus, message),
    }));
    throw error;
  }
}

import type { EventBatch, RahEvent } from "@rah/runtime-protocol";
import * as api from "./api";
import { readErrorMessage } from "./session-store-bootstrap";
import { connectSessionStoreTransport } from "./session-store-transport";
import type { SessionProjection } from "./types";

let recoverTransportInFlight: Promise<void> | null = null;

type SessionSyncState = {
  projections: Map<string, SessionProjection>;
  unreadSessionIds: Set<string>;
  selectedSessionId: string | null;
  workspaceVisibilityVersion: number;
  error: string | null;
};

type SessionSyncSetState = (
  partial:
    | Partial<SessionSyncState>
    | ((state: SessionSyncState) => Partial<SessionSyncState> | SessionSyncState),
) => void;

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
  const sessionsResponse = await api.listSessions();
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
  applyEventsToMap: (
    current: Map<string, SessionProjection>,
    events: RahEvent[],
  ) => Map<string, SessionProjection>;
  computeUnreadSessionIds: (
    currentUnreadSessionIds: ReadonlySet<string>,
    selectedSessionId: string | null,
    events: readonly RahEvent[],
  ) => Set<string>;
  recoverFromReplayGap: (batch: EventBatch) => Promise<void>;
  refreshWorkbenchState: () => Promise<void>;
}) {
  connectSessionStoreTransport({
    getReplayFromSeq: args.getReplayFromSeq,
    isInitialLoaded: args.isInitialLoaded,
    onBatch: (batch) => {
      const projectionEvents =
        batch.events?.filter((event) => event.type !== "session.discovery") ?? [];
      if (projectionEvents.length === 0) {
        return;
      }
      args.set((state) => ({
        projections: args.applyEventsToMap(state.projections, projectionEvents),
        unreadSessionIds: batch.initial
          ? state.unreadSessionIds
          : args.computeUnreadSessionIds(
              state.unreadSessionIds,
              state.selectedSessionId,
              projectionEvents,
            ),
        error: state.error === "Events socket failed" ? null : state.error,
      }));
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
    const workspaceVisibilityVersionAtRequest = args.get().workspaceVisibilityVersion;
    const sessionsResponse = await (args.listSessions ?? api.listSessions)();
    args.set((state) => ({
      ...args.applySessionsResponse(state as never, sessionsResponse, {
        workspaceVisibilityVersionAtRequest,
      }),
      error: null,
    }));
    args.restartTransport();
    await args.maybeRestoreLastHistorySelection(sessionsResponse);
  } catch (error) {
    args.set({ error: readErrorMessage(error) });
    throw error;
  }
}

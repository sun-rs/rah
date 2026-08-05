import type {
  ConversationProjectionDelta,
  EventBatch,
  RahEvent,
  StoredSessionRef,
} from "@rah/runtime-protocol";
import { composeConversationProjectionDeltas } from "@rah/runtime-protocol";
import * as api from "./api";
import { isReadOnlyReplay } from "./session-capabilities";
import { readErrorMessage } from "./session-store-bootstrap";
import {
  createStoppedReplayProjection,
  mergeResumedHistoryProjection,
} from "./session-store-session-lifecycle";
import { connectSessionStoreTransport } from "./session-store-transport";
import type { PendingSessionTransition } from "./session-transition-contract";
import { isTransportErrorMessage } from "./transport-error";
import { applyEventToProjection, type SessionProjection } from "./types";

export type RecoverTransportOptions = {
  signal?: AbortSignal;
  replaceActive?: boolean;
  suppressError?: boolean;
};

type RecoverTransportRequest = {
  controller: AbortController;
  promise: Promise<void>;
};

let recoverTransportInFlight: RecoverTransportRequest | null = null;

export const FOREGROUND_SYNC_FLUSH_INTERVAL_MS = 50;
export const BACKGROUND_SYNC_FLUSH_INTERVAL_MS = 250;
const MAX_PENDING_SYNC_EVENTS = 2_048;
const MAX_SYNC_EVENTS_PER_FLUSH = 192;
const MAX_SYNC_DELTAS_PER_FLUSH = 64;
const MAX_COALESCED_PROCESS_OUTPUT_CHARS = 256 * 1024;
const MAX_PENDING_SYNC_EVENT_BYTES = 16 * 1024 * 1024;
export const MAX_SYNC_EVENT_BYTES_PER_FLUSH = 1024 * 1024;

export function resolveSyncFlushPlan(args: {
  hidden: boolean;
  elapsedSinceLastFlushMs: number;
}): { kind: "frame" } | { kind: "timer"; delayMs: number } {
  if (args.hidden) {
    return {
      kind: "timer",
      delayMs: BACKGROUND_SYNC_FLUSH_INTERVAL_MS,
    };
  }
  const remainingMs =
    FOREGROUND_SYNC_FLUSH_INTERVAL_MS -
    Math.max(0, args.elapsedSinceLastFlushMs);
  return remainingMs <= 0
    ? { kind: "frame" }
    : { kind: "timer", delayMs: Math.ceil(remainingMs) };
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function createAbortError(): Error {
  const error = new Error("The operation was aborted.");
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) {
    return;
  }
  throw createAbortError();
}

function createLinkedAbortController(signal: AbortSignal | undefined): {
  controller: AbortController;
  detach: () => void;
} {
  const controller = new AbortController();
  if (!signal) {
    return { controller, detach: () => undefined };
  }
  const abort = () => controller.abort(signal.reason);
  if (signal.aborted) {
    abort();
    return { controller, detach: () => undefined };
  }
  signal.addEventListener("abort", abort, { once: true });
  return {
    controller,
    detach: () => signal.removeEventListener("abort", abort),
  };
}

type SessionSyncState = {
  projections: Map<string, SessionProjection>;
  unreadSessionIds: Set<string>;
  selectedSessionId: string | null;
  workspaceVisibilityVersion: number;
  sessionTopologyVersion: number;
  eventStreamOpenRevision: number;
  storedSessions: StoredSessionRef[];
  recentSessions: StoredSessionRef[];
  storedSessionsCatalogLoaded?: boolean;
  pendingSessionTransition: PendingSessionTransition | null;
  pendingSessionAction:
    | {
        kind: "attach_session" | "claim_control" | "resume_history";
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

export function splitProjectionTransportEvents(events: readonly RahEvent[]): {
  projectionEvents: RahEvent[];
  dataPlaneSeq: number | null;
} {
  const projectionEvents: RahEvent[] = [];
  let dataPlaneSeq: number | null = null;
  for (const event of events) {
    if (
      event.type === "process.output.appended" ||
      event.type === "session.discovery" ||
      hiddenMessagePartEvent(event)
    ) {
      dataPlaneSeq =
        dataPlaneSeq === null ? event.seq : Math.max(dataPlaneSeq, event.seq);
      continue;
    }
    projectionEvents.push(event);
  }
  return { projectionEvents, dataPlaneSeq };
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
  const outputByKey = new Map<
    string,
    {
      index: number;
      chunks: string[];
      latest: Extract<RahEvent, { type: "process.output.appended" }>;
    }
  >();

  for (const event of events) {
    if (hiddenMessagePartEvent(event)) {
      continue;
    }
    if (event.type === "process.output.appended") {
      const key = `process-output:${event.sessionId}:${event.payload.output.itemId}:${event.payload.output.stream}`;
      const existing = outputByKey.get(key);
      if (existing) {
        existing.chunks.push(event.payload.output.data);
        existing.latest = event;
        continue;
      }
      outputByKey.set(key, {
        index: result.length,
        chunks: [event.payload.output.data],
        latest: event,
      });
      result.push(event);
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

  // Materialize each process tail once. Repeatedly concatenating a growing
  // string here is quadratic and lets a chatty child process monopolize the
  // browser main thread even though the final visible tail is bounded.
  for (const { index, chunks, latest } of outputByKey.values()) {
    const data = chunks
      .join("")
      .slice(-MAX_COALESCED_PROCESS_OUTPUT_CHARS);
    result[index] = {
      ...latest,
      payload: {
        output: {
          ...latest.payload.output,
          data,
          offsetBytes: Math.max(
            0,
            latest.payload.output.totalBytes -
              new TextEncoder().encode(data).byteLength,
          ),
        },
      },
    };
  }
  return result;
}

export function syncEventApproximateBytes(event: RahEvent): number {
  return event.type === "process.output.appended"
    ? 256 + new TextEncoder().encode(event.payload.output.data).byteLength
    : 2_048;
}

export function takeSyncEventPrefix(
  events: readonly RahEvent[],
  options: {
    maxEvents?: number;
    maxBytes?: number;
  } = {},
): { selected: RahEvent[]; remaining: RahEvent[] } {
  const maxEvents = Math.max(1, options.maxEvents ?? MAX_SYNC_EVENTS_PER_FLUSH);
  const maxBytes = Math.max(
    1,
    options.maxBytes ?? MAX_SYNC_EVENT_BYTES_PER_FLUSH,
  );
  let bytes = 0;
  let count = 0;
  for (const event of events) {
    const eventBytes = syncEventApproximateBytes(event);
    if (
      count > 0 &&
      (count >= maxEvents || bytes + eventBytes > maxBytes)
    ) {
      break;
    }
    bytes += eventBytes;
    count += 1;
  }
  return {
    selected: events.slice(0, count),
    remaining: events.slice(count),
  };
}

export function coalesceConversationProjectionDeltas(
  deltas: readonly ConversationProjectionDelta[],
): ConversationProjectionDelta[] {
  return composeConversationProjectionDeltas(deltas);
}

function appendPendingValues<T>(target: T[], values: readonly T[]): void {
  for (const value of values) {
    target.push(value);
  }
}

function compactPendingProjectionEvents(events: RahEvent[]): {
  events: RahEvent[];
  bytes: number;
} {
  const coalesced = coalesceProjectionEvents(events);
  let bytes = coalesced.reduce(
    (total, event) => total + syncEventApproximateBytes(event),
    0,
  );
  let count = coalesced.length;
  if (
    count < MAX_PENDING_SYNC_EVENTS &&
    bytes < MAX_PENDING_SYNC_EVENT_BYTES
  ) {
    return { events: coalesced, bytes };
  }

  // Process append frames are a lossy live tail backed by a final snapshot and
  // the daemon detail store. Under pressure discard their oldest coalesced
  // tails before sacrificing semantic lifecycle or reconnecting the stream.
  const keep = coalesced.map(() => true);
  for (
    let index = 0;
    index < coalesced.length &&
    (count >= MAX_PENDING_SYNC_EVENTS ||
      bytes >= MAX_PENDING_SYNC_EVENT_BYTES);
    index += 1
  ) {
    const event = coalesced[index];
    if (event?.type !== "process.output.appended") {
      continue;
    }
    keep[index] = false;
    count -= 1;
    bytes -= syncEventApproximateBytes(event);
  }
  return {
    events: coalesced.filter((_event, index) => keep[index]),
    bytes,
  };
}

function selectedResumedReplayClosedByEvents(
  state: SessionSyncState,
  events: readonly RahEvent[],
): SessionProjection | null {
  const pendingAction = state.pendingSessionAction;
  if (
    pendingAction?.kind !== "resume_history" ||
    pendingAction.sessionId !== state.selectedSessionId
  ) {
    return null;
  }
  const selectedProjection = state.projections.get(pendingAction.sessionId);
  // Sending from history deliberately upgrades the local replay projection to
  // Starting before the daemon closes that replay. The explicit pending Resume
  // action, rather than its now-interactive capability flags, owns this handoff.
  if (!selectedProjection) {
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

function selectedSessionClosedByEvents(
  state: SessionSyncState,
  events: readonly RahEvent[],
): SessionProjection | null {
  const selectedSessionId = state.selectedSessionId;
  const selectedProjection = selectedSessionId
    ? state.projections.get(selectedSessionId)
    : undefined;
  if (
    !selectedProjection ||
    !selectedProjection.summary.session.providerSessionId
  ) {
    return null;
  }

  // A stopped replay can be produced by an earlier copy of the same close
  // event. Keep it selected until the explicit close command (when the user is
  // deleting a history replay) applies its HTTP result. Without this branch, a
  // duplicated/replayed session.closed event deletes the projection and makes
  // an explicitly stopped chat fall back to New Task.
  if (isReadOnlyReplay(selectedProjection.summary)) {
    return events.some(
      (event) =>
        event.type === "session.closed" && event.sessionId === selectedSessionId,
    )
      ? selectedProjection
      : null;
  }
  if (selectedProjection.summary.session.status !== "running") {
    return null;
  }

  let latestProjection = selectedProjection;
  for (const event of [...events].sort((left, right) => left.seq - right.seq)) {
    if (event.sessionId !== selectedSessionId) {
      continue;
    }
    if (event.type === "session.closed") {
      return createStoppedReplayProjection(latestProjection);
    }
    if (event.type !== "process.output.appended") {
      latestProjection = applyEventToProjection(latestProjection, event);
    }
  }
  return null;
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
  const resumedReplay = selectedResumedReplayClosedByEvents(args.state, args.events);
  const stoppedReplay = resumedReplay
    ? null
    : selectedSessionClosedByEvents(args.state, args.events);
  const projections = args.applyEventsToMap(args.state.projections, args.events);
  const sessionTopologyVersion = eventsMayChangeSessionTopology(args.events)
    ? args.state.sessionTopologyVersion + 1
    : args.state.sessionTopologyVersion;
  if (!resumedReplay && !stoppedReplay) {
    return {
      projections,
      selectedSessionId: args.state.selectedSessionId,
      sessionTopologyVersion,
    };
  }
  if (stoppedReplay) {
    const next = new Map(projections);
    next.set(stoppedReplay.summary.session.id, stoppedReplay);
    return {
      projections: next,
      selectedSessionId: stoppedReplay.summary.session.id,
      sessionTopologyVersion,
    };
  }
  if (!resumedReplay) {
    return {
      projections,
      selectedSessionId: args.state.selectedSessionId,
      sessionTopologyVersion,
    };
  }
  const liveProjection = findLiveProjectionForReplay(projections, resumedReplay);
  if (liveProjection) {
    const next = new Map(projections);
    next.set(
      liveProjection.summary.session.id,
      mergeResumedHistoryProjection(
        liveProjection.summary,
        resumedReplay,
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
  next.set(resumedReplay.summary.session.id, resumedReplay);
  return {
    projections: next,
    selectedSessionId: resumedReplay.summary.session.id,
    sessionTopologyVersion,
  };
}

function shouldSkipSessionsResponse(
  state: SessionSyncState,
  sessionTopologyVersionAtRequest: number,
): boolean {
  return (
    state.sessionTopologyVersion !== sessionTopologyVersionAtRequest ||
    state.pendingSessionAction?.kind === "resume_history"
  );
}

export async function recoverFromReplayGapCommand(args: {
  batch: EventBatch;
  get: () => SessionSyncState;
  set: SessionSyncSetState;
  clearPendingEvents: () => void;
  updateLastSeq: (seq: number) => void;
  replaceSessionsResponse: (
    state: Pick<
      SessionSyncState,
      "projections" | "selectedSessionId" | "workspaceVisibilityVersion"
    > & {
      workspaceDir: string;
      hiddenWorkspaceDirs: Set<string>;
      storedSessions: StoredSessionRef[];
      recentSessions: StoredSessionRef[];
    },
    sessionsResponse: Awaited<ReturnType<typeof api.listSessions>>,
    options?: {
      workspaceVisibilityVersionAtRequest?: number;
      preserveStoredSessionCatalog?: boolean;
    },
  ) => {
    projections: Map<string, SessionProjection>;
    selectedSessionId: string | null;
    workspaceDir: string;
    hiddenWorkspaceDirs: Set<string>;
    workspaceVisibilityVersion: number;
    storedSessions: StoredSessionRef[];
    recentSessions: StoredSessionRef[];
    workspaceDirs: string[];
  };
  applyEventsToMap: (
    current: Map<string, SessionProjection>,
    events: RahEvent[],
  ) => Map<string, SessionProjection>;
  ensureConversationLoaded: (sessionId: string) => Promise<void>;
}) {
  args.clearPendingEvents();
  if (
    args.batch.replayGap?.newestAvailableSeq !== null &&
    args.batch.replayGap?.newestAvailableSeq !== undefined
  ) {
    args.updateLastSeq(args.batch.replayGap.newestAvailableSeq);
  }
  const workspaceVisibilityVersionAtRequest = args.get().workspaceVisibilityVersion;
  const sessionTopologyVersionAtRequest = args.get().sessionTopologyVersion;
  const sessionsResponse = await api.listSessions({ storedSessions: "recent" });
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
      preserveStoredSessionCatalog: true,
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
    void args.ensureConversationLoaded(selectedSessionId);
  }
}

export function connectStoreSyncTransport(args: {
  getReplayFromSeq: () => number | undefined;
  advanceReplaySeq: (seq: number) => void;
  isInitialLoaded: () => boolean;
  set: SessionSyncSetState;
  getNotificationProjections: () => ReadonlyMap<string, SessionProjection>;
  applyEventsToMap: (
    current: Map<string, SessionProjection>,
    events: RahEvent[],
  ) => Map<string, SessionProjection>;
  applyConversationDeltasToMap: (
    current: Map<string, SessionProjection>,
    deltas: readonly ConversationProjectionDelta[],
  ) => Map<string, SessionProjection>;
  computeUnreadSessionIds: (
    currentUnreadSessionIds: ReadonlySet<string>,
    visibleSessionIds: ReadonlySet<string>,
    events: readonly RahEvent[],
  ) => Set<string>;
  getVisibleSessionIds: () => ReadonlySet<string>;
  notifyUnreadEvents?: (args: {
    projections: ReadonlyMap<string, SessionProjection>;
    events: readonly RahEvent[];
  }) => void;
  onConversationDeltasApplied?: (
    deltas: readonly ConversationProjectionDelta[],
  ) => void;
  recoverFromReplayGap: (batch: EventBatch) => Promise<void>;
  refreshWorkbenchState: (events: RahEvent[]) => Promise<void>;
}) {
  let pendingProjectionEvents: RahEvent[] = [];
  let pendingProjectionEventBytes = 0;
  let pendingUnreadEvents: RahEvent[] = [];
  let pendingConversationDeltas: ConversationProjectionDelta[] = [];
  let pendingDataPlaneSeq: number | null = null;
  let pendingFlush: { kind: "frame" | "timer"; id: number } | null = null;
  let lastFlushAt = 0;

  const monotonicNow = () =>
    typeof performance !== "undefined" ? performance.now() : Date.now();

  const cancelPendingFlush = () => {
    if (pendingFlush === null) {
      return;
    }
    if (pendingFlush.kind === "frame") {
      window.cancelAnimationFrame(pendingFlush.id);
    } else {
      window.clearTimeout(pendingFlush.id);
    }
    pendingFlush = null;
  };

  const flushPendingEvents = () => {
    cancelPendingFlush();
    lastFlushAt = monotonicNow();
    if (
      pendingProjectionEvents.length === 0 &&
      pendingUnreadEvents.length === 0 &&
      pendingConversationDeltas.length === 0 &&
      pendingDataPlaneSeq === null
    ) {
      return;
    }
    const allProjectionEvents = coalesceProjectionEvents(pendingProjectionEvents);
    const allUnreadEvents = coalesceProjectionEvents(pendingUnreadEvents);
    const allConversationDeltas = coalesceConversationProjectionDeltas(
      pendingConversationDeltas,
    );
    const projectionBatch = takeSyncEventPrefix(allProjectionEvents);
    const unreadBatch = takeSyncEventPrefix(allUnreadEvents);
    const projectionEvents = projectionBatch.selected;
    const unreadEvents = unreadBatch.selected;
    const conversationDeltas = allConversationDeltas.slice(
      0,
      MAX_SYNC_DELTAS_PER_FLUSH,
    );
    pendingProjectionEvents = projectionBatch.remaining;
    pendingProjectionEventBytes = pendingProjectionEvents.reduce(
      (total, event) => total + syncEventApproximateBytes(event),
      0,
    );
    pendingUnreadEvents = unreadBatch.remaining;
    pendingConversationDeltas = allConversationDeltas.slice(
      MAX_SYNC_DELTAS_PER_FLUSH,
    );
    const dataPlaneSeqToAdvance =
      pendingProjectionEvents.length === 0 &&
      pendingUnreadEvents.length === 0 &&
      pendingConversationDeltas.length === 0
        ? pendingDataPlaneSeq
        : null;
    if (dataPlaneSeqToAdvance !== null) {
      pendingDataPlaneSeq = null;
    }
    if (
      projectionEvents.length === 0 &&
      unreadEvents.length === 0 &&
      conversationDeltas.length === 0
    ) {
      if (dataPlaneSeqToAdvance !== null) {
        args.advanceReplaySeq(dataPlaneSeqToAdvance);
      }
      return;
    }
    if (unreadEvents.length > 0) {
      args.notifyUnreadEvents?.({
        projections: args.getNotificationProjections(),
        events: unreadEvents,
      });
    }
    args.set((state) => {
      const projectionState =
        projectionEvents.length > 0
          ? applyProjectionEventsToSyncState({
              state,
              events: projectionEvents,
              applyEventsToMap: args.applyEventsToMap,
            })
          : {
              projections: state.projections,
              selectedSessionId: state.selectedSessionId,
              sessionTopologyVersion: state.sessionTopologyVersion,
            };
      const projections =
        conversationDeltas.length > 0
          ? args.applyConversationDeltasToMap(
              projectionState.projections,
              conversationDeltas,
            )
          : projectionState.projections;
      const nextError =
        state.error && isTransportErrorMessage(state.error) ? null : state.error;
      if (
        projections === state.projections &&
        projectionState.selectedSessionId === state.selectedSessionId &&
        projectionState.sessionTopologyVersion === state.sessionTopologyVersion &&
        unreadEvents.length === 0 &&
        nextError === state.error
      ) {
        return state;
      }
      return {
        ...projectionState,
        projections,
        unreadSessionIds:
          unreadEvents.length === 0
            ? state.unreadSessionIds
            : args.computeUnreadSessionIds(
                state.unreadSessionIds,
                args.getVisibleSessionIds(),
                unreadEvents,
              ),
        error: nextError,
      };
    });
    if (dataPlaneSeqToAdvance !== null) {
      args.advanceReplaySeq(dataPlaneSeqToAdvance);
    }
    args.onConversationDeltasApplied?.(conversationDeltas);
    if (
      pendingProjectionEvents.length > 0 ||
      pendingUnreadEvents.length > 0 ||
      pendingConversationDeltas.length > 0 ||
      pendingDataPlaneSeq !== null
    ) {
      // Continue on a new frame rather than monopolizing the browser main
      // thread with an entire reconnect replay.
      lastFlushAt = 0;
      schedulePendingEventFlush();
    }
  };

  const schedulePendingEventFlush = () => {
    if (pendingFlush !== null) {
      return;
    }
    const runFlush = () => {
      pendingFlush = null;
      flushPendingEvents();
    };
    const hidden =
      typeof document !== "undefined" &&
      document.visibilityState === "hidden";
    const plan = resolveSyncFlushPlan({
      hidden,
      elapsedSinceLastFlushMs:
        lastFlushAt === 0
          ? Number.POSITIVE_INFINITY
          : monotonicNow() - lastFlushAt,
    });
    if (plan.kind === "frame") {
      pendingFlush = {
        kind: "frame",
        id: window.requestAnimationFrame(runFlush),
      };
      return;
    }
    pendingFlush = {
      kind: "timer",
      id: window.setTimeout(() => {
        pendingFlush = null;
        if (
          typeof document !== "undefined" &&
          document.visibilityState !== "hidden"
        ) {
          pendingFlush = {
            kind: "frame",
            id: window.requestAnimationFrame(runFlush),
          };
          return;
        }
        runFlush();
      }, plan.delayMs),
    };
  };

  const reschedulePendingFlushForVisibility = () => {
    if (pendingFlush === null) {
      return;
    }
    cancelPendingFlush();
    schedulePendingEventFlush();
  };

  if (typeof document !== "undefined") {
    document.addEventListener(
      "visibilitychange",
      reschedulePendingFlushForVisibility,
    );
  }

  connectSessionStoreTransport({
    getReplayFromSeq: args.getReplayFromSeq,
    isInitialLoaded: args.isInitialLoaded,
    onBatch: (batch) => {
      const splitEvents = splitProjectionTransportEvents(batch.events ?? []);
      const projectionEvents = splitEvents.projectionEvents;
      const conversationDeltas = batch.conversationDeltas ?? [];
      if (splitEvents.dataPlaneSeq !== null) {
        pendingDataPlaneSeq =
          pendingDataPlaneSeq === null
            ? splitEvents.dataPlaneSeq
            : Math.max(pendingDataPlaneSeq, splitEvents.dataPlaneSeq);
      }
      if (
        projectionEvents.length === 0 &&
        conversationDeltas.length === 0 &&
        pendingDataPlaneSeq === null
      ) {
        return;
      }
      appendPendingValues(pendingProjectionEvents, projectionEvents);
      pendingProjectionEventBytes += projectionEvents.reduce(
        (total, event) => total + syncEventApproximateBytes(event),
        0,
      );
      appendPendingValues(pendingConversationDeltas, conversationDeltas);
      if (!batch.initial && !batch.replay) {
        appendPendingValues(pendingUnreadEvents, projectionEvents);
      }
      if (
        pendingProjectionEvents.length >= MAX_PENDING_SYNC_EVENTS ||
        pendingProjectionEventBytes >= MAX_PENDING_SYNC_EVENT_BYTES
      ) {
        const compacted = compactPendingProjectionEvents(
          pendingProjectionEvents,
        );
        pendingProjectionEvents = compacted.events;
        pendingProjectionEventBytes = compacted.bytes;
      }
      if (
        pendingProjectionEvents.length >= MAX_PENDING_SYNC_EVENTS ||
        pendingProjectionEventBytes >= MAX_PENDING_SYNC_EVENT_BYTES ||
        pendingConversationDeltas.length >= MAX_PENDING_SYNC_EVENTS
      ) {
        // A reconnect starts from the last applied sequence. Dropping this
        // un-applied queue and reconnecting is safer than a multi-second
        // synchronous catch-up that freezes the UI.
        cancelPendingFlush();
        pendingProjectionEvents = [];
        pendingProjectionEventBytes = 0;
        pendingUnreadEvents = [];
        pendingConversationDeltas = [];
        pendingDataPlaneSeq = null;
        return false;
      }
      schedulePendingEventFlush();
      return true;
    },
    onError: (error) => {
      args.set({ error: error.message });
    },
    onOpen: () => {
      args.set((state) => ({
        eventStreamOpenRevision: state.eventStreamOpenRevision + 1,
        error:
          state.error && isTransportErrorMessage(state.error) ? null : state.error,
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
    options?: {
      workspaceVisibilityVersionAtRequest?: number;
      preserveStoredSessionCatalog?: boolean;
    },
  ) => {
    projections: Map<string, SessionProjection>;
    selectedSessionId: string | null;
    workspaceDir: string;
    hiddenWorkspaceDirs: Set<string>;
    workspaceVisibilityVersion: number;
    storedSessions: StoredSessionRef[];
    recentSessions: StoredSessionRef[];
    workspaceDirs: string[];
  };
  restartTransport: (options?: { signal?: AbortSignal }) => void | Promise<void>;
  maybeRestoreLastHistorySelection: (
    sessionsResponse: Awaited<ReturnType<typeof api.listSessions>>,
  ) => Promise<void>;
  listSessions?: typeof api.listSessions;
}, options: RecoverTransportOptions = {}) {
  if (recoverTransportInFlight && !options.replaceActive) {
    return recoverTransportInFlight.promise;
  }
  recoverTransportInFlight?.controller.abort();
  const linked = createLinkedAbortController(options.signal);
  let request!: RecoverTransportRequest;
  const promise = recoverTransportCommandInner(
    args,
    linked.controller.signal,
    options.suppressError ?? false,
  ).finally(() => {
    linked.detach();
    if (recoverTransportInFlight === request) {
      recoverTransportInFlight = null;
    }
  });
  request = { controller: linked.controller, promise };
  recoverTransportInFlight = request;
  return promise;
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
    options?: {
      workspaceVisibilityVersionAtRequest?: number;
      preserveStoredSessionCatalog?: boolean;
    },
  ) => {
    projections: Map<string, SessionProjection>;
    selectedSessionId: string | null;
    workspaceDir: string;
    hiddenWorkspaceDirs: Set<string>;
    workspaceVisibilityVersion: number;
    storedSessions: StoredSessionRef[];
    recentSessions: StoredSessionRef[];
    workspaceDirs: string[];
  };
  restartTransport: (options?: { signal?: AbortSignal }) => void | Promise<void>;
  maybeRestoreLastHistorySelection: (
    sessionsResponse: Awaited<ReturnType<typeof api.listSessions>>,
  ) => Promise<void>;
  listSessions?: typeof api.listSessions;
}, signal?: AbortSignal, suppressError = false) {
  try {
    throwIfAborted(signal);
    const requestState = args.get();
    const workspaceVisibilityVersionAtRequest = requestState.workspaceVisibilityVersion;
    const sessionTopologyVersionAtRequest = requestState.sessionTopologyVersion;
    const transportReady = Promise.resolve(
      args.restartTransport(signal ? { signal } : undefined),
    );
    const sessionsRequest = (args.listSessions ?? api.listSessions)({
      storedSessions: "recent",
      ...(signal ? { signal } : {}),
    });
    const [sessionsResponse] = await Promise.all([sessionsRequest, transportReady]);
    throwIfAborted(signal);
    args.set((state) => {
      if (shouldSkipSessionsResponse(state, sessionTopologyVersionAtRequest)) {
        return { error: null };
      }
      return {
        ...args.applySessionsResponse(state as never, sessionsResponse, {
          workspaceVisibilityVersionAtRequest,
          preserveStoredSessionCatalog: state.storedSessionsCatalogLoaded === true,
        }),
        error: null,
      };
    });
    throwIfAborted(signal);
    await args.maybeRestoreLastHistorySelection(sessionsResponse);
  } catch (error) {
    if (signal?.aborted || isAbortError(error)) {
      throw createAbortError();
    }
    if (!suppressError) {
      args.set({ error: readErrorMessage(error) });
    }
    throw error;
  }
}

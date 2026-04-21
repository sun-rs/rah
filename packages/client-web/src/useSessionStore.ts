import { create } from "zustand";
import type {
  AttachSessionRequest,
  DebugScenarioDescriptor,
  EventBatch,
  PermissionResponseRequest,
  RahEvent,
  ResumeSessionRequest,
  SessionSummary,
  StoredSessionRef,
} from "@rah/runtime-protocol";
import * as api from "./api";
import { clearLastHistorySelection, readLastHistorySelection } from "./history-selection";
import { isLabModeEnabled } from "./lab-mode";
import { matchesWorkspace } from "./session-browser";
import { canSessionSendInput, isReadOnlyReplay } from "./session-capabilities";
import {
  appendOptimisticUserMessage,
  applyEventToProjection,
  createSessionMap,
  initialHistorySyncState,
  providerLabel,
  type FeedEntry,
  type SessionProjection,
} from "./types";

type ProviderChoice = "codex" | "claude" | "kimi" | "gemini" | "opencode";

interface StartSessionOptions {
  provider?: ProviderChoice;
  cwd?: string;
  title?: string;
  model?: string;
  approvalPolicy?: string;
  sandbox?: string;
}

interface LaunchStatus {
  provider: ProviderChoice;
  cwd: string;
  title?: string;
}

interface SessionState {
  clientId: string;
  projections: Map<string, SessionProjection>;
  unreadSessionIds: Set<string>;
  storedSessions: StoredSessionRef[];
  recentSessions: StoredSessionRef[];
  workspaceDirs: string[];
  debugScenarios: DebugScenarioDescriptor[];
  selectedSessionId: string | null;
  workspaceDir: string;
  newSessionProvider: ProviderChoice;
  launchStatus: LaunchStatus | null;
  isInitialLoaded: boolean;
  error: string | null;

  init: () => Promise<void>;
  clearError: () => void;
  refreshWorkbenchState: () => Promise<void>;
  setWorkspaceDir: (dir: string) => void;
  addWorkspace: (dir: string) => Promise<void>;
  removeWorkspace: (dir: string) => Promise<void>;
  setSelectedSessionId: (id: string | null) => void;
  setNewSessionProvider: (provider: ProviderChoice) => void;
  startSession: (options?: StartSessionOptions) => Promise<void>;
  startScenario: (scenario: DebugScenarioDescriptor) => Promise<void>;
  resumeStoredSession: (
    ref: StoredSessionRef,
    options?: { preferStoredReplay?: boolean; historyReplay?: "include" | "skip" },
  ) => Promise<void>;
  attachSession: (summary: SessionSummary) => Promise<void>;
  closeSession: (sessionId: string) => Promise<void>;
  claimHistorySession: (sessionId: string) => Promise<void>;
  claimControl: (sessionId: string) => Promise<void>;
  releaseControl: (sessionId: string) => Promise<void>;
  interruptSession: (sessionId: string) => Promise<void>;
  sendInput: (sessionId: string, text: string) => Promise<void>;
  ensureSessionHistoryLoaded: (sessionId: string) => Promise<void>;
  loadOlderHistory: (sessionId: string) => Promise<void>;
  respondToPermission: (
    sessionId: string,
    requestId: string,
    response: PermissionResponseRequest,
  ) => Promise<void>;
}

let initialized = false;
let eventsSocket: WebSocket | null = null;
let reconnectTimer: number | null = null;
let lastEventSeq = 0;
let attemptedStoredHistoryRestore = false;
const MAX_PENDING_EVENTS_PER_SESSION = 200;
const MAX_DEFERRED_BOOTSTRAP_EVENTS_PER_SESSION = 500;
let pendingEventsBySession = new Map<string, RahEvent[]>();
let deferredBootstrapEventsBySession = new Map<string, RahEvent[]>();
let hiddenWorkspaceDirs = new Set<string>();

function normalizeWorkspaceDirectory(value: string | undefined): string | null {
  if (!value) {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const withoutTrailing = trimmed.replace(/[\\/]+$/, "");
  if (withoutTrailing.startsWith("/private/var/")) {
    return withoutTrailing.slice("/private".length);
  }
  return withoutTrailing;
}

function sameWorkspaceDirectory(a: string | undefined, b: string | undefined): boolean {
  const left = normalizeWorkspaceDirectory(a);
  const right = normalizeWorkspaceDirectory(b);
  return left !== null && right !== null && left === right;
}

function isHiddenWorkspace(dir: string | undefined): boolean {
  const normalized = normalizeWorkspaceDirectory(dir);
  return normalized !== null && hiddenWorkspaceDirs.has(normalized);
}

function hideWorkspace(dir: string): void {
  const normalized = normalizeWorkspaceDirectory(dir);
  if (!normalized) {
    return;
  }
  hiddenWorkspaceDirs.add(normalized);
}

function revealWorkspace(dir: string | undefined): void {
  const normalized = normalizeWorkspaceDirectory(dir);
  if (!normalized) {
    return;
  }
  hiddenWorkspaceDirs.delete(normalized);
}

function revealWorkspaceCandidates(...dirs: Array<string | undefined>): void {
  for (const dir of dirs) {
    revealWorkspace(dir);
  }
}

function filterHiddenWorkspaceDirs(workspaceDirs: readonly string[]): string[] {
  return workspaceDirs.filter((dir) => !isHiddenWorkspace(dir));
}

function appendVisibleWorkspaceDir(
  workspaceDirs: readonly string[],
  dir: string | undefined,
): string[] {
  const visibleWorkspaceDirs = filterHiddenWorkspaceDirs(workspaceDirs);
  const normalized = normalizeWorkspaceDirectory(dir);
  if (!normalized || isHiddenWorkspace(normalized)) {
    return visibleWorkspaceDirs;
  }
  if (visibleWorkspaceDirs.some((workspaceDir) => sameWorkspaceDirectory(workspaceDir, normalized))) {
    return visibleWorkspaceDirs;
  }
  return [...visibleWorkspaceDirs, normalized];
}

export function reconcileVisibleWorkspaceSelection(args: {
  workspaceDirs: string[];
  sessions: SessionSummary[];
  storedSessions: StoredSessionRef[];
  activeWorkspaceDir: string | undefined;
  currentWorkspaceDir: string;
  hiddenWorkspaceDirs: Iterable<string> | undefined;
}): {
  workspaceDirs: string[];
  workspaceDir: string;
} {
  const hiddenWorkspaceDirs = new Set(
    [...(args.hiddenWorkspaceDirs ?? [])]
      .map((dir) => normalizeWorkspaceDirectory(dir))
      .filter((dir): dir is string => dir !== null),
  );
  const isHidden = (dir: string | undefined): boolean => {
    const normalized = normalizeWorkspaceDirectory(dir);
    return normalized !== null && hiddenWorkspaceDirs.has(normalized);
  };
  const workspaceDirs = args.workspaceDirs.filter((dir) => !isHidden(dir));
  const currentWorkspaceDir = isHidden(args.currentWorkspaceDir) ? "" : args.currentWorkspaceDir;
  const activeWorkspaceDir = isHidden(args.activeWorkspaceDir)
    ? undefined
    : args.activeWorkspaceDir;
  const workspaceDir = currentWorkspaceDir.trim()
    ? currentWorkspaceDir
    : inferWorkspaceDirectory(
        workspaceDirs,
        args.sessions,
        args.storedSessions,
        activeWorkspaceDir,
        currentWorkspaceDir,
      );
  return {
    workspaceDirs,
    workspaceDir,
  };
}

function mergeStoredSessionRefs(
  current: StoredSessionRef[],
  incoming: StoredSessionRef,
): StoredSessionRef[] {
  const next = new Map(
    current.map((entry) => [`${entry.provider}:${entry.providerSessionId}`, entry] as const),
  );
  next.set(`${incoming.provider}:${incoming.providerSessionId}`, incoming);
  return [...next.values()].sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
}

function mergeRecentSessionRefs(
  current: StoredSessionRef[],
  incoming: StoredSessionRef,
): StoredSessionRef[] {
  const next = new Map(
    current.map((entry) => [`${entry.provider}:${entry.providerSessionId}`, entry] as const),
  );
  next.set(`${incoming.provider}:${incoming.providerSessionId}`, incoming);
  return [...next.values()]
    .sort((a, b) => (b.lastUsedAt ?? b.updatedAt ?? "").localeCompare(a.lastUsedAt ?? a.updatedAt ?? ""))
    .slice(0, 15);
}

function readErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function createClientId(): string {
  const randomUuid =
    typeof globalThis.crypto?.randomUUID === "function"
      ? globalThis.crypto.randomUUID.bind(globalThis.crypto)
      : null;
  if (randomUuid) {
    return `web-${randomUuid()}`;
  }
  return `web-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function inferWorkspaceDirectory(
  workspaceDirs: string[],
  sessions: SessionSummary[],
  storedSessions: StoredSessionRef[],
  rememberedActiveWorkspaceDir: string | undefined,
  fallback: string,
): string {
  if (rememberedActiveWorkspaceDir?.trim()) {
    return rememberedActiveWorkspaceDir;
  }
  const liveCandidate = sessions[0]?.session.rootDir ?? sessions[0]?.session.cwd;
  if (liveCandidate) {
    return liveCandidate;
  }
  const storedCandidate = storedSessions[0]?.rootDir ?? storedSessions[0]?.cwd;
  if (storedCandidate) {
    return storedCandidate;
  }
  if (workspaceDirs[0]) {
    return workspaceDirs[0];
  }
  return fallback;
}

function applySessionsResponse(
  state: Pick<
    SessionState,
    "projections" | "workspaceDir" | "selectedSessionId"
  >,
  sessionsResponse: Awaited<ReturnType<typeof api.listSessions>>,
): Pick<
  SessionState,
  | "projections"
  | "storedSessions"
  | "recentSessions"
  | "workspaceDirs"
  | "workspaceDir"
  | "selectedSessionId"
> {
  const projections = mergeSessionsIntoProjections(state.projections, sessionsResponse);
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
    workspaceDir: workspace.workspaceDir,
    selectedSessionId: selectPreferredSessionId(
      projections,
      state.selectedSessionId,
      workspace.workspaceDir,
    ),
  };
}

function replaceSessionsResponse(
  state: Pick<
    SessionState,
    "workspaceDir" | "selectedSessionId"
  >,
  sessionsResponse: Awaited<ReturnType<typeof api.listSessions>>,
): Pick<
  SessionState,
  | "projections"
  | "storedSessions"
  | "recentSessions"
  | "workspaceDirs"
  | "workspaceDir"
  | "selectedSessionId"
> {
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
    workspaceDir: workspace.workspaceDir,
    selectedSessionId: selectPreferredSessionId(
      sessionMap.sessions,
      state.selectedSessionId,
      workspace.workspaceDir,
    ),
  };
}

function selectPreferredSessionId(
  projections: Map<string, SessionProjection>,
  currentSelectedId: string | null,
  workspaceDir: string,
): string | null {
  const current = currentSelectedId ? projections.get(currentSelectedId) ?? null : null;
  if (current && isReadOnlyReplay(current.summary)) {
    return current.summary.session.id;
  }
  if (
    current &&
    matchesWorkspace(current.summary.session.rootDir || current.summary.session.cwd, workspaceDir)
  ) {
    return current.summary.session.id;
  }
  const firstLiveInWorkspace = [...projections.values()]
    .filter(
      (projection) =>
        !isReadOnlyReplay(projection.summary) &&
        matchesWorkspace(
          projection.summary.session.rootDir || projection.summary.session.cwd,
          workspaceDir,
        ),
    )
    .sort((left, right) =>
      right.summary.session.updatedAt.localeCompare(left.summary.session.updatedAt),
    )[0];
  return firstLiveInWorkspace?.summary.session.id ?? null;
}

function applyEventsToMap(
  current: Map<string, SessionProjection>,
  events: RahEvent[],
): Map<string, SessionProjection> {
  if (events.length === 0) {
    return current;
  }
  const next = new Map(current);
  for (const event of [...events].sort((a, b) => a.seq - b.seq)) {
    lastEventSeq = Math.max(lastEventSeq, event.seq);
    if (event.type === "session.closed") {
      next.delete(event.sessionId);
      pendingEventsBySession.delete(event.sessionId);
      deferredBootstrapEventsBySession.delete(event.sessionId);
      continue;
    }
    const projection = next.get(event.sessionId);
    if (!projection) {
      queuePendingEvent(event);
      continue;
    }
    if (shouldDeferEventForHistoryBootstrap(projection, event)) {
      queueDeferredBootstrapEvent(event);
      continue;
    }
    next.set(event.sessionId, applyEventToProjection(projection, event));
  }
  return next;
}

function mergeSessionsIntoProjections(
  current: Map<string, SessionProjection>,
  sessionsResponse: Awaited<ReturnType<typeof api.listSessions>>,
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
  const replay = takePendingEventsForSessions(new Set(next.keys()));
  return applyEventsToMap(next, replay);
}

function adoptExistingProjectionForProviderSession(
  projections: Map<string, SessionProjection>,
  summary: SessionSummary,
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

function queuePendingEvent(event: RahEvent) {
  const existing = pendingEventsBySession.get(event.sessionId) ?? [];
  const next = [...existing, event];
  if (next.length > MAX_PENDING_EVENTS_PER_SESSION) {
    next.splice(0, next.length - MAX_PENDING_EVENTS_PER_SESSION);
  }
  pendingEventsBySession.set(event.sessionId, next);
}

function takePendingEventsForSessions(sessionIds: Set<string>): RahEvent[] {
  const replay: RahEvent[] = [];
  for (const sessionId of sessionIds) {
    const events = pendingEventsBySession.get(sessionId);
    if (!events || events.length === 0) {
      continue;
    }
    replay.push(...events);
    pendingEventsBySession.delete(sessionId);
  }
  return replay;
}

function shouldDeferEventForHistoryBootstrap(
  projection: SessionProjection,
  event: RahEvent,
): boolean {
  if (projection.history.phase !== "loading" || projection.history.authoritativeApplied) {
    return false;
  }
  return (
    event.type === "timeline.item.added" ||
    event.type === "timeline.item.updated" ||
    event.type === "message.part.added" ||
    event.type === "message.part.updated" ||
    event.type === "message.part.delta" ||
    event.type === "message.part.removed" ||
    event.type === "tool.call.started" ||
    event.type === "tool.call.delta" ||
    event.type === "tool.call.completed" ||
    event.type === "tool.call.failed" ||
    event.type === "observation.started" ||
    event.type === "observation.updated" ||
    event.type === "observation.completed" ||
    event.type === "observation.failed" ||
    event.type === "permission.requested" ||
    event.type === "permission.resolved" ||
    event.type === "operation.started" ||
    event.type === "operation.resolved" ||
    event.type === "operation.requested" ||
    event.type === "runtime.status" ||
    event.type === "notification.emitted" ||
    event.type === "attention.required" ||
    event.type === "attention.cleared"
  );
}

function queueDeferredBootstrapEvent(event: RahEvent) {
  const existing = deferredBootstrapEventsBySession.get(event.sessionId) ?? [];
  const next = [...existing, event];
  if (next.length > MAX_DEFERRED_BOOTSTRAP_EVENTS_PER_SESSION) {
    next.splice(0, next.length - MAX_DEFERRED_BOOTSTRAP_EVENTS_PER_SESSION);
  }
  deferredBootstrapEventsBySession.set(event.sessionId, next);
}

function takeDeferredBootstrapEvents(sessionId: string): RahEvent[] {
  const events = deferredBootstrapEventsBySession.get(sessionId) ?? [];
  deferredBootstrapEventsBySession.delete(sessionId);
  return events;
}

function clearBufferedEvents() {
  pendingEventsBySession = new Map();
  deferredBootstrapEventsBySession = new Map();
}

function applyEventBatchToProjection(
  projection: SessionProjection,
  events: RahEvent[],
): SessionProjection {
  let next = projection;
  for (const event of [...events].sort((a, b) => a.seq - b.seq)) {
    next = applyEventToProjection(next, event);
  }
  return next;
}

function attachRequest(clientId: string): AttachSessionRequest {
  return {
    client: {
      id: clientId,
      kind: "web",
      connectionId: clientId,
    },
    mode: "interactive",
    claimControl: true,
  };
}

function observeAttachRequest(clientId: string): AttachSessionRequest {
  return {
    client: {
      id: clientId,
      kind: "web",
      connectionId: clientId,
    },
    mode: "observe",
  };
}

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

function connectEventSocket() {
  const store = useSessionStore.getState();
  if (eventsSocket && eventsSocket.readyState < WebSocket.CLOSING) {
    return;
  }
  const replayFromSeq = lastEventSeq > 0 ? lastEventSeq + 1 : undefined;
  eventsSocket = api.createEventsSocket(
    replayFromSeq === undefined ? {} : { replayFromSeq },
    (batch) => {
      if (batch.replayGap) {
        void recoverFromReplayGap(batch);
        return;
      }
      if (!batch.events?.length) {
        return;
      }
      useSessionStore.setState((state) => ({
        projections: applyEventsToMap(state.projections, batch.events),
        unreadSessionIds: batch.initial
          ? state.unreadSessionIds
          : computeUnreadSessionIds(
              state.unreadSessionIds,
              state.selectedSessionId,
              batch.events,
            ),
        error: state.error === "Events socket failed" ? null : state.error,
      }));
    },
    (error) => {
      useSessionStore.setState({ error: error.message });
      if (eventsSocket && eventsSocket.readyState < WebSocket.CLOSING) {
        eventsSocket.close();
      }
    },
    {
      onOpen: () => {
        useSessionStore.setState((state) => ({
          error: state.error === "Events socket failed" ? null : state.error,
        }));
      },
      onClose: () => {
        eventsSocket = null;
        if (reconnectTimer !== null) {
          window.clearTimeout(reconnectTimer);
        }
        reconnectTimer = window.setTimeout(() => {
          reconnectTimer = null;
          connectEventSocket();
        }, 750);
      },
    },
  );

  if (!store.isInitialLoaded) {
    eventsSocket.close();
    eventsSocket = null;
  }
}

function updateSessionSummary(session: SessionSummary) {
  useSessionStore.setState((state) => {
    const next = new Map(state.projections);
    const projection = next.get(session.session.id);
    if (projection) {
      next.set(session.session.id, { ...projection, summary: session });
    }
    return { projections: next };
  });
}

function replayEventsIntoProjection(
  summary: SessionSummary,
  events: RahEvent[],
): SessionProjection {
  let projection: SessionProjection = {
    summary,
    feed: [],
    events: [],
    lastSeq: 0,
    history: initialHistorySyncState(),
  };
  for (const event of [...events].sort((a, b) => a.seq - b.seq)) {
    projection = applyEventToProjection(projection, event);
  }
  return projection;
}

function feedEntriesSemanticallyMatch(left: FeedEntry, right: FeedEntry): boolean {
  if (left.kind !== right.kind) {
    return false;
  }
  if (left.kind !== "timeline" || right.kind !== "timeline") {
    return false;
  }
  if (left.item.kind !== right.item.kind) {
    return false;
  }
  switch (left.item.kind) {
    case "user_message":
    case "assistant_message": {
      const leftItem = left.item;
      const rightItem = right.item as typeof leftItem;
      const leftMessageId = leftItem.messageId;
      const rightMessageId = rightItem.messageId;
      if (
        leftMessageId !== undefined &&
        rightMessageId !== undefined &&
        leftMessageId === rightMessageId
      ) {
        return true;
      }
      return leftItem.text === rightItem.text;
    }
    case "reasoning": {
      const leftItem = left.item;
      const rightItem = right.item as typeof leftItem;
      return leftItem.text === rightItem.text;
    }
    default:
      return false;
  }
}

function prependHistoryPage(
  projection: SessionProjection,
  events: RahEvent[],
  nextBeforeTs?: string,
): SessionProjection {
  if (events.length === 0) {
    return {
      ...projection,
      history: {
        ...projection.history,
        phase: "ready",
        nextBeforeTs: nextBeforeTs ?? null,
        authoritativeApplied: true,
        lastError: null,
      },
    };
  }

  const historyProjection = replayEventsIntoProjection(projection.summary, events);
  const nextFeed = [...projection.feed];
  const currentKeyIndex = new Map(
    nextFeed.map((entry, index) => [entry.key, index] as const),
  );
  const prepend = historyProjection.feed.filter(
    (entry) => {
      const existingIndex = currentKeyIndex.get(entry.key);
      if (existingIndex !== undefined) {
        nextFeed[existingIndex] = entry;
        return false;
      }
      return !projection.feed.some((current) => feedEntriesSemanticallyMatch(current, entry));
    },
  );

  return {
    ...projection,
    feed: [...prepend, ...nextFeed],
    history: {
      ...projection.history,
      phase: "ready",
      nextBeforeTs: nextBeforeTs ?? null,
      authoritativeApplied: true,
      lastError: null,
    },
  };
}

async function ensureSessionHistoryLoaded(sessionId: string) {
  const projection = useSessionStore.getState().projections.get(sessionId);
  if (
    !projection ||
    projection.history.phase === "loading" ||
    projection.history.authoritativeApplied ||
    !projection.summary.session.providerSessionId
  ) {
    return;
  }
  await useSessionStore.getState().loadOlderHistory(sessionId);
}

async function maybeRestoreLastHistorySelection(
  sessionsResponse: Awaited<ReturnType<typeof api.listSessions>>,
) {
  if (
    attemptedStoredHistoryRestore ||
    useSessionStore.getState().isInitialLoaded ||
    sessionsResponse.sessions.length > 0
  ) {
    return;
  }
  attemptedStoredHistoryRestore = true;
  const selection = readLastHistorySelection();
  if (!selection) {
    return;
  }
  const ref =
    sessionsResponse.storedSessions.find(
      (session) =>
        session.provider === selection.provider &&
        session.providerSessionId === selection.providerSessionId,
    ) ??
    sessionsResponse.recentSessions.find(
      (session) =>
        session.provider === selection.provider &&
        session.providerSessionId === selection.providerSessionId,
    );
  if (!ref) {
    clearLastHistorySelection();
    return;
  }
  if (selection.workspaceDir) {
    useSessionStore.setState((state) => ({
      workspaceDir: isHiddenWorkspace(selection.workspaceDir) ? "" : selection.workspaceDir!,
      workspaceDirs: appendVisibleWorkspaceDir(state.workspaceDirs, selection.workspaceDir),
    }));
  }
  try {
    await useSessionStore.getState().resumeStoredSession(ref, { preferStoredReplay: true });
  } catch {
    clearLastHistorySelection();
  }
}

function maybeAutoClaimSelectedSession(sessionId: string | null) {
  if (!sessionId) {
    return;
  }
  const state = useSessionStore.getState();
  const summary = state.projections.get(sessionId)?.summary;
  if (!summary || !canSessionSendInput(summary)) {
    return;
  }
  if (summary.controlLease.holderClientId === state.clientId) {
    return;
  }
  void state.claimControl(sessionId).catch(() => {});
}

async function recoverFromReplayGap(batch: EventBatch) {
  clearBufferedEvents();
  if (batch.replayGap?.newestAvailableSeq !== null && batch.replayGap?.newestAvailableSeq !== undefined) {
    lastEventSeq = Math.max(lastEventSeq, batch.replayGap.newestAvailableSeq);
  }
  const sessionsResponse = await api.listSessions();
  useSessionStore.setState((state) => {
    const nextState = replaceSessionsResponse(state, sessionsResponse);
    return {
      ...nextState,
      projections: applyEventsToMap(nextState.projections, batch.events),
      error:
        `Event stream replay gap detected. Requested seq ${batch.replayGap?.requestedFromSeq ?? "unknown"}, ` +
        `oldest available ${batch.replayGap?.oldestAvailableSeq ?? "unknown"}. Session views were rebuilt from current state.`,
    };
  });
  const selectedSessionId = useSessionStore.getState().selectedSessionId;
  if (selectedSessionId) {
    void ensureSessionHistoryLoaded(selectedSessionId);
  }
}

export const useSessionStore = create<SessionState>((set, get) => ({
  clientId: createClientId(),
  projections: new Map(),
  unreadSessionIds: new Set(),
  storedSessions: [],
  recentSessions: [],
  workspaceDirs: [],
  debugScenarios: [],
  selectedSessionId: null,
  workspaceDir: "",
  newSessionProvider: "codex",
  launchStatus: null,
  isInitialLoaded: false,
  error: null,

  clearError: () => set({ error: null }),
  setWorkspaceDir: (dir) => {
    if (!dir.trim()) {
      set({ workspaceDir: "" });
      return;
    }
    set((state) => {
      const workspaceDirs = appendVisibleWorkspaceDir(state.workspaceDirs, dir);
      return {
        workspaceDir: isHiddenWorkspace(dir) ? "" : dir,
        workspaceDirs,
      };
    });
    void api
      .selectWorkspace({ dir })
      .then((sessionsResponse) =>
        set((state) => ({
          ...applySessionsResponse(state, sessionsResponse),
          error: null,
        })),
      )
      .catch((error) => {
        set({ error: readErrorMessage(error) });
      });
  },
  addWorkspace: async (dir) => {
    try {
      const sessionsResponse = await api.addWorkspace({ dir });
      revealWorkspace(dir);
      set((state) => ({
        ...applySessionsResponse(
          {
            ...state,
            workspaceDir: dir,
          },
          sessionsResponse,
        ),
        workspaceDir: dir,
        error: null,
      }));
    } catch (error) {
      set({ error: readErrorMessage(error) });
      throw error;
    }
  },
  removeWorkspace: async (dir) => {
    hideWorkspace(dir);
    try {
      set((state) => ({
        workspaceDirs: state.workspaceDirs.filter(
          (workspaceDir) => !sameWorkspaceDirectory(workspaceDir, dir),
        ),
        workspaceDir: sameWorkspaceDirectory(state.workspaceDir, dir) ? "" : state.workspaceDir,
        error: null,
      }));
      const sessionsResponse = await api.removeWorkspace({ dir });
      set((state) => ({
        ...applySessionsResponse(
          {
            ...state,
            workspaceDir: sameWorkspaceDirectory(state.workspaceDir, dir) ? "" : state.workspaceDir,
          },
          sessionsResponse,
        ),
        error: null,
      }));
    } catch (error) {
      revealWorkspace(dir);
      try {
        const sessionsResponse = await api.listSessions();
        set((state) => ({
          ...applySessionsResponse(state, sessionsResponse),
          error: readErrorMessage(error),
        }));
      } catch {
        set({ error: readErrorMessage(error) });
      }
      throw error;
    }
  },
  setSelectedSessionId: (id) =>
    {
      set((state) => {
        const unreadSessionIds = new Set(state.unreadSessionIds);
        if (id) {
          unreadSessionIds.delete(id);
        }
        return { selectedSessionId: id, unreadSessionIds };
      });
      if (id) {
        void ensureSessionHistoryLoaded(id);
      }
      maybeAutoClaimSelectedSession(id);
    },
  setNewSessionProvider: (provider) => set({ newSessionProvider: provider }),

  refreshWorkbenchState: async () => {
    try {
      const [sessionsResponse, debugScenarios] = await Promise.all([
        api.listSessions(),
        isLabModeEnabled() ? api.listDebugScenarios() : Promise.resolve([]),
      ]);
      set((state) => ({
        ...applySessionsResponse(state, sessionsResponse),
        debugScenarios,
        error: null,
      }));
      await maybeRestoreLastHistorySelection(sessionsResponse);
      maybeAutoClaimSelectedSession(useSessionStore.getState().selectedSessionId);
    } catch (error) {
      set({ error: readErrorMessage(error) });
      throw error;
    }
  },

  init: async () => {
    if (initialized) {
      return;
    }
    initialized = true;
    try {
      await get().refreshWorkbenchState();
      set({ isInitialLoaded: true });
      connectEventSocket();
    } catch (error) {
      initialized = false;
      set({
        isInitialLoaded: true,
        error: readErrorMessage(error),
      });
    }
  },

  startSession: async (options) => {
    try {
      const state = get();
      const cwd = options?.cwd?.trim() || state.workspaceDir.trim();
      if (!cwd) {
        set({ error: "Choose a workspace directory first." });
        return;
      }
      const provider = options?.provider ?? state.newSessionProvider;
      set({
        launchStatus: {
          provider,
          cwd,
          ...(options?.title ? { title: options.title } : {}),
        },
        error: null,
      });
      const response = await api.startSession({
        provider,
        cwd,
        title: options?.title ?? `${providerLabel(provider)} session`,
        ...(options?.model ? { model: options.model } : {}),
        ...(options?.approvalPolicy ? { approvalPolicy: options.approvalPolicy } : {}),
        ...(options?.sandbox ? { sandbox: options.sandbox } : {}),
        attach: attachRequest(state.clientId),
      });
      revealWorkspaceCandidates(cwd);
      set((current) => {
        const next = adoptExistingProjectionForProviderSession(
          new Map(current.projections),
          response.session,
        );
        next.set(response.session.session.id, {
          summary: response.session,
          feed: [],
          events: [],
          lastSeq: 0,
          history: initialHistorySyncState(),
        });
        return {
          projections: next,
          unreadSessionIds: new Set(
            [...current.unreadSessionIds].filter((sessionId) => sessionId !== response.session.session.id),
          ),
          workspaceDirs: appendVisibleWorkspaceDir(current.workspaceDirs, cwd),
          workspaceDir: cwd,
          newSessionProvider: provider,
          selectedSessionId: response.session.session.id,
          launchStatus: null,
          error: null,
        };
      });
      void ensureSessionHistoryLoaded(response.session.session.id);
      maybeAutoClaimSelectedSession(response.session.session.id);
    } catch (error) {
      set({ launchStatus: null, error: readErrorMessage(error) });
      throw error;
    }
  },

  startScenario: async (scenario) => {
    try {
      const response = await api.startDebugScenario({
        scenarioId: scenario.id,
        attach: attachRequest(get().clientId),
      });
      revealWorkspaceCandidates(scenario.rootDir);
      set((current) => {
        const next = new Map(current.projections);
        next.set(response.session.session.id, {
          summary: response.session,
          feed: [],
          events: [],
          lastSeq: 0,
          history: initialHistorySyncState(),
        });
        return {
          projections: next,
          unreadSessionIds: new Set(
            [...current.unreadSessionIds].filter((sessionId) => sessionId !== response.session.session.id),
          ),
          workspaceDirs: appendVisibleWorkspaceDir(current.workspaceDirs, scenario.rootDir),
          workspaceDir: scenario.rootDir,
          selectedSessionId: response.session.session.id,
          error: null,
        };
      });
      void ensureSessionHistoryLoaded(response.session.session.id);
      maybeAutoClaimSelectedSession(response.session.session.id);
    } catch (error) {
      set({ error: readErrorMessage(error) });
      throw error;
    }
  },

  resumeStoredSession: async (ref, options) => {
    try {
      if (ref.source === "previous_live") {
        const sessionsResponse = await api.listSessions();
        const running = sessionsResponse.sessions.find(
          (summary) =>
            summary.session.provider === ref.provider &&
            summary.session.providerSessionId === ref.providerSessionId,
        );
        if (running) {
          set((state) => ({
            ...applySessionsResponse(state, sessionsResponse),
            workspaceDir:
              ref.rootDir ??
              ref.cwd ??
              running.session.rootDir ??
              running.session.cwd ??
              state.workspaceDir,
            error: null,
          }));
          await get().attachSession(running);
          return;
        }
      }

      const request: ResumeSessionRequest = {
        provider: ref.provider,
        providerSessionId: ref.providerSessionId,
        preferStoredReplay: options?.preferStoredReplay ?? true,
        attach: observeAttachRequest(get().clientId),
      };
      if (options?.historyReplay !== undefined) {
        request.historyReplay = options.historyReplay;
      }
      if (ref.cwd !== undefined) {
        request.cwd = ref.cwd;
      }
      const response = await api.resumeSession(request);
      revealWorkspaceCandidates(ref.rootDir, ref.cwd);
      set((current) => {
        const next = adoptExistingProjectionForProviderSession(
          new Map(current.projections),
          response.session,
        );
        const replayProjection: SessionProjection = {
          summary: response.session,
          feed: [],
          events: [],
          lastSeq: 0,
          history: initialHistorySyncState(),
        };
        next.set(response.session.session.id, replayProjection);
        const replay = takePendingEventsForSessions(new Set([response.session.session.id]));
        return {
          projections: applyEventsToMap(next, replay),
          unreadSessionIds: new Set(
            [...current.unreadSessionIds].filter((sessionId) => sessionId !== response.session.session.id),
          ),
          workspaceDirs: appendVisibleWorkspaceDir(current.workspaceDirs, ref.rootDir ?? ref.cwd),
          workspaceDir: ref.rootDir ?? ref.cwd ?? current.workspaceDir,
          selectedSessionId: response.session.session.id,
          error: null,
        };
      });
      void ensureSessionHistoryLoaded(response.session.session.id);
      maybeAutoClaimSelectedSession(response.session.session.id);
    } catch (error) {
      const message = readErrorMessage(error);
      if (message.includes("attach instead of resume")) {
        const sessionsResponse = await api.listSessions();
        const running = sessionsResponse.sessions.find(
          (summary) =>
            summary.session.provider === ref.provider &&
            summary.session.providerSessionId === ref.providerSessionId,
        );
        if (running) {
          set((state) => {
            const next = applySessionsResponse(state, sessionsResponse);
            return {
              ...next,
              workspaceDir:
                ref.rootDir ??
                ref.cwd ??
                running.session.rootDir ??
                running.session.cwd ??
                next.workspaceDir,
              selectedSessionId: running.session.id,
              error: null,
            };
          });
          void ensureSessionHistoryLoaded(running.session.id);
          maybeAutoClaimSelectedSession(running.session.id);
          return;
        }
      }
      set({ error: message });
      throw error;
    }
  },

  claimHistorySession: async (sessionId) => {
    const state = get();
    const projection = state.projections.get(sessionId);
    const summary = projection?.summary;
    const providerSessionId = summary?.session.providerSessionId;
    if (!projection || !summary || !providerSessionId) {
      const error = "Only persisted provider sessions can be claimed from history.";
      set({ error });
      throw new Error(error);
    }

    const ref =
      state.recentSessions.find(
        (entry) =>
          entry.provider === summary.session.provider &&
          entry.providerSessionId === providerSessionId,
      ) ??
      state.storedSessions.find(
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
      };

    const preservedProjection: SessionProjection = {
      ...projection,
      summary,
    };

    const targetDir = ref.rootDir ?? ref.cwd ?? null;
    if (targetDir) {
      try {
        await api.listDirectory(targetDir);
      } catch {
        const shouldCreate =
          typeof window !== "undefined" &&
          window.confirm(`Workspace is missing. Create it before claiming control?\n\n${targetDir}`);
        if (!shouldCreate) {
          return;
        }
        await api.ensureDirectory({ dir: targetDir });
      }
    }

    try {
      const request: ResumeSessionRequest = {
        provider: ref.provider,
        providerSessionId: ref.providerSessionId,
        preferStoredReplay: false,
        historyReplay: "skip",
        attach: attachRequest(state.clientId),
      };
      if (ref.cwd !== undefined) {
        request.cwd = ref.cwd;
      }
      const response = await api.resumeSession(request);
      revealWorkspaceCandidates(ref.rootDir, ref.cwd);
      set((current) => {
        const next = new Map(current.projections);
        next.delete(sessionId);
        next.set(response.session.session.id, {
          ...preservedProjection,
          summary: response.session,
        });
        const replay = takePendingEventsForSessions(new Set([response.session.session.id]));
        return {
          projections: applyEventsToMap(next, replay),
          unreadSessionIds: new Set(
            [...current.unreadSessionIds].filter(
              (sessionIdValue) =>
                sessionIdValue !== sessionId && sessionIdValue !== response.session.session.id,
            ),
          ),
          workspaceDirs: appendVisibleWorkspaceDir(current.workspaceDirs, ref.rootDir ?? ref.cwd),
          workspaceDir: ref.rootDir ?? ref.cwd ?? current.workspaceDir,
          selectedSessionId: response.session.session.id,
          error: null,
        };
      });
      maybeAutoClaimSelectedSession(response.session.session.id);
    } catch (error) {
      set({ error: readErrorMessage(error) });
      throw error;
    }
  },

  attachSession: async (summary) => {
    try {
      const response = await api.attachSession(summary.session.id, {
        client: {
          id: get().clientId,
          kind: "web",
          connectionId: get().clientId,
        },
        mode: "observe",
      });
      updateSessionSummary(response.session);
      set((state) => {
        const unreadSessionIds = new Set(state.unreadSessionIds);
        unreadSessionIds.delete(summary.session.id);
        return { selectedSessionId: summary.session.id, unreadSessionIds, error: null };
      });
      void ensureSessionHistoryLoaded(summary.session.id);
    } catch (error) {
      set({ error: readErrorMessage(error) });
      throw error;
    }
  },

  closeSession: async (sessionId) => {
    try {
      const projection = get().projections.get(sessionId);
      const summary = projection?.summary;
      await api.closeSession(sessionId, {
        clientId: get().clientId,
      });
      set((state) => {
        const nextState: Partial<SessionState> = {
          projections: new Map(
            [...state.projections.entries()].filter(([id]) => id !== sessionId),
          ),
          unreadSessionIds: new Set(
            [...state.unreadSessionIds].filter((id) => id !== sessionId),
          ),
          selectedSessionId: state.selectedSessionId === sessionId ? null : state.selectedSessionId,
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
          nextState.storedSessions = mergeStoredSessionRefs(state.storedSessions, remembered);
          nextState.recentSessions = mergeRecentSessionRefs(state.recentSessions, remembered);
        }
        return nextState as SessionState;
      });
      await get().refreshWorkbenchState();
    } catch (error) {
      set({ error: readErrorMessage(error) });
      throw error;
    }
  },

  claimControl: async (sessionId) => {
    try {
      const summary = await api.claimControl(sessionId, get().clientId);
      updateSessionSummary(summary);
      set({ error: null });
    } catch (error) {
      set({ error: readErrorMessage(error) });
      throw error;
    }
  },

  releaseControl: async (sessionId) => {
    try {
      const summary = await api.releaseControl(sessionId, get().clientId);
      updateSessionSummary(summary);
      set({ error: null });
    } catch (error) {
      set({ error: readErrorMessage(error) });
      throw error;
    }
  },

  interruptSession: async (sessionId) => {
    try {
      const summary = await api.interruptSession(sessionId, get().clientId);
      updateSessionSummary(summary);
      set({ error: null });
    } catch (error) {
      set({ error: readErrorMessage(error) });
      throw error;
    }
  },

  sendInput: async (sessionId, text) => {
    try {
      set((state) => {
        const projection = state.projections.get(sessionId);
        if (!projection) {
          return state;
        }
        const next = new Map(state.projections);
        next.set(sessionId, appendOptimisticUserMessage(projection, text));
        return { projections: next };
      });
      await api.sendSessionInput(sessionId, {
        clientId: get().clientId,
        text,
      });
      set({ error: null });
    } catch (error) {
      set({ error: readErrorMessage(error) });
      throw error;
    }
  },

  ensureSessionHistoryLoaded: async (sessionId) => {
    await ensureSessionHistoryLoaded(sessionId);
  },

  loadOlderHistory: async (sessionId) => {
    const projection = get().projections.get(sessionId);
    if (!projection || projection.history.phase === "loading") {
      return;
    }

    const beforeTs = projection.history.nextBeforeTs ?? projection.feed[0]?.ts ?? undefined;
    const requestGeneration = projection.history.generation + 1;

    set((state) => {
      const current = state.projections.get(sessionId);
      if (!current) {
        return state;
      }
      const next = new Map(state.projections);
      next.set(sessionId, {
        ...current,
        history: {
          ...current.history,
          phase: "loading",
          generation: requestGeneration,
          lastError: null,
        },
      });
      return { projections: next };
    });

    try {
      const page = await api.readSessionHistory(sessionId, {
        ...(beforeTs ? { beforeTs } : {}),
        limit: 1000,
      });
      set((state) => {
        const current = state.projections.get(sessionId);
        if (!current || current.history.generation !== requestGeneration) {
          return state;
        }
        const next = new Map(state.projections);
        const withHistory = prependHistoryPage(current, page.events, page.nextBeforeTs);
        const replayed = applyEventBatchToProjection(
          withHistory,
          takeDeferredBootstrapEvents(sessionId),
        );
        next.set(sessionId, replayed);
        return { projections: next, error: null };
      });
    } catch (error) {
      set((state) => {
        const current = state.projections.get(sessionId);
        if (!current) {
          return { error: readErrorMessage(error) };
        }
        const next = new Map(state.projections);
        const failed = applyEventBatchToProjection({
          ...current,
          history: {
            ...current.history,
            phase: "error",
            lastError: readErrorMessage(error),
          },
        }, takeDeferredBootstrapEvents(sessionId));
        next.set(sessionId, failed);
        return { projections: next, error: readErrorMessage(error) };
      });
      throw error;
    }
  },

  respondToPermission: async (sessionId, requestId, response) => {
    try {
      await api.respondToPermission(sessionId, requestId, response);
      set({ error: null });
    } catch (error) {
      set({ error: readErrorMessage(error) });
      throw error;
    }
  },
}));

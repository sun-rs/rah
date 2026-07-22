import { create } from "zustand";
import type {
  DebugScenarioDescriptor,
  EventBatch,
  PermissionResponseRequest,
  ProviderModelCatalog,
  RahEvent,
  SessionConfigValue,
  SessionInputAttachment,
  ConversationItemDetailKind,
  SessionSummary,
  StoredSessionIdentity,
  StoredSessionRef,
  StoredSessionsDeltaResponse,
  WorkbenchPinnedItemRef,
} from "@rah/runtime-protocol";
import * as api from "./api";
import {
  beginSessionStoreInit,
  maybeRestoreLastHistorySelection as maybeRestoreStoredHistorySelection,
  readErrorMessage,
  readOrCreateClientId,
  readOrCreateConnectionId,
  resetSessionStoreInit,
  revealStoredHistoryWorkspace,
} from "./session-store-bootstrap";
import { isLabModeEnabled } from "./lab-mode";
import { type PendingSessionTransition } from "./session-transition-contract";
import {
  adoptExistingProjectionForProviderSession as adoptExistingProjectionForProviderSessionImpl,
  applyEventBatchToProjection,
  applyEventsToProjectionMap as applyEventsToProjectionMapImpl,
  applySessionsResponse as applySessionsResponseImpl,
  computeUnreadSessionIds as computeUnreadSessionIdsImpl,
  replaceSessionsResponse as replaceSessionsResponseImpl,
  updateSessionSummaryInProjectionMap,
} from "./session-store-projections";
import {
  attachSessionCommand,
  claimControlCommand,
  closeSessionCommand,
  deleteQueuedInputCommand,
  interruptSessionCommand,
  renameSessionCommand,
  releaseControlCommand,
  reorderQueuedInputCommand,
  respondToPermissionCommand,
  sendInputCommand,
  setSessionModeCommand,
  steerQueuedInputCommand,
  updateQueuedInputCommand,
} from "./session-store-session-commands";
import {
  activateHistorySessionCommand,
  cancelPendingSessionStartupCommand,
  resumeHistorySessionCommand,
  resumeStoredSessionCommand,
  forkSessionCommand,
  startScenarioCommand,
  startSessionCommand,
  type ForkSessionOptions,
} from "./session-store-session-startup";
import { isPendingResumeProjectionTransferTarget } from "./session-store-session-lifecycle";
import { notifyForRahEvents } from "./browser-notifications";
import {
  clearPendingEvents,
  clearPendingEventsForSession,
  queuePendingEvent,
  takePendingEventsForSessions,
} from "./session-store-pending-events";
import { syncHistorySelectionSubscription } from "./session-store-history-selection-sync";
import {
  applyConversationDeltasToProjectionMap,
  ensureConversationLoadedCommand,
  initializeLiveConversationCommand,
  loadConversationItemDetailCommand,
  loadConversationTurnDetailCommand,
  loadOlderConversationCommand,
  refreshConversationCommand,
  type ConversationRefreshOptions,
} from "./session-store-conversation";
import {
  ensureSessionConversationDirectoryCommand,
  loadConversationDirectoryTurnCommand,
} from "./session-store-conversation-directory";
import {
  ensureSessionReadStateInitialized,
  hasUnreadSinceReadState,
  markProjectionSeenInState,
  readSessionReadState,
  writeSessionReadState,
} from "./session-read-state";
import {
  connectStoreSyncTransport,
  recoverFromReplayGapCommand,
  recoverTransportCommand,
  type RecoverTransportOptions,
} from "./session-store-sync";
import {
  restartSessionStoreTransport,
} from "./session-store-transport";
import {
  appendVisibleWorkspaceDir,
  hideWorkspace,
  isHiddenWorkspace,
  revealWorkspace,
  sameWorkspaceDirectory,
} from "./session-store-workspace";
import {
  type SessionProjection,
} from "./types";

export {
  computeUnreadSessionIds,
} from "./session-store-projections";
export { readOrCreateClientId, readOrCreateConnectionId } from "./session-store-bootstrap";
export {
  coerceSelectedSessionId,
  findDaemonRunningSessionForStoredRef,
  normalizeWorkspaceDirectory,
  reconcileVisibleWorkspaceSelection,
  resolveHiddenWorkspaceDirsFromSessionsResponse,
  resolveHistoryActivationMode,
  sameWorkspaceDirectory,
} from "./session-store-workspace";

type ProviderChoice = "codex" | "claude" | "opencode";
type StoredSessionsMode = "all" | "cached" | "recent";
const RECENT_STORED_SESSION_LIMIT = 15;

interface StartSessionOptions {
  provider?: ProviderChoice;
  cwd?: string;
  title?: string;
  model?: string;
  optionValues?: Record<string, SessionConfigValue>;
  reasoningId?: string;
  modeId?: string;
  initialInput?: string;
  initialAttachments?: SessionInputAttachment[];
  confirmCreateMissingWorkspace?: (dir: string) => Promise<boolean>;
  onSessionCreated?: (sessionId: string) => void;
}

interface ResumeHistorySessionOptions {
  confirmCreateMissingWorkspace?: (dir: string) => Promise<boolean>;
  modeId?: string;
  modelId?: string;
  optionValues?: Record<string, SessionConfigValue>;
  reasoningId?: string | null;
  initialInput?: string;
  initialAttachments?: SessionInputAttachment[];
}

type ModelCatalogLoadState = {
  catalog: ProviderModelCatalog | null;
  loading: boolean;
  error: string | null;
  loadedAt: number | null;
  lastAttemptedAt: number | null;
  lastSuccessfulFetchedAt: string | null;
};

type RememberProviderModelCatalogOptions = {
  cwd?: string;
};

type LoadProviderModelsOptions = {
  cwd?: string;
  forceRefresh?: boolean;
  staleMs?: number;
  background?: boolean;
  reason?: string;
};

type RefreshWorkbenchStateOptions = {
  storedSessions?: StoredSessionsMode;
  preserveWorkspaceNavigation?: boolean;
  preserveLocalStoppedHistory?: boolean;
  excludeLocalStoppedHistoryKeys?: ReadonlySet<string>;
};

interface SessionState {
  clientId: string;
  connectionId: string;
  projections: Map<string, SessionProjection>;
  unreadSessionIds: Set<string>;
  storedSessions: StoredSessionRef[];
  recentSessions: StoredSessionRef[];
  optimisticallyArchivedSessionKeys: Set<string>;
  storedSessionsCatalogLoaded: boolean;
  storedSessionsCatalogDirty: boolean;
  storedSessionsCatalogRevision: number | null;
  workspaceDirs: string[];
  pinnedSidebarItems: WorkbenchPinnedItemRef[];
  hiddenWorkspaceDirs: Set<string>;
  workspaceVisibilityVersion: number;
  sessionTopologyVersion: number;
  eventStreamOpenRevision: number;
  visibleSessionIds: Set<string>;
  debugScenarios: DebugScenarioDescriptor[];
  modelCatalogs: Record<string, ModelCatalogLoadState>;
  selectedSessionId: string | null;
  workspaceDir: string;
  newSessionProvider: ProviderChoice;
  pendingSessionTransition: PendingSessionTransition | null;
  pendingSessionAction:
    | {
        kind: "attach_session" | "claim_control" | "resume_history";
        sessionId: string;
        provider?: SessionSummary["session"]["provider"];
        providerSessionId?: string;
      }
    | null;
  isInitialLoaded: boolean;
  error: string | null;

  init: () => Promise<void>;
  clearError: () => void;
  refreshWorkbenchState: (options?: RefreshWorkbenchStateOptions) => Promise<void>;
  loadStoredSessionsCatalog: () => Promise<void>;
  recoverTransport: (options?: RecoverTransportOptions) => Promise<void>;
  setWorkspaceDir: (dir: string) => void;
  addWorkspace: (dir: string) => Promise<void>;
  removeWorkspace: (dir: string) => Promise<void>;
  setSidebarItemPinned: (workspaceDir: string, itemKey: string, pinned: boolean) => Promise<void>;
  setSelectedSessionId: (id: string | null) => void;
  setNewSessionProvider: (provider: ProviderChoice) => void;
  loadProviderModels: (
    provider: ProviderChoice,
    options?: LoadProviderModelsOptions,
  ) => Promise<void>;
  rememberProviderModelCatalog: (
    provider: ProviderChoice,
    catalog: ProviderModelCatalog,
    options?: RememberProviderModelCatalogOptions,
  ) => void;
  startSession: (options?: StartSessionOptions) => Promise<string | null>;
  forkSession: (parentSessionId: string, options: ForkSessionOptions) => Promise<string>;
  startScenario: (scenario: DebugScenarioDescriptor) => Promise<void>;
  activateHistorySession: (
    ref: StoredSessionRef,
    options?: { confirmCreateMissingWorkspace?: (dir: string) => Promise<boolean> },
  ) => Promise<void>;
  resumeStoredSession: (
    ref: StoredSessionRef,
    options?: {
      preferStoredReplay?: boolean;
      historyReplay?: "include" | "skip";
      confirmCreateMissingWorkspace?: (dir: string) => Promise<boolean>;
    },
  ) => Promise<void>;
  attachSession: (summary: SessionSummary) => Promise<void>;
  closeSession: (sessionId: string) => Promise<void>;
  renameSession: (sessionId: string, title: string) => Promise<void>;
  setSessionMode: (sessionId: string, modeId: string) => Promise<void>;
  setSessionModel: (
    sessionId: string,
    modelId: string,
    reasoningId?: string | null,
    optionValues?: Record<string, SessionConfigValue>,
  ) => Promise<void>;
  resumeHistorySession: (
    sessionId: string,
    options?: ResumeHistorySessionOptions,
  ) => Promise<string | null>;
  archiveHistorySession: (
    session: Pick<StoredSessionRef, "provider" | "providerSessionId">,
    options?: { runtimeSessionId?: string },
  ) => Promise<void>;
  restoreHistorySession: (session: Pick<StoredSessionRef, "provider" | "providerSessionId">) => Promise<void>;
  removeHistorySession: (session: Pick<StoredSessionRef, "provider" | "providerSessionId">) => Promise<void>;
  removeHistoryWorkspaceSessions: (workspaceDir: string) => Promise<void>;
  setVisibleSessionIds: (sessionIds: readonly string[]) => void;
  markSessionsRead: (sessionIds: readonly string[]) => void;
  reconcileUnreadFromLastSeen: (visibleSessionIds?: readonly string[]) => void;
  claimControl: (sessionId: string) => Promise<void>;
  releaseControl: (sessionId: string) => Promise<void>;
  interruptSession: (sessionId: string) => Promise<void>;
  cancelPendingSessionStartup: (sessionId: string) => boolean;
  sendInput: (
    sessionId: string,
    text: string,
    attachments?: SessionInputAttachment[],
    identity?: {
      clientMessageId: string;
      clientTurnId: string;
      skipOptimisticQueue?: boolean;
    },
  ) => Promise<void>;
  updateQueuedInput: (sessionId: string, clientMessageId: string, text: string) => Promise<void>;
  deleteQueuedInput: (sessionId: string, clientMessageId: string) => Promise<void>;
  reorderQueuedInput: (
    sessionId: string,
    clientMessageId: string,
    position: number,
  ) => Promise<void>;
  steerQueuedInput: (sessionId: string, clientMessageId: string) => Promise<void>;
  ensureConversationLoaded: (sessionId: string) => Promise<boolean>;
  initializeLiveConversation: (sessionId: string) => Promise<boolean>;
  refreshConversation: (
    sessionId: string,
    options?: ConversationRefreshOptions,
  ) => Promise<boolean>;
  loadOlderConversation: (sessionId: string) => Promise<void>;
  loadConversationTurnDetail: (sessionId: string, turnId: string) => Promise<void>;
  ensureSessionConversationDirectory: (sessionId: string) => Promise<void>;
  loadConversationDirectoryTurn: (sessionId: string, turnId: string) => Promise<void>;
  loadConversationItemDetail: (
    sessionId: string,
    kind: ConversationItemDetailKind,
    itemId: string,
  ) => Promise<void>;
  respondToPermission: (
    sessionId: string,
    requestId: string,
    response: PermissionResponseRequest,
  ) => Promise<void>;
}

let lastEventSeq = 0;
let storedSessionsCatalogLoadInFlight: Promise<void> | null = null;
const MODEL_CATALOG_PROVIDERS = new Set<ProviderChoice>([
  "codex",
  "claude",
  "opencode",
]);
const MODEL_CATALOG_TTL_MS = 5 * 60 * 1000;
const MODEL_CATALOG_FAILURE_RETRY_MS = 10 * 1000;
const modelCatalogBackgroundInFlight = new Map<string, Promise<void>>();
const modelCatalogRequestGenerations = new Map<string, number>();
const conversationRefreshInFlight = new Map<string, Promise<boolean>>();

function logModelCatalog(message: string, details?: Record<string, unknown>): void {
  if (details) {
    console.info(`[rah] model catalog ${message}`, details);
    return;
  }
  console.info(`[rah] model catalog ${message}`);
}

export function providerModelCatalogKey(provider: ProviderChoice, cwd?: string): string {
  return `${provider}:${cwd?.trim() || "default"}`;
}

function nextModelCatalogRequestGeneration(key: string): number {
  const generation = (modelCatalogRequestGenerations.get(key) ?? 0) + 1;
  modelCatalogRequestGenerations.set(key, generation);
  return generation;
}

function isSuccessfulModelCatalog(catalog: ProviderModelCatalog): boolean {
  return catalog.source === "native" && catalog.freshness === "authoritative";
}

function createProjectionReplayHandling() {
  return {
    takePendingEventsForSessions,
    updateLastSeq: (seq: number) => {
      lastEventSeq = Math.max(lastEventSeq, seq);
    },
    clearPendingSession: clearPendingEventsForSession,
    queuePendingEvent,
  };
}

function rememberSessionsResponseEventSeq(
  sessionsResponse: Awaited<ReturnType<typeof api.listSessions>>,
) {
  if (typeof sessionsResponse.eventSeq === "number" && Number.isFinite(sessionsResponse.eventSeq)) {
    lastEventSeq = Math.max(lastEventSeq, sessionsResponse.eventSeq);
  }
}

function applySessionsResponse(
  state: Pick<
    SessionState,
    | "projections"
    | "workspaceDir"
    | "selectedSessionId"
    | "hiddenWorkspaceDirs"
    | "workspaceVisibilityVersion"
  > & {
    pinnedSidebarItems?: WorkbenchPinnedItemRef[];
    workspaceDirs?: string[];
    storedSessions?: StoredSessionRef[];
    recentSessions?: StoredSessionRef[];
  },
  sessionsResponse: Awaited<ReturnType<typeof api.listSessions>>,
  options?: {
    workspaceVisibilityVersionAtRequest?: number;
    preserveWorkspaceNavigation?: boolean;
    preserveStoredSessionCatalog?: boolean;
    preserveLocalStoppedHistory?: boolean;
    excludeLocalStoppedHistoryKeys?: ReadonlySet<string>;
  },
): Pick<
  SessionState,
  | "projections"
  | "storedSessions"
  | "recentSessions"
  | "workspaceDirs"
  | "pinnedSidebarItems"
  | "hiddenWorkspaceDirs"
  | "workspaceVisibilityVersion"
  | "workspaceDir"
  | "selectedSessionId"
> {
  rememberSessionsResponseEventSeq(sessionsResponse);
  const mergedSessionsResponse = options?.preserveLocalStoppedHistory
    ? mergeLocalStoppedHistoryRefs(state, sessionsResponse, options.excludeLocalStoppedHistoryKeys)
    : sessionsResponse;
  const next = applySessionsResponseImpl(
    state,
    mergedSessionsResponse,
    createProjectionReplayHandling(),
    options,
  );
  return {
    ...next,
    ...(options?.preserveStoredSessionCatalog && state.storedSessions
      ? {
          storedSessions: mergeStoredSessionCatalogRefs(
            state.storedSessions,
            next.storedSessions,
          ),
        }
      : {}),
    ...(options?.preserveWorkspaceNavigation && state.workspaceDirs !== undefined
      ? {
          workspaceDirs: state.workspaceDirs,
          hiddenWorkspaceDirs: state.hiddenWorkspaceDirs,
          workspaceVisibilityVersion: state.workspaceVisibilityVersion,
          workspaceDir: state.workspaceDir,
        }
      : {}),
  };
}

function storedSessionKey(session: Pick<StoredSessionRef, "provider" | "providerSessionId">): string {
  return `${session.provider}:${session.providerSessionId}`;
}

function markStoredSessionOptimisticallyArchived(
  session: StoredSessionRef,
  key: string,
  archivedAt: string,
): StoredSessionRef {
  if (storedSessionKey(session) !== key) {
    return session;
  }
  return {
    ...session,
    libraryState: {
      placement: "archive",
      archivedAt,
    },
  };
}

function rollbackOptimisticStoredSessionArchive(
  session: StoredSessionRef,
  key: string,
  archivedAt: string,
): StoredSessionRef {
  if (
    storedSessionKey(session) !== key ||
    session.libraryState?.placement !== "archive" ||
    session.libraryState.archivedAt !== archivedAt ||
    session.libraryState.backend !== undefined
  ) {
    return session;
  }
  const { libraryState: _optimisticLibraryState, ...restored } = session;
  void _optimisticLibraryState;
  return restored;
}

function withoutSetValue(values: ReadonlySet<string>, value: string): Set<string> {
  const next = new Set(values);
  next.delete(value);
  return next;
}

function storedSessionCatalogActivityAt(session: StoredSessionRef): string {
  // Catalog order reflects conversation history. `lastUsedAt` is navigation
  // state and must not move a sidebar row merely because the user opened it.
  return session.updatedAt ?? session.createdAt ?? session.lastUsedAt ?? "";
}

function compareStoredSessionCatalogRefs(
  left: StoredSessionRef,
  right: StoredSessionRef,
): number {
  return (
    storedSessionCatalogActivityAt(right).localeCompare(storedSessionCatalogActivityAt(left)) ||
    storedSessionKey(left).localeCompare(storedSessionKey(right))
  );
}

function mergeLocalStoppedHistoryRefs(
  state: {
    storedSessions?: StoredSessionRef[];
    recentSessions?: StoredSessionRef[];
  },
  sessionsResponse: Awaited<ReturnType<typeof api.listSessions>>,
  excludedKeys: ReadonlySet<string> | undefined,
): Awaited<ReturnType<typeof api.listSessions>> {
  if (!state.storedSessions && !state.recentSessions) {
    return sessionsResponse;
  }
  const runningKeys = new Set(
    sessionsResponse.sessions
      .map((summary) => {
        const providerSessionId = summary.session.providerSessionId;
        return providerSessionId
          ? storedSessionKey({
              provider: summary.session.provider,
              providerSessionId,
            })
          : null;
      })
      .filter((key): key is string => key !== null),
  );
  const localStopped = [...(state.storedSessions ?? []), ...(state.recentSessions ?? [])].filter(
    (session, index, sessions) =>
      session.source === "previous_running" &&
      !excludedKeys?.has(storedSessionKey(session)) &&
      !runningKeys.has(storedSessionKey(session)) &&
      sessions.findIndex((candidate) => storedSessionKey(candidate) === storedSessionKey(session)) === index,
  );
  if (localStopped.length === 0) {
    return sessionsResponse;
  }
  const appendMissing = (sessions: StoredSessionRef[]) => {
    const keys = new Set(sessions.map(storedSessionKey));
    let changed = false;
    const next = [...sessions];
    for (const session of localStopped) {
      const key = storedSessionKey(session);
      if (keys.has(key)) {
        continue;
      }
      keys.add(key);
      next.push(session);
      changed = true;
    }
    return changed ? next : sessions;
  };
  const storedSessions = appendMissing(sessionsResponse.storedSessions);
  const recentSessions = appendMissing(sessionsResponse.recentSessions);
  if (
    storedSessions === sessionsResponse.storedSessions &&
    recentSessions === sessionsResponse.recentSessions
  ) {
    return sessionsResponse;
  }
  return {
    ...sessionsResponse,
    storedSessions,
    recentSessions,
  };
}

function mergeStoredSessionCatalogRefs(
  current: readonly StoredSessionRef[],
  incoming: readonly StoredSessionRef[],
): StoredSessionRef[] {
  const byKey = new Map(current.map((session) => [storedSessionKey(session), session] as const));
  for (const session of incoming) {
    byKey.set(storedSessionKey(session), session);
  }
  return [...byKey.values()].sort(compareStoredSessionCatalogRefs);
}

function omitStoredSessionCatalogRefs(
  current: readonly StoredSessionRef[],
  omittedKeys: ReadonlySet<string>,
): StoredSessionRef[] {
  if (omittedKeys.size === 0) {
    return [...current];
  }
  return current.filter((session) => !omittedKeys.has(storedSessionKey(session)));
}

function applyStoredSessionOmissionResponse(
  state: SessionState,
  sessionsResponse: Awaited<ReturnType<typeof api.listSessions>>,
  omittedKeys: ReadonlySet<string>,
  workspaceVisibilityVersionAtRequest: number,
) {
  const applied = applySessionsResponse(state, sessionsResponse, {
    workspaceVisibilityVersionAtRequest,
    preserveLocalStoppedHistory: true,
    excludeLocalStoppedHistoryKeys: omittedKeys,
  });
  const recentSessions = omitStoredSessionCatalogRefs(applied.recentSessions, omittedKeys);
  const storedSessions = state.storedSessionsCatalogLoaded
    ? mergeStoredSessionCatalogRefs(
        omitStoredSessionCatalogRefs(state.storedSessions, omittedKeys),
        omitStoredSessionCatalogRefs(applied.storedSessions, omittedKeys),
      )
    : omitStoredSessionCatalogRefs(applied.storedSessions, omittedKeys);
  return {
    ...applied,
    storedSessions,
    recentSessions,
    error: null,
  };
}

function sortStoredSessionCatalogRefs(sessions: Iterable<StoredSessionRef>): StoredSessionRef[] {
  return [...sessions].sort(compareStoredSessionCatalogRefs);
}

export function applyStoredSessionsDeltaToCatalog(
  current: readonly StoredSessionRef[],
  delta: Pick<StoredSessionsDeltaResponse, "upsert" | "remove">,
): StoredSessionRef[] {
  const byKey = new Map(current.map((session) => [storedSessionKey(session), session] as const));
  for (const removed of delta.remove) {
    byKey.delete(storedSessionKey(removed));
  }
  for (const session of delta.upsert) {
    byKey.set(storedSessionKey(session), session);
  }
  return sortStoredSessionCatalogRefs(byKey.values());
}

export function applyStoredSessionsDeltaToRecent(
  current: readonly StoredSessionRef[],
  delta: Pick<StoredSessionsDeltaResponse, "upsert" | "remove">,
): StoredSessionRef[] {
  return applyStoredSessionsDeltaToCatalog(current, delta).slice(
    0,
    RECENT_STORED_SESSION_LIMIT,
  );
}

function discoveryDeltaFromEvents(events: readonly RahEvent[]): StoredSessionsDeltaResponse | null {
  let fromRevision = 0;
  let revision = 0;
  const upsertByKey = new Map<string, StoredSessionRef>();
  const removeByKey = new Map<string, StoredSessionIdentity>();
  let sawDelta = false;
  for (const event of events) {
    if (event.type !== "session.discovery" || !event.payload.storedSessions) {
      continue;
    }
    const delta = event.payload.storedSessions;
    sawDelta = true;
    if (revision === 0) {
      fromRevision = Math.max(0, delta.revision - 1);
    }
    revision = Math.max(revision, delta.revision);
    for (const removed of delta.remove ?? []) {
      const key = storedSessionKey(removed);
      upsertByKey.delete(key);
      removeByKey.set(key, removed);
    }
    for (const session of delta.upsert ?? []) {
      const key = storedSessionKey(session);
      removeByKey.delete(key);
      upsertByKey.set(key, session);
    }
    if (delta.resetRequired) {
      return {
        fromRevision,
        revision,
        upsert: [],
        remove: [],
        resetRequired: true,
      };
    }
  }
  if (!sawDelta) {
    return null;
  }
  return {
    fromRevision,
    revision,
    upsert: [...upsertByKey.values()],
    remove: [...removeByKey.values()],
  };
}

function pinnedSidebarItemsFromDiscoveryEvents(
  events: readonly RahEvent[],
): WorkbenchPinnedItemRef[] | null {
  let latest: WorkbenchPinnedItemRef[] | null = null;
  for (const event of events) {
    if (event.type !== "session.discovery" || !event.payload.workbench) {
      continue;
    }
    latest = event.payload.workbench.pinnedSidebarItems.map((item) => ({ ...item }));
  }
  return latest;
}

function replaceSessionsResponse(
  state: Pick<
    SessionState,
    | "projections"
    | "workspaceDir"
    | "selectedSessionId"
    | "hiddenWorkspaceDirs"
    | "workspaceVisibilityVersion"
  > & {
    storedSessions?: StoredSessionRef[];
    recentSessions?: StoredSessionRef[];
  },
  sessionsResponse: Awaited<ReturnType<typeof api.listSessions>>,
  options?: {
    workspaceVisibilityVersionAtRequest?: number;
    preserveStoredSessionCatalog?: boolean;
  },
): Pick<
  SessionState,
  | "projections"
  | "storedSessions"
  | "recentSessions"
  | "workspaceDirs"
  | "hiddenWorkspaceDirs"
  | "workspaceVisibilityVersion"
  | "workspaceDir"
  | "selectedSessionId"
> {
  rememberSessionsResponseEventSeq(sessionsResponse);
  const next = replaceSessionsResponseImpl(state, sessionsResponse, options);
  if (!options?.preserveStoredSessionCatalog || !state.storedSessions) {
    return next;
  }
  return {
    ...next,
    storedSessions: mergeStoredSessionCatalogRefs(state.storedSessions, next.storedSessions),
  };
}

function applyEventsToMap(
  current: Map<string, SessionProjection>,
  events: RahEvent[],
): Map<string, SessionProjection> {
  return applyEventsToProjectionMapImpl(current, events, createProjectionReplayHandling());
}

function adoptExistingProjectionForProviderSession(
  projections: Map<string, SessionProjection>,
  summary: SessionSummary,
): Map<string, SessionProjection> {
  return adoptExistingProjectionForProviderSessionImpl(projections, summary);
}

function storedSessionsModeForState(
  state: Pick<SessionState, "storedSessionsCatalogLoaded">,
): StoredSessionsMode {
  return state.storedSessionsCatalogLoaded ? "all" : "recent";
}

export function applyStoredSessionDiscoveryEvents(events: readonly RahEvent[]): boolean {
  const delta = discoveryDeltaFromEvents(events);
  const pinnedSidebarItems = pinnedSidebarItemsFromDiscoveryEvents(events);
  let needsNetworkRefresh = false;
  useSessionStore.setState((state) => {
    if (!delta || delta.resetRequired) {
      needsNetworkRefresh = pinnedSidebarItems === null || Boolean(delta?.resetRequired);
      return {
        ...(pinnedSidebarItems === null ? {} : { pinnedSidebarItems }),
        ...(delta?.resetRequired ? { storedSessionsCatalogDirty: true } : {}),
      };
    }
    const recentSessions = applyStoredSessionsDeltaToRecent(state.recentSessions, delta);
    if (!state.storedSessionsCatalogLoaded || state.storedSessionsCatalogRevision === null) {
      return {
        ...(pinnedSidebarItems === null ? {} : { pinnedSidebarItems }),
        recentSessions,
        storedSessionsCatalogDirty: true,
      };
    }
    if (state.storedSessionsCatalogRevision !== delta.fromRevision) {
      needsNetworkRefresh = true;
      return {
        ...(pinnedSidebarItems === null ? {} : { pinnedSidebarItems }),
        storedSessionsCatalogDirty: true,
      };
    }
    return {
      ...(pinnedSidebarItems === null ? {} : { pinnedSidebarItems }),
      storedSessions: applyStoredSessionsDeltaToCatalog(state.storedSessions, delta),
      recentSessions,
      storedSessionsCatalogRevision: delta.revision,
      storedSessionsCatalogDirty: false,
    };
  });
  return needsNetworkRefresh;
}

function shouldSkipSessionsResponseForTopology(
  state: Pick<SessionState, "sessionTopologyVersion" | "pendingSessionAction">,
  sessionTopologyVersionAtRequest: number,
): boolean {
  return (
    state.sessionTopologyVersion !== sessionTopologyVersionAtRequest ||
    state.pendingSessionAction?.kind === "resume_history"
  );
}

function updateSessionSummary(session: SessionSummary) {
  useSessionStore.setState((state) => {
    return {
      projections: updateSessionSummaryInProjectionMap(state.projections, session),
    };
  });
}

async function ensureConversationReady(sessionId: string) {
  await useSessionStore.getState().ensureConversationLoaded(sessionId);
}

function refreshConversationBaseline(
  sessionId: string,
  options: ConversationRefreshOptions = {},
): Promise<boolean> {
  const existing = conversationRefreshInFlight.get(sessionId);
  if (existing && !options.replaceActive) {
    return existing;
  }
  let request!: Promise<boolean>;
  request = refreshConversationCommand(
    {
      get: useSessionStore.getState,
      set: useSessionStore.setState,
    },
    sessionId,
    options,
  ).finally(() => {
    if (conversationRefreshInFlight.get(sessionId) === request) {
      conversationRefreshInFlight.delete(sessionId);
    }
  });
  conversationRefreshInFlight.set(sessionId, request);
  return request;
}

function refreshConversationGapIfNeeded(sessionId: string): void {
  const state = useSessionStore.getState();
  const conversation = state.projections.get(sessionId)?.conversation;
  if (
    !conversation ||
    !conversation.needsRefresh ||
    conversation.phase === "loading" ||
    conversationRefreshInFlight.has(sessionId)
  ) {
    return;
  }
  void refreshConversationBaseline(sessionId);
}

function recoverConversationDeltaGaps(
  deltas: readonly { sessionId: string }[],
): void {
  for (const sessionId of new Set(deltas.map((delta) => delta.sessionId))) {
    refreshConversationGapIfNeeded(sessionId);
  }
}

function createStartupDeps(
  get: () => SessionState,
  set: (
    partial:
      | Partial<SessionState>
      | ((state: SessionState) => Partial<SessionState> | SessionState),
  ) => void,
  options?: ResumeHistorySessionOptions,
) {
  return {
    get,
    set,
    ensureConversationLoaded: ensureConversationReady,
    initializeLiveConversationProjection: async (sessionId: string) => {
      await get().initializeLiveConversation(sessionId);
    },
    sendInput: get().sendInput,
    attachSession: get().attachSession,
    resumeStoredSession: get().resumeStoredSession,
    applySessionsResponse,
    adoptExistingProjectionForProviderSession,
    applyEventsToMap,
    takePendingEventsForSessions,
    confirmCreateMissingWorkspace:
      options?.confirmCreateMissingWorkspace ??
      (async () => false),
  };
}

async function maybeRestoreLastHistorySelection(
  sessionsResponse: Awaited<ReturnType<typeof api.listSessions>>,
) {
  await maybeRestoreStoredHistorySelection({
    isInitialLoaded: useSessionStore.getState().isInitialLoaded,
    sessionsResponse,
    revealWorkspaceSelection: (workspaceDir) => {
      useSessionStore.setState((state) =>
        revealStoredHistoryWorkspace({
          workspaceDir,
          hiddenWorkspaceDirs: state.hiddenWorkspaceDirs,
          workspaceDirs: state.workspaceDirs,
        }),
      );
    },
    resumeStoredSession: (ref, options) => useSessionStore.getState().resumeStoredSession(ref, options),
  });
}

async function recoverFromReplayGap(batch: EventBatch) {
  await recoverFromReplayGapCommand({
    batch,
    get: useSessionStore.getState as never,
    set: useSessionStore.setState as never,
    clearPendingEvents,
    updateLastSeq: (seq) => {
      lastEventSeq = Math.max(lastEventSeq, seq);
    },
    replaceSessionsResponse: replaceSessionsResponse as never,
    applyEventsToMap,
    ensureConversationLoaded: ensureConversationReady,
  });
  const loadedSessionIds = [...useSessionStore.getState().projections.entries()]
    .filter(([, projection]) => projection.conversation?.phase === "ready")
    .map(([sessionId]) => sessionId);
  await Promise.all(loadedSessionIds.map((sessionId) => refreshConversationBaseline(sessionId)));
}

function connectStoreTransport() {
  connectStoreSyncTransport({
    getReplayFromSeq: () => (lastEventSeq > 0 ? lastEventSeq + 1 : undefined),
    isInitialLoaded: () => useSessionStore.getState().isInitialLoaded,
    set: useSessionStore.setState as never,
    getNotificationProjections: () => useSessionStore.getState().projections,
    applyEventsToMap,
    applyConversationDeltasToMap: applyConversationDeltasToProjectionMap,
    computeUnreadSessionIds: computeUnreadSessionIdsImpl,
    getVisibleSessionIds: () => useSessionStore.getState().visibleSessionIds,
    notifyUnreadEvents: notifyForRahEvents,
    onConversationDeltasApplied: recoverConversationDeltaGaps,
    recoverFromReplayGap,
    refreshWorkbenchState: (events) => {
      if (!applyStoredSessionDiscoveryEvents(events)) {
        return Promise.resolve();
      }
      return useSessionStore
        .getState()
        .refreshWorkbenchState({ storedSessions: "recent", preserveWorkspaceNavigation: true });
    },
  });
}

export const useSessionStore = create<SessionState>((set, get) => ({
  clientId: readOrCreateClientId(),
  connectionId: readOrCreateConnectionId(),
  projections: new Map(),
  unreadSessionIds: new Set(),
  storedSessions: [],
  recentSessions: [],
  optimisticallyArchivedSessionKeys: new Set(),
  storedSessionsCatalogLoaded: false,
  storedSessionsCatalogDirty: false,
  storedSessionsCatalogRevision: null,
  workspaceDirs: [],
  pinnedSidebarItems: [],
  hiddenWorkspaceDirs: new Set(),
  workspaceVisibilityVersion: 0,
  sessionTopologyVersion: 0,
  eventStreamOpenRevision: 0,
  visibleSessionIds: new Set<string>(),
  debugScenarios: [],
  modelCatalogs: {},
  selectedSessionId: null,
  workspaceDir: "",
  newSessionProvider: "codex",
  pendingSessionTransition: null,
  pendingSessionAction: null,
  isInitialLoaded: false,
  error: null,

  clearError: () => set({ error: null }),
  recoverTransport: async (options) => {
    await recoverTransportCommand({
      get: get as never,
      set: set as never,
      applySessionsResponse: applySessionsResponse as never,
      restartTransport: restartSessionStoreTransport,
      maybeRestoreLastHistorySelection,
    }, options);
  },
  setWorkspaceDir: (dir) => {
    if (!dir.trim()) {
      set({ workspaceDir: "" });
      return;
    }
    const workspaceVisibilityVersionAtRequest = get().workspaceVisibilityVersion;
    set((state) => {
      const workspaceDirs = appendVisibleWorkspaceDir(
        state.hiddenWorkspaceDirs,
        state.workspaceDirs,
        dir,
      );
      return {
        workspaceDir: isHiddenWorkspace(state.hiddenWorkspaceDirs, dir) ? "" : dir,
        workspaceDirs,
      };
    });
    const storedSessionsMode = storedSessionsModeForState(get());
    void api
      .selectWorkspace({ dir }, { storedSessions: storedSessionsMode })
      .then((sessionsResponse) =>
        set((state) => ({
          ...applySessionsResponse(state, sessionsResponse, {
            workspaceVisibilityVersionAtRequest,
          }),
          error: null,
        })),
      )
      .catch((error) => {
        set({ error: readErrorMessage(error) });
      });
  },
  addWorkspace: async (dir) => {
    try {
      const storedSessionsMode = storedSessionsModeForState(get());
      const sessionsResponse = await api.addWorkspace(
        { dir },
        { storedSessions: storedSessionsMode },
      );
      set((state) => {
        const workspaceVisibilityVersion = state.workspaceVisibilityVersion + 1;
        return {
          ...applySessionsResponse(
            {
              ...state,
              hiddenWorkspaceDirs: revealWorkspace(state.hiddenWorkspaceDirs, dir),
              workspaceDir: dir,
              workspaceVisibilityVersion,
            },
            sessionsResponse,
            { workspaceVisibilityVersionAtRequest: workspaceVisibilityVersion },
          ),
          workspaceVisibilityVersion,
          error: null,
        };
      });
    } catch (error) {
      set({ error: readErrorMessage(error) });
      throw error;
    }
  },
  removeWorkspace: async (dir) => {
    try {
      set((state) => ({
        hiddenWorkspaceDirs: hideWorkspace(state.hiddenWorkspaceDirs, dir),
        workspaceDirs: state.workspaceDirs.filter(
          (workspaceDir) => !sameWorkspaceDirectory(workspaceDir, dir),
        ),
        workspaceDir: sameWorkspaceDirectory(state.workspaceDir, dir) ? "" : state.workspaceDir,
        workspaceVisibilityVersion: state.workspaceVisibilityVersion + 1,
        error: null,
      }));
      const workspaceVisibilityVersionAtRequest = get().workspaceVisibilityVersion;
      const storedSessionsMode = storedSessionsModeForState(get());
      const sessionsResponse = await api.removeWorkspace(
        { dir },
        { storedSessions: storedSessionsMode },
      );
      set((state) => ({
        ...applySessionsResponse(
          {
            ...state,
            hiddenWorkspaceDirs: state.hiddenWorkspaceDirs,
            workspaceDir: sameWorkspaceDirectory(state.workspaceDir, dir) ? "" : state.workspaceDir,
          },
          sessionsResponse,
          { workspaceVisibilityVersionAtRequest },
        ),
        error: null,
      }));
    } catch (error) {
      try {
        set((state) => ({
          hiddenWorkspaceDirs: revealWorkspace(state.hiddenWorkspaceDirs, dir),
          workspaceVisibilityVersion: state.workspaceVisibilityVersion + 1,
        }));
        const workspaceVisibilityVersionAtRequest = get().workspaceVisibilityVersion;
        const sessionsResponse = await api.listSessions({
          storedSessions: storedSessionsModeForState(get()),
        });
        set((state) => ({
          ...applySessionsResponse(state, sessionsResponse, {
            workspaceVisibilityVersionAtRequest,
          }),
          error: readErrorMessage(error),
        }));
      } catch {
        set((state) => ({
          hiddenWorkspaceDirs: revealWorkspace(state.hiddenWorkspaceDirs, dir),
          workspaceVisibilityVersion: state.workspaceVisibilityVersion + 1,
          error: readErrorMessage(error),
        }));
      }
      throw error;
    }
  },
  setSidebarItemPinned: async (workspaceDir, itemKey, pinned) => {
    try {
      const storedSessionsMode = storedSessionsModeForState(get());
      const sessionsResponse = await api.setWorkbenchPinnedItem(
        { workspaceDir, itemKey, pinned },
        { storedSessions: storedSessionsMode },
      );
      set((state) => ({
        ...applySessionsResponse(state, sessionsResponse, {
          preserveWorkspaceNavigation: true,
          preserveStoredSessionCatalog: true,
        }),
        error: null,
      }));
    } catch (error) {
      set({ error: readErrorMessage(error) });
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
        void ensureConversationReady(id);
      }
    },
  setNewSessionProvider: (provider) => {
    set({ newSessionProvider: provider });
    if (MODEL_CATALOG_PROVIDERS.has(provider)) {
      const cwd = get().workspaceDir.trim() || undefined;
      void get().loadProviderModels(provider, {
        ...(cwd ? { cwd } : {}),
        background: true,
        reason: "new-session-provider",
      }).catch(() => undefined);
    }
  },

  rememberProviderModelCatalog: (provider, catalog, options) => {
    if (!MODEL_CATALOG_PROVIDERS.has(provider)) {
      return;
    }
    const catalogKey = providerModelCatalogKey(provider, options?.cwd);
    nextModelCatalogRequestGeneration(catalogKey);
    const now = Date.now();
    set((state) => ({
      modelCatalogs: {
        ...state.modelCatalogs,
        [catalogKey]: {
          catalog,
          loading: false,
          error: null,
          loadedAt: now,
          lastAttemptedAt: now,
          lastSuccessfulFetchedAt: isSuccessfulModelCatalog(catalog)
            ? catalog.fetchedAt
            : state.modelCatalogs[catalogKey]?.lastSuccessfulFetchedAt ?? null,
        },
      },
    }));
  },

  loadProviderModels: async (provider, options) => {
    const catalogKey = providerModelCatalogKey(provider, options?.cwd);
    if (!MODEL_CATALOG_PROVIDERS.has(provider)) {
      set((state) => ({
        modelCatalogs: {
          ...state.modelCatalogs,
          [catalogKey]: {
            catalog: null,
            loading: false,
            error: null,
            loadedAt: null,
            lastAttemptedAt: null,
            lastSuccessfulFetchedAt: null,
          },
        },
      }));
      return;
    }
    const current = get().modelCatalogs[catalogKey];
    const staleMs = options?.staleMs ?? MODEL_CATALOG_TTL_MS;
    if (current?.loading) {
      return;
    }
    if (
      current !== undefined &&
      current.loadedAt !== null &&
      !options?.forceRefresh &&
      Date.now() - current.loadedAt < staleMs
    ) {
      return;
    }
    if (
      options?.background &&
      !options.forceRefresh &&
      !current?.catalog &&
      current?.lastAttemptedAt !== null &&
      current?.lastAttemptedAt !== undefined &&
      Date.now() - current.lastAttemptedAt < MODEL_CATALOG_FAILURE_RETRY_MS
    ) {
      return;
    }
    const backgroundInFlightKey = options?.background
      ? catalogKey
      : null;
    if (backgroundInFlightKey) {
      const inFlight = modelCatalogBackgroundInFlight.get(backgroundInFlightKey);
      if (inFlight) {
        await inFlight;
        return;
      }
    }
    const startedAt = Date.now();
    const requestGeneration = nextModelCatalogRequestGeneration(catalogKey);
    if (!options?.background) {
      set((state) => ({
        modelCatalogs: {
          ...state.modelCatalogs,
          [catalogKey]: {
            catalog: current?.catalog ?? null,
            loading: true,
            error: null,
            loadedAt: current?.loadedAt ?? null,
            lastAttemptedAt: startedAt,
            lastSuccessfulFetchedAt: current?.lastSuccessfulFetchedAt ?? null,
          },
        },
      }));
    }
    if (options?.background) {
      logModelCatalog("refresh start", {
        provider,
        reason: options.reason ?? "background",
      });
    }
    try {
      const catalogRequest = api.listProviderModels(provider, {
        ...(options?.cwd ? { cwd: options.cwd } : {}),
        ...(options?.forceRefresh ? { forceRefresh: options.forceRefresh } : {}),
      });
      if (backgroundInFlightKey) {
        let backgroundRequest: Promise<void>;
        backgroundRequest = catalogRequest
          .then(() => undefined, () => undefined)
          .finally(() => {
            if (modelCatalogBackgroundInFlight.get(backgroundInFlightKey) === backgroundRequest) {
              modelCatalogBackgroundInFlight.delete(backgroundInFlightKey);
            }
          });
        modelCatalogBackgroundInFlight.set(backgroundInFlightKey, backgroundRequest);
      }
      const catalog = await catalogRequest;
      if (modelCatalogRequestGenerations.get(catalogKey) !== requestGeneration) {
        return;
      }
      const loadedAt = Date.now();
      const lastSuccessfulFetchedAt = isSuccessfulModelCatalog(catalog)
        ? catalog.fetchedAt
        : current?.lastSuccessfulFetchedAt ?? null;
      set((state) => ({
        modelCatalogs: {
          ...state.modelCatalogs,
          [catalogKey]: {
            catalog,
            loading: false,
            error: null,
            loadedAt,
            lastAttemptedAt: startedAt,
            lastSuccessfulFetchedAt,
          },
        },
      }));
      const changed =
        !current?.catalog ||
        catalog.source !== current.catalog.source ||
        catalog.fetchedAt !== current.catalog.fetchedAt ||
        catalog.revision !== current.catalog.revision;
      if (options?.background && changed) {
        logModelCatalog("refresh complete", {
          provider,
          reason: options.reason ?? "background",
          source: catalog.source,
          freshness: catalog.freshness ?? null,
          revision: catalog.revision ?? null,
          models: catalog.models.length,
          elapsedMs: Date.now() - startedAt,
        });
      }
    } catch (error) {
      if (options?.background) {
        console.warn("[rah] model catalog refresh failed", {
          provider,
          reason: options.reason ?? "background",
          error: readErrorMessage(error),
        });
        if (modelCatalogRequestGenerations.get(catalogKey) !== requestGeneration) {
          return;
        }
        set((state) => {
          const currentState = state.modelCatalogs[catalogKey];
          return {
            modelCatalogs: {
              ...state.modelCatalogs,
              [catalogKey]: {
                catalog: currentState?.catalog ?? null,
                loading: false,
                error: null,
                loadedAt: currentState?.loadedAt ?? null,
                lastAttemptedAt: startedAt,
                lastSuccessfulFetchedAt: currentState?.lastSuccessfulFetchedAt ?? null,
              },
            },
          };
        });
        return;
      }
      if (modelCatalogRequestGenerations.get(catalogKey) !== requestGeneration) {
        return;
      }
      set((state) => ({
        modelCatalogs: {
          ...state.modelCatalogs,
          [catalogKey]: {
            catalog: state.modelCatalogs[catalogKey]?.catalog ?? null,
            loading: false,
            error: readErrorMessage(error),
            loadedAt: state.modelCatalogs[catalogKey]?.loadedAt ?? null,
            lastAttemptedAt: startedAt,
            lastSuccessfulFetchedAt: state.modelCatalogs[catalogKey]?.lastSuccessfulFetchedAt ?? null,
          },
        },
      }));
    }
  },

  refreshWorkbenchState: async (options = {}) => {
    try {
      const requestState = get();
      const workspaceVisibilityVersionAtRequest = requestState.workspaceVisibilityVersion;
      const sessionTopologyVersionAtRequest = requestState.sessionTopologyVersion;
      const storedSessionsMode = options.storedSessions ?? "recent";
      const [sessionsResponse, debugScenarios] = await Promise.all([
        api.listSessions({ storedSessions: storedSessionsMode }),
        isLabModeEnabled() ? api.listDebugScenarios() : Promise.resolve([]),
      ]);
      set((state) => {
        const responseRevision = sessionsResponse.storedSessionsRevision ?? null;
        const carriesStoredSessionCatalog = storedSessionsMode !== "recent";
        const catalogResponseIsStale =
          carriesStoredSessionCatalog &&
          responseRevision !== null &&
          state.storedSessionsCatalogRevision !== null &&
          responseRevision < state.storedSessionsCatalogRevision;
        const catalogLoadedPatch = {
          storedSessionsCatalogLoaded:
            carriesStoredSessionCatalog && !catalogResponseIsStale
              ? true
              : state.storedSessionsCatalogLoaded,
          storedSessionsCatalogDirty:
            storedSessionsMode === "all" && !catalogResponseIsStale
              ? false
              : storedSessionsMode === "cached" && !catalogResponseIsStale
                ? true
                : state.storedSessionsCatalogDirty,
          storedSessionsCatalogRevision:
            storedSessionsMode === "all" && !catalogResponseIsStale
              ? responseRevision ?? state.storedSessionsCatalogRevision
              : storedSessionsMode === "cached" && !catalogResponseIsStale
                ? null
                : state.storedSessionsCatalogRevision,
          debugScenarios,
          error: null,
        };
        if (shouldSkipSessionsResponseForTopology(state, sessionTopologyVersionAtRequest)) {
          if (!carriesStoredSessionCatalog || catalogResponseIsStale) {
            return catalogLoadedPatch;
          }
          const catalogResponse = options.preserveLocalStoppedHistory ?? true
            ? mergeLocalStoppedHistoryRefs(state, sessionsResponse, undefined)
            : sessionsResponse;
          return {
            ...catalogLoadedPatch,
            storedSessions: catalogResponse.storedSessions,
            recentSessions: catalogResponse.recentSessions,
          };
        }
        const applied = applySessionsResponse(state, sessionsResponse, {
          workspaceVisibilityVersionAtRequest,
          preserveLocalStoppedHistory: options.preserveLocalStoppedHistory ?? true,
          ...(options.preserveWorkspaceNavigation !== undefined
            ? { preserveWorkspaceNavigation: options.preserveWorkspaceNavigation }
            : {}),
        });
        const storedSessions = catalogResponseIsStale
          ? state.storedSessions
          : storedSessionsMode === "recent" && state.storedSessionsCatalogLoaded
            ? mergeStoredSessionCatalogRefs(state.storedSessions, applied.storedSessions)
            : applied.storedSessions;
        return {
          ...applied,
          storedSessions,
          ...(catalogResponseIsStale ? { recentSessions: state.recentSessions } : {}),
          ...catalogLoadedPatch,
        };
      });
      await maybeRestoreLastHistorySelection(sessionsResponse);
    } catch (error) {
      set({ error: readErrorMessage(error) });
      throw error;
    }
  },

  loadStoredSessionsCatalog: async () => {
    const state = get();
    if (state.storedSessionsCatalogLoaded && !state.storedSessionsCatalogDirty) {
      return;
    }
    if (!storedSessionsCatalogLoadInFlight) {
      storedSessionsCatalogLoadInFlight = (async () => {
        const current = get();
        if (
          current.storedSessionsCatalogLoaded &&
          current.storedSessionsCatalogDirty &&
          current.storedSessionsCatalogRevision !== null
        ) {
          try {
            const delta = await api.listStoredSessionsDelta(current.storedSessionsCatalogRevision);
            if (!delta.resetRequired) {
              set((state) => {
                if (
                  !state.storedSessionsCatalogLoaded ||
                  state.storedSessionsCatalogRevision !== delta.fromRevision
                ) {
                  return { storedSessionsCatalogDirty: true };
                }
                return {
                  storedSessions: applyStoredSessionsDeltaToCatalog(state.storedSessions, delta),
                  storedSessionsCatalogRevision: delta.revision,
                  storedSessionsCatalogDirty: false,
                  error: null,
                };
              });
              return;
            }
          } catch {
            // Older daemons and transient delta failures fall back to the authoritative full catalog.
          }
        }
        await get().refreshWorkbenchState({ storedSessions: "all", preserveWorkspaceNavigation: true });
      })().finally(() => {
        storedSessionsCatalogLoadInFlight = null;
      });
    }
    await storedSessionsCatalogLoadInFlight;
  },

  init: async () => {
    if (!beginSessionStoreInit()) {
      return;
    }
    try {
      await get().refreshWorkbenchState({ storedSessions: "cached" });
      set({ isInitialLoaded: true });
      connectStoreTransport();
    } catch (error) {
      resetSessionStoreInit();
      set({
        isInitialLoaded: true,
        error: readErrorMessage(error),
      });
    }
  },

  startSession: async (options) => {
    return startSessionCommand(createStartupDeps(get, set, options), options);
  },

  forkSession: async (parentSessionId, options) => {
    return forkSessionCommand(createStartupDeps(get, set), parentSessionId, options);
  },

  startScenario: async (scenario) => {
    await startScenarioCommand(createStartupDeps(get, set), scenario);
  },

  activateHistorySession: async (
    ref,
    options?: { confirmCreateMissingWorkspace?: (dir: string) => Promise<boolean> },
  ) => {
    await activateHistorySessionCommand(createStartupDeps(get, set, options), ref, options);
  },

  resumeStoredSession: async (ref, options) => {
    await resumeStoredSessionCommand(createStartupDeps(get, set, options), ref, options);
  },

  resumeHistorySession: async (sessionId, options) => {
    return resumeHistorySessionCommand(
      createStartupDeps(get, set, options),
      sessionId,
      {
        ...(options?.modeId ? { modeId: options.modeId } : {}),
        ...(options?.modelId ? { modelId: options.modelId } : {}),
        ...(options?.optionValues !== undefined ? { optionValues: options.optionValues } : {}),
        ...(options?.reasoningId !== undefined ? { reasoningId: options.reasoningId } : {}),
        ...(options?.initialInput !== undefined ? { initialInput: options.initialInput } : {}),
        ...(options?.initialAttachments !== undefined
          ? { initialAttachments: options.initialAttachments }
          : {}),
      },
    );
  },

  archiveHistorySession: async (session, options) => {
    const key = storedSessionKey(session);
    const optimisticArchivedAt = new Date().toISOString();
    set((state) => ({
      storedSessions: state.storedSessions.map((entry) =>
        markStoredSessionOptimisticallyArchived(entry, key, optimisticArchivedAt),
      ),
      recentSessions: state.recentSessions.map((entry) =>
        markStoredSessionOptimisticallyArchived(entry, key, optimisticArchivedAt),
      ),
      optimisticallyArchivedSessionKeys: new Set([
        ...state.optimisticallyArchivedSessionKeys,
        key,
      ]),
      error: null,
    }));
    try {
      const workspaceVisibilityVersionAtRequest = get().workspaceVisibilityVersion;
      const archivedKeys = new Set([key]);
      const sessionsResponse = await api.archiveStoredSession(
        {
          ...session,
          ...(options?.runtimeSessionId
            ? {
                runtimeSessionId: options.runtimeSessionId,
                clientId: get().clientId,
              }
            : {}),
        },
        { storedSessions: "recent" },
      );
      set((state) => {
        const applied = applySessionsResponse(state, sessionsResponse, {
          workspaceVisibilityVersionAtRequest,
          preserveStoredSessionCatalog: state.storedSessionsCatalogLoaded,
          preserveLocalStoppedHistory: true,
          excludeLocalStoppedHistoryKeys: archivedKeys,
        });
        return {
          ...applied,
          optimisticallyArchivedSessionKeys: withoutSetValue(
            state.optimisticallyArchivedSessionKeys,
            key,
          ),
          error: null,
        };
      });
    } catch (error) {
      set((state) => ({
        storedSessions: state.storedSessions.map((entry) =>
          rollbackOptimisticStoredSessionArchive(entry, key, optimisticArchivedAt),
        ),
        recentSessions: state.recentSessions.map((entry) =>
          rollbackOptimisticStoredSessionArchive(entry, key, optimisticArchivedAt),
        ),
        optimisticallyArchivedSessionKeys: withoutSetValue(
          state.optimisticallyArchivedSessionKeys,
          key,
        ),
        error: readErrorMessage(error),
      }));
      throw error;
    }
  },

  restoreHistorySession: async (session) => {
    try {
      const workspaceVisibilityVersionAtRequest = get().workspaceVisibilityVersion;
      const sessionsResponse = await api.restoreStoredSession(session, { storedSessions: "all" });
      set((state) => ({
        ...applySessionsResponse(state, sessionsResponse, {
          workspaceVisibilityVersionAtRequest,
          preserveStoredSessionCatalog: state.storedSessionsCatalogLoaded,
          preserveLocalStoppedHistory: true,
        }),
        error: null,
      }));
    } catch (error) {
      set({ error: readErrorMessage(error) });
      throw error;
    }
  },

  removeHistorySession: async (session) => {
    try {
      const workspaceVisibilityVersionAtRequest = get().workspaceVisibilityVersion;
      const removedKeys = new Set([storedSessionKey(session)]);
      const sessionsResponse = await api.removeStoredSession(session, { storedSessions: "recent" });
      set((state) =>
        applyStoredSessionOmissionResponse(
          state,
          sessionsResponse,
          removedKeys,
          workspaceVisibilityVersionAtRequest,
        ),
      );
    } catch (error) {
      set({ error: readErrorMessage(error) });
      throw error;
    }
  },

  removeHistoryWorkspaceSessions: async (workspaceDir) => {
    try {
      const workspaceVisibilityVersionAtRequest = get().workspaceVisibilityVersion;
      const sessionsResponse = await api.removeStoredWorkspaceSessions({ dir: workspaceDir });
      set((state) => ({
        ...applySessionsResponse(state, sessionsResponse, {
          workspaceVisibilityVersionAtRequest,
        }),
        error: null,
      }));
    } catch (error) {
      set({ error: readErrorMessage(error) });
      throw error;
    }
  },

  setVisibleSessionIds: (sessionIds) => {
    const nextVisibleSessionIds = new Set(sessionIds);
    set((state) => {
      if (
        state.visibleSessionIds.size === nextVisibleSessionIds.size &&
        [...nextVisibleSessionIds].every((sessionId) => state.visibleSessionIds.has(sessionId))
      ) {
        return state;
      }
      return { visibleSessionIds: nextVisibleSessionIds };
    });
  },

  markSessionsRead: (sessionIds) => {
    if (sessionIds.length === 0) {
      return;
    }
    const sessionIdSet = new Set(sessionIds);
    const readState = readSessionReadState();
    let readStateChanged = readState ? ensureSessionReadStateInitialized(readState) : false;
    for (const sessionId of sessionIdSet) {
      const projection = get().projections.get(sessionId);
      if (projection && readState) {
        readStateChanged = markProjectionSeenInState(readState, projection) || readStateChanged;
      }
    }
    if (readState && readStateChanged) {
      writeSessionReadState(readState);
    }
    set((state) => {
      let changed = false;
      const unreadSessionIds = new Set(state.unreadSessionIds);
      for (const sessionId of sessionIdSet) {
        if (unreadSessionIds.delete(sessionId)) {
          changed = true;
        }
      }
      return changed ? { unreadSessionIds } : state;
    });
  },

  reconcileUnreadFromLastSeen: (visibleSessionIds = []) => {
    const visibleSessionIdSet = new Set(visibleSessionIds);
    set((state) => {
      const readState = readSessionReadState();
      let readStateChanged = readState ? ensureSessionReadStateInitialized(readState) : false;
      const unreadSessionIds = new Set(state.unreadSessionIds);
      let changed = false;
      for (const [sessionId, projection] of state.projections) {
        if (visibleSessionIdSet.has(sessionId)) {
          if (readState) {
            readStateChanged = markProjectionSeenInState(readState, projection) || readStateChanged;
          }
          if (unreadSessionIds.delete(sessionId)) {
            changed = true;
          }
          continue;
        }
        if (hasUnreadSinceReadState(projection, readState)) {
          if (!unreadSessionIds.has(sessionId)) {
            unreadSessionIds.add(sessionId);
            changed = true;
          }
        }
      }
      if (readState && readStateChanged) {
        writeSessionReadState(readState);
      }
      return changed ? { unreadSessionIds } : state;
    });
  },

  attachSession: async (summary) => {
    await attachSessionCommand({
      get,
      set,
      summary,
      ensureConversationLoaded: ensureConversationReady,
    });
  },

  closeSession: async (sessionId) => {
    await closeSessionCommand({
      get,
      set,
      sessionId,
      refreshWorkbenchState: () =>
        get().refreshWorkbenchState({ storedSessions: "recent", preserveWorkspaceNavigation: true }),
    });
  },

  renameSession: async (sessionId, title) => {
    await renameSessionCommand({
      set,
      sessionId,
      title,
      refreshWorkbenchState: () =>
        get().refreshWorkbenchState({ preserveWorkspaceNavigation: true }),
    });
  },

  setSessionMode: async (sessionId, modeId) => {
    await setSessionModeCommand({
      set,
      sessionId,
      modeId,
    });
  },

  setSessionModel: async (sessionId, modelId, reasoningId, optionValues) => {
    try {
      const summary = await api.setSessionModel(sessionId, {
        modelId,
        ...(optionValues !== undefined ? { optionValues } : {}),
      });
      updateSessionSummary(summary);
      set({ error: null });
    } catch (error) {
      set({ error: readErrorMessage(error) });
      throw error;
    }
  },

  claimControl: async (sessionId) => {
    await claimControlCommand({ get, set, sessionId });
  },

  releaseControl: async (sessionId) => {
    await releaseControlCommand({ get, set, sessionId });
  },

  interruptSession: async (sessionId) => {
    await interruptSessionCommand({ get, set, sessionId });
  },

  cancelPendingSessionStartup: (sessionId) =>
    cancelPendingSessionStartupCommand({ get, set }, sessionId),

  sendInput: async (sessionId, text, attachments, identity) => {
    await sendInputCommand({
      get,
      set,
      sessionId,
      text,
      ...(attachments !== undefined ? { attachments } : {}),
      ...(identity?.clientMessageId ? { clientMessageId: identity.clientMessageId } : {}),
      ...(identity?.clientTurnId ? { clientTurnId: identity.clientTurnId } : {}),
      ...(identity?.skipOptimisticQueue === true ? { skipOptimisticQueue: true } : {}),
    });
  },

  updateQueuedInput: async (sessionId, clientMessageId, text) => {
    await updateQueuedInputCommand({ get, set, sessionId, clientMessageId, text });
  },

  deleteQueuedInput: async (sessionId, clientMessageId) => {
    await deleteQueuedInputCommand({ get, set, sessionId, clientMessageId });
  },

  reorderQueuedInput: async (sessionId, clientMessageId, position) => {
    await reorderQueuedInputCommand({ get, set, sessionId, clientMessageId, position });
  },

  steerQueuedInput: async (sessionId, clientMessageId) => {
    await steerQueuedInputCommand({ get, set, sessionId, clientMessageId });
  },

  ensureConversationLoaded: async (sessionId) => {
    if (isPendingResumeProjectionTransferTarget(get(), sessionId)) {
      return true;
    }
    const loaded = await ensureConversationLoadedCommand({ get, set }, sessionId);
    refreshConversationGapIfNeeded(sessionId);
    return loaded;
  },

  initializeLiveConversation: async (sessionId) => {
    const loaded = await initializeLiveConversationCommand({ get, set }, sessionId);
    refreshConversationGapIfNeeded(sessionId);
    return loaded;
  },

  refreshConversation: async (sessionId, options) => {
    return refreshConversationBaseline(sessionId, options);
  },

  loadOlderConversation: async (sessionId) => {
    await loadOlderConversationCommand({ get, set }, sessionId);
    refreshConversationGapIfNeeded(sessionId);
  },

  loadConversationTurnDetail: async (sessionId, turnId) => {
    await loadConversationTurnDetailCommand({ get, set }, sessionId, turnId);
  },

  ensureSessionConversationDirectory: async (sessionId) => {
    await ensureSessionConversationDirectoryCommand({ get, set, sessionId });
  },

  loadConversationDirectoryTurn: async (sessionId, turnId) => {
    await loadConversationDirectoryTurnCommand({ get, set, sessionId, turnId });
  },

  loadConversationItemDetail: async (sessionId, kind, itemId) => {
    const loaded = await loadConversationItemDetailCommand({ get, set }, sessionId, itemId);
    if (!loaded) {
      set({ error: `Conversation ${kind} detail is unavailable.` });
    }
  },

  respondToPermission: async (sessionId, requestId, response) => {
    await respondToPermissionCommand({ set, sessionId, requestId, response });
  },
}));

useSessionStore.subscribe((state) => {
  syncHistorySelectionSubscription({ state });
});

import { create } from "zustand";
import type {
  DebugScenarioDescriptor,
  EventBatch,
  PermissionResponseRequest,
  ProviderModelCatalog,
  RahEvent,
  SessionConfigValue,
  SessionHistoryItemDetailKind,
  SessionSummary,
  StoredSessionIdentity,
  StoredSessionRef,
  StoredSessionsDeltaResponse,
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
  interruptSessionCommand,
  renameSessionCommand,
  releaseControlCommand,
  respondToPermissionCommand,
  sendInputCommand,
  setSessionModeCommand,
} from "./session-store-session-commands";
import {
  activateHistorySessionCommand,
  claimHistorySessionCommand,
  resumeStoredSessionCommand,
  startScenarioCommand,
  startSessionCommand,
} from "./session-store-session-startup";
import { notifyForRahEvents } from "./browser-notifications";
import {
  clearHistoryBootstrapBuffers,
  clearHistoryBootstrapBuffersForSession,
  queueDeferredBootstrapEvent,
  queuePendingEvent,
  shouldDeferEventForHistoryBootstrap,
  takePendingEventsForSessions,
} from "./session-store-history-bootstrap";
import {
  syncLastHistorySelectionFromState as syncHistorySelectionFromState,
} from "./session-store-history";
import { syncHistorySelectionSubscription } from "./session-store-history-selection-sync";
import {
  ensureSessionHistoryLoadedCommand,
  loadOlderHistoryCommand,
  refreshLatestHistoryCommand,
} from "./session-store-history-paging";
import {
  connectStoreSyncTransport,
  recoverFromReplayGapCommand,
  recoverTransportCommand,
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

type ProviderChoice = "codex" | "claude" | "gemini" | "opencode";
type StoredSessionsMode = "all" | "recent";

interface StartSessionOptions {
  provider?: ProviderChoice;
  cwd?: string;
  title?: string;
  model?: string;
  optionValues?: Record<string, SessionConfigValue>;
  reasoningId?: string;
  modeId?: string;
  initialInput?: string;
  confirmCreateMissingWorkspace?: (dir: string) => Promise<boolean>;
  onSessionCreated?: (sessionId: string) => void;
}

interface ClaimHistorySessionOptions {
  confirmCreateMissingWorkspace?: (dir: string) => Promise<boolean>;
  modeId?: string;
  modelId?: string;
  optionValues?: Record<string, SessionConfigValue>;
  reasoningId?: string | null;
}

type ModelCatalogLoadState = {
  catalog: ProviderModelCatalog | null;
  loading: boolean;
  error: string | null;
  loadedAt: number | null;
  lastAttemptedAt: number | null;
  lastSuccessfulFetchedAt: string | null;
};

type LoadProviderModelsOptions = {
  cwd?: string;
  forceRefresh?: boolean;
  staleMs?: number;
  background?: boolean;
  pollUntilFetchedAt?: string;
  pollUntilRevision?: string;
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
  storedSessionsCatalogLoaded: boolean;
  storedSessionsCatalogDirty: boolean;
  storedSessionsCatalogRevision: number | null;
  workspaceDirs: string[];
  hiddenWorkspaceDirs: Set<string>;
  workspaceVisibilityVersion: number;
  sessionTopologyVersion: number;
  debugScenarios: DebugScenarioDescriptor[];
  modelCatalogs: Partial<Record<ProviderChoice, ModelCatalogLoadState>>;
  selectedSessionId: string | null;
  workspaceDir: string;
  newSessionProvider: ProviderChoice;
  pendingSessionTransition: PendingSessionTransition | null;
  pendingSessionAction:
    | {
        kind: "attach_session" | "claim_control" | "claim_history";
        sessionId: string;
      }
    | null;
  isInitialLoaded: boolean;
  error: string | null;

  init: () => Promise<void>;
  clearError: () => void;
  refreshWorkbenchState: (options?: RefreshWorkbenchStateOptions) => Promise<void>;
  loadStoredSessionsCatalog: () => Promise<void>;
  recoverTransport: () => Promise<void>;
  setWorkspaceDir: (dir: string) => void;
  addWorkspace: (dir: string) => Promise<void>;
  removeWorkspace: (dir: string) => Promise<void>;
  setSelectedSessionId: (id: string | null) => void;
  setNewSessionProvider: (provider: ProviderChoice) => void;
  loadProviderModels: (
    provider: ProviderChoice,
    options?: LoadProviderModelsOptions,
  ) => Promise<void>;
  rememberProviderModelCatalog: (
    provider: ProviderChoice,
    catalog: ProviderModelCatalog,
  ) => void;
  startSession: (options?: StartSessionOptions) => Promise<string | null>;
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
  claimHistorySession: (
    sessionId: string,
    options?: ClaimHistorySessionOptions,
  ) => Promise<string | null>;
  removeHistorySession: (session: Pick<StoredSessionRef, "provider" | "providerSessionId">) => Promise<void>;
  removeHistoryWorkspaceSessions: (workspaceDir: string) => Promise<void>;
  claimControl: (sessionId: string) => Promise<void>;
  releaseControl: (sessionId: string) => Promise<void>;
  interruptSession: (sessionId: string) => Promise<void>;
  sendInput: (sessionId: string, text: string) => Promise<void>;
  ensureSessionHistoryLoaded: (sessionId: string) => Promise<void>;
  refreshLatestHistory: (sessionId: string) => Promise<void>;
  loadOlderHistory: (sessionId: string) => Promise<void>;
  loadHistoryItemDetail: (
    sessionId: string,
    kind: SessionHistoryItemDetailKind,
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
const HISTORY_PAGE_LIMIT = 60;
const MODEL_CATALOG_PROVIDERS = new Set<ProviderChoice>([
  "codex",
  "claude",
  "gemini",
  "opencode",
]);
const MODEL_CATALOG_TTL_MS = 5 * 60 * 1000;
const MODEL_CATALOG_FAILURE_RETRY_MS = 10 * 1000;
const GEMINI_CATALOG_BACKGROUND_POLL_MS = 1_000;
const GEMINI_CATALOG_BACKGROUND_MAX_ATTEMPTS = 20;
const MODEL_CATALOG_BACKGROUND_REFRESH_MS = 30 * 60 * 1_000;
const geminiCatalogBackgroundAttempts = new Map<string, number>();
const geminiCatalogBackgroundTimers = new Map<string, ReturnType<typeof setTimeout>>();
const modelCatalogBackgroundInFlight = new Map<string, Promise<void>>();
let modelCatalogBackgroundRefreshTimer: ReturnType<typeof setTimeout> | null = null;
let modelCatalogFocusListenerInstalled = false;

function logModelCatalog(message: string, details?: Record<string, unknown>): void {
  if (details) {
    console.info(`[rah] model catalog ${message}`, details);
    return;
  }
  console.info(`[rah] model catalog ${message}`);
}

function geminiCatalogBackgroundKey(cwd?: string): string {
  return cwd?.trim() || "default";
}

function modelCatalogBackgroundKey(provider: ProviderChoice, cwd?: string): string {
  return `${provider}:${cwd?.trim() || "default"}`;
}

function geminiCatalogNeedsNativeRefresh(
  provider: ProviderChoice,
  catalog: ProviderModelCatalog,
): boolean {
  return (
    provider === "gemini" &&
    (catalog.source !== "native" ||
      catalog.modelsExact !== true ||
      catalog.optionsExact !== true ||
      catalog.freshness !== "authoritative")
  );
}

function isSuccessfulModelCatalog(catalog: ProviderModelCatalog): boolean {
  return catalog.source === "native" && catalog.freshness === "authoritative";
}

function geminiCatalogMatchesSnapshot(
  catalog: ProviderModelCatalog,
  snapshot: { fetchedAt?: string; revision?: string },
): boolean {
  return (
    (snapshot.revision === undefined || catalog.revision === snapshot.revision) &&
    (snapshot.fetchedAt === undefined || catalog.fetchedAt === snapshot.fetchedAt)
  );
}

function clearGeminiCatalogBackgroundPoll(cwd?: string): void {
  const key = geminiCatalogBackgroundKey(cwd);
  const timer = geminiCatalogBackgroundTimers.get(key);
  if (timer) {
    clearTimeout(timer);
    geminiCatalogBackgroundTimers.delete(key);
  }
  geminiCatalogBackgroundAttempts.delete(key);
}

function prewarmProviderModelCatalogs(
  getState: () => SessionState,
  reason: string,
): void {
  const providers = Array.from(MODEL_CATALOG_PROVIDERS);
  logModelCatalog("background refresh queued", {
    reason,
    providers,
  });
  for (const provider of providers) {
    void getState()
      .loadProviderModels(provider, {
        background: true,
        reason,
      })
      .catch(() => undefined);
  }
}

function scheduleModelCatalogBackgroundRefresh(getState: () => SessionState): void {
  if (modelCatalogBackgroundRefreshTimer !== null) {
    return;
  }
  const scheduleNext = () => {
    modelCatalogBackgroundRefreshTimer = setTimeout(() => {
      modelCatalogBackgroundRefreshTimer = null;
      prewarmProviderModelCatalogs(getState, "periodic");
      scheduleNext();
    }, MODEL_CATALOG_BACKGROUND_REFRESH_MS);
    (modelCatalogBackgroundRefreshTimer as { unref?: () => void }).unref?.();
  };
  scheduleNext();
  if (
    modelCatalogFocusListenerInstalled ||
    typeof window === "undefined" ||
    typeof document === "undefined"
  ) {
    return;
  }
  modelCatalogFocusListenerInstalled = true;
  window.addEventListener("focus", () => {
    prewarmProviderModelCatalogs(getState, "window-focus");
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      prewarmProviderModelCatalogs(getState, "visibility");
    }
  });
}

function createProjectionReplayHandling() {
  return {
    takePendingEventsForSessions,
    updateLastSeq: (seq: number) => {
      lastEventSeq = Math.max(lastEventSeq, seq);
    },
    clearBufferedSession: clearHistoryBootstrapBuffersForSession,
    queuePendingEvent,
    shouldDeferEvent: shouldDeferEventForHistoryBootstrap,
    queueDeferredEvent: queueDeferredBootstrapEvent,
  };
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
    workspaceDirs?: string[];
    storedSessions?: StoredSessionRef[];
    recentSessions?: StoredSessionRef[];
  },
  sessionsResponse: Awaited<ReturnType<typeof api.listSessions>>,
  options?: {
    workspaceVisibilityVersionAtRequest?: number;
    preserveWorkspaceNavigation?: boolean;
    preserveLocalStoppedHistory?: boolean;
    excludeLocalStoppedHistoryKeys?: ReadonlySet<string>;
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
  const mergedSessionsResponse = options?.preserveLocalStoppedHistory
    ? mergeLocalStoppedHistoryRefs(state, sessionsResponse, options.excludeLocalStoppedHistoryKeys)
    : sessionsResponse;
  const next = applySessionsResponseImpl(
    state,
    mergedSessionsResponse,
    createProjectionReplayHandling(),
    options,
  );
  if (!options?.preserveWorkspaceNavigation || state.workspaceDirs === undefined) {
    return next;
  }
  return {
    ...next,
    workspaceDirs: state.workspaceDirs,
    hiddenWorkspaceDirs: state.hiddenWorkspaceDirs,
    workspaceVisibilityVersion: state.workspaceVisibilityVersion,
    workspaceDir: state.workspaceDir,
  };
}

function storedSessionKey(session: Pick<StoredSessionRef, "provider" | "providerSessionId">): string {
  return `${session.provider}:${session.providerSessionId}`;
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
  return [...byKey.values()].sort((left, right) =>
    (right.lastUsedAt ?? right.updatedAt ?? "").localeCompare(left.lastUsedAt ?? left.updatedAt ?? ""),
  );
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

function sortStoredSessionCatalogRefs(sessions: Iterable<StoredSessionRef>): StoredSessionRef[] {
  return [...sessions].sort((left, right) =>
    (right.lastUsedAt ?? right.updatedAt ?? "").localeCompare(left.lastUsedAt ?? left.updatedAt ?? ""),
  );
}

function applyStoredSessionsDeltaToCatalog(
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

function replaceSessionsResponse(
  state: Pick<
    SessionState,
    | "projections"
    | "workspaceDir"
    | "selectedSessionId"
    | "hiddenWorkspaceDirs"
    | "workspaceVisibilityVersion"
  >,
  sessionsResponse: Awaited<ReturnType<typeof api.listSessions>>,
  options?: {
    workspaceVisibilityVersionAtRequest?: number;
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
  return replaceSessionsResponseImpl(state, sessionsResponse, options);
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

function syncLastHistorySelectionFromState(
  state: Pick<SessionState, "selectedSessionId" | "projections" | "workspaceDir">,
) {
  return syncHistorySelectionFromState(state);
}

function storedSessionsModeForState(
  state: Pick<SessionState, "storedSessionsCatalogLoaded">,
): StoredSessionsMode {
  return state.storedSessionsCatalogLoaded ? "all" : "recent";
}

function applyStoredSessionDiscoveryEvents(events: readonly RahEvent[]) {
  const delta = discoveryDeltaFromEvents(events);
  useSessionStore.setState((state) => {
    if (!delta || delta.resetRequired) {
      return { storedSessionsCatalogDirty: true };
    }
    if (!state.storedSessionsCatalogLoaded || state.storedSessionsCatalogRevision === null) {
      return { storedSessionsCatalogDirty: true };
    }
    if (state.storedSessionsCatalogRevision !== delta.fromRevision) {
      return { storedSessionsCatalogDirty: true };
    }
    return {
      storedSessions: applyStoredSessionsDeltaToCatalog(state.storedSessions, delta),
      storedSessionsCatalogRevision: delta.revision,
      storedSessionsCatalogDirty: false,
    };
  });
}

function shouldSkipSessionsResponseForTopology(
  state: Pick<SessionState, "sessionTopologyVersion" | "pendingSessionAction">,
  sessionTopologyVersionAtRequest: number,
): boolean {
  return (
    state.sessionTopologyVersion !== sessionTopologyVersionAtRequest ||
    state.pendingSessionAction?.kind === "claim_history"
  );
}

function updateSessionSummary(session: SessionSummary) {
  useSessionStore.setState((state) => {
    return {
      projections: updateSessionSummaryInProjectionMap(state.projections, session),
    };
  });
}

async function ensureSessionHistoryLoaded(sessionId: string) {
  await ensureSessionHistoryLoadedCommand({
    get: useSessionStore.getState,
    loadOlderHistory: useSessionStore.getState().loadOlderHistory,
    refreshLatestHistory: useSessionStore.getState().refreshLatestHistory,
    sessionId,
  });
}

function createStartupDeps(
  get: () => SessionState,
  set: (
    partial:
      | Partial<SessionState>
      | ((state: SessionState) => Partial<SessionState> | SessionState),
  ) => void,
  options?: ClaimHistorySessionOptions,
) {
  return {
    get,
    set,
    ensureSessionHistoryLoaded,
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
    clearHistoryBootstrapBuffers,
    updateLastSeq: (seq) => {
      lastEventSeq = Math.max(lastEventSeq, seq);
    },
    replaceSessionsResponse: replaceSessionsResponse as never,
    applyEventsToMap,
    ensureSessionHistoryLoaded,
  });
}

function connectStoreTransport() {
  connectStoreSyncTransport({
    getReplayFromSeq: () => (lastEventSeq > 0 ? lastEventSeq + 1 : undefined),
    isInitialLoaded: () => useSessionStore.getState().isInitialLoaded,
    set: useSessionStore.setState as never,
    getNotificationProjections: () => useSessionStore.getState().projections,
    applyEventsToMap,
    computeUnreadSessionIds: computeUnreadSessionIdsImpl,
    notifyUnreadEvents: notifyForRahEvents,
    recoverFromReplayGap,
    refreshWorkbenchState: (events) => {
      applyStoredSessionDiscoveryEvents(events);
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
  storedSessionsCatalogLoaded: false,
  storedSessionsCatalogDirty: false,
  storedSessionsCatalogRevision: null,
  workspaceDirs: [],
  hiddenWorkspaceDirs: new Set(),
  workspaceVisibilityVersion: 0,
  sessionTopologyVersion: 0,
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
  recoverTransport: async () => {
    await recoverTransportCommand({
      get: get as never,
      set: set as never,
      applySessionsResponse: applySessionsResponse as never,
      restartTransport: restartSessionStoreTransport,
      maybeRestoreLastHistorySelection,
    });
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
    },
  setNewSessionProvider: (provider) => {
    set({ newSessionProvider: provider });
    if (MODEL_CATALOG_PROVIDERS.has(provider)) {
      void get().loadProviderModels(provider, {
        background: true,
        reason: "new-session-provider",
      }).catch(() => undefined);
    }
  },

  rememberProviderModelCatalog: (provider, catalog) => {
    if (!MODEL_CATALOG_PROVIDERS.has(provider)) {
      return;
    }
    const now = Date.now();
    set((state) => ({
      modelCatalogs: {
        ...state.modelCatalogs,
        [provider]: {
          catalog,
          loading: false,
          error: null,
          loadedAt: now,
          lastAttemptedAt: now,
          lastSuccessfulFetchedAt: isSuccessfulModelCatalog(catalog)
            ? catalog.fetchedAt
            : state.modelCatalogs[provider]?.lastSuccessfulFetchedAt ?? null,
        },
      },
    }));
  },

  loadProviderModels: async (provider, options) => {
    if (!MODEL_CATALOG_PROVIDERS.has(provider)) {
      set((state) => ({
        modelCatalogs: {
          ...state.modelCatalogs,
          [provider]: {
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
    const current = get().modelCatalogs[provider];
    const staleMs = options?.staleMs ?? MODEL_CATALOG_TTL_MS;
    const isStale =
      current?.catalog !== undefined &&
      current?.loadedAt !== null &&
      (current?.loadedAt === undefined || Date.now() - current.loadedAt >= staleMs);
    const pollUntilRevision =
      options?.pollUntilRevision ??
      (provider === "gemini" && options?.background && isStale
        ? current?.catalog?.revision
        : undefined);
    const pollUntilFetchedAt =
      options?.pollUntilFetchedAt ??
      (provider === "gemini" && options?.background && isStale
        ? current?.catalog?.fetchedAt
        : undefined);
    const scheduleGeminiBackgroundPoll = (catalog: ProviderModelCatalog) => {
      const pollSnapshot = {
        ...(pollUntilRevision !== undefined ? { revision: pollUntilRevision } : {}),
        ...(pollUntilFetchedAt !== undefined ? { fetchedAt: pollUntilFetchedAt } : {}),
      };
      const pollingForChangedCatalog =
        provider === "gemini" &&
        (pollSnapshot.revision !== undefined || pollSnapshot.fetchedAt !== undefined);
      const needsNativeRefresh = geminiCatalogNeedsNativeRefresh(provider, catalog);
      if (
        pollingForChangedCatalog &&
        !geminiCatalogMatchesSnapshot(catalog, pollSnapshot)
      ) {
        clearGeminiCatalogBackgroundPoll(options?.cwd);
        if (options?.reason === "gemini-cache-poll") {
          logModelCatalog("gemini cache upgraded", {
            source: catalog.source,
            revision: catalog.revision ?? null,
            fetchedAt: catalog.fetchedAt,
            models: catalog.models.length,
          });
        }
        return;
      }
      if (!needsNativeRefresh && !pollingForChangedCatalog) {
        clearGeminiCatalogBackgroundPoll(options?.cwd);
        return;
      }
      if (options?.forceRefresh) {
        return;
      }
      const key = geminiCatalogBackgroundKey(options?.cwd);
      const attempts = geminiCatalogBackgroundAttempts.get(key) ?? 0;
      if (
        attempts >= GEMINI_CATALOG_BACKGROUND_MAX_ATTEMPTS ||
        geminiCatalogBackgroundTimers.has(key)
      ) {
        return;
      }
      const timer = setTimeout(() => {
        geminiCatalogBackgroundTimers.delete(key);
        geminiCatalogBackgroundAttempts.set(key, attempts + 1);
        const currentCatalog = get().modelCatalogs.gemini?.catalog;
        if (
          currentCatalog &&
          pollingForChangedCatalog &&
          !geminiCatalogMatchesSnapshot(currentCatalog, pollSnapshot)
        ) {
          clearGeminiCatalogBackgroundPoll(options?.cwd);
          logModelCatalog("gemini cache upgraded", {
            source: currentCatalog.source,
            revision: currentCatalog.revision ?? null,
            fetchedAt: currentCatalog.fetchedAt,
            models: currentCatalog.models.length,
          });
          return;
        }
        if (
          currentCatalog &&
          !pollingForChangedCatalog &&
          !geminiCatalogNeedsNativeRefresh("gemini", currentCatalog)
        ) {
          clearGeminiCatalogBackgroundPoll(options?.cwd);
          return;
        }
        void get()
          .loadProviderModels("gemini", {
            ...(options?.cwd ? { cwd: options.cwd } : {}),
            background: true,
            pollUntilFetchedAt: pollUntilFetchedAt ?? catalog.fetchedAt,
            ...(pollUntilRevision ?? catalog.revision
              ? { pollUntilRevision: pollUntilRevision ?? catalog.revision }
              : {}),
            reason: "gemini-cache-poll",
            staleMs: 0,
          })
          .catch(() => undefined);
      }, GEMINI_CATALOG_BACKGROUND_POLL_MS);
      (timer as { unref?: () => void }).unref?.();
      geminiCatalogBackgroundTimers.set(key, timer);
    };
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
      ? modelCatalogBackgroundKey(provider, options.cwd)
      : null;
    if (backgroundInFlightKey) {
      const inFlight = modelCatalogBackgroundInFlight.get(backgroundInFlightKey);
      if (inFlight) {
        await inFlight;
        return;
      }
    }
    const startedAt = Date.now();
    if (!options?.background) {
      set((state) => ({
        modelCatalogs: {
          ...state.modelCatalogs,
          [provider]: {
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
    if (options?.background && options.reason !== "gemini-cache-poll") {
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
      const loadedAt = Date.now();
      const lastSuccessfulFetchedAt = isSuccessfulModelCatalog(catalog)
        ? catalog.fetchedAt
        : current?.lastSuccessfulFetchedAt ?? null;
      set((state) => ({
        modelCatalogs: {
          ...state.modelCatalogs,
          [provider]: {
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
        !geminiCatalogMatchesSnapshot(catalog, {
          fetchedAt: current.catalog.fetchedAt,
          ...(current.catalog.revision ? { revision: current.catalog.revision } : {}),
        });
      if (options?.background && (options.reason !== "gemini-cache-poll" || changed)) {
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
      scheduleGeminiBackgroundPoll(catalog);
    } catch (error) {
      if (options?.background) {
        if (options.reason !== "gemini-cache-poll") {
          console.warn("[rah] model catalog refresh failed", {
            provider,
            reason: options.reason ?? "background",
            error: readErrorMessage(error),
          });
        }
        set((state) => {
          const currentState = state.modelCatalogs[provider];
          return {
            modelCatalogs: {
              ...state.modelCatalogs,
              [provider]: {
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
      set((state) => ({
        modelCatalogs: {
          ...state.modelCatalogs,
          [provider]: {
            catalog: state.modelCatalogs[provider]?.catalog ?? null,
            loading: false,
            error: readErrorMessage(error),
            loadedAt: state.modelCatalogs[provider]?.loadedAt ?? null,
            lastAttemptedAt: startedAt,
            lastSuccessfulFetchedAt: state.modelCatalogs[provider]?.lastSuccessfulFetchedAt ?? null,
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
        const catalogLoadedPatch = {
          storedSessionsCatalogLoaded:
            storedSessionsMode === "all" ? true : state.storedSessionsCatalogLoaded,
          storedSessionsCatalogDirty:
            storedSessionsMode === "all" ? false : state.storedSessionsCatalogDirty,
          storedSessionsCatalogRevision:
            storedSessionsMode === "all"
              ? sessionsResponse.storedSessionsRevision ?? state.storedSessionsCatalogRevision
              : state.storedSessionsCatalogRevision,
          debugScenarios,
          error: null,
        };
        if (shouldSkipSessionsResponseForTopology(state, sessionTopologyVersionAtRequest)) {
          return catalogLoadedPatch;
        }
        const applied = applySessionsResponse(state, sessionsResponse, {
          workspaceVisibilityVersionAtRequest,
          preserveLocalStoppedHistory: options.preserveLocalStoppedHistory ?? true,
          ...(options.preserveWorkspaceNavigation !== undefined
            ? { preserveWorkspaceNavigation: options.preserveWorkspaceNavigation }
            : {}),
        });
        const storedSessions =
          storedSessionsMode === "recent" && state.storedSessionsCatalogLoaded
            ? mergeStoredSessionCatalogRefs(state.storedSessions, applied.storedSessions)
            : applied.storedSessions;
        return {
          ...applied,
          storedSessions,
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
      await get().refreshWorkbenchState({ storedSessions: "recent" });
      set({ isInitialLoaded: true });
      connectStoreTransport();
      prewarmProviderModelCatalogs(get, "startup");
      scheduleModelCatalogBackgroundRefresh(get);
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

  claimHistorySession: async (sessionId, options) => {
    return claimHistorySessionCommand(
      createStartupDeps(get, set, options),
      sessionId,
      {
        ...(options?.modeId ? { modeId: options.modeId } : {}),
        ...(options?.modelId ? { modelId: options.modelId } : {}),
        ...(options?.optionValues !== undefined ? { optionValues: options.optionValues } : {}),
        ...(options?.reasoningId !== undefined ? { reasoningId: options.reasoningId } : {}),
      },
    );
  },

  removeHistorySession: async (session) => {
    try {
      const workspaceVisibilityVersionAtRequest = get().workspaceVisibilityVersion;
      const removedKeys = new Set([storedSessionKey(session)]);
      const sessionsResponse = await api.removeStoredSession(session, { storedSessions: "recent" });
      set((state) => {
        const applied = applySessionsResponse(state, sessionsResponse, {
          workspaceVisibilityVersionAtRequest,
          preserveLocalStoppedHistory: true,
          excludeLocalStoppedHistoryKeys: removedKeys,
        });
        const recentSessions = omitStoredSessionCatalogRefs(applied.recentSessions, removedKeys);
        const storedSessions = state.storedSessionsCatalogLoaded
          ? mergeStoredSessionCatalogRefs(
              omitStoredSessionCatalogRefs(state.storedSessions, removedKeys),
              omitStoredSessionCatalogRefs(applied.storedSessions, removedKeys),
            )
          : omitStoredSessionCatalogRefs(applied.storedSessions, removedKeys);
        return {
          ...applied,
          storedSessions,
          recentSessions,
          error: null,
        };
      });
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

  attachSession: async (summary) => {
    await attachSessionCommand({
      get,
      set,
      summary,
      ensureSessionHistoryLoaded,
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
        ...(reasoningId !== undefined ? { reasoningId } : {}),
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

  sendInput: async (sessionId, text) => {
    await sendInputCommand({ get, set, sessionId, text });
  },

  ensureSessionHistoryLoaded: async (sessionId) => {
    await ensureSessionHistoryLoaded(sessionId);
  },

  refreshLatestHistory: async (sessionId) => {
    await refreshLatestHistoryCommand({
      get,
      set,
      sessionId,
      historyPageLimit: HISTORY_PAGE_LIMIT,
    });
  },

  loadOlderHistory: async (sessionId) => {
    await loadOlderHistoryCommand({
      get,
      set,
      sessionId,
      historyPageLimit: HISTORY_PAGE_LIMIT,
    });
  },

  loadHistoryItemDetail: async (sessionId, kind, itemId) => {
    const response = await api.readSessionHistoryItemDetail(sessionId, { kind, itemId });
    set((state) => {
      const current = state.projections.get(sessionId);
      if (!current) {
        return state;
      }
      const next = new Map(state.projections);
      next.set(sessionId, applyEventBatchToProjection(current, response.events));
      return { projections: next };
    });
  },

  respondToPermission: async (sessionId, requestId, response) => {
    await respondToPermissionCommand({ set, sessionId, requestId, response });
  },
}));

useSessionStore.subscribe((state) => {
  syncHistorySelectionSubscription({
    state,
    syncLastHistorySelectionFromState,
  });
});

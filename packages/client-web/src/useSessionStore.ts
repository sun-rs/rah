import { create } from "zustand";
import type {
  ApprovalPolicy,
  AttachSessionRequest,
  DebugScenarioDescriptor,
  EventBatch,
  PermissionResponseRequest,
  ProviderModelCatalog,
  RahEvent,
  ResumeSessionRequest,
  SessionConfigValue,
  SessionSummary,
  StoredSessionRef,
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
import { isReadOnlyReplay } from "./session-capabilities";
import {
  adoptExistingProjectionForProviderSession as adoptExistingProjectionForProviderSessionImpl,
  applyEventBatchToProjection as applyEventBatchToProjectionImpl,
  applyEventsToProjectionMap as applyEventsToProjectionMapImpl,
  applySessionsResponse as applySessionsResponseImpl,
  computeUnreadSessionIds as computeUnreadSessionIdsImpl,
  mergeSessionsIntoProjections as mergeSessionsIntoProjectionsImpl,
  replaceSessionsResponse as replaceSessionsResponseImpl,
  updateSessionSummaryInProjectionMap,
} from "./session-store-projections";
import {
  applyAttachedSessionState,
  applyClaimedHistorySessionState,
  applyClosedSessionState,
  applyResumedStoredSessionState,
  applyStartedSessionState,
  buildFallbackStoredSessionRef,
  createEmptySessionProjection,
} from "./session-store-session-lifecycle";
import {
  attachSessionCommand,
  claimControlCommand,
  closeSessionCommand,
  createInteractiveAttachRequest,
  createObserveAttachRequest,
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
import {
  clearHistoryBootstrapBuffers,
  clearHistoryBootstrapBuffersForSession,
  queueDeferredBootstrapEvent,
  queuePendingEvent,
  shouldDeferEventForHistoryBootstrap,
  takeDeferredBootstrapEvents,
  takePendingEventsForSessions,
} from "./session-store-history-bootstrap";
import {
  prependHistoryPage as prependAuthoritativeHistoryPage,
  replayEventsIntoProjection as replayHistoryEventsIntoProjection,
  syncLastHistorySelectionFromState as syncHistorySelectionFromState,
} from "./session-store-history";
import { syncHistorySelectionSubscription } from "./session-store-history-selection-sync";
import {
  ensureSessionHistoryLoadedCommand,
  loadOlderHistoryCommand,
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
  findDaemonLiveSessionForStoredRef,
  normalizeWorkspaceDirectory,
  reconcileVisibleWorkspaceSelection,
  resolveHiddenWorkspaceDirsFromSessionsResponse,
  resolveHistoryActivationMode,
  sameWorkspaceDirectory,
} from "./session-store-workspace";

type ProviderChoice = "codex" | "claude" | "kimi" | "gemini" | "opencode";

interface StartSessionOptions {
  provider?: ProviderChoice;
  cwd?: string;
  title?: string;
  model?: string;
  reasoningId?: string;
  providerConfig?: Record<string, SessionConfigValue>;
  approvalPolicy?: ApprovalPolicy;
  sandbox?: string;
  modeId?: string;
  initialInput?: string;
}

interface ClaimHistorySessionOptions {
  confirmCreateMissingWorkspace?: (dir: string) => Promise<boolean>;
  modeId?: string;
  modelId?: string;
  reasoningId?: string | null;
}

type ModelCatalogLoadState = {
  catalog: ProviderModelCatalog | null;
  loading: boolean;
  error: string | null;
};

interface SessionState {
  clientId: string;
  connectionId: string;
  projections: Map<string, SessionProjection>;
  unreadSessionIds: Set<string>;
  storedSessions: StoredSessionRef[];
  recentSessions: StoredSessionRef[];
  workspaceDirs: string[];
  hiddenWorkspaceDirs: Set<string>;
  workspaceVisibilityVersion: number;
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
  refreshWorkbenchState: () => Promise<void>;
  recoverTransport: () => Promise<void>;
  setWorkspaceDir: (dir: string) => void;
  addWorkspace: (dir: string) => Promise<void>;
  removeWorkspace: (dir: string) => Promise<void>;
  setSelectedSessionId: (id: string | null) => void;
  setNewSessionProvider: (provider: ProviderChoice) => void;
  loadProviderModels: (
    provider: ProviderChoice,
    options?: { cwd?: string; forceRefresh?: boolean },
  ) => Promise<void>;
  startSession: (options?: StartSessionOptions) => Promise<void>;
  startScenario: (scenario: DebugScenarioDescriptor) => Promise<void>;
  activateHistorySession: (ref: StoredSessionRef) => Promise<void>;
  resumeStoredSession: (
    ref: StoredSessionRef,
    options?: { preferStoredReplay?: boolean; historyReplay?: "include" | "skip" },
  ) => Promise<void>;
  attachSession: (summary: SessionSummary) => Promise<void>;
  closeSession: (sessionId: string) => Promise<void>;
  renameSession: (sessionId: string, title: string) => Promise<void>;
  setSessionMode: (sessionId: string, modeId: string) => Promise<void>;
  setSessionModel: (
    sessionId: string,
    modelId: string,
    reasoningId?: string | null,
  ) => Promise<void>;
  claimHistorySession: (
    sessionId: string,
    options?: ClaimHistorySessionOptions,
  ) => Promise<void>;
  removeHistorySession: (session: Pick<StoredSessionRef, "provider" | "providerSessionId">) => Promise<void>;
  removeHistoryWorkspaceSessions: (workspaceDir: string) => Promise<void>;
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

let lastEventSeq = 0;
const HISTORY_PAGE_LIMIT = 250;
const PRELOAD_MODEL_PROVIDERS = new Set<ProviderChoice>([
  "codex",
  "claude",
  "gemini",
  "kimi",
  "opencode",
]);

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

function mergeSessionsIntoProjections(
  current: Map<string, SessionProjection>,
  sessionsResponse: Awaited<ReturnType<typeof api.listSessions>>,
): Map<string, SessionProjection> {
  return mergeSessionsIntoProjectionsImpl(
    current,
    sessionsResponse,
    createProjectionReplayHandling(),
  );
}

function applySessionsResponse(
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
  return applySessionsResponseImpl(
    state,
    sessionsResponse,
    createProjectionReplayHandling(),
    options,
  );
}

function replaceSessionsResponse(
  state: Pick<
    SessionState,
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

function applyEventBatchToProjection(
  projection: SessionProjection,
  events: RahEvent[],
): SessionProjection {
  return applyEventBatchToProjectionImpl(projection, events);
}

function syncLastHistorySelectionFromState(
  state: Pick<SessionState, "selectedSessionId" | "projections" | "workspaceDir">,
) {
  return syncHistorySelectionFromState(state);
}

function updateSessionSummary(session: SessionSummary) {
  useSessionStore.setState((state) => {
    return {
      projections: updateSessionSummaryInProjectionMap(state.projections, session),
    };
  });
}

function replayEventsIntoProjection(
  summary: SessionSummary,
  events: RahEvent[],
): SessionProjection {
  return replayHistoryEventsIntoProjection(summary, events);
}

function prependHistoryPage(
  projection: SessionProjection,
  events: RahEvent[],
  options?: { nextBeforeTs?: string; nextCursor?: string },
): SessionProjection {
  return prependAuthoritativeHistoryPage(projection, events, options);
}

async function ensureSessionHistoryLoaded(sessionId: string) {
  await ensureSessionHistoryLoadedCommand({
    get: useSessionStore.getState,
    loadOlderHistory: useSessionStore.getState().loadOlderHistory,
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
    applyEventsToMap,
    computeUnreadSessionIds: computeUnreadSessionIdsImpl,
    recoverFromReplayGap,
    refreshWorkbenchState: () => useSessionStore.getState().refreshWorkbenchState(),
  });
}

export const useSessionStore = create<SessionState>((set, get) => ({
  clientId: readOrCreateClientId(),
  connectionId: readOrCreateConnectionId(),
  projections: new Map(),
  unreadSessionIds: new Set(),
  storedSessions: [],
  recentSessions: [],
  workspaceDirs: [],
  hiddenWorkspaceDirs: new Set(),
  workspaceVisibilityVersion: 0,
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
    void api
      .selectWorkspace({ dir })
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
      const sessionsResponse = await api.addWorkspace({ dir });
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
      const sessionsResponse = await api.removeWorkspace({ dir });
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
        const sessionsResponse = await api.listSessions();
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
    if (PRELOAD_MODEL_PROVIDERS.has(provider)) {
      void get().loadProviderModels(provider).catch(() => undefined);
    }
  },

  loadProviderModels: async (provider, options) => {
    if (!PRELOAD_MODEL_PROVIDERS.has(provider)) {
      set((state) => ({
        modelCatalogs: {
          ...state.modelCatalogs,
          [provider]: {
            catalog: null,
            loading: false,
            error: null,
          },
        },
      }));
      return;
    }
    const current = get().modelCatalogs[provider];
    if (current?.loading && !options?.forceRefresh) {
      return;
    }
    set((state) => ({
      modelCatalogs: {
        ...state.modelCatalogs,
        [provider]: {
          catalog: current?.catalog ?? null,
          loading: true,
          error: null,
        },
      },
    }));
    try {
      const catalog = await api.listProviderModels(provider, options);
      set((state) => ({
        modelCatalogs: {
          ...state.modelCatalogs,
          [provider]: {
            catalog,
            loading: false,
            error: null,
          },
        },
      }));
    } catch (error) {
      set((state) => ({
        modelCatalogs: {
          ...state.modelCatalogs,
          [provider]: {
            catalog: state.modelCatalogs[provider]?.catalog ?? null,
            loading: false,
            error: readErrorMessage(error),
          },
        },
      }));
      throw error;
    }
  },

  refreshWorkbenchState: async () => {
    try {
      const workspaceVisibilityVersionAtRequest = get().workspaceVisibilityVersion;
      const [sessionsResponse, debugScenarios] = await Promise.all([
        api.listSessions(),
        isLabModeEnabled() ? api.listDebugScenarios() : Promise.resolve([]),
      ]);
      set((state) => ({
        ...applySessionsResponse(state, sessionsResponse, {
          workspaceVisibilityVersionAtRequest,
        }),
        debugScenarios,
        error: null,
      }));
      await maybeRestoreLastHistorySelection(sessionsResponse);
    } catch (error) {
      set({ error: readErrorMessage(error) });
      throw error;
    }
  },

  init: async () => {
    if (!beginSessionStoreInit()) {
      return;
    }
    try {
      await get().refreshWorkbenchState();
      void get().loadProviderModels("codex").catch(() => undefined);
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
    await startSessionCommand(createStartupDeps(get, set), options);
  },

  startScenario: async (scenario) => {
    await startScenarioCommand(createStartupDeps(get, set), scenario);
  },

  activateHistorySession: async (ref) => {
    await activateHistorySessionCommand(createStartupDeps(get, set), ref);
  },

  resumeStoredSession: async (ref, options) => {
    await resumeStoredSessionCommand(createStartupDeps(get, set), ref, options);
  },

  claimHistorySession: async (sessionId, options) => {
    await claimHistorySessionCommand(
      createStartupDeps(get, set, options),
      sessionId,
      {
        ...(options?.modeId ? { modeId: options.modeId } : {}),
        ...(options?.modelId ? { modelId: options.modelId } : {}),
        ...(options?.reasoningId !== undefined ? { reasoningId: options.reasoningId } : {}),
      },
    );
  },

  removeHistorySession: async (session) => {
    try {
      const workspaceVisibilityVersionAtRequest = get().workspaceVisibilityVersion;
      const sessionsResponse = await api.removeStoredSession(session);
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
      refreshWorkbenchState: get().refreshWorkbenchState,
    });
  },

  renameSession: async (sessionId, title) => {
    await renameSessionCommand({
      set,
      sessionId,
      title,
      refreshWorkbenchState: get().refreshWorkbenchState,
    });
  },

  setSessionMode: async (sessionId, modeId) => {
    await setSessionModeCommand({
      set,
      sessionId,
      modeId,
    });
  },

  setSessionModel: async (sessionId, modelId, reasoningId) => {
    try {
      const summary = await api.setSessionModel(sessionId, {
        modelId,
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

  loadOlderHistory: async (sessionId) => {
    await loadOlderHistoryCommand({
      get,
      set,
      sessionId,
      historyPageLimit: HISTORY_PAGE_LIMIT,
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

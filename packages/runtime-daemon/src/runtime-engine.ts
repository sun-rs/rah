import { mkdir, opendir, stat } from "node:fs/promises";
import { resolve } from "node:path";
import type {
  AddCouncilAgentRequest,
  AddCouncilAgentResponse,
  AddManualProviderModelRequest,
  AddManualProviderModelResponse,
  AttachSessionRequest,
  AttachSessionResponse,
  ClaimControlRequest,
  CloseSessionRequest,
  ConversationItemDetailResponse,
  ConversationResourceIndexResponse,
  ConversationTurnDetailResponse,
  ConversationTurnProjection,
  ConversationTurnsPageResponse,
  CouncilAgentTuiResponse,
  CouncilMessagesPageResponse,
  CouncilMcpRequest,
  CouncilMcpResponse,
  CouncilPostMessageRequest,
  CouncilPostMessageResponse,
  CouncilReinjectAgentsResponse,
  CouncilRemoveAgentResponse,
  CouncilSnapshot,
  CouncilStopAgentResponse,
  CreateCouncilRequest,
  CreateCouncilResponse,
  DetachSessionRequest,
  DeleteQueuedInputRequest,
  DeleteManualProviderModelOptionResponse,
  DeleteManualProviderModelResponse,
  DebugScenarioDescriptor,
  DebugReplayScript,
  EventSubscriptionRequest,
  ForkSessionRequest,
  ForkSessionResponse,
  GitFileActionRequest,
  GitHunkActionRequest,
  IndependentTerminalStartRequest,
  IndependentTerminalStartResponse,
  InterruptSessionRequest,
  ManagedSession,
  ManualProviderModel,
  NativeTuiSurfaceClaimRequest,
  NativeTuiClientCloseRequest,
  NativeTuiSurfaceReleaseRequest,
  NativeTuiSurfaceResponse,
  NativeTuiDiagnostic,
  ListSessionsResponse,
  ListCouncilsResponse,
  ProviderDiagnostic,
  ProviderKind,
  ProviderModelCatalog,
  PermissionResponseRequest,
  PtySessionStats,
  RahEvent,
  ReleaseControlRequest,
  ReorderQueuedInputRequest,
  ResumeSessionRequest,
  ResumeSessionResponse,
  SetInputQueuePolicyRequest,
  SetSessionModelRequest,
  SessionFileSearchResponse,
  ConversationEvidenceDetailMode,
  ConversationEvidencePage,
  ConversationTurnDirectoryResponse,
  SessionInputRequest,
  SessionSummary,
  StartSessionRequest,
  StartSessionResponse,
  SteerQueuedInputRequest,
  StoredSessionIdentity,
  StoredSessionArchiveBackend,
  StoredSessionRef,
  StoredSessionsDeltaResponse,
  TuiMuxSessionDiagnostic,
  UpdateQueuedInputRequest,
  WorkbenchPinnedItemRef,
} from "@rah/runtime-protocol";
import {
  isCoreLiveProvider,
  isNativeLocalServerProvider,
  isTuiMuxFallbackProvider,
  liveBackendSupportedByProvider,
} from "@rah/runtime-protocol";
import { createDefaultProviderAdapters } from "./default-provider-adapters";
import { nativeTuiInputText } from "./session-input-attachments";
import { projectConversation } from "./conversation-projector";
import { ConversationProjectionStore } from "./conversation-projection-store";
import { ConversationResourceIndexStore } from "./conversation-resource-index";
import { summarizeConversationTurnsForTransport } from "./conversation-transport-summary";
import { buildConversationTurnDirectory } from "./conversation-turn-directory";
import { conversationEventBelongsToLiveProjection } from "./conversation-live-policy";
import { approximateJsonByteLength } from "./bounded-json-size";
import {
  applyWorkspaceGitFileActionAsync,
  applyWorkspaceGitHunkActionAsync,
  getWorkspaceGitDiffAsync,
  getWorkspaceGitStatusAsync,
  getWorkspaceSnapshot,
  readHostFileDataAsync,
  readWorkspaceFileFromDirectoryAsync,
  searchWorkspaceFilesInDirectoryAsync,
} from "./workspace-utils";
import { EventBus } from "./event-bus";
import { HistorySnapshotStore } from "./history-snapshots";
import {
  chatHistoryPage,
  fullHistoryPage,
  historyEventMatchesItem,
  summarizeHistoryPage,
} from "./history-event-projection";
import type {
  ProviderActionCapabilityAdapter,
  ProviderAdapter,
  ProviderCapabilityView,
  ProviderDebugAdapter,
  ProviderDiagnosticAdapter,
  ProviderEnhancedModeAdapter,
  ProviderEnhancedModelAdapter,
  ProviderShutdownAdapter,
  ProviderStoredHistoryAdapter,
  ProviderStructuredInputControlAdapter,
  ProviderStructuredLifecycleAdapter,
  ProviderStructuredPermissionAdapter,
  ProviderWorkspaceInspectionAdapter,
} from "./provider-adapter";
import { PtyHub } from "./pty-hub";
import { ProcessOutputStore } from "./process-output-store";
import { RuntimeStructuredProviderCoordinator } from "./provider-control/runtime-structured-provider-coordinator";
import { SessionStore, toSessionSummary, type StoredSessionState } from "./session-store";
import { TurnArtifactStore, turnArtifactOwnerKey } from "./turn-artifact-store";
import {
  buildSessionsResponse as buildRuntimeSessionsResponse,
  discoverStoredSessions as discoverRuntimeStoredSessions,
  sameStoredSessionRefs,
  sessionProviderKey,
  storedSessionRefKey,
  type StoredSessionsResponseMode,
} from "./runtime-session-list";
import { StoredSessionMonitor } from "./stored-session-monitor";
import { StoredSessionCatalog } from "./stored-session-catalog";
import { reconcileStoredSessionCatalogRecords } from "./stored-session-catalog-reconciliation";
import { CODEX_STORED_SESSION_CACHE_VERSION } from "./codex-stored-sessions";
import { StoredSessionLibraryStore } from "./stored-session-library";
import type {
  StoredSessionCatalogProvider,
  StoredSessionCatalogProviderResult,
  StoredSessionCatalogRecord,
} from "./stored-session-catalog-types";
import {
  loadStoredSessionCatalogCache,
  loadStoredSessionCatalogSnapshot,
  writeStoredSessionCatalogSnapshot,
} from "./stored-session-metadata-cache";
import { RuntimeTerminalCoordinator } from "./runtime-terminal-coordinator";
import { releaseTimelineIdentityTelemetrySession } from "./timeline-identity-telemetry";
import { releaseTimelineReconcilerSession } from "./timeline-reconciler";
import { RuntimeSessionLifecycle } from "./runtime-session-lifecycle";
import { SessionInputQueueConflictError } from "./session-input-queue";
import {
  createDefaultNativeTuiProviderRuntime,
  type NativeTuiProviderRuntime,
} from "./native-tui-provider-runtime";
import {
  applyCanonicalTitleToSessionSummary,
  applyCanonicalTitleToStoredSession,
  resolveCanonicalSessionTitle,
} from "./session-title-resolver";
import {
  createDefaultNativeTuiMirrorProvider,
  type NativeTuiMirrorProvider,
} from "./native-tui-mirror-provider";
import { NativeTuiHistoryCatalogIndex } from "./native-tui-history-catalog";
import { WorkbenchStateStore } from "./workbench-state";
import {
  canonicalDirectoryKey,
  findOwningWorkspaceDirectory,
  isReadOnlyReplaySession,
  normalizeDirectory,
  primeCanonicalDirectoryKeys,
  resolveUserPath,
  sessionBelongsToWorkspace,
  workspaceDirsFromState,
} from "./workbench-directory-utils";
import { WorkspaceScopeAuthorizer } from "./workspace-scope-authorizer";
import { assertExistingWorkingDirectory } from "./provider-working-directory";
import { cleanupRahNativeServerOrphans } from "./native-local-server-orphans";
import { prepareProviderSessionResume } from "./provider-resume";
import {
  bindActionCapability,
  bindDebugCapability,
  bindDiagnosticCapability,
  bindEnhancedModeCapability,
  bindEnhancedModelCapability,
  bindShutdownCapability,
  bindStoredHistoryCapability,
  bindStructuredInputControlCapability,
  bindStructuredLifecycleCapability,
  bindStructuredPermissionCapability,
  bindWorkspaceInspectionCapability,
  hasActionCapability,
  hasDebugCapability,
  hasDiagnosticCapability,
  hasEnhancedModeCapability,
  hasEnhancedModelCapability,
  hasShutdownCapability,
  hasStoredHistoryCapability,
  hasStructuredInputControlCapability,
  hasStructuredLifecycleCapability,
  hasStructuredPermissionCapability,
  hasWorkspaceInspectionCapability,
} from "./provider-capability-bindings";
import { CouncilRuntime } from "./council/council-runtime";
import {
  addManualProviderModel,
  deleteManualProviderModel,
  deleteManualProviderModelOption,
  listManualProviderModels,
} from "./manual-provider-models";
import { shouldSuppressCouncilManagedHistoryEvent } from "./provider-activity";

const SYSTEM_SOURCE = {
  provider: "system" as const,
  channel: "system" as const,
  authority: "authoritative" as const,
};

const MAX_MATERIALIZED_HISTORY_EVENTS = 5_000;
const STORED_SESSION_DELTA_LOG_LIMIT = 200;
const PROVIDER_MODEL_CATALOG_STARTUP_REFRESH_DELAY_MS = 1_000;
const PROVIDER_MODEL_CATALOG_REFRESH_INTERVAL_MS = 30 * 60 * 1_000;

function isStoredSessionCatalogProvider(
  provider: ProviderKind,
): provider is StoredSessionCatalogProvider {
  return provider === "codex" || provider === "claude" || provider === "opencode";
}

function stoppedSessionRef(state: StoredSessionState | undefined): StoredSessionRef | undefined {
  if (!state || state.session.provider === "custom" || !state.session.providerSessionId) {
    return undefined;
  }
  const updatedAt =
    state.conversationActivityAt ?? state.session.updatedAt ?? state.session.createdAt;
  return {
    provider: state.session.provider,
    providerSessionId: state.session.providerSessionId,
    cwd: state.session.cwd,
    rootDir: state.session.rootDir,
    ...(state.session.title !== undefined ? { title: state.session.title } : {}),
    ...(state.session.preview !== undefined ? { preview: state.session.preview } : {}),
    createdAt: state.session.createdAt,
    updatedAt,
    lastUsedAt: updatedAt,
    source: "provider_history",
  };
}

type StructuredSessionOwnerProvider = StoredSessionState["session"]["provider"];

type StoredSessionDiscoveryChange = {
  revision: number;
  upsert: StoredSessionRef[];
  remove: StoredSessionIdentity[];
  resetRequired?: boolean;
};

type ForkSessionOperation = {
  operationId: string;
  fingerprint: string;
  promise: Promise<ForkSessionResponse>;
};

type CompletedForkSessionOperation = {
  fingerprint: string;
  response: ForkSessionResponse;
  expiresAt: number;
};

function filterCouncilManagedHistoryPage(
  session: ManagedSession | undefined,
  page: ConversationEvidencePage,
): ConversationEvidencePage {
  if (session?.origin?.kind !== "council") {
    return page;
  }
  return {
    ...page,
    events: page.events.filter((event) => !shouldSuppressCouncilManagedHistoryEvent(event)),
  };
}

const SHUTDOWN_STEP_TIMEOUT_MS = 8_000;
const FORK_SESSION_OPERATION_TTL_MS = 5 * 60_000;

async function runShutdownStep(label: string, task: () => Promise<unknown> | unknown) {
  let timeout: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      Promise.resolve().then(task),
      new Promise<void>((_resolve, reject) => {
        timeout = setTimeout(() => {
          reject(new Error(`Shutdown step timed out after ${SHUTDOWN_STEP_TIMEOUT_MS}ms.`));
        }, SHUTDOWN_STEP_TIMEOUT_MS);
        timeout.unref?.();
      }),
    ]);
  } catch (error) {
    console.error("[rah] shutdown step failed", { step: label, error });
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

export class RuntimeEngine {
  readonly eventBus: EventBus;
  readonly conversationStore: ConversationProjectionStore;
  readonly processOutputs: ProcessOutputStore;
  readonly ptyHub: PtyHub;
  readonly sessionStore: SessionStore;
  readonly workbenchState: WorkbenchStateStore;
  readonly sessionLibrary: StoredSessionLibraryStore;
  readonly historySnapshots: HistorySnapshotStore;
  readonly turnArtifacts: TurnArtifactStore;
  private readonly conversationResourceIndexes = new ConversationResourceIndexStore();
  private rememberedSessions: StoredSessionRef[];
  private rememberedRecentSessions: StoredSessionRef[];
  private rememberedWorkspaceDirs: string[];
  private rememberedHiddenWorkspaces: string[];
  private rememberedActiveWorkspaceDir: string | undefined;
  private rememberedHiddenSessionKeys: string[];
  private rememberedSessionTitleOverrides: Record<string, string>;
  private rememberedPinnedSidebarItems: WorkbenchPinnedItemRef[];
  private lastDiscoveredStoredSessions: StoredSessionRef[] = [];
  private storedSessionDiscoveryVersion = 0;
  private readonly storedSessionDiscoveryChanges: StoredSessionDiscoveryChange[] = [];
  private readonly storedSessionCatalogRecords = new Map<
    StoredSessionCatalogProvider,
    StoredSessionCatalogRecord[]
  >();
  private pendingStoredSessionCatalogSnapshot:
    | StoredSessionCatalogRecord[]
    | undefined;
  private storedSessionCatalogPersistTask: Promise<void> | undefined;
  private storedSessionCatalogPersistError: unknown;
  private readonly storedSessionMonitor: StoredSessionMonitor;
  private readonly storedSessionCatalog: StoredSessionCatalog | undefined;
  /**
   * Provider-native history is also required by native TUI sessions when the
   * engine is constructed with injected adapters. Keep that discovery path
   * separate from the injected adapter catalog so a cache miss can be
   * resolved by the bounded child-process scanner without mutating the
   * caller-owned stored-session list.
   *
   * Production aliases this to `storedSessionCatalog`; injected engines own a
   * lazy, native-TUI-only catalog.
   */
  private readonly nativeTuiStoredSessionCatalog: StoredSessionCatalog;
  private readonly workspaceScopeAuthorizer: WorkspaceScopeAuthorizer;
  private readonly terminals: RuntimeTerminalCoordinator;
  private readonly sessionLifecycle: RuntimeSessionLifecycle;
  private readonly structuredProviders: RuntimeStructuredProviderCoordinator;
  private readonly nativeTuiProviders: NativeTuiProviderRuntime;
  private readonly nativeTuiMirrors: NativeTuiMirrorProvider;
  private readonly nativeTuiHistoryCatalog: NativeTuiHistoryCatalogIndex;
  private readonly council: CouncilRuntime;

  private readonly structuredLiveAdaptersByProvider = new Map<
    string,
    ProviderCapabilityView<ProviderStructuredLifecycleAdapter>
  >();
  private readonly structuredInputAdaptersByProvider = new Map<
    string,
    ProviderCapabilityView<ProviderStructuredInputControlAdapter>
  >();
  private readonly structuredPermissionAdaptersByProvider = new Map<
    string,
    ProviderCapabilityView<Required<ProviderStructuredPermissionAdapter>>
  >();
  private readonly workspaceInspectionAdaptersByProvider = new Map<
    string,
    ProviderCapabilityView<ProviderWorkspaceInspectionAdapter>
  >();
  private readonly modeAdaptersByProvider = new Map<
    string,
    ProviderCapabilityView<ProviderEnhancedModeAdapter>
  >();
  private readonly modelAdaptersByProvider = new Map<
    string,
    ProviderCapabilityView<ProviderEnhancedModelAdapter>
  >();
  private readonly actionAdaptersByProvider = new Map<
    string,
    ProviderCapabilityView<ProviderActionCapabilityAdapter>
  >();
  private readonly diagnosticAdaptersByProvider = new Map<
    string,
    ProviderCapabilityView<ProviderDiagnosticAdapter>
  >();
  private readonly debugAdaptersById = new Map<
    string,
    ProviderCapabilityView<ProviderDebugAdapter>
  >();
  private readonly storedHistoryAdaptersByProvider = new Map<string, ProviderStoredHistoryAdapter>();
  private readonly shutdownAdaptersById = new Map<
    string,
    ProviderCapabilityView<ProviderShutdownAdapter>
  >();
  private readonly structuredSessionOwners = new Map<string, StructuredSessionOwnerProvider>();
  private readonly storedReplayProviders = new Map<string, ProviderKind>();
  private readonly historyMirrorAdapters: ProviderStoredHistoryAdapter[] = [];
  private readonly nativeTuiRehydratedSessionIds = new Set<string>();
  private readonly liveProviderSessionResumeReservations = new Map<string, number>();
  private readonly activeForkSessionOperations = new Map<string, ForkSessionOperation>();
  private readonly completedForkSessionOperations = new Map<
    string,
    CompletedForkSessionOperation
  >();
  private readonly orphanSessionCleanupInFlight = new Set<string>();
  private readonly structuredLiveAllowedForInjectedAdapters: boolean;
  private readonly startupMaintenance: Promise<void>;
  private providerModelCatalogRefreshTimer: ReturnType<typeof setTimeout> | undefined;
  private shuttingDown = false;

  constructor(adapters?: ProviderAdapter[]) {
    this.structuredLiveAllowedForInjectedAdapters = adapters !== undefined;
    this.workbenchState = new WorkbenchStateStore();
    this.sessionLibrary = new StoredSessionLibraryStore();
    this.sessionLibrary.load();
    this.eventBus = new EventBus();
    this.processOutputs = new ProcessOutputStore();
    this.ptyHub = new PtyHub();
    this.historySnapshots = new HistorySnapshotStore();
    this.turnArtifacts = new TurnArtifactStore();
    this.nativeTuiHistoryCatalog = new NativeTuiHistoryCatalogIndex({
      refresh: (provider) =>
        this.refreshNativeTuiHistoryCatalogInBackground(
          provider,
          "native TUI history cache miss",
        ),
    });
    this.nativeTuiProviders = createDefaultNativeTuiProviderRuntime(
      this.nativeTuiHistoryCatalog,
    );
    this.nativeTuiMirrors = createDefaultNativeTuiMirrorProvider(
      this.nativeTuiHistoryCatalog,
    );
    this.council = new CouncilRuntime({
      eventBus: this.eventBus,
      startSession: async (request) => {
        const response = await this.startSession(request);
        return this.syncStartedSessionOrigin(response, request.origin);
      },
      sendInput: (sessionId, request) => this.sendInput(sessionId, request),
      sendStructuredInput: (sessionId, request) => this.sendStructuredInput(sessionId, request),
      interruptSession: (sessionId, request) => {
        this.interruptSession(sessionId, request);
      },
      closeSession: (sessionId) => this.closeCouncilManagedSession(sessionId),
      hasSession: (sessionId) => this.sessionStore?.getSession(sessionId) !== undefined,
    });
    this.sessionStore = new SessionStore({
      onSnapshot: (states) => {
        for (const state of states) {
          this.council.rememberManagedSessionProviderIdentity(state.session);
        }
        this.workbenchState.persistLiveSessions(states);
        this.refreshRememberedState();
      },
    });
    this.conversationStore = new ConversationProjectionStore(this.eventBus, {
      eventFilter: (event) =>
        conversationEventBelongsToLiveProjection(
          this.sessionStore.getSession(event.sessionId)?.session,
          event,
        ),
    });
    const restored = this.workbenchState.load();
    this.rememberedSessions = restored.sessions;
    this.rememberedRecentSessions = restored.recentSessions;
    this.rememberedWorkspaceDirs = restored.workspaces;
    this.rememberedHiddenWorkspaces = restored.hiddenWorkspaces;
    this.rememberedActiveWorkspaceDir = restored.activeWorkspaceDir;
    this.rememberedHiddenSessionKeys = restored.hiddenSessionKeys;
    this.rememberedSessionTitleOverrides = restored.sessionTitleOverrides;
    this.rememberedPinnedSidebarItems = restored.pinnedSidebarItems;
    this.workspaceScopeAuthorizer = new WorkspaceScopeAuthorizer(
      this.workbenchState,
      this.sessionStore,
    );
    this.terminals = new RuntimeTerminalCoordinator({
      eventBus: this.eventBus,
      ptyHub: this.ptyHub,
      sessionStore: this.sessionStore,
      historySnapshots: this.historySnapshots,
      nativeTuiProviders: this.nativeTuiProviders,
      nativeTuiMirrors: this.nativeTuiMirrors,
      onRememberSession: (state) => {
        this.workbenchState.rememberSession(state);
        this.refreshRememberedState();
      },
      onSessionOwnerRemoved: (sessionId) => {
        this.structuredSessionOwners.delete(sessionId);
      },
    });
    this.sessionLifecycle = new RuntimeSessionLifecycle({
      eventBus: this.eventBus,
      ptyHub: this.ptyHub,
      sessionStore: this.sessionStore,
      historySnapshots: this.historySnapshots,
      terminals: this.terminals,
      rememberSession: (state) => {
        this.workbenchState.rememberSession(state);
      },
      setSessionTitleOverride: (session, title) => {
        this.workbenchState.setSessionTitleOverride(session, title);
      },
      refreshRememberedState: () => {
        this.refreshRememberedState();
      },
      publishStoredSessionDiscovery: (session) => {
        if (session) {
          this.publishStoredSessionDiscoveryUpsert(session);
        } else {
          this.publishStoredSessionDiscoveryReset();
        }
      },
      removeStructuredSessionOwner: (sessionId) => {
        this.structuredSessionOwners.delete(sessionId);
      },
      releaseTimelineSessionState: (sessionId) => {
        releaseTimelineReconcilerSession(this, sessionId);
        releaseTimelineIdentityTelemetrySession(this, sessionId);
      },
      requireStructuredLifecycleAdapter: (sessionId) =>
        this.requireStructuredLifecycleAdapter(sessionId),
      requireActionCapabilityAdapter: (sessionId) =>
        this.requireActionCapabilityAdapter(sessionId),
      requireEnhancedModeAdapter: (sessionId) =>
        this.requireEnhancedModeAdapter(sessionId),
      requireEnhancedModelAdapter: (sessionId) =>
        this.requireEnhancedModelAdapter(sessionId),
    });
    this.structuredProviders = new RuntimeStructuredProviderCoordinator({
      structuredLiveAdaptersByProvider: this.structuredLiveAdaptersByProvider,
      modelAdaptersByProvider: this.modelAdaptersByProvider,
      diagnosticAdaptersByProvider: this.diagnosticAdaptersByProvider,
      debugAdaptersById: this.debugAdaptersById,
      rememberStructuredSessionOwner: (sessionId, provider) => {
        this.rememberStructuredSessionOwner(sessionId, provider);
      },
      pruneOrphanSessions: () => {
        this.pruneOrphanSessions();
      },
      historySnapshots: this.historySnapshots,
    });

    const resolvedAdapters: ProviderAdapter[] = adapters ?? createDefaultProviderAdapters({
      eventBus: this.eventBus,
      processOutputs: this.processOutputs,
      ptyHub: this.ptyHub,
      sessionStore: this.sessionStore,
      turnArtifacts: this.turnArtifacts,
      workbenchState: this.workbenchState,
    });
    for (const adapter of resolvedAdapters) {
      this.registerAdapter(adapter);
    }
    if (adapters === undefined) {
      const catalog = new StoredSessionCatalog();
      this.storedSessionCatalog = catalog;
      this.nativeTuiStoredSessionCatalog = catalog;
      const storedSnapshot = loadStoredSessionCatalogSnapshot();
      const cachedRecords = storedSnapshot.length > 0
        ? storedSnapshot
        : [
            ...loadStoredSessionCatalogCache("codex", {
              entryVersion: CODEX_STORED_SESSION_CACHE_VERSION,
            }),
            ...loadStoredSessionCatalogCache("claude"),
          ];
      this.replaceStoredSessionCatalogRecords(cachedRecords);
      this.hydrateStoredSessionCatalog(cachedRecords);
      this.updateStoredSessionsCache(
        cachedRecords.map((record) => record.ref),
      );
    } else {
      this.storedSessionCatalog = undefined;
      this.nativeTuiStoredSessionCatalog = new StoredSessionCatalog();
      this.refreshStoredSessionsCache();
    }
    this.storedSessionMonitor = new StoredSessionMonitor({
      roots: this.historyMirrorAdapters.flatMap(
        (adapter) => adapter.listStoredSessionWatchRoots?.() ?? [],
      ),
      refresh: () =>
        this.refreshStoredSessionsCatalogInBackground(
          { publish: true },
          "periodic reconciliation",
        ),
      ...(adapters !== undefined ? { debounceMs: 50 } : {}),
      watchFs: adapters !== undefined,
      watchFileChanges: adapters !== undefined,
    });
    if (process.env.RAH_DISABLE_STORED_SESSION_MONITOR !== "1") {
      this.storedSessionMonitor.start();
      if (this.storedSessionCatalog) {
        this.storedSessionMonitor.scheduleRefresh();
      }
    }
    this.startupMaintenance = this.restoreTuiMuxLiveSessions(restored.tuiMuxLiveSessions)
      .then(() => this.runStartupOrphanJanitor())
      .catch((error: unknown) => {
        console.warn("[rah] startup orphan cleanup failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    void this.turnArtifacts.runMaintenance().catch((error: unknown) => {
      console.warn("[rah] startup turn artifact maintenance failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
    if (adapters === undefined) {
      this.scheduleProviderModelCatalogRefresh(PROVIDER_MODEL_CATALOG_STARTUP_REFRESH_DELAY_MS);
    }
  }

  private async waitForStartupMaintenance(): Promise<void> {
    await this.startupMaintenance;
  }

  private async restoreTuiMuxLiveSessions(
    sessions: readonly ManagedSession[],
  ): Promise<void> {
    if (sessions.length === 0) {
      return;
    }
    for (const session of sessions) {
      if (!isTuiMuxFallbackProvider(session.provider)) {
        console.warn("[rah] skipping stale unsupported TUI mux running session", {
          sessionId: session.id,
          provider: session.provider,
          muxSessionName: session.mux?.sessionName,
        });
        continue;
      }
      await this.terminals.restoreTuiMuxSession(session).catch((error) => {
        console.warn("[rah] failed to recover TUI mux running session", {
          sessionId: session.id,
          muxSessionName: session.mux?.sessionName,
          error,
        });
        return false;
      });
    }
    this.workbenchState.persistLiveSessions(this.sessionStore.listSessions());
    this.refreshRememberedState();
  }

  private async runStartupOrphanJanitor(): Promise<void> {
    const closedNativeServerPids = await cleanupRahNativeServerOrphans();
    if (closedNativeServerPids.length > 0) {
      console.warn("[rah] cleaned RAH native local-server processes", {
        pids: closedNativeServerPids,
      });
    }
    const closedTuiMuxSessions = await this.terminals.cleanupUnmanagedTuiMuxSessions();
    if (closedTuiMuxSessions.length > 0) {
      console.warn("[rah] cleaned unmanaged RAH tmux sessions", {
        sessions: closedTuiMuxSessions,
      });
    }
    this.council.reconcilePersistedRuntimeState();
  }

  listSessions(options?: { storedSessionsMode?: StoredSessionsResponseMode }): ListSessionsResponse {
    this.pruneOrphanSessions();
    const liveStates = this.sessionStore.listSessions();
    return this.buildSessionsResponse(liveStates, this.lastDiscoveredStoredSessions, {
      ...options,
      storedSessionsMode: options?.storedSessionsMode ?? "recent",
    });
  }

  async listSessionsForRequest(
    options?: { storedSessionsMode?: StoredSessionsResponseMode },
  ): Promise<ListSessionsResponse> {
    await this.primeWorkbenchDirectoryIdentities();
    const storedSessionsMode = options?.storedSessionsMode ?? "recent";
    if (storedSessionsMode === "all") {
      await this.refreshStoredSessionsCatalog();
    }
    return this.listSessions({ ...options, storedSessionsMode });
  }

  async refreshStoredSessionsCatalog(options?: {
    publish?: boolean;
    provider?: ProviderKind;
  }): Promise<void> {
    if (!this.storedSessionCatalog) {
      this.refreshStoredSessionsCache(options);
      return;
    }
    const requestedProvider = options?.provider;
    if (requestedProvider && !isStoredSessionCatalogProvider(requestedProvider)) {
      return;
    }
    const results = await this.storedSessionCatalog.refresh(requestedProvider);
    this.applyStoredSessionCatalogResults(results, {
      publish: options?.publish ?? false,
    });
  }

  async listProviderDiagnostics(options?: {
    forceRefresh?: boolean;
    includeHealth?: boolean;
    provider?: "codex" | "claude" | "opencode";
  }): Promise<ProviderDiagnostic[]> {
    return this.structuredProviders.listProviderDiagnostics(options);
  }

  listNativeTuiDiagnostics(options?: {
    sessionId?: string;
    includeResolved?: boolean;
  }): NativeTuiDiagnostic[] {
    return this.terminals.listNativeTuiDiagnostics(options);
  }

  listPtyStats(): PtySessionStats[] {
    return this.ptyHub.listStats().map((stat) => {
      const state = this.sessionStore.getSession(stat.sessionId);
      if (!state) {
        return stat;
      }
      const { session } = state;
      return {
        ...stat,
        provider: session.provider,
        runtimeState: session.runtimeState,
        ...(session.liveBackend ? { liveBackend: session.liveBackend } : {}),
        ...(session.nativeTui?.promptState
          ? { nativeTuiPromptState: session.nativeTui.promptState }
          : {}),
        ...(session.mux ? { mux: session.mux } : {}),
      };
    });
  }

  async listTuiMuxDiagnostics(): Promise<TuiMuxSessionDiagnostic[]> {
    return await this.terminals.listTuiMuxDiagnostics();
  }

  async closeTuiMuxSession(sessionName: string): Promise<void> {
    await this.terminals.closeUnmanagedTuiMuxSession(sessionName);
  }

  async listProviderModels(
    provider: ProviderKind,
    options?: { cwd?: string; forceRefresh?: boolean },
  ): Promise<ProviderModelCatalog> {
    return this.structuredProviders.listProviderModels(provider, options);
  }

  listManualProviderModels(provider?: ProviderKind): ManualProviderModel[] {
    return listManualProviderModels(provider);
  }

  async addManualProviderModel(
    provider: ProviderKind,
    request: AddManualProviderModelRequest,
  ): Promise<AddManualProviderModelResponse> {
    const trimmedModelId = request.id.trim();
    const catalog = await this.listProviderModels(provider, {
      ...(request.cwd ? { cwd: request.cwd } : {}),
      forceRefresh: true,
    });
    if (catalog.models.some((model) => model.id === trimmedModelId)) {
      throw new Error(`Bad Request: model '${trimmedModelId}' already exists for ${provider}.`);
    }
    const model = await addManualProviderModel(provider, request);
    return {
      model,
      catalog: await this.listProviderModels(provider, request.cwd ? { cwd: request.cwd } : {}),
    };
  }

  async deleteManualProviderModel(
    provider: ProviderKind,
    modelId: string,
    options?: { cwd?: string },
  ): Promise<DeleteManualProviderModelResponse> {
    await deleteManualProviderModel(provider, modelId);
    return {
      ok: true,
      catalog: await this.listProviderModels(provider, options),
    };
  }

  async deleteManualProviderModelOption(
    provider: ProviderKind,
    modelId: string,
    optionId: string,
    options?: { cwd?: string },
  ): Promise<DeleteManualProviderModelOptionResponse> {
    const model = await deleteManualProviderModelOption(provider, modelId, optionId);
    return {
      model,
      catalog: await this.listProviderModels(provider, options),
    };
  }

  listCouncils(): ListCouncilsResponse {
    return this.council.listCouncils();
  }

  readCouncilMessages(
    councilId: string,
    options?: { beforeMessageId?: number; limit?: number },
  ): CouncilMessagesPageResponse {
    return this.council.readCouncilMessages(councilId, options);
  }

  async createCouncil(request: CreateCouncilRequest): Promise<CreateCouncilResponse> {
    await this.waitForStartupMaintenance();
    await assertExistingWorkingDirectory(request.workspace, "Council workspace");
    return await this.council.createCouncil(request);
  }

  async addCouncilAgent(councilId: string, request: AddCouncilAgentRequest): Promise<AddCouncilAgentResponse> {
    const snapshot = this.council.listCouncils().councils.find((council) => council.id === councilId);
    if (snapshot) {
      await assertExistingWorkingDirectory(snapshot.workspace, "Council workspace");
    }
    return await this.council.addAgent(councilId, request);
  }

  postCouncilMessage(
    councilId: string,
    request: CouncilPostMessageRequest,
  ): CouncilPostMessageResponse {
    return this.council.postMessage(councilId, request);
  }

  renameCouncil(councilId: string, title: string): CouncilSnapshot {
    const council = this.council.renameCouncil(councilId, title);
    this.syncCouncilAgentSessionOrigins(council);
    return council;
  }

  private syncStartedSessionOrigin<T extends { session: SessionSummary }>(
    response: T,
    origin: ManagedSession["origin"] | undefined,
  ): T {
    if (origin === undefined) {
      return response;
    }
    const sessionId = response.session.session.id;
    this.sessionStore.patchManagedSession(sessionId, { origin });
    return {
      ...response,
      session: this.getSessionSummary(sessionId),
    };
  }

  private syncCouncilAgentSessionOrigins(council: CouncilSnapshot): void {
    for (const agent of council.agents) {
      const sessionId = agent.nativeSessionId ?? agent.terminalId;
      if (!sessionId) {
        continue;
      }
      const session = this.sessionStore.getSession(sessionId)?.session;
      if (!session) {
        continue;
      }
      const origin = session.origin;
      if (
        origin !== undefined &&
        (origin.kind !== "council" || origin.councilId !== council.id || origin.agentId !== agent.id)
      ) {
        continue;
      }
      this.sessionStore.patchManagedSession(sessionId, {
        origin: {
          kind: "council",
          councilId: council.id,
          councilTitle: council.title,
          agentId: agent.id,
          agentLabel: agent.label,
        },
      });
    }
  }

  async stopCouncil(councilId: string): Promise<void> {
    await this.council.stopCouncil(councilId);
  }

  deleteCouncil(councilId: string): void {
    this.council.deleteCouncil(councilId);
  }

  async getCouncilAgentTui(
    councilId: string,
    agentId: string,
  ): Promise<CouncilAgentTuiResponse> {
    return await this.council.getAgentTui(councilId, agentId);
  }

  reinjectCouncilAgentPrompt(councilId: string, agentId: string): CouncilReinjectAgentsResponse {
    return this.council.reinjectAgentPrompt(councilId, agentId);
  }

  removeCouncilAgent(councilId: string, agentId: string): CouncilRemoveAgentResponse {
    return this.council.removeAgentFromCouncil(councilId, agentId);
  }

  async stopCouncilAgent(councilId: string, agentId: string): Promise<CouncilStopAgentResponse> {
    return await this.council.stopAgentInCouncil(councilId, agentId);
  }

  async callCouncilMcpTool(request: CouncilMcpRequest): Promise<CouncilMcpResponse> {
    return await this.council.callMcpTool(request);
  }

  markCouncilMcpReady(councilId: string, agentId: string): void {
    this.council.markCouncilMcpReady(councilId, agentId);
  }

  async addWorkspace(
    rawDir: string,
    options?: { storedSessionsMode?: StoredSessionsResponseMode },
  ): Promise<ListSessionsResponse> {
    await this.primeWorkbenchDirectoryIdentities([rawDir]);
    this.workbenchState.selectWorkspace(rawDir);
    return this.currentWorkbenchSessions(options);
  }

  async selectWorkspace(
    rawDir: string,
    options?: { storedSessionsMode?: StoredSessionsResponseMode },
  ): Promise<ListSessionsResponse> {
    await this.primeWorkbenchDirectoryIdentities([rawDir]);
    this.workbenchState.selectWorkspace(rawDir);
    return this.currentWorkbenchSessions(options);
  }

  async removeWorkspace(
    rawDir: string,
    options?: { storedSessionsMode?: StoredSessionsResponseMode },
  ): Promise<ListSessionsResponse> {
    const directory = normalizeDirectory(rawDir);
    if (!directory) {
      throw new Error("Workspace directory is required.");
    }
    await this.primeWorkbenchDirectoryIdentities([directory]);
    this.refreshRememberedState();
    const liveStates = this.sessionStore.listSessions();
    const workspaceDirs = workspaceDirsFromState(this.rememberedWorkspaceDirs, liveStates);
    const directoryKey = canonicalDirectoryKey(directory);
    const hasRunningSessions = liveStates.some((state) => {
      if (isReadOnlyReplaySession(state)) {
        return false;
      }
      const owner = findOwningWorkspaceDirectory(
        workspaceDirs,
        state.session.rootDir || state.session.cwd,
      );
      return canonicalDirectoryKey(owner ?? undefined) === directoryKey;
    });
    if (hasRunningSessions) {
      throw new Error("Cannot remove a workspace with active running sessions.");
    }
    this.workbenchState.removeWorkspace(directory);
    return this.currentWorkbenchSessions(options);
  }

  setWorkbenchPinnedItem(
    workspaceDir: string,
    itemKey: string,
    pinned: boolean,
    options?: { storedSessionsMode?: StoredSessionsResponseMode },
  ): ListSessionsResponse {
    this.workbenchState.setPinnedSidebarItem(workspaceDir, itemKey, pinned);
    const response = this.currentWorkbenchSessions(options);
    this.publishStoredSessionDiscovery();
    return response;
  }

  async removeStoredSession(
    provider: ProviderKind,
    providerSessionId: string,
    options?: { storedSessionsMode?: StoredSessionsResponseMode },
  ): Promise<ListSessionsResponse> {
    this.requireStoredSessionClosed(provider, providerSessionId, "delete");
    await this.ensureStoredSessionCatalogRecord(provider, providerSessionId);
    const session = this.lastDiscoveredStoredSessions.find(
      (entry) =>
        entry.provider === provider && entry.providerSessionId === providerSessionId,
    );
    await this.storedHistoryAdaptersByProvider.get(provider)?.removeStoredSession?.(
      session ?? { provider, providerSessionId, source: "provider_history" },
    );
    await this.sessionLibrary.remove({ provider, providerSessionId });
    this.removeStoredSessionCatalogRecord({ provider, providerSessionId });
    this.workbenchState.hideSession({ provider, providerSessionId });
    this.refreshRememberedState();
    this.updateStoredSessionsCache(
      this.lastDiscoveredStoredSessions.filter(
        (session) =>
          session.provider !== provider || session.providerSessionId !== providerSessionId,
      ),
      {
        publish: true,
        extraRemove: [{ provider, providerSessionId }],
      },
    );
    return this.buildSessionsResponse(
      this.sessionStore.listSessions(),
      this.lastDiscoveredStoredSessions,
      options,
    );
  }

  async archiveStoredSession(
    provider: ProviderKind,
    providerSessionId: string,
    options?: {
      storedSessionsMode?: StoredSessionsResponseMode;
      runtimeSessionId?: string;
      clientId?: string;
    },
  ): Promise<ListSessionsResponse> {
    await this.ensureStoredSessionCatalogRecord(provider, providerSessionId);
    let stoppedRuntimeRef: StoredSessionRef | null = null;
    let managedRuntime: StoredSessionState | undefined;
    if (options?.runtimeSessionId) {
      if (!options.clientId) {
        throw new Error("clientId is required when archiving a running session.");
      }
      const managed = this.sessionStore.getSession(options.runtimeSessionId);
      if (!managed) {
        throw new Error(`Unknown session ${options.runtimeSessionId}.`);
      }
      if (
        managed.session.provider !== provider ||
        managed.session.providerSessionId !== providerSessionId
      ) {
        throw new Error(
          `Managed session ${options.runtimeSessionId} does not match ${provider}:${providerSessionId}.`,
        );
      }
      managedRuntime = managed;
      stoppedRuntimeRef = stoppedSessionRef(managed) ?? null;
    }
    const adapter = this.storedHistoryAdaptersByProvider.get(provider);
    const session = this.lastDiscoveredStoredSessions.find(
      (entry) =>
        entry.provider === provider && entry.providerSessionId === providerSessionId,
    ) ?? stoppedRuntimeRef ?? this.sessionLibrary.find({ provider, providerSessionId })?.snapshot ?? {
      provider,
      providerSessionId,
      source: "provider_history" as const,
    };
    let archiveBackend: StoredSessionArchiveBackend =
      adapter?.storedSessionArchiveBackend ??
      (adapter?.archiveStoredSession ? "provider_native" : "rah_overlay");
    let providerArchived = false;
    let libraryArchived = false;
    let archivedAt: string;
    try {
      // Native providers can archive first. If that request fails, the live
      // session remains untouched; this is the fast, failure-atomic path used
      // by Codex and OpenCode.
      if (managedRuntime && archiveBackend === "provider_native") {
        const reportedArchiveBackend = await adapter?.archiveStoredSession?.(session);
        providerArchived = Boolean(adapter?.archiveStoredSession);
        if (reportedArchiveBackend) {
          archiveBackend = reportedArchiveBackend;
        }
        if (archiveBackend !== "provider_native") {
          throw new Error(
            `${provider} reported ${archiveBackend} after declaring provider-native archive.`,
          );
        }
      } else if (managedRuntime && options?.runtimeSessionId && options.clientId) {
        await this.sessionLifecycle.closeSession(options.runtimeSessionId, {
          clientId: options.clientId,
        });
      }

      if (!managedRuntime || archiveBackend !== "provider_native") {
        this.requireStoredSessionClosed(provider, providerSessionId, "archive");
        const reportedArchiveBackend = await adapter?.archiveStoredSession?.(session);
        providerArchived = Boolean(adapter?.archiveStoredSession);
        if (reportedArchiveBackend) {
          archiveBackend = reportedArchiveBackend;
        }
      }

      archivedAt = new Date().toISOString();
      await this.sessionLibrary.archive(session, {
        backend: archiveBackend,
        archivedAt,
        ...(session.rootDir || session.cwd
          ? { workspaceDir: session.rootDir ?? session.cwd }
          : {}),
      });
      libraryArchived = true;

      if (
        managedRuntime &&
        archiveBackend === "provider_native" &&
        options?.runtimeSessionId &&
        options.clientId
      ) {
        await this.sessionLifecycle.closeSession(options.runtimeSessionId, {
          clientId: options.clientId,
        });
      }
    } catch (error) {
      const rollbackErrors: unknown[] = [];
      if (libraryArchived) {
        try {
          await this.sessionLibrary.restore({ provider, providerSessionId });
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError);
        }
      }
      if (providerArchived && adapter?.restoreStoredSession) {
        try {
          await adapter.restoreStoredSession(session);
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError);
        }
      }
      if (
        managedRuntime &&
        !this.sessionStore.getSession(managedRuntime.session.id)
      ) {
        const attachedClient = managedRuntime.clients.find(
          (client) => client.id === options?.clientId,
        );
        try {
          await this.resumeSession({
            provider,
            providerSessionId,
            cwd: managedRuntime.session.cwd,
            ...(managedRuntime.session.liveBackend
              ? { liveBackend: managedRuntime.session.liveBackend }
              : {}),
            ...(managedRuntime.session.origin
              ? { origin: managedRuntime.session.origin }
              : {}),
            ...(managedRuntime.session.model?.currentModelId
              ? { model: managedRuntime.session.model.currentModelId }
              : {}),
            ...(managedRuntime.session.config?.values
              ? { optionValues: managedRuntime.session.config.values }
              : {}),
            ...(managedRuntime.session.mode?.currentModeId
              ? { modeId: managedRuntime.session.mode.currentModeId }
              : {}),
            ...(attachedClient
              ? {
                  attach: {
                    client: {
                      id: attachedClient.id,
                      kind: attachedClient.kind,
                      connectionId: attachedClient.connectionId,
                    },
                    mode: attachedClient.attachMode,
                    claimControl: true,
                  },
                }
              : {}),
          });
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError);
        }
      }
      const providerSessionStillRunning = this.sessionStore.listSessions().some(
        (state) =>
          state.session.provider === provider &&
          state.session.providerSessionId === providerSessionId,
      );
      if (
        stoppedRuntimeRef &&
        !providerSessionStillRunning &&
        !this.lastDiscoveredStoredSessions.some(
          (entry) =>
            entry.provider === provider && entry.providerSessionId === providerSessionId,
        )
      ) {
        this.updateStoredSessionsCache(
          [...this.lastDiscoveredStoredSessions, stoppedRuntimeRef],
          { publish: false },
        );
      }
      if (stoppedRuntimeRef && !providerSessionStillRunning) {
        this.publishStoredSessionDiscoveryUpsert({ provider, providerSessionId });
      }
      if (rollbackErrors.length > 0) {
        throw new AggregateError(
          [error, ...rollbackErrors],
          `Archive failed and ${rollbackErrors.length} rollback step(s) also failed.`,
        );
      }
      throw error;
    }
    const nextStoredSessions = this.lastDiscoveredStoredSessions.map((entry) =>
      entry.provider === provider && entry.providerSessionId === providerSessionId
        ? {
            ...entry,
            ...(archiveBackend === "provider_native"
              ? {
                  providerState: {
                    ...entry.providerState,
                    archived: true,
                    archivedAt,
                  },
                }
              : {}),
            libraryState: {
              placement: "archive" as const,
              archivedAt,
              backend: archiveBackend,
            },
          }
        : entry,
    );
    this.refreshRememberedState();
    this.updateStoredSessionsCache(nextStoredSessions, { publish: true });
    if (archiveBackend === "provider_native" && isStoredSessionCatalogProvider(provider)) {
      const records = this.storedSessionCatalogRecords.get(provider) ?? [];
      const nextRecords = records.map((record) =>
          record.ref.providerSessionId === providerSessionId
            ? {
                ...record,
                archived: true,
                ref: {
                  ...record.ref,
                  providerState: {
                    ...record.ref.providerState,
                    archived: true,
                    archivedAt,
                  },
                },
              }
            : record,
      );
      this.storedSessionCatalogRecords.set(provider, nextRecords);
      this.nativeTuiHistoryCatalog.replaceProvider(provider, nextRecords);
      this.persistStoredSessionCatalogRecords();
    } else if (archiveBackend === "rah_snapshot") {
      this.removeStoredSessionCatalogRecord({ provider, providerSessionId });
    }
    return this.buildSessionsResponse(
      this.sessionStore.listSessions(),
      this.lastDiscoveredStoredSessions,
      options,
    );
  }

  async restoreStoredSession(
    provider: ProviderKind,
    providerSessionId: string,
    options?: { storedSessionsMode?: StoredSessionsResponseMode },
  ): Promise<ListSessionsResponse> {
    this.requireStoredSessionClosed(provider, providerSessionId, "restore");
    await this.ensureStoredSessionCatalogRecord(provider, providerSessionId);
    const identity = { provider, providerSessionId };
    const registryRecord = this.sessionLibrary.find(identity);
    const session = this.lastDiscoveredStoredSessions.find(
      (entry) =>
        entry.provider === provider && entry.providerSessionId === providerSessionId,
    ) ?? registryRecord?.snapshot;
    if (!session) {
      throw new Error(`Could not find an archived ${provider} session for ${providerSessionId}.`);
    }
    const providerNativeArchive =
      session.providerState?.archived === true ||
      registryRecord?.backend === "provider_native";
    const adapterManagedArchive =
      providerNativeArchive || registryRecord?.backend === "rah_snapshot";
    const adapter = this.storedHistoryAdaptersByProvider.get(provider);
    if (adapterManagedArchive) {
      if (!adapter?.restoreStoredSession) {
        throw new Error(`${provider} sessions do not support restore.`);
      }
      await adapter.restoreStoredSession(session);
    }
    await this.sessionLibrary.restore(identity);

    const nextStoredSessions = this.lastDiscoveredStoredSessions.map((entry) => {
      if (entry.provider !== provider || entry.providerSessionId !== providerSessionId) {
        return entry;
      }
      const { libraryState: _libraryState, ...withoutLibraryState } = entry;
      void _libraryState;
      if (!providerNativeArchive) {
        return withoutLibraryState;
      }
      const { archived: _archived, archivedAt: _archivedAt, ...providerState } =
        entry.providerState ?? {};
      void _archived;
      void _archivedAt;
      const { providerState: _oldProviderState, ...withoutProviderState } = withoutLibraryState;
      void _oldProviderState;
      return {
        ...withoutProviderState,
        ...(Object.keys(providerState).length > 0 ? { providerState } : {}),
      };
    });
    this.updateStoredSessionsCache(nextStoredSessions, { publish: true });
    if (providerNativeArchive && isStoredSessionCatalogProvider(provider)) {
      const records = this.storedSessionCatalogRecords.get(provider) ?? [];
      const nextRecords = records.map((record) => {
          if (record.ref.providerSessionId !== providerSessionId) {
            return record;
          }
          const { archived: _archived, archivedAt: _archivedAt, ...providerState } =
            record.ref.providerState ?? {};
          void _archived;
          void _archivedAt;
          const { providerState: _oldProviderState, ...ref } = record.ref;
          void _oldProviderState;
          return {
            ...record,
            archived: false,
            ref: {
              ...ref,
              ...(Object.keys(providerState).length > 0 ? { providerState } : {}),
            },
          };
        });
      this.storedSessionCatalogRecords.set(provider, nextRecords);
      this.nativeTuiHistoryCatalog.replaceProvider(provider, nextRecords);
      this.persistStoredSessionCatalogRecords();
    }
    return this.buildSessionsResponse(
      this.sessionStore.listSessions(),
      this.lastDiscoveredStoredSessions,
      options,
    );
  }

  async removeStoredWorkspaceSessions(rawDir: string): Promise<ListSessionsResponse> {
    const directory = normalizeDirectory(rawDir);
    if (!directory) {
      throw new Error("Workspace directory is required.");
    }
    if (this.storedSessionCatalog) {
      await this.refreshStoredSessionsCatalog();
    }
    const currentSessions = this.buildSessionsResponse(
      this.sessionStore.listSessions(),
      this.lastDiscoveredStoredSessions,
      { storedSessionsMode: "all" },
    );
    const matchingStoredSessions = [...currentSessions.storedSessions, ...currentSessions.recentSessions].filter((session) =>
      sessionBelongsToWorkspace(session.rootDir || session.cwd, directory),
    );
    for (const session of matchingStoredSessions) {
      this.requireStoredSessionClosed(
        session.provider,
        session.providerSessionId,
        "delete",
      );
    }
    const seen = new Set<string>();
    for (const session of matchingStoredSessions) {
      const key = `${session.provider}:${session.providerSessionId}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      await this.storedHistoryAdaptersByProvider
        .get(session.provider)
        ?.removeStoredSession?.(session);
      await this.sessionLibrary.remove(session);
      this.removeStoredSessionCatalogRecord(session, { persist: false });
    }
    if (seen.size > 0) {
      this.persistStoredSessionCatalogRecords();
    }
    this.workbenchState.hideSessionsInWorkspace(directory);
    this.refreshRememberedState();
    this.updateStoredSessionsCache(
      this.lastDiscoveredStoredSessions.filter(
        (session) => !sessionBelongsToWorkspace(session.rootDir || session.cwd, directory),
      ),
      {
        publish: true,
        extraRemove: matchingStoredSessions.map((session) => ({
          provider: session.provider,
          providerSessionId: session.providerSessionId,
        })),
      },
    );
    return this.buildSessionsResponse(
      this.sessionStore.listSessions(),
      this.lastDiscoveredStoredSessions,
      { storedSessionsMode: "all" },
    );
  }

  private requireStoredSessionClosed(
    provider: ProviderKind,
    providerSessionId: string,
    operation: "archive" | "delete" | "restore",
  ): void {
    const managed = this.sessionStore.listSessions().find(
      (state) =>
        state.session.provider === provider &&
        state.session.providerSessionId === providerSessionId,
    );
    if (!managed) {
      return;
    }
    throw new Error(
      `Close session ${managed.session.id} before attempting to ${operation} its provider history.`,
    );
  }

  getSessionSummary(sessionId: string): SessionSummary {
    const state = this.sessionStore.getSession(sessionId);
    if (!state) {
      throw new Error(`Unknown session ${sessionId}`);
    }
    return this.applyCanonicalSessionTitle(toSessionSummary(state));
  }

  async startSession(request: StartSessionRequest): Promise<StartSessionResponse> {
    this.assertAcceptingWork();
    await this.waitForStartupMaintenance();
    this.assertAcceptingWork();
    this.assertLiveSessionProviderAllowed(request);
    this.assertStructuredLiveBackendAllowed(request);
    this.assertNativeLocalServerBackendAllowed(request);
    this.assertTuiMuxBackendAllowed(request);
    if (this.shouldUseNativeLocalServerBackend(request)) {
      return this.applyCanonicalSessionTitleToResponse(
        await this.structuredProviders.startSession(request),
      );
    }
    if (this.shouldUseTuiMuxBackend(request)) {
      await assertExistingWorkingDirectory(request.cwd, "Session working directory");
      this.pruneOrphanSessions();
      return this.applyCanonicalSessionTitleToResponse(
        await this.terminals.startTuiMuxSession({
          launch: await this.nativeTuiProviders.startLaunchSpec(request),
          ...(request.attach !== undefined ? { attach: request.attach } : {}),
          ...(request.origin !== undefined ? { origin: request.origin } : {}),
        }),
      );
    }
    if (this.shouldUseNativeTuiBackend(request)) {
      await assertExistingWorkingDirectory(request.cwd, "Session working directory");
      this.pruneOrphanSessions();
      return this.applyCanonicalSessionTitleToResponse(
        await this.terminals.startNativeTuiSession({
          launch: await this.nativeTuiProviders.startLaunchSpec(request),
          ...(request.attach !== undefined ? { attach: request.attach } : {}),
          ...(request.origin !== undefined ? { origin: request.origin } : {}),
        }),
      );
    }
    return this.applyCanonicalSessionTitleToResponse(
      await this.structuredProviders.startSession(request),
    );
  }

  async resumeSession(request: ResumeSessionRequest): Promise<ResumeSessionResponse> {
    this.assertAcceptingWork();
    await this.waitForStartupMaintenance();
    this.assertAcceptingWork();
    this.assertLiveSessionProviderAllowed(request);
    this.assertStructuredLiveBackendAllowed(request);
    this.assertNativeLocalServerBackendAllowed(request);
    this.assertTuiMuxBackendAllowed(request);
    if (request.preferStoredReplay === true) {
      return this.applyCanonicalSessionTitleToResponse(
        await this.resumeStoredReplaySession(request),
      );
    }
    const releaseReservation = this.reserveLiveProviderSessionResume(request);
    try {
      if (this.shouldUseNativeLocalServerBackend(request)) {
        return this.applyCanonicalSessionTitleToResponse(
          await this.structuredProviders.resumeSession(request),
        );
      }
      if (this.shouldUseTuiMuxBackend(request)) {
        if (request.cwd) {
          await assertExistingWorkingDirectory(request.cwd, "Session working directory");
        }
        this.pruneOrphanSessions();
        const preparedResume = prepareProviderSessionResume({
          services: this,
          provider: request.provider,
          providerSessionId: request.providerSessionId,
          preferStoredReplay: request.preferStoredReplay,
          ...(request.historySourceSessionId ? { historySourceSessionId: request.historySourceSessionId } : {}),
          rehydratedSessionIds: this.nativeTuiRehydratedSessionIds,
        });
        try {
          return this.applyCanonicalSessionTitleToResponse(
            await this.terminals.startTuiMuxSession({
              launch: await this.nativeTuiProviders.resumeLaunchSpec(request),
              ...(request.attach !== undefined ? { attach: request.attach } : {}),
              providerSessionId: request.providerSessionId,
              ...(request.origin !== undefined ? { origin: request.origin } : {}),
            }),
          );
        } catch (error) {
          preparedResume.rollback();
          throw error;
        }
      }
      if (this.shouldUseNativeTuiBackend(request)) {
        if (request.cwd) {
          await assertExistingWorkingDirectory(request.cwd, "Session working directory");
        }
        this.pruneOrphanSessions();
        const preparedResume = prepareProviderSessionResume({
          services: this,
          provider: request.provider,
          providerSessionId: request.providerSessionId,
          preferStoredReplay: request.preferStoredReplay,
          ...(request.historySourceSessionId ? { historySourceSessionId: request.historySourceSessionId } : {}),
          rehydratedSessionIds: this.nativeTuiRehydratedSessionIds,
        });
        try {
          return this.applyCanonicalSessionTitleToResponse(
            await this.terminals.startNativeTuiSession({
              launch: await this.nativeTuiProviders.resumeLaunchSpec(request),
              ...(request.attach !== undefined ? { attach: request.attach } : {}),
              providerSessionId: request.providerSessionId,
              ...(request.origin !== undefined ? { origin: request.origin } : {}),
            }),
          );
        } catch (error) {
          preparedResume.rollback();
          throw error;
        }
      }
      return this.applyCanonicalSessionTitleToResponse(
        await this.structuredProviders.resumeSession(request),
      );
    } finally {
      releaseReservation();
    }
  }

  async forkSession(
    parentSessionId: string,
    request: ForkSessionRequest,
  ): Promise<ForkSessionResponse> {
    this.assertAcceptingWork();
    await this.waitForStartupMaintenance();
    this.assertAcceptingWork();
    const operationId = request.operationId.trim();
    if (!operationId) {
      throw new Error("Fork session operationId must not be empty.");
    }
    const fingerprint = JSON.stringify({
      kind: request.kind,
      workspaceMode: request.workspaceMode,
      lastTurnId: request.lastTurnId ?? null,
    });
    const operationKey = `${parentSessionId}\u0000${operationId}`;
    const now = Date.now();
    for (const [key, operation] of this.completedForkSessionOperations) {
      if (operation.expiresAt <= now) {
        this.completedForkSessionOperations.delete(key);
      }
    }
    const completed = this.completedForkSessionOperations.get(operationKey);
    if (completed) {
      if (completed.fingerprint !== fingerprint) {
        throw new Error(
          `Fork session operation ${operationId} was already used with different parameters.`,
        );
      }
      return completed.response;
    }

    const active = this.activeForkSessionOperations.get(parentSessionId);
    if (active) {
      if (active.operationId === operationId) {
        if (active.fingerprint !== fingerprint) {
          throw new Error(
            `Fork session operation ${operationId} is already running with different parameters.`,
          );
        }
        return await active.promise;
      }
      throw new Error(`A branch operation is already running for session ${parentSessionId}.`);
    }

    const parent = this.sessionStore.getSession(parentSessionId);
    if (!parent) {
      throw new Error(`Unknown parent session ${parentSessionId}.`);
    }
    const branching = parent.session.capabilities.branching;
    const supported =
      request.kind === "side"
        ? request.workspaceMode === "shared" && branching?.side === true
        : request.workspaceMode === "worktree"
          ? branching?.worktree === true
          : branching?.sameWorkspace === true;
    if (!supported) {
      throw new Error(
        `Provider ${parent.session.provider} does not support ${request.kind} with ${request.workspaceMode} workspace mode.`,
      );
    }
    const promise = (async () =>
      this.applyCanonicalSessionTitleToResponse(
        await this.structuredProviders.forkSession(
          parentSessionId,
          parent.session.provider,
          request,
        ),
      ))();
    const operation: ForkSessionOperation = { operationId, fingerprint, promise };
    this.activeForkSessionOperations.set(parentSessionId, operation);
    try {
      const response = await promise;
      this.completedForkSessionOperations.set(operationKey, {
        fingerprint,
        response,
        expiresAt: Date.now() + FORK_SESSION_OPERATION_TTL_MS,
      });
      return response;
    } finally {
      if (this.activeForkSessionOperations.get(parentSessionId) === operation) {
        this.activeForkSessionOperations.delete(parentSessionId);
      }
    }
  }

  private providerSessionResumeKey(
    provider: string,
    providerSessionId: string,
  ): string {
    return `${provider}:${providerSessionId}`;
  }

  private reserveLiveProviderSessionResume(request: ResumeSessionRequest): () => void {
    if (request.preferStoredReplay === true || !request.providerSessionId) {
      return () => undefined;
    }
    const key = this.providerSessionResumeKey(request.provider, request.providerSessionId);
    this.liveProviderSessionResumeReservations.set(
      key,
      (this.liveProviderSessionResumeReservations.get(key) ?? 0) + 1,
    );
    return () => {
      const count = this.liveProviderSessionResumeReservations.get(key) ?? 0;
      if (count <= 1) {
        this.liveProviderSessionResumeReservations.delete(key);
      } else {
        this.liveProviderSessionResumeReservations.set(key, count - 1);
      }
    };
  }

  private assertProviderSessionNotBeingLiveResumed(request: ResumeSessionRequest): void {
    if (!request.providerSessionId) {
      return;
    }
    const key = this.providerSessionResumeKey(request.provider, request.providerSessionId);
    if ((this.liveProviderSessionResumeReservations.get(key) ?? 0) > 0) {
      throw new Error(
        `Provider session ${key} is being claimed; wait for live resume to finish.`,
      );
    }
  }

  private async resumeStoredReplaySession(
    request: ResumeSessionRequest,
  ): Promise<ResumeSessionResponse> {
    this.assertProviderSessionNotBeingLiveResumed(request);
    this.pruneOrphanSessions();
    await this.ensureStoredSessionCatalogRecord(
      request.provider,
      request.providerSessionId,
    );
    const adapter = this.storedHistoryAdaptersByProvider.get(request.provider);
    if (!adapter?.resumeStoredSession && this.structuredLiveAllowedForInjectedAdapters) {
      return await this.structuredProviders.resumeSession(request);
    }
    if (!adapter?.resumeStoredSession) {
      throw new Error(`Provider ${request.provider} does not support stored history replay.`);
    }
    const response = await adapter.resumeStoredSession(request);
    this.storedReplayProviders.set(response.session.session.id, request.provider);
    if (
      request.historySourceSessionId &&
      request.historySourceSessionId !== response.session.session.id
    ) {
      this.historySnapshots.transfer(
        request.historySourceSessionId,
        response.session.session.id,
      );
      this.storedReplayProviders.delete(request.historySourceSessionId);
    }
    return response;
  }

  /**
   * Explicit lifecycle operations may legitimately target a provider session
   * that arrived after the last catalog snapshot. Resolve that race through
   * the background catalog worker, never by letting an adapter scan provider
   * storage on the daemon event loop.
   */
  private async ensureStoredSessionCatalogRecord(
    provider: ProviderKind,
    providerSessionId: string,
  ): Promise<void> {
    if (
      !this.storedSessionCatalog ||
      !isStoredSessionCatalogProvider(provider) ||
      (this.storedSessionCatalogRecords.get(provider) ?? []).some(
        (record) => record.ref.providerSessionId === providerSessionId,
      )
    ) {
      return;
    }
    await this.refreshStoredSessionsCatalog({ provider });
  }

  private assertStructuredLiveBackendAllowed(
    request: Pick<StartSessionRequest | ResumeSessionRequest, "liveBackend"> &
      Partial<Pick<ResumeSessionRequest, "preferStoredReplay">>,
  ): void {
    if (
      request.liveBackend === "structured" &&
      request.preferStoredReplay !== true &&
      !this.structuredLiveAllowedForInjectedAdapters
    ) {
      throw new Error(
        "Structured live backend is disabled outside injected test adapters. Use native_tui for running sessions.",
      );
    }
  }

  private assertNativeLocalServerBackendAllowed(
    request: Pick<StartSessionRequest | ResumeSessionRequest, "provider" | "liveBackend">,
  ): void {
    if (
      request.liveBackend === "native_local_server" &&
      !liveBackendSupportedByProvider({
        provider: request.provider,
        liveBackend: request.liveBackend,
      })
    ) {
      throw new Error(
        `Provider ${request.provider} does not support the native local-server live backend. Use the provider's advertised live backend.`,
      );
    }
  }

  private assertTuiMuxBackendAllowed(
    request: Pick<StartSessionRequest | ResumeSessionRequest, "provider" | "liveBackend">,
  ): void {
    if (
      request.liveBackend === "tui_mux" &&
      !liveBackendSupportedByProvider({
        provider: request.provider,
        liveBackend: request.liveBackend,
      })
    ) {
      throw new Error(
        `Provider ${request.provider} does not support the TUI mux backend. Use native_local_server for Codex/OpenCode running sessions.`,
      );
    }
  }

  private assertLiveSessionProviderAllowed(
    request: Pick<StartSessionRequest | ResumeSessionRequest, "provider"> &
      Partial<Pick<ResumeSessionRequest, "preferStoredReplay">>,
  ): void {
    if (
      request.preferStoredReplay === true ||
      isCoreLiveProvider(request.provider) ||
      this.structuredLiveAllowedForInjectedAdapters ||
      this.nativeTuiProviders.supports(request.provider)
    ) {
      return;
    }
    throw new Error(
      `Provider ${request.provider} is not a supported live provider. Use Codex, Claude, or OpenCode.`,
    );
  }

  private shouldUseNativeTuiBackend(
    request: Pick<StartSessionRequest | ResumeSessionRequest, "provider" | "liveBackend"> &
      Partial<Pick<ResumeSessionRequest, "preferStoredReplay">>,
  ): boolean {
    if (request.liveBackend !== undefined) {
      return request.liveBackend === "native_tui";
    }
    if (request.preferStoredReplay === true) {
      return false;
    }
    return false;
  }

  private shouldUseNativeLocalServerBackend(
    request: Pick<StartSessionRequest | ResumeSessionRequest, "provider" | "liveBackend"> &
      Partial<Pick<ResumeSessionRequest, "preferStoredReplay">>,
  ): boolean {
    if (request.liveBackend !== undefined) {
      return request.liveBackend === "native_local_server";
    }
    if (request.preferStoredReplay === true) {
      return false;
    }
    return !this.structuredLiveAllowedForInjectedAdapters && isNativeLocalServerProvider(request.provider);
  }

  private shouldUseTuiMuxBackend(
    request: Pick<StartSessionRequest | ResumeSessionRequest, "provider" | "liveBackend"> &
      Partial<Pick<ResumeSessionRequest, "preferStoredReplay">>,
  ): boolean {
    if (request.liveBackend !== undefined) {
      return request.liveBackend === "tui_mux";
    }
    if (request.preferStoredReplay === true) {
      return false;
    }
    return isTuiMuxFallbackProvider(request.provider) && this.nativeTuiProviders.supports(request.provider);
  }

  attachSession(sessionId: string, request: AttachSessionRequest): AttachSessionResponse {
    const response = this.sessionLifecycle.attachSession(sessionId, request);
    return {
      ...response,
      session: this.applyCanonicalSessionTitle(response.session),
    };
  }

  claimControl(sessionId: string, request: ClaimControlRequest): SessionSummary {
    return this.applyCanonicalSessionTitle(
      this.sessionLifecycle.claimControl(sessionId, request),
    );
  }

  releaseControl(sessionId: string, request: ReleaseControlRequest): SessionSummary {
    return this.applyCanonicalSessionTitle(
      this.sessionLifecycle.releaseControl(sessionId, request),
    );
  }

  async renameSession(sessionId: string, title: string): Promise<SessionSummary> {
    return this.applyCanonicalSessionTitle(
      await this.sessionLifecycle.renameSession(sessionId, title),
    );
  }

  async setSessionMode(sessionId: string, modeId: string): Promise<SessionSummary> {
    return this.applyCanonicalSessionTitle(
      await this.sessionLifecycle.setSessionMode(sessionId, modeId),
    );
  }

  async setSessionModel(
    sessionId: string,
    request: SetSessionModelRequest,
  ): Promise<SessionSummary> {
    return this.applyCanonicalSessionTitle(
      await this.sessionLifecycle.setSessionModel(sessionId, request),
    );
  }

  sendInput(sessionId: string, request: SessionInputRequest): void {
    this.assertAcceptingWork();
    if (
      this.terminals.handleNativeTuiInput(sessionId, request.clientId, nativeTuiInputText(request), {
        ...(request.clientMessageId !== undefined ? { clientMessageId: request.clientMessageId } : {}),
        ...(request.clientTurnId !== undefined ? { clientTurnId: request.clientTurnId } : {}),
      })
    ) {
      return;
    }
    this.requireStructuredInputControlAdapter(sessionId).sendInput(sessionId, request);
  }

  private sendStructuredInput(sessionId: string, request: SessionInputRequest): void {
    this.assertAcceptingWork();
    this.requireStructuredInputControlAdapter(sessionId).sendInput(sessionId, request);
  }

  updateQueuedInput(
    sessionId: string,
    clientMessageId: string,
    request: UpdateQueuedInputRequest,
  ): SessionSummary {
    this.assertPtyInputControl(sessionId, request.clientId);
    if (!request.text.trim()) {
      throw new Error("Queued message cannot be empty.");
    }
    if (this.terminals.hasNativeTuiSession(sessionId)) {
      if (this.terminals.updateNativeTuiQueuedInput(sessionId, clientMessageId, request.text)) {
        return this.getSessionSummary(sessionId);
      }
      throw new SessionInputQueueConflictError(
        "Queued message is no longer waiting and cannot be edited.",
      );
    }
    const adapter = this.requireStructuredInputControlAdapter(sessionId);
    if (!adapter.updateQueuedInput) {
      throw new Error(`Provider does not support queued input editing for ${sessionId}.`);
    }
    return this.applyCanonicalSessionTitle(
      adapter.updateQueuedInput(sessionId, clientMessageId, request),
    );
  }

  deleteQueuedInput(
    sessionId: string,
    clientMessageId: string,
    request: DeleteQueuedInputRequest,
  ): SessionSummary {
    this.assertPtyInputControl(sessionId, request.clientId);
    if (this.terminals.hasNativeTuiSession(sessionId)) {
      if (this.terminals.deleteNativeTuiQueuedInput(sessionId, clientMessageId)) {
        return this.getSessionSummary(sessionId);
      }
      throw new SessionInputQueueConflictError(
        "Queued message is no longer waiting and cannot be removed.",
      );
    }
    const adapter = this.requireStructuredInputControlAdapter(sessionId);
    if (!adapter.deleteQueuedInput) {
      throw new Error(`Provider does not support queued input deletion for ${sessionId}.`);
    }
    return this.applyCanonicalSessionTitle(
      adapter.deleteQueuedInput(sessionId, clientMessageId, request),
    );
  }

  reorderQueuedInput(
    sessionId: string,
    clientMessageId: string,
    request: ReorderQueuedInputRequest,
  ): SessionSummary {
    this.assertPtyInputControl(sessionId, request.clientId);
    if (this.terminals.hasNativeTuiSession(sessionId)) {
      throw new Error(`Native TUI input queues do not support reordering for ${sessionId}.`);
    }
    const adapter = this.requireStructuredInputControlAdapter(sessionId);
    if (!adapter.reorderQueuedInput) {
      throw new Error(`Provider does not support queued input reordering for ${sessionId}.`);
    }
    return this.applyCanonicalSessionTitle(
      adapter.reorderQueuedInput(sessionId, clientMessageId, request),
    );
  }

  async steerQueuedInput(
    sessionId: string,
    clientMessageId: string,
    request: SteerQueuedInputRequest,
  ): Promise<SessionSummary> {
    this.assertPtyInputControl(sessionId, request.clientId);
    if (this.terminals.hasNativeTuiSession(sessionId)) {
      throw new Error(`Native TUI input queues do not support steering for ${sessionId}.`);
    }
    const adapter = this.requireStructuredInputControlAdapter(sessionId);
    if (!adapter.steerQueuedInput) {
      throw new Error(`Provider does not support queued input steering for ${sessionId}.`);
    }
    return this.applyCanonicalSessionTitle(
      await adapter.steerQueuedInput(sessionId, clientMessageId, request),
    );
  }

  setInputQueuePolicy(
    sessionId: string,
    request: SetInputQueuePolicyRequest,
  ): SessionSummary {
    this.assertPtyInputControl(sessionId, request.clientId);
    if (this.terminals.hasNativeTuiSession(sessionId)) {
      throw new Error(`Native TUI input queues do not support queue policy changes for ${sessionId}.`);
    }
    const adapter = this.requireStructuredInputControlAdapter(sessionId);
    if (!adapter.setInputQueuePolicy) {
      throw new Error(`Provider does not support input queue policy changes for ${sessionId}.`);
    }
    return this.applyCanonicalSessionTitle(adapter.setInputQueuePolicy(sessionId, request));
  }

  interruptSession(
    sessionId: string,
    request: InterruptSessionRequest,
  ): SessionSummary {
    if (this.terminals.handleNativeTuiInterrupt(sessionId, request.clientId)) {
      return this.getSessionSummary(sessionId);
    }
    return this.applyCanonicalSessionTitle(
      this.requireStructuredInputControlAdapter(sessionId).interruptSession(sessionId, request),
    );
  }

  async closeSession(sessionId: string, request: CloseSessionRequest): Promise<void> {
    const closingState = this.sessionStore.getSession(sessionId);
    const closingProvider = closingState?.session.provider;
    const stoppedRef = stoppedSessionRef(closingState);
    await this.sessionLifecycle.closeSession(sessionId, request);
    this.conversationResourceIndexes.invalidate(sessionId);
    if (stoppedRef) {
      this.updateStoredSessionsCache(
        [
          ...this.lastDiscoveredStoredSessions.filter(
            (session) => sessionProviderKey(session) !== sessionProviderKey(stoppedRef),
          ),
          stoppedRef,
        ],
        { publish: true },
      );
    }
    if (this.storedSessionCatalog) {
      void this.refreshStoredSessionsCatalogInBackground(
        closingProvider
          ? { publish: true, provider: closingProvider }
          : { publish: true },
        "session close",
      );
    } else {
      this.refreshStoredSessionsCache(
        closingProvider
          ? { publish: true, provider: closingProvider }
          : { publish: true },
      );
    }
  }

  detachSession(sessionId: string, request: DetachSessionRequest): SessionSummary {
    return this.applyCanonicalSessionTitle(
      this.sessionLifecycle.detachSession(sessionId, request),
    );
  }

  getNativeTuiSurface(sessionId: string): NativeTuiSurfaceResponse {
    return this.terminals.getNativeTuiSurface(sessionId);
  }

  async claimNativeTuiSurface(
    sessionId: string,
    request: NativeTuiSurfaceClaimRequest,
  ): Promise<NativeTuiSurfaceResponse> {
    return await this.terminals.claimNativeTuiSurface(sessionId, request);
  }

  async releaseNativeTuiSurface(
    sessionId: string,
    request: NativeTuiSurfaceReleaseRequest,
  ): Promise<NativeTuiSurfaceResponse> {
    return await this.terminals.releaseNativeTuiSurface(sessionId, request);
  }

  async closeNativeTuiClient(
    sessionId: string,
    request: NativeTuiClientCloseRequest,
  ): Promise<NativeTuiSurfaceResponse> {
    return await this.terminals.closeNativeTuiClient(sessionId, request);
  }

  async respondToPermission(
    sessionId: string,
    requestId: string,
    response: PermissionResponseRequest,
  ): Promise<void> {
    const adapter = this.requireStructuredPermissionAdapter(sessionId);
    await adapter.respondToPermission(sessionId, requestId, response);
  }

  onPtyInput(sessionId: string, clientId: string, data: string): void {
    this.assertPtyInputControl(sessionId, clientId);
    if (this.terminals.handlePtyInput(sessionId, clientId, data)) {
      return;
    }
    this.requireStructuredInputControlAdapter(sessionId).onPtyInput(sessionId, clientId, data);
  }

  onPtyResize(sessionId: string, clientId: string, cols: number, rows: number): void {
    this.assertPtyInputControl(sessionId, clientId);
    if (this.terminals.handlePtyResize(sessionId, clientId, cols, rows)) {
      return;
    }
    this.requireStructuredInputControlAdapter(sessionId).onPtyResize(
      sessionId,
      clientId,
      cols,
      rows,
    );
  }

  private assertPtyInputControl(sessionId: string, clientId: string): void {
    if (!this.sessionStore.getSession(sessionId)) {
      return;
    }
    if (!this.sessionStore.hasInputControl(sessionId, clientId)) {
      throw new Error(`Client ${clientId} does not hold input control for ${sessionId}.`);
    }
  }

  async getWorkspaceSnapshot(sessionId: string, options?: { scopeRoot?: string }) {
    if (this.shouldUseStructuredWorkspaceInspection(sessionId)) {
      const scopeRoot = await this.workspaceScopeAuthorizer.resolveAuthorizedSessionScopeRoot(
        sessionId,
        options?.scopeRoot,
      );
      return await this.requireStructuredWorkspaceInspectionAdapter(sessionId).getWorkspaceSnapshot(
        sessionId,
        {
          ...(scopeRoot ? { scopeRoot } : {}),
        },
      );
    }
    const session = this.requireManagedSession(sessionId).session;
    const scopeRoot = await this.workspaceScopeAuthorizer.resolveAuthorizedSessionScopeRoot(
      sessionId,
      options?.scopeRoot,
    );
    const snapshot = await getWorkspaceSnapshot(scopeRoot ?? session.cwd);
    return {
      sessionId,
      cwd: snapshot.cwd,
      nodes: snapshot.nodes,
    };
  }

  async getGitStatus(
    sessionId: string,
    options?: { scopeRoot?: string; baseBranch?: string },
  ) {
    if (this.shouldUseStructuredWorkspaceInspection(sessionId)) {
      const scopeRoot = await this.workspaceScopeAuthorizer.resolveAuthorizedSessionScopeRoot(
        sessionId,
        options?.scopeRoot,
      );
      return await this.requireStructuredWorkspaceInspectionAdapter(sessionId).getGitStatus(
        sessionId,
        {
          ...(scopeRoot ? { scopeRoot } : {}),
          ...(options?.baseBranch ? { baseBranch: options.baseBranch } : {}),
        },
      );
    }
    const session = this.requireManagedSession(sessionId).session;
    const scopeRoot = await this.workspaceScopeAuthorizer.resolveAuthorizedSessionScopeRoot(
      sessionId,
      options?.scopeRoot,
    );
    const status = await getWorkspaceGitStatusAsync(session.cwd, {
      ...(scopeRoot ? { scopeRoot } : {}),
      ...(options?.baseBranch ? { baseBranch: options.baseBranch } : {}),
    });
    return {
      sessionId,
      ...(status.branch !== undefined ? { branch: status.branch } : {}),
      ...(status.baseBranch !== undefined ? { baseBranch: status.baseBranch } : {}),
      ...(status.comparisonMode !== undefined
        ? { comparisonMode: status.comparisonMode }
        : {}),
      ...(status.comparisonBase !== undefined
        ? { comparisonBase: status.comparisonBase }
        : {}),
      branchOptions: status.branchOptions ?? [],
      branchFiles: status.branchFiles ?? [],
      changedFiles: status.changedFiles,
      ...(status.stagedFiles ? { stagedFiles: status.stagedFiles } : {}),
      ...(status.unstagedFiles ? { unstagedFiles: status.unstagedFiles } : {}),
      ...(status.totalBranch !== undefined ? { totalBranch: status.totalBranch } : {}),
      ...(status.totalStaged !== undefined ? { totalStaged: status.totalStaged } : {}),
      ...(status.totalUnstaged !== undefined ? { totalUnstaged: status.totalUnstaged } : {}),
    };
  }

  async getGitDiff(
    sessionId: string,
    path: string,
    options?: {
      staged?: boolean;
      ignoreWhitespace?: boolean;
      scopeRoot?: string;
      baseBranch?: string;
    },
  ) {
    if (this.shouldUseStructuredWorkspaceInspection(sessionId)) {
      const scopeRoot = await this.workspaceScopeAuthorizer.resolveAuthorizedSessionScopeRoot(
        sessionId,
        options?.scopeRoot,
      );
      return await this.requireStructuredWorkspaceInspectionAdapter(sessionId).getGitDiff(
        sessionId,
        path,
        {
          ...(options?.staged !== undefined ? { staged: options.staged } : {}),
          ...(options?.ignoreWhitespace !== undefined
            ? { ignoreWhitespace: options.ignoreWhitespace }
            : {}),
          ...(scopeRoot ? { scopeRoot } : {}),
          ...(options?.baseBranch ? { baseBranch: options.baseBranch } : {}),
        },
      );
    }
    const session = this.requireManagedSession(sessionId).session;
    const scopeRoot = await this.workspaceScopeAuthorizer.resolveAuthorizedSessionScopeRoot(
      sessionId,
      options?.scopeRoot,
    );
    return {
      sessionId,
      path,
      diff: await getWorkspaceGitDiffAsync(session.cwd, path, {
        ...(options?.staged !== undefined ? { staged: options.staged } : {}),
        ...(options?.ignoreWhitespace !== undefined
          ? { ignoreWhitespace: options.ignoreWhitespace }
          : {}),
        ...(scopeRoot ? { scopeRoot } : {}),
        ...(options?.baseBranch ? { baseBranch: options.baseBranch } : {}),
      }),
    };
  }

  async getTurnFileChanges(sessionId: string, turnId: string) {
    const ownerId = turnArtifactOwnerKey(
      sessionId,
      this.sessionStore.getSession(sessionId)?.session,
    );
    return await this.turnArtifacts.getTurnFileChanges(ownerId, turnId, sessionId);
  }

  async getTurnFileDiff(sessionId: string, turnId: string, filePath: string) {
    const ownerId = turnArtifactOwnerKey(
      sessionId,
      this.sessionStore.getSession(sessionId)?.session,
    );
    try {
      return await this.turnArtifacts.getTurnFileDiff(
        ownerId,
        turnId,
        filePath,
        sessionId,
      );
    } catch (artifactError) {
      const restored =
        await this.storedHistoryAdapterForSession(
          sessionId,
        )?.getSessionConversationTurnFileDiff?.(sessionId, {
          providerTurnId: turnId,
          path: filePath,
        });
      if (restored) {
        return restored;
      }
      throw artifactError;
    }
  }

  private async restorePersistedTurnFileChanges(
    sessionId: string,
    turns: readonly ConversationTurnProjection[],
  ): Promise<ConversationTurnProjection[]> {
    const ownerId = turnArtifactOwnerKey(
      sessionId,
      this.sessionStore.getSession(sessionId)?.session,
    );
    return await Promise.all(turns.map(async (turn) => {
      // A provider-native per-turn summary is the protocol authority when it
      // exists (for Codex this mirrors patch_apply_end accounting). Persisted
      // RAH snapshots are the cross-restart fallback for providers or older
      // turns that do not expose that history.
      if (turn.fileChanges !== undefined) {
        return turn;
      }
      const artifactTurnIds = [
        turn.providerTurnId,
        turn.id,
      ].filter(
        (turnId, index, values): turnId is string =>
          typeof turnId === "string" && values.indexOf(turnId) === index,
      );
      for (const artifactTurnId of artifactTurnIds) {
        const persisted = await this.turnArtifacts.findTurnFileChanges(
          ownerId,
          artifactTurnId,
          sessionId,
        );
        if (persisted) {
          return {
            ...turn,
            fileChanges: persisted.fileChanges,
          };
        }
      }
      return turn;
    }));
  }

  async getWorkspaceGitStatus(dir: string, options?: { baseBranch?: string }) {
    const workspaceDir = await this.workspaceScopeAuthorizer.resolveAuthorizedWorkspaceDirectory(dir);
    return await getWorkspaceGitStatusAsync(workspaceDir, {
      scopeRoot: workspaceDir,
      ...(options?.baseBranch ? { baseBranch: options.baseBranch } : {}),
    });
  }

  async getWorkspaceGitDiff(
    dir: string,
    path: string,
    options?: { staged?: boolean; ignoreWhitespace?: boolean; baseBranch?: string },
  ) {
    const workspaceDir = await this.workspaceScopeAuthorizer.resolveAuthorizedWorkspaceDirectory(dir);
    return {
      sessionId: "",
      path,
      diff: await getWorkspaceGitDiffAsync(workspaceDir, path, {
        ...options,
        scopeRoot: workspaceDir,
      }),
    };
  }

  async applyGitFileAction(sessionId: string, request: GitFileActionRequest) {
    if (!this.shouldUseStructuredWorkspaceInspection(sessionId)) {
      const session = this.requireManagedSession(sessionId).session;
      return {
        ...(await applyWorkspaceGitFileActionAsync(session.cwd, request, {
          scopeRoot: session.rootDir ?? session.cwd,
        })),
        sessionId,
      };
    }
    const adapter = this.requireStructuredWorkspaceInspectionAdapter(sessionId);
    if (!adapter.applyGitFileAction) {
      throw new Error(`Provider ${adapter.id} does not support git file actions.`);
    }
    return await adapter.applyGitFileAction(sessionId, request);
  }

  async applyGitHunkAction(sessionId: string, request: GitHunkActionRequest) {
    if (!this.shouldUseStructuredWorkspaceInspection(sessionId)) {
      const session = this.requireManagedSession(sessionId).session;
      return {
        ...(await applyWorkspaceGitHunkActionAsync(session.cwd, request, {
          scopeRoot: session.rootDir ?? session.cwd,
        })),
        sessionId,
      };
    }
    const adapter = this.requireStructuredWorkspaceInspectionAdapter(sessionId);
    if (!adapter.applyGitHunkAction) {
      throw new Error(`Provider ${adapter.id} does not support git hunk actions.`);
    }
    return await adapter.applyGitHunkAction(sessionId, request);
  }

  async readSessionFile(
    sessionId: string,
    path: string,
    options?: { scopeRoot?: string; imagePreviewMode?: "bounded" | "full" },
  ) {
    if (this.shouldUseStructuredWorkspaceInspection(sessionId)) {
      const scopeRoot = await this.workspaceScopeAuthorizer.resolveAuthorizedSessionScopeRoot(
        sessionId,
        options?.scopeRoot,
      );
      return await this.requireStructuredWorkspaceInspectionAdapter(sessionId).readSessionFile(
        sessionId,
        path,
        {
          ...(scopeRoot ? { scopeRoot } : {}),
          ...(options?.imagePreviewMode ? { imagePreviewMode: options.imagePreviewMode } : {}),
        },
      );
    }
    const session = this.requireManagedSession(sessionId).session;
    const scopeRoot = await this.workspaceScopeAuthorizer.resolveAuthorizedSessionScopeRoot(
      sessionId,
      options?.scopeRoot,
    );
    return {
      ...(await readWorkspaceFileFromDirectoryAsync(session.cwd, path, {
        ...(scopeRoot ? { scopeRoot } : {}),
        ...(options?.imagePreviewMode ? { imagePreviewMode: options.imagePreviewMode } : {}),
      })),
      sessionId,
    };
  }

  async readWorkspaceFile(
    dir: string,
    path: string,
    options?: { imagePreviewMode?: "bounded" | "full" },
  ) {
    const workspaceDir = await this.workspaceScopeAuthorizer.resolveAuthorizedWorkspaceDirectory(dir);
    return await readWorkspaceFileFromDirectoryAsync(workspaceDir, path, {
      scopeRoot: workspaceDir,
      ...(options?.imagePreviewMode ? { imagePreviewMode: options.imagePreviewMode } : {}),
    });
  }

  async readHostFile(path: string, options?: { imagePreviewMode?: "bounded" | "full" }) {
    return {
      sessionId: "",
      ...(await readHostFileDataAsync(path, options)),
    };
  }

  async searchSessionFiles(
    sessionId: string,
    query: string,
    limit = 100,
    options?: { scopeRoot?: string },
  ): Promise<SessionFileSearchResponse> {
    const session = this.sessionStore.getSession(sessionId)?.session;
    if (!session) {
      throw new Error(`Unknown session ${sessionId}`);
    }
    const scopeRoot = await this.workspaceScopeAuthorizer.resolveAuthorizedSessionScopeRoot(
      sessionId,
      options?.scopeRoot,
    );
    return {
      sessionId,
      query,
      files: await searchWorkspaceFilesInDirectoryAsync(scopeRoot ?? session.cwd, query, limit),
    };
  }

  async searchWorkspaceFiles(dir: string, query: string, limit = 100): Promise<SessionFileSearchResponse> {
    const workspaceDir = await this.workspaceScopeAuthorizer.resolveAuthorizedWorkspaceDirectory(dir);
    return {
      sessionId: "",
      query,
      files: await searchWorkspaceFilesInDirectoryAsync(workspaceDir, query, limit),
    };
  }

  getConversationEvidencePage(
    sessionId: string,
    options?: { beforeTs?: string; cursor?: string; limit?: number; detail?: ConversationEvidenceDetailMode },
  ): ConversationEvidencePage {
    const adapter = this.storedHistoryAdapterForSession(sessionId);
    if (!adapter?.getConversationEvidencePage) {
      return { sessionId, events: [] };
    }
    const session = this.sessionStore.getSession(sessionId)?.session;
    const page = this.historySnapshots.getPage({
      sessionId,
      ...(options?.cursor ? { cursor: options.cursor } : {}),
      ...(options?.limit ? { limit: options.limit } : {}),
      loadFrozenPage: () => adapter.createFrozenHistoryPageLoader?.(sessionId),
      loadEvents: () =>
        adapter.getConversationEvidencePage!(
          sessionId,
          options?.beforeTs
            ? { beforeTs: options.beforeTs, limit: MAX_MATERIALIZED_HISTORY_EVENTS }
            : { limit: MAX_MATERIALIZED_HISTORY_EVENTS },
        ).events,
    });
    const filtered = filterCouncilManagedHistoryPage(session, page);
    if (options?.detail === "full") {
      return fullHistoryPage(filtered);
    }
    if (options?.detail === "chat") {
      return chatHistoryPage(filtered);
    }
    return summarizeHistoryPage(filtered);
  }

  async getSessionConversationTurns(
    sessionId: string,
    options?: { cursor?: string; limit?: number; liveOnly?: boolean },
  ): Promise<ConversationTurnsPageResponse> {
    const turnLimit = Math.max(1, Math.min(options?.limit ?? 20, 100));
    if (options?.liveOnly) {
      const resident = this.conversationStore.snapshot(sessionId);
      const response: ConversationTurnsPageResponse = {
        ...resident,
        turns: summarizeConversationTurnsForTransport(
          resident.turns.slice(-turnLimit),
        ),
        liveRevision: resident.liveRevision,
      };
      response.approximateBytes = approximateJsonByteLength(response);
      return response;
    }
    const historyEventLimit = Math.min(500, Math.max(100, turnLimit * 40));
    const adapter = this.storedHistoryAdapterForSession(sessionId);
    const nativeTurnPage = await adapter?.getConversationSummaryEvidencePage?.(sessionId, {
      ...(options?.cursor ? { cursor: options.cursor } : {}),
      limit: turnLimit,
    });
    const historyPage =
      nativeTurnPage ??
      this.getConversationEvidencePage(sessionId, {
        ...(options?.cursor ? { cursor: options.cursor } : {}),
        limit: historyEventLimit,
        detail: "summary",
      });
    const session = this.sessionStore.getSession(sessionId)?.session;
    const seenEventIds = new Set<string>();
    const events = historyPage.events
      .filter((event) => {
        if (event.turnId === undefined || seenEventIds.has(event.id)) {
          return false;
        }
        seenEventIds.add(event.id);
        return true;
      })
      // Stored history and the live EventBus own independent sequence spaces.
      // The history page establishes an isolated baseline projection.
      .map((event, index) => ({ ...event, seq: index + 1 }) as RahEvent);
    const projectedHistory = projectConversation(sessionId, events, {
      // Native turn pages already carry provider lifecycle. Do not close their
      // trailing in-progress turn merely because it is being viewed through a
      // stored-history projection.
      assumeSettled:
        nativeTurnPage === undefined &&
        (session?.status === "stopped" || session?.runtime?.kind === "stored_history"),
      partial: Boolean(historyPage.nextCursor ?? historyPage.nextBeforeTs),
    });
    const projection = nativeTurnPage
      ? {
          ...projectedHistory,
          turns: projectedHistory.turns.map((turn) => ({
            ...turn,
            itemsView: "summary" as const,
            ...(turn.providerTurnId !== undefined &&
            historyPage.turnProcessDetailsAvailable?.[turn.providerTurnId] !==
              undefined
              ? {
                  processDetailsAvailable:
                    historyPage.turnProcessDetailsAvailable[
                      turn.providerTurnId
                    ],
                }
              : {}),
          })),
        }
      : projectedHistory;
    // History paging may await provider I/O. Read the resident overlay only
    // after that await, and return its content plus live revision atomically.
    const liveSnapshot = options?.cursor
      ? {
          ...projection,
          liveRevision: this.conversationStore.snapshot(sessionId).liveRevision,
        }
      : this.conversationStore.overlayLiveSnapshot(projection);
    const { liveRevision, ...responseProjection } = liveSnapshot;
    const pageTurns = await this.restorePersistedTurnFileChanges(
      sessionId,
      nativeTurnPage
      ? responseProjection.turns
      : responseProjection.turns.slice(-turnLimit),
    );
    const response: ConversationTurnsPageResponse = {
      ...responseProjection,
      liveRevision,
      ...(historyPage.sourceRevision
        ? { sourceRevision: historyPage.sourceRevision }
        : {}),
      // A native page owns its cursor boundary. A live turn may be appended on
      // top of that page, so trimming it again could create a pagination gap.
      turns: summarizeConversationTurnsForTransport(pageTurns),
      ...(historyPage.nextCursor || historyPage.nextBeforeTs
        ? { nextCursor: historyPage.nextCursor ?? historyPage.nextBeforeTs }
        : {}),
    };
    response.approximateBytes = approximateJsonByteLength(response);
    return response;
  }

  async getSessionConversationSourceRevision(sessionId: string) {
    const sourceRevision =
      await this.storedHistoryAdapterForSession(
        sessionId,
      )?.getSessionConversationSourceRevision?.(sessionId);
    return {
      sessionId,
      sourceRevision: sourceRevision ?? null,
    };
  }

  async getSessionConversationVisualArtifact(
    sessionId: string,
    artifactId: string,
  ) {
    const adapter = this.storedHistoryAdapterForSession(sessionId);
    const artifact =
      await adapter?.getSessionConversationVisualArtifact?.(
        sessionId,
        artifactId,
      );
    if (!artifact) {
      throw new Error(
        `Unknown conversation visual artifact ${artifactId} for session ${sessionId}.`,
      );
    }
    return artifact;
  }

  async getSessionConversationTurnDetail(
    sessionId: string,
    options: { turnId: string; providerTurnId: string },
  ): Promise<ConversationTurnDetailResponse | undefined> {
    const adapter = this.storedHistoryAdapterForSession(sessionId);
    const nativePage = await adapter?.getSessionConversationTurnDetail?.(sessionId, {
      providerTurnId: options.providerTurnId,
    });
    if (!nativePage) {
      return undefined;
    }
    const events = nativePage.events
      .filter((event) => event.turnId !== undefined)
      .map((event, index) => ({ ...event, seq: index + 1 }) as RahEvent);
    const projection = projectConversation(sessionId, events, {
      assumeSettled: true,
      partial: true,
    });
    const projectedTurn = projection.turns.find(
      (candidate) => candidate.providerTurnId === options.providerTurnId,
    );
    if (!projectedTurn) {
      return undefined;
    }
    const [turn] = await this.restorePersistedTurnFileChanges(sessionId, [{
      ...projectedTurn,
      id: options.turnId,
      itemsView: "full" as const,
      items: projectedTurn.items.map((item) => ({ ...item, turnId: options.turnId })),
    }]);
    if (!turn) {
      return undefined;
    }
    const response: ConversationTurnDetailResponse = {
      sessionId,
      turnId: options.turnId,
      turn,
    };
    response.approximateBytes = approximateJsonByteLength(response);
    return response;
  }

  async getSessionConversationResourceIndex(
    sessionId: string,
    options?: { refresh?: boolean },
  ): Promise<ConversationResourceIndexResponse> {
    const adapter = this.storedHistoryAdapterForSession(sessionId);
    const historyRevision =
      (await adapter?.getSessionConversationSourceRevision?.(sessionId)) ??
      adapter?.createFrozenHistoryPageLoader?.(sessionId)?.boundary?.sourceRevision;
    const state = this.sessionStore.getSession(sessionId);
    const liveRevision = this.conversationStore.snapshot(sessionId).liveRevision;
    const sourceRevision = JSON.stringify({
      history: historyRevision ?? null,
      providerSessionId: state?.session.providerSessionId ?? null,
      liveRevision,
      status: state?.session.status ?? null,
      fallbackActivity:
        historyRevision === undefined
          ? state?.conversationActivityAt ?? state?.session.updatedAt ?? sessionId
          : null,
    });
    return this.conversationResourceIndexes.load({
      sessionId,
      sourceRevision,
      progressive: true,
      ...(options?.refresh ? { refresh: true } : {}),
      readTurns: (cursor) =>
        this.getSessionConversationTurns(sessionId, {
          ...(cursor ? { cursor } : {}),
          limit: 100,
        }),
      readTurnDetail: (turn) =>
        turn.providerTurnId
          ? this.getSessionConversationTurnDetail(sessionId, {
              turnId: turn.id,
              providerTurnId: turn.providerTurnId,
            })
          : Promise.resolve(undefined),
    });
  }

  async getSessionConversationItemDetail(
    sessionId: string,
    options: {
      itemId: string;
      turnId?: string;
      providerTurnId: string;
      providerItemId: string;
    },
  ): Promise<ConversationItemDetailResponse | undefined> {
    const adapter = this.storedHistoryAdapterForSession(sessionId);
    const nativePage = await adapter?.getSessionConversationItemDetail?.(sessionId, {
      providerTurnId: options.providerTurnId,
      providerItemId: options.providerItemId,
    });
    const page = nativePage ?? (() => {
      const eventsById = new Map<string, RahEvent>();
      for (const kind of ["tool_call", "observation"] as const) {
        for (const event of this.getSessionHistoryItemDetail(sessionId, {
          kind,
          itemId: options.providerItemId,
        }).events) {
          eventsById.set(event.id, event);
        }
      }
      return eventsById.size > 0
        ? { sessionId, events: [...eventsById.values()] }
        : undefined;
    })();
    if (!page) {
      return undefined;
    }
    const events = page.events
      .filter((event) => event.turnId !== undefined)
      .map((event, index) => ({ ...event, seq: index + 1 }) as RahEvent);
    const projection = projectConversation(sessionId, events, { partial: true });
    const turn = projection.turns.find(
      (candidate) => candidate.providerTurnId === options.providerTurnId,
    );
    const item = turn?.items.find(
      (candidate) =>
        candidate.id === options.itemId ||
        candidate.providerItemId === options.providerItemId,
    );
    if (!turn || !item) {
      return undefined;
    }
    const turnId = options.turnId ?? turn.id;
    const storedProcessOutput = await this.processOutputs.read(
      sessionId,
      options.providerItemId,
    );
    const hydratedItem = storedProcessOutput
      ? (() => {
          if (item.content.kind === "tool") {
            const toolCall = item.content.toolCall;
            const retainedArtifacts = (toolCall.detail?.artifacts ?? []).filter(
              (artifact) =>
                !(
                  artifact.kind === "text" &&
                  (artifact.label === "output" || artifact.label === "stdout")
                ),
            );
            return {
              ...item,
              detailAvailable: true,
              content: {
                ...item.content,
                toolCall: {
                  ...toolCall,
                  detailAvailable: true,
                  detailSizeBytes: storedProcessOutput.output.totalBytes,
                  detail: {
                    ...toolCall.detail,
                    artifacts: [
                      ...retainedArtifacts,
                      {
                        kind: "text" as const,
                        label: "output",
                        text: storedProcessOutput.text,
                      },
                    ],
                  },
                },
              },
            };
          }
          if (item.content.kind === "observation") {
            const observation = item.content.observation;
            const retainedArtifacts = (
              observation.detail?.artifacts ?? []
            ).filter(
              (artifact) =>
                !(
                  artifact.kind === "text" &&
                  (artifact.label === "output" || artifact.label === "stdout")
                ),
            );
            return {
              ...item,
              detailAvailable: true,
              content: {
                ...item.content,
                observation: {
                  ...observation,
                  detailAvailable: true,
                  detailSizeBytes: storedProcessOutput.output.totalBytes,
                  detail: {
                    ...observation.detail,
                    artifacts: [
                      ...retainedArtifacts,
                      {
                        kind: "text" as const,
                        label: "output",
                        text: storedProcessOutput.text,
                      },
                    ],
                  },
                },
              },
            };
          }
          return item;
        })()
      : item;
    const response: ConversationItemDetailResponse = {
      sessionId,
      turnId,
      itemId: options.itemId,
      item: {
        ...hydratedItem,
        id: options.itemId,
        turnId,
      },
    };
    response.approximateBytes = approximateJsonByteLength(response);
    return response;
  }

  async getSessionConversationDirectory(sessionId: string): Promise<ConversationTurnDirectoryResponse> {
    const adapter = this.storedHistoryAdapterForSession(sessionId);
    if (adapter?.getSessionConversationDirectory) {
      return adapter.getSessionConversationDirectory(sessionId);
    }
    return buildConversationTurnDirectory({
      sessionId,
      loadPage: (cursor) => this.getSessionConversationTurns(sessionId, {
        ...(cursor ? { cursor } : {}),
        limit: 100,
      }),
    });
  }

  getSessionHistoryItemDetail(
    sessionId: string,
    options: { kind: "tool_call" | "observation"; itemId: string },
  ) {
    const eventsById = new Map<string, RahEvent>();
    const matches = (event: RahEvent) =>
      historyEventMatchesItem(event, options.kind, options.itemId);
    for (const event of this.historySnapshots.findCachedEvents(sessionId, matches)) {
      eventsById.set(event.id, event);
    }
    for (const event of this.eventBus.list({ sessionIds: [sessionId] })) {
      if (matches(event)) {
        eventsById.set(event.id, event);
      }
    }
    return {
      sessionId,
      kind: options.kind,
      itemId: options.itemId,
      events: [...eventsById.values()],
    };
  }

  private storedHistoryAdapterForSession(
    sessionId: string,
  ): ProviderStoredHistoryAdapter | undefined {
    const ownerProvider =
      this.structuredSessionOwners.get(sessionId) ??
      this.storedReplayProviders.get(sessionId);
    if (ownerProvider) {
      return this.storedHistoryAdaptersByProvider.get(ownerProvider);
    }
    const session = this.sessionStore.getSession(sessionId);
    return session
      ? this.storedHistoryAdaptersByProvider.get(session.session.provider)
      : undefined;
  }

  getContextUsage(sessionId: string) {
    return this.requireManagedSession(sessionId).usage;
  }

  listScenarios(): DebugScenarioDescriptor[] {
    return this.structuredProviders.listScenarios();
  }

  startScenario(args: {
    scenarioId: string;
    attach?: AttachSessionRequest;
  }): StartSessionResponse {
    return this.structuredProviders.startScenario(args);
  }

  buildScenarioReplayScript(scenarioId: string): DebugReplayScript {
    return this.structuredProviders.buildScenarioReplayScript(scenarioId);
  }

  listEvents(filter: EventSubscriptionRequest): RahEvent[] {
    return this.eventBus.list(filter);
  }

  async listDirectory(
    rawPath: string,
  ): Promise<{ path: string; entries: Array<{ name: string; type: "file" | "directory" }> }> {
    const targetPath = resolveUserPath(rawPath || "~");
    const dir = await opendir(targetPath);
    const entries: Array<{ name: string; type: "file" | "directory" }> = [];
    for await (const entry of dir) {
      if (entry.name.startsWith(".")) continue;
      let type: "file" | "directory" = entry.isDirectory() ? "directory" : "file";
      if (entry.isSymbolicLink()) {
        try {
          const s = await stat(resolve(targetPath, entry.name));
          type = s.isDirectory() ? "directory" : "file";
        } catch {
          continue;
        }
      }
      entries.push({ name: entry.name, type });
    }
    entries.sort((a, b) => {
      if (a.type === b.type) return a.name.localeCompare(b.name);
      return a.type === "directory" ? -1 : 1;
    });
    return { path: targetPath, entries };
  }

  async ensureDirectory(rawPath: string): Promise<{ path: string }> {
    const targetPath = resolveUserPath(rawPath || "~");
    await mkdir(targetPath, { recursive: true });
    return { path: targetPath };
  }

  async startIndependentTerminal(
    request?: IndependentTerminalStartRequest,
  ): Promise<IndependentTerminalStartResponse> {
    return this.terminals.startIndependentTerminal(request);
  }

  listIndependentTerminals(request?: {
    cwd?: string;
    owner?: IndependentTerminalStartRequest["owner"];
  }): IndependentTerminalStartResponse["terminal"][] {
    return this.terminals.listIndependentTerminals(request);
  }

  async closeIndependentTerminal(id: string): Promise<void> {
    await this.terminals.closeIndependentTerminal(id);
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    this.storedReplayProviders.clear();
    if (this.providerModelCatalogRefreshTimer !== undefined) {
      clearTimeout(this.providerModelCatalogRefreshTimer);
      this.providerModelCatalogRefreshTimer = undefined;
    }
    this.conversationStore.close();
    await runShutdownStep("stored session monitor", () => this.storedSessionMonitor.shutdown());
    await runShutdownStep("stored session catalog", () => this.storedSessionCatalog?.shutdown());
    if (this.nativeTuiStoredSessionCatalog !== this.storedSessionCatalog) {
      await runShutdownStep("native TUI stored session catalog", () =>
        this.nativeTuiStoredSessionCatalog.shutdown(),
      );
    }
    await runShutdownStep("stored session catalog snapshot", () =>
      this.flushStoredSessionCatalogRecords(),
    );
    await runShutdownStep("council runtime", () => this.council.shutdown());
    await runShutdownStep("terminal sessions", () => this.terminals.shutdown());
    await Promise.all(
      [...this.shutdownAdaptersById.values()].map((adapter) =>
        runShutdownStep(`provider adapter ${adapter.id}`, () => adapter.shutdown?.()),
      ),
    );
    await runShutdownStep("turn artifact flush", () => this.turnArtifacts.flush());
    await runShutdownStep("process output flush", () => this.processOutputs.flush());
    await runShutdownStep("native local-server cleanup", async () => {
      const closedNativeServerPids = await cleanupRahNativeServerOrphans({
        includeCurrentDaemon: true,
      });
      if (closedNativeServerPids.length > 0) {
        console.warn("[rah] cleaned RAH native local-server processes during shutdown", {
          pids: closedNativeServerPids,
        });
      }
    });
    await runShutdownStep("workbench state flush", () => this.workbenchState.flush());
    await runShutdownStep("session library flush", () => this.sessionLibrary.flush());
  }

  private assertAcceptingWork(): void {
    if (this.shuttingDown) {
      throw new Error("RAH is shutting down and cannot accept new work.");
    }
  }

  private registerAdapter(adapter: ProviderAdapter): void {
    const storedHistoryCapability = hasStoredHistoryCapability(adapter)
      ? bindStoredHistoryCapability(adapter)
      : undefined;
    const structuredLifecycleCapability = hasStructuredLifecycleCapability(adapter)
      ? bindStructuredLifecycleCapability(adapter)
      : undefined;
    const structuredInputCapability = hasStructuredInputControlCapability(adapter)
      ? bindStructuredInputControlCapability(adapter)
      : undefined;
    const structuredPermissionCapability = hasStructuredPermissionCapability(adapter)
      ? bindStructuredPermissionCapability(adapter)
      : undefined;
    const workspaceInspectionCapability = hasWorkspaceInspectionCapability(adapter)
      ? bindWorkspaceInspectionCapability(adapter)
      : undefined;
    const enhancedModeCapability = hasEnhancedModeCapability(adapter)
      ? bindEnhancedModeCapability(adapter)
      : undefined;
    const enhancedModelCapability = hasEnhancedModelCapability(adapter)
      ? bindEnhancedModelCapability(adapter)
      : undefined;
    const actionCapability = hasActionCapability(adapter)
      ? bindActionCapability(adapter)
      : undefined;
    const diagnosticCapability = hasDiagnosticCapability(adapter)
      ? bindDiagnosticCapability(adapter)
      : undefined;
    const debugCapability = hasDebugCapability(adapter)
      ? bindDebugCapability(adapter)
      : undefined;
    const shutdownCapability = hasShutdownCapability(adapter)
      ? bindShutdownCapability(adapter)
      : undefined;
    if (debugCapability) {
      this.debugAdaptersById.set(debugCapability.id, debugCapability);
    }
    if (shutdownCapability) {
      this.shutdownAdaptersById.set(shutdownCapability.id, shutdownCapability);
    }
    for (const provider of adapter.providers) {
      if (structuredLifecycleCapability) {
        this.structuredLiveAdaptersByProvider.set(provider, structuredLifecycleCapability);
      }
      if (structuredInputCapability) {
        this.structuredInputAdaptersByProvider.set(provider, structuredInputCapability);
      }
      if (structuredPermissionCapability) {
        this.structuredPermissionAdaptersByProvider.set(provider, structuredPermissionCapability);
      }
      if (workspaceInspectionCapability) {
        this.workspaceInspectionAdaptersByProvider.set(provider, workspaceInspectionCapability);
      }
      if (enhancedModeCapability) {
        this.modeAdaptersByProvider.set(provider, enhancedModeCapability);
      }
      if (enhancedModelCapability) {
        this.modelAdaptersByProvider.set(provider, enhancedModelCapability);
      }
      if (actionCapability) {
        this.actionAdaptersByProvider.set(provider, actionCapability);
      }
      if (diagnosticCapability) {
        this.diagnosticAdaptersByProvider.set(provider, diagnosticCapability);
      }
      if (storedHistoryCapability) {
        this.storedHistoryAdaptersByProvider.set(provider, storedHistoryCapability);
      }
    }
    if (storedHistoryCapability) {
      this.historyMirrorAdapters.push(storedHistoryCapability);
    }
  }

  private rememberStructuredSessionOwner(
    sessionId: string,
    provider: StructuredSessionOwnerProvider,
  ): void {
    this.structuredSessionOwners.set(sessionId, provider);
  }

  private currentWorkbenchSessions(
    options?: { storedSessionsMode?: StoredSessionsResponseMode },
  ): ListSessionsResponse {
    this.refreshRememberedState();
    return this.listSessions(options);
  }

  private discoverStoredSessions(): StoredSessionRef[] {
    return discoverRuntimeStoredSessions(this.historyMirrorAdapters);
  }

  private discoverStoredSessionsForProvider(provider: ProviderKind): StoredSessionRef[] {
    const adapter = this.storedHistoryAdaptersByProvider.get(provider);
    if (!adapter) {
      return [];
    }
    return discoverRuntimeStoredSessions([adapter]).filter(
      (session) => session.provider === provider,
    );
  }

  getStoredSessionsDelta(sinceRevision: number): StoredSessionsDeltaResponse {
    const fromRevision = Number.isInteger(sinceRevision) && sinceRevision >= 0
      ? sinceRevision
      : 0;
    const currentRevision = this.storedSessionDiscoveryVersion;
    if (fromRevision === currentRevision) {
      return {
        fromRevision,
        revision: currentRevision,
        upsert: [],
        remove: [],
      };
    }
    const earliestRevision = this.storedSessionDiscoveryChanges[0]?.revision ?? currentRevision;
    if (fromRevision < earliestRevision - 1) {
      return {
        fromRevision,
        revision: currentRevision,
        upsert: [],
        remove: [],
        resetRequired: true,
      };
    }
    const changes = this.storedSessionDiscoveryChanges.filter(
      (change) => change.revision > fromRevision,
    );
    if (changes.some((change) => change.resetRequired)) {
      return {
        fromRevision,
        revision: currentRevision,
        upsert: [],
        remove: [],
        resetRequired: true,
      };
    }
    const removeByKey = new Map<string, StoredSessionIdentity>();
    const upsertByKey = new Map<string, StoredSessionRef>();
    for (const change of changes) {
      for (const removed of change.remove) {
        const key = sessionProviderKey(removed);
        upsertByKey.delete(key);
        removeByKey.set(key, removed);
      }
      for (const session of change.upsert) {
        const key = sessionProviderKey(session);
        removeByKey.delete(key);
        upsertByKey.set(key, session);
      }
    }
    return {
      fromRevision,
      revision: currentRevision,
      upsert: [...upsertByKey.values()],
      remove: [...removeByKey.values()],
    };
  }

  private refreshStoredSessionsCache(options?: { publish?: boolean; provider?: ProviderKind }): void {
    const next = options?.provider
      ? [
          ...this.lastDiscoveredStoredSessions.filter(
            (session) => session.provider !== options.provider,
          ),
          ...this.discoverStoredSessionsForProvider(options.provider),
        ]
      : this.discoverStoredSessions();
    this.updateStoredSessionsCache(next, { publish: options?.publish ?? false });
  }

  private async refreshStoredSessionsCatalogInBackground(
    options: { publish?: boolean; provider?: ProviderKind },
    reason: string,
  ): Promise<void> {
    try {
      await this.refreshStoredSessionsCatalog(options);
    } catch (error) {
      if (this.shuttingDown) {
        return;
      }
      console.warn("[rah] background stored-session catalog refresh failed", {
        reason,
        ...(options.provider ? { provider: options.provider } : {}),
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async refreshNativeTuiHistoryCatalog(
    provider: StoredSessionCatalogProvider,
  ): Promise<void> {
    if (this.nativeTuiStoredSessionCatalog === this.storedSessionCatalog) {
      await this.refreshStoredSessionsCatalog({ publish: true, provider });
      return;
    }
    const results = await this.nativeTuiStoredSessionCatalog.refresh(provider);
    for (const result of results) {
      if (!result.records) {
        console.warn("[rah] native TUI history catalog refresh failed", {
          provider: result.provider,
          error: result.error ?? "unknown error",
        });
        continue;
      }
      const current = this.nativeTuiHistoryCatalog.list(result.provider);
      const records = reconcileStoredSessionCatalogRecords({
        current,
        incoming: result.records,
        complete: result.complete === true,
      });
      this.nativeTuiHistoryCatalog.replaceProvider(result.provider, records);
      if (result.complete !== true) {
        console.warn("[rah] native TUI history catalog scan was incomplete", {
          provider: result.provider,
          discovered: result.records.length,
          previous: current.length,
          ...(result.error ? { error: result.error } : {}),
        });
      }
    }
  }

  private async refreshNativeTuiHistoryCatalogInBackground(
    provider: StoredSessionCatalogProvider,
    reason: string,
  ): Promise<void> {
    try {
      await this.refreshNativeTuiHistoryCatalog(provider);
    } catch (error) {
      if (this.shuttingDown) {
        return;
      }
      console.warn("[rah] background native TUI history catalog refresh failed", {
        reason,
        provider,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private scheduleProviderModelCatalogRefresh(delayMs: number): void {
    if (this.shuttingDown || this.providerModelCatalogRefreshTimer !== undefined) {
      return;
    }
    this.providerModelCatalogRefreshTimer = setTimeout(() => {
      this.providerModelCatalogRefreshTimer = undefined;
      void this.refreshProviderModelCatalogsInBackground().finally(() => {
        this.scheduleProviderModelCatalogRefresh(PROVIDER_MODEL_CATALOG_REFRESH_INTERVAL_MS);
      });
    }, delayMs);
    this.providerModelCatalogRefreshTimer.unref?.();
  }

  private async refreshProviderModelCatalogsInBackground(): Promise<void> {
    const snapshot = this.workbenchState.snapshot();
    const cwd = snapshot.activeWorkspaceDir ?? snapshot.workspaces[0];
    const providers = (["codex", "claude", "opencode"] as const).filter((provider) =>
      this.modelAdaptersByProvider.has(provider),
    );
    const results = await Promise.allSettled(
      providers.map((provider) =>
        this.listProviderModels(provider, {
          ...(cwd ? { cwd } : {}),
          forceRefresh: true,
        }),
      ),
    );
    if (this.shuttingDown) {
      return;
    }
    for (let index = 0; index < results.length; index += 1) {
      const result = results[index];
      if (result?.status !== "rejected") {
        continue;
      }
      console.warn("[rah] background provider model refresh failed", {
        provider: providers[index],
        error: result.reason instanceof Error ? result.reason.message : String(result.reason),
      });
    }
  }

  private hydrateStoredSessionCatalog(records: readonly StoredSessionCatalogRecord[]): void {
    if (records.length === 0) {
      return;
    }
    for (const adapter of this.storedHistoryAdaptersByProvider.values()) {
      adapter.hydrateStoredSessionsCatalog?.(records);
    }
  }

  private replaceStoredSessionCatalogRecords(
    records: readonly StoredSessionCatalogRecord[],
  ): void {
    this.storedSessionCatalogRecords.clear();
    for (const provider of ["codex", "claude", "opencode"] as const) {
      this.storedSessionCatalogRecords.set(
        provider,
        records.filter((record) => record.ref.provider === provider),
      );
    }
    this.nativeTuiHistoryCatalog.replace(records);
  }

  private persistStoredSessionCatalogRecords(): void {
    this.pendingStoredSessionCatalogSnapshot = [
      ...this.storedSessionCatalogRecords.values(),
    ].flat();
    if (this.storedSessionCatalogPersistTask) {
      return;
    }
    this.storedSessionCatalogPersistError = undefined;
    const task = this.drainStoredSessionCatalogSnapshots()
      .catch((error) => {
        this.storedSessionCatalogPersistError = error;
        console.warn("[rah] stored-session catalog snapshot persist failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        if (this.storedSessionCatalogPersistTask === task) {
          this.storedSessionCatalogPersistTask = undefined;
        }
        if (this.pendingStoredSessionCatalogSnapshot) {
          this.persistStoredSessionCatalogRecords();
        }
      });
    this.storedSessionCatalogPersistTask = task;
  }

  private async drainStoredSessionCatalogSnapshots(): Promise<void> {
    while (this.pendingStoredSessionCatalogSnapshot) {
      const snapshot = this.pendingStoredSessionCatalogSnapshot;
      this.pendingStoredSessionCatalogSnapshot = undefined;
      await writeStoredSessionCatalogSnapshot(snapshot);
    }
  }

  private async flushStoredSessionCatalogRecords(): Promise<void> {
    if (
      this.pendingStoredSessionCatalogSnapshot &&
      !this.storedSessionCatalogPersistTask
    ) {
      this.persistStoredSessionCatalogRecords();
    }
    while (this.storedSessionCatalogPersistTask) {
      await this.storedSessionCatalogPersistTask;
    }
    if (this.storedSessionCatalogPersistError) {
      throw this.storedSessionCatalogPersistError;
    }
  }

  private removeStoredSessionCatalogRecord(
    identity: StoredSessionIdentity,
    options?: { persist?: boolean },
  ): void {
    if (!isStoredSessionCatalogProvider(identity.provider)) {
      return;
    }
    const records = this.storedSessionCatalogRecords.get(identity.provider) ?? [];
    const nextRecords = records.filter(
      (record) => record.ref.providerSessionId !== identity.providerSessionId,
    );
    this.storedSessionCatalogRecords.set(identity.provider, nextRecords);
    this.nativeTuiHistoryCatalog.replaceProvider(identity.provider, nextRecords);
    if (options?.persist ?? true) {
      this.persistStoredSessionCatalogRecords();
    }
  }

  private applyStoredSessionCatalogResults(
    results: readonly StoredSessionCatalogProviderResult[],
    options?: { publish?: boolean },
  ): void {
    let next = [...this.lastDiscoveredStoredSessions];
    let changedProvider = false;
    for (const result of results) {
      if (!result.records) {
        console.warn("[rah] stored-session catalog refresh failed", {
          provider: result.provider,
          error: result.error ?? "unknown error",
        });
        continue;
      }
      if (result.complete !== true) {
        console.warn("[rah] stored-session catalog scan was incomplete; preserving missing rows", {
          provider: result.provider,
          discovered: result.records.length,
          previous: this.storedSessionCatalogRecords.get(result.provider)?.length ?? 0,
          ...(result.error ? { error: result.error } : {}),
        });
      }
      const providerRecords = reconcileStoredSessionCatalogRecords({
        current: this.storedSessionCatalogRecords.get(result.provider) ?? [],
        incoming: result.records,
        complete: result.complete === true,
      });
      changedProvider = true;
      this.storedSessionCatalogRecords.set(result.provider, providerRecords);
      this.nativeTuiHistoryCatalog.replaceProvider(
        result.provider,
        providerRecords,
      );
      this.storedHistoryAdaptersByProvider
        .get(result.provider)
        ?.hydrateStoredSessionsCatalog?.(providerRecords);
      next = [
        ...next.filter((session) => session.provider !== result.provider),
        ...providerRecords.map((record) => record.ref),
      ];
    }
    if (changedProvider) {
      this.persistStoredSessionCatalogRecords();
      this.updateStoredSessionsCache(next, { publish: options?.publish ?? false });
    }
  }

  private updateStoredSessionsCache(
    next: readonly StoredSessionRef[],
    options?: {
      publish?: boolean;
      resetRequired?: boolean;
      extraRemove?: readonly StoredSessionIdentity[];
    },
  ): void {
    const projectedNext = this.sessionLibrary.project(next);
    if (
      this.sameStoredSessionRefs(this.lastDiscoveredStoredSessions, projectedNext) &&
      !options?.resetRequired &&
      (!options?.extraRemove || options.extraRemove.length === 0)
    ) {
      return;
    }
    const change = this.buildStoredSessionsDiscoveryChange(this.lastDiscoveredStoredSessions, projectedNext, {
      resetRequired: options?.resetRequired ?? false,
      extraRemove: options?.extraRemove ?? [],
    });
    this.lastDiscoveredStoredSessions = [...projectedNext];
    this.rememberStoredSessionDiscoveryChange(change);
    if (options?.publish) {
      this.publishStoredSessionDiscovery(change);
    }
  }

  private rememberStoredSessionDiscoveryChange(change: StoredSessionDiscoveryChange): void {
    this.storedSessionDiscoveryChanges.push(change);
    if (this.storedSessionDiscoveryChanges.length > STORED_SESSION_DELTA_LOG_LIMIT) {
      this.storedSessionDiscoveryChanges.splice(
        0,
        this.storedSessionDiscoveryChanges.length - STORED_SESSION_DELTA_LOG_LIMIT,
      );
    }
  }

  private buildStoredSessionsDiscoveryChange(
    previous: readonly StoredSessionRef[],
    next: readonly StoredSessionRef[],
    options?: { resetRequired?: boolean; extraRemove?: readonly StoredSessionIdentity[] },
  ): StoredSessionDiscoveryChange {
    const previousByKey = new Map(previous.map((session) => [sessionProviderKey(session), session] as const));
    const nextByKey = new Map(next.map((session) => [sessionProviderKey(session), session] as const));
    const remove: StoredSessionIdentity[] = [];
    const upsert: StoredSessionRef[] = [];
    for (const [key, previousSession] of previousByKey) {
      if (!nextByKey.has(key)) {
        remove.push({
          provider: previousSession.provider,
          providerSessionId: previousSession.providerSessionId,
        });
      }
    }
    const removeKeys = new Set(remove.map(sessionProviderKey));
    for (const removed of options?.extraRemove ?? []) {
      const key = sessionProviderKey(removed);
      if (!removeKeys.has(key)) {
        remove.push(removed);
        removeKeys.add(key);
      }
    }
    for (const [key, nextSession] of nextByKey) {
      const previousSession = previousByKey.get(key);
      if (!previousSession || storedSessionRefKey(previousSession) !== storedSessionRefKey(nextSession)) {
        upsert.push(this.applyCanonicalStoredSessionTitle(nextSession));
      }
    }
    return {
      revision: ++this.storedSessionDiscoveryVersion,
      upsert,
      remove,
      ...(options?.resetRequired ? { resetRequired: true } : {}),
    };
  }

  private sameStoredSessionRefs(
    left: readonly StoredSessionRef[],
    right: readonly StoredSessionRef[],
  ): boolean {
    return sameStoredSessionRefs(left, right);
  }

  private publishStoredSessionDiscovery(change?: StoredSessionDiscoveryChange): void {
    this.eventBus.publish({
      sessionId: "workbench:stored-sessions",
      type: "session.discovery",
      source: SYSTEM_SOURCE,
      payload: {
        version: this.storedSessionDiscoveryVersion,
        workbench: {
          pinnedSidebarItems: this.rememberedPinnedSidebarItems.map((item) => ({ ...item })),
        },
        ...(change
          ? {
              storedSessions: {
                revision: change.revision,
                upsert: change.upsert,
                remove: change.remove,
                ...(change.resetRequired ? { resetRequired: true } : {}),
              },
            }
          : {}),
      },
    });
  }

  private publishStoredSessionDiscoveryUpsert(identity: StoredSessionIdentity): void {
    const session = this.findStoredSessionRefForIdentity(identity);
    if (!session) {
      this.publishStoredSessionDiscoveryReset();
      return;
    }
    const change: StoredSessionDiscoveryChange = {
      revision: ++this.storedSessionDiscoveryVersion,
      upsert: [session],
      remove: [],
    };
    this.rememberStoredSessionDiscoveryChange(change);
    this.publishStoredSessionDiscovery(change);
  }

  private publishStoredSessionDiscoveryReset(): void {
    const change = this.buildStoredSessionsDiscoveryChange(
      this.lastDiscoveredStoredSessions,
      this.lastDiscoveredStoredSessions,
      { resetRequired: true },
    );
    this.rememberStoredSessionDiscoveryChange(change);
    this.publishStoredSessionDiscovery(change);
  }

  private findStoredSessionRefForIdentity(identity: StoredSessionIdentity): StoredSessionRef | undefined {
    const response = this.buildSessionsResponse(
      this.sessionStore.listSessions(),
      this.lastDiscoveredStoredSessions,
      { storedSessionsMode: "all" },
    );
    return [...response.storedSessions, ...response.recentSessions].find(
      (session) =>
        session.provider === identity.provider &&
        session.providerSessionId === identity.providerSessionId,
    );
  }

  private applyCanonicalSessionTitle(summary: SessionSummary): SessionSummary {
    const title = resolveCanonicalSessionTitle(summary.session, {
      titleOverrides: this.rememberedSessionTitleOverrides,
      discoveredStoredSessions: this.lastDiscoveredStoredSessions,
    });
    if (!title || title === summary.session.title) {
      return summary;
    }

    const current = this.sessionStore.getSession(summary.session.id);
    if (
      current &&
      current.session.provider === summary.session.provider &&
      current.session.providerSessionId === summary.session.providerSessionId
    ) {
      return toSessionSummary(
        this.sessionStore.patchManagedSession(summary.session.id, { title }),
      );
    }

    return applyCanonicalTitleToSessionSummary(summary, {
      titleOverrides: this.rememberedSessionTitleOverrides,
      discoveredStoredSessions: this.lastDiscoveredStoredSessions,
    });
  }

  private applyCanonicalSessionTitleToResponse<T extends { session: SessionSummary }>(
    response: T,
  ): T {
    return {
      ...response,
      session: this.applyCanonicalSessionTitle(response.session),
    };
  }

  private applyCanonicalStoredSessionTitle(session: StoredSessionRef): StoredSessionRef {
    return applyCanonicalTitleToStoredSession(session, {
      titleOverrides: this.rememberedSessionTitleOverrides,
      discoveredStoredSessions: this.lastDiscoveredStoredSessions,
    });
  }

  private buildSessionsResponse(
    liveStates: readonly StoredSessionState[],
    discoveredStoredSessions: readonly StoredSessionRef[],
    options?: { storedSessionsMode?: StoredSessionsResponseMode },
  ): ListSessionsResponse {
    const eventSeq = this.eventBus.newestSeq();
    const councilProviderSessionKeys = new Set(
      this.council.listCouncils().councils.flatMap((council) =>
        council.agents.flatMap((agent) =>
          (agent.providerSessionIds ?? []).map(
            (providerSessionId) => `${agent.provider}:${providerSessionId}`,
          ),
        ),
      ),
    );
    for (const state of liveStates) {
      if (state.session.origin?.kind === "council" && state.session.providerSessionId) {
        councilProviderSessionKeys.add(
          `${state.session.provider}:${state.session.providerSessionId}`,
        );
      }
    }
    return {
      ...buildRuntimeSessionsResponse({
        liveStates,
        discoveredStoredSessions,
        remembered: {
          rememberedSessions: this.rememberedSessions,
          rememberedRecentSessions: this.rememberedRecentSessions,
          rememberedWorkspaceDirs: this.rememberedWorkspaceDirs,
          rememberedHiddenWorkspaces: this.rememberedHiddenWorkspaces,
          ...(this.rememberedActiveWorkspaceDir
            ? { rememberedActiveWorkspaceDir: this.rememberedActiveWorkspaceDir }
            : {}),
          rememberedHiddenSessionKeys: this.rememberedHiddenSessionKeys,
          rememberedSessionTitleOverrides: this.rememberedSessionTitleOverrides,
          rememberedPinnedSidebarItems: this.rememberedPinnedSidebarItems,
        },
        isClosingSession: (sessionId) => this.orphanSessionCleanupInFlight.has(sessionId),
        excludedProviderSessionKeys: councilProviderSessionKeys,
        ...(options?.storedSessionsMode ? { storedSessionsMode: options.storedSessionsMode } : {}),
      }),
      ...(eventSeq !== null ? { eventSeq } : {}),
      storedSessionsRevision: this.storedSessionDiscoveryVersion,
    };
  }

  private refreshRememberedState(): void {
    const refreshed = this.workbenchState.snapshot();
    this.rememberedSessions = refreshed.sessions;
    this.rememberedRecentSessions = refreshed.recentSessions;
    this.rememberedWorkspaceDirs = refreshed.workspaces;
    this.rememberedHiddenWorkspaces = refreshed.hiddenWorkspaces;
    this.rememberedActiveWorkspaceDir = refreshed.activeWorkspaceDir;
    this.rememberedHiddenSessionKeys = refreshed.hiddenSessionKeys;
    this.rememberedSessionTitleOverrides = refreshed.sessionTitleOverrides;
    this.rememberedPinnedSidebarItems = refreshed.pinnedSidebarItems;
  }

  private async primeWorkbenchDirectoryIdentities(
    extraDirectories: readonly (string | undefined)[] = [],
  ): Promise<void> {
    await primeCanonicalDirectoryKeys([
      ...this.rememberedWorkspaceDirs,
      ...this.rememberedHiddenWorkspaces,
      this.rememberedActiveWorkspaceDir,
      ...this.sessionStore.listSessions().flatMap((state) => [
        state.session.rootDir,
        state.session.cwd,
      ]),
      ...extraDirectories,
    ]);
  }

  private pruneOrphanSessions(): void {
    for (const state of [...this.sessionStore.listSessions()]) {
      if (state.clients.length > 0) {
        continue;
      }
      if (this.terminals.hasNativeTuiSession(state.session.id)) {
        continue;
      }
      if (this.orphanSessionCleanupInFlight.has(state.session.id)) {
        continue;
      }
      const provider = this.resolveStructuredSessionOwnerProvider(state.session.id);
      const adapter = this.structuredLiveAdaptersByProvider.get(provider);
      if (!adapter || typeof adapter.destroySession !== "function") {
        continue;
      }
      this.orphanSessionCleanupInFlight.add(state.session.id);
      void Promise.resolve(adapter.destroySession(state.session.id))
        .then(() => {
          this.sessionStore.removeSession(state.session.id);
          this.ptyHub.removeSession(state.session.id);
          this.structuredSessionOwners.delete(state.session.id);
          this.terminals.clearSessionState(state.session.id);
          this.eventBus.publish({
            sessionId: state.session.id,
            type: "session.closed",
            source: SYSTEM_SOURCE,
            payload: {},
          });
        })
        .catch((error: unknown) => {
          console.error(
            `[rah] destroySession failed for ${state.session.id}:`,
            error instanceof Error ? error.message : String(error),
          );
        })
        .finally(() => {
          this.orphanSessionCleanupInFlight.delete(state.session.id);
        });
    }
  }

  private async closeCouncilManagedSession(sessionId: string): Promise<void> {
    const state = this.sessionStore.getSession(sessionId);
    if (!state) {
      return;
    }
    this.workbenchState.rememberSession(state);
    this.refreshRememberedState();
    const closedNativeTui = await this.terminals.closeNativeTuiSession(sessionId);
    if (!closedNativeTui) {
      await this.terminals.closeNativeLocalServerTuiClient(sessionId).catch(() => false);
      const adapter = this.requireStructuredLifecycleAdapter(sessionId);
      if (typeof adapter.destroySession !== "function") {
        throw new Error(`Provider ${state.session.provider} cannot destroy session ${sessionId}.`);
      }
      await Promise.resolve(adapter.destroySession(sessionId));
    }
    this.sessionStore.removeSession(sessionId);
    this.ptyHub.removeSession(sessionId);
    this.historySnapshots.clear(sessionId);
    this.storedReplayProviders.delete(sessionId);
    this.structuredSessionOwners.delete(sessionId);
    this.terminals.clearSessionState(sessionId);
    this.eventBus.publish({
      sessionId,
      type: "session.closed",
      source: SYSTEM_SOURCE,
      payload: {
        clientId: "rah-council",
      },
    });
  }

  private requireManagedSession(sessionId: string): StoredSessionState {
    const state = this.sessionStore.getSession(sessionId);
    if (!state) {
      throw new Error(`Unknown session ${sessionId}`);
    }
    return state;
  }

  private shouldUseStructuredWorkspaceInspection(sessionId: string): boolean {
    return this.sessionStore.getSession(sessionId)?.session.provider === "custom";
  }

  private requireStructuredInputControlAdapter(
    sessionId: string,
  ): ProviderCapabilityView<ProviderStructuredInputControlAdapter> {
    const provider = this.resolveStructuredSessionOwnerProvider(sessionId);
    const adapter = this.structuredInputAdaptersByProvider.get(provider);
    if (
      !adapter ||
      typeof adapter.sendInput !== "function" ||
      typeof adapter.interruptSession !== "function" ||
      typeof adapter.onPtyInput !== "function" ||
      typeof adapter.onPtyResize !== "function"
    ) {
      throw new Error(`Provider ${provider} does not support structured input control.`);
    }
    return adapter;
  }

  private requireStructuredWorkspaceInspectionAdapter(
    sessionId: string,
  ): ProviderCapabilityView<ProviderWorkspaceInspectionAdapter> {
    const provider = this.resolveStructuredSessionOwnerProvider(sessionId);
    const adapter = this.workspaceInspectionAdaptersByProvider.get(provider);
    if (
      !adapter ||
      typeof adapter.getWorkspaceSnapshot !== "function" ||
      typeof adapter.getGitStatus !== "function" ||
      typeof adapter.getGitDiff !== "function" ||
      typeof adapter.readSessionFile !== "function"
    ) {
      throw new Error(`Provider ${provider} does not support workspace inspection.`);
    }
    return adapter;
  }

  private requireStructuredLifecycleAdapter(
    sessionId: string,
  ): ProviderCapabilityView<ProviderStructuredLifecycleAdapter> {
    const provider = this.resolveStructuredSessionOwnerProvider(sessionId);
    const adapter = this.structuredLiveAdaptersByProvider.get(provider);
    if (!adapter) {
      throw new Error(`Provider ${provider} does not support structured lifecycle.`);
    }
    return adapter;
  }

  private requireActionCapabilityAdapter(
    sessionId: string,
  ): ProviderCapabilityView<ProviderActionCapabilityAdapter> {
    const state = this.requireManagedSession(sessionId);
    const adapter = this.actionAdaptersByProvider.get(state.session.provider);
    if (!adapter) {
      throw new Error(`Provider ${state.session.provider} does not support action controls.`);
    }
    return adapter;
  }

  private requireEnhancedModeAdapter(
    sessionId: string,
  ): ProviderCapabilityView<ProviderEnhancedModeAdapter> {
    const state = this.requireManagedSession(sessionId);
    const adapter = this.modeAdaptersByProvider.get(state.session.provider);
    if (!adapter) {
      throw new Error(`Provider ${state.session.provider} does not support mode controls.`);
    }
    return adapter;
  }

  private requireEnhancedModelAdapter(
    sessionId: string,
  ): ProviderCapabilityView<ProviderEnhancedModelAdapter> {
    const state = this.requireManagedSession(sessionId);
    const adapter = this.modelAdaptersByProvider.get(state.session.provider);
    if (!adapter) {
      throw new Error(`Provider ${state.session.provider} does not support model controls.`);
    }
    return adapter;
  }

  private requireStructuredPermissionAdapter(
    sessionId: string,
  ): ProviderCapabilityView<Required<ProviderStructuredPermissionAdapter>> {
    const provider = this.resolveStructuredSessionOwnerProvider(sessionId);
    const adapter = this.structuredPermissionAdaptersByProvider.get(provider);
    if (!adapter) {
      throw new Error(`Provider ${provider} does not support structured permission responses.`);
    }
    return adapter;
  }

  private resolveStructuredSessionOwnerProvider(
    sessionId: string,
  ): StructuredSessionOwnerProvider {
    const ownerProvider = this.structuredSessionOwners.get(sessionId);
    if (ownerProvider) {
      return ownerProvider;
    }
    const state = this.sessionStore.getSession(sessionId);
    if (!state) {
      throw new Error(`Unknown session ${sessionId}`);
    }
    this.structuredSessionOwners.set(sessionId, state.session.provider);
    return state.session.provider;
  }
}

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
  DeleteManualProviderModelOptionResponse,
  DeleteManualProviderModelResponse,
  DebugScenarioDescriptor,
  DebugReplayScript,
  EventSubscriptionRequest,
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
  ResumeSessionRequest,
  ResumeSessionResponse,
  SetSessionModelRequest,
  SessionFileSearchResponse,
  SessionHistoryDetailMode,
  SessionHistoryPageResponse,
  SessionInputRequest,
  SessionSummary,
  StartSessionRequest,
  StartSessionResponse,
  StoredSessionIdentity,
  StoredSessionRef,
  StoredSessionsDeltaResponse,
  TuiMuxSessionDiagnostic,
} from "@rah/runtime-protocol";
import {
  isCoreLiveProvider,
  isNativeLocalServerProvider,
  isTuiMuxFallbackProvider,
  liveBackendSupportedByProvider,
} from "@rah/runtime-protocol";
import { createDefaultProviderAdapters } from "./default-provider-adapters";
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
import { RuntimeStructuredProviderCoordinator } from "./provider-control/runtime-structured-provider-coordinator";
import { SessionStore, toSessionSummary, type StoredSessionState } from "./session-store";
import {
  buildSessionsResponse as buildRuntimeSessionsResponse,
  discoverStoredSessions as discoverRuntimeStoredSessions,
  sameStoredSessionRefs,
  sessionProviderKey,
  storedSessionRefKey,
  type StoredSessionsResponseMode,
} from "./runtime-session-list";
import { StoredSessionMonitor } from "./stored-session-monitor";
import { RuntimeTerminalCoordinator } from "./runtime-terminal-coordinator";
import { RuntimeSessionLifecycle } from "./runtime-session-lifecycle";
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
import { WorkbenchStateStore } from "./workbench-state";
import {
  findOwningWorkspaceDirectory,
  isReadOnlyReplaySession,
  normalizeDirectory,
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

type StructuredSessionOwnerProvider = StoredSessionState["session"]["provider"];

type StoredSessionDiscoveryChange = {
  revision: number;
  upsert: StoredSessionRef[];
  remove: StoredSessionIdentity[];
  resetRequired?: boolean;
};

function filterCouncilManagedHistoryPage(
  session: ManagedSession | undefined,
  page: SessionHistoryPageResponse,
): SessionHistoryPageResponse {
  if (session?.origin?.kind !== "council") {
    return page;
  }
  return {
    ...page,
    events: page.events.filter((event) => !shouldSuppressCouncilManagedHistoryEvent(event)),
  };
}

const SHUTDOWN_STEP_TIMEOUT_MS = 8_000;

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
  readonly ptyHub: PtyHub;
  readonly sessionStore: SessionStore;
  readonly workbenchState: WorkbenchStateStore;
  readonly historySnapshots: HistorySnapshotStore;
  private rememberedSessions: StoredSessionRef[];
  private rememberedRecentSessions: StoredSessionRef[];
  private rememberedWorkspaceDirs: string[];
  private rememberedHiddenWorkspaces: string[];
  private rememberedActiveWorkspaceDir: string | undefined;
  private rememberedHiddenSessionKeys: string[];
  private rememberedSessionTitleOverrides: Record<string, string>;
  private lastDiscoveredStoredSessions: StoredSessionRef[] = [];
  private storedSessionDiscoveryVersion = 0;
  private readonly storedSessionDiscoveryChanges: StoredSessionDiscoveryChange[] = [];
  private readonly storedSessionMonitor: StoredSessionMonitor;
  private readonly workspaceScopeAuthorizer: WorkspaceScopeAuthorizer;
  private readonly terminals: RuntimeTerminalCoordinator;
  private readonly sessionLifecycle: RuntimeSessionLifecycle;
  private readonly structuredProviders: RuntimeStructuredProviderCoordinator;
  private readonly nativeTuiProviders: NativeTuiProviderRuntime;
  private readonly nativeTuiMirrors: NativeTuiMirrorProvider;
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
  private readonly historyMirrorAdapters: ProviderStoredHistoryAdapter[] = [];
  private readonly nativeTuiRehydratedSessionIds = new Set<string>();
  private readonly liveProviderSessionResumeReservations = new Map<string, number>();
  private readonly structuredLiveAllowedForInjectedAdapters: boolean;
  private readonly startupMaintenance: Promise<void>;

  constructor(adapters?: ProviderAdapter[]) {
    this.structuredLiveAllowedForInjectedAdapters = adapters !== undefined;
    this.workbenchState = new WorkbenchStateStore();
    this.eventBus = new EventBus();
    this.ptyHub = new PtyHub();
    this.historySnapshots = new HistorySnapshotStore();
    this.nativeTuiProviders = createDefaultNativeTuiProviderRuntime();
    this.nativeTuiMirrors = createDefaultNativeTuiMirrorProvider();
    this.council = new CouncilRuntime({
      eventBus: this.eventBus,
      startSession: async (request) => {
        const response = await this.startSession(request);
        return this.syncStartedSessionOrigin(response, request.origin);
      },
      sendInput: (sessionId, request) => this.sendInput(sessionId, request),
      interruptSession: (sessionId, request) => {
        this.interruptSession(sessionId, request);
      },
      closeSession: (sessionId) => this.closeCouncilManagedSession(sessionId),
      hasSession: (sessionId) => this.sessionStore?.getSession(sessionId) !== undefined,
    });
    this.sessionStore = new SessionStore({
      onSnapshot: (states) => {
        this.workbenchState.persistLiveSessions(states);
        this.refreshRememberedState();
      },
    });
    const restored = this.workbenchState.load();
    this.rememberedSessions = restored.sessions;
    this.rememberedRecentSessions = restored.recentSessions;
    this.rememberedWorkspaceDirs = restored.workspaces;
    this.rememberedHiddenWorkspaces = restored.hiddenWorkspaces;
    this.rememberedActiveWorkspaceDir = restored.activeWorkspaceDir;
    this.rememberedHiddenSessionKeys = restored.hiddenSessionKeys;
    this.rememberedSessionTitleOverrides = restored.sessionTitleOverrides;
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
      ptyHub: this.ptyHub,
      sessionStore: this.sessionStore,
      workbenchState: this.workbenchState,
    });
    for (const adapter of resolvedAdapters) {
      this.registerAdapter(adapter);
    }
    this.refreshStoredSessionsCache();
    this.storedSessionMonitor = new StoredSessionMonitor({
      roots: this.historyMirrorAdapters.flatMap(
        (adapter) => adapter.listStoredSessionWatchRoots?.() ?? [],
      ),
      refresh: () => {
        this.refreshStoredSessionsCache({ publish: true });
      },
      ...(adapters !== undefined ? { debounceMs: 50 } : {}),
      watchFs: adapters !== undefined,
      watchFileChanges: adapters !== undefined,
    });
    if (process.env.RAH_DISABLE_STORED_SESSION_MONITOR !== "1") {
      this.storedSessionMonitor.start();
    }
    this.startupMaintenance = this.restoreTuiMuxLiveSessions(restored.tuiMuxLiveSessions)
      .then(() => this.runStartupOrphanJanitor())
      .catch((error: unknown) => {
        console.warn("[rah] startup orphan cleanup failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
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
    return this.buildSessionsResponse(liveStates, this.lastDiscoveredStoredSessions, options);
  }

  async listProviderDiagnostics(options?: { forceRefresh?: boolean }): Promise<ProviderDiagnostic[]> {
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

  addWorkspace(
    rawDir: string,
    options?: { storedSessionsMode?: StoredSessionsResponseMode },
  ): ListSessionsResponse {
    this.workbenchState.selectWorkspace(rawDir);
    return this.currentWorkbenchSessions(options);
  }

  selectWorkspace(
    rawDir: string,
    options?: { storedSessionsMode?: StoredSessionsResponseMode },
  ): ListSessionsResponse {
    this.workbenchState.selectWorkspace(rawDir);
    return this.currentWorkbenchSessions(options);
  }

  removeWorkspace(
    rawDir: string,
    options?: { storedSessionsMode?: StoredSessionsResponseMode },
  ): ListSessionsResponse {
    const directory = normalizeDirectory(rawDir);
    if (!directory) {
      throw new Error("Workspace directory is required.");
    }
    this.refreshRememberedState();
    const liveStates = this.sessionStore.listSessions();
    const workspaceDirs = workspaceDirsFromState(this.rememberedWorkspaceDirs, liveStates);
    const hasRunningSessions = liveStates.some((state) => {
      if (isReadOnlyReplaySession(state)) {
        return false;
      }
      const owner = findOwningWorkspaceDirectory(
        workspaceDirs,
        state.session.rootDir || state.session.cwd,
      );
      return owner === directory;
    });
    if (hasRunningSessions) {
      throw new Error("Cannot remove a workspace with active running sessions.");
    }
    this.workbenchState.removeWorkspace(directory);
    return this.currentWorkbenchSessions(options);
  }

  async removeStoredSession(
    provider: ProviderKind,
    providerSessionId: string,
    options?: { storedSessionsMode?: StoredSessionsResponseMode },
  ): Promise<ListSessionsResponse> {
    const session = this.lastDiscoveredStoredSessions.find(
      (entry) =>
        entry.provider === provider && entry.providerSessionId === providerSessionId,
    );
    await this.storedHistoryAdaptersByProvider.get(provider)?.removeStoredSession?.(
      session ?? { provider, providerSessionId, source: "provider_history" },
    );
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

  async removeStoredWorkspaceSessions(rawDir: string): Promise<ListSessionsResponse> {
    const directory = normalizeDirectory(rawDir);
    if (!directory) {
      throw new Error("Workspace directory is required.");
    }
    const currentSessions = this.buildSessionsResponse(
      this.sessionStore.listSessions(),
      this.lastDiscoveredStoredSessions,
    );
    const matchingStoredSessions = [...currentSessions.storedSessions, ...currentSessions.recentSessions].filter((session) =>
      sessionBelongsToWorkspace(session.rootDir || session.cwd, directory),
    );
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
    return this.buildSessionsResponse(this.sessionStore.listSessions(), this.lastDiscoveredStoredSessions);
  }

  getSessionSummary(sessionId: string): SessionSummary {
    const state = this.sessionStore.getSession(sessionId);
    if (!state) {
      throw new Error(`Unknown session ${sessionId}`);
    }
    return this.applyCanonicalSessionTitle(toSessionSummary(state));
  }

  async startSession(request: StartSessionRequest): Promise<StartSessionResponse> {
    await this.waitForStartupMaintenance();
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
    await this.waitForStartupMaintenance();
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
    const adapter = this.storedHistoryAdaptersByProvider.get(request.provider);
    if (!adapter?.resumeStoredSession && this.structuredLiveAllowedForInjectedAdapters) {
      return await this.structuredProviders.resumeSession(request);
    }
    if (!adapter?.resumeStoredSession) {
      throw new Error(`Provider ${request.provider} does not support stored history replay.`);
    }
    const response = await adapter.resumeStoredSession(request);
    if (
      request.historySourceSessionId &&
      request.historySourceSessionId !== response.session.session.id
    ) {
      this.historySnapshots.transfer(
        request.historySourceSessionId,
        response.session.session.id,
      );
    }
    return response;
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
      `Provider ${request.provider} is not a supported live provider. Use Codex, Claude, Gemini, or OpenCode.`,
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
    if (
      this.terminals.handleNativeTuiInput(sessionId, request.clientId, request.text, {
        ...(request.clientMessageId !== undefined ? { clientMessageId: request.clientMessageId } : {}),
        ...(request.clientTurnId !== undefined ? { clientTurnId: request.clientTurnId } : {}),
      })
    ) {
      return;
    }
    this.requireStructuredInputControlAdapter(sessionId).sendInput(sessionId, request);
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
    const closingProvider = this.sessionStore.getSession(sessionId)?.session.provider;
    await this.sessionLifecycle.closeSession(sessionId, request);
    this.refreshStoredSessionsCache(
      closingProvider
        ? { publish: true, provider: closingProvider }
        : { publish: true },
    );
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

  getWorkspaceSnapshot(sessionId: string, options?: { scopeRoot?: string }) {
    if (this.shouldUseStructuredWorkspaceInspection(sessionId)) {
      const scopeRoot = this.workspaceScopeAuthorizer.resolveAuthorizedSessionScopeRoot(
        sessionId,
        options?.scopeRoot,
      );
      return this.requireStructuredWorkspaceInspectionAdapter(sessionId).getWorkspaceSnapshot(
        sessionId,
        {
          ...(scopeRoot ? { scopeRoot } : {}),
        },
      );
    }
    const session = this.requireManagedSession(sessionId).session;
    const scopeRoot = this.workspaceScopeAuthorizer.resolveAuthorizedSessionScopeRoot(
      sessionId,
      options?.scopeRoot,
    );
    const snapshot = getWorkspaceSnapshot(scopeRoot ?? session.cwd);
    return {
      sessionId,
      cwd: snapshot.cwd,
      nodes: snapshot.nodes,
    };
  }

  async getGitStatus(sessionId: string, options?: { scopeRoot?: string }) {
    if (this.shouldUseStructuredWorkspaceInspection(sessionId)) {
      const scopeRoot = this.workspaceScopeAuthorizer.resolveAuthorizedSessionScopeRoot(
        sessionId,
        options?.scopeRoot,
      );
      return await this.requireStructuredWorkspaceInspectionAdapter(sessionId).getGitStatus(
        sessionId,
        {
          ...(scopeRoot ? { scopeRoot } : {}),
        },
      );
    }
    const session = this.requireManagedSession(sessionId).session;
    const scopeRoot = this.workspaceScopeAuthorizer.resolveAuthorizedSessionScopeRoot(
      sessionId,
      options?.scopeRoot,
    );
    const status = await getWorkspaceGitStatusAsync(session.cwd, {
      ...(scopeRoot ? { scopeRoot } : {}),
    });
    return {
      sessionId,
      ...(status.branch !== undefined ? { branch: status.branch } : {}),
      changedFiles: status.changedFiles,
      ...(status.stagedFiles ? { stagedFiles: status.stagedFiles } : {}),
      ...(status.unstagedFiles ? { unstagedFiles: status.unstagedFiles } : {}),
      ...(status.totalStaged !== undefined ? { totalStaged: status.totalStaged } : {}),
      ...(status.totalUnstaged !== undefined ? { totalUnstaged: status.totalUnstaged } : {}),
    };
  }

  async getGitDiff(
    sessionId: string,
    path: string,
    options?: { staged?: boolean; ignoreWhitespace?: boolean; scopeRoot?: string },
  ) {
    if (this.shouldUseStructuredWorkspaceInspection(sessionId)) {
      const scopeRoot = this.workspaceScopeAuthorizer.resolveAuthorizedSessionScopeRoot(
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
        },
      );
    }
    const session = this.requireManagedSession(sessionId).session;
    const scopeRoot = this.workspaceScopeAuthorizer.resolveAuthorizedSessionScopeRoot(
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
      }),
    };
  }

  async getWorkspaceGitStatus(dir: string) {
    const workspaceDir = this.workspaceScopeAuthorizer.resolveAuthorizedWorkspaceDirectory(dir);
    return await getWorkspaceGitStatusAsync(workspaceDir, { scopeRoot: workspaceDir });
  }

  async getWorkspaceGitDiff(
    dir: string,
    path: string,
    options?: { staged?: boolean; ignoreWhitespace?: boolean },
  ) {
    const workspaceDir = this.workspaceScopeAuthorizer.resolveAuthorizedWorkspaceDirectory(dir);
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
      const scopeRoot = this.workspaceScopeAuthorizer.resolveAuthorizedSessionScopeRoot(
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
    const scopeRoot = this.workspaceScopeAuthorizer.resolveAuthorizedSessionScopeRoot(
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
    const workspaceDir = this.workspaceScopeAuthorizer.resolveAuthorizedWorkspaceDirectory(dir);
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
    const scopeRoot = this.workspaceScopeAuthorizer.resolveAuthorizedSessionScopeRoot(
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
    const workspaceDir = this.workspaceScopeAuthorizer.resolveAuthorizedWorkspaceDirectory(dir);
    return {
      sessionId: "",
      query,
      files: await searchWorkspaceFilesInDirectoryAsync(workspaceDir, query, limit),
    };
  }

  getSessionHistoryPage(
    sessionId: string,
    options?: { beforeTs?: string; cursor?: string; limit?: number; detail?: SessionHistoryDetailMode },
  ): SessionHistoryPageResponse {
    const ownerProvider = this.structuredSessionOwners.get(sessionId);
    const adapter = ownerProvider
      ? this.storedHistoryAdaptersByProvider.get(ownerProvider)
      : (() => {
          const session = this.sessionStore.getSession(sessionId);
          return session
            ? this.storedHistoryAdaptersByProvider.get(session.session.provider)
            : undefined;
        })();
    if (!adapter?.getSessionHistoryPage) {
      return { sessionId, events: [] };
    }
    const session = this.sessionStore.getSession(sessionId)?.session;
    const page = this.historySnapshots.getPage({
      sessionId,
      ...(options?.cursor ? { cursor: options.cursor } : {}),
      ...(options?.limit ? { limit: options.limit } : {}),
      loadFrozenPage: () => adapter.createFrozenHistoryPageLoader?.(sessionId),
      loadEvents: () =>
        adapter.getSessionHistoryPage!(
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

  getSessionHistoryItemDetail(
    sessionId: string,
    options: { kind: "tool_call" | "observation"; itemId: string },
  ) {
    return {
      sessionId,
      kind: options.kind,
      itemId: options.itemId,
      events: this.historySnapshots.findCachedEvents(sessionId, (event) =>
        historyEventMatchesItem(event, options.kind, options.itemId),
      ),
    };
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
    await runShutdownStep("stored session monitor", () => this.storedSessionMonitor.shutdown());
    await runShutdownStep("council runtime", () => this.council.shutdown());
    await runShutdownStep("terminal sessions", () => this.terminals.shutdown());
    await Promise.all(
      [...this.shutdownAdaptersById.values()].map((adapter) =>
        runShutdownStep(`provider adapter ${adapter.id}`, () => adapter.shutdown?.()),
      ),
    );
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
    await runShutdownStep("TUI mux cleanup", async () => {
      const closedTuiMuxSessions = await this.terminals.cleanupUnmanagedTuiMuxSessions();
      if (closedTuiMuxSessions.length > 0) {
        console.warn("[rah] cleaned unmanaged RAH tmux sessions during shutdown", {
          sessions: closedTuiMuxSessions,
        });
      }
    });
    await runShutdownStep("workbench state flush", () => this.workbenchState.flush());
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

  private updateStoredSessionsCache(
    next: readonly StoredSessionRef[],
    options?: {
      publish?: boolean;
      resetRequired?: boolean;
      extraRemove?: readonly StoredSessionIdentity[];
    },
  ): void {
    if (
      this.sameStoredSessionRefs(this.lastDiscoveredStoredSessions, next) &&
      !options?.resetRequired &&
      (!options?.extraRemove || options.extraRemove.length === 0)
    ) {
      return;
    }
    const change = this.buildStoredSessionsDiscoveryChange(this.lastDiscoveredStoredSessions, next, {
      resetRequired: options?.resetRequired ?? false,
      extraRemove: options?.extraRemove ?? [],
    });
    this.lastDiscoveredStoredSessions = [...next];
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
        },
        isClosingSession: () => false,
        ...(options?.storedSessionsMode ? { storedSessionsMode: options.storedSessionsMode } : {}),
      }),
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
  }

  private pruneOrphanSessions(): void {
    for (const state of [...this.sessionStore.listSessions()]) {
      if (state.clients.length > 0) {
        continue;
      }
      if (this.terminals.hasNativeTuiSession(state.session.id)) {
        continue;
      }
      const adapter = this.requireStructuredLifecycleAdapter(state.session.id);
      void Promise.resolve(adapter.destroySession?.(state.session.id)).catch((error: unknown) => {
        console.error(
          `[rah] destroySession failed for ${state.session.id}:`,
          error instanceof Error ? error.message : String(error),
        );
      });
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
      await Promise.resolve(adapter.destroySession?.(sessionId)).catch((error: unknown) => {
        console.error(
          `[rah] destroySession failed for council session ${sessionId}:`,
          error instanceof Error ? error.message : String(error),
        );
      });
    }
    this.sessionStore.removeSession(sessionId);
    this.ptyHub.removeSession(sessionId);
    this.historySnapshots.clear(sessionId);
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

import { mkdir, opendir, stat } from "node:fs/promises";
import { resolve } from "node:path";
import type {
  AttachSessionRequest,
  AttachSessionResponse,
  ClaimControlRequest,
  CloseSessionRequest,
  CouncilAgentTuiResponse,
  CouncilMcpRequest,
  CouncilMcpResponse,
  CouncilPostMessageRequest,
  CouncilPostMessageResponse,
  CreateCouncilRoomRequest,
  CreateCouncilRoomResponse,
  DetachSessionRequest,
  DebugScenarioDescriptor,
  DebugReplayScript,
  EventSubscriptionRequest,
  GitFileActionRequest,
  GitHunkActionRequest,
  IndependentTerminalStartRequest,
  IndependentTerminalStartResponse,
  InterruptSessionRequest,
  ManagedSession,
  NativeTuiSurfaceClaimRequest,
  NativeTuiSurfaceReleaseRequest,
  NativeTuiSurfaceResponse,
  NativeTuiDiagnostic,
  ListSessionsResponse,
  ListCouncilRoomsResponse,
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
  SessionHistoryPageResponse,
  SessionLiveBackend,
  SessionSummary,
  StartSessionRequest,
  StartSessionResponse,
  StoredSessionRef,
  ZellijMuxSessionDiagnostic,
} from "@rah/runtime-protocol";
import { createDefaultProviderAdapters } from "./default-provider-adapters";
import {
  applyWorkspaceGitFileActionAsync,
  applyWorkspaceGitHunkActionAsync,
  getWorkspaceGitDiffAsync,
  getWorkspaceGitStatusAsync,
  getWorkspaceSnapshot,
  readWorkspaceFileFromDirectoryAsync,
  searchWorkspaceFilesInDirectoryAsync,
} from "./workspace-utils";
import { EventBus } from "./event-bus";
import { HistorySnapshotStore } from "./history-snapshots";
import type { ProviderActivity } from "./provider-activity";
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
import { RuntimeStructuredProviderCoordinator } from "./legacy-structured/runtime-structured-provider-coordinator";
import { SessionStore, toSessionSummary, type StoredSessionState } from "./session-store";
import {
  buildSessionsResponse as buildRuntimeSessionsResponse,
  discoverStoredSessions as discoverRuntimeStoredSessions,
  sameStoredSessionRefs,
} from "./runtime-session-list";
import { StoredSessionMonitor } from "./stored-session-monitor";
import {
  type TerminalWrapperFromDaemonMessage,
  type TerminalWrapperPromptState,
  type WrapperHelloMessage,
  type WrapperProviderBoundMessage,
  type WrapperReadyMessage,
} from "./terminal-wrapper-control";
import { RuntimeTerminalCoordinator } from "./runtime-terminal-coordinator";
import { RuntimeSessionLifecycle } from "./runtime-session-lifecycle";
import {
  createDefaultNativeTuiProviderRuntime,
  type NativeTuiProviderRuntime,
} from "./native-tui-provider-runtime";
import {
  createDefaultNativeTuiMirrorProvider,
  type NativeTuiMirrorProvider,
} from "./native-tui-mirror-provider";
import { WorkbenchStateStore } from "./workbench-state";
import {
  isReadOnlyReplaySession,
  normalizeDirectory,
  resolveUserPath,
  sessionBelongsToWorkspace,
} from "./workbench-directory-utils";
import { WorkspaceScopeAuthorizer } from "./workspace-scope-authorizer";
import { assertExistingWorkingDirectory } from "./provider-working-directory";
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

const SYSTEM_SOURCE = {
  provider: "system" as const,
  channel: "system" as const,
  authority: "authoritative" as const,
};

const MAX_MATERIALIZED_HISTORY_EVENTS = 5_000;

type StructuredSessionOwnerProvider = StoredSessionState["session"]["provider"];

type RuntimeEngineOptions = {
  enableLegacyWrapperRuntime?: boolean;
};

async function runShutdownStep(label: string, task: () => Promise<unknown> | unknown) {
  try {
    await task();
  } catch (error) {
    console.error("[rah] shutdown step failed", { step: label, error });
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
  private readonly storedSessionMonitor: StoredSessionMonitor;
  private readonly workspaceScopeAuthorizer: WorkspaceScopeAuthorizer;
  private readonly terminals: RuntimeTerminalCoordinator;
  private readonly sessionLifecycle: RuntimeSessionLifecycle;
  private readonly structuredProviders: RuntimeStructuredProviderCoordinator;
  private readonly nativeTuiProviders: NativeTuiProviderRuntime;
  private readonly nativeTuiMirrors: NativeTuiMirrorProvider;
  private readonly council: CouncilRuntime;
  private readonly defaultLiveBackend: SessionLiveBackend;

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
  private readonly structuredLiveAllowedForInjectedAdapters: boolean;

  constructor(adapters?: ProviderAdapter[], options: RuntimeEngineOptions = {}) {
    this.defaultLiveBackend =
      adapters === undefined
        ? process.env.RAH_MUX_BACKEND === "zellij"
          ? "zellij_tui"
          : "native_tui"
        : "structured";
    this.structuredLiveAllowedForInjectedAdapters = adapters !== undefined;
    this.workbenchState = new WorkbenchStateStore();
    this.eventBus = new EventBus();
    this.ptyHub = new PtyHub();
    this.historySnapshots = new HistorySnapshotStore();
    this.nativeTuiProviders = createDefaultNativeTuiProviderRuntime();
    this.nativeTuiMirrors = createDefaultNativeTuiMirrorProvider();
    this.council = new CouncilRuntime({ eventBus: this.eventBus });
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
      enableLegacyWrapperRuntime: options.enableLegacyWrapperRuntime === true,
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
      refreshRememberedState: () => {
        this.refreshRememberedState();
      },
      publishStoredSessionDiscovery: () => {
        this.publishStoredSessionDiscovery();
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
    });
    this.storedSessionMonitor.start();
    void this.restoreZellijLiveSessions(restored.zellijLiveSessions);
  }

  private async restoreZellijLiveSessions(
    sessions: readonly ManagedSession[],
  ): Promise<void> {
    if (sessions.length === 0) {
      return;
    }
    for (const session of sessions) {
      await this.terminals.restoreZellijTuiSession(session).catch((error) => {
        console.warn("[rah] failed to recover zellij live session", {
          sessionId: session.id,
          zellijSessionName: session.mux?.sessionName,
          error,
        });
        return false;
      });
    }
    this.workbenchState.persistLiveSessions(this.sessionStore.listSessions());
    this.refreshRememberedState();
  }

  listSessions(): ListSessionsResponse {
    this.pruneOrphanSessions();
    const liveStates = this.sessionStore.listSessions();
    return this.buildSessionsResponse(liveStates, this.lastDiscoveredStoredSessions);
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

  async listZellijMuxDiagnostics(): Promise<ZellijMuxSessionDiagnostic[]> {
    return await this.terminals.listZellijMuxDiagnostics();
  }

  async closeZellijMuxSession(sessionName: string): Promise<void> {
    await this.terminals.closeUnmanagedZellijMuxSession(sessionName);
  }

  async listProviderModels(
    provider: ProviderKind,
    options?: { cwd?: string; forceRefresh?: boolean },
  ): Promise<ProviderModelCatalog> {
    return this.structuredProviders.listProviderModels(provider, options);
  }

  listCouncilRooms(): ListCouncilRoomsResponse {
    return this.council.listRooms();
  }

  async createCouncilRoom(request: CreateCouncilRoomRequest): Promise<CreateCouncilRoomResponse> {
    await assertExistingWorkingDirectory(request.workspace, "Council workspace");
    return await this.council.createRoom(request);
  }

  postCouncilMessage(
    roomId: string,
    request: CouncilPostMessageRequest,
  ): CouncilPostMessageResponse {
    return this.council.postMessage(roomId, request);
  }

  async archiveCouncilRoom(roomId: string): Promise<void> {
    await this.council.archiveRoom(roomId);
  }

  async getCouncilAgentTui(
    roomId: string,
    agentId: string,
  ): Promise<CouncilAgentTuiResponse> {
    return await this.council.getAgentTui(roomId, agentId);
  }

  callCouncilMcpTool(request: CouncilMcpRequest): CouncilMcpResponse {
    return this.council.callMcpTool(request);
  }

  addWorkspace(rawDir: string): ListSessionsResponse {
    this.workbenchState.selectWorkspace(rawDir);
    return this.currentWorkbenchSessions();
  }

  selectWorkspace(rawDir: string): ListSessionsResponse {
    this.workbenchState.selectWorkspace(rawDir);
    return this.currentWorkbenchSessions();
  }

  removeWorkspace(rawDir: string): ListSessionsResponse {
    const directory = normalizeDirectory(rawDir);
    if (!directory) {
      throw new Error("Workspace directory is required.");
    }
    const hasLiveSessions = this.sessionStore.listSessions().some((state) =>
      !isReadOnlyReplaySession(state) &&
      sessionBelongsToWorkspace(state.session.rootDir || state.session.cwd, directory),
    );
    if (hasLiveSessions) {
      throw new Error("Cannot remove a workspace with active live sessions.");
    }
    this.workbenchState.removeWorkspace(directory);
    return this.currentWorkbenchSessions();
  }

  async removeStoredSession(
    provider: ProviderKind,
    providerSessionId: string,
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
    this.lastDiscoveredStoredSessions = this.lastDiscoveredStoredSessions.filter(
      (session) =>
        session.provider !== provider || session.providerSessionId !== providerSessionId,
    );
    this.publishStoredSessionDiscovery();
    return this.buildSessionsResponse(this.sessionStore.listSessions(), this.lastDiscoveredStoredSessions);
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
    this.lastDiscoveredStoredSessions = this.lastDiscoveredStoredSessions.filter(
      (session) => !sessionBelongsToWorkspace(session.rootDir || session.cwd, directory),
    );
    this.publishStoredSessionDiscovery();
    return this.buildSessionsResponse(this.sessionStore.listSessions(), this.lastDiscoveredStoredSessions);
  }

  getSessionSummary(sessionId: string): SessionSummary {
    const state = this.sessionStore.getSession(sessionId);
    if (!state) {
      throw new Error(`Unknown session ${sessionId}`);
    }
    return toSessionSummary(state);
  }

  async startSession(request: StartSessionRequest): Promise<StartSessionResponse> {
    this.assertLiveSessionProviderAllowed(request);
    this.assertStructuredLiveBackendAllowed(request);
    if (this.shouldUseZellijTuiBackend(request)) {
      await assertExistingWorkingDirectory(request.cwd, "Session working directory");
      this.pruneOrphanSessions();
      return await this.terminals.startZellijTuiSession({
        launch: await this.nativeTuiProviders.startLaunchSpec(request),
        ...(request.attach !== undefined ? { attach: request.attach } : {}),
      });
    }
    if (this.shouldUseNativeTuiBackend(request)) {
      await assertExistingWorkingDirectory(request.cwd, "Session working directory");
      this.pruneOrphanSessions();
      return await this.terminals.startNativeTuiSession({
        launch: await this.nativeTuiProviders.startLaunchSpec(request),
        ...(request.attach !== undefined ? { attach: request.attach } : {}),
      });
    }
    return this.structuredProviders.startSession(request);
  }

  async resumeSession(request: ResumeSessionRequest): Promise<ResumeSessionResponse> {
    this.assertLiveSessionProviderAllowed(request);
    this.assertStructuredLiveBackendAllowed(request);
    if (request.preferStoredReplay === true) {
      return await this.resumeStoredReplaySession(request);
    }
    if (this.shouldUseZellijTuiBackend(request)) {
      if (request.cwd) {
        await assertExistingWorkingDirectory(request.cwd, "Session working directory");
      }
      this.pruneOrphanSessions();
      return await this.terminals.startZellijTuiSession({
        launch: await this.nativeTuiProviders.resumeLaunchSpec(request),
        ...(request.attach !== undefined ? { attach: request.attach } : {}),
        providerSessionId: request.providerSessionId,
      });
    }
    if (this.shouldUseNativeTuiBackend(request)) {
      if (request.cwd) {
        await assertExistingWorkingDirectory(request.cwd, "Session working directory");
      }
      this.pruneOrphanSessions();
      return await this.terminals.startNativeTuiSession({
        launch: await this.nativeTuiProviders.resumeLaunchSpec(request),
        ...(request.attach !== undefined ? { attach: request.attach } : {}),
        providerSessionId: request.providerSessionId,
      });
    }
    return this.structuredProviders.resumeSession(request);
  }

  private async resumeStoredReplaySession(
    request: ResumeSessionRequest,
  ): Promise<ResumeSessionResponse> {
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
        "Structured live backend is disabled outside injected test adapters. Use native_tui for live sessions.",
      );
    }
  }

  private assertLiveSessionProviderAllowed(
    request: Pick<StartSessionRequest | ResumeSessionRequest, "provider"> &
      Partial<Pick<ResumeSessionRequest, "preferStoredReplay">>,
  ): void {
    if (
      request.preferStoredReplay === true ||
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
    return (
      this.defaultLiveBackend === "native_tui" &&
      this.nativeTuiProviders.supports(request.provider)
    );
  }

  private shouldUseZellijTuiBackend(
    request: Pick<StartSessionRequest | ResumeSessionRequest, "provider" | "liveBackend"> &
      Partial<Pick<ResumeSessionRequest, "preferStoredReplay">>,
  ): boolean {
    if (request.liveBackend !== undefined) {
      return request.liveBackend === "zellij_tui";
    }
    if (request.preferStoredReplay === true) {
      return false;
    }
    return (
      this.defaultLiveBackend === "zellij_tui" &&
      this.nativeTuiProviders.supports(request.provider)
    );
  }

  attachSession(sessionId: string, request: AttachSessionRequest): AttachSessionResponse {
    return this.sessionLifecycle.attachSession(sessionId, request);
  }

  claimControl(sessionId: string, request: ClaimControlRequest): SessionSummary {
    return this.sessionLifecycle.claimControl(sessionId, request);
  }

  releaseControl(sessionId: string, request: ReleaseControlRequest): SessionSummary {
    return this.sessionLifecycle.releaseControl(sessionId, request);
  }

  async renameSession(sessionId: string, title: string): Promise<SessionSummary> {
    return this.sessionLifecycle.renameSession(sessionId, title);
  }

  async setSessionMode(sessionId: string, modeId: string): Promise<SessionSummary> {
    return this.sessionLifecycle.setSessionMode(sessionId, modeId);
  }

  async setSessionModel(
    sessionId: string,
    request: SetSessionModelRequest,
  ): Promise<SessionSummary> {
    return this.sessionLifecycle.setSessionModel(sessionId, request);
  }

  sendInput(sessionId: string, request: { clientId: string; text: string }): void {
    if (this.terminals.handleWrapperInput(sessionId, request.clientId, request.text)) {
      return;
    }
    if (this.terminals.handleNativeTuiInput(sessionId, request.clientId, request.text)) {
      return;
    }
    this.requireStructuredInputControlAdapter(sessionId).sendInput(sessionId, request);
  }

  interruptSession(
    sessionId: string,
    request: InterruptSessionRequest,
  ): SessionSummary {
    if (this.terminals.handleWrapperInterrupt(sessionId, request.clientId)) {
      return this.getSessionSummary(sessionId);
    }
    if (this.terminals.handleNativeTuiInterrupt(sessionId, request.clientId)) {
      return this.getSessionSummary(sessionId);
    }
    return this.requireStructuredInputControlAdapter(sessionId).interruptSession(sessionId, request);
  }

  async closeSession(sessionId: string, request: CloseSessionRequest): Promise<void> {
    await this.sessionLifecycle.closeSession(sessionId, request);
  }

  detachSession(sessionId: string, request: DetachSessionRequest): SessionSummary {
    return this.sessionLifecycle.detachSession(sessionId, request);
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

  async respondToPermission(
    sessionId: string,
    requestId: string,
    response: PermissionResponseRequest,
  ): Promise<void> {
    if (this.terminals.handlePermissionResponse(sessionId, requestId, response)) {
      return;
    }
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

  async readSessionFile(sessionId: string, path: string, options?: { scopeRoot?: string }) {
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
      })),
      sessionId,
    };
  }

  async readWorkspaceFile(dir: string, path: string) {
    const workspaceDir = this.workspaceScopeAuthorizer.resolveAuthorizedWorkspaceDirectory(dir);
    return await readWorkspaceFileFromDirectoryAsync(workspaceDir, path, {
      scopeRoot: workspaceDir,
    });
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
    options?: { beforeTs?: string; cursor?: string; limit?: number },
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
    return this.historySnapshots.getPage({
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

  async closeIndependentTerminal(id: string): Promise<void> {
    await this.terminals.closeIndependentTerminal(id);
  }

  registerTerminalWrapperSession(
    request: WrapperHelloMessage,
    sendMessage: (message: TerminalWrapperFromDaemonMessage) => void,
  ): WrapperReadyMessage {
    return this.terminals.registerTerminalWrapperSession(request, sendMessage);
  }

  disconnectTerminalWrapperSession(sessionId: string): void {
    this.terminals.disconnectTerminalWrapperSession(sessionId);
  }

  bindTerminalWrapperProviderSession(message: WrapperProviderBoundMessage): void {
    this.terminals.bindTerminalWrapperProviderSession(message);
  }

  updateTerminalWrapperPromptState(
    sessionId: string,
    promptState: TerminalWrapperPromptState,
  ): void {
    this.terminals.updateTerminalWrapperPromptState(sessionId, promptState);
  }

  applyTerminalWrapperActivity(sessionId: string, activity: ProviderActivity): RahEvent[] {
    return this.terminals.applyTerminalWrapperActivity(sessionId, activity);
  }

  appendTerminalWrapperPtyOutput(sessionId: string, data: string): RahEvent[] {
    return this.terminals.appendTerminalWrapperPtyOutput(sessionId, data);
  }

  markTerminalWrapperExited(
    sessionId: string,
    options?: { exitCode?: number; signal?: string },
  ): RahEvent[] {
    return this.terminals.markTerminalWrapperExited(sessionId, options);
  }

  async shutdown(): Promise<void> {
    await runShutdownStep("stored session monitor", () => this.storedSessionMonitor.shutdown());
    await runShutdownStep("terminal sessions", () => this.terminals.shutdown());
    await Promise.all(
      [...this.shutdownAdaptersById.values()].map((adapter) =>
        runShutdownStep(`provider adapter ${adapter.id}`, () => adapter.shutdown?.()),
      ),
    );
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

  private currentWorkbenchSessions(): ListSessionsResponse {
    this.refreshRememberedState();
    return this.listSessions();
  }

  private discoverStoredSessions(): StoredSessionRef[] {
    return discoverRuntimeStoredSessions(this.historyMirrorAdapters);
  }

  private refreshStoredSessionsCache(options?: { publish?: boolean }): void {
    const next = this.discoverStoredSessions();
    if (this.sameStoredSessionRefs(this.lastDiscoveredStoredSessions, next)) {
      return;
    }
    this.lastDiscoveredStoredSessions = next;
    if (options?.publish) {
      this.publishStoredSessionDiscovery();
    }
  }

  private sameStoredSessionRefs(
    left: readonly StoredSessionRef[],
    right: readonly StoredSessionRef[],
  ): boolean {
    return sameStoredSessionRefs(left, right);
  }

  private publishStoredSessionDiscovery(): void {
    this.eventBus.publish({
      sessionId: "workbench:stored-sessions",
      type: "session.discovery",
      source: SYSTEM_SOURCE,
      payload: {
        version: ++this.storedSessionDiscoveryVersion,
      },
    });
  }

  private buildSessionsResponse(
    liveStates: readonly StoredSessionState[],
    discoveredStoredSessions: readonly StoredSessionRef[],
  ): ListSessionsResponse {
    return buildRuntimeSessionsResponse({
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
      isClosingSession: (sessionId) => this.terminals.isClosingWrapperSession(sessionId),
    });
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

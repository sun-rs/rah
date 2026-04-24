import { mkdir, opendir, stat } from "node:fs/promises";
import { resolve } from "node:path";
import type {
  AttachSessionRequest,
  AttachSessionResponse,
  ClaimControlRequest,
  CloseSessionRequest,
  DetachSessionRequest,
  DebugScenarioDescriptor,
  DebugReplayScript,
  EventSubscriptionRequest,
  GitFileActionRequest,
  GitHunkActionRequest,
  IndependentTerminalSession,
  IndependentTerminalStartRequest,
  IndependentTerminalStartResponse,
  InterruptSessionRequest,
  ListSessionsResponse,
  ProviderDiagnostic,
  ProviderKind,
  PermissionResponseRequest,
  RahEvent,
  ReleaseControlRequest,
  ResumeSessionRequest,
  ResumeSessionResponse,
  SessionFileSearchResponse,
  SessionHistoryPageResponse,
  SessionSummary,
  StartSessionRequest,
  StartSessionResponse,
  StoredSessionRef,
} from "@rah/runtime-protocol";
import { ClaudeAdapter } from "./claude-adapter";
import { CodexAdapter } from "./codex-adapter";
import {
  getWorkspaceGitDiffAsync,
  getWorkspaceGitStatusAsync,
  readWorkspaceFileFromDirectoryAsync,
  searchWorkspaceFilesInDirectoryAsync,
} from "./workspace-utils";
import { DebugAdapter } from "./debug-adapter";
import { EventBus } from "./event-bus";
import { GeminiAdapter } from "./gemini-adapter";
import { HistorySnapshotStore } from "./history-snapshots";
import { KimiAdapter } from "./kimi-adapter";
import type { ProviderActivity } from "./provider-activity";
import type { ProviderAdapter } from "./provider-adapter";
import { PtyHub } from "./pty-hub";
import { RuntimeProviderCoordinator } from "./runtime-provider-coordinator";
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
import { WorkbenchStateStore } from "./workbench-state";
import {
  isReadOnlyReplaySession,
  normalizeDirectory,
  resolveUserPath,
  sessionBelongsToWorkspace,
  workspaceDirsFromState,
} from "./workbench-directory-utils";
import { WorkspaceScopeAuthorizer } from "./workspace-scope-authorizer";

const SYSTEM_SOURCE = {
  provider: "system" as const,
  channel: "system" as const,
  authority: "authoritative" as const,
};

const MAX_MATERIALIZED_HISTORY_EVENTS = 5_000;

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
  private lastDiscoveredStoredSessions: StoredSessionRef[] = [];
  private storedSessionDiscoveryVersion = 0;
  private readonly storedSessionMonitor: StoredSessionMonitor;
  private readonly workspaceScopeAuthorizer: WorkspaceScopeAuthorizer;
  private readonly terminals: RuntimeTerminalCoordinator;
  private readonly sessionLifecycle: RuntimeSessionLifecycle;
  private readonly providers: RuntimeProviderCoordinator;

  private readonly adaptersById = new Map<string, ProviderAdapter>();
  private readonly adaptersByProvider = new Map<string, ProviderAdapter>();
  private readonly sessionOwners = new Map<string, ProviderAdapter>();

  constructor(adapters?: ProviderAdapter[]) {
    this.workbenchState = new WorkbenchStateStore();
    this.eventBus = new EventBus();
    this.ptyHub = new PtyHub();
    this.historySnapshots = new HistorySnapshotStore();
    this.sessionStore = new SessionStore({
      onSnapshot: (states) => {
        this.workbenchState.persistLiveSessions(states);
      },
    });
    const restored = this.workbenchState.load();
    this.rememberedSessions = restored.sessions;
    this.rememberedRecentSessions = restored.recentSessions;
    this.rememberedWorkspaceDirs = restored.workspaces;
    this.rememberedHiddenWorkspaces = restored.hiddenWorkspaces;
    this.rememberedActiveWorkspaceDir = restored.activeWorkspaceDir;
    this.rememberedHiddenSessionKeys = restored.hiddenSessionKeys;
    this.workspaceScopeAuthorizer = new WorkspaceScopeAuthorizer(
      this.workbenchState,
      this.sessionStore,
    );
    this.terminals = new RuntimeTerminalCoordinator({
      eventBus: this.eventBus,
      ptyHub: this.ptyHub,
      sessionStore: this.sessionStore,
      historySnapshots: this.historySnapshots,
      onRememberSession: (state) => {
        this.workbenchState.rememberSession(state);
        this.refreshRememberedState();
      },
      onSessionOwnerRemoved: (sessionId) => {
        this.sessionOwners.delete(sessionId);
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
      removeSessionOwner: (sessionId) => {
        this.sessionOwners.delete(sessionId);
      },
      requireSessionAdapter: (sessionId) => this.requireSessionAdapter(sessionId),
    });
    this.providers = new RuntimeProviderCoordinator({
      adaptersByProvider: this.adaptersByProvider,
      adaptersById: this.adaptersById,
      rememberSessionOwner: (sessionId, adapter) => {
        this.rememberSessionOwner(sessionId, adapter);
      },
      pruneOrphanSessions: () => {
        this.pruneOrphanSessions();
      },
      historySnapshots: this.historySnapshots,
    });

    const resolvedAdapters: ProviderAdapter[] = adapters ?? (() => {
      const debugAdapter = new DebugAdapter({
        eventBus: this.eventBus,
        ptyHub: this.ptyHub,
        sessionStore: this.sessionStore,
      });
      return [
        debugAdapter,
        new CodexAdapter({
          eventBus: this.eventBus,
          ptyHub: this.ptyHub,
          sessionStore: this.sessionStore,
        }),
        new ClaudeAdapter({
          eventBus: this.eventBus,
          ptyHub: this.ptyHub,
          sessionStore: this.sessionStore,
        }),
        new GeminiAdapter({
          eventBus: this.eventBus,
          ptyHub: this.ptyHub,
          sessionStore: this.sessionStore,
        }),
        new KimiAdapter({
          eventBus: this.eventBus,
          ptyHub: this.ptyHub,
          sessionStore: this.sessionStore,
        }),
      ];
    })();
    for (const adapter of resolvedAdapters) {
      this.registerAdapter(adapter);
    }
    this.refreshStoredSessionsCache();
    this.storedSessionMonitor = new StoredSessionMonitor({
      roots: resolvedAdapters.flatMap((adapter) => adapter.listStoredSessionWatchRoots?.() ?? []),
      refresh: () => {
        this.refreshStoredSessionsCache({ publish: true });
      },
    });
    this.storedSessionMonitor.start();
  }

  listSessions(): ListSessionsResponse {
    this.pruneOrphanSessions();
    const liveStates = this.sessionStore.listSessions();
    return this.buildSessionsResponse(liveStates, this.lastDiscoveredStoredSessions);
  }

  async listProviderDiagnostics(options?: { forceRefresh?: boolean }): Promise<ProviderDiagnostic[]> {
    return this.providers.listProviderDiagnostics(options);
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
    await this.adaptersByProvider.get(provider)?.removeStoredSession?.(
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
      await this.adaptersByProvider.get(session.provider)?.removeStoredSession?.(session);
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
    return this.providers.startSession(request);
  }

  async resumeSession(request: ResumeSessionRequest): Promise<ResumeSessionResponse> {
    return this.providers.resumeSession(request);
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

  sendInput(sessionId: string, request: { clientId: string; text: string }): void {
    if (this.terminals.handleWrapperInput(sessionId, request.clientId, request.text)) {
      return;
    }
    this.requireSessionAdapter(sessionId).sendInput(sessionId, request);
  }

  interruptSession(
    sessionId: string,
    request: InterruptSessionRequest,
  ): SessionSummary {
    if (this.terminals.handleWrapperInterrupt(sessionId, request.clientId)) {
      return this.getSessionSummary(sessionId);
    }
    return this.requireSessionAdapter(sessionId).interruptSession(sessionId, request);
  }

  async closeSession(sessionId: string, request: CloseSessionRequest): Promise<void> {
    await this.sessionLifecycle.closeSession(sessionId, request);
  }

  detachSession(sessionId: string, request: DetachSessionRequest): SessionSummary {
    return this.sessionLifecycle.detachSession(sessionId, request);
  }

  async respondToPermission(
    sessionId: string,
    requestId: string,
    response: PermissionResponseRequest,
  ): Promise<void> {
    if (this.terminals.handlePermissionResponse(sessionId, requestId, response)) {
      return;
    }
    const adapter = this.requireSessionAdapter(sessionId);
    if (!adapter.respondToPermission) {
      throw new Error(`Provider ${adapter.id} does not support permission responses.`);
    }
    await adapter.respondToPermission(sessionId, requestId, response);
  }

  onPtyInput(sessionId: string, clientId: string, data: string): void {
    if (this.terminals.handlePtyInput(sessionId, data)) {
      void clientId;
      return;
    }
    this.requireSessionAdapter(sessionId).onPtyInput(sessionId, clientId, data);
  }

  onPtyResize(sessionId: string, clientId: string, cols: number, rows: number): void {
    if (this.terminals.handlePtyResize(sessionId, cols, rows)) {
      void clientId;
      return;
    }
    this.requireSessionAdapter(sessionId).onPtyResize(sessionId, clientId, cols, rows);
  }

  getWorkspaceSnapshot(sessionId: string, options?: { scopeRoot?: string }) {
    const scopeRoot = this.workspaceScopeAuthorizer.resolveAuthorizedSessionScopeRoot(
      sessionId,
      options?.scopeRoot,
    );
    return this.requireSessionAdapter(sessionId).getWorkspaceSnapshot(sessionId, {
      ...(scopeRoot ? { scopeRoot } : {}),
    });
  }

  async getGitStatus(sessionId: string, options?: { scopeRoot?: string }) {
    const scopeRoot = this.workspaceScopeAuthorizer.resolveAuthorizedSessionScopeRoot(
      sessionId,
      options?.scopeRoot,
    );
    return await this.requireSessionAdapter(sessionId).getGitStatus(sessionId, {
      ...(scopeRoot ? { scopeRoot } : {}),
    });
  }

  async getGitDiff(
    sessionId: string,
    path: string,
    options?: { staged?: boolean; ignoreWhitespace?: boolean; scopeRoot?: string },
  ) {
    const scopeRoot = this.workspaceScopeAuthorizer.resolveAuthorizedSessionScopeRoot(
      sessionId,
      options?.scopeRoot,
    );
    return await this.requireSessionAdapter(sessionId).getGitDiff(sessionId, path, {
      ...(options?.staged !== undefined ? { staged: options.staged } : {}),
      ...(options?.ignoreWhitespace !== undefined
        ? { ignoreWhitespace: options.ignoreWhitespace }
        : {}),
      ...(scopeRoot ? { scopeRoot } : {}),
    });
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
    const adapter = this.requireSessionAdapter(sessionId);
    if (!adapter.applyGitFileAction) {
      throw new Error(`Provider ${adapter.id} does not support git file actions.`);
    }
    return await adapter.applyGitFileAction(sessionId, request);
  }

  async applyGitHunkAction(sessionId: string, request: GitHunkActionRequest) {
    const adapter = this.requireSessionAdapter(sessionId);
    if (!adapter.applyGitHunkAction) {
      throw new Error(`Provider ${adapter.id} does not support git hunk actions.`);
    }
    return await adapter.applyGitHunkAction(sessionId, request);
  }

  async readSessionFile(sessionId: string, path: string, options?: { scopeRoot?: string }) {
    const scopeRoot = this.workspaceScopeAuthorizer.resolveAuthorizedSessionScopeRoot(
      sessionId,
      options?.scopeRoot,
    );
    return await this.requireSessionAdapter(sessionId).readSessionFile(sessionId, path, {
      ...(scopeRoot ? { scopeRoot } : {}),
    });
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
    const adapter = this.requireSessionAdapter(sessionId);
    if (!adapter.getSessionHistoryPage) {
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
    return this.requireSessionAdapter(sessionId).getContextUsage(sessionId);
  }

  listScenarios(): DebugScenarioDescriptor[] {
    return this.providers.listScenarios();
  }

  startScenario(args: {
    scenarioId: string;
    attach?: AttachSessionRequest;
  }): StartSessionResponse {
    return this.providers.startScenario(args);
  }

  buildScenarioReplayScript(scenarioId: string): DebugReplayScript {
    return this.providers.buildScenarioReplayScript(scenarioId);
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
    await this.storedSessionMonitor.shutdown();
    await this.terminals.shutdown();
    for (const adapter of this.adaptersById.values()) {
      await adapter.shutdown?.();
    }
    await this.workbenchState.flush();
  }

  private registerAdapter(adapter: ProviderAdapter): void {
    this.adaptersById.set(adapter.id, adapter);
    for (const provider of adapter.providers) {
      this.adaptersByProvider.set(provider, adapter);
    }
  }

  private rememberSessionOwner(sessionId: string, adapter: ProviderAdapter): void {
    this.sessionOwners.set(sessionId, adapter);
  }

  private currentWorkbenchSessions(): ListSessionsResponse {
    this.refreshRememberedState();
    return this.listSessions();
  }

  private discoverStoredSessions(): StoredSessionRef[] {
    return discoverRuntimeStoredSessions(this.adaptersById.values());
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
  }

  private pruneOrphanSessions(): void {
    for (const state of [...this.sessionStore.listSessions()]) {
      if (state.clients.length > 0) {
        continue;
      }
      const adapter = this.requireSessionAdapter(state.session.id);
      void Promise.resolve(adapter.destroySession?.(state.session.id)).catch((error: unknown) => {
        console.error(
          `[rah] destroySession failed for ${state.session.id}:`,
          error instanceof Error ? error.message : String(error),
        );
      });
      this.sessionStore.removeSession(state.session.id);
      this.ptyHub.removeSession(state.session.id);
      this.sessionOwners.delete(state.session.id);
      this.terminals.clearSessionState(state.session.id);
      this.eventBus.publish({
        sessionId: state.session.id,
        type: "session.closed",
        source: SYSTEM_SOURCE,
        payload: {},
      });
    }
  }

  private requireAdapterForProvider(provider: string): ProviderAdapter {
    const adapter = this.adaptersByProvider.get(provider);
    if (!adapter) {
      throw new Error(`No adapter registered for provider ${provider}.`);
    }
    return adapter;
  }

  private requireSessionAdapter(sessionId: string): ProviderAdapter {
    const owner = this.sessionOwners.get(sessionId);
    if (owner) {
      return owner;
    }
    const state = this.sessionStore.getSession(sessionId);
    if (!state) {
      throw new Error(`Unknown session ${sessionId}`);
    }
    const adapter = this.requireAdapterForProvider(state.session.provider);
    this.sessionOwners.set(sessionId, adapter);
    return adapter;
  }
}

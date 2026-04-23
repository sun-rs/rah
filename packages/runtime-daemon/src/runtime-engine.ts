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
  getWorkspaceGitDiff,
  getWorkspaceGitStatus,
  readWorkspaceFileFromDirectory,
  searchWorkspaceFilesInDirectory,
} from "./workspace-utils";
import { DebugAdapter } from "./debug-adapter";
import { EventBus } from "./event-bus";
import { GeminiAdapter } from "./gemini-adapter";
import { HistorySnapshotStore } from "./history-snapshots";
import { IndependentTerminalProcess } from "./independent-terminal";
import { KimiAdapter } from "./kimi-adapter";
import { applyProviderActivity, type ProviderActivity } from "./provider-activity";
import {
  launchSpecForProvider,
  probeProviderDiagnostic,
} from "./provider-diagnostics";
import type { ProviderAdapter } from "./provider-adapter";
import { PtyHub } from "./pty-hub";
import { SessionStore, toSessionSummary, type StoredSessionState } from "./session-store";
import { StoredSessionMonitor } from "./stored-session-monitor";
import {
  TerminalWrapperRegistry,
  type TerminalWrapperFromDaemonMessage,
  type TerminalWrapperPromptState,
  type WrapperHelloMessage,
  type WrapperProviderBoundMessage,
  type WrapperReadyMessage,
} from "./terminal-wrapper-control";
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
  private readonly terminalWrappers = new TerminalWrapperRegistry();
  private readonly terminalWrapperSenders = new Map<
    string,
    (message: TerminalWrapperFromDaemonMessage) => void
  >();
  private readonly closingTerminalWrapperSessionIds = new Set<string>();

  private readonly adaptersById = new Map<string, ProviderAdapter>();
  private readonly adaptersByProvider = new Map<string, ProviderAdapter>();
  private readonly sessionOwners = new Map<string, ProviderAdapter>();
  private readonly independentTerminals = new Map<string, {
    id: string;
    cwd: string;
    shell: string;
    process: IndependentTerminalProcess;
  }>();

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
    const providers: ProviderKind[] = ["codex", "claude", "kimi", "gemini", "opencode"];
    return Promise.all(
      providers.map(async (provider) => {
        const adapter = this.adaptersByProvider.get(provider);
        if (adapter?.getProviderDiagnostic) {
          return await adapter.getProviderDiagnostic(options);
        }
        const launchSpec = launchSpecForProvider(provider);
        if (launchSpec) {
          return await probeProviderDiagnostic(provider, launchSpec, options);
        }
        return {
          provider,
          status: "launch_error" as const,
          launchCommand: "",
          detail: "Provider adapter is not implemented yet in this runtime.",
          auth: "provider_managed" as const,
          versionStatus: "unknown" as const,
        };
      }),
    );
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
    this.pruneOrphanSessions();
    const adapter = this.requireAdapterForProvider(request.provider);
    const response = await adapter.startSession(request);
    this.rememberSessionOwner(response.session.session.id, adapter);
    return response;
  }

  async resumeSession(request: ResumeSessionRequest): Promise<ResumeSessionResponse> {
    this.pruneOrphanSessions();
    const adapter = this.requireAdapterForProvider(request.provider);
    const response = await adapter.resumeSession(request);
    this.rememberSessionOwner(response.session.session.id, adapter);
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

  attachSession(sessionId: string, request: AttachSessionRequest): AttachSessionResponse {
    const state = this.sessionStore.attachClient({
      sessionId,
      clientId: request.client.id,
      kind: request.client.kind,
      connectionId: request.client.connectionId,
      attachMode: request.mode,
      focus: true,
    });

    this.eventBus.publish({
      sessionId,
      type: "session.attached",
      source: SYSTEM_SOURCE,
      payload: {
        clientId: request.client.id,
        clientKind: request.client.kind,
      },
    });

    if (request.claimControl) {
      this.claimControl(sessionId, { client: request.client });
    }

    return { session: toSessionSummary(state) };
  }

  claimControl(sessionId: string, request: ClaimControlRequest): SessionSummary {
    const state = this.sessionStore.attachClient({
      sessionId,
      clientId: request.client.id,
      kind: request.client.kind,
      connectionId: request.client.connectionId,
      attachMode: "interactive",
      focus: true,
    });
    this.sessionStore.claimControl(sessionId, request.client.id, request.client.kind);
    this.eventBus.publish({
      sessionId,
      type: "control.claimed",
      source: SYSTEM_SOURCE,
      payload: {
        clientId: request.client.id,
        clientKind: request.client.kind,
      },
    });
    return toSessionSummary(state);
  }

  releaseControl(sessionId: string, request: ReleaseControlRequest): SessionSummary {
    const state = this.sessionStore.releaseControl(sessionId, request.clientId);
    this.eventBus.publish({
      sessionId,
      type: "control.released",
      source: SYSTEM_SOURCE,
      payload: {
        clientId: request.clientId,
      },
    });
    return toSessionSummary(state);
  }

  renameSession(sessionId: string, title: string): SessionSummary {
    const nextTitle = title.trim();
    if (!nextTitle) {
      throw new Error("Session title is required.");
    }
    const state = this.sessionStore.patchManagedSession(sessionId, { title: nextTitle });
    this.workbenchState.rememberSession(state);
    this.refreshRememberedState();
    this.publishStoredSessionDiscovery();
    return toSessionSummary(state);
  }

  sendInput(sessionId: string, request: { clientId: string; text: string }): void {
    const wrapper = this.terminalWrappers.get(sessionId);
    if (wrapper) {
      const queuedTurn = this.terminalWrappers.enqueueRemoteTurn(
        sessionId,
        request.clientId,
        request.text,
      );
      const sender = this.terminalWrapperSenders.get(sessionId);
      if (sender) {
        if (wrapper.promptState === "prompt_clean") {
          const injectable = this.terminalWrappers.dequeueInjectableTurn(sessionId);
          if (injectable) {
            sender({ type: "turn.inject", sessionId, queuedTurn: injectable });
          }
        } else {
          sender({ type: "turn.enqueue", sessionId, queuedTurn });
        }
      }
      return;
    }
    this.requireSessionAdapter(sessionId).sendInput(sessionId, request);
  }

  interruptSession(
    sessionId: string,
    request: InterruptSessionRequest,
  ): SessionSummary {
    if (this.terminalWrappers.get(sessionId)) {
      this.terminalWrapperSenders.get(sessionId)?.({
        type: "turn.interrupt",
        sessionId,
        sourceSurfaceId: request.clientId,
      });
      return this.getSessionSummary(sessionId);
    }
    return this.requireSessionAdapter(sessionId).interruptSession(sessionId, request);
  }

  async closeSession(sessionId: string, request: CloseSessionRequest): Promise<void> {
    const state = this.sessionStore.getSession(sessionId);
    if (!state) {
      throw new Error(`Unknown session ${sessionId}`);
    }
    if (!this.sessionStore.hasAttachedClient(sessionId, request.clientId)) {
      throw new Error(`Client ${request.clientId} is not attached to ${sessionId}.`);
    }
    this.workbenchState.rememberSession(state);
    this.refreshRememberedState();
    if (this.terminalWrappers.get(sessionId)) {
      this.closingTerminalWrapperSessionIds.add(sessionId);
      this.sessionStore.setRuntimeState(sessionId, "stopped");
      this.terminalWrapperSenders.get(sessionId)?.({
        type: "wrapper.close",
        sessionId,
      });
      this.eventBus.publish({
        sessionId,
        type: "session.closed",
        source: SYSTEM_SOURCE,
        payload: {
          clientId: request.clientId,
        },
      });
      return;
    }
    const adapter = this.requireSessionAdapter(sessionId);
    await adapter.closeSession?.(sessionId, request);
    this.sessionStore.removeSession(sessionId);
    this.ptyHub.removeSession(sessionId);
    this.historySnapshots.clear(sessionId);
    this.sessionOwners.delete(sessionId);
    this.eventBus.publish({
      sessionId,
      type: "session.closed",
      source: SYSTEM_SOURCE,
      payload: {
        clientId: request.clientId,
      },
    });
  }

  detachSession(sessionId: string, request: DetachSessionRequest): SessionSummary {
    const state = this.sessionStore.detachClient(sessionId, request.clientId);
    this.eventBus.publish({
      sessionId,
      type: "session.detached",
      source: SYSTEM_SOURCE,
      payload: {
        clientId: request.clientId,
      },
    });
    return toSessionSummary(state);
  }

  async respondToPermission(
    sessionId: string,
    requestId: string,
    response: PermissionResponseRequest,
  ): Promise<void> {
    if (this.terminalWrappers.get(sessionId)) {
      this.terminalWrapperSenders.get(sessionId)?.({
        type: "permission.resolve",
        sessionId,
        requestId,
        response,
      });
      return;
    }
    const adapter = this.requireSessionAdapter(sessionId);
    if (!adapter.respondToPermission) {
      throw new Error(`Provider ${adapter.id} does not support permission responses.`);
    }
    await adapter.respondToPermission(sessionId, requestId, response);
  }

  onPtyInput(sessionId: string, clientId: string, data: string): void {
    const terminal = this.independentTerminals.get(sessionId);
    if (terminal) {
      void clientId;
      terminal.process.write(data);
      return;
    }
    this.requireSessionAdapter(sessionId).onPtyInput(sessionId, clientId, data);
  }

  onPtyResize(sessionId: string, clientId: string, cols: number, rows: number): void {
    const terminal = this.independentTerminals.get(sessionId);
    if (terminal) {
      void clientId;
      terminal.process.resize(cols, rows);
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

  getGitStatus(sessionId: string, options?: { scopeRoot?: string }) {
    const scopeRoot = this.workspaceScopeAuthorizer.resolveAuthorizedSessionScopeRoot(
      sessionId,
      options?.scopeRoot,
    );
    return this.requireSessionAdapter(sessionId).getGitStatus(sessionId, {
      ...(scopeRoot ? { scopeRoot } : {}),
    });
  }

  getGitDiff(
    sessionId: string,
    path: string,
    options?: { staged?: boolean; ignoreWhitespace?: boolean; scopeRoot?: string },
  ) {
    const scopeRoot = this.workspaceScopeAuthorizer.resolveAuthorizedSessionScopeRoot(
      sessionId,
      options?.scopeRoot,
    );
    return this.requireSessionAdapter(sessionId).getGitDiff(sessionId, path, {
      ...(options?.staged !== undefined ? { staged: options.staged } : {}),
      ...(options?.ignoreWhitespace !== undefined
        ? { ignoreWhitespace: options.ignoreWhitespace }
        : {}),
      ...(scopeRoot ? { scopeRoot } : {}),
    });
  }

  getWorkspaceGitStatus(dir: string) {
    const workspaceDir = this.workspaceScopeAuthorizer.resolveAuthorizedWorkspaceDirectory(dir);
    return getWorkspaceGitStatus(workspaceDir, { scopeRoot: workspaceDir });
  }

  getWorkspaceGitDiff(
    dir: string,
    path: string,
    options?: { staged?: boolean; ignoreWhitespace?: boolean },
  ) {
    const workspaceDir = this.workspaceScopeAuthorizer.resolveAuthorizedWorkspaceDirectory(dir);
    return {
      sessionId: "",
      path,
      diff: getWorkspaceGitDiff(workspaceDir, path, { ...options, scopeRoot: workspaceDir }),
    };
  }

  applyGitFileAction(sessionId: string, request: GitFileActionRequest) {
    const adapter = this.requireSessionAdapter(sessionId);
    if (!adapter.applyGitFileAction) {
      throw new Error(`Provider ${adapter.id} does not support git file actions.`);
    }
    return adapter.applyGitFileAction(sessionId, request);
  }

  applyGitHunkAction(sessionId: string, request: GitHunkActionRequest) {
    const adapter = this.requireSessionAdapter(sessionId);
    if (!adapter.applyGitHunkAction) {
      throw new Error(`Provider ${adapter.id} does not support git hunk actions.`);
    }
    return adapter.applyGitHunkAction(sessionId, request);
  }

  readSessionFile(sessionId: string, path: string, options?: { scopeRoot?: string }) {
    const scopeRoot = this.workspaceScopeAuthorizer.resolveAuthorizedSessionScopeRoot(
      sessionId,
      options?.scopeRoot,
    );
    return this.requireSessionAdapter(sessionId).readSessionFile(sessionId, path, {
      ...(scopeRoot ? { scopeRoot } : {}),
    });
  }

  readWorkspaceFile(dir: string, path: string) {
    const workspaceDir = this.workspaceScopeAuthorizer.resolveAuthorizedWorkspaceDirectory(dir);
    return readWorkspaceFileFromDirectory(workspaceDir, path, { scopeRoot: workspaceDir });
  }

  searchSessionFiles(
    sessionId: string,
    query: string,
    limit = 100,
    options?: { scopeRoot?: string },
  ): SessionFileSearchResponse {
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
      files: searchWorkspaceFilesInDirectory(scopeRoot ?? session.cwd, query, limit),
    };
  }

  searchWorkspaceFiles(dir: string, query: string, limit = 100): SessionFileSearchResponse {
    const workspaceDir = this.workspaceScopeAuthorizer.resolveAuthorizedWorkspaceDirectory(dir);
    return {
      sessionId: "",
      query,
      files: searchWorkspaceFilesInDirectory(workspaceDir, query, limit),
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
    const adapter = this.adaptersById.get("debug");
    return adapter?.listDebugScenarios?.() ?? [];
  }

  startScenario(args: {
    scenarioId: string;
    attach?: AttachSessionRequest;
  }): StartSessionResponse {
    const adapter = this.adaptersById.get("debug");
    if (!adapter?.startDebugScenario) {
      throw new Error("No debug adapter registered.");
    }
    const response = adapter.startDebugScenario(args);
    this.rememberSessionOwner(response.session.session.id, adapter);
    return response;
  }

  buildScenarioReplayScript(scenarioId: string): DebugReplayScript {
    const adapter = this.adaptersById.get("debug");
    if (!adapter?.buildDebugScenarioReplayScript) {
      throw new Error("No debug adapter registered.");
    }
    return adapter.buildDebugScenarioReplayScript(scenarioId);
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
    const requestedCwd = resolveUserPath(request?.cwd || "~");
    let cwd = requestedCwd;
    try {
      const directoryStat = await stat(requestedCwd);
      if (!directoryStat.isDirectory()) {
        cwd = resolveUserPath("~");
      }
    } catch {
      cwd = resolveUserPath("~");
    }
    const id = crypto.randomUUID();
    this.ptyHub.ensureSession(id);
    const process = new IndependentTerminalProcess({
      cwd,
      ...(request?.cols !== undefined ? { cols: request.cols } : {}),
      ...(request?.rows !== undefined ? { rows: request.rows } : {}),
      onData: (data) => {
        this.ptyHub.appendOutput(id, data);
      },
      onExit: (args) => {
        this.ptyHub.emitExit(id, args.exitCode, args.signal);
        this.independentTerminals.delete(id);
      },
    });
    try {
      await process.waitUntilReady();
    } catch (error) {
      await process.close().catch(() => undefined);
      this.ptyHub.removeSession(id);
      throw error;
    }
    this.independentTerminals.set(id, {
      id,
      cwd,
      shell: process.shell,
      process,
    });
    const terminal: IndependentTerminalSession = {
      id,
      cwd,
      shell: process.shell,
    };
    return { terminal };
  }

  async closeIndependentTerminal(id: string): Promise<void> {
    const terminal = this.independentTerminals.get(id);
    if (!terminal) {
      return;
    }
    this.independentTerminals.delete(id);
    await terminal.process.close();
    this.ptyHub.removeSession(id);
  }

  registerTerminalWrapperSession(
    request: WrapperHelloMessage,
    sendMessage: (message: TerminalWrapperFromDaemonMessage) => void,
  ): WrapperReadyMessage {
    const state = this.sessionStore.createManagedSession({
      provider: request.provider,
      ...(request.resumeProviderSessionId
        ? { providerSessionId: request.resumeProviderSessionId }
        : {}),
      launchSource: "terminal",
      cwd: request.cwd,
      rootDir: request.rootDir,
      title: `${request.provider} terminal session`,
      preview: request.launchCommand.join(" "),
      capabilities: {
        steerInput: true,
        queuedInput: true,
      },
    });
    this.ptyHub.ensureSession(state.session.id);
    this.sessionStore.setRuntimeState(state.session.id, "running");
    this.eventBus.publish({
      sessionId: state.session.id,
      type: "session.created",
      source: SYSTEM_SOURCE,
      payload: { session: state.session },
    });
    this.eventBus.publish({
      sessionId: state.session.id,
      type: "session.started",
      source: SYSTEM_SOURCE,
      payload: { session: state.session },
    });

    const surfaceId = `terminal:${request.terminalPid}:${crypto.randomUUID()}`;
    const operatorGroupId = `terminal-group:${state.session.id}`;
    this.terminalWrappers.register({
      sessionId: state.session.id,
      provider: request.provider,
      cwd: request.cwd,
      rootDir: request.rootDir,
      terminalPid: request.terminalPid,
      launchCommand: request.launchCommand,
      surfaceId,
      operatorGroupId,
      promptState: "agent_busy",
      ...(request.resumeProviderSessionId
        ? { resumeProviderSessionId: request.resumeProviderSessionId }
        : {}),
    });
    this.terminalWrapperSenders.set(state.session.id, sendMessage);
    this.sessionStore.attachClient({
      sessionId: state.session.id,
      clientId: surfaceId,
      kind: "terminal",
      connectionId: surfaceId,
      attachMode: "interactive",
      focus: true,
    });
    this.sessionStore.claimControl(state.session.id, surfaceId, "terminal");
    this.eventBus.publish({
      sessionId: state.session.id,
      type: "session.attached",
      source: SYSTEM_SOURCE,
      payload: {
        clientId: surfaceId,
        clientKind: "terminal",
      },
    });
    this.eventBus.publish({
      sessionId: state.session.id,
      type: "control.claimed",
      source: SYSTEM_SOURCE,
      payload: {
        clientId: surfaceId,
        clientKind: "terminal",
      },
    });
    return {
      type: "wrapper.ready",
      sessionId: state.session.id,
      surfaceId,
      operatorGroupId,
    };
  }

  disconnectTerminalWrapperSession(sessionId: string): void {
    if (!this.terminalWrappers.get(sessionId)) {
      this.terminalWrapperSenders.delete(sessionId);
      return;
    }
    void this.markTerminalWrapperExited(sessionId);
  }

  bindTerminalWrapperProviderSession(message: WrapperProviderBoundMessage): void {
    if (
      this.closingTerminalWrapperSessionIds.has(message.sessionId) ||
      !this.terminalWrappers.get(message.sessionId) ||
      !this.sessionStore.getSession(message.sessionId)
    ) {
      return;
    }
    const update = this.terminalWrappers.bindProviderSession({
      sessionId: message.sessionId,
      providerSessionId: message.providerSessionId,
      ...(message.providerTitle !== undefined ? { providerTitle: message.providerTitle } : {}),
      ...(message.providerPreview !== undefined ? { providerPreview: message.providerPreview } : {}),
      ...(message.reason !== undefined ? { reason: message.reason } : {}),
    });
    if (!update.changed) {
      return;
    }
    const isRebind =
      update.previousProviderSessionId !== undefined &&
      update.previousProviderSessionId !== message.providerSessionId;
    this.sessionStore.patchManagedSession(message.sessionId, {
      providerSessionId: message.providerSessionId,
      ...(message.providerTitle !== undefined ? { title: message.providerTitle } : {}),
      ...(message.providerPreview !== undefined ? { preview: message.providerPreview } : {}),
    });
    if (isRebind) {
      this.sessionStore.setActiveTurn(message.sessionId);
      this.sessionStore.updateUsage(message.sessionId, undefined);
      this.sessionStore.setRuntimeState(message.sessionId, "idle");
      this.historySnapshots.clear(message.sessionId);
    }
    const state = this.sessionStore.getSession(message.sessionId);
    if (state) {
      this.eventBus.publish({
        sessionId: message.sessionId,
        type: "session.started",
        source: SYSTEM_SOURCE,
        payload: { session: state.session },
      });
    }
    if (
      !isRebind &&
      update.binding.resumeProviderSessionId &&
      update.binding.resumeProviderSessionId !== message.providerSessionId
    ) {
      throw new Error(
        `Wrapper bound provider session ${message.providerSessionId} but expected ${update.binding.resumeProviderSessionId}.`,
      );
    }
  }

  updateTerminalWrapperPromptState(
    sessionId: string,
    promptState: TerminalWrapperPromptState,
  ): void {
    const existingState = this.sessionStore.getSession(sessionId);
    if (
      this.closingTerminalWrapperSessionIds.has(sessionId) ||
      !this.terminalWrappers.get(sessionId) ||
      !existingState
    ) {
      return;
    }
    this.terminalWrappers.updatePromptState(sessionId, promptState);
    const nextRuntimeState = promptState === "agent_busy" ? "running" : "idle";
    if (existingState.session.runtimeState !== nextRuntimeState) {
      this.sessionStore.setRuntimeState(sessionId, nextRuntimeState);
      this.eventBus.publish({
        sessionId,
        type: "session.state.changed",
        source: SYSTEM_SOURCE,
        payload: {
          state: nextRuntimeState,
        },
      });
    }
    if (promptState !== "prompt_clean") {
      return;
    }
    const injectable = this.terminalWrappers.dequeueInjectableTurn(sessionId);
    if (injectable) {
      this.terminalWrapperSenders.get(sessionId)?.({
        type: "turn.inject",
        sessionId,
        queuedTurn: injectable,
      });
    }
  }

  applyTerminalWrapperActivity(sessionId: string, activity: ProviderActivity): RahEvent[] {
    if (this.closingTerminalWrapperSessionIds.has(sessionId)) {
      return [];
    }
    const session = this.sessionStore.getSession(sessionId)?.session;
    if (!session) {
      return [];
    }
    return applyProviderActivity(
      {
        eventBus: this.eventBus,
        ptyHub: this.ptyHub,
        sessionStore: this.sessionStore,
      },
      sessionId,
      {
        provider: session.provider,
        authority: "authoritative",
      },
      activity,
    );
  }

  appendTerminalWrapperPtyOutput(sessionId: string, data: string): RahEvent[] {
    if (
      this.closingTerminalWrapperSessionIds.has(sessionId) ||
      !this.sessionStore.getSession(sessionId)
    ) {
      return [];
    }
    return this.applyTerminalWrapperActivity(sessionId, {
      type: "terminal_output",
      data,
    });
  }

  markTerminalWrapperExited(
    sessionId: string,
    options?: { exitCode?: number; signal?: string },
  ): RahEvent[] {
    const state = this.sessionStore.getSession(sessionId);
    if (!state) {
      this.terminalWrapperSenders.delete(sessionId);
      this.terminalWrappers.remove(sessionId);
      this.closingTerminalWrapperSessionIds.delete(sessionId);
      return [];
    }
    const published = this.applyTerminalWrapperActivity(sessionId, {
      type: "terminal_exited",
      ...(options?.exitCode !== undefined ? { exitCode: options.exitCode } : {}),
      ...(options?.signal !== undefined ? { signal: options.signal } : {}),
    });
    this.workbenchState.rememberSession(state);
    this.refreshRememberedState();
    this.terminalWrapperSenders.delete(sessionId);
    this.terminalWrappers.remove(sessionId);
    this.closingTerminalWrapperSessionIds.delete(sessionId);
    this.sessionStore.removeSession(sessionId);
    this.ptyHub.removeSession(sessionId);
    this.historySnapshots.clear(sessionId);
    this.sessionOwners.delete(sessionId);
    this.eventBus.publish({
      sessionId,
      type: "session.closed",
      source: SYSTEM_SOURCE,
      payload: {},
    });
    return published;
  }

  async shutdown(): Promise<void> {
    await this.storedSessionMonitor.shutdown();
    this.terminalWrapperSenders.clear();
    for (const terminal of this.independentTerminals.values()) {
      await terminal.process.close();
      this.ptyHub.removeSession(terminal.id);
    }
    this.independentTerminals.clear();
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
    const discovered = new Map<string, StoredSessionRef>();
    for (const adapter of this.adaptersById.values()) {
      const storedSessions =
        adapter.refreshStoredSessionsCatalog?.() ??
        adapter.listStoredSessions?.() ??
        [];
      for (const stored of storedSessions) {
        discovered.set(`${stored.provider}:${stored.providerSessionId}`, stored);
      }
    }
    return [...discovered.values()];
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
    if (left.length !== right.length) {
      return false;
    }
    return left.every((entry, index) => this.storedSessionRefKey(entry) === this.storedSessionRefKey(right[index]!));
  }

  private storedSessionRefKey(entry: StoredSessionRef): string {
    return JSON.stringify([
      entry.provider,
      entry.providerSessionId,
      entry.source ?? "provider_history",
      entry.cwd ?? "",
      entry.rootDir ?? "",
      entry.title ?? "",
      entry.preview ?? "",
      entry.updatedAt ?? "",
      entry.lastUsedAt ?? "",
    ]);
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
    const visibleLiveStates = liveStates.filter(
      (state) => !this.closingTerminalWrapperSessionIds.has(state.session.id),
    );
    const hiddenSessionKeys = new Set(this.rememberedHiddenSessionKeys);
    const availableProviderSessionKeys = new Set<string>();
    const discoveredByKey = new Map<string, StoredSessionRef>();
    for (const stored of discoveredStoredSessions) {
      const key = `${stored.provider}:${stored.providerSessionId}`;
      availableProviderSessionKeys.add(key);
      discoveredByKey.set(key, stored);
    }
    for (const state of visibleLiveStates) {
      if (!state.session.providerSessionId) {
        continue;
      }
      availableProviderSessionKeys.add(
        `${state.session.provider}:${state.session.providerSessionId}`,
      );
    }
    const storedSessions = new Map<string, StoredSessionRef>();
    for (const remembered of this.rememberedSessions) {
      const key = `${remembered.provider}:${remembered.providerSessionId}`;
      if (hiddenSessionKeys.has(key)) {
        continue;
      }
      if (
        remembered.source === "previous_live" &&
        !availableProviderSessionKeys.has(key)
      ) {
        continue;
      }
      storedSessions.set(key, remembered);
    }
    for (const stored of discoveredStoredSessions) {
      if (hiddenSessionKeys.has(`${stored.provider}:${stored.providerSessionId}`)) {
        continue;
      }
      storedSessions.set(`${stored.provider}:${stored.providerSessionId}`, stored);
    }
    for (const state of visibleLiveStates) {
      const providerSessionId = state.session.providerSessionId;
      if (!providerSessionId) {
        continue;
      }
      storedSessions.delete(`${state.session.provider}:${providerSessionId}`);
    }
    return {
      sessions: visibleLiveStates.map((state) => {
        const providerSessionId = state.session.providerSessionId;
        if (!providerSessionId) {
          return toSessionSummary(state);
        }
        const discovered = discoveredByKey.get(`${state.session.provider}:${providerSessionId}`);
        if (!discovered) {
          return toSessionSummary(state);
        }
        return toSessionSummary({
          ...state,
          session: {
            ...state.session,
            ...(discovered.title !== undefined ? { title: discovered.title } : {}),
            ...(discovered.preview !== undefined ? { preview: discovered.preview } : {}),
          },
        });
      }),
      storedSessions: [...storedSessions.values()],
      recentSessions: this.rememberedRecentSessions.filter(
        (session) => {
          const key = `${session.provider}:${session.providerSessionId}`;
          if (hiddenSessionKeys.has(key)) {
            return false;
          }
          if (
            session.source === "previous_live" &&
            !availableProviderSessionKeys.has(key)
          ) {
            return false;
          }
          return true;
        },
      ).map((session) => {
        const key = `${session.provider}:${session.providerSessionId}`;
        const discovered = discoveredByKey.get(key);
        if (!discovered) {
          return session;
        }
        const lastUsedAt = session.lastUsedAt ?? discovered.lastUsedAt ?? discovered.updatedAt;
        return {
          ...session,
          ...discovered,
          ...(lastUsedAt ? { lastUsedAt } : {}),
        };
      }),
      workspaceDirs: workspaceDirsFromState(this.rememberedWorkspaceDirs, liveStates),
      hiddenWorkspaces: [...this.rememberedHiddenWorkspaces],
      ...(this.rememberedActiveWorkspaceDir
        ? { activeWorkspaceDir: this.rememberedActiveWorkspaceDir }
        : {}),
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
      this.terminalWrappers.remove(state.session.id);
      this.terminalWrapperSenders.delete(state.session.id);
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

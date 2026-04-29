import type {
  AttachSessionRequest,
  CloseSessionRequest,
  ContextUsage,
  DebugScenarioDescriptor,
  DebugReplayScript,
  GitDiffResponse,
  GitFileActionRequest,
  GitFileActionResponse,
  GitHunkActionRequest,
  GitHunkActionResponse,
  GitStatusResponse,
  InterruptSessionRequest,
  ProviderDiagnostic,
  PermissionResponseRequest,
  ProviderModelCatalog,
  ResumeSessionRequest,
  ResumeSessionResponse,
  SetSessionModelRequest,
  SessionFileResponse,
  SessionHistoryPageResponse,
  SessionInputRequest,
  SessionSummary,
  StartSessionRequest,
  StartSessionResponse,
  StoredSessionRef,
  WorkspaceSnapshotResponse,
  ManagedSession,
} from "@rah/runtime-protocol";
import type { EventBus } from "./event-bus";
import type { FrozenHistoryPageLoader } from "./history-snapshots";
import type { PtyHub } from "./pty-hub";
import type { SessionStore } from "./session-store";
import type { WorkbenchStateStore } from "./workbench-state";

export interface RuntimeServices {
  eventBus: EventBus;
  ptyHub: PtyHub;
  sessionStore: SessionStore;
  workbenchState?: WorkbenchStateStore;
}

export interface StartDebugScenarioRequest {
  scenarioId: string;
  attach?: AttachSessionRequest;
}

export interface ProviderAdapterIdentity {
  readonly id: string;
  readonly providers: ManagedSession["provider"][];
}

export interface ProviderLifecycleAdapter {
  /**
   * Start/resume requests carry RAH-level model/mode ids. Adapters own all
   * translation into provider-native flags, config files, SDK parameters, or
   * permission rulesets.
   */
  startSession(request: StartSessionRequest): StartSessionResponse | Promise<StartSessionResponse>;
  resumeSession(request: ResumeSessionRequest): ResumeSessionResponse | Promise<ResumeSessionResponse>;
  closeSession?(sessionId: string, request: CloseSessionRequest): Promise<void> | void;
  destroySession?(sessionId: string): Promise<void> | void;
}

export interface ProviderModeCapabilityAdapter {
  setSessionMode?(
    sessionId: string,
    modeId: string,
  ): SessionSummary | Promise<SessionSummary>;
}

export interface ProviderModelCapabilityAdapter {
  /**
   * Returns the provider catalog including adapter-owned mode descriptors. The
   * frontend must treat mode/model/config ids as opaque and submit them back.
   */
  listModels?(options?: {
    cwd?: string;
    forceRefresh?: boolean;
  }): ProviderModelCatalog | Promise<ProviderModelCatalog>;
  setSessionModel?(
    sessionId: string,
    request: SetSessionModelRequest,
  ): SessionSummary | Promise<SessionSummary>;
}

export interface ProviderActionCapabilityAdapter {
  renameSession?(
    sessionId: string,
    title: string,
  ): SessionSummary | Promise<SessionSummary>;
}

export interface ProviderInputControlAdapter {
  sendInput(sessionId: string, request: SessionInputRequest): void;
  interruptSession(sessionId: string, request: InterruptSessionRequest): SessionSummary;
  onPtyInput(sessionId: string, clientId: string, data: string): void;
  onPtyResize(sessionId: string, clientId: string, cols: number, rows: number): void;
}

export interface ProviderPermissionCapabilityAdapter {
  respondToPermission?(
    sessionId: string,
    requestId: string,
    response: PermissionResponseRequest,
  ): Promise<void> | void;
}

export interface ProviderWorkspaceCapabilityAdapter {
  getWorkspaceSnapshot(
    sessionId: string,
    options?: { scopeRoot?: string },
  ): WorkspaceSnapshotResponse;
  getGitStatus(
    sessionId: string,
    options?: { scopeRoot?: string },
  ): GitStatusResponse | Promise<GitStatusResponse>;
  getGitDiff(
    sessionId: string,
    path: string,
    options?: { staged?: boolean; ignoreWhitespace?: boolean; scopeRoot?: string },
  ): GitDiffResponse | Promise<GitDiffResponse>;
  applyGitFileAction?(
    sessionId: string,
    request: GitFileActionRequest,
  ): GitFileActionResponse | Promise<GitFileActionResponse>;
  applyGitHunkAction?(
    sessionId: string,
    request: GitHunkActionRequest,
  ): GitHunkActionResponse | Promise<GitHunkActionResponse>;
  readSessionFile(
    sessionId: string,
    path: string,
    options?: { scopeRoot?: string },
  ): SessionFileResponse | Promise<SessionFileResponse>;
}

export interface ProviderStoredHistoryAdapter {
  getSessionHistoryPage?(
    sessionId: string,
    options?: { beforeTs?: string; cursor?: string; limit?: number },
  ): SessionHistoryPageResponse;
  createFrozenHistoryPageLoader?(sessionId: string): FrozenHistoryPageLoader | undefined;
  listStoredSessions?(): StoredSessionRef[];
  refreshStoredSessionsCatalog?(): StoredSessionRef[];
  listStoredSessionWatchRoots?(): string[];
  removeStoredSession?(session: StoredSessionRef): Promise<void> | void;
}

export interface ProviderContextCapabilityAdapter {
  getContextUsage(sessionId: string): ContextUsage | undefined;
}

export interface ProviderDiagnosticAdapter {
  getProviderDiagnostic?(options?: {
    forceRefresh?: boolean;
  }): Promise<ProviderDiagnostic> | ProviderDiagnostic;
}

export interface ProviderDebugAdapter {
  listDebugScenarios?(): DebugScenarioDescriptor[];
  startDebugScenario?(request: StartDebugScenarioRequest): StartSessionResponse;
  buildDebugScenarioReplayScript?(scenarioId: string): DebugReplayScript;
}

export interface ProviderShutdownAdapter {
  shutdown?(): Promise<void> | void;
}

export interface ProviderAdapter
  extends ProviderAdapterIdentity,
    ProviderLifecycleAdapter,
    ProviderModeCapabilityAdapter,
    ProviderModelCapabilityAdapter,
    ProviderActionCapabilityAdapter,
    ProviderInputControlAdapter,
    ProviderPermissionCapabilityAdapter,
    ProviderWorkspaceCapabilityAdapter,
    ProviderStoredHistoryAdapter,
    ProviderContextCapabilityAdapter,
    ProviderDiagnosticAdapter,
    ProviderDebugAdapter,
    ProviderShutdownAdapter {}

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
  ResumeSessionRequest,
  ResumeSessionResponse,
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

export interface RuntimeServices {
  eventBus: EventBus;
  ptyHub: PtyHub;
  sessionStore: SessionStore;
}

export interface StartDebugScenarioRequest {
  scenarioId: string;
  attach?: AttachSessionRequest;
}

export interface ProviderAdapter {
  readonly id: string;
  readonly providers: ManagedSession["provider"][];

  startSession(request: StartSessionRequest): StartSessionResponse | Promise<StartSessionResponse>;
  resumeSession(request: ResumeSessionRequest): ResumeSessionResponse | Promise<ResumeSessionResponse>;
  sendInput(sessionId: string, request: SessionInputRequest): void;
  closeSession?(sessionId: string, request: CloseSessionRequest): Promise<void> | void;
  destroySession?(sessionId: string): Promise<void> | void;
  interruptSession(sessionId: string, request: InterruptSessionRequest): SessionSummary;
  respondToPermission?(
    sessionId: string,
    requestId: string,
    response: PermissionResponseRequest,
  ): Promise<void> | void;
  onPtyInput(sessionId: string, clientId: string, data: string): void;
  onPtyResize(sessionId: string, clientId: string, cols: number, rows: number): void;
  getWorkspaceSnapshot(sessionId: string): WorkspaceSnapshotResponse;
  getGitStatus(sessionId: string): GitStatusResponse;
  getGitDiff(
    sessionId: string,
    path: string,
    options?: { staged?: boolean; ignoreWhitespace?: boolean },
  ): GitDiffResponse;
  applyGitFileAction?(
    sessionId: string,
    request: GitFileActionRequest,
  ): GitFileActionResponse | Promise<GitFileActionResponse>;
  applyGitHunkAction?(
    sessionId: string,
    request: GitHunkActionRequest,
  ): GitHunkActionResponse | Promise<GitHunkActionResponse>;
  readSessionFile(sessionId: string, path: string): SessionFileResponse;
  getSessionHistoryPage?(
    sessionId: string,
    options?: { beforeTs?: string; cursor?: string; limit?: number },
  ): SessionHistoryPageResponse;
  createFrozenHistoryPageLoader?(sessionId: string): FrozenHistoryPageLoader | undefined;
  getContextUsage(sessionId: string): ContextUsage | undefined;
  listStoredSessions?(): StoredSessionRef[];
  refreshStoredSessionsCatalog?(): StoredSessionRef[];
  listStoredSessionWatchRoots?(): string[];
  removeStoredSession?(session: StoredSessionRef): Promise<void> | void;
  getProviderDiagnostic?(options?: {
    forceRefresh?: boolean;
  }): Promise<ProviderDiagnostic> | ProviderDiagnostic;

  listDebugScenarios?(): DebugScenarioDescriptor[];
  startDebugScenario?(request: StartDebugScenarioRequest): StartSessionResponse;
  buildDebugScenarioReplayScript?(scenarioId: string): DebugReplayScript;
  shutdown?(): Promise<void> | void;
}

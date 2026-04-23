import type {
  CloseSessionRequest,
  DebugScenarioDescriptor,
  GitHunkActionRequest,
  GitHunkActionResponse,
  ManagedSession,
  ResumeSessionRequest,
  ResumeSessionResponse,
  SessionInputRequest,
  StartSessionRequest,
  StartSessionResponse,
  WorkspaceSnapshotResponse,
  GitStatusResponse,
  GitDiffResponse,
  ContextUsage,
  DebugReplayScript,
  InterruptSessionRequest,
  SessionFileResponse,
  SessionSummary,
  StoredSessionRef,
} from "@rah/runtime-protocol";
import { DebugEngine } from "./debug-engine";
import { DEBUG_STORED_SESSIONS } from "./debug-stored-sessions";
import type {
  ProviderAdapter,
  RuntimeServices,
  StartDebugScenarioRequest,
} from "./provider-adapter";

const DEBUG_PROVIDERS: ManagedSession["provider"][] = [
  "claude",
  "kimi",
  "gemini",
  "opencode",
  "custom",
];

export class DebugAdapter implements ProviderAdapter {
  readonly id = "debug";
  readonly providers = DEBUG_PROVIDERS;

  private readonly engine: DebugEngine;

  constructor(services: RuntimeServices) {
    this.engine = new DebugEngine({
      ...services,
      storedSessions: DEBUG_STORED_SESSIONS,
    });
  }

  startSession(request: StartSessionRequest): StartSessionResponse {
    return this.engine.startSession(request);
  }

  resumeSession(request: ResumeSessionRequest): ResumeSessionResponse {
    return this.engine.resumeSession(request);
  }

  sendInput(sessionId: string, request: SessionInputRequest): void {
    this.engine.sendInput(sessionId, request);
  }

  closeSession(sessionId: string, request: CloseSessionRequest): void {
    this.engine.closeSession(sessionId, request);
  }

  destroySession(sessionId: string): void {
    this.engine.destroySession(sessionId);
  }

  interruptSession(sessionId: string, request: InterruptSessionRequest): SessionSummary {
    return this.engine.interruptSession(sessionId, request);
  }

  onPtyInput(sessionId: string, clientId: string, data: string): void {
    this.engine.onPtyInput(sessionId, clientId, data);
  }

  onPtyResize(sessionId: string, clientId: string, cols: number, rows: number): void {
    this.engine.onPtyResize(sessionId, clientId, cols, rows);
  }

  getWorkspaceSnapshot(
    sessionId: string,
    options?: { scopeRoot?: string },
  ): WorkspaceSnapshotResponse {
    return this.engine.getWorkspaceSnapshot(sessionId, options);
  }

  getGitStatus(sessionId: string, options?: { scopeRoot?: string }): GitStatusResponse {
    return this.engine.getGitStatus(sessionId, options);
  }

  getGitDiff(
    sessionId: string,
    path: string,
    options?: { staged?: boolean; ignoreWhitespace?: boolean; scopeRoot?: string },
  ): GitDiffResponse {
    return this.engine.getGitDiff(sessionId, path, options);
  }

  applyGitHunkAction(
    _sessionId: string,
    _request: GitHunkActionRequest,
  ): GitHunkActionResponse {
    throw new Error("Debug sessions do not support git hunk actions.");
  }

  readSessionFile(
    sessionId: string,
    path: string,
    options?: { scopeRoot?: string },
  ): SessionFileResponse {
    return this.engine.readSessionFile(sessionId, path, options);
  }

  getContextUsage(sessionId: string): ContextUsage | undefined {
    return this.engine.getContextUsage(sessionId);
  }

  listStoredSessions(): StoredSessionRef[] {
    return [...DEBUG_STORED_SESSIONS];
  }

  listDebugScenarios(): DebugScenarioDescriptor[] {
    return this.engine.listScenarios();
  }

  startDebugScenario(request: StartDebugScenarioRequest): StartSessionResponse {
    return this.engine.startScenario(request);
  }

  buildDebugScenarioReplayScript(scenarioId: string): DebugReplayScript {
    return this.engine.buildScenarioReplayScript(scenarioId);
  }
}

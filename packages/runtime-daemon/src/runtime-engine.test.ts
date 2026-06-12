import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  CloseSessionRequest,
  ContextUsage,
  GitDiffResponse,
  GitHunkActionRequest,
  GitHunkActionResponse,
  GitStatusResponse,
  InterruptSessionRequest,
  PermissionResponseRequest,
  ProviderKind,
  RahEvent,
  ResumeSessionRequest,
  ResumeSessionResponse,
  SessionFileResponse,
  SessionHistoryPageResponse,
  SessionInputRequest,
  SetSessionModelRequest,
  SessionSummary,
  StartSessionRequest,
  StartSessionResponse,
  StoredSessionRef,
  WorkspaceSnapshotResponse,
} from "@rah/runtime-protocol";
import { RuntimeEngine } from "./runtime-engine";
import { toSessionSummary } from "./session-store";
import type { ProviderAdapter } from "./provider-adapter";
import type { FrozenHistoryBoundary, FrozenHistoryPageLoader } from "./history-snapshots";
import { discoverCodexStoredSessions } from "./codex-stored-sessions";

const hasSqlite = (() => {
  try {
    execFileSync("sqlite3", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

class CountingStoredSessionsAdapter implements ProviderAdapter {
  readonly id: string = "counting";
  readonly providers: ProviderKind[] = ["codex"];
  storedSessionCalls = 0;
  removedSessionIds: string[] = [];

  constructor(private readonly storedSessions: StoredSessionRef[]) {}

  listStoredSessions(): StoredSessionRef[] {
    this.storedSessionCalls += 1;
    return [...this.storedSessions];
  }

  listStoredSessionWatchRoots(): string[] {
    return [];
  }

  async removeStoredSession(session: StoredSessionRef): Promise<void> {
    this.removedSessionIds.push(session.providerSessionId);
  }

  startSession(_request: StartSessionRequest): StartSessionResponse | Promise<StartSessionResponse> {
    throw new Error("not implemented");
  }

  resumeSession(_request: ResumeSessionRequest): ResumeSessionResponse | Promise<ResumeSessionResponse> {
    throw new Error("not implemented");
  }

  sendInput(_sessionId: string, _request: SessionInputRequest): void {
    throw new Error("not implemented");
  }

  closeSession?(_sessionId: string, _request: CloseSessionRequest): Promise<void> | void {
    throw new Error("not implemented");
  }

  interruptSession(_sessionId: string, _request: InterruptSessionRequest): SessionSummary {
    throw new Error("not implemented");
  }

  respondToPermission?(
    _sessionId: string,
    _requestId: string,
    _response: PermissionResponseRequest,
  ): Promise<void> | void {
    throw new Error("not implemented");
  }

  onPtyInput(_sessionId: string, _clientId: string, _data: string): void {
    throw new Error("not implemented");
  }

  onPtyResize(_sessionId: string, _clientId: string, _cols: number, _rows: number): void {
    throw new Error("not implemented");
  }

  getWorkspaceSnapshot(_sessionId: string): WorkspaceSnapshotResponse {
    throw new Error("not implemented");
  }

  getGitStatus(_sessionId: string): GitStatusResponse {
    throw new Error("not implemented");
  }

  getGitDiff(
    _sessionId: string,
    _path: string,
    _options?: { staged?: boolean; ignoreWhitespace?: boolean },
  ): GitDiffResponse {
    throw new Error("not implemented");
  }

  applyGitHunkAction(
    _sessionId: string,
    _request: GitHunkActionRequest,
  ): GitHunkActionResponse {
    throw new Error("not implemented");
  }

  readSessionFile(_sessionId: string, _path: string): SessionFileResponse {
    throw new Error("not implemented");
  }

  getSessionHistoryPage?(
    _sessionId: string,
    _options?: { beforeTs?: string; cursor?: string; limit?: number },
  ): SessionHistoryPageResponse {
    throw new Error("not implemented");
  }

  getContextUsage(_sessionId: string): ContextUsage | undefined {
    return undefined;
  }
}

class CloseRefreshStoredSessionsAdapter extends CountingStoredSessionsAdapter {
  override readonly id = "close-refresh";
  engine: RuntimeEngine | undefined;
  private refreshedSessions: StoredSessionRef[] = [];

  constructor() {
    super([]);
  }

  override listStoredSessions(): StoredSessionRef[] {
    this.storedSessionCalls += 1;
    return [...this.refreshedSessions];
  }

  override startSession(request: StartSessionRequest): StartSessionResponse {
    if (!this.engine) {
      throw new Error("engine missing");
    }
    let state = this.engine.sessionStore.createManagedSession({
      provider: "codex",
      providerSessionId: "closed-provider-session",
      launchSource: "web",
      cwd: request.cwd,
      rootDir: request.cwd,
      title: "Closing session",
    });
    if (request.attach) {
      state = this.engine.sessionStore.attachClient({
        sessionId: state.session.id,
        clientId: request.attach.client.id,
        kind: request.attach.client.kind,
        connectionId: request.attach.client.connectionId,
        attachMode: request.attach.mode,
        focus: true,
      });
      if (request.attach.claimControl) {
        state = this.engine.sessionStore.claimControl(
          state.session.id,
          request.attach.client.id,
          request.attach.client.kind,
        );
      }
    }
    return { session: toSessionSummary(state) };
  }

  override async closeSession(sessionId: string, _request: CloseSessionRequest): Promise<void> {
    if (!this.engine) {
      throw new Error("engine missing");
    }
    const state = this.engine.sessionStore.getSession(sessionId);
    if (!state?.session.providerSessionId) {
      throw new Error("session missing provider session id");
    }
    this.refreshedSessions = [
      {
        provider: "codex",
        providerSessionId: state.session.providerSessionId,
        cwd: state.session.cwd,
        rootDir: state.session.rootDir,
        ...(state.session.title ? { title: state.session.title } : {}),
        createdAt: state.session.createdAt,
        updatedAt: "2026-06-12T10:00:00.000Z",
        lastUsedAt: "2026-06-12T10:00:00.000Z",
        historyMeta: {
          lines: 12,
          bytes: 512,
        },
        source: "provider_history",
      },
    ];
  }
}

class RenameStoredSessionsAdapter extends CountingStoredSessionsAdapter {
  override readonly id = "rename-stored-sessions";
  engine: RuntimeEngine | undefined;

  constructor() {
    super([
      {
        provider: "codex",
        providerSessionId: "rename-provider-session",
        cwd: workDirGlobal,
        rootDir: workDirGlobal,
        title: "Old history title",
        updatedAt: "2025-07-19T22:21:00.000Z",
        source: "provider_history",
      },
    ]);
  }

  override startSession(request: StartSessionRequest): StartSessionResponse {
    if (!this.engine) {
      throw new Error("engine missing");
    }
    const state = this.engine.sessionStore.createManagedSession({
      provider: "codex",
      providerSessionId: "rename-provider-session",
      launchSource: "web",
      cwd: request.cwd,
      rootDir: request.cwd,
      title: "Old live title",
      ...(request.origin ? { origin: request.origin } : {}),
      capabilities: {
        renameSession: true,
        actions: {
          info: true,
          stop: true,
          delete: true,
          rename: "native",
        },
      },
    });
    return { session: toSessionSummary(state) };
  }

  async renameSession(sessionId: string, title: string): Promise<SessionSummary> {
    if (!this.engine) {
      throw new Error("engine missing");
    }
    return toSessionSummary(
      this.engine.sessionStore.patchManagedSession(sessionId, { title }),
    );
  }
}

class GeminiStoredSessionsProbeAdapter extends CountingStoredSessionsAdapter {
  override readonly id = "gemini-stored-sessions-probe";
  override readonly providers: Array<"gemini"> = ["gemini"];

  constructor() {
    super([]);
  }
}

class WatchingStoredSessionsAdapter implements ProviderAdapter {
  readonly id = "watching";
  readonly providers: Array<"codex"> = ["codex"];
  storedSessions: StoredSessionRef[];
  storedSessionCalls = 0;

  constructor(
    initialStoredSessions: StoredSessionRef[],
    private readonly watchRoot: string,
  ) {
    this.storedSessions = initialStoredSessions;
  }

  listStoredSessions(): StoredSessionRef[] {
    this.storedSessionCalls += 1;
    return [...this.storedSessions];
  }

  listStoredSessionWatchRoots(): string[] {
    return [this.watchRoot];
  }

  startSession(_request: StartSessionRequest): StartSessionResponse | Promise<StartSessionResponse> {
    throw new Error("not implemented");
  }

  resumeSession(_request: ResumeSessionRequest): ResumeSessionResponse | Promise<ResumeSessionResponse> {
    throw new Error("not implemented");
  }

  sendInput(_sessionId: string, _request: SessionInputRequest): void {
    throw new Error("not implemented");
  }

  closeSession?(_sessionId: string, _request: CloseSessionRequest): Promise<void> | void {
    throw new Error("not implemented");
  }

  interruptSession(_sessionId: string, _request: InterruptSessionRequest): SessionSummary {
    throw new Error("not implemented");
  }

  respondToPermission?(
    _sessionId: string,
    _requestId: string,
    _response: PermissionResponseRequest,
  ): Promise<void> | void {
    throw new Error("not implemented");
  }

  onPtyInput(_sessionId: string, _clientId: string, _data: string): void {
    throw new Error("not implemented");
  }

  onPtyResize(_sessionId: string, _clientId: string, _cols: number, _rows: number): void {
    throw new Error("not implemented");
  }

  getWorkspaceSnapshot(_sessionId: string): WorkspaceSnapshotResponse {
    throw new Error("not implemented");
  }

  getGitStatus(_sessionId: string): GitStatusResponse {
    throw new Error("not implemented");
  }

  getGitDiff(
    _sessionId: string,
    _path: string,
    _options?: { staged?: boolean; ignoreWhitespace?: boolean },
  ): GitDiffResponse {
    throw new Error("not implemented");
  }

  applyGitHunkAction(
    _sessionId: string,
    _request: GitHunkActionRequest,
  ): GitHunkActionResponse {
    throw new Error("not implemented");
  }

  readSessionFile(_sessionId: string, _path: string): SessionFileResponse {
    throw new Error("not implemented");
  }

  getSessionHistoryPage?(
    _sessionId: string,
    _options?: { beforeTs?: string; cursor?: string; limit?: number },
  ): SessionHistoryPageResponse {
    throw new Error("not implemented");
  }

  getContextUsage(_sessionId: string): ContextUsage | undefined {
    return undefined;
  }
}

class FailingRemovalStoredSessionsAdapter extends CountingStoredSessionsAdapter {
  override async removeStoredSession(_session: StoredSessionRef): Promise<void> {
    throw new Error("provider trash move failed");
  }
}

class ShutdownTrackingAdapter extends CountingStoredSessionsAdapter {
  override readonly providers: Array<"codex"> = ["codex"];
  shutdownCalls = 0;

  constructor(
    override readonly id: string,
    private readonly failShutdown = false,
  ) {
    super([]);
  }

  async shutdown(): Promise<void> {
    this.shutdownCalls += 1;
    if (this.failShutdown) {
      throw new Error(`shutdown failed for ${this.id}`);
    }
  }
}

function historyEvent(
  sessionId: string,
  seq: number,
  ts: string,
  text: string,
  messageId?: string,
): RahEvent {
  return {
    id: `${sessionId}-${seq}`,
    seq,
    ts,
    sessionId,
    type: "timeline.item.added",
    source: {
      provider: "codex",
      channel: "structured_persisted",
      authority: "authoritative",
    },
    payload: {
      item: {
        kind: "assistant_message",
        text,
        ...(messageId !== undefined ? { messageId } : {}),
      },
    },
  };
}

async function waitFor(
  assertion: () => void,
  options?: { timeoutMs?: number; intervalMs?: number },
): Promise<void> {
  const timeoutMs = options?.timeoutMs ?? 2_000;
  const intervalMs = options?.intervalMs ?? 50;
  const started = Date.now();
  let lastError: unknown;
  while (Date.now() - started < timeoutMs) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function sessionSummary(sessionId: string, providerSessionId: string): SessionSummary {
  return {
    session: {
      id: sessionId,
      provider: "codex",
      providerSessionId,
      launchSource: "web",
      cwd: workDirGlobal,
      rootDir: workDirGlobal,
      status: "running",
      phase: "ready",
      runtimeState: "idle",
      ptyId: `pty-${sessionId}`,
      capabilities: {
        liveAttach: true,
        structuredTimeline: true,
        nativeTui: false,
        rawPtyInput: false,
        chatMirror: false,
        structuredControl: true,
        livePermissions: false,
        contextUsage: false,
        resumeByProvider: true,
        listProviderSessions: true,
        steerInput: true,
        queuedInput: false,
        renameSession: false,
        actions: {
          info: true,
          stop: false,
          delete: true,
          rename: "none",
        },
        modelSwitch: false,
        planMode: false,
        subagents: false,
      },
      createdAt: "2025-07-19T22:21:00.000Z",
      updatedAt: "2025-07-19T22:21:00.000Z",
    },
    attachedClients: [],
    controlLease: {
      sessionId,
    },
  };
}

class MutableControlsAdapter extends CountingStoredSessionsAdapter {
  engine: RuntimeEngine | undefined;
  modeCalls = 0;
  modelCalls = 0;

  constructor() {
    super([]);
  }

  override startSession(request: StartSessionRequest): StartSessionResponse {
    if (!this.engine) {
      throw new Error("engine missing");
    }
    const state = this.engine.sessionStore.createManagedSession({
      provider: "codex",
      providerSessionId: "controls-1",
      launchSource: "web",
      cwd: request.cwd,
      rootDir: request.cwd,
      capabilities: {
        modelSwitch: true,
        planMode: true,
      },
      mode: {
        currentModeId: "default",
        availableModes: [
          { id: "default", label: "Default", hotSwitch: true, applyTiming: "idle_only" },
          { id: "plan", label: "Plan", hotSwitch: true, applyTiming: "idle_only" },
        ],
        mutable: true,
        source: "native",
      },
      model: {
        currentModelId: "alpha",
        availableModels: [
          { id: "alpha" },
          { id: "beta" },
        ],
        mutable: true,
        source: "native",
      },
    });
    const idleState = this.engine.sessionStore.setRuntimeState(state.session.id, "idle");
    return { session: toSessionSummary(idleState) };
  }

  setSessionMode(sessionId: string, modeId: string): SessionSummary {
    if (!this.engine) {
      throw new Error("engine missing");
    }
    this.modeCalls += 1;
    const currentMode = this.engine.sessionStore.getSession(sessionId)?.session.mode;
    if (!currentMode) {
      throw new Error("mode missing");
    }
    return toSessionSummary(
      this.engine.sessionStore.patchManagedSession(sessionId, {
        mode: {
          ...currentMode,
          currentModeId: modeId,
        },
      }),
    );
  }

  setSessionModel(sessionId: string, request: SetSessionModelRequest): SessionSummary {
    if (!this.engine) {
      throw new Error("engine missing");
    }
    this.modelCalls += 1;
    const currentModel = this.engine.sessionStore.getSession(sessionId)?.session.model;
    if (!currentModel) {
      throw new Error("model missing");
    }
    return toSessionSummary(
      this.engine.sessionStore.patchManagedSession(sessionId, {
        model: {
          ...currentModel,
          currentModelId: request.modelId,
          ...(request.reasoningId !== undefined ? { currentReasoningId: request.reasoningId } : {}),
        },
      }),
    );
  }
}

class NativeLocalServerRoutingAdapter implements ProviderAdapter {
  readonly id = "native-local-routing";
  readonly providers: Array<"codex"> = ["codex"];
  engine: RuntimeEngine | undefined;
  startRequests: StartSessionRequest[] = [];
  resumeRequests: ResumeSessionRequest[] = [];
  inputRequests: Array<{ sessionId: string; request: SessionInputRequest }> = [];
  interruptRequests: Array<{ sessionId: string; request: InterruptSessionRequest }> = [];

  startSession(request: StartSessionRequest): StartSessionResponse {
    if (!this.engine) {
      throw new Error("engine missing");
    }
    this.startRequests.push(request);
    const state = this.engine.sessionStore.createManagedSession({
      provider: "codex",
      providerSessionId: "native-local-start",
      launchSource: "web",
      liveBackend: request.liveBackend,
      cwd: request.cwd,
      rootDir: request.cwd,
      capabilities: {
        structuredControl: true,
        steerInput: true,
      },
    });
    return { session: toSessionSummary(state) };
  }

  resumeSession(request: ResumeSessionRequest): ResumeSessionResponse {
    if (!this.engine) {
      throw new Error("engine missing");
    }
    this.resumeRequests.push(request);
    const cwd = request.cwd ?? workDirGlobal;
    const state = this.engine.sessionStore.createManagedSession({
      provider: "codex",
      providerSessionId: request.providerSessionId,
      launchSource: "web",
      liveBackend: request.liveBackend,
      cwd,
      rootDir: cwd,
      capabilities: {
        structuredControl: true,
        steerInput: true,
      },
    });
    return { session: toSessionSummary(state) };
  }

  sendInput(sessionId: string, request: SessionInputRequest): void {
    this.inputRequests.push({ sessionId, request });
  }

  interruptSession(sessionId: string, request: InterruptSessionRequest): SessionSummary {
    if (!this.engine) {
      throw new Error("engine missing");
    }
    this.interruptRequests.push({ sessionId, request });
    return this.engine.getSessionSummary(sessionId);
  }

  onPtyInput(_sessionId: string, _clientId: string, _data: string): void {
    throw new Error("not implemented");
  }

  onPtyResize(_sessionId: string, _clientId: string, _cols: number, _rows: number): void {
    throw new Error("not implemented");
  }
}

class CouncilManagedSessionAdapter extends CountingStoredSessionsAdapter {
  engine: RuntimeEngine | undefined;
  readonly startedSessionIds: string[] = [];

  constructor() {
    super([]);
  }

  override startSession(request: StartSessionRequest): StartSessionResponse {
    if (!this.engine) {
      throw new Error("engine missing");
    }
    const sessionId = `council-agent-${this.startedSessionIds.length + 1}`;
    const state = this.engine.sessionStore.createManagedSession({
      id: sessionId,
      provider: request.provider,
      providerSessionId: sessionId,
      launchSource: "web",
      liveBackend: request.liveBackend,
      cwd: request.cwd,
      rootDir: request.cwd,
      ...(request.origin !== undefined ? { origin: request.origin } : {}),
      ...(request.title !== undefined ? { title: request.title } : {}),
    });
    this.startedSessionIds.push(sessionId);
    return { session: toSessionSummary(state) };
  }

  override sendInput(_sessionId: string, _request: SessionInputRequest): void {
    // Council bootstrap input is not relevant to this origin metadata test.
  }
}

let workDirGlobal = "";

class SnapshotPagingAdapter implements ProviderAdapter {
  readonly id = "snapshot-paging";
  readonly providers: Array<"codex"> = ["codex"];
  readonly historyBySessionId = new Map<string, RahEvent[]>();

  startSession(_request: StartSessionRequest): StartSessionResponse | Promise<StartSessionResponse> {
    throw new Error("not implemented");
  }

  async resumeSession(request: ResumeSessionRequest): Promise<ResumeSessionResponse> {
    const sessionId = request.preferStoredReplay ? "replay-1" : "live-1";
    return {
      session: sessionSummary(sessionId, request.providerSessionId),
    };
  }

  sendInput(_sessionId: string, _request: SessionInputRequest): void {
    throw new Error("not implemented");
  }

  closeSession?(_sessionId: string, _request: CloseSessionRequest): Promise<void> | void {
    throw new Error("not implemented");
  }

  interruptSession(_sessionId: string, _request: InterruptSessionRequest): SessionSummary {
    throw new Error("not implemented");
  }

  respondToPermission?(
    _sessionId: string,
    _requestId: string,
    _response: PermissionResponseRequest,
  ): Promise<void> | void {
    throw new Error("not implemented");
  }

  onPtyInput(_sessionId: string, _clientId: string, _data: string): void {
    throw new Error("not implemented");
  }

  onPtyResize(_sessionId: string, _clientId: string, _cols: number, _rows: number): void {
    throw new Error("not implemented");
  }

  getWorkspaceSnapshot(_sessionId: string): WorkspaceSnapshotResponse {
    throw new Error("not implemented");
  }

  getGitStatus(_sessionId: string): GitStatusResponse {
    throw new Error("not implemented");
  }

  getGitDiff(
    _sessionId: string,
    _path: string,
    _options?: { staged?: boolean; ignoreWhitespace?: boolean },
  ): GitDiffResponse {
    throw new Error("not implemented");
  }

  readSessionFile(_sessionId: string, _path: string): SessionFileResponse {
    throw new Error("not implemented");
  }

  getSessionHistoryPage(
    sessionId: string,
    options?: { beforeTs?: string; cursor?: string; limit?: number },
  ): SessionHistoryPageResponse {
    const events = this.historyBySessionId.get(sessionId) ?? [];
    const limit = Math.max(1, options?.limit ?? 1000);
    const start = Math.max(0, events.length - limit);
    return {
      sessionId,
      events: events.slice(start),
      ...(start > 0 && events[start] ? { nextBeforeTs: events[start]!.ts } : {}),
    };
  }

  getContextUsage(_sessionId: string): ContextUsage | undefined {
    return undefined;
  }
}

class StoredReplayDuringLiveResumeAdapter extends SnapshotPagingAdapter {
  engine: RuntimeEngine | undefined;
  probedStoredReplay = false;

  override async resumeSession(request: ResumeSessionRequest): Promise<ResumeSessionResponse> {
    if (!request.preferStoredReplay) {
      if (!this.engine) {
        throw new Error("engine missing");
      }
      this.probedStoredReplay = true;
      await assert.rejects(
        () =>
          this.engine!.resumeSession({
            provider: request.provider,
            providerSessionId: request.providerSessionId,
            preferStoredReplay: true,
          }),
        /being claimed; wait for live resume to finish/,
      );
      return { session: sessionSummary("live-1", request.providerSessionId) };
    }
    return { session: sessionSummary("replay-1", request.providerSessionId) };
  }
}

class FrozenPagingAdapter implements ProviderAdapter {
  readonly id = "frozen-paging";
  readonly providers: Array<"codex"> = ["codex"];
  loaderCreationCount = 0;
  readonly pagesBySessionId = new Map<
    string,
    {
      boundary: FrozenHistoryBoundary;
      initial: SessionHistoryPageResponse;
      olderByCursor: Map<string, SessionHistoryPageResponse>;
    }
  >();

  startSession(_request: StartSessionRequest): StartSessionResponse | Promise<StartSessionResponse> {
    throw new Error("not implemented");
  }

  async resumeSession(request: ResumeSessionRequest): Promise<ResumeSessionResponse> {
    const sessionId = request.preferStoredReplay ? "replay-1" : "live-1";
    return {
      session: sessionSummary(sessionId, request.providerSessionId),
    };
  }

  sendInput(_sessionId: string, _request: SessionInputRequest): void {
    throw new Error("not implemented");
  }

  closeSession?(_sessionId: string, _request: CloseSessionRequest): Promise<void> | void {
    throw new Error("not implemented");
  }

  interruptSession(_sessionId: string, _request: InterruptSessionRequest): SessionSummary {
    throw new Error("not implemented");
  }

  respondToPermission?(
    _sessionId: string,
    _requestId: string,
    _response: PermissionResponseRequest,
  ): Promise<void> | void {
    throw new Error("not implemented");
  }

  onPtyInput(_sessionId: string, _clientId: string, _data: string): void {
    throw new Error("not implemented");
  }

  onPtyResize(_sessionId: string, _clientId: string, _cols: number, _rows: number): void {
    throw new Error("not implemented");
  }

  getWorkspaceSnapshot(_sessionId: string): WorkspaceSnapshotResponse {
    throw new Error("not implemented");
  }

  getGitStatus(_sessionId: string): GitStatusResponse {
    throw new Error("not implemented");
  }

  getGitDiff(
    _sessionId: string,
    _path: string,
    _options?: { staged?: boolean; ignoreWhitespace?: boolean },
  ): GitDiffResponse {
    throw new Error("not implemented");
  }

  applyGitHunkAction(
    _sessionId: string,
    _request: GitHunkActionRequest,
  ): GitHunkActionResponse {
    throw new Error("not implemented");
  }

  readSessionFile(_sessionId: string, _path: string): SessionFileResponse {
    throw new Error("not implemented");
  }

  createFrozenHistoryPageLoader(sessionId: string): FrozenHistoryPageLoader | undefined {
    const pages = this.pagesBySessionId.get(sessionId);
    if (!pages) {
      return undefined;
    }
    this.loaderCreationCount += 1;
    return {
      loadInitialPage: (_limit) => ({
        boundary: pages.boundary,
        events: pages.initial.events,
        ...(pages.initial.nextCursor ? { nextCursor: pages.initial.nextCursor } : {}),
        ...(pages.initial.nextBeforeTs ? { nextBeforeTs: pages.initial.nextBeforeTs } : {}),
      }),
      loadOlderPage: (cursor, _limit, boundary) => {
        assert.equal(boundary.sourceRevision, pages.boundary.sourceRevision);
        const response = pages.olderByCursor.get(cursor);
        if (!response) {
          throw new Error(`Unknown frozen history cursor ${cursor}`);
        }
        return {
          boundary: pages.boundary,
          events: response.events,
          ...(response.nextCursor ? { nextCursor: response.nextCursor } : {}),
          ...(response.nextBeforeTs ? { nextBeforeTs: response.nextBeforeTs } : {}),
        };
      },
    };
  }

  getSessionHistoryPage?(
    _sessionId: string,
    _options?: { beforeTs?: string; cursor?: string; limit?: number },
  ): SessionHistoryPageResponse {
    throw new Error("materialized fallback should not be used");
  }

  getContextUsage(_sessionId: string): ContextUsage | undefined {
    return undefined;
  }
}

describe("RuntimeEngine", () => {
  let tmpClaudeConfig: string;
  let previousClaudeConfig: string | undefined;
  let tmpRahHome: string;
  let previousRahHome: string | undefined;
  let workDir: string;
  let projectDir: string;

  beforeEach(() => {
    previousClaudeConfig = process.env.CLAUDE_CONFIG_DIR;
    previousRahHome = process.env.RAH_HOME;
    tmpClaudeConfig = mkdtempSync(path.join(os.tmpdir(), "rah-runtime-claude-"));
    tmpRahHome = mkdtempSync(path.join(os.tmpdir(), "rah-runtime-home-"));
    workDir = mkdtempSync(path.join(os.tmpdir(), "rah-runtime-claude-workdir-"));
    workDirGlobal = workDir;
    const projectId = path.resolve(workDir).replace(/[^a-zA-Z0-9]/g, "-");
    projectDir = path.join(tmpClaudeConfig, "projects", projectId);
    mkdirSync(projectDir, { recursive: true });
    process.env.CLAUDE_CONFIG_DIR = tmpClaudeConfig;
    process.env.RAH_HOME = tmpRahHome;
  });

  afterEach(() => {
    if (previousClaudeConfig === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR;
    } else {
      process.env.CLAUDE_CONFIG_DIR = previousClaudeConfig;
    }
    if (previousRahHome === undefined) {
      delete process.env.RAH_HOME;
    } else {
      process.env.RAH_HOME = previousRahHome;
    }
    rmSync(tmpClaudeConfig, { recursive: true, force: true });
    rmSync(tmpRahHome, { recursive: true, force: true });
    rmSync(workDir, { recursive: true, force: true });
  });

  test("shutdown isolates adapter failures and continues shutting down later adapters", async () => {
    const failing = new ShutdownTrackingAdapter("failing-shutdown", true);
    const later = new ShutdownTrackingAdapter("later-shutdown");
    const engine = new RuntimeEngine([failing, later]);
    const originalConsoleError = console.error;
    console.error = () => undefined;
    try {
      await engine.shutdown();
    } finally {
      console.error = originalConsoleError;
    }

    assert.equal(failing.shutdownCalls, 1);
    assert.equal(later.shutdownCalls, 1);
  });

  test("routes claude stored replay through the stored-history adapter instead of DebugAdapter", async () => {
    writeFileSync(
      path.join(projectDir, "session-1.jsonl"),
      [
        JSON.stringify({
          type: "user",
          uuid: "user-1",
          cwd: workDir,
          sessionId: "session-1",
          timestamp: "2025-07-19T22:21:00.000Z",
          message: { content: "say hi" },
        }),
        JSON.stringify({
          type: "assistant",
          uuid: "assistant-1",
          cwd: workDir,
          sessionId: "session-1",
          timestamp: "2025-07-19T22:21:04.000Z",
          message: { content: [{ type: "text", text: "hello" }] },
        }),
      ].join("\n") + "\n",
    );

    const engine = new RuntimeEngine();
    const sessions = engine.listSessions();
    assert.ok(
      sessions.storedSessions.some(
        (entry) => entry.provider === "claude" && entry.providerSessionId === "session-1",
      ),
    );

    const resumed = await engine.resumeSession({
      provider: "claude",
      providerSessionId: "session-1",
      cwd: workDir,
      preferStoredReplay: true,
      attach: {
        client: {
          id: "web-1",
          kind: "web",
          connectionId: "web-1",
        },
        mode: "observe",
      },
    });
    assert.equal(resumed.session.session.runtime?.kind, "stored_history");
    assert.equal(resumed.session.session.runtime?.features?.structuredControl, "unsupported");
    assert.equal(resumed.session.session.capabilities.structuredControl, false);
    assert.equal(resumed.session.session.capabilities.liveAttach, false);

    const page = engine.getSessionHistoryPage(resumed.session.session.id, { limit: 20 });
    assert.ok(
      page.events.some(
        (event) =>
          event.type === "timeline.item.added" &&
          event.payload.item.kind === "assistant_message" &&
          event.payload.item.text === "hello",
      ),
    );

    await engine.shutdown();
  });

  test("listDirectory expands tilde to the current user home directory", async () => {
    const engine = new RuntimeEngine();

    const listing = await engine.listDirectory("~");

    assert.equal(listing.path, os.homedir());

    await engine.shutdown();
  });

  test("live start and resume reject missing working directories before adapter launch", async () => {
    const missingDir = path.join(os.tmpdir(), `rah-runtime-missing-cwd-${Date.now()}`);
    rmSync(missingDir, { recursive: true, force: true });
    const adapter = new SnapshotPagingAdapter();
    const engine = new RuntimeEngine([adapter]);

    await assert.rejects(
      () => engine.startSession({ provider: "codex", cwd: missingDir }),
      /Session working directory does not exist/,
    );
    await assert.rejects(
      () =>
        engine.resumeSession({
          provider: "codex",
          providerSessionId: "thread-missing-cwd",
          cwd: missingDir,
          preferStoredReplay: false,
        }),
      /Session working directory does not exist/,
    );

    const replay = await engine.resumeSession({
      provider: "codex",
      providerSessionId: "thread-missing-cwd",
      cwd: missingDir,
      preferStoredReplay: true,
    });
    assert.equal(replay.session.session.id, "replay-1");

    await engine.shutdown();
  });

  test("live resume reservation blocks concurrent stored replay rehydrate", async () => {
    const adapter = new StoredReplayDuringLiveResumeAdapter();
    const engine = new RuntimeEngine([adapter]);
    adapter.engine = engine;

    const live = await engine.resumeSession({
      provider: "codex",
      providerSessionId: "thread-claim",
      cwd: workDir,
      preferStoredReplay: false,
    });
    assert.equal(adapter.probedStoredReplay, true);
    assert.equal(live.session.session.id, "live-1");

    const replay = await engine.resumeSession({
      provider: "codex",
      providerSessionId: "thread-claim",
      preferStoredReplay: true,
    });
    assert.equal(replay.session.session.id, "replay-1");

    await engine.shutdown();
  });

  test("renaming a running Council updates managed agent session origin metadata", async () => {
    const adapter = new CouncilManagedSessionAdapter();
    const engine = new RuntimeEngine([adapter]);
    adapter.engine = engine;

    const created = await engine.createCouncil({
      title: "Original Council",
      workspace: workDir,
      agents: [{ provider: "codex", label: "Codex Agent" }],
    });
    await waitFor(() => assert.equal(adapter.startedSessionIds.length, 1));
    const sessionId = adapter.startedSessionIds[0]!;

    assert.equal(
      engine.sessionStore.getSession(sessionId)?.session.origin?.councilTitle,
      "Original Council",
    );

    const renamed = engine.renameCouncil(created.council.id, "Renamed Council");

    assert.equal(renamed.title, "Renamed Council");
    assert.equal(
      engine.sessionStore.getSession(sessionId)?.session.origin?.councilTitle,
      "Renamed Council",
    );
    await engine.shutdown();
  });

  test("production engine rejects explicit provider control live backend outside injected adapters", async () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), "rah-structured-live-disabled-"));
    const engine = new RuntimeEngine();
    try {
      await assert.rejects(
        () =>
          engine.startSession({
            provider: "codex",
            cwd: workspace,
            liveBackend: "structured",
          }),
        /Structured live backend is disabled outside injected test adapters/,
      );
      await assert.rejects(
        () =>
          engine.resumeSession({
            provider: "codex",
            providerSessionId: "thread-structured-disabled",
            cwd: workspace,
            liveBackend: "structured",
          }),
        /Structured live backend is disabled outside injected test adapters/,
      );
    } finally {
      await engine.shutdown();
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("production engine rejects native local-server backend for providers without that runtime", async () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), "rah-native-local-unsupported-"));
    const engine = new RuntimeEngine();
    try {
      await assert.rejects(
        () =>
          engine.startSession({
            provider: "claude",
            cwd: workspace,
            liveBackend: "native_local_server",
          }),
        /Provider claude does not support the native local-server live backend/,
      );
      await assert.rejects(
        () =>
          engine.resumeSession({
            provider: "claude",
            providerSessionId: "claude-native-local-unsupported",
            cwd: workspace,
            liveBackend: "native_local_server",
          }),
        /Provider claude does not support the native local-server live backend/,
      );
    } finally {
      await engine.shutdown();
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("native local-server backend routes through structured lifecycle and tags runtime", async () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), "rah-native-local-routing-"));
    workDirGlobal = workspace;
    const adapter = new NativeLocalServerRoutingAdapter();
    const engine = new RuntimeEngine([adapter]);
    adapter.engine = engine;
    try {
      const started = await engine.startSession({
        provider: "codex",
        cwd: workspace,
        liveBackend: "native_local_server",
      });
      const sessionId = started.session.session.id;
      assert.equal(adapter.startRequests.length, 1);
      assert.equal(started.session.session.liveBackend, "native_local_server");
      assert.equal(started.session.session.runtime?.kind, "native_local_server");
      assert.equal(started.session.session.runtime?.liveSource, "provider_server");
      assert.equal(started.session.session.runtime?.structuredLiveEvents, true);
      assert.equal(started.session.session.runtime?.tuiRole, "client_view");
      assert.equal(started.session.session.runtime?.tuiContinuity, true);
      engine.claimControl(sessionId, {
        client: {
          id: "terminal-client",
          kind: "terminal",
          connectionId: "pid:test-terminal",
        },
      });
      assert.doesNotThrow(() =>
        engine.sendInput(sessionId, {
          clientId: "web-chat",
          text: "web chat should not require TUI control",
        }),
      );
      assert.doesNotThrow(() =>
        engine.interruptSession(sessionId, {
          clientId: "web-chat",
        }),
      );
      assert.deepEqual(adapter.inputRequests.at(-1), {
        sessionId,
        request: {
          clientId: "web-chat",
          text: "web chat should not require TUI control",
        },
      });
      assert.deepEqual(adapter.interruptRequests.at(-1), {
        sessionId,
        request: {
          clientId: "web-chat",
        },
      });

      const resumed = await engine.resumeSession({
        provider: "codex",
        providerSessionId: "native-local-resume",
        cwd: workspace,
        liveBackend: "native_local_server",
      });
      assert.equal(adapter.resumeRequests.length, 1);
      assert.equal(resumed.session.session.liveBackend, "native_local_server");
      assert.equal(resumed.session.session.runtime?.kind, "native_local_server");
      assert.equal(resumed.session.session.runtime?.liveSource, "provider_server");
      assert.equal(resumed.session.session.runtime?.structuredLiveEvents, true);
      assert.equal(resumed.session.session.runtime?.tuiRole, "client_view");
      assert.equal(resumed.session.session.runtime?.tuiContinuity, true);
    } finally {
      await engine.shutdown();
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("applies remembered title overrides to resumed live session responses", async () => {
    const providerSessionId = "thread-renamed";
    mkdirSync(path.join(tmpRahHome, "runtime-daemon"), { recursive: true });
    writeFileSync(
      path.join(tmpRahHome, "runtime-daemon", "workbench-state.json"),
      JSON.stringify({
        version: 2,
        updatedAt: "2026-05-25T00:00:00.000Z",
        workspaces: [workDir],
        hiddenWorkspaces: [],
        hiddenSessionKeys: [],
        sessionTitleOverrides: {
          [`codex:${providerSessionId}`]: "Renamed session",
        },
        sessions: [],
        recentSessions: [
          {
            provider: "codex",
            providerSessionId,
            cwd: workDir,
            rootDir: workDir,
            title: "Renamed session",
            updatedAt: "2026-05-25T00:00:00.000Z",
          },
        ],
      }),
    );

    const adapter = new NativeLocalServerRoutingAdapter();
    const engine = new RuntimeEngine([adapter]);
    adapter.engine = engine;
    try {
      const resumed = await engine.resumeSession({
        provider: "codex",
        providerSessionId,
        cwd: workDir,
        liveBackend: "native_local_server",
      });

      assert.equal(resumed.session.session.title, "Renamed session");
      assert.equal(
        engine.getSessionSummary(resumed.session.session.id).session.title,
        "Renamed session",
      );
      assert.equal(
        engine.claimControl(resumed.session.session.id, {
          client: {
            id: "web-client",
            kind: "web",
            connectionId: "web-client",
          },
        }).session.title,
        "Renamed session",
      );
    } finally {
      await engine.shutdown();
    }
  });

  test("applies discovered provider history titles to resumed live session responses", async () => {
    const providerSessionId = "thread-provider-title";
    const history = new CountingStoredSessionsAdapter([
      {
        provider: "codex",
        providerSessionId,
        cwd: workDir,
        rootDir: workDir,
        title: "Provider history title",
        preview: "Old first prompt preview",
        updatedAt: "2026-05-25T00:00:00.000Z",
        source: "provider_history",
      },
    ]);
    const adapter = new NativeLocalServerRoutingAdapter();
    const engine = new RuntimeEngine([history, adapter]);
    adapter.engine = engine;
    try {
      const resumed = await engine.resumeSession({
        provider: "codex",
        providerSessionId,
        cwd: workDir,
        liveBackend: "native_local_server",
      });

      assert.equal(resumed.session.session.title, "Provider history title");
      assert.equal(
        engine.claimControl(resumed.session.session.id, {
          client: {
            id: "web-client",
            kind: "web",
            connectionId: "web-client",
          },
        }).session.title,
        "Provider history title",
      );
    } finally {
      await engine.shutdown();
    }
  });

  test("native local-server sessions expose an on-demand Web TUI client", async () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), "rah-native-local-web-tui-"));
    const fakeCodex = path.join(workspace, "fake-codex.js");
    const previousCodexBinary = process.env.RAH_CODEX_BINARY;
    writeFileSync(
      fakeCodex,
      [
        "#!/usr/bin/env node",
        "process.stdout.write(`NATIVE_LOCAL_TUI_READY args=${process.argv.slice(2).join('|')}\\r\\n`);",
        "process.stdin.setEncoding('utf8');",
        "process.stdin.resume();",
        "process.stdin.on('data', (chunk) => process.stdout.write(`NATIVE_LOCAL_TUI_INPUT:${chunk}\\r\\n`));",
        "setInterval(() => undefined, 1000);",
        "",
      ].join("\n"),
    );
    chmodSync(fakeCodex, 0o755);
    process.env.RAH_CODEX_BINARY = fakeCodex;
    workDirGlobal = workspace;
    const adapter = new NativeLocalServerRoutingAdapter();
    const engine = new RuntimeEngine([adapter]);
    adapter.engine = engine;
    try {
      const started = await engine.startSession({
        provider: "codex",
        cwd: workspace,
        liveBackend: "native_local_server",
      });
      const sessionId = started.session.session.id;
      engine.sessionStore.patchManagedSession(sessionId, {
        nativeTui: {
          terminalId: sessionId,
          viewAvailable: true,
          promptState: "prompt_clean",
          queuedInputCount: 0,
        },
        capabilities: {
          nativeTui: true,
          rawPtyInput: true,
        },
        runtimeDiagnostics: {
          serverEndpoint: "ws://127.0.0.1:65531/",
          attachState: "ready",
        },
      });

      let transcript = "";
      const unsubscribe = engine.ptyHub.subscribe(sessionId, (frame) => {
        if (frame.type === "pty.replay") {
          transcript += frame.chunks.join("");
        } else if (frame.type === "pty.output") {
          transcript += frame.data;
        }
      });

      await engine.claimNativeTuiSurface(sessionId, {
        clientId: "web-tui",
        clientKind: "web",
        cols: 80,
        rows: 24,
      });

      await waitFor(() => {
        assert.match(
          transcript,
          /NATIVE_LOCAL_TUI_READY args=.*--remote\|ws:\/\/127\.0\.0\.1:65531\/\|resume\|native-local-start/,
        );
        assert.equal(engine.getSessionSummary(sessionId).controlLease.holderClientId, "web-user");
      });

      engine.onPtyInput(sessionId, "web-tui", "hello from web tui\r");
      await waitFor(() => {
        assert.match(transcript, /NATIVE_LOCAL_TUI_INPUT:hello from web tui/);
      });

      await engine.closeNativeTuiClient(sessionId, { clientId: "web-tui" });
      assert.equal(
        engine.listPtyStats().find((stat) => stat.sessionId === sessionId)?.status,
        "open",
      );
      assert.match(transcript, /Web TUI client closed/);

      let reactivatedTranscript = "";
      const unsubscribeReactivated = engine.ptyHub.subscribe(sessionId, (frame) => {
        if (frame.type === "pty.replay") {
          reactivatedTranscript += frame.chunks.join("");
        } else if (frame.type === "pty.output") {
          reactivatedTranscript += frame.data;
        }
      });
      await engine.claimNativeTuiSurface(sessionId, {
        clientId: "web-tui-reactivated",
        clientKind: "web",
        cols: 80,
        rows: 24,
      });
      await waitFor(() => {
        assert.match(reactivatedTranscript, /NATIVE_LOCAL_TUI_READY/);
      });

      unsubscribeReactivated();
      unsubscribe();
      await engine.closeSession(sessionId, { clientId: "web-tui" });
    } finally {
      if (previousCodexBinary === undefined) {
        delete process.env.RAH_CODEX_BINARY;
      } else {
        process.env.RAH_CODEX_BINARY = previousCodexBinary;
      }
      await engine.shutdown();
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("production engine rejects unsupported live providers before structured fallback", async () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), "rah-unsupported-live-provider-"));
    const engine = new RuntimeEngine();
    try {
      await assert.rejects(
        () =>
          engine.startSession({
            provider: "custom",
            cwd: workspace,
          }),
        /Provider custom is not a supported live provider/,
      );
      await assert.rejects(
        () =>
          engine.resumeSession({
            provider: "custom",
            providerSessionId: "custom-session",
            cwd: workspace,
          }),
        /Provider custom is not a supported live provider/,
      );
    } finally {
      await engine.shutdown();
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("blocks mode and model changes while a session is not idle", async () => {
    const adapter = new MutableControlsAdapter();
    const engine = new RuntimeEngine([adapter]);
    adapter.engine = engine;

    const started = await engine.startSession({
      provider: "codex",
      cwd: workDirGlobal,
    });
    const sessionId = started.session.session.id;
    engine.sessionStore.setRuntimeState(sessionId, "running");

    await assert.rejects(
      () => engine.setSessionMode(sessionId, "plan"),
      /Session mode can only be changed while the session is idle/,
    );
    await assert.rejects(
      () => engine.setSessionModel(sessionId, { modelId: "beta" }),
      /Session model can only be changed while the session is idle/,
    );
    assert.equal(adapter.modeCalls, 0);
    assert.equal(adapter.modelCalls, 0);

    engine.sessionStore.setRuntimeState(sessionId, "idle");
    await engine.setSessionMode(sessionId, "plan");
    await engine.setSessionModel(sessionId, { modelId: "beta" });
    assert.equal(adapter.modeCalls, 1);
    assert.equal(adapter.modelCalls, 1);

    await engine.shutdown();
  });

  test("blocks mode and model changes when runtime config is not available", async () => {
    const adapter = new MutableControlsAdapter();
    const engine = new RuntimeEngine([adapter]);
    adapter.engine = engine;

    const started = await engine.startSession({
      provider: "codex",
      cwd: workDirGlobal,
    });
    const sessionId = started.session.session.id;
    engine.sessionStore.patchManagedSession(sessionId, {
      runtime: {
        kind: "native_local_server",
        protocolStability: "project_native",
        liveSource: "provider_server",
        tuiRole: "none",
        structuredLiveEvents: true,
        tuiContinuity: false,
        features: {
          structuredLiveEvents: "available",
          structuredControl: "available",
          historyBackfill: "available",
          tuiClientContinuity: "unsupported",
          crossClientSync: "unverified",
          prelaunchConfig: "available",
          runtimeConfig: "unverified",
          interrupt: "unverified",
          stopLifecycle: "unverified",
        },
      },
    });

    await assert.rejects(
      () => engine.setSessionMode(sessionId, "plan"),
      /Session mode controls are not available for this session runtime/,
    );
    await assert.rejects(
      () => engine.setSessionModel(sessionId, { modelId: "beta" }),
      /Session model controls are not available for this session runtime/,
    );
    assert.equal(adapter.modeCalls, 0);
    assert.equal(adapter.modelCalls, 0);

    engine.sessionStore.patchManagedSession(sessionId, {
      runtime: {
        ...engine.sessionStore.getSession(sessionId)!.session.runtime!,
        features: {
          ...engine.sessionStore.getSession(sessionId)!.session.runtime!.features!,
          runtimeConfig: "available",
        },
      },
    });
    await engine.setSessionMode(sessionId, "plan");
    await engine.setSessionModel(sessionId, { modelId: "beta" });
    assert.equal(adapter.modeCalls, 1);
    assert.equal(adapter.modelCalls, 1);

    await engine.shutdown();
  });

  test("history removal reuses cached stored sessions instead of rescanning adapters", async () => {
    const adapter = new CountingStoredSessionsAdapter([
      {
        provider: "codex",
        providerSessionId: "session-1",
        cwd: workDir,
        rootDir: workDir,
        updatedAt: "2025-07-19T22:21:00.000Z",
        source: "provider_history",
      },
      {
        provider: "codex",
        providerSessionId: "session-2",
        cwd: workDir,
        rootDir: workDir,
        updatedAt: "2025-07-19T22:22:00.000Z",
        source: "provider_history",
      },
    ]);
    const engine = new RuntimeEngine([adapter]);
    assert.equal(adapter.storedSessionCalls, 1);

    const initial = engine.listSessions();
    assert.equal(adapter.storedSessionCalls, 1);
    assert.equal(initial.storedSessions.length, 2);
    assert.equal(typeof initial.storedSessionsRevision, "number");

    const secondList = engine.listSessions();
    assert.equal(adapter.storedSessionCalls, 1);
    assert.equal(secondList.storedSessions.length, 2);

    const afterSingleRemoval = await engine.removeStoredSession("codex", "session-1");
    assert.equal(adapter.storedSessionCalls, 1);
    assert.deepEqual(adapter.removedSessionIds, ["session-1"]);
    assert.ok((afterSingleRemoval.storedSessionsRevision ?? 0) > (initial.storedSessionsRevision ?? 0));
    assert.deepEqual(
      afterSingleRemoval.storedSessions.map((entry) => entry.providerSessionId),
      ["session-2"],
    );
    assert.deepEqual(engine.getStoredSessionsDelta(initial.storedSessionsRevision ?? 0), {
      fromRevision: initial.storedSessionsRevision,
      revision: afterSingleRemoval.storedSessionsRevision,
      upsert: [],
      remove: [{ provider: "codex", providerSessionId: "session-1" }],
    });

    const afterWorkspaceRemoval = await engine.removeStoredWorkspaceSessions(workDir);
    assert.equal(adapter.storedSessionCalls, 1);
    assert.deepEqual(adapter.removedSessionIds, ["session-1", "session-2"]);
    assert.equal(afterWorkspaceRemoval.storedSessions.length, 0);

    await engine.shutdown();
  });

  test("renaming a session publishes a stored-session upsert delta", async () => {
    const adapter = new RenameStoredSessionsAdapter();
    const engine = new RuntimeEngine([adapter]);
    adapter.engine = engine;

    try {
      const initial = engine.listSessions({ storedSessionsMode: "all" });
      assert.equal(initial.storedSessions[0]?.title, "Old history title");
      assert.equal(typeof initial.storedSessionsRevision, "number");

      const started = await engine.startSession({
        provider: "codex",
        cwd: workDirGlobal,
      });

      await engine.renameSession(started.session.session.id, "New canonical title");

      const delta = engine.getStoredSessionsDelta(initial.storedSessionsRevision ?? 0);
      assert.equal(delta.resetRequired, undefined);
      assert.equal(delta.remove.length, 0);
      assert.equal(delta.upsert.length, 1);
      assert.equal(delta.upsert[0]?.provider, "codex");
      assert.equal(delta.upsert[0]?.providerSessionId, "rename-provider-session");
      assert.equal(delta.upsert[0]?.title, "New canonical title");

      const current = engine.listSessions({ storedSessionsMode: "all" });
      assert.equal(
        current.storedSessions.find(
          (session) => session.providerSessionId === "rename-provider-session",
        )?.title,
        "New canonical title",
      );
    } finally {
      await engine.shutdown();
    }
  });

  test("closing a session refreshes stored history metadata before the next list", async () => {
    const adapter = new CloseRefreshStoredSessionsAdapter();
    const otherProviderAdapter = new GeminiStoredSessionsProbeAdapter();
    const engine = new RuntimeEngine([adapter, otherProviderAdapter]);
    adapter.engine = engine;

    try {
      assert.equal(adapter.storedSessionCalls, 1);
      assert.equal(otherProviderAdapter.storedSessionCalls, 1);
      const started = await engine.startSession({
        provider: "codex",
        cwd: workDir,
        attach: {
          client: {
            id: "web-user",
            kind: "web",
            connectionId: "close-refresh-client",
          },
          mode: "interactive",
          claimControl: true,
        },
      });

      await engine.closeSession(started.session.session.id, { clientId: "web-user" });

      const sessions = engine.listSessions();
      const stopped = sessions.storedSessions.find(
        (session) => session.providerSessionId === "closed-provider-session",
      );
      assert.equal(stopped?.source, "provider_history");
      assert.equal(stopped?.historyMeta?.lines, 12);
      assert.equal(
        sessions.recentSessions.find(
          (session) => session.providerSessionId === "closed-provider-session",
        )?.historyMeta?.lines,
        12,
      );
      assert.equal(adapter.storedSessionCalls, 2);
      assert.equal(otherProviderAdapter.storedSessionCalls, 1);
    } finally {
      await engine.shutdown();
    }
  });

  test("history paging freezes a snapshot once loaded", async () => {
    const adapter = new SnapshotPagingAdapter();
    adapter.historyBySessionId.set("replay-1", [
      historyEvent("replay-1", 1, "2025-07-19T22:21:01.000Z", "older"),
      historyEvent("replay-1", 2, "2025-07-19T22:21:02.000Z", "middle"),
      historyEvent("replay-1", 3, "2025-07-19T22:21:03.000Z", "latest"),
    ]);
    const engine = new RuntimeEngine([adapter]);

    const resumed = await engine.resumeSession({
      provider: "codex",
      providerSessionId: "provider-1",
      preferStoredReplay: true,
    });

    const firstPage = engine.getSessionHistoryPage(resumed.session.session.id, { limit: 2 });
    assert.deepEqual(
      firstPage.events.map((event) => {
        if (
          event.type === "timeline.item.added" &&
          event.payload.item.kind === "assistant_message"
        ) {
          return event.payload.item.text;
        }
        return null;
      }),
      ["middle", "latest"],
    );
    assert.ok(firstPage.nextCursor);

    adapter.historyBySessionId.set("replay-1", [
      historyEvent("replay-1", 0, "2025-07-19T22:21:00.000Z", "newer-file-head"),
      ...(adapter.historyBySessionId.get("replay-1") ?? []),
    ]);

    const secondPage = engine.getSessionHistoryPage(resumed.session.session.id, {
      cursor: firstPage.nextCursor,
      limit: 2,
    });
    assert.deepEqual(
      secondPage.events.map((event) => {
        if (
          event.type === "timeline.item.added" &&
          event.payload.item.kind === "assistant_message"
        ) {
          return event.payload.item.text;
        }
        return null;
      }),
      ["older"],
    );

    await engine.shutdown();
  });

  test("filters provider history noise for Council-managed agent sessions", async () => {
    const adapter = new SnapshotPagingAdapter();
    adapter.historyBySessionId.set("replay-1", [
      historyEvent("replay-1", 1, "2025-07-19T22:21:01.000Z", "Joined the council."),
      historyEvent("replay-1", 2, "2025-07-19T22:21:02.000Z", "Listening for messages."),
      historyEvent(
        "replay-1",
        3,
        "2025-07-19T22:21:03.000Z",
        "Visible Council reply",
        "council-mcp:call-post",
      ),
      historyEvent("replay-1", 4, "2025-07-19T22:21:04.000Z", "Continuing to wait."),
    ]);
    const engine = new RuntimeEngine([adapter]);

    const managed = engine.sessionStore.createManagedSession({
      id: "replay-1",
      provider: "codex",
      providerSessionId: "provider-1",
      launchSource: "web",
      cwd: workDir,
      rootDir: workDir,
      origin: {
        kind: "council",
        councilId: "council-1",
        councilTitle: "Council",
        agentId: "agent-1",
        agentLabel: "Agent",
      },
    });

    const page = engine.getSessionHistoryPage(managed.session.id, { limit: 20 });
    assert.deepEqual(
      page.events.map((event) => {
        if (
          event.type === "timeline.item.added" &&
          event.payload.item.kind === "assistant_message"
        ) {
          return event.payload.item.text;
        }
        return null;
      }),
      ["Visible Council reply"],
    );

    await engine.shutdown();
  });

  test("stored session watcher refreshes cached sessions after external add and delete", async () => {
    const watchRoot = mkdtempSync(path.join(os.tmpdir(), "rah-runtime-watch-"));
    const watchFile = path.join(watchRoot, "probe.txt");
    const adapter = new WatchingStoredSessionsAdapter([
      {
        provider: "codex",
        providerSessionId: "session-1",
        cwd: workDir,
        rootDir: workDir,
        updatedAt: "2025-07-19T22:21:00.000Z",
        source: "provider_history",
      },
    ], watchRoot);
    const engine = new RuntimeEngine([adapter]);

    assert.deepEqual(
      engine.listSessions().storedSessions.map((session) => session.providerSessionId),
      ["session-1"],
    );
    await new Promise((resolve) => setTimeout(resolve, 100));

    adapter.storedSessions = [
      ...adapter.storedSessions,
      {
        provider: "codex",
        providerSessionId: "session-2",
        cwd: workDir,
        rootDir: workDir,
        updatedAt: "2025-07-19T22:22:00.000Z",
        source: "provider_history",
      },
    ];
    writeFileSync(watchFile, "changed");

    await waitFor(() => {
      assert.deepEqual(
        [...engine.listSessions().storedSessions.map((session) => session.providerSessionId)].sort(),
        ["session-1", "session-2"],
      );
    });
    assert.ok(
      engine
        .listEvents({ eventTypes: ["session.discovery"] })
        .some(
          (event) =>
            event.type === "session.discovery" &&
            event.payload.storedSessions?.upsert?.some(
              (session) => session.providerSessionId === "session-2",
            ),
        ),
    );

    adapter.storedSessions = adapter.storedSessions.filter(
      (session) => session.providerSessionId !== "session-2",
    );
    unlinkSync(watchFile);
    await new Promise((resolve) => setTimeout(resolve, 100));

    await waitFor(() => {
      assert.deepEqual(
        engine.listSessions().storedSessions.map((session) => session.providerSessionId),
        ["session-1"],
      );
    });

    await engine.shutdown();
    rmSync(watchRoot, { recursive: true, force: true });
  });

  test("failed provider removal leaves stored session visible", async () => {
    const adapter = new FailingRemovalStoredSessionsAdapter([
      {
        provider: "codex",
        providerSessionId: "session-1",
        cwd: workDir,
        rootDir: workDir,
        updatedAt: "2025-07-19T22:21:00.000Z",
        source: "provider_history",
      },
    ]);
    const engine = new RuntimeEngine([adapter]);

    await assert.rejects(
      engine.removeStoredSession("codex", "session-1"),
      /provider trash move failed/,
    );
    assert.deepEqual(
      engine.listSessions().storedSessions.map((session) => session.providerSessionId),
      ["session-1"],
    );

    await engine.shutdown();
  });

  test("history snapshot transfers from replay to claimed running session", async () => {
    const adapter = new SnapshotPagingAdapter();
    adapter.historyBySessionId.set("replay-1", [
      historyEvent("replay-1", 1, "2025-07-19T22:21:01.000Z", "older"),
      historyEvent("replay-1", 2, "2025-07-19T22:21:02.000Z", "middle"),
      historyEvent("replay-1", 3, "2025-07-19T22:21:03.000Z", "latest"),
    ]);
    adapter.historyBySessionId.set("live-1", [
      historyEvent("live-1", 1, "2025-07-19T22:21:01.000Z", "older"),
      historyEvent("live-1", 2, "2025-07-19T22:21:02.000Z", "middle"),
      historyEvent("live-1", 3, "2025-07-19T22:21:03.000Z", "latest"),
      historyEvent("live-1", 4, "2025-07-19T22:21:04.000Z", "live-appended"),
    ]);
    const engine = new RuntimeEngine([adapter]);

    const replay = await engine.resumeSession({
      provider: "codex",
      providerSessionId: "provider-1",
      preferStoredReplay: true,
    });
    const firstPage = engine.getSessionHistoryPage(replay.session.session.id, { limit: 2 });
    assert.ok(firstPage.nextCursor);

    const live = await engine.resumeSession({
      provider: "codex",
      providerSessionId: "provider-1",
      preferStoredReplay: false,
      historySourceSessionId: replay.session.session.id,
    });

    const olderPage = engine.getSessionHistoryPage(live.session.session.id, {
      cursor: firstPage.nextCursor,
      limit: 2,
    });
    assert.deepEqual(
      olderPage.events.map((event) => {
        if (
          event.type === "timeline.item.added" &&
          event.payload.item.kind === "assistant_message"
        ) {
          return event.payload.item.text;
        }
        return null;
      }),
      ["older"],
    );

    await engine.shutdown();
  });

  test("frozen history pager caches provider-owned pages by cursor", async () => {
    const adapter = new FrozenPagingAdapter();
    adapter.pagesBySessionId.set("replay-1", {
      boundary: { kind: "frozen", sourceRevision: "rev-1" },
      initial: {
        sessionId: "replay-1",
        events: [
          historyEvent("replay-1", 2, "2025-07-19T22:21:02.000Z", "middle"),
          historyEvent("replay-1", 3, "2025-07-19T22:21:03.000Z", "latest"),
        ],
        nextCursor: "older-1",
        nextBeforeTs: "2025-07-19T22:21:02.000Z",
      },
      olderByCursor: new Map([
        [
          "older-1",
          {
            sessionId: "replay-1",
            events: [historyEvent("replay-1", 1, "2025-07-19T22:21:01.000Z", "older")],
          },
        ],
      ]),
    });
    const engine = new RuntimeEngine([adapter]);

    const replay = await engine.resumeSession({
      provider: "codex",
      providerSessionId: "provider-1",
      preferStoredReplay: true,
    });

    const firstPage = engine.getSessionHistoryPage(replay.session.session.id, { limit: 2 });
    assert.deepEqual(
      firstPage.events.map((event) =>
        event.type === "timeline.item.added" && event.payload.item.kind === "assistant_message"
          ? event.payload.item.text
          : null,
      ),
      ["middle", "latest"],
    );
    assert.equal(firstPage.nextCursor, "older-1");

    const olderPage = engine.getSessionHistoryPage(replay.session.session.id, {
      cursor: "older-1",
      limit: 2,
    });
    assert.deepEqual(
      olderPage.events.map((event) =>
        event.type === "timeline.item.added" && event.payload.item.kind === "assistant_message"
          ? event.payload.item.text
          : null,
      ),
      ["older"],
    );

    const olderPageAgain = engine.getSessionHistoryPage(replay.session.session.id, {
      cursor: "older-1",
      limit: 2,
    });
    assert.deepEqual(olderPageAgain, olderPage);
    assert.equal(adapter.loaderCreationCount, 1);

    await engine.shutdown();
  });

  test("frozen history pager refreshes the initial page when the source revision changes", async () => {
    const adapter = new FrozenPagingAdapter();
    adapter.pagesBySessionId.set("replay-1", {
      boundary: { kind: "frozen", sourceRevision: "rev-1" },
      initial: {
        sessionId: "replay-1",
        events: [
          historyEvent("replay-1", 2, "2025-07-19T22:21:02.000Z", "middle"),
          historyEvent("replay-1", 3, "2025-07-19T22:21:03.000Z", "latest"),
        ],
        nextCursor: "older-1",
        nextBeforeTs: "2025-07-19T22:21:02.000Z",
      },
      olderByCursor: new Map([
        [
          "older-1",
          {
            sessionId: "replay-1",
            events: [historyEvent("replay-1", 1, "2025-07-19T22:21:01.000Z", "older")],
          },
        ],
      ]),
    });
    const engine = new RuntimeEngine([adapter]);

    const replay = await engine.resumeSession({
      provider: "codex",
      providerSessionId: "provider-1",
      preferStoredReplay: true,
    });
    const firstPage = engine.getSessionHistoryPage(replay.session.session.id, { limit: 2 });
    assert.equal(firstPage.nextCursor, "older-1");

    adapter.pagesBySessionId.set("replay-1", {
      boundary: { kind: "frozen", sourceRevision: "rev-2" },
      initial: {
        sessionId: "replay-1",
        events: [
          historyEvent("replay-1", 3, "2025-07-19T22:21:03.000Z", "latest"),
          historyEvent("replay-1", 4, "2025-07-19T22:21:04.000Z", "appended"),
        ],
        nextCursor: "older-2",
        nextBeforeTs: "2025-07-19T22:21:03.000Z",
      },
      olderByCursor: new Map([
        [
          "older-2",
          {
            sessionId: "replay-1",
            events: [historyEvent("replay-1", 2, "2025-07-19T22:21:02.000Z", "middle")],
          },
        ],
      ]),
    });

    const refreshedPage = engine.getSessionHistoryPage(replay.session.session.id, { limit: 2 });
    assert.deepEqual(
      refreshedPage.events.map((event) =>
        event.type === "timeline.item.added" && event.payload.item.kind === "assistant_message"
          ? event.payload.item.text
          : null,
      ),
      ["latest", "appended"],
    );
    assert.equal(refreshedPage.nextCursor, "older-2");

    await engine.shutdown();
  });

  test("frozen history pager transfers to claimed running session", async () => {
    const adapter = new FrozenPagingAdapter();
    adapter.pagesBySessionId.set("replay-1", {
      boundary: { kind: "frozen", sourceRevision: "rev-1" },
      initial: {
        sessionId: "replay-1",
        events: [
          historyEvent("replay-1", 2, "2025-07-19T22:21:02.000Z", "middle"),
          historyEvent("replay-1", 3, "2025-07-19T22:21:03.000Z", "latest"),
        ],
        nextCursor: "older-1",
        nextBeforeTs: "2025-07-19T22:21:02.000Z",
      },
      olderByCursor: new Map([
        [
          "older-1",
          {
            sessionId: "replay-1",
            events: [historyEvent("replay-1", 1, "2025-07-19T22:21:01.000Z", "older")],
          },
        ],
      ]),
    });
    adapter.pagesBySessionId.set("live-1", {
      boundary: { kind: "frozen", sourceRevision: "rev-1" },
      initial: {
        sessionId: "live-1",
        events: [historyEvent("live-1", 99, "2025-07-19T22:21:09.000Z", "wrong-initial")],
      },
      olderByCursor: new Map([
        [
          "older-1",
          {
            sessionId: "live-1",
            events: [historyEvent("live-1", 1, "2025-07-19T22:21:01.000Z", "older")],
          },
        ],
      ]),
    });
    const engine = new RuntimeEngine([adapter]);

    const replay = await engine.resumeSession({
      provider: "codex",
      providerSessionId: "provider-1",
      preferStoredReplay: true,
    });
    const replayPage = engine.getSessionHistoryPage(replay.session.session.id, { limit: 2 });
    assert.equal(replayPage.nextCursor, "older-1");

    const live = await engine.resumeSession({
      provider: "codex",
      providerSessionId: "provider-1",
      preferStoredReplay: false,
      historySourceSessionId: replay.session.session.id,
    });
    const olderPage = engine.getSessionHistoryPage(live.session.session.id, {
      cursor: "older-1",
      limit: 2,
    });
    assert.deepEqual(
      olderPage.events.map((event) =>
        event.type === "timeline.item.added" && event.payload.item.kind === "assistant_message"
          ? event.payload.item.text
          : null,
      ),
      ["older"],
    );

    await engine.shutdown();
  });

  test("independent terminal starts as standalone PTY and honors resize", async () => {
    const engine = new RuntimeEngine([]);
    const workspace = mkdtempSync(path.join(os.tmpdir(), "rah-terminal-pty-"));

    const terminal = await engine.startIndependentTerminal({
      cwd: workspace,
      cols: 100,
      rows: 32,
    });
    assert.deepEqual(engine.listIndependentTerminals({ cwd: workspace }), [terminal.terminal]);

    let transcript = "";
    let sawExit = false;
    const unsubscribe = engine.ptyHub.subscribe(terminal.terminal.id, (frame) => {
      if (frame.type === "pty.replay") {
        transcript += frame.chunks.join("");
        return;
      }
      if (frame.type === "pty.output") {
        transcript += frame.data;
        return;
      }
      if (frame.type === "pty.exited") {
        sawExit = true;
      }
    });

    engine.onPtyInput(terminal.terminal.id, "browser", "printf 'RAH_TERMINAL_OK\\n'\r");
    await waitFor(() => {
      assert.match(transcript, /RAH_TERMINAL_OK/);
    });

    engine.onPtyResize(terminal.terminal.id, "browser", 140, 40);
    await new Promise((resolve) => setTimeout(resolve, 150));
    engine.onPtyInput(terminal.terminal.id, "browser", "stty size\r");
    await waitFor(() => {
      assert.match(transcript, /40 140/);
    });

    await engine.closeIndependentTerminal(terminal.terminal.id);
    await waitFor(() => {
      assert.equal(sawExit, true);
    });
    assert.deepEqual(engine.listIndependentTerminals({ cwd: workspace }), []);

    unsubscribe();
    await engine.shutdown();
    rmSync(workspace, { force: true, recursive: true });
  });

  test("independent terminal registry separates session owners in the same cwd", async () => {
    const engine = new RuntimeEngine([]);
    const workspace = mkdtempSync(path.join(os.tmpdir(), "rah-terminal-owner-"));

    const first = await engine.startIndependentTerminal({
      cwd: workspace,
      owner: { kind: "session", id: "session-a" },
    });
    const second = await engine.startIndependentTerminal({
      cwd: workspace,
      owner: { kind: "session", id: "session-b" },
    });

    assert.deepEqual(engine.listIndependentTerminals({
      cwd: workspace,
      owner: { kind: "session", id: "session-a" },
    }), [first.terminal]);
    assert.deepEqual(engine.listIndependentTerminals({
      cwd: workspace,
      owner: { kind: "session", id: "session-b" },
    }), [second.terminal]);
    assert.deepEqual(
      engine.listIndependentTerminals({ cwd: workspace }).map((terminal) => terminal.id).sort(),
      [first.terminal.id, second.terminal.id].sort(),
    );

    await engine.closeIndependentTerminal(first.terminal.id);
    await engine.closeIndependentTerminal(second.terminal.id);
    await engine.shutdown();
    rmSync(workspace, { force: true, recursive: true });
  });

  test("explicit native_tui backend routes chat input through PTY", async () => {
    const engine = new RuntimeEngine();
    const workspace = mkdtempSync(path.join(os.tmpdir(), "rah-native-tui-"));
    const fakeCodex = path.join(workspace, "fake-codex.js");
    const providerSessionId = "019de928-7d22-7c63-ba89-dcb25d4a8155";
    const previousCodexBinary = process.env.RAH_CODEX_BINARY;
    const previousCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = path.join(workspace, "codex-home");
    mkdirSync(path.join(process.env.CODEX_HOME, "sessions"), { recursive: true });
    writeFileSync(
      fakeCodex,
      [
        "#!/usr/bin/env node",
        "process.stdout.write(`MOCK_NATIVE_TUI_READY args=${process.argv.slice(2).join('|')}\\r\\n`);",
        `process.stdout.write('Session: ${providerSessionId}\\r\\n');`,
        "process.on('SIGINT', () => {",
        "  process.stdout.write('MOCK_NATIVE_TUI_INTERRUPTED\\r\\n›\\r\\n');",
        "});",
        "process.stdin.setEncoding('utf8');",
        "if (process.stdin.isTTY && process.stdin.setRawMode) {",
        "  process.stdin.setRawMode(true);",
        "}",
        "process.stdin.resume();",
        "let buffer = '';",
        "process.stdin.on('data', (chunk) => {",
        "  buffer += chunk;",
        "  if (buffer.includes('\\u0003') || buffer.includes('\\u001b')) {",
        "    process.stdout.write('MOCK_NATIVE_TUI_INTERRUPTED\\r\\n›\\r\\n');",
        "    buffer = 'aborted stale prompt';",
        "  }",
        "  if (buffer.includes('\\u0015') || buffer.includes('\\u000b')) {",
        "    process.stdout.write('MOCK_NATIVE_TUI_CLEARED\\r\\n');",
        "    buffer = buffer.slice(Math.max(buffer.lastIndexOf('\\u0015'), buffer.lastIndexOf('\\u000b')) + 1);",
        "  }",
        "  const parts = buffer.split(/\\r|\\n/);",
        "  buffer = parts.pop() ?? '';",
        "  for (const part of parts) {",
        "    if (part.trim()) {",
        "      process.stdout.write(`MOCK_NATIVE_TUI_INPUT:${part.trim()}\\r\\n`);",
        "    }",
        "  }",
        "});",
        "setInterval(() => undefined, 1000);",
        "",
      ].join("\n"),
    );
    chmodSync(fakeCodex, 0o755);
    process.env.RAH_CODEX_BINARY = fakeCodex;

    try {
      const started = await engine.startSession({
        provider: "codex",
        cwd: workspace,
        liveBackend: "native_tui",
        model: "gpt-native-test",
        modeId: "never/danger-full-access",
        attach: {
          client: {
            id: "web-native",
            kind: "web",
            connectionId: "web-native",
          },
          mode: "interactive",
          claimControl: true,
        },
      });
      const sessionId = started.session.session.id;
      assert.equal(started.session.session.liveBackend, "native_tui");
      assert.equal(started.session.session.nativeTui?.terminalId, sessionId);
      assert.equal(started.session.session.capabilities.nativeTui, true);
      assert.equal(started.session.session.capabilities.rawPtyInput, true);
      assert.equal(started.session.session.capabilities.structuredControl, false);

      let transcript = "";
      let sawExit = false;
      const unsubscribe = engine.ptyHub.subscribe(sessionId, (frame) => {
        if (frame.type === "pty.replay") {
          transcript += frame.chunks.join("");
        } else if (frame.type === "pty.output") {
          transcript += frame.data;
        } else if (frame.type === "pty.exited") {
          sawExit = true;
        }
      });

      await waitFor(() => {
        assert.match(transcript, /MOCK_NATIVE_TUI_READY/);
        assert.match(transcript, /--model\|gpt-native-test/);
        assert.match(transcript, /--dangerously-bypass-approvals-and-sandbox/);
        assert.equal(engine.getSessionSummary(sessionId).session.providerSessionId, providerSessionId);
      }, { timeoutMs: 5_000 });

      await assert.rejects(
        () => engine.setSessionMode(sessionId, "plan"),
        /does not expose mode controls|controlled outside RAH|does not support/,
      );
      await assert.rejects(
        () => engine.setSessionModel(sessionId, { modelId: "gpt-native-rejected" }),
        /does not support model switching/,
      );
      assert.equal(engine.getSessionSummary(sessionId).session.runtimeState, "idle");

      engine.sendInput(sessionId, {
        clientId: "web-native",
        text: "hello native tui",
        clientTurnId: "client-turn-native-1",
      });
      await waitFor(() => {
        assert.match(transcript, /MOCK_NATIVE_TUI_INPUT:hello native tui/);
      });

      engine.interruptSession(sessionId, { clientId: "web-native" });
      engine.interruptSession(sessionId, { clientId: "web-native" });
      await waitFor(() => {
        assert.match(transcript, /MOCK_NATIVE_TUI_INTERRUPTED/);
        assert.equal(engine.getSessionSummary(sessionId).session.runtimeState, "idle");
      });
      assert.equal(transcript.match(/MOCK_NATIVE_TUI_INTERRUPTED/g)?.length, 1);
      const canceledEvents = engine.eventBus
        .list({ sessionIds: [sessionId] })
        .filter((event) => event.type === "turn.canceled");
      assert.equal(canceledEvents.length, 1);
      assert.equal(canceledEvents[0]?.turnId, "client-turn-native-1");
      await waitFor(() => {
        assert.match(transcript, /MOCK_NATIVE_TUI_CLEARED/);
      });

      engine.sendInput(sessionId, { clientId: "web-native", text: "second native tui" });
      await waitFor(() => {
        assert.match(transcript, /MOCK_NATIVE_TUI_INPUT:second native tui/);
      });
      assert.doesNotMatch(
        transcript,
        /MOCK_NATIVE_TUI_INPUT:aborted stale promptsecond native tui/,
      );

      await engine.closeSession(sessionId, { clientId: "web-native" });
      await waitFor(() => {
        assert.equal(sawExit, true);
      });
      assert.equal(engine.listSessions().sessions.some((entry) => entry.session.id === sessionId), false);
      unsubscribe();
    } finally {
      if (previousCodexBinary === undefined) {
        delete process.env.RAH_CODEX_BINARY;
      } else {
        process.env.RAH_CODEX_BINARY = previousCodexBinary;
      }
      if (previousCodexHome === undefined) {
        delete process.env.CODEX_HOME;
      } else {
        process.env.CODEX_HOME = previousCodexHome;
      }
      await engine.shutdown();
      rmSync(workspace, { force: true, recursive: true });
    }
  });

  test("native TUI startup failures keep the provider error on the stopped session", async () => {
    const engine = new RuntimeEngine([]);
    const workspace = mkdtempSync(path.join(os.tmpdir(), "rah-native-tui-failing-"));
    const fakeClaude = path.join(workspace, "fake-claude-failing.js");
    const configDir = mkdtempSync(path.join(os.tmpdir(), "rah-native-tui-failing-claude-config-"));
    const previousClaudeBinary = process.env.RAH_CLAUDE_BINARY;
    const previousClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
    writeFileSync(
      fakeClaude,
      [
        "#!/usr/bin/env node",
        "process.stdout.write('Claude boot\\r\\nError: invalid model claude-wrong-model\\r\\n');",
        "setTimeout(() => process.exit(1), 80);",
        "",
      ].join("\n"),
    );
    chmodSync(fakeClaude, 0o755);
    process.env.RAH_CLAUDE_BINARY = fakeClaude;
    process.env.CLAUDE_CONFIG_DIR = configDir;

    try {
      const started = await engine.startSession({
        provider: "claude",
        cwd: workspace,
        liveBackend: "native_tui",
        model: "claude-wrong-model",
        attach: {
          client: {
            id: "web-native-failing-claude",
            kind: "web",
            connectionId: "web-native-failing-claude",
          },
          mode: "interactive",
          claimControl: true,
        },
      });
      const sessionId = started.session.session.id;
      await waitFor(() => {
        const summary = engine.getSessionSummary(sessionId).session;
        assert.equal(summary.runtimeState, "failed");
        assert.equal(summary.status, "stopped");
        assert.equal(summary.phase, "failed");
        assert.match(
          summary.runtimeDiagnostics?.lastError ?? "",
          /invalid model claude-wrong-model/,
        );
      }, { timeoutMs: 5_000 });

      await engine.closeSession(sessionId, { clientId: "web-native-failing-claude" });
      assert.throws(() => engine.getSessionSummary(sessionId), /Unknown session/);
    } finally {
      if (previousClaudeBinary === undefined) {
        delete process.env.RAH_CLAUDE_BINARY;
      } else {
        process.env.RAH_CLAUDE_BINARY = previousClaudeBinary;
      }
      if (previousClaudeConfigDir === undefined) {
        delete process.env.CLAUDE_CONFIG_DIR;
      } else {
        process.env.CLAUDE_CONFIG_DIR = previousClaudeConfigDir;
      }
      await engine.shutdown();
      rmSync(workspace, { force: true, recursive: true });
      rmSync(configDir, { force: true, recursive: true });
    }
  });

  test("native TUI backend survives web detach and clientless session listing", async () => {
    const engine = new RuntimeEngine([]);
    const workspace = mkdtempSync(path.join(os.tmpdir(), "rah-native-tui-detached-"));
    const fakeCodex = path.join(workspace, "fake-codex.js");
    const providerSessionId = "019de928-7d22-7c63-ba89-dcb25d4a8666";
    const previousCodexBinary = process.env.RAH_CODEX_BINARY;
    const previousCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = path.join(workspace, "codex-home");
    mkdirSync(path.join(process.env.CODEX_HOME, "sessions"), { recursive: true });
    writeFileSync(
      fakeCodex,
      [
        "#!/usr/bin/env node",
        "process.stdout.write('MOCK_NATIVE_TUI_DETACHED_READY\\r\\n');",
        `process.stdout.write('Session: ${providerSessionId}\\r\\n');`,
        "process.stdin.resume();",
        "setInterval(() => undefined, 1000);",
        "",
      ].join("\n"),
    );
    chmodSync(fakeCodex, 0o755);
    process.env.RAH_CODEX_BINARY = fakeCodex;

    try {
      const started = await engine.startSession({
        provider: "codex",
        cwd: workspace,
        liveBackend: "native_tui",
        attach: {
          client: {
            id: "web-native",
            kind: "web",
            connectionId: "web-native",
          },
          mode: "interactive",
          claimControl: true,
        },
      });
      const sessionId = started.session.session.id;
      assert.equal(started.session.attachedClients.length, 1);
      assert.equal(started.session.controlLease.holderClientId, "web-user");
      await waitFor(() => {
        assert.equal(engine.getSessionSummary(sessionId).session.providerSessionId, providerSessionId);
      }, { timeoutMs: 5_000 });

      const detached = engine.detachSession(sessionId, { clientId: "web-native" });
      assert.equal(detached.attachedClients.length, 0);
      assert.equal(detached.controlLease.holderClientId, undefined);

      const listed = engine.listSessions();
      assert.equal(listed.sessions.some((entry) => entry.session.id === sessionId), true);
      assert.ok(engine.sessionStore.getSession(sessionId));
      assert.equal(engine.ptyHub.stats(sessionId)?.status, "open");
    } finally {
      if (previousCodexBinary === undefined) {
        delete process.env.RAH_CODEX_BINARY;
      } else {
        process.env.RAH_CODEX_BINARY = previousCodexBinary;
      }
      if (previousCodexHome === undefined) {
        delete process.env.CODEX_HOME;
      } else {
        process.env.CODEX_HOME = previousCodexHome;
      }
      await engine.shutdown();
      rmSync(workspace, { force: true, recursive: true });
    }
  });

  test("native TUI backend queues chat input while the native prompt is busy", async () => {
    const engine = new RuntimeEngine([]);
    const workspace = mkdtempSync(path.join(os.tmpdir(), "rah-native-tui-queue-"));
    const fakeCodex = path.join(workspace, "fake-codex.js");
    const providerSessionId = "019de928-7d22-7c63-ba89-dcb25d4a8555";
    const previousCodexBinary = process.env.RAH_CODEX_BINARY;
    const previousCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = path.join(workspace, "codex-home");
    mkdirSync(path.join(process.env.CODEX_HOME, "sessions"), { recursive: true });
    writeFileSync(
      fakeCodex,
      [
        "#!/usr/bin/env node",
        `process.stdout.write('Session: ${providerSessionId}\\r\\n');`,
        "process.stdin.setEncoding('utf8');",
        "process.stdin.resume();",
        "let buffer = '';",
        "let inputCount = 0;",
        "process.stdin.on('data', (chunk) => {",
        "  buffer += chunk;",
        "  const parts = buffer.split(/\\r|\\n/);",
        "  buffer = parts.pop() ?? '';",
        "  for (const part of parts) {",
        "    if (!part.trim()) continue;",
        "    inputCount += 1;",
        "    process.stdout.write(`MOCK_NATIVE_TUI_QUEUE_INPUT_${inputCount}:${part.trim()}\\r\\n`);",
        "    if (inputCount === 1) {",
        "      setTimeout(() => process.stdout.write('MOCK_NATIVE_TUI_QUEUE_PROMPT\\r\\n› '), 150);",
        "    }",
        "  }",
        "});",
        "setInterval(() => undefined, 1000);",
        "",
      ].join("\n"),
    );
    chmodSync(fakeCodex, 0o755);
    process.env.RAH_CODEX_BINARY = fakeCodex;

    try {
      const started = await engine.startSession({
        provider: "codex",
        cwd: workspace,
        liveBackend: "native_tui",
        attach: {
          client: {
            id: "web-native",
            kind: "web",
            connectionId: "web-native",
          },
          mode: "interactive",
          claimControl: true,
        },
      });
      const sessionId = started.session.session.id;
      let transcript = "";
      const unsubscribe = engine.ptyHub.subscribe(sessionId, (frame) => {
        if (frame.type === "pty.replay") {
          transcript += frame.chunks.join("");
        } else if (frame.type === "pty.output") {
          transcript += frame.data;
        }
      });

      await waitFor(() => {
        assert.equal(engine.getSessionSummary(sessionId).session.providerSessionId, providerSessionId);
      });
      engine.sendInput(sessionId, { clientId: "web-native", text: "first queued prompt" });
      engine.sendInput(sessionId, { clientId: "web-native", text: "second queued prompt" });

      await waitFor(() => {
        assert.match(transcript, /MOCK_NATIVE_TUI_QUEUE_INPUT_1:first queued prompt/);
        assert.match(transcript, /MOCK_NATIVE_TUI_QUEUE_PROMPT/);
        assert.match(transcript, /MOCK_NATIVE_TUI_QUEUE_INPUT_2:second queued prompt/);
        assert.ok(
          transcript.indexOf("MOCK_NATIVE_TUI_QUEUE_INPUT_2") >
            transcript.indexOf("MOCK_NATIVE_TUI_QUEUE_PROMPT"),
        );
      });

      unsubscribe();
      await engine.closeSession(sessionId, { clientId: "web-native" });
    } finally {
      if (previousCodexBinary === undefined) {
        delete process.env.RAH_CODEX_BINARY;
      } else {
        process.env.RAH_CODEX_BINARY = previousCodexBinary;
      }
      if (previousCodexHome === undefined) {
        delete process.env.CODEX_HOME;
      } else {
        process.env.CODEX_HOME = previousCodexHome;
      }
      await engine.shutdown();
      rmSync(workspace, { force: true, recursive: true });
    }
  });

  test("native TUI backend queues chat input while the TUI prompt is dirty", async () => {
    const engine = new RuntimeEngine([]);
    const workspace = mkdtempSync(path.join(os.tmpdir(), "rah-native-tui-dirty-"));
    const fakeCodex = path.join(workspace, "fake-codex.js");
    const providerSessionId = "019de928-7d22-7c63-ba89-dcb25d4a8666";
    const previousCodexBinary = process.env.RAH_CODEX_BINARY;
    const previousCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = path.join(workspace, "codex-home");
    mkdirSync(path.join(process.env.CODEX_HOME, "sessions"), { recursive: true });
    writeFileSync(
      fakeCodex,
      [
        "#!/usr/bin/env node",
        `process.stdout.write('Session: ${providerSessionId}\\r\\n');`,
        "process.stdin.setEncoding('utf8');",
        "process.stdin.resume();",
        "process.stdin.on('data', (chunk) => process.stdout.write(`MOCK_NATIVE_TUI_RAW:${JSON.stringify(chunk)}\\r\\n`));",
        "setInterval(() => undefined, 1000);",
        "",
      ].join("\n"),
    );
    chmodSync(fakeCodex, 0o755);
    process.env.RAH_CODEX_BINARY = fakeCodex;

    try {
      const started = await engine.startSession({
        provider: "codex",
        cwd: workspace,
        liveBackend: "native_tui",
        attach: {
          client: {
            id: "web-native",
            kind: "web",
            connectionId: "web-native",
          },
          mode: "interactive",
          claimControl: true,
        },
      });
      const sessionId = started.session.session.id;
      let transcript = "";
      const unsubscribe = engine.ptyHub.subscribe(sessionId, (frame) => {
        if (frame.type === "pty.replay") {
          transcript += frame.chunks.join("");
        } else if (frame.type === "pty.output") {
          transcript += frame.data;
        }
      });

      await waitFor(() => {
        assert.equal(engine.getSessionSummary(sessionId).session.providerSessionId, providerSessionId);
      });
      assert.equal(engine.getSessionSummary(sessionId).session.nativeTui?.promptState, "prompt_clean");
      assert.throws(
        () => engine.onPtyInput(sessionId, "other-client", "blocked"),
        /does not hold input control/,
      );
      assert.throws(
        () => engine.onPtyResize(sessionId, "other-client", 100, 30),
        /does not hold input control/,
      );
      engine.onPtyInput(sessionId, "web-native", "partial local draft");
      await waitFor(() => {
        assert.equal(engine.getSessionSummary(sessionId).session.nativeTui?.promptState, "prompt_dirty");
      });
      engine.sendInput(sessionId, { clientId: "web-native", text: "send after dirty prompt" });
      await waitFor(() => {
        assert.equal(engine.getSessionSummary(sessionId).session.nativeTui?.queuedInputCount, 1);
      });
      assert.equal(engine.getSessionSummary(sessionId).session.runtimeState, "running");

      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.doesNotMatch(transcript, /send after dirty prompt/);

      engine.onPtyInput(sessionId, "web-native", "\u001b");
      await waitFor(() => {
        assert.equal(engine.getSessionSummary(sessionId).session.nativeTui?.promptState, "agent_busy");
        assert.match(transcript, /MOCK_NATIVE_TUI_RAW:.*send after dirty prompt/);
      });

      unsubscribe();
      await engine.closeSession(sessionId, { clientId: "web-native" });
    } finally {
      if (previousCodexBinary === undefined) {
        delete process.env.RAH_CODEX_BINARY;
      } else {
        process.env.RAH_CODEX_BINARY = previousCodexBinary;
      }
      if (previousCodexHome === undefined) {
        delete process.env.CODEX_HOME;
      } else {
        process.env.CODEX_HOME = previousCodexHome;
      }
      await engine.shutdown();
      rmSync(workspace, { force: true, recursive: true });
    }
  });

  test("native TUI backend keeps chat send enabled after terminal escape navigation", async () => {
    const engine = new RuntimeEngine([]);
    const workspace = mkdtempSync(path.join(os.tmpdir(), "rah-native-tui-escape-clean-"));
    const fakeCodex = path.join(workspace, "fake-codex.js");
    const providerSessionId = "019de928-7d22-7c63-ba89-dcb25d4a8777";
    const previousCodexBinary = process.env.RAH_CODEX_BINARY;
    const previousCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = path.join(workspace, "codex-home");
    mkdirSync(path.join(process.env.CODEX_HOME, "sessions"), { recursive: true });
    writeFileSync(
      fakeCodex,
      [
        "#!/usr/bin/env node",
        `process.stdout.write('Session: ${providerSessionId}\\r\\n');`,
        "process.stdin.setEncoding('utf8');",
        "process.stdin.resume();",
        "process.stdin.on('data', (chunk) => process.stdout.write(`MOCK_NATIVE_TUI_ESCAPE:${JSON.stringify(chunk)}\\r\\n`));",
        "setInterval(() => undefined, 1000);",
        "",
      ].join("\n"),
    );
    chmodSync(fakeCodex, 0o755);
    process.env.RAH_CODEX_BINARY = fakeCodex;

    try {
      const started = await engine.startSession({
        provider: "codex",
        cwd: workspace,
        liveBackend: "native_tui",
        attach: {
          client: {
            id: "web-native",
            kind: "web",
            connectionId: "web-native",
          },
          mode: "interactive",
          claimControl: true,
        },
      });
      const sessionId = started.session.session.id;
      let transcript = "";
      const unsubscribe = engine.ptyHub.subscribe(sessionId, (frame) => {
        if (frame.type === "pty.replay") {
          transcript += frame.chunks.join("");
        } else if (frame.type === "pty.output") {
          transcript += frame.data;
        }
      });

      await waitFor(() => {
        assert.equal(engine.getSessionSummary(sessionId).session.providerSessionId, providerSessionId);
      });
      assert.equal(engine.getSessionSummary(sessionId).session.nativeTui?.promptState, "prompt_clean");

      engine.onPtyInput(sessionId, "web-native", "\u001b[I");
      engine.onPtyInput(sessionId, "web-native", "\u001b[O");
      engine.onPtyInput(sessionId, "web-native", "\u001b[A");

      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(engine.getSessionSummary(sessionId).session.nativeTui?.promptState, "prompt_clean");
      engine.sendInput(sessionId, { clientId: "web-native", text: "chat still works" });

      await waitFor(() => {
        assert.match(transcript, /MOCK_NATIVE_TUI_ESCAPE:.*chat still works/);
      });
      await waitFor(() => {
        assert.equal(engine.getSessionSummary(sessionId).session.nativeTui?.promptState, "agent_busy");
      });

      engine.onPtyInput(sessionId, "web-native", "\u001b[I");
      await waitFor(() => {
        assert.equal(engine.getSessionSummary(sessionId).session.nativeTui?.promptState, "prompt_clean");
      });
      engine.sendInput(sessionId, {
        clientId: "web-native",
        text: "chat still works after busy escape",
      });
      await waitFor(() => {
        assert.match(transcript, /MOCK_NATIVE_TUI_ESCAPE:.*chat still works after busy escape/);
      });

      unsubscribe();
      await engine.closeSession(sessionId, { clientId: "web-native" });
    } finally {
      if (previousCodexBinary === undefined) {
        delete process.env.RAH_CODEX_BINARY;
      } else {
        process.env.RAH_CODEX_BINARY = previousCodexBinary;
      }
      if (previousCodexHome === undefined) {
        delete process.env.CODEX_HOME;
      } else {
        process.env.CODEX_HOME = previousCodexHome;
      }
      await engine.shutdown();
      rmSync(workspace, { force: true, recursive: true });
    }
  });

  test("native TUI backend binds Codex provider session from discovered rollout history", async () => {
    const engine = new RuntimeEngine([]);
    const workspace = mkdtempSync(path.join(os.tmpdir(), "rah-native-tui-bind-"));
    const fakeCodex = path.join(workspace, "fake-codex.js");
    const providerSessionId = "019de928-7d22-7c63-ba89-dcb25d4a8111";
    const previousCodexBinary = process.env.RAH_CODEX_BINARY;
    const previousCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = path.join(workspace, "codex-home");
    mkdirSync(path.join(process.env.CODEX_HOME, "sessions"), { recursive: true });
    writeFileSync(
      fakeCodex,
      [
        "#!/usr/bin/env node",
        "const fs = require('node:fs');",
        "const path = require('node:path');",
        "process.stdout.write('MOCK_NATIVE_TUI_HISTORY_BIND_READY\\r\\n');",
        "setTimeout(() => {",
        "  const home = process.env.CODEX_HOME;",
        "  const rollout = path.join(home, 'sessions', 'rollout-bind.jsonl');",
        "  fs.mkdirSync(path.dirname(rollout), { recursive: true });",
        "  fs.writeFileSync(rollout, JSON.stringify({",
        "    type: 'session_meta',",
        `    payload: { id: '${providerSessionId}', cwd: process.cwd(), timestamp: new Date().toISOString() },`,
        "  }) + '\\n');",
        "}, 100);",
        "process.stdin.resume();",
        "setInterval(() => undefined, 1000);",
        "",
      ].join("\n"),
    );
    chmodSync(fakeCodex, 0o755);
    process.env.RAH_CODEX_BINARY = fakeCodex;

    try {
      const started = await engine.startSession({
        provider: "codex",
        cwd: workspace,
        liveBackend: "native_tui",
        attach: {
          client: {
            id: "web-native",
            kind: "web",
            connectionId: "web-native",
          },
          mode: "interactive",
          claimControl: true,
        },
      });
      const sessionId = started.session.session.id;
      await waitFor(
        () => {
          assert.equal(engine.getSessionSummary(sessionId).session.providerSessionId, providerSessionId);
        },
        { timeoutMs: 4_000 },
      );
      await engine.closeSession(sessionId, { clientId: "web-native" });
    } finally {
      if (previousCodexBinary === undefined) {
        delete process.env.RAH_CODEX_BINARY;
      } else {
        process.env.RAH_CODEX_BINARY = previousCodexBinary;
      }
      if (previousCodexHome === undefined) {
        delete process.env.CODEX_HOME;
      } else {
        process.env.CODEX_HOME = previousCodexHome;
      }
      await engine.shutdown();
      rmSync(workspace, { force: true, recursive: true });
    }
  });

  test("native TUI backend ignores unrelated Codex rollout updates without local binding evidence", async () => {
    const engine = new RuntimeEngine([]);
    const workspace = mkdtempSync(path.join(os.tmpdir(), "rah-native-tui-codex-unrelated-"));
    const fakeCodex = path.join(workspace, "fake-codex.js");
    const externalProviderSessionId = "019de928-7d22-7c63-ba89-dcb25d4a8999";
    const previousCodexBinary = process.env.RAH_CODEX_BINARY;
    const previousCodexHome = process.env.CODEX_HOME;
    const previousProbeInterval = process.env.RAH_NATIVE_TUI_BINDING_PROBE_INTERVAL_MS;
    const previousMockBaseHome = process.env.MOCK_BASE_CODEX_HOME;
    const baseHome = path.join(workspace, "codex-home");
    process.env.CODEX_HOME = baseHome;
    process.env.MOCK_BASE_CODEX_HOME = baseHome;
    process.env.RAH_NATIVE_TUI_BINDING_PROBE_INTERVAL_MS = "25";
    mkdirSync(path.join(baseHome, "sessions"), { recursive: true });
    writeFileSync(
      fakeCodex,
      [
        "#!/usr/bin/env node",
        "const fs = require('node:fs');",
        "const path = require('node:path');",
        "process.stdout.write('MOCK_NATIVE_TUI_UNRELATED_CODEX_READY\\r\\n');",
        "setTimeout(() => {",
        "  const home = process.env.MOCK_BASE_CODEX_HOME;",
        "  const rollout = path.join(home, 'sessions', 'external-rollout.jsonl');",
        "  fs.mkdirSync(path.dirname(rollout), { recursive: true });",
        "  fs.writeFileSync(rollout, JSON.stringify({",
        "    type: 'session_meta',",
        `    payload: { id: '${externalProviderSessionId}', cwd: process.cwd(), timestamp: new Date().toISOString() },`,
        "  }) + '\\n');",
        "}, 80);",
        "process.stdin.resume();",
        "setInterval(() => undefined, 1000);",
        "",
      ].join("\n"),
    );
    chmodSync(fakeCodex, 0o755);
    process.env.RAH_CODEX_BINARY = fakeCodex;

    try {
      const started = await engine.startSession({
        provider: "codex",
        cwd: workspace,
        liveBackend: "native_tui",
        attach: {
          client: {
            id: "web-native",
            kind: "web",
            connectionId: "web-native",
          },
          mode: "interactive",
          claimControl: true,
        },
      });
      const sessionId = started.session.session.id;
      await new Promise((resolve) => setTimeout(resolve, 350));
      assert.equal(engine.getSessionSummary(sessionId).session.providerSessionId, undefined);
      await engine.closeSession(sessionId, { clientId: "web-native" });
    } finally {
      if (previousCodexBinary === undefined) {
        delete process.env.RAH_CODEX_BINARY;
      } else {
        process.env.RAH_CODEX_BINARY = previousCodexBinary;
      }
      if (previousCodexHome === undefined) {
        delete process.env.CODEX_HOME;
      } else {
        process.env.CODEX_HOME = previousCodexHome;
      }
      if (previousProbeInterval === undefined) {
        delete process.env.RAH_NATIVE_TUI_BINDING_PROBE_INTERVAL_MS;
      } else {
        process.env.RAH_NATIVE_TUI_BINDING_PROBE_INTERVAL_MS = previousProbeInterval;
      }
      if (previousMockBaseHome === undefined) {
        delete process.env.MOCK_BASE_CODEX_HOME;
      } else {
        process.env.MOCK_BASE_CODEX_HOME = previousMockBaseHome;
      }
      await engine.shutdown();
      rmSync(workspace, { force: true, recursive: true });
    }
  });

  test("native TUI diagnostics record and resolve delayed provider binding", async () => {
    const engine = new RuntimeEngine([]);
    const workspace = mkdtempSync(path.join(os.tmpdir(), "rah-native-tui-diagnostic-bind-"));
    const fakeCodex = path.join(workspace, "fake-codex.js");
    const providerSessionId = "019de928-7d22-7c63-ba89-dcb25d4a8444";
    const previousCodexBinary = process.env.RAH_CODEX_BINARY;
    const previousCodexHome = process.env.CODEX_HOME;
    const previousProbeInterval = process.env.RAH_NATIVE_TUI_BINDING_PROBE_INTERVAL_MS;
    const previousWarnAfter = process.env.RAH_NATIVE_TUI_BINDING_WARN_AFTER_MS;
    const previousConsoleWarn = console.warn;
    console.warn = () => undefined;
    process.env.CODEX_HOME = path.join(workspace, "codex-home");
    process.env.RAH_NATIVE_TUI_BINDING_PROBE_INTERVAL_MS = "25";
    process.env.RAH_NATIVE_TUI_BINDING_WARN_AFTER_MS = "25";
    mkdirSync(path.join(process.env.CODEX_HOME, "sessions"), { recursive: true });
    writeFileSync(
      fakeCodex,
      [
        "#!/usr/bin/env node",
        "process.stdout.write('MOCK_NATIVE_TUI_DIAGNOSTIC_BIND_READY\\r\\n');",
        `setTimeout(() => process.stdout.write('Session: ${providerSessionId}\\r\\n'), 150);`,
        "process.stdin.resume();",
        "setInterval(() => undefined, 1000);",
        "",
      ].join("\n"),
    );
    chmodSync(fakeCodex, 0o755);
    process.env.RAH_CODEX_BINARY = fakeCodex;

    try {
      const started = await engine.startSession({
        provider: "codex",
        cwd: workspace,
        liveBackend: "native_tui",
        attach: {
          client: {
            id: "web-native",
            kind: "web",
            connectionId: "web-native",
          },
          mode: "interactive",
          claimControl: true,
        },
      });
      const sessionId = started.session.session.id;

      await waitFor(() => {
        const active = engine.listNativeTuiDiagnostics({ sessionId });
        assert.equal(active.length, 1);
        assert.equal(active[0]?.kind, "binding_missing");
        assert.equal(active[0]?.status, "active");
        assert.equal(active[0]?.provider, "codex");
      });

      await waitFor(() => {
        assert.equal(engine.getSessionSummary(sessionId).session.providerSessionId, providerSessionId);
        assert.equal(engine.listNativeTuiDiagnostics({ sessionId }).length, 0);
        const resolved = engine.listNativeTuiDiagnostics({ sessionId, includeResolved: true });
        assert.equal(resolved.length, 1);
        assert.equal(resolved[0]?.kind, "binding_missing");
        assert.equal(resolved[0]?.status, "resolved");
        assert.equal(resolved[0]?.providerSessionId, providerSessionId);
      });

      await engine.closeSession(sessionId, { clientId: "web-native" });
    } finally {
      if (previousCodexBinary === undefined) {
        delete process.env.RAH_CODEX_BINARY;
      } else {
        process.env.RAH_CODEX_BINARY = previousCodexBinary;
      }
      if (previousCodexHome === undefined) {
        delete process.env.CODEX_HOME;
      } else {
        process.env.CODEX_HOME = previousCodexHome;
      }
      if (previousProbeInterval === undefined) {
        delete process.env.RAH_NATIVE_TUI_BINDING_PROBE_INTERVAL_MS;
      } else {
        process.env.RAH_NATIVE_TUI_BINDING_PROBE_INTERVAL_MS = previousProbeInterval;
      }
      if (previousWarnAfter === undefined) {
        delete process.env.RAH_NATIVE_TUI_BINDING_WARN_AFTER_MS;
      } else {
        process.env.RAH_NATIVE_TUI_BINDING_WARN_AFTER_MS = previousWarnAfter;
      }
      console.warn = previousConsoleWarn;
      await engine.shutdown();
      rmSync(workspace, { force: true, recursive: true });
    }
  });

  test("native TUI diagnostics record unexpected provider process exits", async () => {
    const engine = new RuntimeEngine([]);
    const workspace = mkdtempSync(path.join(os.tmpdir(), "rah-native-tui-diagnostic-exit-"));
    const fakeCodex = path.join(workspace, "fake-codex.js");
    const providerSessionId = "019de928-7d22-7c63-ba89-dcb25d4a8555";
    const previousCodexBinary = process.env.RAH_CODEX_BINARY;
    const previousCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = path.join(workspace, "codex-home");
    mkdirSync(path.join(process.env.CODEX_HOME, "sessions"), { recursive: true });
    writeFileSync(
      fakeCodex,
      [
        "#!/usr/bin/env node",
        "process.stdout.write('MOCK_NATIVE_TUI_EXIT_READY\\r\\n');",
        `process.stdout.write('Session: ${providerSessionId}\\r\\n');`,
        "setTimeout(() => process.exit(7), 120);",
        "process.stdin.resume();",
        "",
      ].join("\n"),
    );
    chmodSync(fakeCodex, 0o755);
    process.env.RAH_CODEX_BINARY = fakeCodex;

    try {
      const started = await engine.startSession({
        provider: "codex",
        cwd: workspace,
        liveBackend: "native_tui",
        attach: {
          client: {
            id: "web-native",
            kind: "web",
            connectionId: "web-native",
          },
          mode: "interactive",
          claimControl: true,
        },
      });
      const sessionId = started.session.session.id;

      await waitFor(() => {
        const summary = engine.getSessionSummary(sessionId);
        assert.equal(summary.session.runtimeState, "stopped");
        assert.equal(summary.session.capabilities.steerInput, false);
        assert.equal(summary.session.capabilities.rawPtyInput, false);
        const active = engine.listNativeTuiDiagnostics({ sessionId });
        assert.equal(active.length, 1);
        assert.equal(active[0]?.kind, "process_exited");
        assert.equal(active[0]?.status, "active");
        assert.equal(active[0]?.severity, "warning");
        assert.equal(active[0]?.providerSessionId, providerSessionId);
        assert.equal(active[0]?.details?.exitCode, 7);
      });

      await engine.closeSession(sessionId, { clientId: "web-native" });
      const resolved = engine.listNativeTuiDiagnostics({ sessionId, includeResolved: true });
      assert.equal(resolved.some((diagnostic) => diagnostic.kind === "process_exited"), true);
      assert.equal(
        resolved.find((diagnostic) => diagnostic.kind === "process_exited")?.status,
        "resolved",
      );
    } finally {
      if (previousCodexBinary === undefined) {
        delete process.env.RAH_CODEX_BINARY;
      } else {
        process.env.RAH_CODEX_BINARY = previousCodexBinary;
      }
      if (previousCodexHome === undefined) {
        delete process.env.CODEX_HOME;
      } else {
        process.env.CODEX_HOME = previousCodexHome;
      }
      await engine.shutdown();
      rmSync(workspace, { force: true, recursive: true });
    }
  });

  test("native TUI backend mirrors Codex rollout history into structured chat events", async () => {
    const engine = new RuntimeEngine([]);
    const workspace = mkdtempSync(path.join(os.tmpdir(), "rah-native-tui-mirror-"));
    const fakeCodex = path.join(workspace, "fake-codex.js");
    const providerSessionId = "019de928-7d22-7c63-ba89-dcb25d4a8222";
    const previousCodexBinary = process.env.RAH_CODEX_BINARY;
    const previousCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = path.join(workspace, "codex-home");
    mkdirSync(path.join(process.env.CODEX_HOME, "sessions"), { recursive: true });
    writeFileSync(
      fakeCodex,
      [
        "#!/usr/bin/env node",
        "const fs = require('node:fs');",
        "const path = require('node:path');",
        "process.stdout.write('MOCK_NATIVE_TUI_MIRROR_READY\\r\\n');",
        "setTimeout(() => {",
        "  const home = process.env.CODEX_HOME;",
        "  const rollout = path.join(home, 'sessions', 'rollout-mirror.jsonl');",
        "  fs.mkdirSync(path.dirname(rollout), { recursive: true });",
        "  const rows = [",
        "    { timestamp: '2026-05-03T00:00:00.000Z', type: 'session_meta', payload: { id: process.env.MOCK_PROVIDER_SESSION_ID, cwd: process.cwd(), timestamp: '2026-05-03T00:00:00.000Z' } },",
        "    { timestamp: '2026-05-03T00:00:01.000Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-native' } },",
        "    { timestamp: '2026-05-03T00:00:02.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Native mirror question' }] } },",
        "    { timestamp: '2026-05-03T00:00:03.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Native mirror answer' }] } },",
        "    { timestamp: '2026-05-03T00:00:04.000Z', type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-native' } },",
        "  ];",
        "  fs.writeFileSync(rollout, rows.map((row) => JSON.stringify(row)).join('\\n') + '\\n');",
        "}, 100);",
        "process.stdin.resume();",
        "setInterval(() => undefined, 1000);",
        "",
      ].join("\n"),
    );
    chmodSync(fakeCodex, 0o755);
    process.env.RAH_CODEX_BINARY = fakeCodex;
    process.env.MOCK_PROVIDER_SESSION_ID = providerSessionId;

    try {
      const started = await engine.startSession({
        provider: "codex",
        cwd: workspace,
        liveBackend: "native_tui",
        attach: {
          client: {
            id: "web-native",
            kind: "web",
            connectionId: "web-native",
          },
          mode: "interactive",
          claimControl: true,
        },
      });
      const sessionId = started.session.session.id;
      assert.equal(started.session.session.capabilities.chatMirror, true);
      assert.equal(started.session.session.capabilities.structuredTimeline, true);

      await waitFor(
        () => {
          assert.equal(engine.getSessionSummary(sessionId).session.providerSessionId, providerSessionId);
          const events = engine.listEvents({ sessionIds: [sessionId] });
          assert.ok(
            events.some(
              (event) =>
                event.type === "timeline.item.added" &&
                event.payload.item.kind === "user_message" &&
                event.payload.item.text === "Native mirror question",
            ),
          );
          assert.ok(
            events.some(
              (event) =>
                event.type === "timeline.item.added" &&
                event.payload.item.kind === "assistant_message" &&
                event.payload.item.text === "Native mirror answer" &&
                event.payload.identity?.canonicalItemId,
            ),
          );
          assert.ok(events.some((event) => event.type === "turn.completed"));
          assert.equal(engine.getSessionSummary(sessionId).session.runtimeState, "idle");
        },
        { timeoutMs: 5_000 },
      );
      await engine.closeSession(sessionId, { clientId: "web-native" });
    } finally {
      if (previousCodexBinary === undefined) {
        delete process.env.RAH_CODEX_BINARY;
      } else {
        process.env.RAH_CODEX_BINARY = previousCodexBinary;
      }
      if (previousCodexHome === undefined) {
        delete process.env.CODEX_HOME;
      } else {
        process.env.CODEX_HOME = previousCodexHome;
      }
      delete process.env.MOCK_PROVIDER_SESSION_ID;
      await engine.shutdown();
      rmSync(workspace, { force: true, recursive: true });
    }
  });

  test("native TUI backend resumes Codex sessions and mirrors existing rollout history", async () => {
    const engine = new RuntimeEngine([]);
    const workspace = mkdtempSync(path.join(os.tmpdir(), "rah-native-tui-resume-"));
    const fakeCodex = path.join(workspace, "fake-codex.js");
    const providerSessionId = "019de928-7d22-7c63-ba89-dcb25d4a8333";
    const previousCodexBinary = process.env.RAH_CODEX_BINARY;
    const previousCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = path.join(workspace, "codex-home");
    const sessionsDir = path.join(process.env.CODEX_HOME, "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(
      path.join(sessionsDir, "rollout-resume.jsonl"),
      [
        {
          timestamp: "2026-05-03T00:00:00.000Z",
          type: "session_meta",
          payload: {
            id: providerSessionId,
            cwd: workspace,
            timestamp: "2026-05-03T00:00:00.000Z",
          },
        },
        {
          timestamp: "2026-05-03T00:00:01.000Z",
          type: "event_msg",
          payload: { type: "task_started", turn_id: "turn-resume" },
        },
        {
          timestamp: "2026-05-03T00:00:02.000Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "Resume mirror question" }],
          },
        },
        {
          timestamp: "2026-05-03T00:00:03.000Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "Resume mirror answer" }],
          },
        },
        {
          timestamp: "2026-05-03T00:00:04.000Z",
          type: "event_msg",
          payload: { type: "task_complete", turn_id: "turn-resume" },
        },
      ].map((row) => JSON.stringify(row)).join("\n") + "\n",
    );
    writeFileSync(
      fakeCodex,
      [
        "#!/usr/bin/env node",
        "process.stdout.write(`MOCK_NATIVE_TUI_RESUME_READY args=${process.argv.slice(2).join('|')}\\r\\n`);",
        "process.stdin.setEncoding('utf8');",
        "process.stdin.resume();",
        "let buffer = '';",
        "process.stdin.on('data', (chunk) => {",
        "  buffer += chunk;",
        "  const parts = buffer.split(/\\r|\\n/);",
        "  buffer = parts.pop() ?? '';",
        "  for (const part of parts) {",
        "    if (part.trim()) {",
        "      process.stdout.write(`MOCK_NATIVE_TUI_RESUME_INPUT:${part.trim()}\\r\\n`);",
        "    }",
        "  }",
        "});",
        "setInterval(() => undefined, 1000);",
        "",
      ].join("\n"),
    );
    chmodSync(fakeCodex, 0o755);
    process.env.RAH_CODEX_BINARY = fakeCodex;

    try {
      const resumed = await engine.resumeSession({
        provider: "codex",
        providerSessionId,
        cwd: workspace,
        liveBackend: "native_tui",
        model: "gpt-native-resume",
        modeId: "on-request/workspace-write",
        attach: {
          client: {
            id: "web-native",
            kind: "web",
            connectionId: "web-native",
          },
          mode: "interactive",
          claimControl: true,
        },
      });
      const sessionId = resumed.session.session.id;
      assert.equal(resumed.session.session.providerSessionId, providerSessionId);
      assert.equal(resumed.session.session.liveBackend, "native_tui");
      assert.equal(resumed.session.session.capabilities.chatMirror, true);

      let transcript = "";
      const unsubscribe = engine.ptyHub.subscribe(sessionId, (frame) => {
        if (frame.type === "pty.replay") {
          transcript += frame.chunks.join("");
        } else if (frame.type === "pty.output") {
          transcript += frame.data;
        }
      });

      await waitFor(() => {
        assert.match(transcript, /MOCK_NATIVE_TUI_RESUME_READY/);
        assert.match(transcript, /resume\|--cd/);
        assert.match(transcript, /--model\|gpt-native-resume/);
        assert.match(transcript, /--ask-for-approval\|on-request\|--sandbox\|workspace-write/);
        assert.match(transcript, new RegExp(`${providerSessionId}`));
        const events = engine.listEvents({ sessionIds: [sessionId] });
        assert.ok(
          events.some(
            (event) =>
              event.type === "timeline.item.added" &&
              event.payload.item.kind === "assistant_message" &&
              event.payload.item.text === "Resume mirror answer",
          ),
        );
        assert.ok(events.some((event) => event.type === "turn.completed"));
        assert.equal(engine.getSessionSummary(sessionId).session.runtimeState, "idle");
      });

      engine.sendInput(sessionId, { clientId: "web-native", text: "resume input" });
      await waitFor(() => {
        assert.match(transcript, /MOCK_NATIVE_TUI_RESUME_INPUT:resume input/);
      });

      unsubscribe();
      await engine.closeSession(sessionId, { clientId: "web-native" });
    } finally {
      if (previousCodexBinary === undefined) {
        delete process.env.RAH_CODEX_BINARY;
      } else {
        process.env.RAH_CODEX_BINARY = previousCodexBinary;
      }
      if (previousCodexHome === undefined) {
        delete process.env.CODEX_HOME;
      } else {
        process.env.CODEX_HOME = previousCodexHome;
      }
      await engine.shutdown();
      rmSync(workspace, { force: true, recursive: true });
    }
  });

  test("native TUI backend pre-binds provider session ids for providers that support it", async () => {
    const engine = new RuntimeEngine([]);
    const workspace = mkdtempSync(path.join(os.tmpdir(), "rah-native-tui-claude-"));
    const fakeClaude = path.join(workspace, "fake-claude.js");
    const previousClaudeBinary = process.env.RAH_CLAUDE_BINARY;
    writeFileSync(
      fakeClaude,
      [
        "#!/usr/bin/env node",
        "const fs = require('node:fs');",
        "const path = require('node:path');",
        "const sessionIdArgIndex = process.argv.indexOf('--session-id');",
        "const sessionId = sessionIdArgIndex >= 0 ? process.argv[sessionIdArgIndex + 1] : undefined;",
        "if (process.env.CLAUDE_CONFIG_DIR && sessionId) {",
        "  const projectId = process.cwd().replace(/[^a-zA-Z0-9]/g, '-');",
        "  const projectDir = path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', projectId);",
        "  fs.mkdirSync(projectDir, { recursive: true });",
        "  const now = new Date().toISOString();",
        "  fs.writeFileSync(path.join(projectDir, `${sessionId}.jsonl`), [",
        "    JSON.stringify({ type: 'user', uuid: 'claude-native-user', cwd: process.cwd(), sessionId, timestamp: now, message: { content: 'Claude native question' } }),",
        "    JSON.stringify({ type: 'assistant', uuid: 'claude-native-assistant', cwd: process.cwd(), sessionId, timestamp: now, message: { content: [{ type: 'text', text: 'Claude native answer' }] } }),",
        "  ].join('\\n') + '\\n');",
        "}",
        "process.stdout.write(`MOCK_CLAUDE_TUI_READY args=${process.argv.slice(2).join('|')}\\r\\n`);",
        "process.stdin.setEncoding('utf8');",
        "process.stdin.resume();",
        "let buffer = '';",
        "process.stdin.on('data', (chunk) => {",
        "  buffer += chunk;",
        "  const parts = buffer.split(/\\r|\\n/);",
        "  buffer = parts.pop() ?? '';",
        "  for (const part of parts) {",
        "    if (part.trim()) {",
        "      process.stdout.write(`MOCK_CLAUDE_INPUT:${part.trim()}\\r\\n`);",
        "    }",
        "  }",
        "});",
        "setInterval(() => undefined, 1000);",
        "",
      ].join("\n"),
    );
    chmodSync(fakeClaude, 0o755);
    process.env.RAH_CLAUDE_BINARY = fakeClaude;

    try {
      const started = await engine.startSession({
        provider: "claude",
        cwd: workspace,
        liveBackend: "native_tui",
        model: "opus",
        optionValues: { effort: "max" },
        modeId: "bypassPermissions",
        attach: {
          client: {
            id: "web-native",
            kind: "web",
            connectionId: "web-native",
          },
          mode: "interactive",
          claimControl: true,
        },
      });
      const sessionId = started.session.session.id;
      const providerSessionId = started.session.session.providerSessionId;
      assert.match(providerSessionId ?? "", /^[0-9a-f-]{36}$/);
      assert.equal(started.session.session.liveBackend, "native_tui");
      assert.equal(started.session.session.capabilities.nativeTui, true);
      assert.equal(started.session.session.capabilities.chatMirror, true);

      let transcript = "";
      const unsubscribe = engine.ptyHub.subscribe(sessionId, (frame) => {
        if (frame.type === "pty.replay") {
          transcript += frame.chunks.join("");
        } else if (frame.type === "pty.output") {
          transcript += frame.data;
        }
      });

      await waitFor(() => {
        assert.match(transcript, /MOCK_CLAUDE_TUI_READY/);
        assert.match(transcript, /--permission-mode\|bypassPermissions/);
        assert.match(transcript, /--model\|opus/);
        assert.match(transcript, /--effort\|max/);
        assert.match(transcript, new RegExp(`--session-id\\|${providerSessionId}`));
      });

      engine.sendInput(sessionId, { clientId: "web-native", text: "hello claude native" });
      await waitFor(() => {
        assert.match(transcript, /MOCK_CLAUDE_INPUT:hello claude native/);
      });
      await waitFor(() => {
        assert.ok(
          engine.eventBus
            .list({ sessionIds: [sessionId] })
            .some(
              (event) =>
                event.type === "timeline.item.added" &&
                event.payload.item.kind === "assistant_message" &&
                event.payload.item.text === "Claude native answer" &&
                event.payload.identity?.canonicalItemId,
            ),
        );
      });

      unsubscribe();
      await engine.closeSession(sessionId, { clientId: "web-native" });
    } finally {
      if (previousClaudeBinary === undefined) {
        delete process.env.RAH_CLAUDE_BINARY;
      } else {
        process.env.RAH_CLAUDE_BINARY = previousClaudeBinary;
      }
      await engine.shutdown();
      rmSync(workspace, { force: true, recursive: true });
    }
  });

  test("Claude native TUI mirror remains a history mirror instead of owning busy state", async () => {
    const engine = new RuntimeEngine([]);
    const workspace = mkdtempSync(path.join(os.tmpdir(), "rah-native-tui-claude-stale-"));
    const fakeClaude = path.join(workspace, "fake-claude-stale.js");
    const previousClaudeBinary = process.env.RAH_CLAUDE_BINARY;
    const previousClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
    const previousMirrorInterval = process.env.RAH_NATIVE_TUI_MIRROR_INTERVAL_MS;
    process.env.CLAUDE_CONFIG_DIR = path.join(workspace, "claude-config");
    process.env.RAH_NATIVE_TUI_MIRROR_INTERVAL_MS = "25";
    writeFileSync(
      fakeClaude,
      [
        "#!/usr/bin/env node",
        "const fs = require('node:fs');",
        "const path = require('node:path');",
        "const sessionIdArgIndex = process.argv.indexOf('--session-id');",
        "const sessionId = sessionIdArgIndex >= 0 ? process.argv[sessionIdArgIndex + 1] : undefined;",
        "const staleTimestamp = new Date(Date.now() - 60000).toISOString();",
        "let historyWritten = false;",
        "function writeStaleHistory() {",
        "  if (historyWritten || !process.env.CLAUDE_CONFIG_DIR || !sessionId) return;",
        "  historyWritten = true;",
        "  const projectId = process.cwd().replace(/[^a-zA-Z0-9]/g, '-');",
        "  const projectDir = path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', projectId);",
        "  fs.mkdirSync(projectDir, { recursive: true });",
        "  fs.writeFileSync(path.join(projectDir, `${sessionId}.jsonl`), [",
        "    JSON.stringify({ type: 'user', uuid: 'claude-stale-user', cwd: process.cwd(), sessionId, timestamp: staleTimestamp, message: { content: 'stale Claude question' } }),",
        "    JSON.stringify({ type: 'assistant', uuid: 'claude-stale-assistant', cwd: process.cwd(), sessionId, timestamp: staleTimestamp, message: { content: [{ type: 'text', text: 'stale Claude answer' }] } }),",
        "  ].join('\\n') + '\\n');",
        "}",
        "process.stdout.write(`MOCK_CLAUDE_STALE_READY args=${process.argv.slice(2).join('|')}\\r\\n`);",
        "process.stdin.setEncoding('utf8');",
        "process.stdin.resume();",
        "let buffer = '';",
        "process.stdin.on('data', (chunk) => {",
        "  buffer += chunk;",
        "  const parts = buffer.split(/\\r|\\n/);",
        "  buffer = parts.pop() ?? '';",
        "  for (const part of parts) {",
        "    const text = part.trim();",
        "    if (text) {",
        "      process.stdout.write(`MOCK_CLAUDE_STALE_INPUT:${text}\\r\\n`);",
        "      setTimeout(writeStaleHistory, 50);",
        "    }",
        "  }",
        "});",
        "setInterval(() => undefined, 1000);",
        "",
      ].join("\n"),
    );
    chmodSync(fakeClaude, 0o755);
    process.env.RAH_CLAUDE_BINARY = fakeClaude;

    try {
      const started = await engine.startSession({
        provider: "claude",
        cwd: workspace,
        liveBackend: "native_tui",
        attach: {
          client: {
            id: "web-native",
            kind: "web",
            connectionId: "web-native",
          },
          mode: "interactive",
          claimControl: true,
        },
      });
      const sessionId = started.session.session.id;

      let transcript = "";
      const unsubscribe = engine.ptyHub.subscribe(sessionId, (frame) => {
        if (frame.type === "pty.replay") {
          transcript += frame.chunks.join("");
        } else if (frame.type === "pty.output") {
          transcript += frame.data;
        }
      });
      await waitFor(() => {
        assert.match(transcript, /MOCK_CLAUDE_STALE_READY/);
      });

      engine.sendInput(sessionId, { clientId: "web-native", text: "current web input" });
      await waitFor(() => {
        assert.match(transcript, /MOCK_CLAUDE_STALE_INPUT:current web input/);
      });
      await waitFor(() => {
        assert.ok(
          engine.eventBus
            .list({ sessionIds: [sessionId] })
            .some(
              (event) =>
                event.type === "timeline.item.added" &&
                event.payload.item.kind === "assistant_message" &&
                event.payload.item.text === "stale Claude answer",
            ),
        );
      });
      assert.equal(engine.getSessionSummary(sessionId).session.runtimeState, "idle");

      engine.interruptSession(sessionId, { clientId: "web-native" });
      unsubscribe();
      await engine.closeSession(sessionId, { clientId: "web-native" });
    } finally {
      if (previousClaudeBinary === undefined) {
        delete process.env.RAH_CLAUDE_BINARY;
      } else {
        process.env.RAH_CLAUDE_BINARY = previousClaudeBinary;
      }
      if (previousClaudeConfigDir === undefined) {
        delete process.env.CLAUDE_CONFIG_DIR;
      } else {
        process.env.CLAUDE_CONFIG_DIR = previousClaudeConfigDir;
      }
      if (previousMirrorInterval === undefined) {
        delete process.env.RAH_NATIVE_TUI_MIRROR_INTERVAL_MS;
      } else {
        process.env.RAH_NATIVE_TUI_MIRROR_INTERVAL_MS = previousMirrorInterval;
      }
      await engine.shutdown();
      rmSync(workspace, { force: true, recursive: true });
    }
  });

  test("Claude native TUI chat input bypasses hidden queue and clears known draft first", async () => {
    const engine = new RuntimeEngine([]);
    const workspace = mkdtempSync(path.join(os.tmpdir(), "rah-native-tui-claude-dirty-mirror-"));
    const fakeClaude = path.join(workspace, "fake-claude-dirty-mirror.js");
    const previousClaudeBinary = process.env.RAH_CLAUDE_BINARY;
    const previousClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
    const previousMirrorInterval = process.env.RAH_NATIVE_TUI_MIRROR_INTERVAL_MS;
    process.env.CLAUDE_CONFIG_DIR = path.join(workspace, "claude-config");
    process.env.RAH_NATIVE_TUI_MIRROR_INTERVAL_MS = "25";
    writeFileSync(
      fakeClaude,
      [
        "#!/usr/bin/env node",
        "const sessionIdArgIndex = process.argv.indexOf('--session-id');",
        "const sessionId = sessionIdArgIndex >= 0 ? process.argv[sessionIdArgIndex + 1] : undefined;",
        "process.stdout.write(`MOCK_CLAUDE_DIRTY_READY args=${process.argv.slice(2).join('|')}\\r\\n`);",
        "process.stdin.setEncoding('utf8');",
        "process.stdin.resume();",
        "process.stdin.on('data', () => undefined);",
        "setInterval(() => undefined, 1000);",
        "",
      ].join("\n"),
    );
    chmodSync(fakeClaude, 0o755);
    process.env.RAH_CLAUDE_BINARY = fakeClaude;

    try {
      const started = await engine.startSession({
        provider: "claude",
        cwd: workspace,
        liveBackend: "native_tui",
        attach: {
          client: {
            id: "web-native",
            kind: "web",
            connectionId: "web-native",
          },
          mode: "interactive",
          claimControl: true,
        },
      });
      const sessionId = started.session.session.id;
      let transcript = "";
      const unsubscribe = engine.ptyHub.subscribe(sessionId, (frame) => {
        if (frame.type === "pty.replay") {
          transcript += frame.chunks.join("");
        } else if (frame.type === "pty.output") {
          transcript += frame.data;
        }
      });
      await waitFor(() => {
        assert.match(transcript, /MOCK_CLAUDE_DIRTY_READY/);
      });

      engine.onPtyInput(sessionId, "web-native", "partial local draft");
      await waitFor(() => {
        assert.equal(engine.getSessionSummary(sessionId).session.nativeTui?.promptState, "prompt_dirty");
      });
      const providerSessionId = engine.getSessionSummary(sessionId).session.providerSessionId;
      assert.ok(providerSessionId);
      const claudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
      assert.ok(claudeConfigDir);
      const projectId = workspace.replace(/[^a-zA-Z0-9]/g, "-");
      const projectDir = path.join(claudeConfigDir, "projects", projectId);
      const now = new Date().toISOString();
      mkdirSync(projectDir, { recursive: true });
      writeFileSync(
        path.join(projectDir, `${providerSessionId}.jsonl`),
        [
          JSON.stringify({
            type: "user",
            uuid: "claude-dirty-mirror-user",
            cwd: workspace,
            sessionId: providerSessionId,
            timestamp: now,
            message: { content: "delayed Claude question" },
          }),
          JSON.stringify({
            type: "assistant",
            uuid: "claude-dirty-mirror-assistant",
            cwd: workspace,
            sessionId: providerSessionId,
            timestamp: now,
            message: { content: [{ type: "text", text: "delayed Claude answer" }] },
          }),
        ].join("\n") + "\n",
      );
      await waitFor(() => {
        assert.ok(
          engine.eventBus
            .list({ sessionIds: [sessionId] })
            .some(
              (event) =>
                event.type === "timeline.item.added" &&
                event.payload.item.kind === "assistant_message" &&
                event.payload.item.text === "delayed Claude answer",
            ),
        );
      });
      assert.equal(engine.getSessionSummary(sessionId).session.nativeTui?.promptState, "prompt_dirty");
      engine.sendInput(sessionId, { clientId: "web-native", text: "sent after draft" });
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(engine.getSessionSummary(sessionId).session.nativeTui?.queuedInputCount, 0);
      assert.match(transcript, /sent after draft/);

      unsubscribe();
      await engine.closeSession(sessionId, { clientId: "web-native" });
    } finally {
      if (previousClaudeBinary === undefined) {
        delete process.env.RAH_CLAUDE_BINARY;
      } else {
        process.env.RAH_CLAUDE_BINARY = previousClaudeBinary;
      }
      if (previousClaudeConfigDir === undefined) {
        delete process.env.CLAUDE_CONFIG_DIR;
      } else {
        process.env.CLAUDE_CONFIG_DIR = previousClaudeConfigDir;
      }
      if (previousMirrorInterval === undefined) {
        delete process.env.RAH_NATIVE_TUI_MIRROR_INTERVAL_MS;
      } else {
        process.env.RAH_NATIVE_TUI_MIRROR_INTERVAL_MS = previousMirrorInterval;
      }
      await engine.shutdown();
      rmSync(workspace, { force: true, recursive: true });
    }
  });

  test("native TUI mirror does not mark newer web input idle with stale Codex rollout lifecycle", async () => {
    const engine = new RuntimeEngine([]);
    const workspace = mkdtempSync(path.join(os.tmpdir(), "rah-native-tui-codex-stale-"));
    const fakeCodex = path.join(workspace, "fake-codex-stale.js");
    const providerSessionId = "019de928-7d22-7c63-ba89-dcb25d4a8666";
    const previousCodexBinary = process.env.RAH_CODEX_BINARY;
    const previousCodexHome = process.env.CODEX_HOME;
    const previousMirrorInterval = process.env.RAH_NATIVE_TUI_MIRROR_INTERVAL_MS;
    process.env.CODEX_HOME = path.join(workspace, "codex-home");
    process.env.RAH_NATIVE_TUI_MIRROR_INTERVAL_MS = "25";
    mkdirSync(path.join(process.env.CODEX_HOME, "sessions"), { recursive: true });
    writeFileSync(
      fakeCodex,
      [
        "#!/usr/bin/env node",
        "const fs = require('node:fs');",
        "const path = require('node:path');",
        "const providerSessionId = process.env.MOCK_CODEX_STALE_SESSION_ID;",
        "const staleBase = new Date(Date.now() - 60000);",
        "let historyWritten = false;",
        "function timestamp(offsetMs) { return new Date(staleBase.getTime() + offsetMs).toISOString(); }",
        "function writeStaleRollout() {",
        "  if (historyWritten || !process.env.CODEX_HOME || !providerSessionId) return;",
        "  historyWritten = true;",
        "  const rollout = path.join(process.env.CODEX_HOME, 'sessions', 'rollout-stale-native.jsonl');",
        "  fs.mkdirSync(path.dirname(rollout), { recursive: true });",
        "  const rows = [",
        "    { timestamp: timestamp(0), type: 'session_meta', payload: { id: providerSessionId, cwd: process.cwd(), timestamp: timestamp(0) } },",
        "    { timestamp: timestamp(100), type: 'event_msg', payload: { type: 'task_started', turn_id: 'stale-codex-turn' } },",
        "    { timestamp: timestamp(200), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'stale Codex question' }] } },",
        "    { timestamp: timestamp(300), type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'stale Codex answer' }] } },",
        "    { timestamp: timestamp(400), type: 'event_msg', payload: { type: 'task_complete', turn_id: 'stale-codex-turn' } },",
        "  ];",
        "  fs.writeFileSync(rollout, rows.map((row) => JSON.stringify(row)).join('\\n') + '\\n');",
        "}",
        "process.stdout.write(`MOCK_CODEX_STALE_READY args=${process.argv.slice(2).join('|')}\\r\\n`);",
        "process.stdout.write(`Session: ${providerSessionId}\\r\\n`);",
        "process.stdin.setEncoding('utf8');",
        "process.stdin.resume();",
        "let buffer = '';",
        "process.stdin.on('data', (chunk) => {",
        "  buffer += chunk;",
        "  const parts = buffer.split(/\\r|\\n/);",
        "  buffer = parts.pop() ?? '';",
        "  for (const part of parts) {",
        "    const text = part.trim();",
        "    if (text) {",
        "      process.stdout.write(`MOCK_CODEX_STALE_INPUT:${text}\\r\\n`);",
        "      setTimeout(writeStaleRollout, 50);",
        "    }",
        "  }",
        "});",
        "setInterval(() => undefined, 1000);",
        "",
      ].join("\n"),
    );
    chmodSync(fakeCodex, 0o755);
    process.env.RAH_CODEX_BINARY = fakeCodex;
    process.env.MOCK_CODEX_STALE_SESSION_ID = providerSessionId;

    try {
      const started = await engine.startSession({
        provider: "codex",
        cwd: workspace,
        liveBackend: "native_tui",
        attach: {
          client: {
            id: "web-native",
            kind: "web",
            connectionId: "web-native",
          },
          mode: "interactive",
          claimControl: true,
        },
      });
      const sessionId = started.session.session.id;

      let transcript = "";
      const unsubscribe = engine.ptyHub.subscribe(sessionId, (frame) => {
        if (frame.type === "pty.replay") {
          transcript += frame.chunks.join("");
        } else if (frame.type === "pty.output") {
          transcript += frame.data;
        }
      });
      await waitFor(() => {
        assert.match(transcript, /MOCK_CODEX_STALE_READY/);
        assert.equal(engine.getSessionSummary(sessionId).session.providerSessionId, providerSessionId);
      });

      engine.sendInput(sessionId, { clientId: "web-native", text: "current codex web input" });
      await waitFor(() => {
        assert.match(transcript, /MOCK_CODEX_STALE_INPUT:current codex web input/);
      });
      await waitFor(() => {
        assert.ok(
          engine.eventBus
            .list({ sessionIds: [sessionId] })
            .some(
              (event) =>
                event.type === "timeline.item.added" &&
                event.payload.item.kind === "assistant_message" &&
                event.payload.item.text === "stale Codex answer",
            ),
        );
      });
      assert.equal(engine.getSessionSummary(sessionId).session.runtimeState, "running");

      engine.interruptSession(sessionId, { clientId: "web-native" });
      unsubscribe();
      await engine.closeSession(sessionId, { clientId: "web-native" });
    } finally {
      if (previousCodexBinary === undefined) {
        delete process.env.RAH_CODEX_BINARY;
      } else {
        process.env.RAH_CODEX_BINARY = previousCodexBinary;
      }
      if (previousCodexHome === undefined) {
        delete process.env.CODEX_HOME;
      } else {
        process.env.CODEX_HOME = previousCodexHome;
      }
      if (previousMirrorInterval === undefined) {
        delete process.env.RAH_NATIVE_TUI_MIRROR_INTERVAL_MS;
      } else {
        process.env.RAH_NATIVE_TUI_MIRROR_INTERVAL_MS = previousMirrorInterval;
      }
      delete process.env.MOCK_CODEX_STALE_SESSION_ID;
      await engine.shutdown();
      rmSync(workspace, { force: true, recursive: true });
    }
  });

  test("native TUI mirror does not mark newer web input idle with stale OpenCode database rows", { skip: !hasSqlite }, async () => {
    const engine = new RuntimeEngine([]);
    const workspace = mkdtempSync(path.join(os.tmpdir(), "rah-native-tui-opencode-stale-"));
    const fakeOpenCode = path.join(workspace, "fake-opencode-stale.js");
    const providerSessionId = "ses_native_opencode_stale";
    const previousOpenCodeBinary = process.env.RAH_OPENCODE_BINARY;
    const previousXdgDataHome = process.env.XDG_DATA_HOME;
    const previousMirrorInterval = process.env.RAH_NATIVE_TUI_MIRROR_INTERVAL_MS;
    const previousBindingInterval = process.env.RAH_NATIVE_TUI_BINDING_PROBE_INTERVAL_MS;
    process.env.XDG_DATA_HOME = path.join(workspace, "xdg-data");
    process.env.RAH_NATIVE_TUI_MIRROR_INTERVAL_MS = "25";
    process.env.RAH_NATIVE_TUI_BINDING_PROBE_INTERVAL_MS = "25";
    writeFileSync(
      fakeOpenCode,
      [
        "#!/usr/bin/env node",
        "const fs = require('node:fs');",
        "const path = require('node:path');",
        "const { execFileSync } = require('node:child_process');",
        "function sql(value) { return `'${String(value).replace(/'/g, `''`)}'`; }",
        "const sessionId = process.env.MOCK_OPENCODE_STALE_SESSION_ID;",
        "const staleBase = Date.now() - 60000;",
        "let historyWritten = false;",
        "function writeStaleDb() {",
        "  if (historyWritten || !process.env.XDG_DATA_HOME || !sessionId) return;",
        "  historyWritten = true;",
        "  const db = path.join(process.env.XDG_DATA_HOME, 'opencode', 'opencode.db');",
        "  fs.mkdirSync(path.dirname(db), { recursive: true });",
        "  execFileSync('sqlite3', [db, `",
        "    pragma busy_timeout = 5000;",
        "    create table if not exists project (id text primary key, worktree text, name text, time_updated integer);",
        "    create table if not exists session (id text primary key, project_id text not null, parent_id text, directory text, title text, time_created integer, time_updated integer, time_archived integer);",
        "    create table if not exists message (id text primary key, session_id text, time_created integer, time_updated integer, data text);",
        "    create table if not exists part (id text primary key, message_id text, session_id text, time_created integer, time_updated integer, data text);",
        "    insert or replace into project (id, worktree, name, time_updated) values ('project_stale', ${sql(process.cwd())}, null, ${Date.now()});",
        "    insert or replace into session (id, project_id, parent_id, directory, title, time_created, time_updated, time_archived)",
        "      values (${sql(sessionId)}, 'project_stale', null, ${sql(process.cwd())}, 'OpenCode stale DB session', ${staleBase}, ${Date.now()}, null);",
        "    insert or replace into message (id, session_id, time_created, time_updated, data)",
        "      values ('msg_user_stale', ${sql(sessionId)}, ${staleBase + 10}, ${staleBase + 10}, ${sql(JSON.stringify({ role: 'user', time: { created: staleBase + 10 } }))});",
        "    insert or replace into message (id, session_id, time_created, time_updated, data)",
        "      values ('msg_assistant_stale', ${sql(sessionId)}, ${staleBase + 20}, ${staleBase + 50}, ${sql(JSON.stringify({ role: 'assistant', parentID: 'msg_user_stale', finish: 'stop', time: { created: staleBase + 20, completed: staleBase + 50 } }))});",
        "    insert or replace into part (id, message_id, session_id, time_created, time_updated, data)",
        "      values ('part_user_stale', 'msg_user_stale', ${sql(sessionId)}, ${staleBase + 11}, ${staleBase + 11}, ${sql(JSON.stringify({ type: 'text', text: 'stale OpenCode question' }))});",
        "    insert or replace into part (id, message_id, session_id, time_created, time_updated, data)",
        "      values ('part_assistant_stale', 'msg_assistant_stale', ${sql(sessionId)}, ${staleBase + 21}, ${staleBase + 50}, ${sql(JSON.stringify({ type: 'text', text: 'stale OpenCode answer' }))});",
        "  `]);",
        "}",
        "process.stdout.write(`MOCK_OPENCODE_STALE_READY args=${process.argv.slice(2).join('|')}\\r\\nAsk anything...\\r\\n`);",
        "process.stdin.setEncoding('utf8');",
        "process.stdin.resume();",
        "let buffer = '';",
        "process.stdin.on('data', (chunk) => {",
        "  buffer += chunk;",
        "  const parts = buffer.split(/\\r|\\n/);",
        "  buffer = parts.pop() ?? '';",
        "  for (const part of parts) {",
        "    const text = part.trim();",
        "    if (text) {",
        "      process.stdout.write(`MOCK_OPENCODE_STALE_INPUT:${text}\\r\\n`);",
        "      setTimeout(writeStaleDb, 50);",
        "    }",
        "  }",
        "});",
        "setInterval(() => undefined, 1000);",
        "",
      ].join("\n"),
    );
    chmodSync(fakeOpenCode, 0o755);
    process.env.RAH_OPENCODE_BINARY = fakeOpenCode;
    process.env.MOCK_OPENCODE_STALE_SESSION_ID = providerSessionId;

    try {
      const started = await engine.startSession({
        provider: "opencode",
        cwd: workspace,
        liveBackend: "native_tui",
        attach: {
          client: {
            id: "web-native",
            kind: "web",
            connectionId: "web-native",
          },
          mode: "interactive",
          claimControl: true,
        },
      });
      const sessionId = started.session.session.id;

      let transcript = "";
      const unsubscribe = engine.ptyHub.subscribe(sessionId, (frame) => {
        if (frame.type === "pty.replay") {
          transcript += frame.chunks.join("");
        } else if (frame.type === "pty.output") {
          transcript += frame.data;
        }
      });
      await waitFor(() => {
        assert.match(transcript, /MOCK_OPENCODE_STALE_READY/);
      });

      engine.sendInput(sessionId, { clientId: "web-native", text: "current opencode web input" });
      await waitFor(() => {
        assert.match(transcript, /MOCK_OPENCODE_STALE_INPUT:current opencode web input/);
      });
      await waitFor(() => {
        assert.equal(engine.getSessionSummary(sessionId).session.providerSessionId, providerSessionId);
        assert.ok(
          engine.eventBus
            .list({ sessionIds: [sessionId] })
            .some(
              (event) =>
                event.type === "timeline.item.added" &&
                event.payload.item.kind === "assistant_message" &&
                event.payload.item.text === "stale OpenCode answer",
            ),
        );
      }, { timeoutMs: 4_000 });
      assert.equal(engine.getSessionSummary(sessionId).session.runtimeState, "running");

      engine.interruptSession(sessionId, { clientId: "web-native" });
      unsubscribe();
      await engine.closeSession(sessionId, { clientId: "web-native" });
    } finally {
      if (previousOpenCodeBinary === undefined) {
        delete process.env.RAH_OPENCODE_BINARY;
      } else {
        process.env.RAH_OPENCODE_BINARY = previousOpenCodeBinary;
      }
      if (previousXdgDataHome === undefined) {
        delete process.env.XDG_DATA_HOME;
      } else {
        process.env.XDG_DATA_HOME = previousXdgDataHome;
      }
      if (previousMirrorInterval === undefined) {
        delete process.env.RAH_NATIVE_TUI_MIRROR_INTERVAL_MS;
      } else {
        process.env.RAH_NATIVE_TUI_MIRROR_INTERVAL_MS = previousMirrorInterval;
      }
      if (previousBindingInterval === undefined) {
        delete process.env.RAH_NATIVE_TUI_BINDING_PROBE_INTERVAL_MS;
      } else {
        process.env.RAH_NATIVE_TUI_BINDING_PROBE_INTERVAL_MS = previousBindingInterval;
      }
      delete process.env.MOCK_OPENCODE_STALE_SESSION_ID;
      await engine.shutdown();
      rmSync(workspace, { force: true, recursive: true });
    }
  });

  test("native TUI diagnostics expose missing chat mirror sources", async () => {
    const engine = new RuntimeEngine([]);
    const workspace = mkdtempSync(path.join(os.tmpdir(), "rah-native-tui-diagnostic-mirror-"));
    const fakeClaude = path.join(workspace, "fake-claude.js");
    const previousClaudeBinary = process.env.RAH_CLAUDE_BINARY;
    const previousClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
    const previousMirrorInterval = process.env.RAH_NATIVE_TUI_MIRROR_INTERVAL_MS;
    const previousWarnAfter = process.env.RAH_NATIVE_TUI_MIRROR_WARN_AFTER_MS;
    const previousConsoleWarn = console.warn;
    console.warn = () => undefined;
    process.env.CLAUDE_CONFIG_DIR = path.join(workspace, "claude-config");
    process.env.RAH_NATIVE_TUI_MIRROR_INTERVAL_MS = "25";
    process.env.RAH_NATIVE_TUI_MIRROR_WARN_AFTER_MS = "25";
    writeFileSync(
      fakeClaude,
      [
        "#!/usr/bin/env node",
        "process.stdout.write('MOCK_CLAUDE_DIAGNOSTIC_MIRROR_READY\\r\\n');",
        "process.stdin.resume();",
        "setInterval(() => undefined, 1000);",
        "",
      ].join("\n"),
    );
    chmodSync(fakeClaude, 0o755);
    process.env.RAH_CLAUDE_BINARY = fakeClaude;

    try {
      const started = await engine.startSession({
        provider: "claude",
        cwd: workspace,
        liveBackend: "native_tui",
        attach: {
          client: {
            id: "web-native",
            kind: "web",
            connectionId: "web-native",
          },
          mode: "interactive",
          claimControl: true,
        },
      });
      const sessionId = started.session.session.id;
      const providerSessionId = started.session.session.providerSessionId;
      assert.match(providerSessionId ?? "", /^[0-9a-f-]{36}$/);

      await waitFor(() => {
        const active = engine.listNativeTuiDiagnostics({ sessionId });
        assert.equal(active.length, 1);
        assert.equal(active[0]?.kind, "mirror_source_missing");
        assert.equal(active[0]?.status, "active");
        assert.equal(active[0]?.provider, "claude");
        assert.equal(active[0]?.providerSessionId, providerSessionId);
      });

      const allActive = engine.listNativeTuiDiagnostics();
      assert.ok(allActive.some((diagnostic) => diagnostic.sessionId === sessionId));
      await engine.closeSession(sessionId, { clientId: "web-native" });
    } finally {
      if (previousClaudeBinary === undefined) {
        delete process.env.RAH_CLAUDE_BINARY;
      } else {
        process.env.RAH_CLAUDE_BINARY = previousClaudeBinary;
      }
      if (previousClaudeConfigDir === undefined) {
        delete process.env.CLAUDE_CONFIG_DIR;
      } else {
        process.env.CLAUDE_CONFIG_DIR = previousClaudeConfigDir;
      }
      if (previousMirrorInterval === undefined) {
        delete process.env.RAH_NATIVE_TUI_MIRROR_INTERVAL_MS;
      } else {
        process.env.RAH_NATIVE_TUI_MIRROR_INTERVAL_MS = previousMirrorInterval;
      }
      if (previousWarnAfter === undefined) {
        delete process.env.RAH_NATIVE_TUI_MIRROR_WARN_AFTER_MS;
      } else {
        process.env.RAH_NATIVE_TUI_MIRROR_WARN_AFTER_MS = previousWarnAfter;
      }
      console.warn = previousConsoleWarn;
      await engine.shutdown();
      rmSync(workspace, { force: true, recursive: true });
    }
  });

  test("native TUI diagnostics expose chat mirror update failures", async () => {
    const engine = new RuntimeEngine([]);
    const workspace = mkdtempSync(path.join(os.tmpdir(), "rah-native-tui-diagnostic-mirror-fail-"));
    const fakeCodex = path.join(workspace, "fake-codex.js");
    const providerSessionId = "019de928-7d22-7c63-ba89-dcb25d4a8666";
    const previousCodexBinary = process.env.RAH_CODEX_BINARY;
    const previousCodexHome = process.env.CODEX_HOME;
    const previousBindingInterval = process.env.RAH_NATIVE_TUI_BINDING_PROBE_INTERVAL_MS;
    const previousMirrorInterval = process.env.RAH_NATIVE_TUI_MIRROR_INTERVAL_MS;
    const previousConsoleWarn = console.warn;
    console.warn = () => undefined;
    process.env.CODEX_HOME = path.join(workspace, "codex-home");
    process.env.RAH_NATIVE_TUI_BINDING_PROBE_INTERVAL_MS = "25";
    process.env.RAH_NATIVE_TUI_MIRROR_INTERVAL_MS = "25";
    writeFileSync(
      fakeCodex,
      [
        "#!/usr/bin/env node",
        "const fs = require('node:fs');",
        "const path = require('node:path');",
        "process.stdout.write('MOCK_NATIVE_TUI_MIRROR_FAILURE_READY\\r\\n');",
        "setTimeout(() => {",
        "  const rollout = path.join(process.env.CODEX_HOME, 'sessions', 'rollout-mirror-failure.jsonl');",
        "  fs.mkdirSync(path.dirname(rollout), { recursive: true });",
        "  const rows = [",
        "    { timestamp: '2026-05-03T00:00:00.000Z', type: 'session_meta', payload: { id: process.env.MOCK_PROVIDER_SESSION_ID, cwd: process.cwd(), timestamp: '2026-05-03T00:00:00.000Z' } },",
        "    { timestamp: '2026-05-03T00:00:01.000Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-native' } },",
        "    { timestamp: '2026-05-03T00:00:02.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Mirror before failure' }] } },",
        "    { timestamp: '2026-05-03T00:00:03.000Z', type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-native' } },",
        "  ];",
        "  fs.writeFileSync(rollout, rows.map((row) => JSON.stringify(row)).join('\\n') + '\\n');",
        "}, 50);",
        "process.stdin.resume();",
        "setInterval(() => undefined, 1000);",
        "",
      ].join("\n"),
    );
    chmodSync(fakeCodex, 0o755);
    process.env.RAH_CODEX_BINARY = fakeCodex;
    process.env.MOCK_PROVIDER_SESSION_ID = providerSessionId;

    try {
      const started = await engine.startSession({
        provider: "codex",
        cwd: workspace,
        liveBackend: "native_tui",
        attach: {
          client: {
            id: "web-native",
            kind: "web",
            connectionId: "web-native",
          },
          mode: "interactive",
          claimControl: true,
        },
      });
      const sessionId = started.session.session.id;

      await waitFor(() => {
        assert.equal(engine.getSessionSummary(sessionId).session.providerSessionId, providerSessionId);
        assert.ok(
          engine.listEvents({ sessionIds: [sessionId] }).some(
            (event) =>
              event.type === "timeline.item.added" &&
              event.payload.item.kind === "assistant_message" &&
              event.payload.item.text === "Mirror before failure",
          ),
        );
      });

      const rolloutRecord = discoverCodexStoredSessions().find(
        (record) => record.ref.providerSessionId === providerSessionId,
      );
      assert.ok(rolloutRecord);
      unlinkSync(rolloutRecord.rolloutPath);

      await waitFor(() => {
        const active = engine.listNativeTuiDiagnostics({ sessionId });
        assert.equal(active.length, 1);
        assert.equal(active[0]?.kind, "mirror_failed");
        assert.equal(active[0]?.status, "active");
        assert.equal(active[0]?.provider, "codex");
        assert.equal(active[0]?.providerSessionId, providerSessionId);
        assert.equal(active[0]?.details?.phase, "read_codex_rollout");
      });

      await engine.closeSession(sessionId, { clientId: "web-native" });
    } finally {
      if (previousCodexBinary === undefined) {
        delete process.env.RAH_CODEX_BINARY;
      } else {
        process.env.RAH_CODEX_BINARY = previousCodexBinary;
      }
      if (previousCodexHome === undefined) {
        delete process.env.CODEX_HOME;
      } else {
        process.env.CODEX_HOME = previousCodexHome;
      }
      if (previousMirrorInterval === undefined) {
        delete process.env.RAH_NATIVE_TUI_MIRROR_INTERVAL_MS;
      } else {
        process.env.RAH_NATIVE_TUI_MIRROR_INTERVAL_MS = previousMirrorInterval;
      }
      if (previousBindingInterval === undefined) {
        delete process.env.RAH_NATIVE_TUI_BINDING_PROBE_INTERVAL_MS;
      } else {
        process.env.RAH_NATIVE_TUI_BINDING_PROBE_INTERVAL_MS = previousBindingInterval;
      }
      delete process.env.MOCK_PROVIDER_SESSION_ID;
      console.warn = previousConsoleWarn;
      await engine.shutdown();
      rmSync(workspace, { force: true, recursive: true });
    }
  });

  test("native TUI backend binds OpenCode provider session from discovered database", { skip: !hasSqlite }, async () => {
    const engine = new RuntimeEngine([]);
    const workspace = mkdtempSync(path.join(os.tmpdir(), "rah-native-tui-opencode-"));
    const fakeOpenCode = path.join(workspace, "fake-opencode.js");
    const providerSessionId = "ses_native_opencode";
    const previousOpenCodeBinary = process.env.RAH_OPENCODE_BINARY;
    const previousXdgDataHome = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = path.join(workspace, "xdg-data");
    writeFileSync(
      fakeOpenCode,
      [
        "#!/usr/bin/env node",
        "const fs = require('node:fs');",
        "const path = require('node:path');",
        "const { execFileSync } = require('node:child_process');",
        "function sql(value) { return `'${String(value).replace(/'/g, `''`)}'`; }",
        "process.stdout.write(`MOCK_OPENCODE_TUI_READY args=${process.argv.slice(2).join('|')}\\r\\nAsk anything...\\r\\n`);",
        "setTimeout(() => {",
        "  const dataHome = process.env.XDG_DATA_HOME;",
        "  const sessionId = process.env.MOCK_OPENCODE_SESSION_ID;",
        "  if (!dataHome || !sessionId) return;",
        "  const db = path.join(dataHome, 'opencode', 'opencode.db');",
        "  fs.mkdirSync(path.dirname(db), { recursive: true });",
        "  const now = Date.now();",
        "  const writeDb = (attempt = 0) => {",
        "    try {",
        "      execFileSync('sqlite3', [db, `",
        "    pragma busy_timeout = 5000;",
        "    create table if not exists project (id text primary key, worktree text, name text, time_updated integer);",
        "    create table if not exists session (id text primary key, project_id text not null, parent_id text, directory text, title text, time_created integer, time_updated integer, time_archived integer);",
        "    create table if not exists message (id text primary key, session_id text, time_created integer, time_updated integer, data text);",
        "    create table if not exists part (id text primary key, message_id text, session_id text, time_created integer, time_updated integer, data text);",
        "    insert or replace into project (id, worktree, name, time_updated) values ('project_native', ${sql(process.cwd())}, null, ${now});",
        "    insert or replace into session (id, project_id, parent_id, directory, title, time_created, time_updated, time_archived)",
        "      values (${sql(sessionId)}, 'project_native', null, ${sql(process.cwd())}, 'OpenCode native DB session', ${now}, ${now}, null);",
        "    insert or replace into message (id, session_id, time_created, time_updated, data)",
        "      values ('msg_user_native', ${sql(sessionId)}, ${now + 10}, ${now + 10}, ${sql(JSON.stringify({ role: 'user', time: { created: now + 10 } }))});",
        "    insert or replace into message (id, session_id, time_created, time_updated, data)",
        "      values ('msg_assistant_native', ${sql(sessionId)}, ${now + 20}, ${now + 20}, ${sql(JSON.stringify({ role: 'assistant', parentID: 'msg_user_native', time: { created: now + 20 } }))});",
        "    insert or replace into part (id, message_id, session_id, time_created, time_updated, data)",
        "      values ('part_user_native', 'msg_user_native', ${sql(sessionId)}, ${now + 11}, ${now + 11}, ${sql(JSON.stringify({ type: 'text', text: 'OpenCode native question' }))});",
        "    insert or replace into part (id, message_id, session_id, time_created, time_updated, data)",
        "      values ('part_0_step_start_native', 'msg_assistant_native', ${sql(sessionId)}, ${now + 20}, ${now + 20}, ${sql(JSON.stringify({ type: 'step-start' }))});",
        "    insert or replace into part (id, message_id, session_id, time_created, time_updated, data)",
        "      values ('part_1_reasoning_native', 'msg_assistant_native', ${sql(sessionId)}, ${now + 20}, ${now + 20}, ${sql(JSON.stringify({ type: 'reasoning', text: 'OpenCode native reasoning' }))});",
        "    insert or replace into part (id, message_id, session_id, time_created, time_updated, data)",
        "      values ('part_assistant_native', 'msg_assistant_native', ${sql(sessionId)}, ${now + 21}, ${now + 20}, ${sql(JSON.stringify({ type: 'text', text: 'OpenCode native partial' }))});",
        "    insert or replace into part (id, message_id, session_id, time_created, time_updated, data)",
        "      values ('part_tool_native', 'msg_assistant_native', ${sql(sessionId)}, ${now + 22}, ${now + 22}, ${sql(JSON.stringify({ type: 'tool', callID: 'tool-native', tool: 'bash', state: { status: 'running', input: { command: 'pwd' }, title: 'Shell' } }))});",
        "      `]);",
        "    } catch (error) {",
        "      if (attempt < 20) {",
        "        setTimeout(() => writeDb(attempt + 1), 100);",
        "        return;",
        "      }",
        "      throw error;",
        "    }",
        "  };",
        "  writeDb();",
        "  setTimeout(() => {",
        "    try {",
        "      execFileSync('sqlite3', [db, `",
        "        pragma busy_timeout = 5000;",
        "        update message",
        "          set time_updated = ${now + 50}, data = ${sql(JSON.stringify({ role: 'assistant', parentID: 'msg_user_native', finish: 'stop', time: { created: now + 20, completed: now + 50 }, tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 7, write: 3 } }, cost: 0.0123 }))}",
        "          where id = 'msg_assistant_native';",
        "        update part",
        "          set time_updated = ${now + 50}, data = ${sql(JSON.stringify({ type: 'text', text: 'OpenCode native answer' }))}",
        "          where id = 'part_assistant_native';",
        "        update part",
        "          set time_updated = ${now + 51}, data = ${sql(JSON.stringify({ type: 'tool', callID: 'tool-native', tool: 'bash', state: { status: 'completed', input: { command: 'pwd' }, output: '/tmp/workspace', title: 'Shell' } }))}",
        "          where id = 'part_tool_native';",
        "        insert or replace into part (id, message_id, session_id, time_created, time_updated, data)",
        "          values ('part_z_step_finish_native', 'msg_assistant_native', ${sql(sessionId)}, ${now + 52}, ${now + 52}, ${sql(JSON.stringify({ type: 'step-finish', reason: 'stop' }))});",
        "        update session set time_updated = ${now + 50} where id = ${sql(sessionId)};",
        "      `]);",
        "    } catch {",
        "      // The initial DB write is best-effort retried above; final-state retry is not needed for this smoke fixture.",
        "    }",
        "  }, 2200);",
        "}, 100);",
        "process.stdin.setEncoding('utf8');",
        "process.stdin.resume();",
        "let buffer = '';",
        "process.stdin.on('data', (chunk) => {",
        "  buffer += chunk;",
        "  const parts = buffer.split(/\\r|\\n/);",
        "  buffer = parts.pop() ?? '';",
        "  for (const part of parts) {",
        "    if (part.trim()) {",
        "      process.stdout.write(`MOCK_OPENCODE_INPUT:${part.trim()}\\r\\n`);",
        "    }",
        "  }",
        "});",
        "setInterval(() => undefined, 1000);",
        "",
      ].join("\n"),
    );
    chmodSync(fakeOpenCode, 0o755);
    process.env.RAH_OPENCODE_BINARY = fakeOpenCode;
    process.env.MOCK_OPENCODE_SESSION_ID = providerSessionId;

    try {
      const started = await engine.startSession({
        provider: "opencode",
        cwd: workspace,
        liveBackend: "native_tui",
        model: "deepseek/deepseek-v4-pro",
        optionValues: { model_reasoning_variant: "high" },
        modeId: "build",
        attach: {
          client: {
            id: "web-native",
            kind: "web",
            connectionId: "web-native",
          },
          mode: "interactive",
          claimControl: true,
        },
      });
      const sessionId = started.session.session.id;
      assert.equal(started.session.session.liveBackend, "native_tui");
      assert.equal(started.session.session.providerSessionId, undefined);
      assert.equal(started.session.session.capabilities.chatMirror, true);

      let transcript = "";
      const unsubscribe = engine.ptyHub.subscribe(sessionId, (frame) => {
        if (frame.type === "pty.replay") {
          transcript += frame.chunks.join("");
        } else if (frame.type === "pty.output") {
          transcript += frame.data;
        }
      });

      await waitFor(() => {
        assert.match(transcript, /MOCK_OPENCODE_TUI_READY/);
        assert.match(transcript, /--model\|deepseek\/deepseek-v4-pro/);
        assert.match(transcript, new RegExp(workspace.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
        assert.equal(engine.getSessionSummary(sessionId).session.providerSessionId, providerSessionId);
        const events = engine.listEvents({ sessionIds: [sessionId] });
        assert.ok(
          events.some(
            (event) =>
              event.type === "timeline.item.added" &&
              event.payload.item.kind === "user_message" &&
              event.payload.item.text === "OpenCode native question",
          ),
        );
        assert.ok(
          events.some(
            (event) =>
              event.type === "timeline.item.added" &&
              event.payload.item.kind === "assistant_message" &&
              event.payload.item.text === "OpenCode native partial" &&
              event.payload.identity?.canonicalItemId,
          ),
        );
        assert.ok(
          events.some(
            (event) =>
              event.type === "timeline.item.added" &&
              event.payload.item.kind === "reasoning" &&
              event.payload.item.text === "OpenCode native reasoning" &&
              event.payload.identity?.canonicalItemId,
          ),
        );
        assert.ok(
          events.some(
            (event) =>
              event.type === "tool.call.started" &&
              event.payload.toolCall.id === "tool-native" &&
              event.payload.toolCall.providerToolName === "bash",
          ),
        );
      }, { timeoutMs: 4_000 });

      await waitFor(() => {
        const events = engine.listEvents({ sessionIds: [sessionId] });
        assert.ok(
          events.some(
            (event) =>
              (event.type === "timeline.item.added" ||
                event.type === "timeline.item.updated") &&
              event.payload.item.kind === "assistant_message" &&
              event.payload.item.text === "OpenCode native answer" &&
              event.payload.identity?.canonicalItemId,
          ),
        );
        assert.ok(
          events.some(
            (event) =>
              event.type === "tool.call.completed" &&
              event.payload.toolCall.id === "tool-native" &&
              event.payload.toolCall.result?.output === "/tmp/workspace",
          ),
        );
        assert.ok(
          events.some(
            (event) =>
              event.type === "usage.updated" &&
              event.payload.usage.source === "opencode.message.usage" &&
              event.payload.usage.usedTokens === 135 &&
              event.payload.usage.inputTokens === 100 &&
              event.payload.usage.outputTokens === 20 &&
              event.payload.usage.reasoningOutputTokens === 5 &&
              event.payload.usage.cachedInputTokens === 7 &&
              event.payload.usage.totalCostUsd === 0.0123,
          ),
        );
        assert.deepEqual(engine.getSessionSummary(sessionId).usage, {
          source: "opencode.message.usage",
          usedTokens: 135,
          inputTokens: 100,
          outputTokens: 20,
          reasoningOutputTokens: 5,
          cachedInputTokens: 7,
          totalCostUsd: 0.0123,
          basis: "turn",
          precision: "exact",
        });
      }, { timeoutMs: 6_000 });

      engine.sendInput(sessionId, { clientId: "web-native", text: "hello opencode native" });
      await waitFor(() => {
        assert.match(transcript, /MOCK_OPENCODE_INPUT:hello opencode native/);
      });

      unsubscribe();
      await engine.closeSession(sessionId, { clientId: "web-native" });
    } finally {
      if (previousOpenCodeBinary === undefined) {
        delete process.env.RAH_OPENCODE_BINARY;
      } else {
        process.env.RAH_OPENCODE_BINARY = previousOpenCodeBinary;
      }
      if (previousXdgDataHome === undefined) {
        delete process.env.XDG_DATA_HOME;
      } else {
        process.env.XDG_DATA_HOME = previousXdgDataHome;
      }
      delete process.env.MOCK_OPENCODE_SESSION_ID;
      await engine.shutdown();
      rmSync(workspace, { force: true, recursive: true });
    }
  });

});

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
import type {
  TerminalWrapperFromDaemonMessage,
  WrapperHelloMessage,
} from "./terminal-wrapper-control";

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
  readonly providers: Array<"codex"> = ["codex"];
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

function historyEvent(sessionId: string, seq: number, ts: string, text: string): RahEvent {
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
          archive: false,
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
          { id: "alpha", label: "Alpha" },
          { id: "beta", label: "Beta" },
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

  test("routes claude stored replay through ClaudeAdapter instead of DebugAdapter", async () => {
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

    const secondList = engine.listSessions();
    assert.equal(adapter.storedSessionCalls, 1);
    assert.equal(secondList.storedSessions.length, 2);

    const afterSingleRemoval = await engine.removeStoredSession("codex", "session-1");
    assert.equal(adapter.storedSessionCalls, 1);
    assert.deepEqual(adapter.removedSessionIds, ["session-1"]);
    assert.deepEqual(
      afterSingleRemoval.storedSessions.map((entry) => entry.providerSessionId),
      ["session-2"],
    );

    const afterWorkspaceRemoval = await engine.removeStoredWorkspaceSessions(workDir);
    assert.equal(adapter.storedSessionCalls, 1);
    assert.deepEqual(adapter.removedSessionIds, ["session-1", "session-2"]);
    assert.equal(afterWorkspaceRemoval.storedSessions.length, 0);

    await engine.shutdown();
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
        .some((event) => event.type === "session.discovery"),
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

  test("history snapshot transfers from replay to claimed live session", async () => {
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

  test("frozen history pager transfers to claimed live session", async () => {
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

    unsubscribe();
    await engine.shutdown();
    rmSync(workspace, { force: true, recursive: true });
  });

  test("default live start uses native TUI and routes chat input through PTY", async () => {
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
        "  process.stdout.write('MOCK_NATIVE_TUI_INTERRUPTED\\r\\n');",
        "});",
        "process.stdin.setEncoding('utf8');",
        "process.stdin.resume();",
        "let buffer = '';",
        "process.stdin.on('data', (chunk) => {",
        "  buffer += chunk;",
        "  if (buffer.includes('\\u0003')) {",
        "    process.stdout.write('MOCK_NATIVE_TUI_INTERRUPTED\\r\\n');",
        "    buffer = buffer.replace(/\\u0003/g, '');",
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

      engine.sendInput(sessionId, { clientId: "web-native", text: "hello native tui" });
      await waitFor(() => {
        assert.match(transcript, /MOCK_NATIVE_TUI_INPUT:hello native tui/);
      });

      engine.interruptSession(sessionId, { clientId: "web-native" });
      await waitFor(() => {
        assert.match(transcript, /MOCK_NATIVE_TUI_INTERRUPTED/);
        assert.equal(engine.getSessionSummary(sessionId).session.runtimeState, "idle");
      });

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

  test("native TUI backend rejects chat input while the TUI prompt is dirty", async () => {
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
      engine.onPtyInput(sessionId, "browser", "partial local draft");
      await waitFor(() => {
        assert.equal(engine.getSessionSummary(sessionId).session.nativeTui?.promptState, "prompt_dirty");
      });
      assert.throws(
        () => engine.sendInput(sessionId, { clientId: "web-native", text: "must not be injected" }),
        /prompt is not clean/,
      );

      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.doesNotMatch(transcript, /must not be injected/);

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

  test("native TUI backend ignores unrelated Codex rollout updates outside its isolated home", async () => {
    const engine = new RuntimeEngine([]);
    const workspace = mkdtempSync(path.join(os.tmpdir(), "rah-native-tui-codex-isolate-"));
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
        "process.stdout.write('MOCK_NATIVE_TUI_ISOLATED_CODEX_READY\\r\\n');",
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
        assert.equal(engine.getSessionSummary(sessionId).session.runtimeState, "stopped");
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

  test("native TUI mirror does not mark newer web input idle with stale Claude history", async () => {
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
      assert.equal(engine.getSessionSummary(sessionId).session.runtimeState, "running");

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

  test("native TUI mirror does not clean an unsubmitted Claude prompt draft", async () => {
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

      engine.onPtyInput(sessionId, "browser", "partial local draft");
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
      assert.throws(
        () => engine.sendInput(sessionId, { clientId: "web-native", text: "must remain blocked" }),
        /prompt is not clean/,
      );
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.doesNotMatch(transcript, /must remain blocked/);

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

  test("native TUI mirror does not mark newer web input idle with stale Kimi TurnEnd", async () => {
    const engine = new RuntimeEngine([]);
    const workspace = mkdtempSync(path.join(os.tmpdir(), "rah-native-tui-kimi-stale-"));
    const fakeKimi = path.join(workspace, "fake-kimi-stale.js");
    const previousKimiBinary = process.env.RAH_KIMI_BINARY;
    const previousKimiHome = process.env.KIMI_SHARE_DIR;
    const previousMirrorInterval = process.env.RAH_NATIVE_TUI_MIRROR_INTERVAL_MS;
    process.env.KIMI_SHARE_DIR = path.join(workspace, "kimi-home");
    process.env.RAH_NATIVE_TUI_MIRROR_INTERVAL_MS = "25";
    writeFileSync(
      fakeKimi,
      [
        "#!/usr/bin/env node",
        "const fs = require('node:fs');",
        "const path = require('node:path');",
        "const { createHash } = require('node:crypto');",
        "const sessionArgIndex = process.argv.indexOf('--session');",
        "const sessionId = sessionArgIndex >= 0 ? process.argv[sessionArgIndex + 1] : undefined;",
        "const staleTimestamp = Date.now() / 1000 - 60;",
        "let historyWritten = false;",
        "function writeStaleWire() {",
        "  if (historyWritten || !process.env.KIMI_SHARE_DIR || !sessionId) return;",
        "  historyWritten = true;",
        "  const workDir = process.cwd();",
        "  const digest = createHash('md5').update(workDir).digest('hex');",
        "  const sessionDir = path.join(process.env.KIMI_SHARE_DIR, 'sessions', digest, sessionId);",
        "  fs.mkdirSync(sessionDir, { recursive: true });",
        "  fs.writeFileSync(path.join(process.env.KIMI_SHARE_DIR, 'kimi.json'), JSON.stringify({ work_dirs: [{ path: workDir }] }));",
        "  const line = (offset, type, payload) => JSON.stringify({ timestamp: staleTimestamp + offset, message: { type, payload } });",
        "  fs.writeFileSync(path.join(sessionDir, 'wire.jsonl'), [",
        "    line(0, 'TurnBegin', { user_input: 'stale Kimi question' }),",
        "    line(0.1, 'ContentPart', { type: 'text', text: 'stale Kimi answer' }),",
        "    line(0.2, 'TurnEnd', {}),",
        "  ].join('\\n') + '\\n');",
        "}",
        "process.stdout.write(`MOCK_KIMI_STALE_READY args=${process.argv.slice(2).join('|')}\\r\\n`);",
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
        "      process.stdout.write(`MOCK_KIMI_STALE_INPUT:${text}\\r\\n`);",
        "      setTimeout(writeStaleWire, 50);",
        "    }",
        "  }",
        "});",
        "setInterval(() => undefined, 1000);",
        "",
      ].join("\n"),
    );
    chmodSync(fakeKimi, 0o755);
    process.env.RAH_KIMI_BINARY = fakeKimi;

    try {
      const started = await engine.startSession({
        provider: "kimi",
        cwd: workspace,
        liveBackend: "native_tui",
        model: "kimi-k2.6,thinking",
        optionValues: { model_thinking: "thinking" },
        modeId: "yolo",
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
      assert.match(started.session.session.providerSessionId ?? "", /^[0-9a-f-]{36}$/);

      let transcript = "";
      const unsubscribe = engine.ptyHub.subscribe(sessionId, (frame) => {
        if (frame.type === "pty.replay") {
          transcript += frame.chunks.join("");
        } else if (frame.type === "pty.output") {
          transcript += frame.data;
        }
      });
      await waitFor(() => {
        assert.match(transcript, /MOCK_KIMI_STALE_READY/);
      });

      engine.sendInput(sessionId, { clientId: "web-native", text: "current kimi web input" });
      await waitFor(() => {
        assert.match(transcript, /MOCK_KIMI_STALE_INPUT:current kimi web input/);
      });
      await waitFor(() => {
        assert.ok(
          engine.eventBus
            .list({ sessionIds: [sessionId] })
            .some(
              (event) =>
                event.type === "timeline.item.added" &&
                event.payload.item.kind === "assistant_message" &&
                event.payload.item.text === "stale Kimi answer",
            ),
        );
      });
      assert.equal(engine.getSessionSummary(sessionId).session.runtimeState, "running");

      engine.interruptSession(sessionId, { clientId: "web-native" });
      unsubscribe();
      await engine.closeSession(sessionId, { clientId: "web-native" });
    } finally {
      if (previousKimiBinary === undefined) {
        delete process.env.RAH_KIMI_BINARY;
      } else {
        process.env.RAH_KIMI_BINARY = previousKimiBinary;
      }
      if (previousKimiHome === undefined) {
        delete process.env.KIMI_SHARE_DIR;
      } else {
        process.env.KIMI_SHARE_DIR = previousKimiHome;
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

  test("native TUI mirror does not mark newer web input idle with stale Gemini conversation", async () => {
    const engine = new RuntimeEngine([]);
    const workspace = mkdtempSync(path.join(os.tmpdir(), "rah-native-tui-gemini-stale-"));
    const fakeGemini = path.join(workspace, "fake-gemini-stale.js");
    const providerSessionId = "745e0831-25cf-4e73-87d2-0cb9064eb399";
    const previousGeminiBinary = process.env.RAH_GEMINI_BINARY;
    const previousGeminiHome = process.env.GEMINI_CLI_HOME;
    const previousMirrorInterval = process.env.RAH_NATIVE_TUI_MIRROR_INTERVAL_MS;
    process.env.GEMINI_CLI_HOME = path.join(workspace, "gemini-home");
    process.env.RAH_NATIVE_TUI_MIRROR_INTERVAL_MS = "25";
    mkdirSync(process.env.GEMINI_CLI_HOME, { recursive: true });
    writeFileSync(
      path.join(process.env.GEMINI_CLI_HOME, "projects.json"),
      JSON.stringify({ projects: { [workspace]: "native-gemini-stale-test" } }),
    );
    writeFileSync(
      fakeGemini,
      [
        "#!/usr/bin/env node",
        "const fs = require('node:fs');",
        "const path = require('node:path');",
        "const { createHash } = require('node:crypto');",
        "const providerSessionId = process.env.MOCK_GEMINI_STALE_SESSION_ID;",
        "const staleTimestamp = new Date(Date.now() - 60000).toISOString();",
        "const currentTimestamp = new Date().toISOString();",
        "let historyWritten = false;",
        "function writeStaleConversation() {",
        "  if (historyWritten || !process.env.GEMINI_CLI_HOME || !providerSessionId) return;",
        "  historyWritten = true;",
        "  const projectHash = createHash('sha256').update(process.cwd()).digest('hex');",
        "  const chatsDir = path.join(process.env.GEMINI_CLI_HOME, 'tmp', projectHash, 'chats');",
        "  fs.mkdirSync(chatsDir, { recursive: true });",
        "  fs.writeFileSync(path.join(chatsDir, `session-${providerSessionId}.json`), JSON.stringify({",
        "    sessionId: providerSessionId,",
        "    projectHash,",
        "    startTime: staleTimestamp,",
        "    lastUpdated: currentTimestamp,",
        "    messages: [",
        "      { id: 'user-stale', timestamp: staleTimestamp, type: 'user', content: [{ text: 'stale Gemini question' }] },",
        "      { id: 'assistant-stale', timestamp: staleTimestamp, type: 'gemini', content: [{ text: 'stale Gemini answer' }] },",
        "    ],",
        "  }));",
        "}",
        "process.stdout.write(`MOCK_GEMINI_STALE_READY args=${process.argv.slice(2).join('|')}\\r\\n`);",
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
        "      process.stdout.write(`MOCK_GEMINI_STALE_INPUT:${text}\\r\\n`);",
        "      setTimeout(writeStaleConversation, 50);",
        "    }",
        "  }",
        "});",
        "setInterval(() => undefined, 1000);",
        "",
      ].join("\n"),
    );
    chmodSync(fakeGemini, 0o755);
    process.env.RAH_GEMINI_BINARY = fakeGemini;
    process.env.MOCK_GEMINI_STALE_SESSION_ID = providerSessionId;

    try {
      const started = await engine.startSession({
        provider: "gemini",
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
        assert.match(transcript, /MOCK_GEMINI_STALE_READY/);
      });

      engine.sendInput(sessionId, { clientId: "web-native", text: "current gemini web input" });
      await waitFor(() => {
        assert.match(transcript, /MOCK_GEMINI_STALE_INPUT:current gemini web input/);
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
                event.payload.item.text === "stale Gemini answer",
            ),
        );
      });
      assert.equal(engine.getSessionSummary(sessionId).session.runtimeState, "running");

      engine.interruptSession(sessionId, { clientId: "web-native" });
      unsubscribe();
      await engine.closeSession(sessionId, { clientId: "web-native" });
    } finally {
      if (previousGeminiBinary === undefined) {
        delete process.env.RAH_GEMINI_BINARY;
      } else {
        process.env.RAH_GEMINI_BINARY = previousGeminiBinary;
      }
      if (previousGeminiHome === undefined) {
        delete process.env.GEMINI_CLI_HOME;
      } else {
        process.env.GEMINI_CLI_HOME = previousGeminiHome;
      }
      if (previousMirrorInterval === undefined) {
        delete process.env.RAH_NATIVE_TUI_MIRROR_INTERVAL_MS;
      } else {
        process.env.RAH_NATIVE_TUI_MIRROR_INTERVAL_MS = previousMirrorInterval;
      }
      delete process.env.MOCK_GEMINI_STALE_SESSION_ID;
      await engine.shutdown();
      rmSync(workspace, { force: true, recursive: true });
    }
  });

  test("native TUI mirror does not clean an unsubmitted Gemini prompt draft", async () => {
    const engine = new RuntimeEngine([]);
    const workspace = mkdtempSync(path.join(os.tmpdir(), "rah-native-tui-gemini-dirty-mirror-"));
    const fakeGemini = path.join(workspace, "fake-gemini-dirty-mirror.js");
    const providerSessionId = "645e0831-25cf-4e73-87d2-0cb9064eb399";
    const previousGeminiBinary = process.env.RAH_GEMINI_BINARY;
    const previousGeminiHome = process.env.GEMINI_CLI_HOME;
    const previousMirrorInterval = process.env.RAH_NATIVE_TUI_MIRROR_INTERVAL_MS;
    const previousBindingInterval = process.env.RAH_NATIVE_TUI_BINDING_PROBE_INTERVAL_MS;
    process.env.GEMINI_CLI_HOME = path.join(workspace, "gemini-home");
    process.env.RAH_NATIVE_TUI_MIRROR_INTERVAL_MS = "25";
    process.env.RAH_NATIVE_TUI_BINDING_PROBE_INTERVAL_MS = "25";
    mkdirSync(process.env.GEMINI_CLI_HOME, { recursive: true });
    writeFileSync(
      path.join(process.env.GEMINI_CLI_HOME, "projects.json"),
      JSON.stringify({ projects: { [workspace]: "native-gemini-dirty-mirror-test" } }),
    );
    writeFileSync(
      fakeGemini,
      [
        "#!/usr/bin/env node",
        "process.stdout.write(`MOCK_GEMINI_DIRTY_READY args=${process.argv.slice(2).join('|')}\\r\\n`);",
        "process.stdin.setEncoding('utf8');",
        "process.stdin.resume();",
        "let buffer = '';",
        "process.stdin.on('data', (chunk) => {",
        "  buffer += chunk;",
        "  const parts = buffer.split(/\\r|\\n/);",
        "  buffer = parts.pop() ?? '';",
        "  for (const part of parts) {",
        "    const text = part.trim();",
        "    if (text) process.stdout.write(`MOCK_GEMINI_DIRTY_INPUT:${text}\\r\\n`);",
        "  }",
        "});",
        "setInterval(() => undefined, 1000);",
        "",
      ].join("\n"),
    );
    chmodSync(fakeGemini, 0o755);
    process.env.RAH_GEMINI_BINARY = fakeGemini;

    try {
      const started = await engine.startSession({
        provider: "gemini",
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
        assert.match(transcript, /MOCK_GEMINI_DIRTY_READY/);
      });

      engine.onPtyInput(sessionId, "browser", "partial gemini local draft");
      await waitFor(() => {
        assert.equal(engine.getSessionSummary(sessionId).session.nativeTui?.promptState, "prompt_dirty");
      });

      const geminiHome = process.env.GEMINI_CLI_HOME;
      assert.ok(geminiHome);
      const projectHash = createHash("sha256").update(workspace).digest("hex");
      const chatsDir = path.join(geminiHome, "tmp", projectHash, "chats");
      const now = new Date().toISOString();
      mkdirSync(chatsDir, { recursive: true });
      writeFileSync(
        path.join(chatsDir, `session-${providerSessionId}.json`),
        JSON.stringify({
          sessionId: providerSessionId,
          projectHash,
          startTime: now,
          lastUpdated: now,
          messages: [
            {
              id: "user-dirty-mirror",
              timestamp: now,
              type: "user",
              content: [{ text: "delayed Gemini question" }],
            },
            {
              id: "assistant-dirty-mirror",
              timestamp: now,
              type: "gemini",
              content: [{ text: "delayed Gemini answer" }],
            },
          ],
        }),
      );

      await waitFor(() => {
        assert.equal(engine.getSessionSummary(sessionId).session.providerSessionId, providerSessionId);
        assert.ok(
          engine.eventBus
            .list({ sessionIds: [sessionId] })
            .some(
              (event) =>
                event.type === "timeline.item.added" &&
                event.payload.item.kind === "assistant_message" &&
                event.payload.item.text === "delayed Gemini answer",
            ),
        );
      });
      assert.equal(engine.getSessionSummary(sessionId).session.nativeTui?.promptState, "prompt_dirty");
      assert.throws(
        () => engine.sendInput(sessionId, { clientId: "web-native", text: "must remain blocked" }),
        /prompt is not clean/,
      );
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.doesNotMatch(transcript, /must remain blocked/);

      unsubscribe();
      await engine.closeSession(sessionId, { clientId: "web-native" });
    } finally {
      if (previousGeminiBinary === undefined) {
        delete process.env.RAH_GEMINI_BINARY;
      } else {
        process.env.RAH_GEMINI_BINARY = previousGeminiBinary;
      }
      if (previousGeminiHome === undefined) {
        delete process.env.GEMINI_CLI_HOME;
      } else {
        process.env.GEMINI_CLI_HOME = previousGeminiHome;
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
        "process.stdout.write(`MOCK_OPENCODE_STALE_READY args=${process.argv.slice(2).join('|')}\\r\\n`);",
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

  test("native TUI backend binds Gemini provider session from discovered history", async () => {
    const engine = new RuntimeEngine([]);
    const workspace = mkdtempSync(path.join(os.tmpdir(), "rah-native-tui-gemini-"));
    const fakeGemini = path.join(workspace, "fake-gemini.js");
    const providerSessionId = "645e0831-25cf-4e73-87d2-0cb9064eb399";
    const previousGeminiBinary = process.env.RAH_GEMINI_BINARY;
    const previousGeminiHome = process.env.GEMINI_CLI_HOME;
    process.env.GEMINI_CLI_HOME = path.join(workspace, "gemini-home");
    const projectHash = createHash("sha256").update(workspace).digest("hex");
    const chatsDir = path.join(process.env.GEMINI_CLI_HOME, "tmp", projectHash, "chats");
    mkdirSync(chatsDir, { recursive: true });
    writeFileSync(
      path.join(process.env.GEMINI_CLI_HOME, "projects.json"),
      JSON.stringify({ projects: { [workspace]: "native-gemini-test" } }),
    );
    writeFileSync(
      fakeGemini,
      [
        "#!/usr/bin/env node",
        "const fs = require('node:fs');",
        "const path = require('node:path');",
        "process.stdout.write(`MOCK_GEMINI_TUI_READY args=${process.argv.slice(2).join('|')}\\r\\n`);",
        "setTimeout(() => {",
        "  const chatsDir = process.env.MOCK_GEMINI_CHATS_DIR;",
        "  const sessionId = process.env.MOCK_GEMINI_SESSION_ID;",
        "  const projectHash = process.env.MOCK_GEMINI_PROJECT_HASH;",
        "  const now = new Date().toISOString();",
        "  fs.mkdirSync(chatsDir, { recursive: true });",
        "  fs.writeFileSync(path.join(chatsDir, `session-${sessionId}.json`), JSON.stringify({",
        "    sessionId,",
        "    projectHash,",
        "    startTime: now,",
        "    lastUpdated: now,",
        "    messages: [{ id: 'user-1', timestamp: now, type: 'user', content: [{ text: 'Gemini native question' }] }],",
        "  }));",
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
        "      process.stdout.write(`MOCK_GEMINI_INPUT:${part.trim()}\\r\\n`);",
        "    }",
        "  }",
        "});",
        "setInterval(() => undefined, 1000);",
        "",
      ].join("\n"),
    );
    chmodSync(fakeGemini, 0o755);
    process.env.RAH_GEMINI_BINARY = fakeGemini;
    process.env.MOCK_GEMINI_CHATS_DIR = chatsDir;
    process.env.MOCK_GEMINI_SESSION_ID = providerSessionId;
    process.env.MOCK_GEMINI_PROJECT_HASH = projectHash;

    try {
      const started = await engine.startSession({
        provider: "gemini",
        cwd: workspace,
        liveBackend: "native_tui",
        model: "gemini-native-test",
        modeId: "yolo",
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

      let transcript = "";
      const unsubscribe = engine.ptyHub.subscribe(sessionId, (frame) => {
        if (frame.type === "pty.replay") {
          transcript += frame.chunks.join("");
        } else if (frame.type === "pty.output") {
          transcript += frame.data;
        }
      });

      await waitFor(() => {
        assert.match(transcript, /MOCK_GEMINI_TUI_READY/);
        assert.match(transcript, /--approval-mode\|yolo/);
        assert.match(transcript, /--model\|gemini-native-test/);
        assert.equal(engine.getSessionSummary(sessionId).session.providerSessionId, providerSessionId);
      }, { timeoutMs: 4_000 });

      engine.sendInput(sessionId, { clientId: "web-native", text: "hello gemini native" });
      await waitFor(() => {
        assert.match(transcript, /MOCK_GEMINI_INPUT:hello gemini native/);
      });

      unsubscribe();
      await engine.closeSession(sessionId, { clientId: "web-native" });
    } finally {
      if (previousGeminiBinary === undefined) {
        delete process.env.RAH_GEMINI_BINARY;
      } else {
        process.env.RAH_GEMINI_BINARY = previousGeminiBinary;
      }
      if (previousGeminiHome === undefined) {
        delete process.env.GEMINI_CLI_HOME;
      } else {
        process.env.GEMINI_CLI_HOME = previousGeminiHome;
      }
      delete process.env.MOCK_GEMINI_CHATS_DIR;
      delete process.env.MOCK_GEMINI_SESSION_ID;
      delete process.env.MOCK_GEMINI_PROJECT_HASH;
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
        "process.stdout.write(`MOCK_OPENCODE_TUI_READY args=${process.argv.slice(2).join('|')}\\r\\n`);",
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
        modeId: "opencode/full-auto",
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
        assert.match(transcript, /--model\|deepseek\/deepseek-v4-pro\/high/);
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
        assert.ok(events.some((event) => event.type === "turn.step.started"));
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
              event.type === "timeline.item.added" &&
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
        assert.ok(events.some((event) => event.type === "turn.step.completed"));
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

  test("registers terminal wrapper sessions as live and dispatches queued turns when prompt becomes clean", async () => {
    const adapter = new CountingStoredSessionsAdapter([]);
    const engine = new RuntimeEngine([adapter]);
    const outbound: TerminalWrapperFromDaemonMessage[] = [];

    const ready = engine.registerTerminalWrapperSession(
      {
        type: "wrapper.hello",
        provider: "codex",
        cwd: workDirGlobal,
        rootDir: workDirGlobal,
        terminalPid: 4242,
        launchCommand: ["rah", "codex"],
      } satisfies WrapperHelloMessage,
      (message) => outbound.push(message),
    );

    const sessions = engine.listSessions();
    assert.equal(sessions.sessions.length, 1);
    assert.equal(sessions.sessions[0]?.session.launchSource, "terminal");
    assert.equal(sessions.sessions[0]?.session.capabilities.queuedInput, true);
    assert.equal(sessions.sessions[0]?.controlLease.holderKind, "terminal");

    engine.updateTerminalWrapperPromptState(ready.sessionId, "prompt_dirty");
    engine.sendInput(ready.sessionId, { clientId: "web-user", text: "Explain the bug." });
    assert.equal(engine.listSessions().sessions[0]?.controlLease.holderKind, "web");
    assert.equal(engine.listSessions().sessions[0]?.controlLease.holderClientId, "web-user");
    assert.equal(
      engine
        .listEvents({ sessionIds: [ready.sessionId] })
        .some(
          (event) =>
            event.type === "session.attached" &&
            event.payload.clientId === "web-user" &&
            event.payload.clientKind === "web",
        ),
      true,
    );

    assert.deepEqual(outbound.at(-1), {
      type: "turn.enqueue",
      sessionId: ready.sessionId,
      queuedTurn: {
        queuedTurnId: `${ready.sessionId}:queued:1`,
        sourceSurfaceId: "web-user",
        text: "Explain the bug.",
      },
    });

    engine.updateTerminalWrapperPromptState(ready.sessionId, "prompt_clean");

    assert.deepEqual(outbound.at(-1), {
      type: "turn.inject",
      sessionId: ready.sessionId,
      queuedTurn: {
        queuedTurnId: `${ready.sessionId}:queued:1`,
        sourceSurfaceId: "web-user",
        text: "Explain the bug.",
      },
    });
    assert.equal(engine.listSessions().sessions[0]?.session.runtimeState, "idle");
    const stateChangedEvents = engine
      .listEvents({ sessionIds: [ready.sessionId] })
      .filter((event) => event.type === "session.state.changed");
    assert.equal(stateChangedEvents.at(-1)?.payload.state, "idle");

    engine.updateTerminalWrapperPromptState(ready.sessionId, "agent_busy");
    assert.equal(engine.listSessions().sessions[0]?.session.runtimeState, "running");
    const runningStateChangedEvents = engine
      .listEvents({ sessionIds: [ready.sessionId] })
      .filter((event) => event.type === "session.state.changed");
    assert.equal(runningStateChangedEvents.at(-1)?.payload.state, "running");

    await engine.shutdown();
  });

  test("terminal wrapper permission capability matches provider support", async () => {
    const adapter = new CountingStoredSessionsAdapter([]);
    const engine = new RuntimeEngine([adapter]);

    const claude = engine.registerTerminalWrapperSession(
      {
        type: "wrapper.hello",
        provider: "claude",
        cwd: workDirGlobal,
        rootDir: workDirGlobal,
        terminalPid: 4242,
        launchCommand: ["rah", "claude"],
      } satisfies WrapperHelloMessage,
      () => undefined,
    );
    const codex = engine.registerTerminalWrapperSession(
      {
        type: "wrapper.hello",
        provider: "codex",
        cwd: workDirGlobal,
        rootDir: workDirGlobal,
        terminalPid: 4243,
        launchCommand: ["rah", "codex"],
      } satisfies WrapperHelloMessage,
      () => undefined,
    );

    const sessions = engine.listSessions().sessions;
    assert.equal(
      sessions.find((session) => session.session.id === claude.sessionId)?.session.capabilities
        .livePermissions,
      false,
    );
    assert.equal(
      sessions.find((session) => session.session.id === codex.sessionId)?.session.capabilities
        .livePermissions,
      true,
    );

    await engine.shutdown();
  });

  test("interrupting a terminal wrapper turn before injection cancels the queued web turn", async () => {
    const adapter = new CountingStoredSessionsAdapter([]);
    const engine = new RuntimeEngine([adapter]);
    const outbound: TerminalWrapperFromDaemonMessage[] = [];

    const ready = engine.registerTerminalWrapperSession(
      {
        type: "wrapper.hello",
        provider: "codex",
        cwd: workDirGlobal,
        rootDir: workDirGlobal,
        terminalPid: 4242,
        launchCommand: ["rah", "codex"],
      } satisfies WrapperHelloMessage,
      (message) => outbound.push(message),
    );
    engine.updateTerminalWrapperPromptState(ready.sessionId, "prompt_dirty");
    engine.sendInput(ready.sessionId, { clientId: "web-user", text: "Explain the bug." });
    assert.equal(outbound.at(-1)?.type, "turn.enqueue");

    engine.interruptSession(ready.sessionId, { clientId: "web-user" });
    engine.updateTerminalWrapperPromptState(ready.sessionId, "prompt_clean");

    assert.equal(outbound.some((message) => message.type === "turn.inject"), false);
    assert.equal(outbound.at(-1)?.type, "turn.interrupt");

    await engine.shutdown();
  });

  test("interrupting before wrapper input arrives suppresses the next same-client input", async () => {
    const adapter = new CountingStoredSessionsAdapter([]);
    const engine = new RuntimeEngine([adapter]);
    const outbound: TerminalWrapperFromDaemonMessage[] = [];

    const ready = engine.registerTerminalWrapperSession(
      {
        type: "wrapper.hello",
        provider: "codex",
        cwd: workDirGlobal,
        rootDir: workDirGlobal,
        terminalPid: 4242,
        launchCommand: ["rah", "codex"],
      } satisfies WrapperHelloMessage,
      (message) => outbound.push(message),
    );

    engine.updateTerminalWrapperPromptState(ready.sessionId, "prompt_clean");
    engine.interruptSession(ready.sessionId, { clientId: "web-user" });
    engine.sendInput(ready.sessionId, { clientId: "web-user", text: "Explain the bug." });

    assert.equal(outbound.some((message) => message.type === "turn.inject"), false);
    assert.equal(outbound.filter((message) => message.type === "turn.interrupt").length, 1);

    await engine.shutdown();
  });

  test("applies terminal wrapper activity and PTY output through canonical channels", async () => {
    const adapter = new CountingStoredSessionsAdapter([]);
    const engine = new RuntimeEngine([adapter]);

    const ready = engine.registerTerminalWrapperSession(
      {
        type: "wrapper.hello",
        provider: "codex",
        cwd: workDirGlobal,
        rootDir: workDirGlobal,
        terminalPid: 5252,
        launchCommand: ["rah", "codex"],
      } satisfies WrapperHelloMessage,
      () => undefined,
    );

    engine.bindTerminalWrapperProviderSession({
      type: "wrapper.provider_bound",
      sessionId: ready.sessionId,
      providerSessionId: "thread-wrapper-1",
      providerTitle: "Wrapper thread",
      reason: "initial",
    });
    engine.applyTerminalWrapperActivity(ready.sessionId, {
      type: "turn_started",
      turnId: "turn-1",
    });
    engine.appendTerminalWrapperPtyOutput(ready.sessionId, "hello from terminal\n");

    const events = engine.listEvents({ sessionIds: [ready.sessionId] });
    assert.ok(events.some((event) => event.type === "turn.started" && event.turnId === "turn-1"));
    assert.ok(
      events.some(
        (event) =>
          event.type === "terminal.output" &&
          event.payload.data.includes("hello from terminal"),
      ),
    );
    assert.equal(engine.listSessions().sessions[0]?.session.title, "Wrapper thread");

    engine.markTerminalWrapperExited(ready.sessionId, { exitCode: 0 });
    assert.equal(engine.listSessions().sessions.length, 0);

    await engine.shutdown();
  });

  test("rebinds a terminal wrapper session to a new provider session without mixing feed ownership", async () => {
    const adapter = new CountingStoredSessionsAdapter([]);
    const engine = new RuntimeEngine([adapter]);

    const ready = engine.registerTerminalWrapperSession(
      {
        type: "wrapper.hello",
        provider: "codex",
        cwd: workDirGlobal,
        rootDir: workDirGlobal,
        terminalPid: 6262,
        launchCommand: ["rah", "codex"],
      } satisfies WrapperHelloMessage,
      () => undefined,
    );

    engine.bindTerminalWrapperProviderSession({
      type: "wrapper.provider_bound",
      sessionId: ready.sessionId,
      providerSessionId: "thread-wrapper-1",
      providerTitle: "First thread",
      reason: "initial",
    });
    engine.applyTerminalWrapperActivity(ready.sessionId, {
      type: "turn_started",
      turnId: "turn-1",
    });

    engine.bindTerminalWrapperProviderSession({
      type: "wrapper.provider_bound",
      sessionId: ready.sessionId,
      providerSessionId: "thread-wrapper-2",
      providerTitle: "Second thread",
      reason: "switch",
    });

    const summary = engine.listSessions().sessions[0];
    assert.equal(summary?.session.providerSessionId, "thread-wrapper-2");
    assert.equal(summary?.session.title, "Second thread");
    assert.equal(summary?.session.runtimeState, "idle");
    assert.equal(summary?.usage, undefined);
    const reboundEvents = engine
      .listEvents({ sessionIds: [ready.sessionId] })
      .filter((event) => event.type === "session.started");
    assert.equal(reboundEvents.at(-1)?.payload.session.providerSessionId, "thread-wrapper-2");

    await engine.shutdown();
  });

  test("disconnecting a terminal wrapper session removes the live session", async () => {
    const adapter = new CountingStoredSessionsAdapter([]);
    const engine = new RuntimeEngine([adapter]);

    const ready = engine.registerTerminalWrapperSession(
      {
        type: "wrapper.hello",
        provider: "codex",
        cwd: workDirGlobal,
        rootDir: workDirGlobal,
        terminalPid: 6363,
        launchCommand: ["rah", "codex"],
      } satisfies WrapperHelloMessage,
      () => undefined,
    );

    assert.equal(engine.listSessions().sessions.length, 1);
    engine.disconnectTerminalWrapperSession(ready.sessionId);
    assert.equal(engine.listSessions().sessions.length, 0);

    await engine.shutdown();
  });

  test("closing a terminal wrapper session requests wrapper shutdown before removing it", async () => {
    const adapter = new CountingStoredSessionsAdapter([]);
    const engine = new RuntimeEngine([adapter]);
    const outbound: TerminalWrapperFromDaemonMessage[] = [];

    const ready = engine.registerTerminalWrapperSession(
      {
        type: "wrapper.hello",
        provider: "codex",
        cwd: workDirGlobal,
        rootDir: workDirGlobal,
        terminalPid: 7373,
        launchCommand: ["rah", "codex"],
      } satisfies WrapperHelloMessage,
      (message) => outbound.push(message),
    );

    engine.attachSession(ready.sessionId, {
      client: {
        id: "web-user",
        kind: "web",
        connectionId: "web-connection",
      },
      mode: "observe",
    });

    await engine.closeSession(ready.sessionId, {
      clientId: "web-user",
    });

    assert.deepEqual(outbound.at(-1), {
      type: "wrapper.close",
      sessionId: ready.sessionId,
    });
    assert.equal(engine.listSessions().sessions.length, 0);

    assert.deepEqual(engine.markTerminalWrapperExited(ready.sessionId, { exitCode: 0 }), []);

    await engine.shutdown();
  });

  test("ignores stale wrapper messages after a terminal wrapper session is closed", async () => {
    const adapter = new CountingStoredSessionsAdapter([]);
    const engine = new RuntimeEngine([adapter]);
    const outbound: TerminalWrapperFromDaemonMessage[] = [];

    const ready = engine.registerTerminalWrapperSession(
      {
        type: "wrapper.hello",
        provider: "codex",
        cwd: workDirGlobal,
        rootDir: workDirGlobal,
        terminalPid: 7474,
        launchCommand: ["rah", "codex"],
      } satisfies WrapperHelloMessage,
      (message) => outbound.push(message),
    );

    engine.attachSession(ready.sessionId, {
      client: {
        id: "web-user",
        kind: "web",
        connectionId: "web-connection",
      },
      mode: "observe",
    });

    await engine.closeSession(ready.sessionId, {
      clientId: "web-user",
    });

    assert.deepEqual(outbound.at(-1), {
      type: "wrapper.close",
      sessionId: ready.sessionId,
    });
    assert.deepEqual(
      engine.appendTerminalWrapperPtyOutput(ready.sessionId, "late output"),
      [],
    );
    assert.deepEqual(
      engine.applyTerminalWrapperActivity(ready.sessionId, {
        type: "runtime_status",
        status: "thinking",
      }),
      [],
    );
    engine.updateTerminalWrapperPromptState(ready.sessionId, "prompt_clean");
    engine.bindTerminalWrapperProviderSession({
      type: "wrapper.provider_bound",
      sessionId: ready.sessionId,
      providerSessionId: "thread-late",
      reason: "switch",
    });
    assert.equal(engine.listSessions().sessions.length, 0);

    await engine.shutdown();
  });
});

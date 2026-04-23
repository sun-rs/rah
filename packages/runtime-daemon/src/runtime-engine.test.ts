import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  AttachSessionRequest,
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
  SessionSummary,
  StartSessionRequest,
  StartSessionResponse,
  StoredSessionRef,
  WorkspaceSnapshotResponse,
} from "@rah/runtime-protocol";
import { RuntimeEngine } from "./runtime-engine";
import type { ProviderAdapter } from "./provider-adapter";
import type { FrozenHistoryBoundary, FrozenHistoryPageLoader } from "./history-snapshots";

class CountingStoredSessionsAdapter implements ProviderAdapter {
  readonly id = "counting";
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
        livePermissions: false,
        contextUsage: false,
        resumeByProvider: true,
        listProviderSessions: true,
        steerInput: true,
        queuedInput: false,
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
});

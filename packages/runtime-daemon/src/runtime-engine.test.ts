import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  AttachSessionRequest,
  CloseSessionRequest,
  ContextUsage,
  GitDiffResponse,
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

  getGitDiff(_sessionId: string, _path: string): GitDiffResponse {
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

  getGitDiff(_sessionId: string, _path: string): GitDiffResponse {
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

    const initial = engine.listSessions();
    assert.equal(adapter.storedSessionCalls, 1);
    assert.equal(initial.storedSessions.length, 2);

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
});

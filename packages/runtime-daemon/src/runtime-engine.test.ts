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
  ResumeSessionRequest,
  ResumeSessionResponse,
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

  getSessionHistoryPage?(
    _sessionId: string,
    _options?: { beforeTs?: string; limit?: number },
  ): SessionHistoryPageResponse {
    throw new Error("not implemented");
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
});

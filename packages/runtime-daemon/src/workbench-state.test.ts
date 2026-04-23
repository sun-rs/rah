import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { RuntimeEngine } from "./runtime-engine";

describe("WorkbenchStateStore", () => {
  let tmpRoot: string;
  let previousRahHome: string | undefined;

  beforeEach(() => {
    tmpRoot = mkdtempSync(path.join(os.tmpdir(), "rah-workbench-state-"));
    previousRahHome = process.env.RAH_HOME;
    process.env.RAH_HOME = tmpRoot;
  });

  afterEach(() => {
    if (previousRahHome === undefined) {
      delete process.env.RAH_HOME;
    } else {
      process.env.RAH_HOME = previousRahHome;
    }
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  test("does not surface stale previous live sessions without provider backing", async () => {
    const first = new RuntimeEngine();
    first.addWorkspace("/workspace/demo");
    first.addWorkspace("/workspace/extra");
    const state = first.sessionStore.createManagedSession({
      provider: "codex",
      providerSessionId: "thread-remember-1",
      launchSource: "web",
      cwd: "/workspace/demo",
      rootDir: "/workspace/demo",
      title: "remember me",
      preview: "resume later",
    });

    first.sessionStore.setRuntimeState(state.session.id, "running");
    await first.shutdown();

    const second = new RuntimeEngine();
    const listed = second.listSessions();

    assert.equal(listed.sessions.length, 0);
    assert.equal(listed.activeWorkspaceDir, "/workspace/extra");
    assert.deepEqual(listed.workspaceDirs, ["/workspace/demo", "/workspace/extra"]);
    assert.ok(
      !listed.recentSessions.some(
        (entry) =>
          entry.provider === "codex" &&
          entry.providerSessionId === "thread-remember-1",
      ),
    );
    assert.ok(
      !listed.storedSessions.some(
        (entry) =>
          entry.provider === "codex" &&
          entry.providerSessionId === "thread-remember-1",
      ),
    );

    await second.shutdown();
  });

  test("listSessions exposes hidden workspaces from persisted workbench state", async () => {
    const engine = new RuntimeEngine();
    engine.addWorkspace("/workspace/demo");
    engine.addWorkspace("/workspace/extra");

    const afterRemoval = engine.removeWorkspace("/workspace/demo");

    assert.deepEqual(afterRemoval.workspaceDirs, ["/workspace/extra"]);
    assert.deepEqual(afterRemoval.hiddenWorkspaces, ["/workspace/demo"]);

    await engine.shutdown();
  });

  test("cannot remove a workspace with active live sessions", async () => {
    const engine = new RuntimeEngine();
    engine.addWorkspace("/workspace/demo");
    engine.sessionStore.createManagedSession({
      provider: "codex",
      providerSessionId: "thread-live-1",
      launchSource: "web",
      cwd: "/workspace/demo",
      rootDir: "/workspace/demo",
      title: "live",
    });

    assert.throws(
      () => engine.removeWorkspace("/workspace/demo"),
      /Cannot remove a workspace with active live sessions/,
    );

    await engine.shutdown();
  });

  test("preserves workspace add order across restart", async () => {
    const first = new RuntimeEngine();
    first.addWorkspace("/workspace/zeta");
    first.addWorkspace("/workspace/alpha");
    first.addWorkspace("/workspace/mid");
    await first.shutdown();

    const second = new RuntimeEngine();
    const listed = second.listSessions();

    assert.deepEqual(listed.workspaceDirs, [
      "/workspace/zeta",
      "/workspace/alpha",
      "/workspace/mid",
    ]);

    await second.shutdown();
  });

  test("cannot remove a parent workspace when a descendant live session exists", async () => {
    const engine = new RuntimeEngine();
    engine.addWorkspace("/workspace/demo");
    engine.addWorkspace("/workspace/demo/app");
    engine.sessionStore.createManagedSession({
      provider: "codex",
      providerSessionId: "thread-live-nested-1",
      launchSource: "web",
      cwd: "/workspace/demo/app",
      rootDir: "/workspace/demo/app",
      title: "nested live",
    });

    assert.throws(
      () => engine.removeWorkspace("/workspace/demo"),
      /Cannot remove a workspace with active live sessions/,
    );

    await engine.shutdown();
  });

  test("loading workbench state sanitizes old internal bootstrap previews", async () => {
    const daemonDir = path.join(tmpRoot, "runtime-daemon");
    mkdirSync(daemonDir, { recursive: true });
    writeFileSync(
      path.join(daemonDir, "workbench-state.json"),
      JSON.stringify(
        {
          version: 1,
          updatedAt: new Date().toISOString(),
          workspaces: ["/workspace/demo"],
          sessions: [
            {
              provider: "codex",
              providerSessionId: "thread-sanitize-1",
              cwd: "/workspace/demo",
              rootDir: "/workspace/demo",
              title: "<environment_context> # AGENTS.md instructions",
              preview: "<environment_context> <cwd>/workspace/demo</cwd>",
              updatedAt: "2026-04-19T00:00:00.000Z",
              source: "provider_history",
            },
          ],
          recentSessions: [
            {
              provider: "codex",
              providerSessionId: "thread-sanitize-1",
              cwd: "/workspace/demo",
              rootDir: "/workspace/demo",
              title: "<environment_context> # AGENTS.md instructions",
              preview: "<environment_context> <cwd>/workspace/demo</cwd>",
              updatedAt: "2026-04-19T00:00:00.000Z",
              lastUsedAt: "2026-04-19T00:00:00.000Z",
              source: "provider_history",
            },
          ],
        },
        null,
        2,
      ),
      "utf8",
    );

    const engine = new RuntimeEngine();
    const listed = engine.listSessions();

    const stored = listed.storedSessions.find(
      (entry) => entry.provider === "codex" && entry.providerSessionId === "thread-sanitize-1",
    );
    const recent = listed.recentSessions.find(
      (entry) => entry.provider === "codex" && entry.providerSessionId === "thread-sanitize-1",
    );

    assert.equal(stored?.title, "thread-sanitize-1");
    assert.equal(stored?.preview, "thread-sanitize-1");
    assert.equal(recent?.title, "thread-sanitize-1");
    assert.equal(recent?.preview, "thread-sanitize-1");

    await engine.shutdown();
  });

  test("closing a managed session removes it from live sessions and unblocks workspace removal", async () => {
    const engine = new RuntimeEngine();
    engine.addWorkspace("/workspace/demo");
    const started = await engine.startSession({
      provider: "claude",
      cwd: "/workspace/demo",
      title: "close me",
      attach: {
        client: {
          id: "web-client",
          kind: "web",
          connectionId: "web-client",
        },
        mode: "interactive",
        claimControl: true,
      },
    });

    await engine.closeSession(started.session.session.id, {
      clientId: "web-client",
    });

    const listed = engine.listSessions();
    assert.equal(listed.sessions.length, 0);
    assert.ok(
      engine
        .listEvents({ sessionIds: [started.session.session.id] })
        .some((event) => event.type === "session.closed"),
    );

    const afterRemoval = engine.removeWorkspace("/workspace/demo");
    assert.deepEqual(afterRemoval.workspaceDirs, []);

    await engine.shutdown();
  });

  test("closing a resumable session keeps it visible in recent and stored history", async () => {
    const engine = new RuntimeEngine();

    const resumed = await engine.resumeSession({
      provider: "custom",
      providerSessionId: "debug-claude-session-1",
      attach: {
        client: {
          id: "web-client",
          kind: "web",
          connectionId: "web-client",
        },
        mode: "interactive",
        claimControl: true,
      },
    });

    await engine.closeSession(resumed.session.session.id, {
      clientId: "web-client",
    });

    const listed = engine.listSessions();
    assert.ok(
      listed.recentSessions.some(
        (entry) =>
          entry.provider === "custom" &&
          entry.providerSessionId === "debug-claude-session-1",
      ),
    );
    assert.ok(
      listed.storedSessions.some(
        (entry) =>
          entry.provider === "custom" &&
          entry.providerSessionId === "debug-claude-session-1",
      ),
    );

    await engine.shutdown();
  });

  test("can remove a workspace when only read-only replay sessions remain open", async () => {
    const previousClaudeConfig = process.env.CLAUDE_CONFIG_DIR;
    const tmpClaudeConfig = mkdtempSync(path.join(os.tmpdir(), "rah-workbench-claude-"));
    const workDir = mkdtempSync(path.join(os.tmpdir(), "rah-workbench-replay-"));
    const projectId = path.resolve(workDir).replace(/[^a-zA-Z0-9]/g, "-");
    const projectDir = path.join(tmpClaudeConfig, "projects", projectId);
    mkdirSync(projectDir, { recursive: true });
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
    process.env.CLAUDE_CONFIG_DIR = tmpClaudeConfig;

    const engine = new RuntimeEngine();
    try {
      engine.addWorkspace(workDir);

      const resumed = await engine.resumeSession({
        provider: "claude",
        providerSessionId: "session-1",
        cwd: workDir,
        preferStoredReplay: true,
        attach: {
          client: {
            id: "web-client",
            kind: "web",
            connectionId: "web-client",
          },
          mode: "observe",
        },
      });

      assert.equal(resumed.session.session.capabilities.steerInput, false);
      assert.equal(resumed.session.session.capabilities.livePermissions, false);

      const afterRemoval = engine.removeWorkspace(workDir);
      assert.deepEqual(afterRemoval.workspaceDirs, []);

      await engine.shutdown();
    } finally {
      if (previousClaudeConfig === undefined) {
        delete process.env.CLAUDE_CONFIG_DIR;
      } else {
        process.env.CLAUDE_CONFIG_DIR = previousClaudeConfig;
      }
      rmSync(tmpClaudeConfig, { recursive: true, force: true });
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  test("workspace removal treats /private/var and /var as the same directory", async () => {
    const engine = new RuntimeEngine();
    engine.addWorkspace("/private/var/folders/demo/workspace");

    const afterRemoval = engine.removeWorkspace("/var/folders/demo/workspace");
    assert.deepEqual(afterRemoval.workspaceDirs, []);

    await engine.shutdown();
  });

  test("removed workspace stays removed across restart even if stale previous live history still points to it", async () => {
    const first = new RuntimeEngine();
    first.addWorkspace("/workspace/demo");
    const state = first.sessionStore.createManagedSession({
      provider: "codex",
      providerSessionId: "thread-removed-1",
      launchSource: "web",
      cwd: "/workspace/demo",
      rootDir: "/workspace/demo",
      title: "remember me",
    });
    first.sessionStore.setRuntimeState(state.session.id, "running");
    await first.shutdown();

    const second = new RuntimeEngine();
    const removed = second.removeWorkspace("/workspace/demo");
    assert.deepEqual(removed.workspaceDirs, []);
    await second.shutdown();

    const third = new RuntimeEngine();
    const listed = third.listSessions();
    assert.deepEqual(listed.workspaceDirs, []);
    assert.ok(
      !listed.storedSessions.some(
        (entry) =>
          entry.provider === "codex" &&
          entry.providerSessionId === "thread-removed-1",
      ),
    );
    await third.shutdown();
  });

  test("listing sessions prunes orphan live sessions with no attached clients", async () => {
    const rootDir = mkdtempSync(path.join(tmpRoot, "workspace-orphan-"));
    const engine = new RuntimeEngine();

    const started = await engine.startSession({
      provider: "claude",
      cwd: rootDir,
      title: "Orphan candidate",
    });

    const sessionId = started.session.session.id;
    const state = engine.sessionStore.getSession(sessionId);
    assert.ok(state);
    assert.equal(state?.clients.length, 0);

    const listed = engine.listSessions();
    assert.equal(listed.sessions.length, 0);
    assert.equal(engine.sessionStore.getSession(sessionId), undefined);

    await engine.shutdown();
  });
});

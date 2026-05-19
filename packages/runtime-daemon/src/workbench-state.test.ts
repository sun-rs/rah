import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { RuntimeEngine } from "./runtime-engine";
import { SessionStore } from "./session-store";
import {
  normalizeDirectory,
  sessionBelongsToWorkspace,
} from "./workbench-directory-utils";
import { WorkbenchStateStore } from "./workbench-state";

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

  test("does not surface stale previous running sessions without provider backing", async () => {
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

  test("cannot remove a workspace with active running sessions", async () => {
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
      /Cannot remove a workspace with active running sessions/,
    );

    await engine.shutdown();
  });

  test("surfaces visible running sessions in global recent before control is claimed", async () => {
    const engine = new RuntimeEngine();
    const state = engine.sessionStore.createManagedSession({
      provider: "codex",
      providerSessionId: "thread-claim-recent-1",
      launchSource: "web",
      cwd: "/workspace/demo",
      rootDir: "/workspace/demo",
      title: "claim me",
    });
    engine.attachSession(state.session.id, {
      client: {
        id: "web-client",
        kind: "web",
        connectionId: "web-client",
      },
      mode: "observe",
    });

    assert.ok(
      engine.listSessions().recentSessions.some(
        (entry) =>
          entry.provider === "codex" &&
          entry.providerSessionId === "thread-claim-recent-1",
      ),
    );

    engine.claimControl(state.session.id, {
      client: {
        id: "web-client",
        kind: "web",
        connectionId: "web-client",
      },
    });

    assert.ok(
      engine.listSessions().recentSessions.some(
        (entry) =>
          entry.provider === "codex" &&
          entry.providerSessionId === "thread-claim-recent-1",
      ),
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

  test("cannot remove a parent workspace when a descendant running session exists", async () => {
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
      /Cannot remove a workspace with active running sessions/,
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
    assert.equal(recent, undefined);

    await engine.shutdown();
  });

  test("loading workbench state drops old internal custom debug sessions", () => {
    const daemonDir = path.join(tmpRoot, "runtime-daemon");
    mkdirSync(daemonDir, { recursive: true });
    writeFileSync(
      path.join(daemonDir, "workbench-state.json"),
      JSON.stringify(
        {
          version: 2,
          updatedAt: new Date().toISOString(),
          workspaces: ["/workspace/demo", "/workspace/debug"],
          hiddenSessionKeys: ["custom:debug-claude-session-1", "codex:thread-visible-1"],
          sessionTitleOverrides: {
            "custom:debug-claude-session-1": "debug title",
            "codex:thread-visible-1": "visible title",
          },
          pendingSessionTitleOverrides: {
            "custom:debug-claude-session-1": "debug pending title",
            "pending-live-id": "pending title",
          },
          sessions: [
            {
              provider: "custom",
              providerSessionId: "debug-claude-session-1",
              cwd: "/workspace/debug",
              rootDir: "/workspace/debug",
              title: "Refactor mobile workbench",
              updatedAt: "2026-04-23T13:26:21.939Z",
              source: "previous_running",
            },
            {
              provider: "codex",
              providerSessionId: "thread-visible-1",
              cwd: "/workspace/demo",
              rootDir: "/workspace/demo",
              title: "Visible",
              updatedAt: "2026-04-23T13:26:21.939Z",
              source: "provider_history",
            },
          ],
          recentSessions: [
            {
              provider: "custom",
              providerSessionId: "debug-claude-session-1",
              cwd: "/workspace/debug",
              rootDir: "/workspace/debug",
              title: "Refactor mobile workbench",
              updatedAt: "2026-04-23T13:26:21.939Z",
              lastUsedAt: "2026-04-23T13:26:21.939Z",
              source: "previous_running",
            },
          ],
        },
        null,
        2,
      ),
      "utf8",
    );

    const snapshot = new WorkbenchStateStore().load();

    assert.deepEqual(snapshot.hiddenSessionKeys, ["codex:thread-visible-1"]);
    assert.deepEqual(snapshot.sessionTitleOverrides, {
      "codex:thread-visible-1": "visible title",
    });
    assert.deepEqual(snapshot.pendingSessionTitleOverrides, {
      "pending-live-id": "pending title",
    });
    assert.ok(snapshot.sessions.every((session) => session.provider !== "custom"));
    assert.ok(snapshot.recentSessions.every((session) => session.provider !== "custom"));
  });

  test("closing a managed session removes it from running sessions and unblocks workspace removal", async () => {
    const rootDir = mkdtempSync(path.join(tmpRoot, "workspace-close-"));
    const engine = new RuntimeEngine();
    engine.addWorkspace(rootDir);
    const started = await engine.startSession({
      provider: "claude",
      cwd: rootDir,
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

    const afterRemoval = engine.removeWorkspace(rootDir);
    assert.deepEqual(afterRemoval.workspaceDirs, []);

    await engine.shutdown();
  });

  test("closing a resumable session keeps it visible in recent and stored history", async () => {
    const previousClaudeConfig = process.env.CLAUDE_CONFIG_DIR;
    const tmpClaudeConfig = mkdtempSync(path.join(os.tmpdir(), "rah-workbench-claude-resumable-"));
    const workDir = mkdtempSync(path.join(os.tmpdir(), "rah-workbench-resumable-"));
    const projectId = path.resolve(workDir).replace(/[^a-zA-Z0-9]/g, "-");
    const projectDir = path.join(tmpClaudeConfig, "projects", projectId);
    const providerSessionId = "debug-claude-session-1";
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(
      path.join(projectDir, `${providerSessionId}.jsonl`),
      [
        JSON.stringify({
          type: "user",
          uuid: "user-1",
          cwd: workDir,
          sessionId: providerSessionId,
          timestamp: "2025-07-19T22:21:00.000Z",
          message: { content: "say hi" },
        }),
        JSON.stringify({
          type: "assistant",
          uuid: "assistant-1",
          cwd: workDir,
          sessionId: providerSessionId,
          timestamp: "2025-07-19T22:21:04.000Z",
          message: { content: [{ type: "text", text: "hello" }] },
        }),
      ].join("\n") + "\n",
    );
    process.env.CLAUDE_CONFIG_DIR = tmpClaudeConfig;
    const engine = new RuntimeEngine();

    try {
      const resumed = await engine.resumeSession({
        provider: "claude",
        providerSessionId,
        preferStoredReplay: true,
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
            entry.provider === "claude" &&
            entry.providerSessionId === providerSessionId,
        ),
      );
      assert.ok(
        listed.storedSessions.some(
          (entry) =>
            entry.provider === "claude" &&
            entry.providerSessionId === providerSessionId,
        ),
      );
    } finally {
      if (previousClaudeConfig === undefined) {
        delete process.env.CLAUDE_CONFIG_DIR;
      } else {
        process.env.CLAUDE_CONFIG_DIR = previousClaudeConfig;
      }
      await engine.shutdown();
      rmSync(tmpClaudeConfig, { recursive: true, force: true });
      rmSync(workDir, { recursive: true, force: true });
    }
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
      assert.ok(
        engine.listSessions().recentSessions.some(
          (entry) =>
            entry.provider === "claude" &&
            entry.providerSessionId === "session-1",
        ),
      );

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

  test("root workspace normalization keeps root as a valid boundary", () => {
    assert.equal(normalizeDirectory("/"), "/");
    assert.equal(sessionBelongsToWorkspace("/Users/sun/project", "/"), true);
    assert.equal(sessionBelongsToWorkspace(undefined, "/"), false);
  });

  test("workspace list dedupes symlink and real paths even after the workspace child is deleted", async () => {
    const target = path.join(tmpRoot, "target");
    const alias = path.join(tmpRoot, "alias");
    mkdirSync(target);
    symlinkSync(target, alias, "dir");
    const aliasWorkspace = path.join(alias, "crates", "AI", "synapse");
    const targetWorkspace = path.join(target, "crates", "AI", "synapse");

    const engine = new RuntimeEngine();
    engine.addWorkspace(aliasWorkspace);
    const listed = engine.addWorkspace(targetWorkspace);

    assert.deepEqual(listed.workspaceDirs, [aliasWorkspace]);

    await engine.shutdown();
  });

  test("session store read methods normalize shared web clients without mutating stored state", () => {
    const store = new SessionStore();
    const state = store.createManagedSession({
      provider: "codex",
      providerSessionId: "thread-shared-web-read-1",
      launchSource: "web",
      cwd: "/workspace/demo",
      rootDir: "/workspace/demo",
    });
    state.clients.push(
      {
        id: "web-alpha",
        kind: "web",
        sessionId: state.session.id,
        connectionId: "web-alpha",
        attachMode: "interactive",
        focus: false,
        lastSeenAt: "2026-04-29T01:00:00.000Z",
      },
      {
        id: "web-beta",
        kind: "web",
        sessionId: state.session.id,
        connectionId: "web-beta",
        attachMode: "observe",
        focus: true,
        lastSeenAt: "2026-04-29T01:01:00.000Z",
      },
    );
    state.controlLease = {
      sessionId: state.session.id,
      holderClientId: "web-alpha",
      holderKind: "web",
      grantedAt: "2026-04-29T01:00:10.000Z",
    };

    const listed = store.listSessions()[0];
    assert.deepEqual(
      listed?.clients.map((client) => client.id),
      ["web-user"],
    );
    assert.equal(listed?.controlLease.holderClientId, "web-user");

    const fetched = store.getSession(state.session.id);
    assert.deepEqual(
      fetched?.clients.map((client) => client.id),
      ["web-user"],
    );
    assert.equal(fetched?.controlLease.holderClientId, "web-user");

    assert.deepEqual(
      state.clients.map((client) => client.id),
      ["web-alpha", "web-beta"],
    );
    assert.equal(state.controlLease.holderClientId, "web-alpha");
  });

  test("removed workspace stays removed across restart even if stale previous running history still points to it", async () => {
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

  test("listing sessions prunes orphan running sessions with no attached clients", async () => {
    const rootDir = mkdtempSync(path.join(tmpRoot, "workspace-orphan-"));
    const engine = new RuntimeEngine();
    try {
      const state = engine.sessionStore.createManagedSession({
        provider: "claude",
        providerSessionId: "orphan-candidate-1",
        launchSource: "web",
        cwd: rootDir,
        rootDir,
        title: "Orphan candidate",
      });

      assert.equal(state.clients.length, 0);

      const listed = engine.listSessions();
      assert.equal(listed.sessions.length, 0);
      assert.equal(engine.sessionStore.getSession(state.session.id), undefined);
    } finally {
      await engine.shutdown();
    }
  });
});

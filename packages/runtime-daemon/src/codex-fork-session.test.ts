import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { EventBus } from "./event-bus";
import { PtyHub } from "./pty-hub";
import { CodexAdapter } from "./provider-control/codex-structured-adapter";
import { SessionStore } from "./session-store";

let tmpDir: string;
let previousBinary: string | undefined;
let previousTransport: string | undefined;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "rah-codex-fork-"));
  previousBinary = process.env.RAH_CODEX_BINARY;
  previousTransport = process.env.RAH_CODEX_APP_SERVER_TRANSPORT;
  process.env.RAH_CODEX_APP_SERVER_TRANSPORT = "stdio";
});

afterEach(() => {
  if (previousBinary === undefined) {
    delete process.env.RAH_CODEX_BINARY;
  } else {
    process.env.RAH_CODEX_BINARY = previousBinary;
  }
  if (previousTransport === undefined) {
    delete process.env.RAH_CODEX_APP_SERVER_TRANSPORT;
  } else {
    process.env.RAH_CODEX_APP_SERVER_TRANSPORT = previousTransport;
  }
  rmSync(tmpDir, { recursive: true, force: true });
});

test("forks an ephemeral Codex Side thread and unsubscribes it on close", async () => {
  const requestLog = path.join(tmpDir, "requests.jsonl");
  const serverJs = path.join(tmpDir, "mock-codex-fork-server.js");
  writeFileSync(
    serverJs,
    `
const fs = require('node:fs');
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
function send(msg) { process.stdout.write(JSON.stringify(msg) + "\\n"); }
function log(msg) { fs.appendFileSync(${JSON.stringify(requestLog)}, JSON.stringify(msg) + "\\n"); }
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  log({ method: msg.method, params: msg.params });
  if (msg.method === 'initialize') {
    send({ id: msg.id, result: {} });
    return;
  }
  if (msg.method === 'thread/start') {
    send({ id: msg.id, result: { thread: { id: 'thread-parent', status: { type: 'idle' } }, cwd: ${JSON.stringify(tmpDir)} } });
    return;
  }
  if (msg.method === 'thread/fork') {
    const threadId = msg.params?.ephemeral ? 'thread-side' : 'thread-fork';
    send({ id: msg.id, result: { thread: { id: threadId, status: { type: 'idle' } }, cwd: ${JSON.stringify(tmpDir)}, model: 'gpt-test' } });
    return;
  }
  if (msg.method === 'turn/start') {
    const turn = { id: 'turn-side-1', status: 'inProgress' };
    send({ id: msg.id, result: { turn } });
    send({ method: 'turn/started', params: { threadId: msg.params.threadId, turn } });
    send({ method: 'turn/completed', params: { threadId: msg.params.threadId, turn: { id: turn.id, status: 'completed' } } });
    return;
  }
  if (msg.method === 'thread/unsubscribe') {
    send({ id: msg.id, result: { status: 'unsubscribed' } });
    return;
  }
  if (msg.method === 'thread/goal/get') {
    send({ id: msg.id, result: { goal: null } });
    return;
  }
  send({ id: msg.id, result: {} });
});
`,
  );
  const wrapper = path.join(tmpDir, "mock-codex");
  writeFileSync(wrapper, `#!/bin/sh\nexec node "${serverJs}" "$@"\n`);
  chmodSync(wrapper, 0o755);
  process.env.RAH_CODEX_BINARY = wrapper;

  const services = {
    eventBus: new EventBus(),
    ptyHub: new PtyHub(),
    sessionStore: new SessionStore(),
  };
  const adapter = new CodexAdapter(services);
  const attach = {
    client: { id: "web-1", kind: "web" as const, connectionId: "connection-1" },
    mode: "interactive" as const,
    claimControl: true,
  };

  try {
    const parent = await adapter.startSession({
      provider: "codex",
      cwd: tmpDir,
      title: "Parent",
      attach,
    });
    const side = await adapter.forkSession(parent.session.session.id, {
      operationId: "side-operation-1",
      kind: "side",
      workspaceMode: "shared",
      lastTurnId: "turn-parent-7",
      attach,
    });

    assert.deepEqual(side.session.session.relationship, {
      parentSessionId: parent.session.session.id,
      parentProviderSessionId: "thread-parent",
      forkPointTurnId: "turn-parent-7",
      kind: "side",
      workspaceMode: "shared",
      persistence: "ephemeral",
      sideState: "ready",
    });
    assert.equal(side.session.session.capabilities.actions?.archive, false);
    assert.equal(side.session.session.capabilities.actions?.delete, false);
    assert.equal(side.session.session.capabilities.nativeTui, false);
    assert.equal(side.session.session.capabilities.branching?.side, false);

    adapter.sendInput(side.session.session.id, {
      clientId: "web-1",
      text: "Check this in the background.",
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(
      services.sessionStore.getSession(side.session.session.id)?.session.relationship?.sideState,
      "completed",
    );

    const persistentFork = await adapter.forkSession(parent.session.session.id, {
      operationId: "fork-operation-1",
      kind: "fork",
      workspaceMode: "shared",
      attach,
    });
    assert.equal(persistentFork.session.session.relationship?.kind, "fork");
    assert.equal(persistentFork.session.session.relationship?.persistence, "persistent");
    assert.equal(persistentFork.session.session.capabilities.actions?.archive, true);
    assert.equal(persistentFork.session.session.capabilities.branching?.side, true);

    await adapter.closeSession(side.session.session.id, { clientId: "web-1" });
    await adapter.closeSession(persistentFork.session.session.id, { clientId: "web-1" });

    const requests = readFileSync(requestLog, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { method: string; params?: Record<string, unknown> });
    const fork = requests.find((request) => request.method === "thread/fork");
    assert.equal(typeof fork?.params?.developerInstructions, "string");
    const { developerInstructions, ...forkParams } = fork?.params ?? {};
    assert.equal(typeof developerInstructions, "string");
    assert.deepEqual(forkParams, {
      threadId: "thread-parent",
      lastTurnId: "turn-parent-7",
      cwd: tmpDir,
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      ephemeral: true,
      threadSource: "sideConversation",
    });
    const inject = requests.find((request) => request.method === "thread/inject_items");
    assert.equal(inject?.params?.threadId, "thread-side");
    assert.equal(Array.isArray(inject?.params?.items), true);
    assert.equal(
      requests.some(
        (request) =>
          request.method === "thread/unsubscribe" &&
          request.params?.threadId === "thread-side",
      ),
      true,
    );
    assert.equal(
      requests.some(
        (request) =>
          request.method === "thread/unsubscribe" &&
          request.params?.threadId === "thread-fork",
      ),
      false,
    );
    assert.equal(
      requests.filter((request) => request.method === "thread/inject_items").length,
      1,
    );
  } finally {
    await adapter.shutdown();
  }
});

test("keeps an unloaded Side visible as expired and does not unsubscribe it again", async () => {
  const requestLog = path.join(tmpDir, "expired-requests.jsonl");
  const serverJs = path.join(tmpDir, "mock-codex-expired-side-server.js");
  writeFileSync(
    serverJs,
    `
const fs = require('node:fs');
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
function send(msg) { process.stdout.write(JSON.stringify(msg) + "\\n"); }
function log(msg) { fs.appendFileSync(${JSON.stringify(requestLog)}, JSON.stringify(msg) + "\\n"); }
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  log({ method: msg.method, params: msg.params });
  if (msg.method === 'initialize') {
    send({ id: msg.id, result: {} });
    return;
  }
  if (msg.method === 'thread/start') {
    send({ id: msg.id, result: { thread: { id: 'thread-parent-expired', status: { type: 'idle' } }, cwd: ${JSON.stringify(tmpDir)} } });
    return;
  }
  if (msg.method === 'thread/fork') {
    send({ id: msg.id, result: { thread: { id: 'thread-side-expired', status: { type: 'idle' } }, cwd: ${JSON.stringify(tmpDir)} } });
    return;
  }
  if (msg.method === 'thread/inject_items') {
    send({ id: msg.id, result: {} });
    setTimeout(() => send({
      method: 'thread/status/changed',
      params: { threadId: 'thread-side-expired', status: { type: 'notLoaded' } },
    }), 10);
    return;
  }
  if (msg.method === 'thread/goal/get') {
    send({ id: msg.id, result: { goal: null } });
    return;
  }
  if (msg.method === 'thread/unsubscribe') {
    send({ id: msg.id, result: {} });
    return;
  }
  send({ id: msg.id, result: {} });
});
`,
  );
  const wrapper = path.join(tmpDir, "mock-codex-expired-side");
  writeFileSync(wrapper, `#!/bin/sh\nexec node "${serverJs}" "$@"\n`);
  chmodSync(wrapper, 0o755);
  process.env.RAH_CODEX_BINARY = wrapper;

  const services = {
    eventBus: new EventBus(),
    ptyHub: new PtyHub(),
    sessionStore: new SessionStore(),
  };
  const adapter = new CodexAdapter(services);
  const attach = {
    client: { id: "web-expired", kind: "web" as const, connectionId: "connection-expired" },
    mode: "interactive" as const,
    claimControl: true,
  };

  try {
    const parent = await adapter.startSession({
      provider: "codex",
      cwd: tmpDir,
      attach,
    });
    const side = await adapter.forkSession(parent.session.session.id, {
      operationId: "side-expired-operation",
      kind: "side",
      workspaceMode: "shared",
      attach,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    const expired = services.sessionStore.getSession(side.session.session.id)?.session;
    assert.equal(expired?.relationship?.sideState, "expired");
    assert.equal(expired?.runtimeState, "stopped");
    assert.throws(
      () =>
        adapter.sendInput(side.session.session.id, {
          clientId: "web-expired",
          text: "Continue",
        }),
      /expired in Codex/,
    );

    await adapter.closeSession(side.session.session.id, { clientId: "web-expired" });
    const requests = readFileSync(requestLog, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { method: string; params?: Record<string, unknown> });
    assert.equal(
      requests.some(
        (request) =>
          request.method === "thread/unsubscribe" &&
          request.params?.threadId === "thread-side-expired",
      ),
      false,
    );
  } finally {
    await adapter.shutdown();
  }
});

test("rolls back the provider thread when Side initialization fails", async () => {
  const requestLog = path.join(tmpDir, "rollback-requests.jsonl");
  const serverJs = path.join(tmpDir, "mock-codex-fork-rollback-server.js");
  writeFileSync(
    serverJs,
    `
const fs = require('node:fs');
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
function send(msg) { process.stdout.write(JSON.stringify(msg) + "\\n"); }
function log(msg) { fs.appendFileSync(${JSON.stringify(requestLog)}, JSON.stringify(msg) + "\\n"); }
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  log({ method: msg.method, params: msg.params });
  if (msg.method === 'initialize') {
    send({ id: msg.id, result: {} });
    return;
  }
  if (msg.method === 'thread/start') {
    send({ id: msg.id, result: { thread: { id: 'thread-parent', status: { type: 'idle' } }, cwd: ${JSON.stringify(tmpDir)} } });
    return;
  }
  if (msg.method === 'thread/fork') {
    send({ id: msg.id, result: { thread: { id: 'thread-side-failed', status: { type: 'idle' } }, cwd: ${JSON.stringify(tmpDir)} } });
    return;
  }
  if (msg.method === 'thread/inject_items') {
    send({ id: msg.id, error: { code: -32000, message: 'side boundary injection failed' } });
    return;
  }
  if (msg.method === 'thread/unsubscribe') {
    send({ id: msg.id, result: { status: 'unsubscribed' } });
    return;
  }
  if (msg.method === 'thread/goal/get') {
    send({ id: msg.id, result: { goal: null } });
    return;
  }
  send({ id: msg.id, result: {} });
});
`,
  );
  const wrapper = path.join(tmpDir, "mock-codex-rollback");
  writeFileSync(wrapper, `#!/bin/sh\nexec node "${serverJs}" "$@"\n`);
  chmodSync(wrapper, 0o755);
  process.env.RAH_CODEX_BINARY = wrapper;

  const services = {
    eventBus: new EventBus(),
    ptyHub: new PtyHub(),
    sessionStore: new SessionStore(),
  };
  const adapter = new CodexAdapter(services);
  const attach = {
    client: { id: "web-rollback", kind: "web" as const, connectionId: "connection-rollback" },
    mode: "interactive" as const,
    claimControl: true,
  };

  try {
    const parent = await adapter.startSession({
      provider: "codex",
      cwd: tmpDir,
      title: "Parent",
      attach,
    });
    await assert.rejects(
      adapter.forkSession(parent.session.session.id, {
        operationId: "side-operation-rollback",
        kind: "side",
        workspaceMode: "shared",
        attach,
      }),
      /side boundary injection failed/,
    );

    assert.deepEqual(
      services.sessionStore.listSessions().map((state) => state.session.providerSessionId),
      ["thread-parent"],
    );
    const requests = readFileSync(requestLog, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { method: string; params?: Record<string, unknown> });
    assert.equal(
      requests.some(
        (request) =>
          request.method === "thread/unsubscribe" &&
          request.params?.threadId === "thread-side-failed",
      ),
      true,
    );
    await adapter.closeSession(parent.session.session.id, { clientId: "web-rollback" });
  } finally {
    await adapter.shutdown();
  }
});

test("keeps a failed recovery Side when boundary injection and rollback both fail", async () => {
  const requestLog = path.join(tmpDir, "provisional-recovery-requests.jsonl");
  const serverJs = path.join(tmpDir, "mock-codex-provisional-recovery-server.js");
  writeFileSync(
    serverJs,
    `
const fs = require('node:fs');
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
let unsubscribeCount = 0;
function send(msg) { process.stdout.write(JSON.stringify(msg) + "\\n"); }
function log(msg) { fs.appendFileSync(${JSON.stringify(requestLog)}, JSON.stringify(msg) + "\\n"); }
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  log({ method: msg.method, params: msg.params });
  if (msg.method === 'initialize') {
    send({ id: msg.id, result: {} });
    return;
  }
  if (msg.method === 'thread/start') {
    send({ id: msg.id, result: { thread: { id: 'thread-parent', status: { type: 'idle' } }, cwd: ${JSON.stringify(tmpDir)} } });
    return;
  }
  if (msg.method === 'thread/fork') {
    send({ id: msg.id, result: { thread: { id: 'thread-side-provisional', status: { type: 'idle' } }, cwd: ${JSON.stringify(tmpDir)} } });
    return;
  }
  if (msg.method === 'thread/inject_items') {
    send({ id: msg.id, error: { code: -32000, message: 'side boundary injection failed' } });
    return;
  }
  if (msg.method === 'thread/unsubscribe') {
    unsubscribeCount += 1;
    if (unsubscribeCount === 1) {
      send({ id: msg.id, error: { code: -32000, message: 'temporary rollback failure' } });
    } else {
      send({ id: msg.id, result: { status: 'unsubscribed' } });
    }
    return;
  }
  if (msg.method === 'thread/goal/get') {
    send({ id: msg.id, result: { goal: null } });
    return;
  }
  send({ id: msg.id, result: {} });
});
`,
  );
  const wrapper = path.join(tmpDir, "mock-codex-provisional-recovery");
  writeFileSync(wrapper, `#!/bin/sh\nexec node "${serverJs}" "$@"\n`);
  chmodSync(wrapper, 0o755);
  process.env.RAH_CODEX_BINARY = wrapper;

  const services = {
    eventBus: new EventBus(),
    ptyHub: new PtyHub(),
    sessionStore: new SessionStore(),
  };
  const adapter = new CodexAdapter(services);
  const attach = {
    client: {
      id: "web-provisional",
      kind: "web" as const,
      connectionId: "connection-provisional",
    },
    mode: "interactive" as const,
    claimControl: true,
  };

  try {
    const parent = await adapter.startSession({ provider: "codex", cwd: tmpDir, attach });
    const response = await adapter.forkSession(parent.session.session.id, {
      operationId: "side-operation-provisional-recovery",
      kind: "side",
      workspaceMode: "shared",
      attach,
    });

    const recovery = services.sessionStore.findManagedByProviderSession(
      "codex",
      "thread-side-provisional",
    );
    assert.ok(recovery);
    assert.equal(response.session.session.id, recovery.session.id);
    assert.equal(recovery.session.runtimeState, "failed");
    assert.match(
      recovery.session.runtimeDiagnostics?.lastError ?? "",
      /side boundary injection failed.*temporary rollback failure/,
    );
    assert.equal(
      services.sessionStore.hasAttachedClient(recovery.session.id, "web-provisional"),
      true,
    );

    await adapter.closeSession(recovery.session.id, { clientId: "web-provisional" });
    const requests = readFileSync(requestLog, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { method: string; params?: Record<string, unknown> });
    assert.equal(
      requests.filter(
        (request) =>
          request.method === "thread/unsubscribe" &&
          request.params?.threadId === "thread-side-provisional",
      ).length,
      2,
    );
    await adapter.closeSession(parent.session.session.id, { clientId: "web-provisional" });
  } finally {
    await adapter.shutdown();
  }
});

test("keeps a live Side registered when unsubscribe fails so close can be retried", async () => {
  const requestLog = path.join(tmpDir, "retry-close-requests.jsonl");
  const serverJs = path.join(tmpDir, "mock-codex-side-close-retry-server.js");
  writeFileSync(
    serverJs,
    `
const fs = require('node:fs');
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
let unsubscribeCount = 0;
function send(msg) { process.stdout.write(JSON.stringify(msg) + "\\n"); }
function log(msg) { fs.appendFileSync(${JSON.stringify(requestLog)}, JSON.stringify(msg) + "\\n"); }
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  log({ method: msg.method, params: msg.params });
  if (msg.method === 'initialize') {
    send({ id: msg.id, result: {} });
    return;
  }
  if (msg.method === 'thread/start') {
    send({ id: msg.id, result: { thread: { id: 'thread-parent', status: { type: 'idle' } }, cwd: ${JSON.stringify(tmpDir)} } });
    return;
  }
  if (msg.method === 'thread/fork') {
    send({ id: msg.id, result: { thread: { id: 'thread-side-retry', status: { type: 'idle' } }, cwd: ${JSON.stringify(tmpDir)} } });
    return;
  }
  if (msg.method === 'thread/unsubscribe') {
    unsubscribeCount += 1;
    if (unsubscribeCount === 1) {
      send({ id: msg.id, error: { code: -32000, message: 'temporary unsubscribe failure' } });
    } else {
      send({ id: msg.id, result: { status: 'unsubscribed' } });
    }
    return;
  }
  if (msg.method === 'thread/goal/get') {
    send({ id: msg.id, result: { goal: null } });
    return;
  }
  send({ id: msg.id, result: {} });
});
`,
  );
  const wrapper = path.join(tmpDir, "mock-codex-side-close-retry");
  writeFileSync(wrapper, `#!/bin/sh\nexec node "${serverJs}" "$@"\n`);
  chmodSync(wrapper, 0o755);
  process.env.RAH_CODEX_BINARY = wrapper;

  const services = {
    eventBus: new EventBus(),
    ptyHub: new PtyHub(),
    sessionStore: new SessionStore(),
  };
  const adapter = new CodexAdapter(services);
  const attach = {
    client: { id: "web-retry", kind: "web" as const, connectionId: "connection-retry" },
    mode: "interactive" as const,
    claimControl: true,
  };

  try {
    const parent = await adapter.startSession({ provider: "codex", cwd: tmpDir, attach });
    const side = await adapter.forkSession(parent.session.session.id, {
      operationId: "side-operation-close-retry",
      kind: "side",
      workspaceMode: "shared",
      attach,
    });

    await assert.rejects(
      adapter.closeSession(side.session.session.id, { clientId: "web-retry" }),
      /temporary unsubscribe failure/,
    );
    await adapter.closeSession(side.session.session.id, { clientId: "web-retry" });

    const requests = readFileSync(requestLog, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { method: string; params?: Record<string, unknown> });
    assert.equal(
      requests.filter(
        (request) =>
          request.method === "thread/unsubscribe" &&
          request.params?.threadId === "thread-side-retry",
      ).length,
      2,
    );
    await adapter.closeSession(parent.session.session.id, { clientId: "web-retry" });
  } finally {
    await adapter.shutdown();
  }
});

test("registers a failed recovery Side when local creation and provider rollback both fail", async () => {
  const requestLog = path.join(tmpDir, "prelocal-recovery-requests.jsonl");
  const serverJs = path.join(tmpDir, "mock-codex-prelocal-recovery-server.js");
  writeFileSync(
    serverJs,
    `
const fs = require('node:fs');
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
let unsubscribeCount = 0;
function send(msg) { process.stdout.write(JSON.stringify(msg) + "\\n"); }
function log(msg) { fs.appendFileSync(${JSON.stringify(requestLog)}, JSON.stringify(msg) + "\\n"); }
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  log({ method: msg.method, params: msg.params });
  if (msg.method === 'initialize') {
    send({ id: msg.id, result: {} });
    return;
  }
  if (msg.method === 'thread/start') {
    send({ id: msg.id, result: { thread: { id: 'thread-parent', status: { type: 'idle' } }, cwd: ${JSON.stringify(tmpDir)} } });
    return;
  }
  if (msg.method === 'thread/fork') {
    send({ id: msg.id, result: { thread: { id: 'thread-side-prelocal', status: { type: 'idle' } }, cwd: ${JSON.stringify(tmpDir)} } });
    return;
  }
  if (msg.method === 'thread/unsubscribe') {
    unsubscribeCount += 1;
    if (unsubscribeCount === 1) {
      send({ id: msg.id, error: { code: -32000, message: 'temporary rollback failure' } });
    } else {
      send({ id: msg.id, result: { status: 'unsubscribed' } });
    }
    return;
  }
  if (msg.method === 'thread/goal/get') {
    send({ id: msg.id, result: { goal: null } });
    return;
  }
  send({ id: msg.id, result: {} });
});
`,
  );
  const wrapper = path.join(tmpDir, "mock-codex-prelocal-recovery");
  writeFileSync(wrapper, `#!/bin/sh\nexec node "${serverJs}" "$@"\n`);
  chmodSync(wrapper, 0o755);
  process.env.RAH_CODEX_BINARY = wrapper;

  const services = {
    eventBus: new EventBus(),
    ptyHub: new PtyHub(),
    sessionStore: new SessionStore(),
  };
  const adapter = new CodexAdapter(services);
  const attach = {
    client: { id: "web-prelocal", kind: "web" as const, connectionId: "connection-prelocal" },
    mode: "interactive" as const,
    claimControl: true,
  };

  try {
    const parent = await adapter.startSession({ provider: "codex", cwd: tmpDir, attach });
    const originalCreateManagedSession =
      services.sessionStore.createManagedSession.bind(services.sessionStore);
    let failFirstSideRegistration = true;
    services.sessionStore.createManagedSession = ((args) => {
      if (
        failFirstSideRegistration &&
        args.provider === "codex" &&
        args.providerSessionId === "thread-side-prelocal"
      ) {
        failFirstSideRegistration = false;
        throw new Error("local Side registration failed");
      }
      return originalCreateManagedSession(args);
    }) as SessionStore["createManagedSession"];

    const response = await adapter.forkSession(parent.session.session.id, {
      operationId: "side-operation-prelocal-recovery",
      kind: "side",
      workspaceMode: "shared",
      attach,
    });

    const recovery = services.sessionStore.findManagedByProviderSession(
      "codex",
      "thread-side-prelocal",
    );
    assert.ok(recovery);
    assert.equal(response.session.session.id, recovery.session.id);
    assert.equal(recovery.session.runtimeState, "failed");
    assert.equal(recovery.session.relationship?.kind, "side");
    assert.equal(recovery.session.capabilities.nativeTui, false);
    assert.match(
      recovery.session.runtimeDiagnostics?.lastError ?? "",
      /local Side registration failed.*temporary rollback failure/,
    );
    assert.equal(services.sessionStore.hasAttachedClient(recovery.session.id, "web-prelocal"), true);

    await adapter.closeSession(recovery.session.id, { clientId: "web-prelocal" });
    const requests = readFileSync(requestLog, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { method: string; params?: Record<string, unknown> });
    assert.equal(
      requests.filter(
        (request) =>
          request.method === "thread/unsubscribe" &&
          request.params?.threadId === "thread-side-prelocal",
      ).length,
      2,
    );
    await adapter.closeSession(parent.session.session.id, { clientId: "web-prelocal" });
  } finally {
    await adapter.shutdown();
  }
});

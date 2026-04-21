import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { CodexAdapter } from "./codex-adapter";
import { EventBus } from "./event-bus";
import { PtyHub } from "./pty-hub";
import { SessionStore } from "./session-store";

function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() - started > timeoutMs) {
        reject(new Error("Timed out waiting for condition"));
        return;
      }
      setTimeout(tick, 25);
    };
    tick();
  });
}

describe("Codex live permission flow", () => {
  let tmpDir: string;
  let previousBinary: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "rah-codex-live-"));
    previousBinary = process.env.RAH_CODEX_BINARY;
  });

  afterEach(() => {
    if (previousBinary === undefined) {
      delete process.env.RAH_CODEX_BINARY;
    } else {
      process.env.RAH_CODEX_BINARY = previousBinary;
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("round-trips request_user_input through adapter responses", async () => {
    const serverJs = path.join(tmpDir, "mock-codex-server.js");
    writeFileSync(
      serverJs,
      `
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
function send(msg) { process.stdout.write(JSON.stringify(msg) + "\\n"); }
let pendingTurnId = null;
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') {
    send({ id: msg.id, result: {} });
    return;
  }
  if (msg.method === 'thread/start') {
    send({ id: msg.id, result: { thread: { id: 'thread-live-1' } } });
    return;
  }
  if (msg.method === 'turn/start') {
    pendingTurnId = 'turn-live-1';
    setTimeout(() => send({ method: 'turn/started', params: { turn: { id: pendingTurnId } } }), 5);
    setTimeout(() => send({
      id: 9001,
      method: 'item/tool/requestUserInput',
      params: {
        threadId: 'thread-live-1',
        turnId: pendingTurnId,
        itemId: 'question-1',
        questions: [
          {
            id: 'drink',
            header: 'Drink',
            question: 'Which drink do you want?',
            options: [{ label: 'Coffee' }, { label: 'Tea' }],
          },
        ],
      },
    }), 10);
    send({ id: msg.id, result: { turn: { id: pendingTurnId } } });
    return;
  }
  if (msg.id === 9001) {
    const selected = msg.result?.answers?.drink?.answers?.[0] ?? 'unknown';
    send({ method: 'item/agentMessage/delta', params: { itemId: 'assistant-1', delta: 'Selected: ' + selected } });
    send({ method: 'turn/completed', params: { turn: { id: pendingTurnId, status: 'completed' } } });
    return;
  }
  if (msg.method === 'turn/interrupt') {
    send({ id: msg.id, result: {} });
    send({ method: 'turn/completed', params: { turn: { id: pendingTurnId, status: 'interrupted' } } });
    return;
  }
  send({ id: msg.id, result: {} });
});
`,
    );
    const wrapper = path.join(tmpDir, "mock-codex");
    writeFileSync(
      wrapper,
      `#!/bin/sh\nexec node "${serverJs}" "$@"\n`,
    );
    chmodSync(wrapper, 0o755);
    process.env.RAH_CODEX_BINARY = wrapper;

    const services = {
      eventBus: new EventBus(),
      ptyHub: new PtyHub(),
      sessionStore: new SessionStore(),
    };
    const adapter = new CodexAdapter(services);

    const started = await adapter.startSession({
      provider: "codex",
      cwd: tmpDir,
      title: "live question test",
      attach: {
        client: {
          id: "test-client",
          kind: "web",
          connectionId: "test-client",
        },
        mode: "interactive",
        claimControl: true,
      },
    });
    assert.equal(started.session.session.capabilities.steerInput, true);
    assert.equal(started.session.session.capabilities.livePermissions, true);
    assert.equal(started.session.session.capabilities.liveAttach, true);
    assert.equal(started.session.session.capabilities.structuredTimeline, true);
    assert.equal(started.session.session.capabilities.resumeByProvider, true);
    assert.equal(started.session.session.capabilities.listProviderSessions, true);
    assert.equal(started.session.session.capabilities.queuedInput, false);
    assert.equal(started.session.session.capabilities.modelSwitch, false);
    assert.equal(started.session.session.capabilities.planMode, false);
    assert.equal(started.session.session.capabilities.subagents, false);

    adapter.sendInput(started.session.session.id, {
      clientId: "test-client",
      text: "Pick a drink",
    });

    await waitFor(() =>
      services.eventBus.list({ sessionIds: [started.session.session.id] }).some(
        (event) => event.type === "permission.requested",
      ),
    );

    await adapter.respondToPermission?.(started.session.session.id, "permission-question-1", {
      behavior: "allow",
      answers: {
        drink: { answers: ["Coffee"] },
      },
    });

    await waitFor(() =>
      services.eventBus.list({ sessionIds: [started.session.session.id] }).some(
        (event) =>
          event.type === "timeline.item.added" &&
          event.payload.item.kind === "assistant_message" &&
          event.payload.item.text.includes("Coffee"),
      ),
    );

    const events = services.eventBus.list({ sessionIds: [started.session.session.id] });
    assert.ok(events.some((event) => event.type === "permission.requested"));
    assert.ok(events.some((event) => event.type === "permission.resolved"));
    assert.ok(events.some((event) => event.type === "turn.completed"));

    await adapter.shutdown?.();
  });

  test("bridges exec command output into PTY frames for live sessions", async () => {
    const serverJs = path.join(tmpDir, "mock-codex-exec-server.js");
    writeFileSync(
      serverJs,
      `
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
function send(msg) { process.stdout.write(JSON.stringify(msg) + "\\n"); }
let pendingTurnId = null;
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') {
    send({ id: msg.id, result: {} });
    return;
  }
  if (msg.method === 'thread/start') {
    send({ id: msg.id, result: { thread: { id: 'thread-live-exec-1' } } });
    return;
  }
  if (msg.method === 'turn/start') {
    pendingTurnId = 'turn-live-exec-1';
    send({ id: msg.id, result: { turn: { id: pendingTurnId } } });
    setTimeout(() => send({ method: 'turn/started', params: { turn: { id: pendingTurnId } } }), 5);
    setTimeout(() => send({
      method: 'codex/event/exec_command_begin',
      params: {
        msg: {
          call_id: 'call-exec-1',
          command: 'echo hello',
          cwd: '${tmpDir}',
        },
      },
    }), 10);
    setTimeout(() => send({
      method: 'codex/event/exec_command_output_delta',
      params: { msg: { call_id: 'call-exec-1', chunk: 'hello\\n' } },
    }), 15);
    setTimeout(() => send({
      method: 'codex/event/exec_command_end',
      params: { msg: { call_id: 'call-exec-1', exit_code: 0 } },
    }), 20);
    setTimeout(() => send({ method: 'turn/completed', params: { turn: { id: pendingTurnId, status: 'completed' } } }), 25);
    return;
  }
  send({ id: msg.id, result: {} });
});
`,
    );
    const wrapper = path.join(tmpDir, "mock-codex-exec");
    writeFileSync(
      wrapper,
      `#!/bin/sh\nexec node "${serverJs}" "$@"\n`,
    );
    chmodSync(wrapper, 0o755);
    process.env.RAH_CODEX_BINARY = wrapper;

    const services = {
      eventBus: new EventBus(),
      ptyHub: new PtyHub(),
      sessionStore: new SessionStore(),
    };
    const adapter = new CodexAdapter(services);

    const started = await adapter.startSession({
      provider: "codex",
      cwd: tmpDir,
      title: "live exec test",
      attach: {
        client: {
          id: "test-client",
          kind: "web",
          connectionId: "test-client",
        },
        mode: "interactive",
        claimControl: true,
      },
    });

    const frames: Array<string> = [];
    const unsubscribe = services.ptyHub.subscribe(
      started.session.session.id,
      (frame) => {
        if (frame.type === "pty.output") {
          frames.push(frame.data);
        }
      },
      false,
    );

    adapter.sendInput(started.session.session.id, {
      clientId: "test-client",
      text: "Run a command",
    });

    await waitFor(() =>
      frames.some((chunk) => chunk.includes("$ echo hello")) &&
      frames.some((chunk) => chunk.includes("hello")) &&
      frames.some((chunk) => chunk.includes("[exit 0]")),
    );

    unsubscribe();
    await adapter.shutdown?.();
  });

  test("handles MCP elicitation and dynamic client tool server requests", async () => {
    const serverJs = path.join(tmpDir, "mock-codex-server-requests.js");
    writeFileSync(
      serverJs,
      `
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
function send(msg) { process.stdout.write(JSON.stringify(msg) + "\\n"); }
let pendingTurnId = null;
let sawMcpResponse = false;
let sawDynamicResponse = false;
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') {
    send({ id: msg.id, result: {} });
    return;
  }
  if (msg.method === 'thread/start') {
    send({ id: msg.id, result: { thread: { id: 'thread-live-requests-1' } } });
    return;
  }
  if (msg.method === 'turn/start') {
    pendingTurnId = 'turn-live-requests-1';
    send({ id: msg.id, result: { turn: { id: pendingTurnId } } });
    setTimeout(() => send({ method: 'turn/started', params: { turn: { id: pendingTurnId } } }), 5);
    setTimeout(() => send({
      id: 9100,
      method: 'mcpServer/elicitation/request',
      params: {
        threadId: 'thread-live-requests-1',
        turnId: pendingTurnId,
        serverName: 'demo-mcp',
        mode: 'form',
        message: 'Choose a value',
        requestedSchema: {
          type: 'object',
          properties: {},
        },
      },
    }), 10);
    return;
  }
  if (msg.id === 9100) {
    sawMcpResponse = msg.result?.action === 'accept';
    send({
      id: 9101,
      method: 'item/tool/call',
      params: {
        threadId: 'thread-live-requests-1',
        turnId: pendingTurnId,
        callId: 'dynamic-1',
        tool: 'client_demo_tool',
        arguments: { value: 1 },
      },
    });
    return;
  }
  if (msg.id === 9101) {
    sawDynamicResponse = msg.result?.success === false;
    send({ method: 'item/agentMessage/delta', params: { itemId: 'assistant-requests-1', delta: 'responses ' + sawMcpResponse + ' ' + sawDynamicResponse } });
    send({ method: 'turn/completed', params: { turn: { id: pendingTurnId, status: 'completed' } } });
    return;
  }
  send({ id: msg.id, result: {} });
});
`,
    );
    const wrapper = path.join(tmpDir, "mock-codex-requests");
    writeFileSync(
      wrapper,
      `#!/bin/sh\nexec node "${serverJs}" "$@"\n`,
    );
    chmodSync(wrapper, 0o755);
    process.env.RAH_CODEX_BINARY = wrapper;

    const services = {
      eventBus: new EventBus(),
      ptyHub: new PtyHub(),
      sessionStore: new SessionStore(),
    };
    const adapter = new CodexAdapter(services);

    const started = await adapter.startSession({
      provider: "codex",
      cwd: tmpDir,
      title: "server request test",
      attach: {
        client: {
          id: "test-client",
          kind: "web",
          connectionId: "test-client",
        },
        mode: "interactive",
        claimControl: true,
      },
    });

    adapter.sendInput(started.session.session.id, {
      clientId: "test-client",
      text: "Trigger server requests",
    });

    await waitFor(() =>
      services.eventBus.list({ sessionIds: [started.session.session.id] }).some(
        (event) =>
          event.type === "permission.requested" &&
          event.payload.request.id === "permission-mcp-9100",
      ),
    );

    await adapter.respondToPermission?.(started.session.session.id, "permission-mcp-9100", {
      behavior: "allow",
      answers: {
        value: { answers: ["yes"] },
      },
    });

    await waitFor(() =>
      services.eventBus.list({ sessionIds: [started.session.session.id] }).some(
        (event) =>
          event.type === "timeline.item.added" &&
          event.payload.item.kind === "assistant_message" &&
          event.payload.item.text.includes("responses true true"),
      ),
    );

    const events = services.eventBus.list({ sessionIds: [started.session.session.id] });
    assert.ok(events.some((event) => event.type === "operation.requested"));
    assert.ok(events.some((event) => event.type === "tool.call.failed"));
    assert.ok(events.some((event) => event.type === "permission.resolved"));

    await adapter.shutdown?.();
  });
});

import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { CodexAdapter } from "./codex-adapter";
import { DebugAdapter } from "./debug-adapter";
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

describe("CodexAdapter", () => {
  let tmpHome: string;
  let previousCodexHome: string | undefined;
  let previousBinary: string | undefined;

  beforeEach(() => {
    previousCodexHome = process.env.CODEX_HOME;
    previousBinary = process.env.RAH_CODEX_BINARY;
    tmpHome = mkdtempSync(path.join(os.tmpdir(), "rah-codex-home-"));
    process.env.CODEX_HOME = tmpHome;
  });

  afterEach(() => {
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    if (previousBinary === undefined) {
      delete process.env.RAH_CODEX_BINARY;
    } else {
      process.env.RAH_CODEX_BINARY = previousBinary;
    }
    rmSync(tmpHome, { recursive: true, force: true });
  });

  function writeRollout(sessionId: string, cwd: string): string {
    const dir = path.join(tmpHome, "sessions", "2026", "04", "15");
    mkdirSync(dir, { recursive: true });
    const rolloutPath = path.join(
      dir,
      `rollout-2026-04-15T00-00-00-${sessionId}.jsonl`,
    );
    return writeRolloutLines(rolloutPath, [
      JSON.stringify({
        timestamp: "2026-04-15T00:00:00.000Z",
        type: "session_meta",
        payload: {
          id: sessionId,
          timestamp: "2026-04-15T00:00:00.000Z",
          cwd,
          source: "cli",
        },
      }),
      JSON.stringify({
        timestamp: "2026-04-15T00:00:01.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Fix the resume bug" }],
        },
      }),
      JSON.stringify({
        timestamp: "2026-04-15T00:00:02.000Z",
        type: "event_msg",
        payload: {
          type: "agent_reasoning",
          text: "Inspecting rollout state.",
        },
      }),
      JSON.stringify({
        timestamp: "2026-04-15T00:00:03.000Z",
        type: "response_item",
        payload: {
          type: "function_call",
          name: "exec_command",
          arguments: '{"cmd":"echo hello","workdir":"%CWD%"}'.replace("%CWD%", cwd),
          call_id: "call-1",
        },
      }),
      JSON.stringify({
        timestamp: "2026-04-15T00:00:04.000Z",
        type: "response_item",
        payload: {
          type: "function_call_output",
          call_id: "call-1",
          output: "Chunk ID: abc\nWall time: 0.1 seconds\nProcess exited with code 0\nOutput:\nhello",
        },
      }),
    ]);
  }

  function writeRolloutLines(rolloutPath: string, lines: string[]): string {
    writeFileSync(rolloutPath, lines.join("\n") + "\n");
    return rolloutPath;
  }

  function writeMockCodexServer(source: string): string {
    const serverJs = path.join(tmpHome, "mock-codex-server.js");
    const wrapper = path.join(tmpHome, "mock-codex");
    writeFileSync(serverJs, source);
    writeFileSync(wrapper, `#!/bin/sh\nexec node "${serverJs}" "$@"\n`);
    chmodSync(wrapper, 0o755);
    process.env.RAH_CODEX_BINARY = wrapper;
    return wrapper;
  }

  test("falls back to stored rollout replay when thread/resume is unavailable", async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), "rah-codex-cwd-"));
    const sessionId = "019d9999-aaaa-7bbb-8ccc-ddddeeeeffff";
    writeRollout(sessionId, cwd);
    writeMockCodexServer(`
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
function send(msg) { process.stdout.write(JSON.stringify(msg) + "\\n"); }
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') {
    send({ id: msg.id, result: {} });
    return;
  }
  if (msg.method === 'thread/resume') {
    send({ id: msg.id, error: { message: 'resume unsupported in mock' } });
    return;
  }
  send({ id: msg.id, result: {} });
});
`);

    const services = {
      eventBus: new EventBus(),
      ptyHub: new PtyHub(),
      sessionStore: new SessionStore(),
    };
    const debugAdapter = new DebugAdapter(services);
    void debugAdapter;
    const adapter = new CodexAdapter(services);

    const stored = adapter.listStoredSessions();
    assert.equal(stored.length, 1);
    assert.equal(stored[0]?.providerSessionId, sessionId);
    assert.equal(stored[0]?.cwd, cwd);
    assert.equal(stored[0]?.preview, "Fix the resume bug");

    const resumed = await adapter.resumeSession({
      provider: "codex",
      providerSessionId: sessionId,
    });
    assert.equal(resumed.session.session.providerSessionId, sessionId);
    assert.equal(resumed.session.session.cwd, cwd);
    assert.equal(resumed.session.session.capabilities.steerInput, false);
    assert.equal(resumed.session.session.capabilities.livePermissions, false);
    assert.equal(resumed.session.session.capabilities.resumeByProvider, true);
    assert.equal(resumed.session.session.capabilities.listProviderSessions, true);
    assert.equal(resumed.session.session.capabilities.queuedInput, false);
    assert.equal(resumed.session.session.capabilities.modelSwitch, false);
    assert.equal(resumed.session.session.capabilities.planMode, false);
    assert.equal(resumed.session.session.capabilities.subagents, false);

    assert.equal(
      services.eventBus
        .list({ sessionIds: [resumed.session.session.id] })
        .filter((event) => event.type === "timeline.item.added").length,
      0,
    );
    const page = adapter.getSessionHistoryPage(resumed.session.session.id, { limit: 20 });
    assert.ok(page.events.some((event) => event.type === "timeline.item.added"));
    assert.ok(page.events.some((event) => event.type === "tool.call.started"));
    assert.ok(page.events.some((event) => event.type === "tool.call.completed"));

    assert.throws(
      () =>
        adapter.sendInput(resumed.session.session.id, {
          clientId: "web-client",
          text: "Continue",
        }),
      /read-only/,
    );

    rmSync(cwd, { recursive: true, force: true });
  });

  test("opens stored Codex history immediately when preferStoredReplay is requested", async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), "rah-codex-prefer-stored-cwd-"));
    const sessionId = "019d9999-stored-7bbb-8ccc-ddddeeeeffff";
    writeRollout(sessionId, cwd);

    const services = {
      eventBus: new EventBus(),
      ptyHub: new PtyHub(),
      sessionStore: new SessionStore(),
    };
    const adapter = new CodexAdapter(services);

    const resumed = await adapter.resumeSession({
      provider: "codex",
      providerSessionId: sessionId,
      preferStoredReplay: true,
    });

    assert.equal(resumed.session.session.providerSessionId, sessionId);
    assert.equal(resumed.session.session.capabilities.steerInput, false);
    assert.equal(resumed.session.session.capabilities.livePermissions, false);
    assert.equal(
      services.eventBus
        .list({ sessionIds: [resumed.session.session.id] })
        .filter((event) => event.type === "timeline.item.added").length,
      0,
    );

    rmSync(cwd, { recursive: true, force: true });
  });

  test("preferStoredReplay rejects missing Codex rollout records before live resume", async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), "rah-codex-missing-stored-cwd-"));
    const services = {
      eventBus: new EventBus(),
      ptyHub: new PtyHub(),
      sessionStore: new SessionStore(),
    };
    const adapter = new CodexAdapter(services);

    await assert.rejects(
      adapter.resumeSession({
        provider: "codex",
        providerSessionId: "019db93e-98c5-7bc0-8d15-a553c1da63f4",
        cwd,
        preferStoredReplay: true,
      }),
      /Unknown Codex session 019db93e-98c5-7bc0-8d15-a553c1da63f4/,
    );

    rmSync(cwd, { recursive: true, force: true });
  });

  test("pages stored Codex history from rollout files", async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), "rah-codex-history-cwd-"));
    const sessionId = "019d7777-cccc-7ddd-8eee-ffff00001111";
    writeRollout(sessionId, cwd);
    writeMockCodexServer(`
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
function send(msg) { process.stdout.write(JSON.stringify(msg) + "\\n"); }
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') {
    send({ id: msg.id, result: {} });
    return;
  }
  if (msg.method === 'thread/resume') {
    send({ id: msg.id, error: { message: 'resume unsupported in mock' } });
    return;
  }
  send({ id: msg.id, result: {} });
});
`);

    const services = {
      eventBus: new EventBus(),
      ptyHub: new PtyHub(),
      sessionStore: new SessionStore(),
    };
    const debugAdapter = new DebugAdapter(services);
    void debugAdapter;
    const adapter = new CodexAdapter(services);

    const resumed = await adapter.resumeSession({
      provider: "codex",
      providerSessionId: sessionId,
    });

    const firstPage = adapter.getSessionHistoryPage(resumed.session.session.id, { limit: 3 });
    assert.equal(firstPage.sessionId, resumed.session.session.id);
    assert.equal(firstPage.events.length, 3);
    assert.ok(firstPage.nextBeforeTs);
    assert.ok(firstPage.events[0]!.ts <= firstPage.events[1]!.ts);
    assert.ok(firstPage.events[1]!.ts <= firstPage.events[2]!.ts);

    const secondPage = adapter.getSessionHistoryPage(resumed.session.session.id, {
      beforeTs: firstPage.nextBeforeTs,
      limit: 3,
    });
    assert.ok(secondPage.events.length >= 1);
    assert.ok(
      secondPage.events.every((event) => event.ts < (firstPage.nextBeforeTs as string)),
    );

    rmSync(cwd, { recursive: true, force: true });
  });

  test("collapses duplicate assistant history and ignores persisted noise", async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), "rah-codex-history-clean-cwd-"));
    const sessionId = "019d7777-clean-7ddd-8eee-ffff00001111";
    const dir = path.join(tmpHome, "sessions", "2026", "04", "15");
    mkdirSync(dir, { recursive: true });
    const rolloutPath = path.join(dir, `rollout-2026-04-15T01-00-00-${sessionId}.jsonl`);
    writeRolloutLines(rolloutPath, [
      JSON.stringify({
        timestamp: "2026-04-15T01:00:00.000Z",
        type: "session_meta",
        payload: {
          id: sessionId,
          timestamp: "2026-04-15T01:00:00.000Z",
          cwd,
          source: "cli",
        },
      }),
      JSON.stringify({
        timestamp: "2026-04-15T01:00:01.000Z",
        type: "event_msg",
        payload: { type: "task_started", turn_id: "turn-1" },
      }),
      JSON.stringify({
        timestamp: "2026-04-15T01:00:02.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "developer",
          content: [{ type: "input_text", text: "internal instructions" }],
        },
      }),
      JSON.stringify({
        timestamp: "2026-04-15T01:00:03.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "你是谁" }],
        },
      }),
      JSON.stringify({
        timestamp: "2026-04-15T01:00:04.000Z",
        type: "event_msg",
        payload: { type: "agent_message", message: "我是 Codex" },
      }),
      JSON.stringify({
        timestamp: "2026-04-15T01:00:05.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "我是 Codex" }],
        },
      }),
      JSON.stringify({
        timestamp: "2026-04-15T01:00:06.000Z",
        type: "event_msg",
        payload: { type: "token_count", info: null },
      }),
    ]);
    writeMockCodexServer(`
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
function send(msg) { process.stdout.write(JSON.stringify(msg) + "\\n"); }
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') {
    send({ id: msg.id, result: {} });
    return;
  }
  if (msg.method === 'thread/resume') {
    send({ id: msg.id, error: { message: 'resume unsupported in mock' } });
    return;
  }
  send({ id: msg.id, result: {} });
});
`);

    const services = {
      eventBus: new EventBus(),
      ptyHub: new PtyHub(),
      sessionStore: new SessionStore(),
    };
    const adapter = new CodexAdapter(services);
    const resumed = await adapter.resumeSession({
      provider: "codex",
      providerSessionId: sessionId,
    });

    const page = adapter.getSessionHistoryPage(resumed.session.session.id, { limit: 10 });
    assert.deepEqual(
      page.events.map((event) => ({
        type: event.type,
        kind: (() => {
          switch (event.type) {
            case "timeline.item.added":
              return event.payload.item.kind;
            case "observation.started":
            case "observation.updated":
            case "observation.completed":
            case "observation.failed":
              return event.payload.observation.kind;
            default:
              return undefined;
          }
        })(),
      })),
      [
        { type: "timeline.item.added", kind: "user_message" },
        { type: "timeline.item.added", kind: "assistant_message" },
      ],
    );

    rmSync(cwd, { recursive: true, force: true });
  });

  test("stored session discovery ignores bootstrap prompt when deriving title and preview", async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), "rah-codex-bootstrap-title-cwd-"));
    const sessionId = "019d7777-bootstrap-7ddd-8eee-ffff00001111";
    const dir = path.join(tmpHome, "sessions", "2026", "04", "15");
    mkdirSync(dir, { recursive: true });
    const rolloutPath = path.join(dir, `rollout-2026-04-15T02-00-00-${sessionId}.jsonl`);
    writeRolloutLines(rolloutPath, [
      JSON.stringify({
        timestamp: "2026-04-15T02:00:00.000Z",
        type: "session_meta",
        payload: {
          id: sessionId,
          timestamp: "2026-04-15T02:00:00.000Z",
          cwd,
          source: "cli",
        },
      }),
      JSON.stringify({
        timestamp: "2026-04-15T02:00:01.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [
            {
              type: "input_text",
              text:
                "# AGENTS.md instructions for /workspace/demo\n\n<INSTRUCTIONS>\ninternal\n</INSTRUCTIONS>\n<environment_context>\n  <cwd>/workspace/demo</cwd>\n</environment_context>",
            },
          ],
        },
      }),
      JSON.stringify({
        timestamp: "2026-04-15T02:00:02.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "真正的问题" }],
        },
      }),
    ]);

    const services = {
      eventBus: new EventBus(),
      ptyHub: new PtyHub(),
      sessionStore: new SessionStore(),
    };
    const adapter = new CodexAdapter(services);
    const stored = adapter.listStoredSessions();
    const match = stored.find((item) => item.providerSessionId === sessionId);
    assert.equal(match?.preview, "真正的问题");
    assert.equal(match?.title, "真正的问题");

    rmSync(cwd, { recursive: true, force: true });
  });

  test("rehydrates stored history then attaches to a live external Codex thread", async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), "rah-codex-live-cwd-"));
    const sessionId = "019d8888-bbbb-7ccc-8ddd-eeeeffff0000";
    writeRollout(sessionId, cwd);
    writeMockCodexServer(`
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
let turnId = null;
function send(msg) { process.stdout.write(JSON.stringify(msg) + "\\n"); }
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') {
    send({ id: msg.id, result: {} });
    return;
  }
  if (msg.method === 'thread/resume') {
    send({
      id: msg.id,
      result: {
        thread: {
          id: '${sessionId}',
          cwd: '${cwd}',
          preview: '<environment_context>\\n  <cwd>${cwd}</cwd>\\n</environment_context>',
          name: '<environment_context>\\n  <cwd>${cwd}</cwd>\\n</environment_context>',
          status: { type: 'idle' },
        },
        cwd: '${cwd}',
      },
    });
    return;
  }
  if (msg.method === 'turn/start') {
    turnId = 'turn-live-1';
    send({ id: msg.id, result: { turn: { id: turnId } } });
    setTimeout(() => send({ method: 'turn/started', params: { turn: { id: turnId } } }), 5);
    setTimeout(() => send({
      method: 'item/agentMessage/delta',
      params: { itemId: 'assistant-live-1', delta: 'Live reattach works.' },
    }), 10);
    setTimeout(() => send({ method: 'turn/completed', params: { turn: { id: turnId, status: 'completed' } } }), 15);
    return;
  }
  if (msg.method === 'turn/interrupt') {
    send({ id: msg.id, result: {} });
    return;
  }
  send({ id: msg.id, result: {} });
});
`);

    const services = {
      eventBus: new EventBus(),
      ptyHub: new PtyHub(),
      sessionStore: new SessionStore(),
    };
    const adapter = new CodexAdapter(services);

    const resumed = await adapter.resumeSession({
      provider: "codex",
      providerSessionId: sessionId,
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

    assert.equal(resumed.session.session.providerSessionId, sessionId);
    assert.equal(resumed.session.session.cwd, cwd);
    assert.equal(resumed.session.controlLease.holderClientId, "web-client");
    assert.equal(resumed.session.session.title, "Fix the resume bug");
    assert.equal(resumed.session.session.preview, "Fix the resume bug");
    assert.equal(resumed.session.session.capabilities.steerInput, true);
    assert.equal(resumed.session.session.capabilities.livePermissions, true);
    assert.equal(resumed.session.session.capabilities.resumeByProvider, true);
    assert.equal(resumed.session.session.capabilities.listProviderSessions, true);
    assert.equal(resumed.session.session.capabilities.queuedInput, false);
    assert.equal(resumed.session.session.capabilities.modelSwitch, false);
    assert.equal(resumed.session.session.capabilities.planMode, false);
    assert.equal(resumed.session.session.capabilities.subagents, false);

    const historicalEvents = services.eventBus.list({ sessionIds: [resumed.session.session.id] });
    assert.ok(
      historicalEvents.some(
        (event) =>
          event.type === "timeline.item.added" &&
          event.payload.item.kind === "user_message" &&
          event.payload.item.text.includes("Fix the resume bug"),
      ),
    );

    adapter.sendInput(resumed.session.session.id, {
      clientId: "web-client",
      text: "Continue the work",
    });

    await waitFor(() =>
      services.eventBus.list({ sessionIds: [resumed.session.session.id] }).some(
        (event) =>
          event.type === "timeline.item.added" &&
          event.payload.item.kind === "assistant_message" &&
          event.payload.item.text.includes("Live reattach works"),
      ),
    );

    const events = services.eventBus.list({ sessionIds: [resumed.session.session.id] });
    assert.ok(events.some((event) => event.type === "turn.started"));
    assert.ok(events.some((event) => event.type === "turn.completed"));

    await adapter.shutdown?.();
    rmSync(cwd, { recursive: true, force: true });
  });

  test("attaches to a live external Codex thread without replaying stored history when skipped", async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), "rah-codex-live-skip-cwd-"));
    const sessionId = "019d8888-skip-7ccc-8ddd-eeeeffff0000";
    writeRollout(sessionId, cwd);
    writeMockCodexServer(`
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
let turnId = null;
function send(msg) { process.stdout.write(JSON.stringify(msg) + "\\n"); }
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') {
    send({ id: msg.id, result: {} });
    return;
  }
  if (msg.method === 'thread/resume') {
    send({
      id: msg.id,
      result: {
        thread: {
          id: '${sessionId}',
          cwd: '${cwd}',
          preview: 'Fix the resume bug',
          name: 'External Codex Thread',
          status: { type: 'idle' },
        },
        cwd: '${cwd}',
      },
    });
    return;
  }
  if (msg.method === 'turn/start') {
    turnId = 'turn-live-skip-1';
    send({ id: msg.id, result: { turn: { id: turnId } } });
    setTimeout(() => send({ method: 'turn/started', params: { turn: { id: turnId } } }), 5);
    setTimeout(() => send({
      method: 'item/agentMessage/delta',
      params: { itemId: 'assistant-live-skip-1', delta: 'Only new live output.' },
    }), 10);
    setTimeout(() => send({ method: 'turn/completed', params: { turn: { id: turnId, status: 'completed' } } }), 15);
    return;
  }
  send({ id: msg.id, result: {} });
});
`);

    const services = {
      eventBus: new EventBus(),
      ptyHub: new PtyHub(),
      sessionStore: new SessionStore(),
    };
    const adapter = new CodexAdapter(services);

    const resumed = await adapter.resumeSession({
      provider: "codex",
      providerSessionId: sessionId,
      historyReplay: "skip",
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

    const historicalEvents = services.eventBus.list({ sessionIds: [resumed.session.session.id] });
    assert.ok(
      !historicalEvents.some(
        (event) =>
          event.type === "timeline.item.added" &&
          event.payload.item.kind === "user_message" &&
          event.payload.item.text.includes("Fix the resume bug"),
      ),
    );

    adapter.sendInput(resumed.session.session.id, {
      clientId: "web-client",
      text: "Continue the work",
    });

    await waitFor(() =>
      services.eventBus.list({ sessionIds: [resumed.session.session.id] }).some(
        (event) =>
          event.type === "timeline.item.added" &&
          event.payload.item.kind === "assistant_message" &&
          event.payload.item.text.includes("Only new live output."),
      ),
    );

    await adapter.shutdown?.();
    rmSync(cwd, { recursive: true, force: true });
  });

  test("upgrades a rehydrated replay to live resume without duplicating stored history", async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), "rah-codex-upgrade-live-cwd-"));
    const sessionId = "019d8888-upgrade-7ccc-8ddd-eeeeffff0000";
    writeRollout(sessionId, cwd);
    writeMockCodexServer(`
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
let turnId = null;
function send(msg) { process.stdout.write(JSON.stringify(msg) + "\\n"); }
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') {
    send({ id: msg.id, result: {} });
    return;
  }
  if (msg.method === 'thread/resume') {
    send({
      id: msg.id,
      result: {
        thread: {
          id: '${sessionId}',
          cwd: '${cwd}',
          preview: 'Fix the resume bug',
          name: 'External Codex Thread',
          status: { type: 'idle' },
        },
        cwd: '${cwd}',
      },
    });
    return;
  }
  if (msg.method === 'turn/start') {
    turnId = 'turn-live-upgrade-1';
    send({ id: msg.id, result: { turn: { id: turnId } } });
    setTimeout(() => send({ method: 'turn/started', params: { turn: { id: turnId } } }), 5);
    setTimeout(() => send({
      method: 'item/agentMessage/delta',
      params: { itemId: 'assistant-live-upgrade-1', delta: 'Continue after claim.' },
    }), 10);
    setTimeout(() => send({ method: 'turn/completed', params: { turn: { id: turnId, status: 'completed' } } }), 15);
    return;
  }
  send({ id: msg.id, result: {} });
});
`);

    const services = {
      eventBus: new EventBus(),
      ptyHub: new PtyHub(),
      sessionStore: new SessionStore(),
    };
    const adapter = new CodexAdapter(services);

    const replay = await adapter.resumeSession({
      provider: "codex",
      providerSessionId: sessionId,
      preferStoredReplay: true,
    });
    const replaySessionId = replay.session.session.id;

    const resumed = await adapter.resumeSession({
      provider: "codex",
      providerSessionId: sessionId,
      historyReplay: "skip",
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

    assert.equal(services.sessionStore.getSession(replaySessionId), undefined);
    const sessionClosedEvents = services.eventBus
      .list({ sessionIds: [replaySessionId] })
      .filter((event) => event.type === "session.closed");
    assert.equal(sessionClosedEvents.length, 1);

    const historicalEvents = services.eventBus.list({ sessionIds: [resumed.session.session.id] });
    assert.ok(
      !historicalEvents.some(
        (event) =>
          event.type === "timeline.item.added" &&
          event.payload.item.kind === "user_message" &&
          event.payload.item.text.includes("Fix the resume bug"),
      ),
    );

    adapter.sendInput(resumed.session.session.id, {
      clientId: "web-client",
      text: "Continue the work",
    });

    await waitFor(() =>
      services.eventBus.list({ sessionIds: [resumed.session.session.id] }).some(
        (event) =>
          event.type === "timeline.item.added" &&
          event.payload.item.kind === "assistant_message" &&
          event.payload.item.text.includes("Continue after claim."),
      ),
    );

    await adapter.shutdown?.();
    rmSync(cwd, { recursive: true, force: true });
  });
});

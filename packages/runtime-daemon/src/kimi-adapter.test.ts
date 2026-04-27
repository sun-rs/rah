import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventBus } from "./event-bus";
import { KimiAdapter } from "./kimi-adapter";
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

describe("KimiAdapter", () => {
  let tmpDir: string;
  let previousBinary: string | undefined;

  beforeEach(() => {
    previousBinary = process.env.RAH_KIMI_BINARY;
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "rah-kimi-live-"));
  });

  afterEach(() => {
    if (previousBinary === undefined) {
      delete process.env.RAH_KIMI_BINARY;
    } else {
      process.env.RAH_KIMI_BINARY = previousBinary;
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function createServices() {
    return {
      eventBus: new EventBus(),
      ptyHub: new PtyHub(),
      sessionStore: new SessionStore(),
    };
  }

  function writeMockKimiBinary(mode: "basic" | "approval") {
    const logPath = path.join(tmpDir, "kimi-wire.log");
    const serverJs = path.join(tmpDir, "mock-kimi.js");
    const wrapper = path.join(tmpDir, "mock-kimi");
    writeFileSync(
      serverJs,
      `
const fs = require("node:fs");
const readline = require("node:readline");
const args = process.argv.slice(2);
const logPath = process.env.RAH_KIMI_LOG;
const mode = process.env.RAH_KIMI_MODE || "basic";
const sessionIndex = args.indexOf("--session");
const sessionId = sessionIndex >= 0 ? args[sessionIndex + 1] : "kimi-session";
let pendingPromptId = null;
function log(obj) {
  if (logPath) fs.appendFileSync(logPath, JSON.stringify(obj) + "\\n");
}
function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\\n");
}
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  log(msg);
  if (msg.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        protocol_version: "1.9",
        server: { name: "Kimi Code CLI", version: "1.33.0" },
        capabilities: { supports_question: true }
      }
    });
    return;
  }
  if (msg.method === "prompt") {
    pendingPromptId = msg.id;
    send({ jsonrpc: "2.0", method: "event", params: { type: "TurnBegin", payload: { user_input: msg.params.user_input } } });
    send({ jsonrpc: "2.0", method: "event", params: { type: "StepBegin", payload: { n: 1 } } });
    send({ jsonrpc: "2.0", method: "event", params: { type: "ContentPart", payload: { type: "think", think: "planning" } } });
    if (mode === "approval") {
      send({
        jsonrpc: "2.0",
        method: "request",
        id: "approval-1",
        params: {
          type: "ApprovalRequest",
          payload: {
            id: "approval-1",
            tool_call_id: "tool-1",
            sender: "tool",
            action: "WriteFile",
            description: "write demo file",
            display: []
          }
        }
      });
      return;
    }
    send({
      jsonrpc: "2.0",
      method: "event",
      params: {
        type: "ToolCall",
        payload: {
          id: "tool-1",
          function: { name: "ReadFile", arguments: "{\\"path\\":\\"README.md\\"}" }
        }
      }
    });
    send({
      jsonrpc: "2.0",
      method: "event",
      params: {
        type: "ToolResult",
        payload: {
          tool_call_id: "tool-1",
          return_value: { is_error: false, output: "README", message: "done", display: [] }
        }
      }
    });
    send({
      jsonrpc: "2.0",
      method: "event",
      params: {
        type: "StatusUpdate",
        payload: {
          context_usage: 0.25,
          context_tokens: 1000,
          max_context_tokens: 4000,
          token_usage: { input_other: 100, input_cache_read: 20, output: 30 }
        }
      }
    });
    send({
      jsonrpc: "2.0",
      method: "event",
      params: { type: "ContentPart", payload: { type: "text", text: "done" } }
    });
    send({ jsonrpc: "2.0", method: "event", params: { type: "TurnEnd", payload: {} } });
    send({ jsonrpc: "2.0", id: msg.id, result: { status: "finished" } });
    return;
  }
  if (msg.id === "approval-1" && mode === "approval") {
    send({
      jsonrpc: "2.0",
      method: "event",
      params: { type: "ContentPart", payload: { type: "text", text: "approved path" } }
    });
    send({ jsonrpc: "2.0", id: pendingPromptId, result: { status: "finished" } });
    return;
  }
  if (msg.method === "cancel") {
    send({ jsonrpc: "2.0", id: msg.id, result: { status: "cancelled" } });
    if (pendingPromptId) {
      send({ jsonrpc: "2.0", id: pendingPromptId, result: { status: "cancelled" } });
    }
    return;
  }
  if (msg.method === "set_plan_mode") {
    send({
      jsonrpc: "2.0",
      method: "event",
      params: { type: "StatusUpdate", payload: { plan_mode: Boolean(msg.params && msg.params.enabled) } }
    });
    send({ jsonrpc: "2.0", id: msg.id, result: { status: "ok", plan_mode: Boolean(msg.params && msg.params.enabled) } });
  }
});
`,
    );
    writeFileSync(wrapper, `#!/bin/sh\nexec node "${serverJs}" "$@"\n`);
    chmodSync(wrapper, 0o755);
    process.env.RAH_KIMI_BINARY = wrapper;
    process.env.RAH_KIMI_LOG = logPath;
    process.env.RAH_KIMI_MODE = mode;
    return { logPath };
  }

  test("starts a live Kimi session and streams tool and usage events", async () => {
    writeMockKimiBinary("basic");
    const services = createServices();
    const adapter = new KimiAdapter(services);

    const started = await adapter.startSession({
      provider: "kimi",
      cwd: tmpDir,
      attach: {
        client: { id: "web-1", kind: "web", connectionId: "web-1" },
        mode: "interactive",
        claimControl: true,
      },
    });

    const providerSessionId = started.session.session.providerSessionId;
    assert.ok(typeof providerSessionId === "string");
    assert.equal(started.session.session.capabilities.actions.archive, true);

    adapter.sendInput(started.session.session.id, {
      clientId: "web-1",
      text: "hello",
    });

    await waitFor(
      () => services.sessionStore.getSession(started.session.session.id)?.session.runtimeState === "idle",
      5000,
    );

    const events = services.eventBus.list({ sessionIds: [started.session.session.id] });
    assert.ok(
      events.some(
        (event) =>
          event.type === "timeline.item.added" &&
          event.payload.item.kind === "assistant_message" &&
          event.payload.item.text === "done",
      ),
    );
    assert.ok(
      events.some(
        (event) =>
          event.type === "tool.call.completed" &&
          event.payload.toolCall.providerToolName === "ReadFile",
      ),
    );
    const state = services.sessionStore.getSession(started.session.session.id);
    assert.deepEqual(state?.usage, {
      usedTokens: 1000,
      contextWindow: 4000,
      percentRemaining: 75,
      inputTokens: 100,
      cachedInputTokens: 20,
      outputTokens: 30,
    });
  });

  test("resumed live Kimi sessions can be archived from RAH", async () => {
    writeMockKimiBinary("basic");
    const services = createServices();
    const adapter = new KimiAdapter(services);

    const resumed = await adapter.resumeSession({
      provider: "kimi",
      providerSessionId: "kimi-resume-session",
      cwd: tmpDir,
      preferStoredReplay: false,
      attach: {
        client: { id: "web-1", kind: "web", connectionId: "web-1" },
        mode: "interactive",
        claimControl: true,
      },
    });

    assert.equal(resumed.session.session.capabilities.steerInput, true);
    assert.equal(resumed.session.session.capabilities.actions.archive, true);
  });

  test("switches Kimi plan mode over the wire", async () => {
    const { logPath } = writeMockKimiBinary("basic");
    const services = createServices();
    const adapter = new KimiAdapter(services);

    const started = await adapter.startSession({
      provider: "kimi",
      cwd: tmpDir,
      attach: {
        client: { id: "web-1", kind: "web", connectionId: "web-1" },
        mode: "interactive",
        claimControl: true,
      },
    });

    const updated = await adapter.setSessionMode(started.session.session.id, "plan");
    assert.equal(updated.session.mode?.currentModeId, "plan");
    assert.equal(updated.session.mode?.mutable, true);

    const requests = readFileSync(logPath, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { method?: string; params?: { enabled?: boolean } });
    assert.ok(
      requests.some((entry) => entry.method === "set_plan_mode" && entry.params?.enabled === true),
    );
  });

  test("round-trips Kimi approval requests through permission response", async () => {
    const { logPath } = writeMockKimiBinary("approval");
    const services = createServices();
    const adapter = new KimiAdapter(services);

    const started = await adapter.startSession({
      provider: "kimi",
      cwd: tmpDir,
      attach: {
        client: { id: "web-1", kind: "web", connectionId: "web-1" },
        mode: "interactive",
        claimControl: true,
      },
    });

    adapter.sendInput(started.session.session.id, {
      clientId: "web-1",
      text: "needs approval",
    });

    await waitFor(() =>
      services.eventBus
        .list({ sessionIds: [started.session.session.id] })
        .some((event) => event.type === "permission.requested"),
    );

    await adapter.respondToPermission(started.session.session.id, "approval-1", {
      behavior: "allow",
      selectedActionId: "approve",
      decision: "approved",
    });

    await waitFor(
      () => services.sessionStore.getSession(started.session.session.id)?.session.runtimeState === "idle",
      5000,
    );

    const logLines = readFileSync(logPath, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.ok(
      logLines.some(
        (line) =>
          line.id === "approval-1" &&
          isObject(line.result) &&
          line.result.request_id === "approval-1" &&
          line.result.response === "approve",
      ),
    );
  });
});

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

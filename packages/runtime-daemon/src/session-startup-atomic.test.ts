import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resetDefaultManualProviderModelStoreForTests } from "./manual-provider-models";
import { RuntimeEngine } from "./runtime-engine";

function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() - startedAt >= timeoutMs) {
        reject(new Error("Timed out waiting for atomic Session startup evidence."));
        return;
      }
      setTimeout(poll, 20);
    };
    poll();
  });
}

test(
  "slow live resume of large Codex history atomically owns and delivers its first prompt",
  { timeout: 20_000 },
  async () => {
    const testRoot = mkdtempSync(path.join(os.tmpdir(), "rah-atomic-resume-"));
    const codexHome = path.join(testRoot, "codex-home");
    const rahHome = path.join(testRoot, "rah-home");
    const cwd = path.join(testRoot, "workspace");
    const sessionId = "019d9999-aaaa-7bbb-8ccc-ddddeeeeffab";
    const capturePath = path.join(testRoot, "app-server-rpc.jsonl");
    const mockServerPath = path.join(testRoot, "mock-codex-server.js");
    const mockCodexPath = path.join(testRoot, "mock-codex");
    const previousCodexHome = process.env.CODEX_HOME;
    const previousRahHome = process.env.RAH_HOME;
    const previousCodexBinary = process.env.RAH_CODEX_BINARY;
    const previousTransport = process.env.RAH_CODEX_APP_SERVER_TRANSPORT;
    mkdirSync(cwd, { recursive: true });
    const rolloutDir = path.join(codexHome, "sessions", "2026", "04", "16");
    mkdirSync(rolloutDir, { recursive: true });
    const rolloutPath = path.join(
      rolloutDir,
      `rollout-2026-04-16T00-00-00-${sessionId}.jsonl`,
    );
    const largeHistoryRows = Array.from({ length: 7_500 }, (_, index) =>
      JSON.stringify({
        timestamp: `2026-04-16T00:00:${String(index % 60).padStart(2, "0")}.000Z`,
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [
            {
              type: "output_text",
              text: `large-history-${index}-${"x".repeat(900)}`,
            },
          ],
        },
      }),
    );
    writeFileSync(
      rolloutPath,
      [
        JSON.stringify({
          timestamp: "2026-04-16T00:00:00.000Z",
          type: "session_meta",
          payload: {
            id: sessionId,
            timestamp: "2026-04-16T00:00:00.000Z",
            cwd,
            source: "cli",
          },
        }),
        JSON.stringify({
          timestamp: "2026-04-16T00:00:01.000Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "Original large-session prompt" }],
          },
        }),
        ...largeHistoryRows,
      ].join("\n") + "\n",
    );
    assert.ok(readFileSync(rolloutPath).byteLength > 6_000_000);

    writeFileSync(
      mockServerPath,
      `
const fs = require('node:fs');
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
const capturePath = ${JSON.stringify(capturePath)};
const threadId = ${JSON.stringify(sessionId)};
const cwd = ${JSON.stringify(cwd)};
function send(message) { process.stdout.write(JSON.stringify(message) + "\\n"); }
function capture(message) { fs.appendFileSync(capturePath, JSON.stringify(message) + "\\n"); }
rl.on('line', (line) => {
  const message = JSON.parse(line);
  capture(message);
  if (message.method === 'initialize') {
    send({ id: message.id, result: {} });
    return;
  }
  if (message.method === 'thread/resume') {
    setTimeout(() => send({
      id: message.id,
      result: {
        thread: {
          id: threadId,
          cwd,
          name: 'Large resumable task',
          preview: 'Original large-session prompt',
          status: { type: 'idle' },
        },
        cwd,
      },
    }), 350);
    return;
  }
  if (message.method === 'turn/start') {
    const turnId = 'turn-atomic-resume-1';
    setTimeout(() => send({
      method: 'thread/status/changed',
      params: { threadId, status: { type: 'idle' } },
    }), 25);
    setTimeout(() => {
      send({ id: message.id, result: { turn: { id: turnId } } });
      send({ method: 'turn/started', params: { threadId, turn: { id: turnId } } });
      send({
        method: 'item/agentMessage/delta',
        params: {
          threadId,
          turnId,
          itemId: 'assistant-atomic-resume-1',
          delta: 'Atomic prompt received.',
        },
      });
      send({
        method: 'turn/completed',
        params: { threadId, turn: { id: turnId, status: 'completed' } },
      });
    }, 300);
    return;
  }
  send({ id: message.id, result: {} });
});
`,
    );
    writeFileSync(mockCodexPath, `#!/bin/sh\nexec node "${mockServerPath}" "$@"\n`);
    chmodSync(mockCodexPath, 0o755);

    process.env.CODEX_HOME = codexHome;
    process.env.RAH_HOME = rahHome;
    process.env.RAH_CODEX_BINARY = mockCodexPath;
    process.env.RAH_CODEX_APP_SERVER_TRANSPORT = "stdio";
    resetDefaultManualProviderModelStoreForTests(
      path.join(rahHome, "runtime-daemon"),
    );

    const engine = new RuntimeEngine();
    try {
      const clientMessageId = "client-message:atomic-large-resume";
      const startedAt = Date.now();
      const resuming = engine.resumeSession({
        provider: "codex",
        providerSessionId: sessionId,
        cwd,
        liveBackend: "native_local_server",
        historyReplay: "skip",
        initialInput: {
          clientId: "web-client",
          clientMessageId,
          clientTurnId: "client-turn:atomic-large-resume",
          text: "请继续这个大 Session",
        },
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
      await waitFor(() => {
        const pending = engine
          .listSessions()
          .sessions.find(
            (entry) => entry.session.providerSessionId === sessionId,
          );
        return (
          pending?.session.runtimeState === "starting" &&
          pending.session.inputQueue?.[0]?.clientMessageId === clientMessageId &&
          pending.session.inputQueue?.[0]?.state === "submitting"
        );
      });
      const pendingRefresh = engine
        .listSessions()
        .sessions.find((entry) => entry.session.providerSessionId === sessionId);
      assert.equal(pendingRefresh?.session.inputQueue?.[0]?.text, "请继续这个大 Session");

      const resumed = await resuming;
      const runtimeSessionId = resumed.session.session.id;
      assert.ok(
        Date.now() - startedAt >= 600,
        "resume must await Codex turn acceptance, not only thread rehydration",
      );
      assert.ok(
        ["starting", "running", "idle"].includes(
          resumed.session.session.runtimeState,
        ),
        `unexpected post-acceptance state ${resumed.session.session.runtimeState}`,
      );
      assert.equal(resumed.session.session.inputQueue?.length ?? 0, 0);
      assert.ok(
        engine.eventBus.list({ sessionIds: [runtimeSessionId] }).some(
          (event) =>
            event.type === "runtime.status" && event.payload.status === "thinking",
        ),
      );

      await waitFor(() => {
        if (!existsSync(capturePath)) return false;
        return readFileSync(capturePath, "utf8")
          .split(/\r?\n/)
          .filter(Boolean)
          .map((line) => JSON.parse(line) as Record<string, unknown>)
          .some((message) => {
            if (message.method !== "turn/start") return false;
            const params = message.params as Record<string, unknown>;
            return (
              params.clientUserMessageId === clientMessageId &&
              JSON.stringify(params.input).includes("请继续这个大 Session")
            );
          });
      });
      await waitFor(() => {
        const events = engine.eventBus.list({ sessionIds: [runtimeSessionId] });
        const hasUserPrompt = events.some(
          (event) =>
            event.type === "timeline.item.added" &&
            event.payload.item.kind === "user_message" &&
            event.payload.item.text.includes("请继续这个大 Session"),
        );
        const hasAssistantOutput = events.some(
          (event) =>
            event.type === "timeline.item.added" &&
            event.payload.item.kind === "assistant_message" &&
            event.payload.item.text.includes("Atomic prompt received"),
        );
        return hasUserPrompt && hasAssistantOutput;
      });
      assert.equal(
        engine.getSessionSummary(runtimeSessionId).session.inputQueue?.length ?? 0,
        0,
      );
    } finally {
      await engine.shutdown();
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
      if (previousRahHome === undefined) delete process.env.RAH_HOME;
      else process.env.RAH_HOME = previousRahHome;
      if (previousCodexBinary === undefined) delete process.env.RAH_CODEX_BINARY;
      else process.env.RAH_CODEX_BINARY = previousCodexBinary;
      if (previousTransport === undefined) delete process.env.RAH_CODEX_APP_SERVER_TRANSPORT;
      else process.env.RAH_CODEX_APP_SERVER_TRANSPORT = previousTransport;
      resetDefaultManualProviderModelStoreForTests();
      rmSync(testRoot, { recursive: true, force: true });
    }
  },
);

test(
  "slow new Codex startup atomically owns and delivers its first prompt",
  { timeout: 20_000 },
  async () => {
    const testRoot = mkdtempSync(path.join(os.tmpdir(), "rah-atomic-start-"));
    const codexHome = path.join(testRoot, "codex-home");
    const rahHome = path.join(testRoot, "rah-home");
    const cwd = path.join(testRoot, "workspace");
    const providerSessionId = "019d9999-aaaa-7bbb-8ccc-ddddeeeeffac";
    const capturePath = path.join(testRoot, "app-server-rpc.jsonl");
    const mockServerPath = path.join(testRoot, "mock-codex-server.js");
    const mockCodexPath = path.join(testRoot, "mock-codex");
    const previousCodexHome = process.env.CODEX_HOME;
    const previousRahHome = process.env.RAH_HOME;
    const previousCodexBinary = process.env.RAH_CODEX_BINARY;
    const previousTransport = process.env.RAH_CODEX_APP_SERVER_TRANSPORT;
    mkdirSync(cwd, { recursive: true });

    writeFileSync(
      mockServerPath,
      `
const fs = require('node:fs');
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
const capturePath = ${JSON.stringify(capturePath)};
const threadId = ${JSON.stringify(providerSessionId)};
const cwd = ${JSON.stringify(cwd)};
function send(message) { process.stdout.write(JSON.stringify(message) + "\\n"); }
function capture(message) { fs.appendFileSync(capturePath, JSON.stringify(message) + "\\n"); }
rl.on('line', (line) => {
  const message = JSON.parse(line);
  capture(message);
  if (message.method === 'initialize') {
    send({ id: message.id, result: {} });
    return;
  }
  if (message.method === 'thread/start') {
    setTimeout(() => send({
      id: message.id,
      result: {
        thread: { id: threadId, cwd, status: { type: 'idle' } },
        model: 'gpt-test',
        reasoningEffort: 'medium',
      },
    }), 350);
    return;
  }
  if (message.method === 'turn/start') {
    const turnId = 'turn-atomic-start-1';
    setTimeout(() => send({
      method: 'thread/status/changed',
      params: { threadId, status: { type: 'idle' } },
    }), 25);
    setTimeout(() => {
      send({ id: message.id, result: { turn: { id: turnId } } });
      send({ method: 'turn/started', params: { threadId, turn: { id: turnId } } });
      send({
        method: 'item/agentMessage/delta',
        params: {
          threadId,
          turnId,
          itemId: 'assistant-atomic-start-1',
          delta: 'Atomic new prompt received.',
        },
      });
      send({
        method: 'turn/completed',
        params: { threadId, turn: { id: turnId, status: 'completed' } },
      });
    }, 300);
    return;
  }
  send({ id: message.id, result: {} });
});
`,
    );
    writeFileSync(mockCodexPath, `#!/bin/sh\nexec node "${mockServerPath}" "$@"\n`);
    chmodSync(mockCodexPath, 0o755);

    process.env.CODEX_HOME = codexHome;
    process.env.RAH_HOME = rahHome;
    process.env.RAH_CODEX_BINARY = mockCodexPath;
    process.env.RAH_CODEX_APP_SERVER_TRANSPORT = "stdio";
    resetDefaultManualProviderModelStoreForTests(
      path.join(rahHome, "runtime-daemon"),
    );

    const engine = new RuntimeEngine();
    try {
      const startedAt = Date.now();
      let generatedClientMessageId: string | undefined;
      const starting = engine.startSession({
        provider: "codex",
        cwd,
        model: "gpt-test",
        initialInput: {
          clientId: "web-client",
          clientTurnId: "client-turn:atomic-new",
          text: "这是新的第一条问题",
        },
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
      await waitFor(() => {
        const pending = engine
          .listSessions()
          .sessions.find((entry) => entry.session.cwd === cwd);
        const pendingInput = pending?.session.inputQueue?.[0];
        const ready = (
          pending?.session.runtimeState === "starting" &&
          pendingInput?.text === "这是新的第一条问题" &&
          pendingInput.state === "submitting"
        );
        if (ready && pendingInput) generatedClientMessageId = pendingInput.clientMessageId;
        return ready;
      });
      assert.ok(
        generatedClientMessageId,
        "daemon must generate a startup correlation id for compatibility callers",
      );
      const pendingRefresh = engine
        .listSessions()
        .sessions.find((entry) => entry.session.cwd === cwd);
      assert.equal(pendingRefresh?.session.inputQueue?.[0]?.text, "这是新的第一条问题");

      const started = await starting;
      const runtimeSessionId = started.session.session.id;
      assert.ok(
        Date.now() - startedAt >= 600,
        "start must await first-turn acceptance, not only thread creation",
      );
      assert.ok(
        ["starting", "running", "idle"].includes(
          started.session.session.runtimeState,
        ),
        `unexpected post-acceptance state ${started.session.session.runtimeState}`,
      );
      assert.equal(started.session.session.inputQueue?.length ?? 0, 0);
      assert.ok(
        engine.eventBus.list({ sessionIds: [runtimeSessionId] }).some(
          (event) =>
            event.type === "runtime.status" && event.payload.status === "thinking",
        ),
      );

      await waitFor(() => {
        if (!existsSync(capturePath)) return false;
        return readFileSync(capturePath, "utf8")
          .split(/\r?\n/)
          .filter(Boolean)
          .map((line) => JSON.parse(line) as Record<string, unknown>)
          .some((message) => {
            if (message.method !== "turn/start") return false;
            const params = message.params as Record<string, unknown>;
            return (
              params.clientUserMessageId === generatedClientMessageId &&
              JSON.stringify(params.input).includes("这是新的第一条问题")
            );
          });
      });
      await waitFor(() => {
        const events = engine.eventBus.list({ sessionIds: [runtimeSessionId] });
        const hasUserPrompt = events.some(
          (event) =>
            event.type === "timeline.item.added" &&
            event.payload.item.kind === "user_message" &&
            event.payload.item.text.includes("这是新的第一条问题"),
        );
        const hasAssistantOutput = events.some(
          (event) =>
            event.type === "timeline.item.added" &&
            event.payload.item.kind === "assistant_message" &&
            event.payload.item.text.includes("Atomic new prompt received"),
        );
        return hasUserPrompt && hasAssistantOutput;
      });
      assert.equal(
        engine.getSessionSummary(runtimeSessionId).session.inputQueue?.length ?? 0,
        0,
      );
    } finally {
      await engine.shutdown();
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
      if (previousRahHome === undefined) delete process.env.RAH_HOME;
      else process.env.RAH_HOME = previousRahHome;
      if (previousCodexBinary === undefined) delete process.env.RAH_CODEX_BINARY;
      else process.env.RAH_CODEX_BINARY = previousCodexBinary;
      if (previousTransport === undefined) delete process.env.RAH_CODEX_APP_SERVER_TRANSPORT;
      else process.env.RAH_CODEX_APP_SERVER_TRANSPORT = previousTransport;
      resetDefaultManualProviderModelStoreForTests();
      rmSync(testRoot, { recursive: true, force: true });
    }
  },
);

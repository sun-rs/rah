import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { EventBus } from "./event-bus";
import { GeminiAdapter } from "./gemini-adapter";
import { loadCachedGeminiHistoryManifest } from "./gemini-history-cache";
import { createGeminiStoredSessionFrozenHistoryPageLoader } from "./gemini-session-files";
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

function getProjectHash(projectRoot: string): string {
  return createHash("sha256").update(projectRoot).digest("hex");
}

describe("GeminiAdapter", () => {
  let tmpHome: string;
  let previousGeminiHome: string | undefined;
  let previousBinary: string | undefined;
  let cwd: string;

  beforeEach(() => {
    previousGeminiHome = process.env.GEMINI_CLI_HOME;
    previousBinary = process.env.RAH_GEMINI_BINARY;
    tmpHome = mkdtempSync(path.join(os.tmpdir(), "rah-gemini-home-"));
    cwd = mkdtempSync(path.join(os.tmpdir(), "rah-gemini-cwd-"));
    process.env.GEMINI_CLI_HOME = tmpHome;
  });

  afterEach(() => {
    if (previousGeminiHome === undefined) {
      delete process.env.GEMINI_CLI_HOME;
    } else {
      process.env.GEMINI_CLI_HOME = previousGeminiHome;
    }
    if (previousBinary === undefined) {
      delete process.env.RAH_GEMINI_BINARY;
    } else {
      process.env.RAH_GEMINI_BINARY = previousBinary;
    }
    rmSync(tmpHome, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });

  function createServices() {
    return {
      eventBus: new EventBus(),
      ptyHub: new PtyHub(),
      sessionStore: new SessionStore(),
    };
  }

  function writeMockGeminiBinary() {
    const logPath = path.join(tmpHome, "gemini-args.log");
    const serverJs = path.join(tmpHome, "mock-gemini.js");
    const wrapper = path.join(tmpHome, "mock-gemini");
    writeFileSync(
      serverJs,
      `
const fs = require("node:fs");
const args = process.argv.slice(2);
const logPath = process.env.RAH_GEMINI_ARGS_LOG;
if (logPath) {
  fs.appendFileSync(logPath, JSON.stringify(args) + "\\n");
}
const promptIndex = args.indexOf("--prompt");
const prompt = promptIndex >= 0 ? args[promptIndex + 1] : "";
const resumeIndex = args.indexOf("--resume");
const resume = resumeIndex >= 0 ? args[resumeIndex + 1] : null;
const modelIndex = args.indexOf("--model");
const model = modelIndex >= 0 ? args[modelIndex + 1] : "gemini-2.5-pro";
const sessionId = resume || "gemini-session-1";
function emit(event) {
  process.stdout.write(JSON.stringify(event) + "\\n");
}
emit({ type: "init", timestamp: new Date().toISOString(), session_id: sessionId, model });
emit({ type: "message", timestamp: new Date().toISOString(), role: "assistant", content: "Gemini: " + prompt.slice(0, 8), delta: true });
emit({ type: "tool_use", timestamp: new Date().toISOString(), tool_name: "read_file", tool_id: "tool-1", parameters: { path: "README.md" } });
emit({ type: "tool_result", timestamp: new Date().toISOString(), tool_id: "tool-1", status: "success", output: "file contents" });
emit({ type: "result", timestamp: new Date().toISOString(), status: "success", stats: { total_tokens: 42, input_tokens: 30, output_tokens: 12, cached: 5 } });
`,
    );
    writeFileSync(wrapper, `#!/bin/sh\nexec node "${serverJs}" "$@"\n`);
    chmodSync(wrapper, 0o755);
    process.env.RAH_GEMINI_BINARY = wrapper;
    process.env.RAH_GEMINI_ARGS_LOG = logPath;
    return { wrapper, logPath };
  }

  function writeGeminiSessionFile(sessionId: string) {
    const chatsDir = path.join(tmpHome, "tmp", getProjectHash(cwd), "chats");
    mkdirSync(chatsDir, { recursive: true });
    const filePath = path.join(chatsDir, `session-2026-01-01T00-00-00-${sessionId.slice(0, 8)}.jsonl`);
    writeFileSync(
      filePath,
      [
        JSON.stringify({
          sessionId,
          projectHash: getProjectHash(cwd),
          startTime: "2026-01-01T00:00:00.000Z",
          lastUpdated: "2026-01-01T00:00:05.000Z",
        }),
        JSON.stringify({
          id: "msg-user-1",
          timestamp: "2026-01-01T00:00:01.000Z",
          type: "user",
          content: [{ text: "Explain this repo" }],
        }),
        JSON.stringify({
          id: "msg-gemini-1",
          timestamp: "2026-01-01T00:00:02.000Z",
          type: "gemini",
          content: [{ text: "This repo provides a CLI." }],
          toolCalls: [
            {
              id: "tool-1",
              name: "read_file",
              args: { path: "README.md" },
              result: [{ text: "README contents" }],
              status: "success",
            },
          ],
        }),
        JSON.stringify({
          id: "msg-gemini-warning-1",
          timestamp: "2026-01-01T00:00:03.000Z",
          type: "warning",
          content: [{ text: "Rate limit almost reached." }],
        }),
        JSON.stringify({
          id: "msg-gemini-2",
          timestamp: "2026-01-01T00:00:04.000Z",
          type: "gemini",
          content: [{ text: "The write failed." }],
          toolCalls: [
            {
              id: "tool-2",
              name: "write_file",
              args: { path: "README.md" },
              result: [{ text: "Permission denied" }],
              status: "error",
            },
          ],
        }),
      ].join("\n") + "\n",
    );
  }

  test("binds provider session id from init and resumes later turns with --resume", async () => {
    const { logPath } = writeMockGeminiBinary();
    const services = createServices();
    const adapter = new GeminiAdapter(services);

    const started = await adapter.startSession({
      provider: "gemini",
      cwd,
      attach: {
        client: {
          id: "web-1",
          kind: "web",
          connectionId: "web-1",
        },
        mode: "interactive",
        claimControl: true,
      },
    });

    adapter.sendInput(started.session.session.id, {
      clientId: "web-1",
      text: "first prompt",
    });

    await waitFor(() => {
      const state = services.sessionStore.getSession(started.session.session.id);
      return state?.session.providerSessionId === "gemini-session-1";
    });
    await waitFor(
      () => services.sessionStore.getSession(started.session.session.id)?.session.runtimeState === "idle",
    );

    adapter.sendInput(started.session.session.id, {
      clientId: "web-1",
      text: "second prompt",
    });

    await waitFor(
      () =>
        readFileSync(logPath, "utf8")
          .split(/\r?\n/)
          .filter(Boolean).length === 2,
    );

    const argsLog = readFileSync(logPath, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as string[]);
    assert.equal(argsLog.length, 2);
    assert.ok(!argsLog[0]?.includes("--resume"));
    assert.ok(argsLog[1]?.includes("--resume"));
    assert.ok(argsLog[1]?.includes("gemini-session-1"));

    const state = services.sessionStore.getSession(started.session.session.id);
    assert.equal(state?.session.providerSessionId, "gemini-session-1");
    assert.deepEqual(state?.usage, {
      usedTokens: 42,
      inputTokens: 30,
      cachedInputTokens: 5,
      outputTokens: 12,
    });
  });

  test("discovers stored sessions and rehydrates replay history", async () => {
    writeGeminiSessionFile("gemini-session-2");
    const services = createServices();
    const adapter = new GeminiAdapter(services);

    const stored = adapter.listStoredSessions();
    assert.equal(stored.length, 1);
    assert.equal(stored[0]?.providerSessionId, "gemini-session-2");

    const resumed = await adapter.resumeSession({
      provider: "gemini",
      providerSessionId: "gemini-session-2",
      cwd,
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

    assert.equal(resumed.session.session.capabilities.steerInput, false);
    assert.equal(resumed.session.session.capabilities.livePermissions, false);
    assert.equal(
      services.eventBus
        .list({ sessionIds: [resumed.session.session.id] })
        .filter((event) => event.type === "timeline.item.added").length,
      0,
    );

    const page = adapter.getSessionHistoryPage(resumed.session.session.id, { limit: 20 });
    assert.ok(
      page.events.some(
        (event) =>
          event.type === "timeline.item.added" &&
          event.payload.item.kind === "user_message" &&
          event.payload.item.text === "Explain this repo",
      ),
    );
    assert.ok(
      page.events.some(
        (event) =>
          event.type === "timeline.item.added" &&
          event.payload.item.kind === "assistant_message" &&
          event.payload.item.text === "This repo provides a CLI.",
      ),
    );
    assert.ok(
      page.events.some(
        (event) =>
          event.type === "tool.call.completed" &&
          event.payload.toolCall.providerToolName === "read_file",
      ),
    );
    assert.ok(
      page.events.some(
        (event) =>
          event.type === "tool.call.failed" &&
          event.payload.toolCallId === "tool-2" &&
          event.payload.error.includes("Permission denied"),
      ),
    );
    assert.ok(
      page.events.some(
        (event) =>
          event.type === "timeline.item.added" &&
          event.payload.item.kind === "system" &&
          event.payload.item.text === "Rate limit almost reached.",
      ),
    );
  });

  test("upgrades a rehydrated Gemini replay to live resume without changing provider session id", async () => {
    writeMockGeminiBinary();
    writeGeminiSessionFile("gemini-session-3");
    const services = createServices();
    const adapter = new GeminiAdapter(services);

    const replay = await adapter.resumeSession({
      provider: "gemini",
      providerSessionId: "gemini-session-3",
      cwd,
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

    assert.equal(replay.session.session.capabilities.steerInput, false);

    const resumed = await adapter.resumeSession({
      provider: "gemini",
      providerSessionId: "gemini-session-3",
      cwd,
      preferStoredReplay: false,
      historyReplay: "skip",
      attach: {
        client: {
          id: "web-1",
          kind: "web",
          connectionId: "web-1",
        },
        mode: "interactive",
        claimControl: true,
      },
    });

    assert.equal(resumed.session.session.capabilities.steerInput, true);
    assert.equal(resumed.session.session.providerSessionId, "gemini-session-3");

    const state = services.sessionStore.getSession(resumed.session.session.id);
    assert.equal(state?.controlLease.holderClientId, "web-user");
  });

  test("frozen Gemini history loader keeps browsing anchored after newer messages append", () => {
    const sessionId = "gemini-session-frozen";
    const chatsDir = path.join(tmpHome, "tmp", getProjectHash(cwd), "chats");
    mkdirSync(chatsDir, { recursive: true });
    const filePath = path.join(chatsDir, "session-2026-01-01T00-00-frozen.json");

    const messages = Array.from({ length: 120 }, (_, index) => {
      const n = index + 1;
      const minute = String(Math.floor((index * 2) / 60)).padStart(2, "0");
      const userSecond = String((index * 2) % 60).padStart(2, "0");
      const assistantSecond = String((index * 2 + 1) % 60).padStart(2, "0");
      return [
        {
          id: `msg-user-${n}`,
          timestamp: `2026-01-01T00:${minute}:${userSecond}.000Z`,
          type: "user",
          content: [{ text: `user ${n}` }],
        },
        {
          id: `msg-gemini-${n}`,
          timestamp: `2026-01-01T00:${minute}:${assistantSecond}.000Z`,
          type: "gemini",
          content: [{ text: `assistant ${n}` }],
        },
      ];
    }).flat();

    writeFileSync(
      filePath,
      JSON.stringify({
        sessionId,
        projectHash: getProjectHash(cwd),
        startTime: "2026-01-01T00:00:00.000Z",
        lastUpdated: "2026-01-01T00:59:59.000Z",
        messages,
      }),
    );

    const loader = createGeminiStoredSessionFrozenHistoryPageLoader({
      sessionId: "replay-1",
      record: {
        ref: {
          provider: "gemini",
          providerSessionId: sessionId,
          title: "gemini frozen",
          preview: "gemini frozen",
          updatedAt: "2026-01-01T00:59:59.000Z",
          source: "provider_history",
        },
        filePath,
        conversation: {
          sessionId,
          projectHash: getProjectHash(cwd),
          startTime: "2026-01-01T00:00:00.000Z",
          lastUpdated: "2026-01-01T00:59:59.000Z",
          messages: [],
        },
      },
    });

    const initial = loader.loadInitialPage(2);
    assert.deepEqual(
      initial.events.flatMap((event) => {
        if (
          event.type === "timeline.item.added" &&
          (event.payload.item.kind === "user_message" ||
            event.payload.item.kind === "assistant_message")
        ) {
          return [event.payload.item.text];
        }
        return [];
      }),
      ["user 120", "assistant 120"],
    );
    assert.ok(initial.nextCursor);

    const olderBeforeAppend = loader.loadOlderPage(initial.nextCursor!, 2, initial.boundary);
    const olderBeforeTexts = olderBeforeAppend.events.flatMap((event) => {
      if (
        event.type === "timeline.item.added" &&
        (event.payload.item.kind === "user_message" ||
          event.payload.item.kind === "assistant_message")
      ) {
        return [event.payload.item.text];
      }
      return [];
    });

    writeFileSync(
      filePath,
      JSON.stringify({
        sessionId,
        projectHash: getProjectHash(cwd),
        startTime: "2026-01-01T00:00:00.000Z",
        lastUpdated: "2026-01-01T01:00:01.000Z",
        messages: [
          ...messages,
          {
            id: "msg-user-121",
            timestamp: "2026-01-01T01:00:00.000Z",
            type: "user",
            content: [{ text: "user 121" }],
          },
          {
            id: "msg-gemini-121",
            timestamp: "2026-01-01T01:00:01.000Z",
            type: "gemini",
            content: [{ text: "assistant 121" }],
          },
        ],
      }),
    );

    const older = loader.loadOlderPage(initial.nextCursor!, 2, initial.boundary);
    assert.equal(older.nextCursor ?? null, olderBeforeAppend.nextCursor ?? null);
    assert.equal(older.nextBeforeTs ?? null, olderBeforeAppend.nextBeforeTs ?? null);
    assert.deepEqual(
      older.events.flatMap((event) => {
        if (
          event.type === "timeline.item.added" &&
          (event.payload.item.kind === "user_message" ||
            event.payload.item.kind === "assistant_message")
        ) {
          return [event.payload.item.text];
        }
        return [];
      }),
      olderBeforeTexts,
    );

    const initialAgain = loader.loadInitialPage(2);
    assert.deepEqual(
      initialAgain.events.flatMap((event) => {
        if (
          event.type === "timeline.item.added" &&
          (event.payload.item.kind === "user_message" ||
            event.payload.item.kind === "assistant_message")
        ) {
          return [event.payload.item.text];
        }
        return [];
      }),
      ["user 120", "assistant 120"],
    );
  });

  test("refreshes json-backed Gemini cache incrementally when only new messages append", () => {
    const sessionId = "gemini-session-json-incremental";
    const chatsDir = path.join(tmpHome, "tmp", getProjectHash(cwd), "chats");
    mkdirSync(chatsDir, { recursive: true });
    const filePath = path.join(chatsDir, "session-2026-01-02T00-00-json.json");

    const baseMessages = [
      {
        id: "msg-user-1",
        timestamp: "2026-01-02T00:00:00.000Z",
        type: "user",
        content: [{ text: "user 1" }],
      },
      {
        id: "msg-gemini-1",
        timestamp: "2026-01-02T00:00:01.000Z",
        type: "gemini",
        content: [{ text: "assistant 1" }],
      },
      {
        id: "msg-user-2",
        timestamp: "2026-01-02T00:00:02.000Z",
        type: "user",
        content: [{ text: "user 2" }],
      },
      {
        id: "msg-gemini-2",
        timestamp: "2026-01-02T00:00:03.000Z",
        type: "gemini",
        content: [{ text: "assistant 2" }],
      },
    ];

    writeFileSync(
      filePath,
      JSON.stringify({
        sessionId,
        projectHash: getProjectHash(cwd),
        startTime: "2026-01-02T00:00:00.000Z",
        lastUpdated: "2026-01-02T00:00:03.000Z",
        messages: baseMessages,
      }),
    );

    const initialLoader = createGeminiStoredSessionFrozenHistoryPageLoader({
      sessionId: "replay-json-1",
      record: {
        ref: {
          provider: "gemini",
          providerSessionId: sessionId,
          title: "gemini json incremental",
          preview: "gemini json incremental",
          updatedAt: "2026-01-02T00:00:03.000Z",
          source: "provider_history",
        },
        filePath,
        conversation: {
          sessionId,
          projectHash: getProjectHash(cwd),
          startTime: "2026-01-02T00:00:00.000Z",
          lastUpdated: "2026-01-02T00:00:03.000Z",
          messages: [],
        },
      },
    });
    const initialPage = initialLoader.loadInitialPage(10);
    assert.deepEqual(
      initialPage.events.flatMap((event) => {
        if (
          event.type === "timeline.item.added" &&
          (event.payload.item.kind === "user_message" ||
            event.payload.item.kind === "assistant_message")
        ) {
          return [event.payload.item.text];
        }
        return [];
      }),
      ["user 1", "assistant 1", "user 2", "assistant 2"],
    );

    const initialStats = statSync(filePath);
    const initialManifest = loadCachedGeminiHistoryManifest({
      filePath,
      size: initialStats.size,
      mtimeMs: initialStats.mtimeMs,
    });
    assert.ok(initialManifest);
    assert.equal(initialManifest?.sourceKind, "json");
    assert.equal(initialManifest?.sourceState?.messageCount, 4);

    writeFileSync(
      filePath,
      JSON.stringify({
        sessionId,
        projectHash: getProjectHash(cwd),
        startTime: "2026-01-02T00:00:00.000Z",
        lastUpdated: "2026-01-02T00:00:05.000Z",
        messages: [
          ...baseMessages,
          {
            id: "msg-user-3",
            timestamp: "2026-01-02T00:00:04.000Z",
            type: "user",
            content: [{ text: "user 3" }],
          },
          {
            id: "msg-gemini-3",
            timestamp: "2026-01-02T00:00:05.000Z",
            type: "gemini",
            content: [{ text: "assistant 3" }],
          },
        ],
      }),
    );

    const reopenedLoader = createGeminiStoredSessionFrozenHistoryPageLoader({
      sessionId: "replay-json-2",
      record: {
        ref: {
          provider: "gemini",
          providerSessionId: sessionId,
          title: "gemini json incremental",
          preview: "gemini json incremental",
          updatedAt: "2026-01-02T00:00:05.000Z",
          source: "provider_history",
        },
        filePath,
        conversation: {
          sessionId,
          projectHash: getProjectHash(cwd),
          startTime: "2026-01-02T00:00:00.000Z",
          lastUpdated: "2026-01-02T00:00:05.000Z",
          messages: [],
        },
      },
    });

    const reopenedPage = reopenedLoader.loadInitialPage(2);
    assert.deepEqual(
      reopenedPage.events.flatMap((event) => {
        if (
          event.type === "timeline.item.added" &&
          (event.payload.item.kind === "user_message" ||
            event.payload.item.kind === "assistant_message")
        ) {
          return [event.payload.item.text];
        }
        return [];
      }),
      ["user 3", "assistant 3"],
    );

    const updatedStats = statSync(filePath);
    const updatedManifest = loadCachedGeminiHistoryManifest({
      filePath,
      size: updatedStats.size,
      mtimeMs: updatedStats.mtimeMs,
    });
    assert.ok(updatedManifest);
    assert.equal(updatedManifest?.sourceState?.messageCount, 6);
    assert.equal(updatedManifest?.totalEvents, 6);
  });
});

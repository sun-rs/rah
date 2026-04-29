import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { validateProviderModelCatalog } from "@rah/runtime-protocol";
import { EventBus } from "./event-bus";
import { GeminiAdapter } from "./gemini-adapter";
import { loadCachedGeminiHistoryManifest } from "./gemini-history-cache";
import { isNoisyGeminiCliStderr } from "./gemini-live-client";
import {
  createGeminiStoredSessionFrozenHistoryPageLoader,
  findGeminiStoredSessionRecord,
  isGeminiStoredSessionRecordResumable,
} from "./gemini-session-files";
import { PtyHub } from "./pty-hub";
import { SessionStore } from "./session-store";
import { WorkbenchStateStore } from "./workbench-state";
import { buildSessionsResponse } from "./runtime-session-list";

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
  let tmpRahHome: string;
  let previousGeminiHome: string | undefined;
  let previousRahHome: string | undefined;
  let previousBinary: string | undefined;
  let cwd: string;
  let workbenchStores: WorkbenchStateStore[];

  beforeEach(() => {
    previousGeminiHome = process.env.GEMINI_CLI_HOME;
    previousRahHome = process.env.RAH_HOME;
    previousBinary = process.env.RAH_GEMINI_BINARY;
    tmpHome = mkdtempSync(path.join(os.tmpdir(), "rah-gemini-home-"));
    tmpRahHome = mkdtempSync(path.join(os.tmpdir(), "rah-gemini-rah-home-"));
    cwd = mkdtempSync(path.join(os.tmpdir(), "rah-gemini-cwd-"));
    workbenchStores = [];
    process.env.GEMINI_CLI_HOME = tmpHome;
    process.env.RAH_HOME = tmpRahHome;
  });

  afterEach(async () => {
    await Promise.all(workbenchStores.map((store) => store.flush()));
    if (previousGeminiHome === undefined) {
      delete process.env.GEMINI_CLI_HOME;
    } else {
      process.env.GEMINI_CLI_HOME = previousGeminiHome;
    }
    if (previousRahHome === undefined) {
      delete process.env.RAH_HOME;
    } else {
      process.env.RAH_HOME = previousRahHome;
    }
    if (previousBinary === undefined) {
      delete process.env.RAH_GEMINI_BINARY;
    } else {
      process.env.RAH_GEMINI_BINARY = previousBinary;
    }
    rmSync(tmpHome, { recursive: true, force: true });
    rmSync(tmpRahHome, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });

  function createServices() {
    const workbenchState = new WorkbenchStateStore(path.join(tmpRahHome, "runtime-daemon"));
    workbenchStores.push(workbenchState);
    return {
      eventBus: new EventBus(),
      ptyHub: new PtyHub(),
      sessionStore: new SessionStore(),
      workbenchState,
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
if (logPath && !args.includes("--acp")) {
  fs.appendFileSync(logPath, JSON.stringify(args) + "\\n");
}
if (args.includes("--acp")) {
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    for (const line of chunk.split(/\\r?\\n/).filter(Boolean)) {
      const request = JSON.parse(line);
      if (request.method === "initialize") {
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: 1 } }) + "\\n");
      }
      if (request.method === "session/new") {
        process.stdout.write(JSON.stringify({
          jsonrpc: "2.0",
          id: request.id,
          result: {
            sessionId: "mock-acp-session",
            models: {
              currentModelId: "auto-gemini-3",
              availableModels: [
                { modelId: "auto-gemini-3", name: "Auto (Gemini 3)" },
                { modelId: "gemini-2.5-pro", name: "gemini-2.5-pro" }
              ]
            }
          }
        }) + "\\n");
      }
    }
  });
  return;
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
    const hashDir = path.join(tmpHome, "tmp", getProjectHash(cwd));
    const chatsDir = path.join(hashDir, "chats");
    mkdirSync(hashDir, { recursive: true });
    writeFileSync(path.join(hashDir, ".project_root"), `${cwd}\n`);
    writeFileSync(
      path.join(tmpHome, "projects.json"),
      JSON.stringify({ projects: { [cwd]: path.basename(cwd) } }),
      "utf8",
    );
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
          content: [
            { text: "Explain this repo" },
            { text: "\n--- Content from referenced files ---" },
            { text: "\n# Expanded README contents\n" },
          ],
          displayContent: [{ text: "Explain this repo" }],
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

  function writeGeminiSessionHeaderOnlyFile(sessionId: string) {
    const hashDir = path.join(tmpHome, "tmp", getProjectHash(cwd));
    const chatsDir = path.join(hashDir, "chats");
    mkdirSync(hashDir, { recursive: true });
    writeFileSync(path.join(hashDir, ".project_root"), `${cwd}\n`);
    mkdirSync(chatsDir, { recursive: true });
    writeFileSync(
      path.join(chatsDir, `session-2026-01-01T00-00-00-${sessionId.slice(0, 8)}.jsonl`),
      JSON.stringify({
        sessionId,
        projectHash: getProjectHash(cwd),
        startTime: "2026-01-01T00:00:00.000Z",
        lastUpdated: "2026-01-01T00:00:00.000Z",
        kind: "main",
      }) + "\n",
    );
  }

  function writeLegacyGeminiSessionFile(params: {
    sessionId: string;
    projectHash: string;
    messageText: string;
    existingRoot?: string;
    logsMessage?: string;
  }) {
    const hashDir = path.join(tmpHome, "tmp", params.projectHash);
    const chatsDir = path.join(hashDir, "chats");
    mkdirSync(chatsDir, { recursive: true });
    if (params.existingRoot) {
      mkdirSync(params.existingRoot, { recursive: true });
    }
    writeFileSync(
      path.join(
        chatsDir,
        `session-2026-01-02T00-00-00-${params.sessionId.slice(0, 8)}.json`,
      ),
      JSON.stringify(
        {
          sessionId: params.sessionId,
          projectHash: params.projectHash,
          startTime: "2026-01-02T00:00:00.000Z",
          lastUpdated: "2026-01-02T00:00:05.000Z",
          messages: [
            {
              id: "msg-user-legacy-1",
              timestamp: "2026-01-02T00:00:01.000Z",
              type: "user",
              content: params.messageText,
            },
          ],
        },
        null,
        2,
      ),
      "utf8",
    );
    if (params.logsMessage) {
      writeFileSync(
        path.join(hashDir, "logs.json"),
        JSON.stringify(
          [
            {
              sessionId: params.sessionId,
              messageId: 0,
              type: "user",
              message: params.logsMessage,
              timestamp: "2026-01-02T00:00:00.000Z",
            },
          ],
          null,
          2,
        ),
        "utf8",
      );
    }
  }

  function writeRahWorkbenchState(workspaces: string[]) {
    writeFileSync(
      path.join(tmpRahHome, "workbench-state.json"),
      JSON.stringify(
        {
          version: 1,
          updatedAt: new Date().toISOString(),
          workspaces,
          hiddenWorkspaces: [],
          activeWorkspaceDir: workspaces[0],
          hiddenSessionKeys: [],
          sessions: [],
          recentSessions: [],
        },
        null,
        2,
      ),
      "utf8",
    );
  }

  test("does not treat header-only Gemini session files as resumable", () => {
    writeGeminiSessionHeaderOnlyFile("gemini-empty-session");

    const record = findGeminiStoredSessionRecord("gemini-empty-session", cwd);

    assert.ok(record);
    assert.equal(record.conversation.messages.length, 0);
    assert.equal(isGeminiStoredSessionRecordResumable(record), false);
  });

  test("filters recurring Gemini CLI startup stderr noise", () => {
    assert.equal(
      isNoisyGeminiCliStderr(
        "YOLO mode is enabled. All tool calls will be automatically approved.",
      ),
      true,
    );
    assert.equal(
      isNoisyGeminiCliStderr(
        "[ERROR] [IDEClient] Failed to connect to IDE companion extension. Please ensure the extension is running. To install the extension, run /ide install.",
      ),
      true,
    );
    assert.equal(
      isNoisyGeminiCliStderr(
        "Warning: Basic terminal detected (TERM=dumb). Visual rendering will be limited. For the best experience, use a terminal emulator with truecolor support.",
      ),
      true,
    );
    assert.equal(
      isNoisyGeminiCliStderr(
        "Warning: 256-color support not detected. Using a terminal with at least 256-color support is recommended for a better visual experience.",
      ),
      true,
    );
    assert.equal(
      isNoisyGeminiCliStderr("Ripgrep is not available. Falling back to GrepTool."),
      true,
    );
    assert.equal(isNoisyGeminiCliStderr("headers: {"), true);
    assert.equal(isNoisyGeminiCliStderr("'alt-svc': 'h3=\":443\"; ma=2592000',"), true);
    assert.equal(isNoisyGeminiCliStderr("status: 429,"), true);
    assert.equal(isNoisyGeminiCliStderr("statusText: 'Too Many Requests',"), true);
    assert.equal(isNoisyGeminiCliStderr("Actual Gemini error"), false);
  });

  test("lists Gemini models before connecting a live session", async () => {
    process.env.RAH_GEMINI_BINARY = path.join(tmpHome, "missing-gemini");
    const services = createServices();
    const adapter = new GeminiAdapter(services);
    const catalog = await adapter.listModels();

    assert.equal(catalog.provider, "gemini");
    assert.equal(catalog.source, "static");
    assert.equal(catalog.currentModelId, "auto-gemini-3");
    assert.equal(catalog.sourceDetail, "static_builtin");
    assert.equal(catalog.freshness, "provisional");
    assert.equal(catalog.modelsExact, false);
    assert.equal(catalog.optionsExact, false);
    assert.equal(validateProviderModelCatalog(catalog).ok, true);
    assert.equal(catalog.modelProfiles?.find((profile) => profile.modelId === "auto-gemini-3")?.configOptions.length, 0);
    assert.equal(catalog.modelProfiles?.find((profile) => profile.modelId === "gemini-3-flash-preview")?.configOptions.length, 0);
    assert.deepEqual(
      catalog.models.map((model) => model.id),
      [
        "auto-gemini-3",
        "auto-gemini-2.5",
        "gemini-3.1-pro-preview",
        "gemini-3-flash-preview",
        "gemini-3.1-flash-lite-preview",
        "gemini-2.5-pro",
        "gemini-2.5-flash",
        "gemini-2.5-flash-lite",
      ],
    );
  });

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
    assert.equal(started.session.session.model?.currentModelId, "auto-gemini-3");
    assert.equal(started.session.session.model?.mutable, true);
    assert.equal(started.session.session.model?.availableModels.length, 8);

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
      contextWindow: 1048576,
      percentUsed: 0,
      percentRemaining: 100,
      basis: "context_window",
      precision: "estimated",
      source: "gemini.model_profile.context_window",
    });
  });

  test("switches Gemini approval mode for subsequent turns", async () => {
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

    const updated = adapter.setSessionMode(started.session.session.id, "plan");
    assert.equal(updated.session.mode?.currentModeId, "plan");
    assert.equal(updated.session.mode?.mutable, true);

    adapter.sendInput(started.session.session.id, {
      clientId: "web-1",
      text: "plan prompt",
    });

    await waitFor(
      () => services.sessionStore.getSession(started.session.session.id)?.session.runtimeState === "idle",
    );

    const argsLog = readFileSync(logPath, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as string[]);
    assert.equal(argsLog.length, 1);
    assert.ok(argsLog[0]?.includes("--approval-mode"));
    assert.ok(argsLog[0]?.includes("plan"));
  });

  test("switches Gemini model for subsequent turns", async () => {
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
    assert.equal(started.session.session.capabilities.modelSwitch, true);

    const updated = await adapter.setSessionModel?.(started.session.session.id, {
      modelId: "gemini-2.5-pro",
    });
    assert.equal(updated?.session.model?.currentModelId, "gemini-2.5-pro");
    assert.equal(updated?.session.model?.mutable, true);
    assert.equal(updated?.session.modelProfile?.modelId, "gemini-2.5-pro");

    adapter.sendInput(started.session.session.id, {
      clientId: "web-1",
      text: "model prompt",
    });

    await waitFor(
      () => services.sessionStore.getSession(started.session.session.id)?.session.runtimeState === "idle",
    );

    const argsLog = readFileSync(logPath, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as string[]);
    assert.equal(argsLog.length, 1);
    assert.ok(argsLog[0]?.includes("--model"));
    assert.ok(argsLog[0]?.includes("gemini-2.5-pro"));
  });

  test("discovers stored sessions and rehydrates replay history", async () => {
    writeGeminiSessionFile("gemini-session-2");
    const services = createServices();
    const adapter = new GeminiAdapter(services);

    const stored = adapter.listStoredSessions();
    assert.equal(stored.length, 1);
    assert.equal(stored[0]?.providerSessionId, "gemini-session-2");
    assert.equal(stored[0]?.cwd, cwd);
    assert.equal(stored[0]?.rootDir, cwd);
    assert.equal(stored[0]?.title, "Explain this repo");

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

  test("applies local Gemini rename through RAH title overrides", async () => {
    writeGeminiSessionFile("gemini-session-rename-1");
    const services = createServices();
    const adapter = new GeminiAdapter(services);

    const resumed = await adapter.resumeSession({
      provider: "gemini",
      providerSessionId: "gemini-session-rename-1",
      cwd,
      preferStoredReplay: true,
    });

    const renamed = await adapter.renameSession(
      resumed.session.session.id,
      "Renamed Gemini Session",
    );
    assert.equal(renamed.session.title, "Renamed Gemini Session");

    const response = buildSessionsResponse({
      liveStates: services.sessionStore.listSessions(),
      discoveredStoredSessions: adapter.listStoredSessions(),
      remembered: {
        rememberedSessions: services.workbenchState.snapshot().sessions,
        rememberedRecentSessions: services.workbenchState.snapshot().recentSessions,
        rememberedWorkspaceDirs: services.workbenchState.snapshot().workspaces,
        rememberedHiddenWorkspaces: services.workbenchState.snapshot().hiddenWorkspaces,
        rememberedHiddenSessionKeys: services.workbenchState.snapshot().hiddenSessionKeys,
        rememberedSessionTitleOverrides: services.workbenchState.snapshot().sessionTitleOverrides,
        ...(services.workbenchState.snapshot().activeWorkspaceDir
          ? { rememberedActiveWorkspaceDir: services.workbenchState.snapshot().activeWorkspaceDir }
          : {}),
      },
      isClosingSession: () => false,
    });

    assert.equal(
      response.storedSessions.find(
        (session) =>
          session.provider === "gemini" &&
          session.providerSessionId === "gemini-session-rename-1",
      )?.title,
      "Renamed Gemini Session",
    );
  });

  test("promotes pending Gemini local rename after provider session id binds", async () => {
    writeMockGeminiBinary();
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

    await adapter.renameSession(started.session.session.id, "Pending Gemini Title");
    assert.equal(
      services.workbenchState.snapshot().pendingSessionTitleOverrides[started.session.session.id],
      "Pending Gemini Title",
    );

    adapter.sendInput(started.session.session.id, {
      clientId: "web-1",
      text: "first prompt",
    });

    await waitFor(() => {
      const state = services.sessionStore.getSession(started.session.session.id);
      return state?.session.providerSessionId === "gemini-session-1";
    });

    const snapshot = services.workbenchState.snapshot();
    assert.equal(snapshot.pendingSessionTitleOverrides[started.session.session.id], undefined);
    assert.equal(
      snapshot.sessionTitleOverrides["gemini:gemini-session-1"],
      "Pending Gemini Title",
    );
    assert.equal(
      services.sessionStore.getSession(started.session.session.id)?.session.title,
      "Pending Gemini Title",
    );
  });

  test("recovers workspace metadata for legacy Gemini sessions from absolute path hints", () => {
    const inferredRoot = path.join(tmpHome, "legacy-project");
    writeLegacyGeminiSessionFile({
      sessionId: "gemini-session-legacy-path",
      projectHash: "legacy-project-hash",
      existingRoot: inferredRoot,
      messageText: `Read ${path.join(inferredRoot, "src", "main.ts")} and summarize it.`,
    });

    const adapter = new GeminiAdapter(createServices());
    const stored = adapter.listStoredSessions();
    const target = stored.find(
      (session) => session.providerSessionId === "gemini-session-legacy-path",
    );

    assert.equal(target?.cwd, inferredRoot);
    assert.equal(target?.rootDir, inferredRoot);
  });

  test("stores rootDir without cwd when legacy Gemini path hints only identify a missing project", () => {
    const missingRoot = path.join(tmpHome, "removed-project");
    writeLegacyGeminiSessionFile({
      sessionId: "gemini-session-legacy-missing",
      projectHash: "legacy-missing-hash",
      messageText: "No file path in the chat body.",
      logsMessage: `Review ${path.join(missingRoot, "lib", "index.ts")} and report the result.`,
    });

    const adapter = new GeminiAdapter(createServices());
    const stored = adapter.listStoredSessions();
    const target = stored.find(
      (session) => session.providerSessionId === "gemini-session-legacy-missing",
    );

    assert.equal(target?.cwd, undefined);
    assert.equal(target?.rootDir, missingRoot);
  });

  test("recovers workspace metadata for legacy Gemini sessions from remembered workspace candidates", () => {
    const rememberedRoot = path.join(tmpHome, "remembered-workspace");
    const projectHash = getProjectHash(rememberedRoot);
    writeRahWorkbenchState([rememberedRoot]);
    writeLegacyGeminiSessionFile({
      sessionId: "gemini-session-legacy-workbench",
      projectHash,
      messageText: "No path hints here.",
    });

    const adapter = new GeminiAdapter(createServices());
    const stored = adapter.listStoredSessions();
    const target = stored.find(
      (session) => session.providerSessionId === "gemini-session-legacy-workbench",
    );

    assert.equal(target?.cwd, undefined);
    assert.equal(target?.rootDir, rememberedRoot);
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
    assert.equal(replay.session.session.capabilities.actions.archive, false);

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
    assert.equal(resumed.session.session.capabilities.actions.archive, true);
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

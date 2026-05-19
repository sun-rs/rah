import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import type { RahEvent } from "@rah/runtime-protocol";
import {
  createGeminiStoredActivityState,
  discoverGeminiStoredSessions,
  findGeminiStoredSessionRecord,
  getGeminiStoredSessionHistoryPage,
  readGeminiStoredSessionActivityBatch,
} from "./gemini-session-files";
import { movePathToTrash } from "./trash";

type TimelineAddedEvent = Extract<RahEvent, { type: "timeline.item.added" }>;

const sessionId = "6b029ead-4e4f-4b2e-90d8-2cad44a9554f";

function isTimelineAdded(event: RahEvent): event is TimelineAddedEvent {
  return event.type === "timeline.item.added";
}

function projectHash(projectRoot: string): string {
  return createHash("sha256").update(projectRoot).digest("hex");
}

function writeGeminiSession(params: {
  geminiHome: string;
  cwd: string;
  sessionId?: string;
  fileStamp?: string;
  startTime?: string;
  lastUpdated?: string;
  summary?: string;
  messages?: unknown[];
}): string {
  const hash = projectHash(params.cwd);
  const providerSessionId = params.sessionId ?? sessionId;
  const chatsDir = path.join(params.geminiHome, "tmp", hash, "chats");
  mkdirSync(chatsDir, { recursive: true });
  writeFileSync(
    path.join(params.geminiHome, "projects.json"),
    JSON.stringify({ projects: { [params.cwd]: path.basename(params.cwd) } }),
    "utf8",
  );
  const filePath = path.join(
    chatsDir,
    `session-${params.fileStamp ?? "2026-05-18T00-00-00"}-${providerSessionId}.json`,
  );
  writeFileSync(
    filePath,
    JSON.stringify(
      {
        sessionId: providerSessionId,
        projectHash: hash,
        startTime: params.startTime ?? "2026-05-18T00:00:00.000Z",
        lastUpdated: params.lastUpdated ?? "2026-05-18T00:00:05.000Z",
        summary: params.summary ?? "Gemini test session",
        messages: params.messages ?? [
          {
            id: "msg-user-1",
            timestamp: "2026-05-18T00:00:01.000Z",
            type: "user",
            content: [{ text: "Analyze this repo" }],
            displayContent: [{ text: "Analyze this repo" }],
          },
          {
            id: "msg-gemini-1",
            timestamp: "2026-05-18T00:00:02.000Z",
            type: "gemini",
            content: [{ text: "This repo is a local AI workbench." }],
            thoughts: [{ text: "Need inspect project structure first." }],
            model: "gemini-2.5-pro",
            toolCalls: [
              {
                id: "tool-1",
                name: "read_file",
                args: { path: "README.md" },
                result: [{ text: "README contents" }],
                status: "success",
              },
            ],
          },
        ],
      },
      null,
      2,
    ),
    "utf8",
  );
  return filePath;
}

function writeGeminiJsonlSession(params: {
  geminiHome: string;
  cwd: string;
  slug: string;
  sessionId?: string;
  fileStamp?: string;
  lines?: unknown[];
}): string {
  const hash = projectHash(params.cwd);
  const providerSessionId = params.sessionId ?? sessionId;
  const projectDir = path.join(params.geminiHome, "tmp", params.slug);
  const chatsDir = path.join(projectDir, "chats");
  mkdirSync(chatsDir, { recursive: true });
  writeFileSync(path.join(projectDir, ".project_root"), params.cwd, "utf8");
  writeFileSync(
    path.join(params.geminiHome, "projects.json"),
    JSON.stringify({ projects: { [params.cwd]: params.slug } }),
    "utf8",
  );
  const filePath = path.join(
    chatsDir,
    `session-${params.fileStamp ?? "2026-05-18T00-00"}-${providerSessionId.slice(0, 8)}.jsonl`,
  );
  const lines = params.lines ?? [
    {
      sessionId: providerSessionId,
      projectHash: hash,
      startTime: "2026-05-18T00:00:00.000Z",
      lastUpdated: "2026-05-18T00:00:00.000Z",
      kind: "main",
    },
    {
      id: "msg-user-jsonl",
      timestamp: "2026-05-18T00:00:01.000Z",
      type: "user",
      content: [{ text: "你是谁" }],
    },
    { $set: { lastUpdated: "2026-05-18T00:00:01.000Z" } },
    {
      id: "msg-gemini-jsonl",
      timestamp: "2026-05-18T00:00:02.000Z",
      type: "gemini",
      content: "",
      thoughts: [{ description: "Preparing answer" }],
      model: "gemini-3.1-pro-preview",
    },
    {
      id: "msg-gemini-jsonl",
      timestamp: "2026-05-18T00:00:02.000Z",
      type: "gemini",
      content: "我是 Gemini CLI。",
      thoughts: [{ description: "Preparing answer" }],
      model: "gemini-3.1-pro-preview",
    },
    { $set: { lastUpdated: "2026-05-18T00:00:02.000Z" } },
  ];
  writeFileSync(filePath, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`, "utf8");
  return filePath;
}

describe("Gemini stored session files", () => {
  let geminiHome: string;
  let cwd: string;
  let previousGeminiHome: string | undefined;

  beforeEach(() => {
    previousGeminiHome = process.env.GEMINI_CLI_HOME;
    geminiHome = mkdtempSync(path.join(os.tmpdir(), "rah-gemini-home-"));
    cwd = mkdtempSync(path.join(os.tmpdir(), "rah-gemini-cwd-"));
    process.env.GEMINI_CLI_HOME = geminiHome;
  });

  afterEach(async () => {
    if (previousGeminiHome === undefined) {
      delete process.env.GEMINI_CLI_HOME;
    } else {
      process.env.GEMINI_CLI_HOME = previousGeminiHome;
    }
    await movePathToTrash(geminiHome);
    await movePathToTrash(cwd);
  });

  test("discovers JSON Gemini CLI conversations with workspace and history metadata", () => {
    const filePath = writeGeminiSession({ geminiHome, cwd });

    const sessions = discoverGeminiStoredSessions(cwd);
    assert.equal(sessions.length, 1);
    assert.deepEqual(
      {
        provider: sessions[0]!.ref.provider,
        providerSessionId: sessions[0]!.ref.providerSessionId,
        cwd: sessions[0]!.ref.cwd,
        rootDir: sessions[0]!.ref.rootDir,
        title: sessions[0]!.ref.title,
        source: sessions[0]!.ref.source,
        hasHistoryMeta: Boolean(sessions[0]!.ref.historyMeta),
      },
      {
        provider: "gemini",
        providerSessionId: sessionId,
        cwd,
        rootDir: cwd,
        title: "Gemini test session",
        source: "provider_history",
        hasHistoryMeta: true,
      },
    );
    assert.equal(sessions[0]!.filePath, filePath);
    assert.equal(sessions[0]!.ref.historyMeta?.messages, 2);
  });

  test("dedupes duplicate provider session ids by newest usable record", () => {
    writeGeminiSession({
      geminiHome,
      cwd,
      fileStamp: "2026-05-18T00-00-00",
      lastUpdated: "2026-05-18T00:00:05.000Z",
      summary: "older duplicate",
      messages: [
        {
          id: "msg-user-old",
          timestamp: "2026-05-18T00:00:01.000Z",
          type: "user",
          content: [{ text: "old" }],
        },
      ],
    });
    const newerPath = writeGeminiSession({
      geminiHome,
      cwd,
      fileStamp: "2026-05-18T00-01-00",
      lastUpdated: "2026-05-18T00:01:05.000Z",
      summary: "newer duplicate",
      messages: [
        {
          id: "msg-user-new",
          timestamp: "2026-05-18T00:01:01.000Z",
          type: "user",
          content: [{ text: "new" }],
        },
        {
          id: "msg-gemini-new",
          timestamp: "2026-05-18T00:01:02.000Z",
          type: "gemini",
          content: [{ text: "new answer" }],
        },
      ],
    });

    const sessions = discoverGeminiStoredSessions(cwd);
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0]!.filePath, newerPath);
    assert.equal(sessions[0]!.ref.title, "newer duplicate");
    assert.equal(sessions[0]!.ref.historyMeta?.messages, 2);

    const record = findGeminiStoredSessionRecord(sessionId, cwd);
    assert.equal(record?.filePath, newerPath);
  });

  test("discovers JSONL Gemini CLI conversations under the projects slug directory", () => {
    const filePath = writeGeminiJsonlSession({
      geminiHome,
      cwd,
      slug: "rah-1",
    });

    const sessions = discoverGeminiStoredSessions(cwd);
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0]!.filePath, filePath);
    assert.equal(sessions[0]!.ref.providerSessionId, sessionId);
    assert.equal(sessions[0]!.ref.cwd, cwd);
    assert.equal(sessions[0]!.ref.historyMeta?.messages, 2);

    const page = getGeminiStoredSessionHistoryPage({
      sessionId: "rah-session-1",
      record: sessions[0]!,
      limit: 100,
    });
    const assistantTexts = page.events
      .filter(isTimelineAdded)
      .filter((event) => event.payload.item.kind === "assistant_message")
      .map((event) => (event.payload.item.kind === "assistant_message" ? event.payload.item.text : ""));
    assert.deepEqual(assistantTexts, ["我是 Gemini CLI。"]);
  });

  test("materializes user, assistant, reasoning, tool, model, and stable identities", () => {
    writeGeminiSession({ geminiHome, cwd });
    const record = findGeminiStoredSessionRecord(sessionId, cwd);
    assert.ok(record);

    const page = getGeminiStoredSessionHistoryPage({
      sessionId: "rah-session-1",
      record,
      limit: 100,
    });
    const timelineEvents = page.events.filter(isTimelineAdded);
    const userEvent = timelineEvents.find(
      (event) => event.payload.item.kind === "user_message",
    );
    const assistantEvent = timelineEvents.find(
      (event) => event.payload.item.kind === "assistant_message",
    );
    const reasoningEvent = timelineEvents.find(
      (event) => event.payload.item.kind === "reasoning",
    );
    const toolCompleted = page.events.find((event) => event.type === "tool.call.completed");
    assert.deepEqual(
      timelineEvents.slice(0, 3).map((event) => event.payload.item.kind),
      ["user_message", "reasoning", "assistant_message"],
    );

    assert.equal(userEvent?.payload.item.kind, "user_message");
    if (userEvent?.payload.item.kind === "user_message") {
      assert.equal(userEvent.payload.item.text, "Analyze this repo");
    }
    assert.equal(assistantEvent?.payload.item.kind, "assistant_message");
    if (assistantEvent?.payload.item.kind === "assistant_message") {
      assert.equal(assistantEvent.payload.item.text, "This repo is a local AI workbench.");
      assert.equal(assistantEvent.payload.item.runtimeModel?.modelId, "gemini-2.5-pro");
    }
    assert.equal(reasoningEvent?.payload.item.kind, "reasoning");
    if (reasoningEvent?.payload.item.kind === "reasoning") {
      assert.equal(reasoningEvent.payload.item.text, "Need inspect project structure first.");
    }
    assert.equal(toolCompleted?.payload.toolCall.providerToolName, "read_file");
    assert.equal(userEvent?.payload.identity?.origin, "history");

    const state = createGeminiStoredActivityState();
    const liveBatch = readGeminiStoredSessionActivityBatch({ record, state });
    const liveUser = liveBatch.find(
      (item) =>
        item.activity.type === "timeline_item" &&
        item.activity.item.kind === "user_message",
    );
    assert.equal(liveUser?.activity.type, "timeline_item");
    if (liveUser?.activity.type !== "timeline_item") {
      throw new Error("Expected live Gemini user message timeline activity.");
    }
    assert.equal(liveUser.activity.identity?.origin, "live");
    assert.equal(
      liveUser.activity.identity?.canonicalItemId,
      userEvent?.payload.identity?.canonicalItemId,
    );
    assert.deepEqual(readGeminiStoredSessionActivityBatch({ record, state }), []);
  });

  test("reloads the Gemini file when materializing history from an indexed record", () => {
    writeGeminiSession({
      geminiHome,
      cwd,
      messages: [
        {
          id: "msg-user-1",
          timestamp: "2026-05-18T00:00:01.000Z",
          type: "user",
          content: [{ text: "Question" }],
        },
        {
          id: "msg-gemini-1",
          timestamp: "2026-05-18T00:00:02.000Z",
          type: "gemini",
          content: [{ text: "Stale answer" }],
        },
      ],
    });
    const record = findGeminiStoredSessionRecord(sessionId, cwd);
    assert.ok(record);

    writeGeminiSession({
      geminiHome,
      cwd,
      lastUpdated: "2026-05-18T00:00:10.000Z",
      messages: [
        {
          id: "msg-user-1",
          timestamp: "2026-05-18T00:00:01.000Z",
          type: "user",
          content: [{ text: "Question" }],
        },
        {
          id: "msg-gemini-1",
          timestamp: "2026-05-18T00:00:02.000Z",
          type: "gemini",
          content: [{ text: "Fresh answer" }],
        },
      ],
    });

    const page = getGeminiStoredSessionHistoryPage({
      sessionId: "rah-session-1",
      record,
      limit: 100,
    });
    const assistantTexts = page.events
      .filter(isTimelineAdded)
      .filter((event) => event.payload.item.kind === "assistant_message")
      .map((event) => (event.payload.item.kind === "assistant_message" ? event.payload.item.text : ""));
    assert.deepEqual(assistantTexts, ["Fresh answer"]);
  });

  test("emits a running Gemini tool once and only completes it after the tool revision changes", () => {
    const runningTool = {
      id: "tool-live-1",
      name: "run_shell",
      args: { command: "npm test" },
      status: "running",
    };
    writeGeminiSession({
      geminiHome,
      cwd,
      messages: [
        {
          id: "msg-gemini-tool",
          timestamp: "2026-05-18T00:00:02.000Z",
          type: "gemini",
          content: [],
          toolCalls: [runningTool],
        },
      ],
    });
    const record = findGeminiStoredSessionRecord(sessionId, cwd);
    assert.ok(record);
    const state = createGeminiStoredActivityState();

    const firstBatch = readGeminiStoredSessionActivityBatch({ record, state });
    assert.equal(firstBatch.filter((item) => item.activity.type === "tool_call_started").length, 1);
    assert.equal(firstBatch.filter((item) => item.activity.type === "tool_call_completed").length, 0);

    writeGeminiSession({
      geminiHome,
      cwd,
      lastUpdated: "2026-05-18T00:00:10.000Z",
      messages: [
        {
          id: "msg-gemini-tool",
          timestamp: "2026-05-18T00:00:02.000Z",
          type: "gemini",
          content: [],
          toolCalls: [
            {
              ...runningTool,
              result: [{ text: "ok" }],
              status: "success",
            },
          ],
        },
      ],
    });

    const secondBatch = readGeminiStoredSessionActivityBatch({ record, state });
    assert.equal(secondBatch.filter((item) => item.activity.type === "tool_call_started").length, 0);
    assert.equal(secondBatch.filter((item) => item.activity.type === "tool_call_completed").length, 1);
    assert.deepEqual(readGeminiStoredSessionActivityBatch({ record, state }), []);
  });

  test("projects rah_council MCP posts and hides polling tools", () => {
    writeGeminiSession({
      geminiHome,
      cwd,
      messages: [
        {
          id: "msg-user-1",
          timestamp: "2026-05-18T00:00:01.000Z",
          type: "user",
          content: [{ text: "Join the council" }],
          displayContent: [{ text: "Join the council" }],
        },
        {
          id: "msg-gemini-1",
          timestamp: "2026-05-18T00:00:02.000Z",
          type: "gemini",
          content: [],
          model: "gemini-2.5-pro",
          toolCalls: [
            {
              id: "tool-wait-1",
              name: "mcp_rah_council_channel_wait_new",
              args: { council: "council-1", timeout_s: 60 },
              result: { ok: true, timed_out: true },
              status: "success",
            },
            {
              id: "tool-post-1",
              name: "mcp_rah_council_channel_post",
              args: { text: "Gemini council reply" },
              result: { ok: true, msg_id: 42 },
              status: "success",
            },
          ],
        },
      ],
    });
    const record = findGeminiStoredSessionRecord(sessionId, cwd);
    assert.ok(record);

    const page = getGeminiStoredSessionHistoryPage({
      sessionId: "rah-session-1",
      record,
      limit: 100,
    });
    const timelineEvents = page.events.filter(isTimelineAdded);
    const projectedReply = timelineEvents.find(
      (event) =>
        event.payload.item.kind === "assistant_message" &&
        event.payload.item.text === "Gemini council reply",
    );
    const rawCouncilTools = page.events.filter(
      (event) =>
        (event.type === "tool.call.started" || event.type === "tool.call.completed") &&
        event.payload.toolCall.providerToolName.includes("rah_council"),
    );

    assert.equal(projectedReply?.payload.item.kind, "assistant_message");
    assert.equal(projectedReply?.payload.identity?.origin, "history");
    assert.equal(rawCouncilTools.length, 0);
  });
});

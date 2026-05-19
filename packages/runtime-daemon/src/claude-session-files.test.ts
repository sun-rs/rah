import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventBus } from "./event-bus";
import { PtyHub } from "./pty-hub";
import { SessionStore } from "./session-store";
import {
  createClaudeStoredSessionFrozenHistoryPageLoader,
  discoverClaudeStoredSessions,
  findClaudeStoredSessionRecord,
  getClaudeStoredSessionHistoryPage,
  resumeClaudeStoredSession,
  updateClaudeSessionTitle,
} from "./claude-session-files";
import { createClaudeTimelineIdentity } from "./claude-timeline-identity";

describe("Claude session files", () => {
  let tmpClaudeConfig: string;
  let previousClaudeConfig: string | undefined;
  let workDir: string;
  let projectDir: string;

  beforeEach(() => {
    previousClaudeConfig = process.env.CLAUDE_CONFIG_DIR;
    tmpClaudeConfig = mkdtempSync(path.join(os.tmpdir(), "rah-claude-config-"));
    workDir = mkdtempSync(path.join(os.tmpdir(), "rah-claude-workdir-"));
    const projectId = path.resolve(workDir).replace(/[^a-zA-Z0-9]/g, "-");
    projectDir = path.join(tmpClaudeConfig, "projects", projectId);
    mkdirSync(projectDir, { recursive: true });
    process.env.CLAUDE_CONFIG_DIR = tmpClaudeConfig;
  });

  afterEach(() => {
    if (previousClaudeConfig === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR;
    } else {
      process.env.CLAUDE_CONFIG_DIR = previousClaudeConfig;
    }
    rmSync(tmpClaudeConfig, { recursive: true, force: true });
    rmSync(workDir, { recursive: true, force: true });
  });

  function writeClaudeSession(fileName: string, lines: unknown[]) {
    writeFileSync(
      path.join(projectDir, fileName),
      `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`,
    );
  }

  test("discovers stored Claude sessions from .claude/projects path", () => {
    writeClaudeSession("session-1.jsonl", [
      {
        type: "user",
        uuid: "user-1",
        cwd: workDir,
        sessionId: "session-1",
        timestamp: "2025-07-19T22:21:00.000Z",
        message: {
          content: "say lol",
        },
      },
      {
        type: "assistant",
        uuid: "assistant-1",
        cwd: workDir,
        sessionId: "session-1",
        timestamp: "2025-07-19T22:21:04.000Z",
        message: {
          content: [{ type: "text", text: "lol" }],
        },
      },
    ]);

    const stored = discoverClaudeStoredSessions(workDir);
    assert.equal(stored.length, 1);
    assert.equal(stored[0]?.ref.provider, "claude");
    assert.equal(stored[0]?.ref.providerSessionId, "session-1");
    assert.equal(stored[0]?.ref.cwd, workDir);
    assert.match(stored[0]?.ref.title ?? "", /say lol/);
  });

  test("finds stored Claude sessions across /var and /private/var aliases", () => {
    const privateLikeWorkDir = path.join("/private", workDir);
    const privateProjectId = path.resolve(privateLikeWorkDir).replace(/[^a-zA-Z0-9]/g, "-");
    const privateProjectDir = path.join(tmpClaudeConfig, "projects", privateProjectId);
    mkdirSync(privateProjectDir, { recursive: true });
    writeFileSync(
      path.join(privateProjectDir, "session-private.jsonl"),
      `${JSON.stringify({
        type: "user",
        uuid: "user-private-1",
        cwd: privateLikeWorkDir,
        sessionId: "session-private",
        timestamp: "2025-07-19T22:21:00.000Z",
        message: { content: "say private" },
      })}\n`,
    );

    const record = findClaudeStoredSessionRecord("session-private", workDir);
    assert.ok(record);
    assert.equal(record.ref.providerSessionId, "session-private");
  });

  test("prefers custom-title metadata over first user message", () => {
    writeClaudeSession("session-renamed.jsonl", [
      {
        type: "user",
        uuid: "user-1",
        cwd: workDir,
        sessionId: "session-renamed",
        timestamp: "2025-07-19T22:21:00.000Z",
        message: {
          content: "hello there",
        },
      },
      {
        type: "custom-title",
        customTitle: "Renamed Claude Session",
        sessionId: "session-renamed",
      },
    ]);

    const stored = discoverClaudeStoredSessions(workDir);
    assert.equal(stored[0]?.ref.title, "Renamed Claude Session");

    updateClaudeSessionTitle("session-renamed", "Renamed Again", workDir);
    const refreshed = discoverClaudeStoredSessions(workDir);
    assert.equal(refreshed[0]?.ref.title, "Renamed Again");
  });

  test("preserves Claude assistant markdown line breaks and indentation", () => {
    const markdown = [
      "会涉及抽象。",
      "",
      "- AgentAdapter",
      "  - nested item",
      "",
      "```text",
      "  Council",
      "```",
    ].join("\n");
    writeClaudeSession("session-markdown.jsonl", [
      {
        type: "user",
        uuid: "user-1",
        cwd: workDir,
        sessionId: "session-markdown",
        timestamp: "2025-07-19T22:21:00.000Z",
        message: {
          content: "show markdown",
        },
      },
      {
        type: "assistant",
        uuid: "assistant-1",
        cwd: workDir,
        sessionId: "session-markdown",
        timestamp: "2025-07-19T22:21:04.000Z",
        message: {
          model: "claude-opus-4-7",
          content: [{ type: "text", text: `\n${markdown}\n` }],
        },
      },
    ]);

    const record = findClaudeStoredSessionRecord("session-markdown", workDir);
    assert.ok(record);
    const page = getClaudeStoredSessionHistoryPage({
      sessionId: "replay-markdown",
      record,
      limit: 100,
    });
    const assistantMessage = page.events.find(
      (event) =>
        event.type === "timeline.item.added" &&
        event.payload.item.kind === "assistant_message",
    );

    assert.ok(assistantMessage);
    if (
      assistantMessage.type === "timeline.item.added" &&
      assistantMessage.payload.item.kind === "assistant_message"
    ) {
      assert.equal(assistantMessage.payload.item.text, markdown);
      assert.deepEqual(assistantMessage.payload.item.runtimeModel, {
        modelId: "claude-opus-4-7",
        source: "native",
      });
    }
  });

  test("projects Claude Council channel_post tool results as assistant messages with native model", () => {
    writeClaudeSession("session-council-post.jsonl", [
      {
        type: "user",
        uuid: "user-council-1",
        cwd: workDir,
        sessionId: "session-council-post",
        timestamp: "2025-07-19T22:21:00.000Z",
        message: {
          content: "join council",
        },
      },
      {
        type: "assistant",
        uuid: "assistant-council-tool",
        cwd: workDir,
        sessionId: "session-council-post",
        timestamp: "2025-07-19T22:21:02.000Z",
        message: {
          model: "kimi-for-coding",
          content: [
            {
              type: "tool_use",
              id: "toolu_council_post",
              name: "mcp__rah_council__channel_post",
              input: { text: "我是 Claude council agent，已准备好。" },
            },
          ],
        },
      },
      {
        type: "user",
        uuid: "tool-result-council-post",
        cwd: workDir,
        sessionId: "session-council-post",
        timestamp: "2025-07-19T22:21:03.000Z",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_council_post",
              content: JSON.stringify({ ok: true, msg_id: "msg-1" }),
            },
          ],
        },
      },
    ]);

    const record = findClaudeStoredSessionRecord("session-council-post", workDir);
    assert.ok(record);
    const page = getClaudeStoredSessionHistoryPage({
      sessionId: "rah-session-council-post",
      record,
      limit: 100,
    });

    const assistantMessage = page.events.find(
      (event) =>
        event.type === "timeline.item.added" &&
        event.payload.item.kind === "assistant_message" &&
        event.payload.item.text === "我是 Claude council agent，已准备好。",
    );
    assert.ok(assistantMessage);
    if (
      assistantMessage.type === "timeline.item.added" &&
      assistantMessage.payload.item.kind === "assistant_message"
    ) {
      assert.equal(assistantMessage.payload.item.messageId, "council-mcp:toolu_council_post");
      assert.deepEqual(assistantMessage.payload.item.runtimeModel, {
        modelId: "kimi-for-coding",
        source: "native",
      });
      assert.equal(
        assistantMessage.payload.identity?.canonicalItemId,
        createClaudeTimelineIdentity({
          providerSessionId: "session-council-post",
          recordUuid: "assistant-council-tool",
          itemKind: "assistant_message",
          origin: "history",
          partIndex: 1,
        }).canonicalItemId,
      );
    }
    assert.equal(
      page.events.some(
        (event) =>
          event.type === "tool.call.completed" &&
          event.payload.toolCall.providerToolName === "mcp__rah_council__channel_post",
      ),
      false,
    );
  });

  test("frozen Claude history loader preserves Council posts when tool context crosses page windows", () => {
    const hiddenSystemRecords = Array.from({ length: 32 }, (_, index) => ({
      type: "system",
      uuid: `system-noise-${index}`,
      cwd: workDir,
      sessionId: "session-council-window",
      timestamp: `2025-07-19T22:21:${String(index + 3).padStart(2, "0")}.000Z`,
      subtype: "noise",
    }));
    const laterTurns = Array.from({ length: 24 }, (_, index) => {
      const n = index + 1;
      return [
        {
          type: "user",
          uuid: `user-later-${n}`,
          cwd: workDir,
          sessionId: "session-council-window",
          timestamp: `2025-07-19T22:30:${String(index * 2).padStart(2, "0")}.000Z`,
          message: {
            content: `later user ${n}`,
          },
        },
        {
          type: "assistant",
          uuid: `assistant-later-${n}`,
          cwd: workDir,
          sessionId: "session-council-window",
          timestamp: `2025-07-19T22:30:${String(index * 2 + 1).padStart(2, "0")}.000Z`,
          message: {
            content: [{ type: "text", text: `later assistant ${n}` }],
          },
        },
      ];
    }).flat();
    writeClaudeSession("session-council-window.jsonl", [
      {
        type: "user",
        uuid: "user-council-window",
        cwd: workDir,
        sessionId: "session-council-window",
        timestamp: "2025-07-19T22:21:00.000Z",
        message: {
          content: "join council",
        },
      },
      {
        type: "assistant",
        uuid: "assistant-council-window-tool",
        cwd: workDir,
        sessionId: "session-council-window",
        timestamp: "2025-07-19T22:21:02.000Z",
        message: {
          model: "kimi-for-coding",
          content: [
            {
              type: "tool_use",
              id: "toolu_council_window",
              name: "mcp__rah_council__channel_post",
              input: { text: "Claude Council post split across pager windows." },
            },
          ],
        },
      },
      ...hiddenSystemRecords,
      {
        type: "user",
        uuid: "tool-result-council-window",
        cwd: workDir,
        sessionId: "session-council-window",
        timestamp: "2025-07-19T22:22:00.000Z",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_council_window",
              content: JSON.stringify({ ok: true, msg_id: "msg-window" }),
            },
          ],
        },
      },
      ...laterTurns,
    ]);

    const record = findClaudeStoredSessionRecord("session-council-window", workDir);
    assert.ok(record);
    const loader = createClaudeStoredSessionFrozenHistoryPageLoader({
      sessionId: "replay-council-window",
      record,
    });
    const collected = [];
    let page = loader.loadInitialPage(4);
    for (let index = 0; index < 40; index += 1) {
      collected.push(...page.events);
      if (!page.nextCursor) {
        break;
      }
      page = loader.loadOlderPage(page.nextCursor, 4, page.boundary);
    }

    const projected = collected.find(
      (event) =>
        event.type === "timeline.item.added" &&
        event.payload.item.kind === "assistant_message" &&
        event.payload.item.text === "Claude Council post split across pager windows.",
    );
    assert.ok(projected);
    if (projected.type === "timeline.item.added" && projected.payload.item.kind === "assistant_message") {
      assert.deepEqual(projected.payload.item.runtimeModel, {
        modelId: "kimi-for-coding",
        source: "native",
      });
    }
  });

  test("keeps Claude chat messages in file order when record timestamps go backwards", () => {
    writeClaudeSession("session-nonmonotonic.jsonl", [
      {
        type: "user",
        uuid: "user-nonmonotonic-1",
        cwd: workDir,
        sessionId: "session-nonmonotonic",
        timestamp: "2025-07-19T22:21:10.000Z",
        message: {
          content: "first question",
        },
      },
      {
        type: "assistant",
        uuid: "assistant-nonmonotonic-1",
        cwd: workDir,
        sessionId: "session-nonmonotonic",
        timestamp: "2025-07-19T22:21:05.000Z",
        message: {
          content: [{ type: "text", text: "first answer" }],
        },
      },
    ]);

    const record = findClaudeStoredSessionRecord("session-nonmonotonic", workDir);
    assert.ok(record);
    const page = getClaudeStoredSessionHistoryPage({
      sessionId: "replay-nonmonotonic",
      record,
      limit: 100,
    });
    const messages = page.events
      .filter((event) => event.type === "timeline.item.added")
      .map((event) => event.payload.item)
      .filter((item) => item.kind === "user_message" || item.kind === "assistant_message");

    assert.deepEqual(
      messages.map((item) => item.text),
      ["first question", "first answer"],
    );
    const assistantEvent = page.events.find(
      (event) =>
        event.type === "timeline.item.added" &&
        event.payload.item.kind === "assistant_message",
    );
    assert.equal(assistantEvent?.turnId, "turn:user-nonmonotonic-1");
  });

  test("filters Claude resume interrupted banner from chat history", () => {
    writeClaudeSession("session-resume-banner.jsonl", [
      {
        type: "user",
        uuid: "user-1",
        cwd: workDir,
        sessionId: "session-resume-banner",
        timestamp: "2025-07-19T22:21:00.000Z",
        message: {
          content: "first question",
        },
      },
      {
        type: "assistant",
        uuid: "assistant-1",
        cwd: workDir,
        sessionId: "session-resume-banner",
        timestamp: "2025-07-19T22:21:04.000Z",
        message: {
          content: [{ type: "text", text: "first answer" }],
        },
      },
      {
        type: "user",
        uuid: "user-resume-banner-1",
        cwd: workDir,
        sessionId: "session-resume-banner",
        timestamp: "2025-07-19T22:21:05.000Z",
        message: {
          content: "Continue from where you left off.\nConversation interrupted — The previous turn was interrupted.",
        },
      },
      {
        type: "user",
        uuid: "user-resume-banner-2",
        cwd: workDir,
        sessionId: "session-resume-banner",
        timestamp: "2025-07-19T22:21:05.500Z",
        message: {
          content: [
            { type: "text", text: "Continue from where you left off." },
            { type: "text", text: "Conversation interrupted — The previous turn was interrupted." },
          ],
        },
      },
      {
        type: "user",
        uuid: "user-2",
        cwd: workDir,
        sessionId: "session-resume-banner",
        timestamp: "2025-07-19T22:21:06.000Z",
        message: {
          content: "second question",
        },
      },
    ]);

    const record = findClaudeStoredSessionRecord("session-resume-banner", workDir);
    assert.ok(record);
    const page = getClaudeStoredSessionHistoryPage({
      sessionId: "replay-resume-banner",
      record,
      limit: 100,
    });
    const messages = page.events
      .filter((event) => event.type === "timeline.item.added")
      .map((event) => event.payload.item)
      .filter((item) => item.kind === "user_message" || item.kind === "assistant_message");

    assert.deepEqual(
      messages.map((item) => item.text),
      ["first question", "first answer", "second question"],
    );
  });

  test("deduplicates resumed history and skips internal Claude events", () => {
    writeClaudeSession("session-2.jsonl", [
      {
        type: "summary",
        summary: "Earlier summary",
        leafUuid: "assistant-1",
        cwd: workDir,
        sessionId: "session-2",
        timestamp: "2025-07-19T22:32:30.000Z",
      },
      {
        type: "user",
        uuid: "user-1",
        cwd: workDir,
        sessionId: "session-2",
        timestamp: "2025-07-19T22:32:31.000Z",
        message: {
          content: "say lol",
        },
      },
      {
        type: "assistant",
        uuid: "assistant-1",
        cwd: workDir,
        sessionId: "session-2",
        timestamp: "2025-07-19T22:32:32.000Z",
        message: {
          content: [{ type: "text", text: "lol" }],
        },
      },
      {
        type: "file-history-snapshot",
        cwd: workDir,
        sessionId: "session-2",
      },
      {
        type: "assistant",
        uuid: "assistant-tool",
        cwd: workDir,
        sessionId: "session-2",
        timestamp: "2025-07-19T22:32:49.000Z",
        message: {
          content: [
            {
              type: "tool_use",
              id: "toolu_1",
              name: "LS",
              input: { path: workDir },
            },
          ],
        },
      },
      {
        type: "assistant",
        uuid: "assistant-2",
        cwd: workDir,
        sessionId: "session-2",
        timestamp: "2025-07-19T22:32:51.000Z",
        message: {
          content: [{ type: "text", text: "0-say-lol-session.jsonl\nreadme.md" }],
        },
      },
      {
        type: "assistant",
        uuid: "assistant-noise-1",
        cwd: workDir,
        sessionId: "session-2",
        timestamp: "2025-07-19T22:32:52.000Z",
        message: {
          content: [{ type: "text", text: "<local-command-stdout>pwd output</local-command-stdout>" }],
        },
      },
      {
        type: "assistant",
        uuid: "assistant-noise-2",
        cwd: workDir,
        sessionId: "session-2",
        timestamp: "2025-07-19T22:32:53.000Z",
        message: {
          content: [{ type: "text", text: "No response requested." }],
        },
      },
      {
        type: "system",
        uuid: "system-error-1",
        subtype: "api_error",
        cwd: workDir,
        sessionId: "session-2",
        timestamp: "2025-07-19T22:32:54.000Z",
        error: "Claude upstream rejected the request",
      },
    ]);

    const record = discoverClaudeStoredSessions(workDir)[0];
    assert.ok(record);

    const services = {
      eventBus: new EventBus(),
      ptyHub: new PtyHub(),
      sessionStore: new SessionStore(),
    };
    const resumed = resumeClaudeStoredSession({
      services,
      record,
    });
    assert.equal(
      services.eventBus
        .list({ sessionIds: [resumed.sessionId] })
        .filter((event) => event.type === "timeline.item.added").length,
      0,
    );
    const page = getClaudeStoredSessionHistoryPage({
      sessionId: resumed.sessionId,
      record,
      limit: 100,
    });

    const userMessages = page.events.filter(
      (event) =>
        event.type === "timeline.item.added" &&
        event.payload.item.kind === "user_message",
    );
    assert.equal(userMessages.length, 1);
    const onlyUser = userMessages[0];
    assert.ok(onlyUser);
    if (onlyUser.type === "timeline.item.added" && onlyUser.payload.item.kind === "user_message") {
      assert.equal(onlyUser.payload.item.text, "say lol");
      assert.equal(
        onlyUser.payload.identity?.canonicalItemId,
        createClaudeTimelineIdentity({
          providerSessionId: "session-2",
          recordUuid: "user-1",
          itemKind: "user_message",
          origin: "live",
        }).canonicalItemId,
      );
    }

    const assistantMessages = page.events.filter(
      (event) =>
        (event.type === "timeline.item.added" || event.type === "timeline.item.updated") &&
        event.payload.item.kind === "assistant_message",
    );
    assert.ok(
      assistantMessages.some(
        (event) =>
          (event.type === "timeline.item.added" || event.type === "timeline.item.updated") &&
          event.payload.item.kind === "assistant_message" &&
          event.payload.item.text === "lol",
      ),
    );
    const firstAssistant = assistantMessages.find(
      (event) =>
        (event.type === "timeline.item.added" || event.type === "timeline.item.updated") &&
        event.payload.item.kind === "assistant_message" &&
        event.payload.item.text === "lol",
    );
    assert.ok(firstAssistant);
    if (firstAssistant.type === "timeline.item.added" || firstAssistant.type === "timeline.item.updated") {
      assert.equal(
        firstAssistant.payload.identity?.canonicalItemId,
        createClaudeTimelineIdentity({
          providerSessionId: "session-2",
          recordUuid: "assistant-1",
          itemKind: "assistant_message",
          origin: "live",
        }).canonicalItemId,
      );
    }
    assert.ok(
      assistantMessages.some(
        (event) =>
          (event.type === "timeline.item.added" || event.type === "timeline.item.updated") &&
          event.payload.item.kind === "assistant_message" &&
          event.payload.item.text.includes("readme.md"),
      ),
    );

    assert.ok(
      page.events.some(
        (event) =>
          event.type === "tool.call.completed" &&
          event.payload.toolCall.providerToolName === "LS",
      ),
    );

    assert.equal(
      page.events.some((event) => (event as { raw?: { type?: string } }).raw?.type === "file-history-snapshot"),
      false,
    );
    assert.equal(
      assistantMessages.some(
        (event) =>
          (event.type === "timeline.item.added" || event.type === "timeline.item.updated") &&
          event.payload.item.kind === "assistant_message" &&
          event.payload.item.text.includes("local-command-stdout"),
      ),
      false,
    );
    assert.equal(
      assistantMessages.some(
        (event) =>
          (event.type === "timeline.item.added" || event.type === "timeline.item.updated") &&
          event.payload.item.kind === "assistant_message" &&
          event.payload.item.text === "No response requested.",
      ),
      false,
    );
    assert.equal(
      page.events.some(
        (event) =>
          event.type === "notification.emitted" &&
          event.payload.title === "Claude API error",
      ),
      false,
    );
  });

  test("filters Claude api errors out of chat history notifications", () => {
    writeClaudeSession("session-503.jsonl", [
      {
        type: "user",
        uuid: "user-503",
        cwd: workDir,
        sessionId: "session-503",
        timestamp: "2025-07-19T22:32:50.000Z",
        message: {
          content: "你是谁",
        },
      },
      {
        type: "system",
        uuid: "system-error-503",
        subtype: "api_error",
        cwd: workDir,
        sessionId: "session-503",
        timestamp: "2025-07-19T22:32:51.000Z",
        error: {
          status: 503,
          headers: {
            server: "cloudflare",
            "x-request-id": "f589e5e5-1066-4763-abe4-14122f11c486",
          },
          error: {
            error: {
              message: "No available accounts: no available accounts",
              type: "api_error",
            },
            type: "error",
          },
          type: "api_error",
        },
      },
    ]);

    const record = discoverClaudeStoredSessions(workDir)[0];
    assert.ok(record);
    const page = getClaudeStoredSessionHistoryPage({
      sessionId: "rah-session",
      record,
      limit: 100,
    });
    assert.equal(
      page.events.some(
        (event) =>
          event.type === "notification.emitted" &&
          event.payload.title === "Claude API error",
      ),
      false,
    );
    assert.equal(
      JSON.stringify(page.events).includes("No available accounts"),
      false,
    );
  });

  test("filters Claude overload and rate-limit api errors out of chat history", () => {
    writeClaudeSession("session-429.jsonl", [
      {
        type: "user",
        uuid: "user-429",
        cwd: workDir,
        sessionId: "session-429",
        timestamp: "2025-07-19T22:32:50.000Z",
        message: {
          content: "你是谁",
        },
      },
      {
        type: "system",
        uuid: "system-error-429",
        subtype: "api_error",
        cwd: workDir,
        sessionId: "session-429",
        timestamp: "2025-07-19T22:32:51.000Z",
        error: {
          status: 429,
          error: {
            error: {
              message: "The engine is currently overloaded, please try again later",
              type: "api_error",
            },
            type: "error",
          },
          type: "api_error",
        },
      },
    ]);

    const record = discoverClaudeStoredSessions(workDir)[0];
    assert.ok(record);
    const page = getClaudeStoredSessionHistoryPage({
      sessionId: "rah-session",
      record,
      limit: 100,
    });
    assert.equal(
      page.events.some(
        (event) =>
          event.type === "notification.emitted" &&
          event.payload.title === "Claude API error",
      ),
      false,
    );
    assert.equal(
      JSON.stringify(page.events).includes("The engine is currently overloaded"),
      false,
    );
  });

  test("filters Claude interrupt placeholders instead of creating chat notices", () => {
    writeClaudeSession("session-interrupted.jsonl", [
      {
        type: "user",
        uuid: "user-interrupted",
        cwd: workDir,
        sessionId: "session-interrupted",
        timestamp: "2025-07-19T22:33:00.000Z",
        message: {
          content: "请执行一个长任务",
        },
      },
      {
        type: "assistant",
        uuid: "assistant-interrupted",
        cwd: workDir,
        sessionId: "session-interrupted",
        timestamp: "2025-07-19T22:33:01.000Z",
        message: {
          content: [{ type: "text", text: "[Request interrupted by user]" }],
        },
      },
    ]);

    const record = discoverClaudeStoredSessions(workDir)[0];
    assert.ok(record);
    const page = getClaudeStoredSessionHistoryPage({
      sessionId: "rah-session",
      record,
      limit: 100,
    });

    assert.equal(page.events.some((event) => event.type === "turn.canceled"), false);
    assert.equal(
      page.events.some(
        (event) =>
          (event.type === "timeline.item.added" || event.type === "timeline.item.updated") &&
          event.payload.item.kind === "assistant_message" &&
          event.payload.item.text.includes("Request interrupted"),
      ),
      false,
    );
  });

  test("strips Claude turn_aborted context from user messages", () => {
    writeClaudeSession("session-turn-aborted-context.jsonl", [
      {
        type: "user",
        uuid: "user-turn-aborted-context",
        cwd: workDir,
        sessionId: "session-turn-aborted-context",
        timestamp: "2025-07-19T22:35:00.000Z",
        message: {
          content:
            "休眠五秒\n<turn_aborted>\nThe user interrupted the previous turn on purpose.\n</turn_aborted>",
        },
      },
    ]);

    const record = discoverClaudeStoredSessions(workDir).find(
      (session) => session.ref.providerSessionId === "session-turn-aborted-context",
    );
    assert.ok(record);
    const page = getClaudeStoredSessionHistoryPage({
      sessionId: "rah-session",
      record,
      limit: 100,
    });

    const user = page.events.find(
      (event) =>
        event.type === "timeline.item.added" &&
        event.payload.item.kind === "user_message",
    );
    assert.equal(
      user?.type === "timeline.item.added" && user.payload.item.kind === "user_message"
        ? user.payload.item.text
        : null,
      "休眠五秒",
    );
  });

  test("filters Claude no-response placeholders without creating chat notices", () => {
    writeClaudeSession("session-no-response.jsonl", [
      {
        type: "user",
        uuid: "user-no-response",
        cwd: workDir,
        sessionId: "session-no-response",
        timestamp: "2025-07-19T22:34:00.000Z",
        message: {
          content: "启动后马上按 Esc",
        },
      },
      {
        type: "assistant",
        uuid: "assistant-no-response",
        cwd: workDir,
        sessionId: "session-no-response",
        timestamp: "2025-07-19T22:34:01.000Z",
        message: {
          content: [{ type: "text", text: "No response requested." }],
        },
      },
      {
        type: "user",
        uuid: "user-answered",
        cwd: workDir,
        sessionId: "session-no-response",
        timestamp: "2025-07-19T22:34:02.000Z",
        message: {
          content: "正常回答",
        },
      },
      {
        type: "assistant",
        uuid: "assistant-answered",
        cwd: workDir,
        sessionId: "session-no-response",
        timestamp: "2025-07-19T22:34:03.000Z",
        message: {
          content: [{ type: "text", text: "已回答" }],
        },
      },
      {
        type: "assistant",
        uuid: "assistant-no-response-after-answer",
        cwd: workDir,
        sessionId: "session-no-response",
        timestamp: "2025-07-19T22:34:04.000Z",
        message: {
          content: [{ type: "text", text: "No response requested." }],
        },
      },
    ]);

    const record = discoverClaudeStoredSessions(workDir)[0];
    assert.ok(record);
    const page = getClaudeStoredSessionHistoryPage({
      sessionId: "rah-session",
      record,
      limit: 100,
    });
    const canceled = page.events.filter((event) => event.type === "turn.canceled");
    assert.equal(canceled.length, 0);
  });

  test("frozen Claude history loader keeps browsing anchored after newer lines append", () => {
    const lines = Array.from({ length: 400 }, (_, index) => {
      const n = index + 1;
      const minute = String(Math.floor((index * 2) / 60)).padStart(2, "0");
      const userSecond = String((index * 2) % 60).padStart(2, "0");
      const assistantSecond = String((index * 2 + 1) % 60).padStart(2, "0");
      return [
        {
          type: "user",
          uuid: `user-${n}`,
          cwd: workDir,
          sessionId: "session-frozen",
          timestamp: `2025-07-19T22:${minute}:${userSecond}.000Z`,
          message: {
            content: `user ${n}`,
          },
        },
        {
          type: "assistant",
          uuid: `assistant-${n}`,
          cwd: workDir,
          sessionId: "session-frozen",
          timestamp: `2025-07-19T22:${minute}:${assistantSecond}.000Z`,
          message: {
            content: [{ type: "text", text: `assistant ${n}` }],
          },
        },
      ];
    }).flat();
    writeClaudeSession("session-frozen.jsonl", lines);

    const record = findClaudeStoredSessionRecord("session-frozen", workDir);
    assert.ok(record);
    const loader = createClaudeStoredSessionFrozenHistoryPageLoader({
      sessionId: "replay-1",
      record,
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
      ["user 400", "assistant 400"],
    );
    assert.ok(initial.nextCursor);

    const olderBeforeAppend = loader.loadOlderPage(initial.nextCursor!, 2, initial.boundary);

    writeFileSync(
      path.join(projectDir, "session-frozen.jsonl"),
      `${[
        ...lines,
        {
          type: "user",
          uuid: "user-21",
          cwd: workDir,
          sessionId: "session-frozen",
          timestamp: "2025-07-19T22:22:00.000Z",
          message: { content: "user 21" },
        },
        {
          type: "assistant",
          uuid: "assistant-21",
          cwd: workDir,
          sessionId: "session-frozen",
          timestamp: "2025-07-19T22:22:01.000Z",
          message: { content: [{ type: "text", text: "assistant 21" }] },
        },
      ].map((line) => JSON.stringify(line)).join("\n")}\n`,
    );

    const older = loader.loadOlderPage(initial.nextCursor!, 2, initial.boundary);
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
      olderBeforeAppend.events.flatMap((event) => {
        if (
          event.type === "timeline.item.added" &&
          (event.payload.item.kind === "user_message" ||
            event.payload.item.kind === "assistant_message")
        ) {
          return [event.payload.item.text];
        }
        return [];
      }),
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
      ["user 400", "assistant 400"],
    );
  });
});

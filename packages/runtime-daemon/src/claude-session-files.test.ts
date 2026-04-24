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
    }

    const assistantMessages = page.events.filter(
      (event) =>
        event.type === "timeline.item.added" &&
        event.payload.item.kind === "assistant_message",
    );
    assert.ok(
      assistantMessages.some(
        (event) =>
          event.type === "timeline.item.added" &&
          event.payload.item.kind === "assistant_message" &&
          event.payload.item.text === "lol",
      ),
    );
    assert.ok(
      assistantMessages.some(
        (event) =>
          event.type === "timeline.item.added" &&
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
          event.type === "timeline.item.added" &&
          event.payload.item.kind === "assistant_message" &&
          event.payload.item.text.includes("local-command-stdout"),
      ),
      false,
    );
    assert.equal(
      assistantMessages.some(
        (event) =>
          event.type === "timeline.item.added" &&
          event.payload.item.kind === "assistant_message" &&
          event.payload.item.text === "No response requested.",
      ),
      false,
    );
    assert.ok(
      page.events.some(
        (event) =>
          event.type === "notification.emitted" &&
          event.payload.title === "Claude API error" &&
          event.payload.body === "Claude upstream rejected the request",
      ),
    );
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

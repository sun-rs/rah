import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import type { RahEvent } from "@rah/runtime-protocol";
import type { RuntimeServices } from "./provider-adapter";
import { OpenCodeStoredHistoryAdapter } from "./opencode-stored-history-adapter";
import { EventBus } from "./event-bus";
import { PtyHub } from "./pty-hub";
import { SessionStore } from "./session-store";
import {
  createOpenCodeStoredSessionFrozenHistoryPageLoader,
  deleteOpenCodeStoredSessionAsync,
  discoverOpenCodeStoredSessions,
  findOpenCodeStoredSessionRecord,
  findOpenCodeStoredSessionRecordAsync,
  getOpenCodeStoredSessionHistoryPage,
  getOpenCodeStoredSessionTurnDetail,
  getOpenCodeStoredSessionTurnDetailAsync,
  getOpenCodeStoredSessionTurnDirectory,
  getOpenCodeStoredSessionTurnDirectoryAsync,
  getOpenCodeStoredSessionTurnHistoryPage,
  getOpenCodeStoredSessionTurnHistoryPageAsync,
  loadOpenCodeStoredMessages,
  restoreOpenCodeStoredSessionAsync,
  resumeOpenCodeStoredSession,
} from "./opencode-stored-sessions";

const hasSqlite = (() => {
  try {
    execFileSync("sqlite3", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

test("discovers OpenCode stored sessions from opencode.db", { skip: !hasSqlite }, () => {
  const dataDir = createOpenCodeFixture();
  try {
    const sessions = discoverOpenCodeStoredSessions({ dataDir });
    assert.equal(sessions.length, 2);
    assert.deepEqual(sessions[0]!.ref, {
      provider: "opencode",
      providerSessionId: "ses_active",
      modelProvider: "test",
      source: "provider_history",
      removalDisposition: "permanent",
      cwd: "/tmp/project/sub",
      rootDir: "/tmp/project",
      title: "Active session",
      preview: "Assistant answer",
      createdAt: "2026-04-26T16:00:00.000Z",
      updatedAt: "2026-04-26T16:00:05.000Z",
      lastUsedAt: "2026-04-26T16:00:05.000Z",
      historyMeta: {
        bytes: 317,
        messages: 2,
      },
    });
    assert.equal(sessions[1]?.ref.providerSessionId, "ses_archived");
    assert.equal(sessions[1]?.ref.providerState?.archived, true);
    assert.equal(
      sessions[1]?.ref.providerState?.archivedAt,
      "2026-04-26T16:00:05.000Z",
    );
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("uses stable OpenCode stored session preview instead of the latest text part", { skip: !hasSqlite }, () => {
  const dataDir = createOpenCodeFixture({
    assistantText: "First assistant answer",
    laterAssistantText: "Later assistant answer",
  });
  try {
    const sessions = discoverOpenCodeStoredSessions({ dataDir });
    assert.equal(sessions[0]?.ref.preview, "First assistant answer");
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("excludes OpenCode sessions that have never accepted a user message", { skip: !hasSqlite }, async () => {
  const dataDir = createOpenCodeFixture();
  try {
    const databasePath = path.join(dataDir, "opencode.db");
    execFileSync("sqlite3", [
      databasePath,
      `
        insert into session (
          id, project_id, parent_id, directory, title,
          time_created, time_updated, time_archived
        ) values (
          'ses_shell', 'project_active', null, '/tmp/project/sub',
          'Named but empty OpenCode shell', 1, 2, null
        );
      `,
    ]);

    assert.equal(findOpenCodeStoredSessionRecord("ses_shell", { dataDir }), null);
    assert.equal(
      await findOpenCodeStoredSessionRecordAsync("ses_shell", { dataDir }),
      null,
    );
    assert.deepEqual(
      discoverOpenCodeStoredSessions({ dataDir }).map(
        (record) => record.ref.providerSessionId,
      ),
      ["ses_active", "ses_archived"],
    );
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("reuses OpenCode history-size metadata until the provider session revision changes", { skip: !hasSqlite }, () => {
  const dataDir = createOpenCodeFixture();
  try {
    const databasePath = path.join(dataDir, "opencode.db");
    const initialBytes =
      discoverOpenCodeStoredSessions({ dataDir }).find(
        (record) => record.ref.providerSessionId === "ses_active",
      )?.ref.historyMeta?.bytes ?? 0;

    execFileSync("sqlite3", [
      databasePath,
      `
        update part
        set data = json_set(data, '$.text', printf('%.*c', 4096, 'x'))
        where id = 'prt_c_assistant';
      `,
    ]);
    const cachedBytes =
      discoverOpenCodeStoredSessions({ dataDir }).find(
        (record) => record.ref.providerSessionId === "ses_active",
      )?.ref.historyMeta?.bytes ?? 0;
    assert.equal(cachedBytes, initialBytes);

    execFileSync("sqlite3", [
      databasePath,
      `update session set time_updated = time_updated + 1 where id = 'ses_active';`,
    ]);
    const refreshedBytes =
      discoverOpenCodeStoredSessions({ dataDir }).find(
        (record) => record.ref.providerSessionId === "ses_active",
      )?.ref.historyMeta?.bytes ?? 0;
    assert.ok(refreshedBytes > initialBytes);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("discovers the complete OpenCode catalog when no explicit limit is requested", { skip: !hasSqlite }, () => {
  const dataDir = createOpenCodeFixture();
  try {
    const dbPath = path.join(dataDir, "opencode.db");
    execFileSync("sqlite3", [
      dbPath,
      `
        with recursive sequence(value) as (
          select 1
          union all
          select value + 1 from sequence where value < 1005
        )
        insert into session (
          id, project_id, parent_id, directory, title,
          time_created, time_updated, time_archived
        )
        select
          printf('bulk_%04d', value),
          'project_active',
          null,
          '/tmp/project/sub',
          printf('Bulk session %d', value),
          ${Date.parse("2026-04-26T16:00:00.000Z")},
          ${Date.parse("2026-04-26T16:00:05.000Z")},
          null
        from sequence;

        with recursive sequence(value) as (
          select 1
          union all
          select value + 1 from sequence where value < 1005
        )
        insert into message (id, session_id, time_created, time_updated, data)
        select
          printf('bulk_message_%04d', value),
          printf('bulk_%04d', value),
          ${Date.parse("2026-04-26T16:00:00.000Z")},
          ${Date.parse("2026-04-26T16:00:05.000Z")},
          json_object('role', 'user')
        from sequence;
      `,
    ]);

    assert.equal(discoverOpenCodeStoredSessions({ dataDir }).length, 1007);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("loads OpenCode stored messages and materializes history", { skip: !hasSqlite }, () => {
  const dataDir = createOpenCodeFixture();
  try {
    const record = findOpenCodeStoredSessionRecord("ses_active", { dataDir });
    assert.ok(record);

    const messages = loadOpenCodeStoredMessages(record);
    assert.equal(messages.length, 2);
    assert.equal(messages[0]!.info.role, "user");
    assert.equal(messages[0]!.parts[0]!.type, "text");
    assert.equal(messages[1]!.info.role, "assistant");
    assert.equal(messages[1]!.parts[0]!.type, "reasoning");
    assert.equal(messages[1]!.parts[1]!.type, "text");

    const page = getOpenCodeStoredSessionHistoryPage({
      sessionId: "runtime-session",
      record,
      limit: 20,
    });
    assert.equal(page.sessionId, "runtime-session");
    const timelineItems = page.events
      .filter((event) => event.type === "timeline.item.added")
      .map((event) => event.payload.item);
    assert.deepEqual(timelineItems, [
      { kind: "user_message", text: "Hello", messageId: "msg_user" },
      {
        kind: "reasoning",
        text: "Thinking",
        runtimeModel: {
          modelId: "test/test-model",
          source: "native",
        },
      },
      {
        kind: "assistant_message",
        text: "Assistant answer",
        messageId: "msg_assistant",
        runtimeModel: {
          modelId: "test/test-model",
          source: "native",
        },
      },
    ]);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("scopes OpenCode parts to the selected session", { skip: !hasSqlite }, () => {
  const dataDir = createOpenCodeFixture();
  try {
    const record = findOpenCodeStoredSessionRecord("ses_active", { dataDir });
    assert.ok(record);
    execFileSync("sqlite3", [
      record.databasePath,
      `
        insert into part (id, message_id, session_id, time_created, time_updated, data)
        values (
          'prt_foreign',
          'msg_assistant',
          'ses_archived',
          1,
          1,
          ${sqlJson({ type: "text", text: "foreign session text" })}
        );
      `,
    ]);

    const messages = loadOpenCodeStoredMessages(record);
    assert.equal(
      messages.flatMap((message) => message.parts).some(
        (part) => part.type === "text" && part.text === "foreign session text",
      ),
      false,
    );
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("loads a compact OpenCode message summary when requested", { skip: !hasSqlite }, () => {
  const dataDir = createOpenCodeFixture();
  try {
    const record = findOpenCodeStoredSessionRecord("ses_active", { dataDir });
    assert.ok(record);

    const messages = loadOpenCodeStoredMessages(record, { summary: true });
    assert.equal(messages.length, 2);
    assert.deepEqual(
      messages.flatMap((message) => message.parts).map((part) => part.type),
      ["text", "text"],
    );
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("pages OpenCode stored history through a frozen loader", { skip: !hasSqlite }, () => {
  const dataDir = createOpenCodeFixture();
  try {
    const record = findOpenCodeStoredSessionRecord("ses_active", { dataDir });
    assert.ok(record);

    const secondTurnAt = Date.parse("2026-04-26T16:00:10.000Z");
    execFileSync("sqlite3", [
      record.databasePath,
      `
        insert into message (id, session_id, time_created, time_updated, data) values
          ('msg_user_2', 'ses_active', ${secondTurnAt}, ${secondTurnAt}, ${sqlJson({
            role: "user",
            time: { created: secondTurnAt },
          })}),
          ('msg_assistant_2', 'ses_active', ${secondTurnAt + 100}, ${secondTurnAt + 200}, ${sqlJson({
            role: "assistant",
            parentID: "msg_user_2",
            providerID: "test",
            modelID: "test-model",
            finish: "stop",
            time: { created: secondTurnAt + 100, completed: secondTurnAt + 200 },
          })});
        insert into part (id, message_id, session_id, time_created, time_updated, data) values
          ('prt_user_2', 'msg_user_2', 'ses_active', ${secondTurnAt + 1}, ${secondTurnAt + 1}, ${sqlJson({
            type: "text",
            text: "Second question",
          })}),
          ('prt_reasoning_2', 'msg_assistant_2', 'ses_active', ${secondTurnAt + 101}, ${secondTurnAt + 101}, ${sqlJson({
            type: "reasoning",
            text: "Second thinking",
          })}),
          ('prt_assistant_2', 'msg_assistant_2', 'ses_active', ${secondTurnAt + 102}, ${secondTurnAt + 200}, ${sqlJson({
            type: "text",
            text: "Second answer",
          })});
      `,
    ]);

    const loader = createOpenCodeStoredSessionFrozenHistoryPageLoader({
      sessionId: "runtime-session",
      record,
    });
    const first = loader.loadInitialPage(3);
    assert.ok(first.nextCursor);
    assert.deepEqual(
      first.events.flatMap((event) =>
        event.type === "timeline.item.added" &&
        (event.payload.item.kind === "user_message" ||
          event.payload.item.kind === "assistant_message")
          ? [event.payload.item.text]
          : [],
      ),
      ["Second question", "Second answer"],
    );

    const older = loader.loadOlderPage(first.nextCursor, 3, first.boundary);
    const timelineItems = older.events
      .filter((event) => event.type === "timeline.item.added")
      .map((event) => event.payload.item);
    assert.deepEqual(
      timelineItems.filter(
        (item) => item.kind === "user_message" || item.kind === "assistant_message",
      ),
      [
        { kind: "user_message", text: "Hello", messageId: "msg_user" },
        {
          kind: "assistant_message",
          text: "Assistant answer",
          messageId: "msg_assistant",
          runtimeModel: {
            modelId: "test/test-model",
            source: "native",
          },
        },
      ],
    );
    assert.equal(older.nextCursor, undefined);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("pages OpenCode stored history by exact user turns", { skip: !hasSqlite }, () => {
  const dataDir = createOpenCodeFixture();
  try {
    const record = findOpenCodeStoredSessionRecord("ses_active", { dataDir });
    assert.ok(record);

    const secondTurnAt = Date.parse("2026-04-26T16:00:10.000Z");
    execFileSync("sqlite3", [
      record.databasePath,
      `
        insert into message (id, session_id, time_created, time_updated, data) values
          ('msg_user_2', 'ses_active', ${secondTurnAt}, ${secondTurnAt}, ${sqlJson({
            role: "user",
            time: { created: secondTurnAt },
          })}),
          ('msg_assistant_2', 'ses_active', ${secondTurnAt + 100}, ${secondTurnAt + 200}, ${sqlJson({
            role: "assistant",
            parentID: "msg_user_2",
            providerID: "test",
            modelID: "test-model",
            finish: "stop",
            time: { created: secondTurnAt + 100, completed: secondTurnAt + 200 },
          })});
        insert into part (id, message_id, session_id, time_created, time_updated, data) values
          ('prt_user_2', 'msg_user_2', 'ses_active', ${secondTurnAt + 1}, ${secondTurnAt + 1}, ${sqlJson({
            type: "text",
            text: "Second question",
          })}),
          ('prt_assistant_2', 'msg_assistant_2', 'ses_active', ${secondTurnAt + 101}, ${secondTurnAt + 200}, ${sqlJson({
            type: "text",
            text: "Second answer",
          })}),
          ('prt_tool_2', 'msg_assistant_2', 'ses_active', ${secondTurnAt + 102}, ${secondTurnAt + 199}, ${sqlJson({
            type: "tool",
            callID: "call_summary",
            tool: "bash",
            state: {
              status: "completed",
              title: "Runs focused test",
              input: { command: "summary-secret-input" },
              output: "summary-secret-output",
              metadata: {
                output: "summary-secret-metadata-output",
                diff: "summary-secret-diff",
                exit: 1,
                description: "Runs focused test",
              },
            },
          })});
      `,
    ]);

    const latest = getOpenCodeStoredSessionTurnHistoryPage({
      sessionId: "runtime-session",
      record,
      limit: 1,
    });
    assert.ok(latest.nextCursor);
    assert.deepEqual(timelineMessageTexts(latest.events), ["Second question", "Second answer"]);
    const serializedLatest = JSON.stringify(latest);
    assert.doesNotMatch(serializedLatest, /summary-secret/);
    assert.doesNotMatch(serializedLatest, /Runs focused test/);
    assert.doesNotMatch(serializedLatest, /\"exit\":1/);

    const detail = getOpenCodeStoredSessionTurnDetail({
      sessionId: "runtime-session",
      record,
      providerTurnId: "opencode:msg_user_2",
    });
    assert.ok(detail);
    const serializedDetail = JSON.stringify(detail);
    assert.match(serializedDetail, /summary-secret-input/);
    assert.match(serializedDetail, /summary-secret-output/);
    assert.match(serializedDetail, /Runs focused test/);
    assert.match(serializedDetail, /\"exit\":1/);

    const older = getOpenCodeStoredSessionTurnHistoryPage({
      sessionId: "runtime-session",
      record,
      cursor: latest.nextCursor,
      limit: 1,
    });
    assert.equal(older.nextCursor, undefined);
    assert.deepEqual(timelineMessageTexts(older.events), ["Hello", "Assistant answer"]);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test(
  "serves bounded OpenCode interactive history through asynchronous subprocesses",
  { skip: !hasSqlite },
  async () => {
    const assistantText = "x".repeat(24 * 1024);
    const dataDir = createOpenCodeFixture({ assistantText });
    try {
      const record = await findOpenCodeStoredSessionRecordAsync("ses_active", { dataDir });
      assert.ok(record);

      const summary = await getOpenCodeStoredSessionTurnHistoryPageAsync({
        sessionId: "runtime-session",
        record,
        limit: 1,
      });
      const summaryTexts = timelineMessageTexts(summary.events);
      assert.equal(summaryTexts[0], "Hello");
      assert.equal(summaryTexts[1]?.length, 16 * 1024);

      const detail = await getOpenCodeStoredSessionTurnDetailAsync({
        sessionId: "runtime-session",
        record,
        providerTurnId: "opencode:msg_user",
      });
      assert.ok(detail);
      assert.equal(timelineMessageTexts(detail.events)[1], assistantText);

      const directory = await getOpenCodeStoredSessionTurnDirectoryAsync({
        sessionId: "runtime-session",
        record,
      });
      assert.equal(directory.complete, true);
      assert.equal(directory.items.length, 1);
      assert.equal(directory.items[0]?.assistantPreview, "x".repeat(160));
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  },
);

test("builds the OpenCode turn directory from native roots without replaying full parts", { skip: !hasSqlite }, () => {
  const dataDir = createOpenCodeFixture();
  try {
    const record = findOpenCodeStoredSessionRecord("ses_active", { dataDir });
    assert.ok(record);
    const interruptedAt = Date.parse("2026-04-26T16:00:10.000Z");
    execFileSync("sqlite3", [
      record.databasePath,
      `
        insert into message (id, session_id, time_created, time_updated, data) values
          ('msg_internal', 'ses_active', ${interruptedAt - 100}, ${interruptedAt - 100}, ${sqlJson({
            role: "user",
            time: { created: interruptedAt - 100 },
          })}),
          ('msg_interrupted', 'ses_active', ${interruptedAt}, ${interruptedAt}, ${sqlJson({
            role: "user",
            time: { created: interruptedAt },
          })}),
          ('msg_interrupted_assistant', 'ses_active', ${interruptedAt + 100}, ${interruptedAt + 200}, ${sqlJson({
            role: "assistant",
            parentID: "msg_interrupted",
            error: {
              name: "MessageAbortedError",
              data: { message: "The operation was aborted." },
            },
            time: { created: interruptedAt + 100, completed: interruptedAt + 200 },
          })});
        insert into part (id, message_id, session_id, time_created, time_updated, data) values
          ('prt_internal', 'msg_internal', 'ses_active', ${interruptedAt - 99}, ${interruptedAt - 99}, ${sqlJson({
            type: "text",
            text: "<system-reminder>\n[BACKGROUND TASK COMPLETED]\n</system-reminder>",
          })}),
          ('prt_interrupted', 'msg_interrupted', 'ses_active', ${interruptedAt + 1}, ${interruptedAt + 1}, ${sqlJson({
            type: "text",
            text: "Stop this turn",
          })}),
          ('prt_interrupted_assistant', 'msg_interrupted_assistant', 'ses_active', ${interruptedAt + 101}, ${interruptedAt + 101}, ${sqlJson({
            type: "text",
            text: "Partial answer",
          })});
      `,
    ]);

    const directory = getOpenCodeStoredSessionTurnDirectory({
      sessionId: "runtime-session",
      record,
    });
    assert.equal(directory.complete, true);
    assert.deepEqual(
      directory.items.map((item) => ({
        id: item.id,
        userPreview: item.userPreview,
        assistantPreview: item.assistantPreview,
        status: item.status,
      })),
      [
        {
          id: "opencode:msg_user",
          userPreview: "Hello",
          assistantPreview: "Assistant answer",
          status: "completed",
        },
        {
          id: "opencode:msg_interrupted",
          userPreview: "Stop this turn",
          assistantPreview: "Partial answer",
          status: "interrupted",
        },
      ],
    );
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("keeps the live OpenCode database tail in progress", { skip: !hasSqlite }, () => {
  const dataDir = createOpenCodeFixture();
  try {
    const record = findOpenCodeStoredSessionRecord("ses_active", { dataDir });
    assert.ok(record);
    const pendingAt = Date.parse("2026-04-26T16:00:10.000Z");
    execFileSync("sqlite3", [
      record.databasePath,
      `
        insert into message (id, session_id, time_created, time_updated, data)
        values ('msg_pending', 'ses_active', ${pendingAt}, ${pendingAt}, ${sqlJson({
          role: "user",
          time: { created: pendingAt },
        })});
        insert into part (id, message_id, session_id, time_created, time_updated, data)
        values ('prt_pending', 'msg_pending', 'ses_active', ${pendingAt + 1}, ${pendingAt + 1}, ${sqlJson({
          type: "text",
          text: "Still running",
        })});
      `,
    ]);

    const live = getOpenCodeStoredSessionTurnHistoryPage({
      sessionId: "runtime-session",
      record,
      limit: 1,
      finalizeTrailingTurn: false,
    });
    assert.deepEqual(timelineMessageTexts(live.events), ["Still running"]);
    assert.equal(live.events.some((event) => event.type === "turn.completed"), false);

    const settled = getOpenCodeStoredSessionTurnHistoryPage({
      sessionId: "runtime-session",
      record,
      limit: 1,
      finalizeTrailingTurn: true,
    });
    assert.equal(settled.events.some((event) => event.type === "turn.completed"), true);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("rehydrates OpenCode history with the stored-history runtime boundary", { skip: !hasSqlite }, () => {
  const dataDir = createOpenCodeFixture();
  try {
    const record = findOpenCodeStoredSessionRecord("ses_active", { dataDir });
    assert.ok(record);
    const services = {
      eventBus: new EventBus(),
      ptyHub: new PtyHub(),
      sessionStore: new SessionStore(),
    };
    const resumed = resumeOpenCodeStoredSession({ services, record });
    const session = services.sessionStore.getSession(resumed.sessionId)?.session;

    assert.equal(session?.runtime?.kind, "stored_history");
    assert.equal(session?.runtime?.structuredLiveEvents, false);
    assert.equal(session?.runtime?.liveSource, "provider_history");
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("preserves OpenCode stored assistant markdown line breaks and indentation", { skip: !hasSqlite }, () => {
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
  const dataDir = createOpenCodeFixture({ assistantText: markdown });
  try {
    const record = findOpenCodeStoredSessionRecord("ses_active", { dataDir });
    assert.ok(record);

    const page = getOpenCodeStoredSessionHistoryPage({
      sessionId: "runtime-session",
      record,
      limit: 20,
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
    }
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("discovers and restores provider-native OpenCode archives", { skip: !hasSqlite }, async () => {
  const dataDir = createOpenCodeFixture();
  try {
    const record = await findOpenCodeStoredSessionRecordAsync("ses_active", { dataDir });
    assert.ok(record);
    execFileSync("sqlite3", [
      record.databasePath,
      `update session set time_archived = ${Date.now()} where id = 'ses_active';`,
    ]);
    const archived = discoverOpenCodeStoredSessions({ dataDir }).find(
      (entry) => entry.ref.providerSessionId === "ses_active",
    );
    assert.equal(archived?.ref.providerState?.archived, true);
    await restoreOpenCodeStoredSessionAsync(record);
    const restored = discoverOpenCodeStoredSessions({ dataDir }).find(
      (entry) => entry.ref.providerSessionId === "ses_active",
    );
    assert.equal(restored?.ref.providerState, undefined);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("permanently deletes OpenCode sessions through the provider CLI", { skip: !hasSqlite }, async () => {
  const xdgDataHome = mkdtempSync(path.join(os.tmpdir(), "rah-opencode-delete-"));
  const dataDir = path.join(xdgDataHome, "opencode");
  const binDir = path.join(xdgDataHome, "bin");
  const fakeOpenCode = path.join(binDir, "opencode");
  const previousBinary = process.env.RAH_OPENCODE_BINARY;
  mkdirSync(binDir, { recursive: true });
  writeFileSync(
    fakeOpenCode,
    `#!/bin/sh\nsqlite3 "$XDG_DATA_HOME/opencode/opencode.db" "delete from session where id = '$3'"\n`,
    "utf8",
  );
  chmodSync(fakeOpenCode, 0o755);
  process.env.RAH_OPENCODE_BINARY = fakeOpenCode;
  createOpenCodeFixture({ dataDir });
  try {
    const record = await findOpenCodeStoredSessionRecordAsync("ses_active", { dataDir });
    assert.ok(record);
    await deleteOpenCodeStoredSessionAsync(record);
    assert.equal(await findOpenCodeStoredSessionRecordAsync("ses_active", { dataDir }), null);
    assert.ok(await findOpenCodeStoredSessionRecordAsync("ses_archived", { dataDir }));
  } finally {
    if (previousBinary === undefined) {
      delete process.env.RAH_OPENCODE_BINARY;
    } else {
      process.env.RAH_OPENCODE_BINARY = previousBinary;
    }
    rmSync(xdgDataHome, { recursive: true, force: true });
  }
});

test("OpenCode stored history adapter lists only its hydrated cache", { skip: !hasSqlite }, () => {
  const xdgDataHome = mkdtempSync(path.join(os.tmpdir(), "rah-opencode-cache-"));
  const dataDir = path.join(xdgDataHome, "opencode");
  const previousXdgDataHome = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = xdgDataHome;
  createOpenCodeFixture({ dataDir });
  try {
    const adapter = new OpenCodeStoredHistoryAdapter({} as RuntimeServices);
    const records = discoverOpenCodeStoredSessions({ dataDir });
    adapter.hydrateStoredSessionsCatalog(
      records.map((record) => ({
        ref: record.ref,
        storagePath: record.databasePath,
      })),
    );
    const first = adapter.listStoredSessions();
    assert.equal(first.length, 2);

    writeFileSync(path.join(dataDir, "opencode.db"), "not a sqlite database", "utf8");
    assert.deepEqual(adapter.listStoredSessions(), first);
  } finally {
    if (previousXdgDataHome === undefined) {
      delete process.env.XDG_DATA_HOME;
    } else {
      process.env.XDG_DATA_HOME = previousXdgDataHome;
    }
    rmSync(xdgDataHome, { recursive: true, force: true });
  }
});

function createOpenCodeFixture(options: {
  assistantText?: string;
  laterAssistantText?: string;
  dataDir?: string;
} = {}): string {
  const dataDir = options.dataDir ?? mkdtempSync(path.join(os.tmpdir(), "rah-opencode-history-"));
  mkdirSync(dataDir, { recursive: true });
  const dbPath = path.join(dataDir, "opencode.db");
  const created = Date.parse("2026-04-26T16:00:00.000Z");
  const updated = Date.parse("2026-04-26T16:00:05.000Z");
  execFileSync("sqlite3", [
    dbPath,
    fixtureSql(created, updated, {
      assistantText: options.assistantText ?? "Assistant answer",
      laterAssistantText: options.laterAssistantText,
    }),
  ]);
  return dataDir;
}

function fixtureSql(
  created: number,
  updated: number,
  options: {
    assistantText: string;
    laterAssistantText?: string | undefined;
  },
): string {
  return `
    create table project (
      id text primary key,
      worktree text,
      name text,
      time_updated integer
    );
    create table session (
      id text primary key,
      project_id text not null,
      parent_id text,
      directory text,
      title text,
      time_created integer,
      time_updated integer,
      time_archived integer
    );
    create table message (
      id text primary key,
      session_id text,
      time_created integer,
      time_updated integer,
      data text
    );
    create table part (
      id text primary key,
      message_id text,
      session_id text,
      time_created integer,
      time_updated integer,
      data text
    );

    insert into project (id, worktree, name, time_updated)
    values ('project_active', '/tmp/project', null, ${updated});

    insert into session (id, project_id, parent_id, directory, title, time_created, time_updated, time_archived)
    values
      ('ses_active', 'project_active', null, '/tmp/project/sub', 'Active session', ${created}, ${updated}, null),
      ('ses_archived', 'project_active', null, '/tmp/project/sub', 'Archived session', ${created}, ${updated}, ${updated});

    insert into message (id, session_id, time_created, time_updated, data)
    values
      ('msg_user', 'ses_active', ${created + 100}, ${created + 100}, ${sqlJson({
        role: "user",
        time: { created: created + 100 },
      })}),
      ('msg_archived_user', 'ses_archived', ${created + 100}, ${created + 100}, ${sqlJson({
        role: "user",
        time: { created: created + 100 },
      })}),
      ('msg_assistant', 'ses_active', ${created + 200}, ${updated}, ${sqlJson({
        role: "assistant",
        parentID: "msg_user",
        providerID: "test",
        modelID: "test-model",
        finish: "stop",
        time: { created: created + 200, completed: updated },
      })})${options.laterAssistantText ? `,
      ('msg_assistant_later', 'ses_active', ${created + 300}, ${updated}, ${sqlJson({
        role: "assistant",
        parentID: "msg_assistant",
        providerID: "test",
        modelID: "test-model",
        finish: "stop",
        time: { created: created + 300, completed: updated },
      })})` : ""};

    insert into part (id, message_id, session_id, time_created, time_updated, data)
    values
      ('prt_a_user', 'msg_user', 'ses_active', ${created + 101}, ${created + 101}, ${sqlJson({
        type: "text",
        text: "Hello",
      })}),
      ('prt_b_reasoning', 'msg_assistant', 'ses_active', ${created + 201}, ${created + 201}, ${sqlJson({
        type: "reasoning",
        text: "Thinking",
      })}),
      ('prt_c_assistant', 'msg_assistant', 'ses_active', ${created + 202}, ${updated}, ${sqlJson({
        type: "text",
        text: options.assistantText,
      })})${options.laterAssistantText ? `,
      ('prt_d_assistant_later', 'msg_assistant_later', 'ses_active', ${created + 302}, ${updated}, ${sqlJson({
        type: "text",
        text: options.laterAssistantText,
      })})` : ""};
  `;
}

function sqlJson(value: unknown): string {
  return `'${JSON.stringify(value).replace(/'/g, "''")}'`;
}

function timelineMessageTexts(events: readonly RahEvent[]): string[] {
  return events.flatMap((event) =>
    event.type === "timeline.item.added" &&
    (event.payload.item.kind === "user_message" ||
      event.payload.item.kind === "assistant_message")
      ? [event.payload.item.text]
      : [],
  );
}

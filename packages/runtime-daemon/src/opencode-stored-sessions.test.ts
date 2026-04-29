import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import {
  archiveOpenCodeStoredSession,
  createOpenCodeStoredSessionFrozenHistoryPageLoader,
  discoverOpenCodeStoredSessions,
  findOpenCodeStoredSessionRecord,
  getOpenCodeStoredSessionHistoryPage,
  loadOpenCodeStoredMessages,
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
    assert.equal(sessions.length, 1);
    assert.deepEqual(sessions[0]!.ref, {
      provider: "opencode",
      providerSessionId: "ses_active",
      source: "provider_history",
      cwd: "/tmp/project/sub",
      rootDir: "/tmp/project",
      title: "Active session",
      preview: "Assistant answer",
      createdAt: "2026-04-26T16:00:00.000Z",
      updatedAt: "2026-04-26T16:00:05.000Z",
      lastUsedAt: "2026-04-26T16:00:05.000Z",
    });
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
      { kind: "reasoning", text: "Thinking" },
      { kind: "assistant_message", text: "Assistant answer", messageId: "msg_assistant" },
    ]);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("pages OpenCode stored history through a frozen loader", { skip: !hasSqlite }, () => {
  const dataDir = createOpenCodeFixture();
  try {
    const record = findOpenCodeStoredSessionRecord("ses_active", { dataDir });
    assert.ok(record);

    const loader = createOpenCodeStoredSessionFrozenHistoryPageLoader({
      sessionId: "runtime-session",
      record,
    });
    const first = loader.loadInitialPage(3);
    assert.equal(first.events.length, 3);
    assert.ok(first.nextCursor);

    const older = loader.loadOlderPage(first.nextCursor, 3, first.boundary);
    const timelineItems = older.events
      .filter((event) => event.type === "timeline.item.added")
      .map((event) => event.payload.item);
    assert.deepEqual(timelineItems, [
      { kind: "user_message", text: "Hello", messageId: "msg_user" },
    ]);
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

test("archives OpenCode stored sessions so discovery no longer returns them", { skip: !hasSqlite }, () => {
  const dataDir = createOpenCodeFixture();
  try {
    const record = findOpenCodeStoredSessionRecord("ses_active", { dataDir });
    assert.ok(record);
    archiveOpenCodeStoredSession(record);
    assert.deepEqual(discoverOpenCodeStoredSessions({ dataDir }), []);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

function createOpenCodeFixture(options: { assistantText?: string } = {}): string {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "rah-opencode-history-"));
  const dbPath = path.join(dataDir, "opencode.db");
  const created = Date.parse("2026-04-26T16:00:00.000Z");
  const updated = Date.parse("2026-04-26T16:00:05.000Z");
  execFileSync("sqlite3", [
    dbPath,
    fixtureSql(created, updated, options.assistantText ?? "Assistant answer"),
  ]);
  return dataDir;
}

function fixtureSql(created: number, updated: number, assistantText: string): string {
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
      ('msg_assistant', 'ses_active', ${created + 200}, ${updated}, ${sqlJson({
        role: "assistant",
        parentID: "msg_user",
        providerID: "test",
        modelID: "test-model",
        finish: "stop",
        time: { created: created + 200, completed: updated },
      })});

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
        text: assistantText,
      })});
  `;
}

function sqlJson(value: unknown): string {
  return `'${JSON.stringify(value).replace(/'/g, "''")}'`;
}

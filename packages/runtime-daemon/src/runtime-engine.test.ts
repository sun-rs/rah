import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { RuntimeEngine } from "./runtime-engine";

describe("RuntimeEngine", () => {
  let tmpClaudeConfig: string;
  let previousClaudeConfig: string | undefined;
  let workDir: string;
  let projectDir: string;

  beforeEach(() => {
    previousClaudeConfig = process.env.CLAUDE_CONFIG_DIR;
    tmpClaudeConfig = mkdtempSync(path.join(os.tmpdir(), "rah-runtime-claude-"));
    workDir = mkdtempSync(path.join(os.tmpdir(), "rah-runtime-claude-workdir-"));
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

  test("routes claude stored replay through ClaudeAdapter instead of DebugAdapter", async () => {
    writeFileSync(
      path.join(projectDir, "session-1.jsonl"),
      [
        JSON.stringify({
          type: "user",
          uuid: "user-1",
          cwd: workDir,
          sessionId: "session-1",
          timestamp: "2025-07-19T22:21:00.000Z",
          message: { content: "say hi" },
        }),
        JSON.stringify({
          type: "assistant",
          uuid: "assistant-1",
          cwd: workDir,
          sessionId: "session-1",
          timestamp: "2025-07-19T22:21:04.000Z",
          message: { content: [{ type: "text", text: "hello" }] },
        }),
      ].join("\n") + "\n",
    );

    const engine = new RuntimeEngine();
    const sessions = engine.listSessions();
    assert.ok(
      sessions.storedSessions.some(
        (entry) => entry.provider === "claude" && entry.providerSessionId === "session-1",
      ),
    );

    const resumed = await engine.resumeSession({
      provider: "claude",
      providerSessionId: "session-1",
      cwd: workDir,
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

    const page = engine.getSessionHistoryPage(resumed.session.session.id, { limit: 20 });
    assert.ok(
      page.events.some(
        (event) =>
          event.type === "timeline.item.added" &&
          event.payload.item.kind === "assistant_message" &&
          event.payload.item.text === "hello",
      ),
    );

    await engine.shutdown();
  });

  test("listDirectory expands tilde to the current user home directory", async () => {
    const engine = new RuntimeEngine();

    const listing = await engine.listDirectory("~");

    assert.equal(listing.path, os.homedir());

    await engine.shutdown();
  });
});

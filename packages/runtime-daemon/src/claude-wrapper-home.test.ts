import assert from "node:assert/strict";
import { lstatSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { discoverClaudeStoredSessions } from "./claude-session-files";
import { createIsolatedClaudeWrapperHome } from "./claude-wrapper-home";

function writeClaudeSessionFile(filePath: string, sessionId: string, cwd: string) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(
    filePath,
    `${JSON.stringify({
      type: "user",
      uuid: "user-1",
      timestamp: "2026-04-24T01:00:00.000Z",
      cwd,
      sessionId,
      message: {
        role: "user",
        content: "hello from wrapper",
      },
    })}\n`,
    "utf8",
  );
}

describe("claude wrapper home", () => {
  const originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
  let baseHome: string;

  beforeEach(() => {
    baseHome = path.join(os.tmpdir(), `rah-claude-home-${Date.now()}-${Math.random()}`);
    mkdirSync(baseHome, { recursive: true });
    writeFileSync(path.join(baseHome, "settings.json"), "{\"theme\":\"light\"}\n", "utf8");
    mkdirSync(path.join(baseHome, "projects"), { recursive: true });
    process.env.CLAUDE_CONFIG_DIR = baseHome;
  });

  afterEach(() => {
    if (originalClaudeConfigDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR;
    } else {
      process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir;
    }
    rmSync(baseHome, { recursive: true, force: true });
  });

  test("creates an isolated wrapper home with shared config symlinks", () => {
    const wrapperHome = createIsolatedClaudeWrapperHome(baseHome);

    assert.equal(
      lstatSync(path.join(wrapperHome, "settings.json")).isSymbolicLink(),
      true,
    );
    assert.equal(
      lstatSync(path.join(wrapperHome, "projects")).isDirectory(),
      true,
    );
    assert.equal(
      lstatSync(path.join(wrapperHome, "projects")).isSymbolicLink(),
      false,
    );
  });

  test("discovers stored sessions from wrapper homes under the shared claude home", () => {
    writeClaudeSessionFile(
      path.join(baseHome, "projects", "-repo-global", "global-session.jsonl"),
      "global-session",
      "/repo/global",
    );
    const wrapperHome = createIsolatedClaudeWrapperHome(baseHome);
    writeClaudeSessionFile(
      path.join(wrapperHome, "projects", "-repo-wrapper", "wrapper-session.jsonl"),
      "wrapper-session",
      "/repo/wrapper",
    );

    const discovered = discoverClaudeStoredSessions().map((record) => record.ref.providerSessionId);

    assert.equal(discovered.includes("global-session"), true);
    assert.equal(discovered.includes("wrapper-session"), true);
  });
});

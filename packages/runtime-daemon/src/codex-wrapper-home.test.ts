import assert from "node:assert/strict";
import { lstatSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { discoverCodexStoredSessions } from "./codex-stored-sessions";
import { createIsolatedCodexWrapperHome } from "./codex-wrapper-home";

function writeRolloutFile(filePath: string, sessionId: string, cwd: string) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(
    filePath,
    `${JSON.stringify({
      timestamp: "2026-04-23T12:00:00.000Z",
      type: "session_meta",
      payload: {
        id: sessionId,
        timestamp: "2026-04-23T12:00:00.000Z",
        cwd,
        originator: "codex-tui",
      },
    })}\n`,
    "utf8",
  );
}

describe("codex wrapper home", () => {
  const originalCodexHome = process.env.CODEX_HOME;
  let baseHome: string;

  beforeEach(() => {
    baseHome = path.join(os.tmpdir(), `rah-codex-home-${Date.now()}-${Math.random()}`);
    mkdirSync(baseHome, { recursive: true });
    writeFileSync(path.join(baseHome, "auth.json"), "{}", "utf8");
    writeFileSync(path.join(baseHome, "config.toml"), "model = \"gpt-5.4\"\n", "utf8");
    mkdirSync(path.join(baseHome, "sessions"), { recursive: true });
    process.env.CODEX_HOME = baseHome;
  });

  afterEach(() => {
    if (originalCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = originalCodexHome;
    }
    rmSync(baseHome, { recursive: true, force: true });
  });

  test("creates an isolated wrapper home with shared config symlinks", () => {
    const wrapperHome = createIsolatedCodexWrapperHome(baseHome);

    assert.equal(
      lstatSync(path.join(wrapperHome, "auth.json")).isSymbolicLink(),
      true,
    );
    assert.equal(
      lstatSync(path.join(wrapperHome, "config.toml")).isSymbolicLink(),
      true,
    );
    assert.equal(
      lstatSync(path.join(wrapperHome, "sessions")).isDirectory(),
      true,
    );
    assert.equal(
      lstatSync(path.join(wrapperHome, "sessions")).isSymbolicLink(),
      false,
    );
  });

  test("discovers stored sessions from wrapper homes under the shared codex home", () => {
    writeRolloutFile(
      path.join(baseHome, "sessions", "2026", "04", "23", "rollout-global.jsonl"),
      "global-session",
      "/repo/global",
    );
    const wrapperHome = createIsolatedCodexWrapperHome(baseHome);
    writeRolloutFile(
      path.join(wrapperHome, "sessions", "2026", "04", "23", "rollout-wrapper.jsonl"),
      "wrapper-session",
      "/repo/wrapper",
    );

    const discovered = discoverCodexStoredSessions().map((record) => record.ref.providerSessionId);

    assert.equal(discovered.includes("global-session"), true);
    assert.equal(discovered.includes("wrapper-session"), true);
  });
});

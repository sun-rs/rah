import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  nativeTuiResumeLaunchSpec,
  nativeTuiStartLaunchSpec,
} from "./native-tui-launch-spec";

const originalEnv = {
  CODEX_HOME: process.env.CODEX_HOME,
  RAH_CODEX_BINARY: process.env.RAH_CODEX_BINARY,
  RAH_CLAUDE_BINARY: process.env.RAH_CLAUDE_BINARY,
  RAH_GEMINI_BINARY: process.env.RAH_GEMINI_BINARY,
  RAH_KIMI_BINARY: process.env.RAH_KIMI_BINARY,
  RAH_OPENCODE_BINARY: process.env.RAH_OPENCODE_BINARY,
};

afterEach(() => {
  restoreEnv("CODEX_HOME", originalEnv.CODEX_HOME);
  restoreEnv("RAH_CODEX_BINARY", originalEnv.RAH_CODEX_BINARY);
  restoreEnv("RAH_CLAUDE_BINARY", originalEnv.RAH_CLAUDE_BINARY);
  restoreEnv("RAH_GEMINI_BINARY", originalEnv.RAH_GEMINI_BINARY);
  restoreEnv("RAH_KIMI_BINARY", originalEnv.RAH_KIMI_BINARY);
  restoreEnv("RAH_OPENCODE_BINARY", originalEnv.RAH_OPENCODE_BINARY);
});

function restoreEnv(key: keyof typeof originalEnv, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

function fakeBinary(name: string): { dir: string; path: string } {
  const dir = mkdtempSync(path.join(os.tmpdir(), `rah-native-spec-${name}-`));
  const binaryPath = path.join(dir, name);
  writeFileSync(binaryPath, "#!/bin/sh\nexit 0\n");
  chmodSync(binaryPath, 0o755);
  return { dir, path: binaryPath };
}

describe("native TUI launch specs", () => {
  test("builds Codex start in an isolated wrapper home and resumes wrapper sessions from that home", async () => {
    const fake = fakeBinary("codex");
    const baseHome = mkdtempSync(path.join(os.tmpdir(), "rah-native-spec-codex-home-"));
    const providerSessionId = "019de928-7d22-7c63-ba89-dcb25d4a8111";
    process.env.RAH_CODEX_BINARY = fake.path;
    process.env.CODEX_HOME = baseHome;
    try {
      const start = await nativeTuiStartLaunchSpec({
        provider: "codex",
        cwd: "/workspace/demo",
        liveBackend: "native_tui",
      });

      assert.equal(start.command, fake.path);
      assert.deepEqual(start.args, ["--cd", "/workspace/demo"]);
      const codexHome = start.env?.CODEX_HOME;
      assert.ok(codexHome);
      assert.notEqual(codexHome, baseHome);
      assert.equal(
        codexHome.startsWith(path.join(baseHome, "rah_wrappers", "codex-")),
        true,
      );

      const rolloutPath = path.join(
        codexHome,
        "sessions",
        "2026",
        "05",
        "03",
        "rollout-wrapper.jsonl",
      );
      mkdirSync(path.dirname(rolloutPath), { recursive: true });
      writeFileSync(
        rolloutPath,
        `${JSON.stringify({
          timestamp: "2026-05-03T00:00:00.000Z",
          type: "session_meta",
          payload: {
            id: providerSessionId,
            cwd: "/workspace/demo",
            timestamp: "2026-05-03T00:00:00.000Z",
            originator: "codex-tui",
          },
        })}\n`,
        "utf8",
      );

      const resume = await nativeTuiResumeLaunchSpec({
        provider: "codex",
        providerSessionId,
        cwd: "/workspace/demo",
        liveBackend: "native_tui",
      });
      assert.deepEqual(resume.args, ["resume", "--cd", "/workspace/demo", providerSessionId]);
      assert.equal(resume.env?.CODEX_HOME, codexHome);
    } finally {
      rmSync(fake.dir, { force: true, recursive: true });
      rmSync(baseHome, { force: true, recursive: true });
    }
  });

  test("builds Claude start and resume args with native session ids", async () => {
    const fake = fakeBinary("claude");
    process.env.RAH_CLAUDE_BINARY = fake.path;
    try {
      const start = await nativeTuiStartLaunchSpec({
        provider: "claude",
        cwd: "/workspace/demo",
        liveBackend: "native_tui",
        model: "opus",
        optionValues: { effort: "max" },
        modeId: "bypassPermissions",
      });

      assert.equal(start.command, fake.path);
      assert.equal(start.provider, "claude");
      assert.match(start.providerSessionId ?? "", /^[0-9a-f-]{36}$/);
      assert.deepEqual(start.args, [
        "--permission-mode",
        "bypassPermissions",
        "--model",
        "opus",
        "--effort",
        "max",
        "--session-id",
        start.providerSessionId,
      ]);

      const resume = await nativeTuiResumeLaunchSpec({
        provider: "claude",
        providerSessionId: "1fc664f1-6b72-46ed-936f-62b2e099ac45",
        cwd: "/workspace/demo",
        liveBackend: "native_tui",
        modeId: "default",
      });
      assert.deepEqual(resume.args, [
        "--permission-mode",
        "default",
        "--resume",
        "1fc664f1-6b72-46ed-936f-62b2e099ac45",
      ]);
      assert.equal(resume.providerSessionId, "1fc664f1-6b72-46ed-936f-62b2e099ac45");
    } finally {
      rmSync(fake.dir, { force: true, recursive: true });
    }
  });

  test("builds Gemini native args without inventing a new session id", async () => {
    const fake = fakeBinary("gemini");
    process.env.RAH_GEMINI_BINARY = fake.path;
    try {
      const start = await nativeTuiStartLaunchSpec({
        provider: "gemini",
        cwd: "/workspace/demo",
        liveBackend: "native_tui",
        model: "gemini-2.5-pro",
        modeId: "yolo",
      });
      assert.equal(start.providerSessionId, undefined);
      assert.deepEqual(start.args, [
        "--approval-mode",
        "yolo",
        "--model",
        "gemini-2.5-pro",
      ]);

      const resume = await nativeTuiResumeLaunchSpec({
        provider: "gemini",
        providerSessionId: "645e0831-25cf-4e73-87d2-0cb9064eb399",
        cwd: "/workspace/demo",
        liveBackend: "native_tui",
        modeId: "plan",
      });
      assert.deepEqual(resume.args, [
        "--approval-mode",
        "plan",
        "--resume",
        "645e0831-25cf-4e73-87d2-0cb9064eb399",
      ]);
    } finally {
      rmSync(fake.dir, { force: true, recursive: true });
    }
  });

  test("builds Kimi native args with model thinking and permission flags", async () => {
    const fake = fakeBinary("kimi");
    process.env.RAH_KIMI_BINARY = fake.path;
    try {
      const start = await nativeTuiStartLaunchSpec({
        provider: "kimi",
        cwd: "/workspace/demo",
        liveBackend: "native_tui",
        model: "kimi-k2.6",
        optionValues: { model_thinking: "thinking" },
        modeId: "yolo",
      });
      assert.equal(start.command, fake.path);
      assert.match(start.providerSessionId ?? "", /^[0-9a-f-]{36}$/);
      assert.deepEqual(start.args, [
        "--model",
        "kimi-k2.6",
        "--thinking",
        "--yolo",
        "--session",
        start.providerSessionId,
      ]);

      const resume = await nativeTuiResumeLaunchSpec({
        provider: "kimi",
        providerSessionId: "4223a9be-4a4b-46bd-b536-cf2dffc4d77c",
        cwd: "/workspace/demo",
        liveBackend: "native_tui",
        model: "kimi-k2.6",
        reasoningId: "default",
        modeId: "plan",
      });
      assert.deepEqual(resume.args, [
        "--model",
        "kimi-k2.6",
        "--no-thinking",
        "--plan",
        "--session",
        "4223a9be-4a4b-46bd-b536-cf2dffc4d77c",
      ]);
    } finally {
      rmSync(fake.dir, { force: true, recursive: true });
    }
  });

  test("builds OpenCode native args with project, model variant, and session resume", async () => {
    const fake = fakeBinary("opencode");
    process.env.RAH_OPENCODE_BINARY = fake.path;
    try {
      const start = await nativeTuiStartLaunchSpec({
        provider: "opencode",
        cwd: "/workspace/demo",
        liveBackend: "native_tui",
        model: "deepseek/deepseek-v4-pro",
        optionValues: { model_reasoning_variant: "high" },
        modeId: "opencode/full-auto",
      });
      assert.equal(start.command, fake.path);
      assert.equal(start.providerSessionId, undefined);
      assert.deepEqual(start.args, [
        "--model",
        "deepseek/deepseek-v4-pro/high",
        "/workspace/demo",
      ]);

      const resume = await nativeTuiResumeLaunchSpec({
        provider: "opencode",
        providerSessionId: "ses_active",
        cwd: "/workspace/demo",
        liveBackend: "native_tui",
        model: "anthropic/claude-sonnet-4-5",
        reasoningId: "default",
      });
      assert.deepEqual(resume.args, [
        "--model",
        "anthropic/claude-sonnet-4-5",
        "--session",
        "ses_active",
        "/workspace/demo",
      ]);
      assert.equal(resume.providerSessionId, "ses_active");
    } finally {
      rmSync(fake.dir, { force: true, recursive: true });
    }
  });
});

import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  nativeTuiResumeLaunchSpec,
  nativeTuiStartLaunchSpec,
} from "./native-tui-launch-spec";
import type { SessionModeDescriptor } from "@rah/runtime-protocol";

const originalEnv = {
  CODEX_HOME: process.env.CODEX_HOME,
  RAH_CODEX_BINARY: process.env.RAH_CODEX_BINARY,
  RAH_CLAUDE_BINARY: process.env.RAH_CLAUDE_BINARY,
  RAH_GEMINI_BINARY: process.env.RAH_GEMINI_BINARY,
  RAH_OPENCODE_BINARY: process.env.RAH_OPENCODE_BINARY,
  CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
  GEMINI_CLI_SYSTEM_SETTINGS_PATH: process.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH,
  RAH_HOME: process.env.RAH_HOME,
};

afterEach(() => {
  restoreEnv("CODEX_HOME", originalEnv.CODEX_HOME);
  restoreEnv("RAH_CODEX_BINARY", originalEnv.RAH_CODEX_BINARY);
  restoreEnv("RAH_CLAUDE_BINARY", originalEnv.RAH_CLAUDE_BINARY);
  restoreEnv("RAH_GEMINI_BINARY", originalEnv.RAH_GEMINI_BINARY);
  restoreEnv("RAH_OPENCODE_BINARY", originalEnv.RAH_OPENCODE_BINARY);
  restoreEnv("CLAUDE_CONFIG_DIR", originalEnv.CLAUDE_CONFIG_DIR);
  restoreEnv("GEMINI_CLI_SYSTEM_SETTINGS_PATH", originalEnv.GEMINI_CLI_SYSTEM_SETTINGS_PATH);
  restoreEnv("RAH_HOME", originalEnv.RAH_HOME);
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

function openCodeAgentMode(id: string, label = id): SessionModeDescriptor {
  return {
    id,
    role: "custom",
    label,
    applyTiming: "next_turn",
    hotSwitch: true,
  };
}

describe("native TUI launch specs", () => {
  test("builds Codex start and resume without overriding CODEX_HOME", async () => {
    const fake = fakeBinary("codex");
    const providerSessionId = "019de928-7d22-7c63-ba89-dcb25d4a8111";
    process.env.RAH_CODEX_BINARY = fake.path;
    try {
      const start = await nativeTuiStartLaunchSpec({
        provider: "codex",
        cwd: "/workspace/demo",
        liveBackend: "native_tui",
      });

      assert.equal(start.command, fake.path);
      assert.deepEqual(start.args, ["--cd", "/workspace/demo"]);
      assert.equal(start.env, undefined);

      const resume = await nativeTuiResumeLaunchSpec({
        provider: "codex",
        providerSessionId,
        cwd: "/workspace/demo",
        liveBackend: "native_tui",
      });
      assert.deepEqual(resume.args, ["resume", "--cd", "/workspace/demo", providerSessionId]);
      assert.equal(resume.env, undefined);
    } finally {
      rmSync(fake.dir, { force: true, recursive: true });
    }
  });

  test("builds Claude start and resume args with native session ids", async () => {
    const fake = fakeBinary("claude");
    const configDir = mkdtempSync(path.join(os.tmpdir(), "rah-native-spec-claude-config-"));
    const workspace = mkdtempSync(path.join(os.tmpdir(), "rah-native-spec-claude-workspace-"));
    process.env.RAH_CLAUDE_BINARY = fake.path;
    process.env.CLAUDE_CONFIG_DIR = configDir;
    try {
      const start = await nativeTuiStartLaunchSpec({
        provider: "claude",
        cwd: workspace,
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
        "--dangerously-skip-permissions",
        "--model",
        "opus",
        "--effort",
        "max",
        "--session-id",
        start.providerSessionId,
      ]);
      assert.equal(start.modeId, "bypassPermissions");
      assert.equal(start.modelId, "opus");
      assert.equal(start.reasoningId, "max");
      assert.deepEqual(start.optionValues, { effort: "max" });

      const resume = await nativeTuiResumeLaunchSpec({
        provider: "claude",
        providerSessionId: "1fc664f1-6b72-46ed-936f-62b2e099ac45",
        cwd: workspace,
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

      const claudeConfig = JSON.parse(
        readFileSync(path.join(configDir, ".claude.json"), "utf8"),
      ) as { projects?: Record<string, { hasTrustDialogAccepted?: boolean }> };
      assert.equal(
        Object.values(claudeConfig.projects ?? {}).some(
          (project) => project.hasTrustDialogAccepted === true,
        ),
        true,
      );
    } finally {
      rmSync(fake.dir, { force: true, recursive: true });
      rmSync(configDir, { force: true, recursive: true });
      rmSync(workspace, { force: true, recursive: true });
    }
  });

  test("builds Gemini start and resume args with native session ids", async () => {
    const fake = fakeBinary("gemini");
    const workspace = mkdtempSync(path.join(os.tmpdir(), "rah-native-spec-gemini-workspace-"));
    process.env.RAH_GEMINI_BINARY = fake.path;
    try {
      const start = await nativeTuiStartLaunchSpec({
        provider: "gemini",
        cwd: workspace,
        liveBackend: "native_tui",
        model: "gemini-2.5-pro",
        modeId: "yolo",
      });

      assert.equal(start.command, fake.path);
      assert.equal(start.provider, "gemini");
      assert.match(start.providerSessionId ?? "", /^[0-9a-f-]{36}$/);
      assert.deepEqual(start.args, [
        "--approval-mode",
        "yolo",
        "--model",
        "gemini-2.5-pro",
        "--skip-trust",
        "--session-id",
        start.providerSessionId,
      ]);
      assert.equal(start.modeId, "yolo");
      assert.equal(start.modelId, "gemini-2.5-pro");

      const resume = await nativeTuiResumeLaunchSpec({
        provider: "gemini",
        providerSessionId: "6b029ead-4e4f-4b2e-90d8-2cad44a9554f",
        cwd: workspace,
        liveBackend: "native_tui",
        modeId: "default",
      });
      assert.deepEqual(resume.args, [
        "--approval-mode",
        "default",
        "--skip-trust",
        "--resume",
        "6b029ead-4e4f-4b2e-90d8-2cad44a9554f",
      ]);
      assert.equal(resume.providerSessionId, "6b029ead-4e4f-4b2e-90d8-2cad44a9554f");
    } finally {
      rmSync(fake.dir, { force: true, recursive: true });
      rmSync(workspace, { force: true, recursive: true });
    }
  });

  test("builds OpenCode native args with project, base model, and session resume", async () => {
    const fake = fakeBinary("opencode");
    process.env.RAH_OPENCODE_BINARY = fake.path;
    try {
      const start = await nativeTuiStartLaunchSpec({
        provider: "opencode",
        cwd: "/workspace/demo",
        liveBackend: "native_tui",
        model: "deepseek/deepseek-v4-pro",
        optionValues: { model_reasoning_variant: "high" },
        modeId: "plan",
        availableModes: [
          openCodeAgentMode("build", "Build"),
          openCodeAgentMode("plan", "Plan"),
        ],
      });
      assert.equal(start.command, fake.path);
      assert.equal(start.providerSessionId, undefined);
      assert.deepEqual(start.args, [
        "--model",
        "deepseek/deepseek-v4-pro/high",
        "--agent",
        "plan",
        "/workspace/demo",
      ]);
      assert.equal(start.env?.OPENCODE_CONFIG_CONTENT, undefined);
      assert.equal(start.modeId, "plan");
      assert.equal(start.modelId, "deepseek/deepseek-v4-pro");
      assert.equal(start.reasoningId, "high");

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

      const planStart = await nativeTuiStartLaunchSpec({
        provider: "opencode",
        cwd: "/workspace/demo",
        liveBackend: "native_tui",
        modeId: "plan",
        availableModes: [
          openCodeAgentMode("build", "Build"),
          openCodeAgentMode("plan", "Plan"),
        ],
      });
      assert.equal(
        planStart.args.includes("--agent"),
        true,
      );
      assert.deepEqual(planStart.args.slice(0, 2), ["--agent", "plan"]);

      const customStart = await nativeTuiStartLaunchSpec({
        provider: "opencode",
        cwd: "/workspace/demo",
        liveBackend: "native_tui",
        modeId: "sisyfus",
        availableModes: [openCodeAgentMode("sisyfus")],
      });
      assert.deepEqual(customStart.args.slice(0, 2), ["--agent", "sisyfus"]);
    } finally {
      rmSync(fake.dir, { force: true, recursive: true });
    }
  });

  test("rejects native TUI launch modes that cannot be applied by CLI args", async () => {
    const codex = fakeBinary("codex");
    const claude = fakeBinary("claude");
    const gemini = fakeBinary("gemini");
    const opencode = fakeBinary("opencode");
    const workspace = mkdtempSync(path.join(os.tmpdir(), "rah-native-spec-mode-reject-"));
    const configDir = mkdtempSync(path.join(os.tmpdir(), "rah-native-spec-mode-reject-claude-"));
    process.env.RAH_CODEX_BINARY = codex.path;
    process.env.RAH_CLAUDE_BINARY = claude.path;
    process.env.RAH_GEMINI_BINARY = gemini.path;
    process.env.RAH_OPENCODE_BINARY = opencode.path;
    process.env.CLAUDE_CONFIG_DIR = configDir;
    try {
      await assert.rejects(
        nativeTuiStartLaunchSpec({
          provider: "codex",
          cwd: workspace,
          liveBackend: "native_tui",
          modeId: "plan",
        }),
        /Codex plan mode is a native TUI interactive toggle/,
      );
      await assert.rejects(
        nativeTuiStartLaunchSpec({
          provider: "claude",
          cwd: workspace,
          liveBackend: "native_tui",
          modeId: "not-a-mode",
        }),
        /Unsupported Claude launch mode/,
      );
      await assert.rejects(
        nativeTuiStartLaunchSpec({
          provider: "gemini",
          cwd: workspace,
          liveBackend: "native_tui",
          modeId: "not-a-mode",
        }),
        /Unsupported Gemini launch mode/,
      );
      await assert.rejects(
        nativeTuiStartLaunchSpec({
          provider: "opencode",
          cwd: workspace,
          liveBackend: "native_tui",
          modeId: "not-an-agent",
        }),
        /Unsupported OpenCode launch agent/,
      );
      await assert.rejects(
        nativeTuiStartLaunchSpec({
          provider: "opencode",
          cwd: workspace,
          liveBackend: "native_tui",
          modeId: "build",
          availableModes: [openCodeAgentMode("sisyfus")],
        }),
        /Unsupported OpenCode launch agent/,
      );
    } finally {
      rmSync(codex.dir, { force: true, recursive: true });
      rmSync(claude.dir, { force: true, recursive: true });
      rmSync(gemini.dir, { force: true, recursive: true });
      rmSync(opencode.dir, { force: true, recursive: true });
      rmSync(workspace, { force: true, recursive: true });
      rmSync(configDir, { force: true, recursive: true });
    }
  });

  test("injects extra MCP servers into Codex, Claude, Gemini, and OpenCode startup specs", async () => {
    const codex = fakeBinary("codex");
    const claude = fakeBinary("claude");
    const gemini = fakeBinary("gemini");
    const opencode = fakeBinary("opencode");
    const workspace = mkdtempSync(path.join(os.tmpdir(), "rah-native-spec-mcp-workspace-"));
    const configDir = mkdtempSync(path.join(os.tmpdir(), "rah-native-spec-mcp-claude-config-"));
    const rahHome = mkdtempSync(path.join(os.tmpdir(), "rah-native-spec-mcp-rah-home-"));
    process.env.RAH_CODEX_BINARY = codex.path;
    process.env.RAH_CLAUDE_BINARY = claude.path;
    process.env.RAH_GEMINI_BINARY = gemini.path;
    process.env.RAH_OPENCODE_BINARY = opencode.path;
    process.env.CLAUDE_CONFIG_DIR = configDir;
    process.env.RAH_HOME = rahHome;
    const extraMcpServers = [{
      name: "rah council",
      command: process.execPath,
      args: ["/repo/bin/rah.mjs", "council-mcp", "--room", "room-1", "--actor", "codex-lead"],
    }];
    try {
      const codexStart = await nativeTuiStartLaunchSpec({
        provider: "codex",
        cwd: workspace,
        liveBackend: "native_tui",
        extraMcpServers,
        initialPrompt: "join council",
      });
      assert.ok(codexStart.args.includes("mcp_servers.rah_council.command=" + JSON.stringify(process.execPath)));
      assert.ok(codexStart.args.some((arg) => arg.startsWith("mcp_servers.rah_council.args=")));
      assert.equal(codexStart.args.at(-1), "join council");

      const claudeStart = await nativeTuiStartLaunchSpec({
        provider: "claude",
        cwd: workspace,
        liveBackend: "native_tui",
        extraMcpServers,
        initialPrompt: "join council",
      });
      const claudeConfigIndex = claudeStart.args.indexOf("--mcp-config");
      assert.notEqual(claudeConfigIndex, -1);
      const claudeMcpConfigPath = claudeStart.args[claudeConfigIndex + 1]!;
      assert.ok(claudeMcpConfigPath.startsWith(path.join(rahHome, "runtime-daemon", "claude-mcp-configs")));
      const claudeMcpConfig = JSON.parse(readFileSync(claudeMcpConfigPath, "utf8")) as {
        mcpServers?: Record<string, { command?: string; args?: string[] }>;
      };
      assert.equal(claudeMcpConfig.mcpServers?.rah_council?.command, process.execPath);
      assert.deepEqual(claudeMcpConfig.mcpServers?.rah_council?.args?.slice(1, 3), [
        "council-mcp",
        "--room",
      ]);
      assert.equal(claudeStart.args.at(-1), "join council");

      const geminiStart = await nativeTuiStartLaunchSpec({
        provider: "gemini",
        cwd: workspace,
        liveBackend: "native_tui",
        extraMcpServers,
        initialPrompt: "join council",
      });
      assert.deepEqual(geminiStart.args.slice(-2), ["--prompt-interactive", "join council"]);
      const geminiSystemSettingsPath = geminiStart.env?.GEMINI_CLI_SYSTEM_SETTINGS_PATH;
      assert.ok(geminiSystemSettingsPath);
      assert.ok(geminiSystemSettingsPath.startsWith(path.join(rahHome, "runtime-daemon", "gemini-system-settings")));
      const geminiSystemSettings = JSON.parse(readFileSync(geminiSystemSettingsPath, "utf8")) as {
        mcpServers?: Record<string, { command?: string; args?: string[]; trust?: boolean }>;
      };
      assert.equal(geminiSystemSettings.mcpServers?.rah_council?.command, process.execPath);
      assert.deepEqual(geminiSystemSettings.mcpServers?.rah_council?.args?.slice(1, 3), [
        "council-mcp",
        "--room",
      ]);
      assert.equal(geminiSystemSettings.mcpServers?.rah_council?.trust, true);

      const openCodeStart = await nativeTuiStartLaunchSpec({
        provider: "opencode",
        cwd: workspace,
        liveBackend: "native_tui",
        modeId: "build",
        availableModes: [
          openCodeAgentMode("build", "Build"),
          openCodeAgentMode("plan", "Plan"),
        ],
        extraMcpServers,
        initialPrompt: "join council",
      });
      assert.ok(openCodeStart.args.includes("--prompt"));
      assert.ok(openCodeStart.args.includes("join council"));
      const openCodeConfigContent = openCodeStart.env?.OPENCODE_CONFIG_CONTENT;
      assert.ok(openCodeConfigContent);
      const openCodeConfig = JSON.parse(openCodeConfigContent) as {
        default_agent?: string;
        experimental?: { mcp_timeout?: number };
        mcp?: Record<string, { type?: string; command?: string[]; enabled?: boolean; timeout?: number }>;
      };
      assert.equal(openCodeConfig.default_agent, undefined);
      assert.equal(openCodeConfig.experimental?.mcp_timeout, 300_000);
      assert.equal(openCodeConfig.mcp?.rah_council?.type, "local");
      assert.deepEqual(openCodeConfig.mcp?.rah_council?.command?.slice(1, 3), [
        "/repo/bin/rah.mjs",
        "council-mcp",
      ]);
      assert.equal(openCodeConfig.mcp?.rah_council?.enabled, true);
      assert.equal(openCodeConfig.mcp?.rah_council?.timeout, 300_000);
    } finally {
      rmSync(codex.dir, { force: true, recursive: true });
      rmSync(claude.dir, { force: true, recursive: true });
      rmSync(gemini.dir, { force: true, recursive: true });
      rmSync(opencode.dir, { force: true, recursive: true });
      rmSync(workspace, { force: true, recursive: true });
      rmSync(configDir, { force: true, recursive: true });
    }
  });
});

#!/usr/bin/env node

import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_DAEMON_URL = "http://127.0.0.1:43111";
const SUPPORTED_PROVIDERS = new Set(["codex", "claude", "gemini", "kimi", "opencode"]);
const CLAUDE_PERMISSION_MODES = new Set([
  "acceptEdits",
  "auto",
  "bypassPermissions",
  "default",
  "plan",
]);
const GEMINI_APPROVAL_MODES = new Set(["default", "auto_edit", "yolo", "plan"]);
const KIMI_APPROVAL_MODES = new Set(["default", "yolo"]);

function printUsage() {
  process.stdout.write(
    [
      "Usage:",
      "  rah <provider>",
      "  rah <provider> resume <providerSessionId>",
      "",
      "Providers:",
      "  codex | claude | gemini | kimi | opencode",
      "",
      "Options:",
      "  --cwd <dir>         Override working directory",
      "  --daemon-url <url>  Override daemon base URL",
      "  --permission-mode <mode>",
      "                      Claude handoff mode (default: bypassPermissions)",
      "                      Values: default | acceptEdits | auto | bypassPermissions | plan",
      "  --approval-mode <mode>",
      "                      Gemini/Kimi handoff mode (default: yolo)",
      "                      Gemini values: default | auto_edit | yolo | plan",
      "                      Kimi values: default | yolo",
      "  --help              Show this help",
      "",
      "Current status:",
      "  codex: stable live terminal wrapper",
      "  claude: live terminal wrapper",
      "  kimi: live terminal wrapper",
      "  gemini: live terminal wrapper",
      "  opencode: live terminal wrapper via OpenCode server API",
      "",
      "Claude note:",
      "  `rah claude resume <providerSessionId>` maps to `claude --resume <id>`.",
      "  Bare `claude --resume` session-picker mode is intentionally unsupported.",
      "",
    ].join("\n"),
  );
}

function parseArgs(argv) {
  if (argv.length === 0 || argv.includes("--help")) {
    return { help: true };
  }

  const provider = argv[0];
  if (!SUPPORTED_PROVIDERS.has(provider)) {
    throw new Error(`Unsupported provider: ${provider}`);
  }

  let resumeProviderSessionId;
  let cwd = process.cwd();
  let daemonUrl = DEFAULT_DAEMON_URL;
  let claudePermissionMode;
  let geminiApprovalMode;
  let kimiApprovalMode;

  const rest = [...argv.slice(1)];
  if (rest[0] === "resume") {
    rest.shift();
    resumeProviderSessionId = rest.shift();
    if (!resumeProviderSessionId) {
      throw new Error("Missing provider session id after `resume`.");
    }
  }

  while (rest.length > 0) {
    const option = rest.shift();
    if (option === "--cwd") {
      cwd = rest.shift() ?? cwd;
      continue;
    }
    if (option === "--daemon-url") {
      daemonUrl = rest.shift() ?? daemonUrl;
      continue;
    }
    if (option === "--permission-mode") {
      if (provider !== "claude") {
        throw new Error("`--permission-mode` is only supported for `rah claude`.");
      }
      const value = rest.shift();
      if (!value || !CLAUDE_PERMISSION_MODES.has(value)) {
        throw new Error(
          `Unsupported Claude permission mode: ${value ?? "<missing>"}. ` +
            "Use default, acceptEdits, auto, bypassPermissions, or plan.",
        );
      }
      claudePermissionMode = value;
      continue;
    }
    if (option === "--approval-mode") {
      if (provider !== "gemini" && provider !== "kimi") {
        throw new Error("`--approval-mode` is only supported for `rah gemini` and `rah kimi`.");
      }
      const value = rest.shift();
      const supported = provider === "gemini" ? GEMINI_APPROVAL_MODES : KIMI_APPROVAL_MODES;
      if (!value || !supported.has(value)) {
        throw new Error(
          `Unsupported ${provider} approval mode: ${value ?? "<missing>"}. ` +
            (provider === "gemini" ? "Use default, auto_edit, yolo, or plan." : "Use default or yolo."),
        );
      }
      if (provider === "gemini") {
        geminiApprovalMode = value;
      } else {
        kimiApprovalMode = value;
      }
      continue;
    }
    if (option === "--yolo") {
      if (provider !== "gemini" && provider !== "kimi") {
        throw new Error("`--yolo` is only supported for `rah gemini` and `rah kimi`.");
      }
      if (provider === "gemini") {
        geminiApprovalMode = "yolo";
      } else {
        kimiApprovalMode = "yolo";
      }
      continue;
    }
    throw new Error(`Unknown argument: ${option}`);
  }

  return {
    help: false,
    provider,
    cwd: resolve(cwd),
    daemonUrl,
    ...(resumeProviderSessionId ? { resumeProviderSessionId } : {}),
    ...(claudePermissionMode ? { claudePermissionMode } : {}),
    ...(geminiApprovalMode ? { geminiApprovalMode } : {}),
    ...(kimiApprovalMode ? { kimiApprovalMode } : {}),
  };
}

async function daemonReady(daemonUrl) {
  try {
    const response = await fetch(`${daemonUrl}/readyz`);
    if (!response.ok) {
      return false;
    }
    const text = (await response.text()).trim();
    return text === "ok";
  } catch {
    return false;
  }
}

async function ensureDaemon(daemonUrl) {
  if (await daemonReady(daemonUrl)) {
    return;
  }

  const parsedUrl = new URL(daemonUrl);
  const port = parsedUrl.port || (parsedUrl.protocol === "https:" ? "443" : "80");
  const daemonLogPath = `/tmp/rah-daemon-${port}.log`;
  const daemonCommand = [
    "--import",
    "tsx",
    "packages/runtime-daemon/src/main.ts",
  ];
  const child = spawn(process.execPath, daemonCommand, {
    cwd: ROOT_DIR,
    env: {
      ...process.env,
      RAH_PORT: port,
    },
    stdio: "ignore",
    detached: true,
  });
  child.unref();

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (await daemonReady(daemonUrl)) {
      process.stdout.write(`[rah] daemon ready at ${daemonUrl}\n`);
      return;
    }
    await delay(250);
  }

  throw new Error(
    `Timed out waiting for daemon at ${daemonUrl}. Check ${daemonLogPath} for logs.`,
  );
}

function isDaemonConnectionError(error) {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ECONNREFUSED",
  );
}

function formatCliError(error, daemonUrl) {
  if (isDaemonConnectionError(error)) {
    return `RAH daemon is not running at ${daemonUrl}. Start it and try again.`;
  }
  return error instanceof Error ? error.message : String(error);
}

async function main() {
  let parsed;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n`);
    printUsage();
    process.exitCode = 1;
    return;
  }

  if (parsed.help) {
    printUsage();
    return;
  }

  if (parsed.provider === "codex") {
    await ensureDaemon(parsed.daemonUrl);
    const childArgs = [
      "--import",
      "tsx",
      "packages/runtime-daemon/src/codex-terminal-wrapper-handoff.ts",
      "--daemon-url",
      parsed.daemonUrl,
      "--cwd",
      parsed.cwd,
      ...(parsed.resumeProviderSessionId
        ? ["--resume-provider-session-id", parsed.resumeProviderSessionId]
        : []),
    ];
    const child = spawn(process.execPath, childArgs, {
      cwd: ROOT_DIR,
      env: process.env,
      stdio: "inherit",
    });
    await new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("exit", (code, signal) => {
        if (signal) {
          process.kill(process.pid, signal);
          return;
        }
        process.exitCode = code ?? 0;
        resolve(undefined);
      });
    });
    return;
  }

  if (parsed.provider === "claude") {
    await ensureDaemon(parsed.daemonUrl);
    const childArgs = [
      "--import",
      "tsx",
      "packages/runtime-daemon/src/claude-terminal-wrapper.ts",
      "--daemon-url",
      parsed.daemonUrl,
      "--cwd",
      parsed.cwd,
      ...(parsed.resumeProviderSessionId
        ? ["--resume-provider-session-id", parsed.resumeProviderSessionId]
        : []),
      ...(parsed.claudePermissionMode
        ? ["--permission-mode", parsed.claudePermissionMode]
        : []),
    ];
    const child = spawn(process.execPath, childArgs, {
      cwd: ROOT_DIR,
      env: process.env,
      stdio: "inherit",
    });
    await new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("exit", (code, signal) => {
        if (signal) {
          process.kill(process.pid, signal);
          return;
        }
        process.exitCode = code ?? 0;
        resolve(undefined);
      });
    });
    return;
  }

  if (parsed.provider === "kimi") {
    await ensureDaemon(parsed.daemonUrl);
    const childArgs = [
      "--import",
      "tsx",
      "packages/runtime-daemon/src/kimi-terminal-wrapper.ts",
      "--daemon-url",
      parsed.daemonUrl,
      "--cwd",
      parsed.cwd,
      ...(parsed.resumeProviderSessionId
        ? ["--resume-provider-session-id", parsed.resumeProviderSessionId]
        : []),
      ...(parsed.kimiApprovalMode
        ? ["--approval-mode", parsed.kimiApprovalMode]
        : []),
    ];
    const child = spawn(process.execPath, childArgs, {
      cwd: ROOT_DIR,
      env: process.env,
      stdio: "inherit",
    });
    await new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("exit", (code, signal) => {
        if (signal) {
          process.kill(process.pid, signal);
          return;
        }
        process.exitCode = code ?? 0;
        resolve(undefined);
      });
    });
    return;
  }

  if (parsed.provider === "gemini") {
    await ensureDaemon(parsed.daemonUrl);
    const childArgs = [
      "--import",
      "tsx",
      "packages/runtime-daemon/src/gemini-terminal-wrapper.ts",
      "--daemon-url",
      parsed.daemonUrl,
      "--cwd",
      parsed.cwd,
      ...(parsed.resumeProviderSessionId
        ? ["--resume-provider-session-id", parsed.resumeProviderSessionId]
        : []),
      ...(parsed.geminiApprovalMode
        ? ["--approval-mode", parsed.geminiApprovalMode]
        : []),
    ];
    const child = spawn(process.execPath, childArgs, {
      cwd: ROOT_DIR,
      env: process.env,
      stdio: "inherit",
    });
    await new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("exit", (code, signal) => {
        if (signal) {
          process.kill(process.pid, signal);
          return;
        }
        process.exitCode = code ?? 0;
        resolve(undefined);
      });
    });
    return;
  }

  if (parsed.provider === "opencode") {
    await ensureDaemon(parsed.daemonUrl);
    const childArgs = [
      "--import",
      "tsx",
      "packages/runtime-daemon/src/opencode-terminal-wrapper.ts",
      "--daemon-url",
      parsed.daemonUrl,
      "--cwd",
      parsed.cwd,
      ...(parsed.resumeProviderSessionId
        ? ["--resume-provider-session-id", parsed.resumeProviderSessionId]
        : []),
    ];
    const child = spawn(process.execPath, childArgs, {
      cwd: ROOT_DIR,
      env: process.env,
      stdio: "inherit",
    });
    await new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("exit", (code, signal) => {
        if (signal) {
          process.kill(process.pid, signal);
          return;
        }
        process.exitCode = code ?? 0;
        resolve(undefined);
      });
    });
    return;
  }
}

void main().catch((error) => {
  const daemonUrl =
    process.argv.includes("--daemon-url")
      ? process.argv[process.argv.indexOf("--daemon-url") + 1] ?? DEFAULT_DAEMON_URL
      : DEFAULT_DAEMON_URL;
  process.stderr.write(`[rah] ${formatCliError(error, daemonUrl)}\n`);
  process.exitCode = 1;
});

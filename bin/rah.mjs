#!/usr/bin/env node

import { spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, networkInterfaces } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_DAEMON_URL = "http://127.0.0.1:43111";
const SUPPORTED_PROVIDERS = new Set(["codex", "claude", "gemini", "kimi", "opencode"]);
const MANAGEMENT_COMMANDS = new Set(["start", "status", "stop", "restart", "logs"]);
const CLIENT_INDEX_PATH = join(ROOT_DIR, "packages", "client-web", "dist", "index.html");
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
      "  rah start",
      "  rah status",
      "  rah stop",
      "  rah restart",
      "  rah logs [--follow]",
      "  rah <provider>",
      "  rah <provider> resume <providerSessionId>",
      "",
      "Providers:",
      "  codex | claude | gemini | kimi | opencode",
      "",
      "Options:",
      "  --cwd <dir>         Override working directory",
      "  --daemon-url <url>  Override daemon base URL",
      "  --no-build          Skip web build for rah start",
      "  --no-open           Do not open the browser for rah start",
      "  --follow, -f        Follow logs for rah logs",
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
      "Source workflow:",
      "  `rah start` builds the web client, starts the daemon in the background,",
      "  and writes pid/log files under ~/.rah/runtime-daemon.",
      "",
    ].join("\n"),
  );
}

function parseManagementArgs(command, argv) {
  let daemonUrl = DEFAULT_DAEMON_URL;
  let build = command === "start";
  let open = command === "start";
  let follow = false;
  const rest = [...argv];
  while (rest.length > 0) {
    const option = rest.shift();
    if (option === "--daemon-url") {
      daemonUrl = rest.shift() ?? daemonUrl;
      continue;
    }
    if (option === "--build") {
      build = true;
      continue;
    }
    if (option === "--no-build") {
      build = false;
      continue;
    }
    if (option === "--open") {
      open = true;
      continue;
    }
    if (option === "--no-open") {
      open = false;
      continue;
    }
    if (option === "--follow" || option === "-f") {
      follow = true;
      continue;
    }
    throw new Error(`Unknown argument: ${option}`);
  }
  return { command, daemonUrl, build, open, follow };
}

function parseArgs(argv) {
  if (argv.length === 0 || argv.includes("--help")) {
    return { help: true };
  }

  const provider = argv[0];
  if (MANAGEMENT_COMMANDS.has(provider)) {
    return {
      help: false,
      ...parseManagementArgs(provider, argv.slice(1)),
    };
  }

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

function daemonPort(daemonUrl) {
  const parsedUrl = new URL(daemonUrl);
  return parsedUrl.port || (parsedUrl.protocol === "https:" ? "443" : "80");
}

function resolveRahRuntimeHome() {
  return process.env.RAH_HOME ? resolve(process.env.RAH_HOME) : join(homedir(), ".rah", "runtime-daemon");
}

function managedDaemonPaths(daemonUrl) {
  const port = daemonPort(daemonUrl);
  const root = resolveRahRuntimeHome();
  return {
    root,
    port,
    pidPath: join(root, `daemon-${port}.pid`),
    logPath: join(root, `daemon-${port}.log`),
  };
}

function clientBundleExists() {
  return existsSync(CLIENT_INDEX_PATH);
}

function readManagedPid(daemonUrl) {
  const { pidPath } = managedDaemonPaths(daemonUrl);
  try {
    const pid = Number.parseInt(readFileSync(pidPath, "utf8").trim(), 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function runCommand(command, args, options = {}) {
  await new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? ROOT_DIR,
      env: options.env ?? process.env,
      stdio: options.stdio ?? "inherit",
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`${command} exited with signal ${signal}`));
        return;
      }
      if (code && code !== 0) {
        reject(new Error(`${command} exited with code ${code}`));
        return;
      }
      resolvePromise(undefined);
    });
  });
}

async function buildWebClient() {
  process.stdout.write("[rah] building web client...\n");
  await runCommand("npm", ["run", "build:web"], { cwd: ROOT_DIR });
}

function startDaemonDetached(daemonUrl) {
  const { root, port, pidPath, logPath } = managedDaemonPaths(daemonUrl);
  mkdirSync(root, { recursive: true });
  const logFd = openSync(logPath, "a");
  const daemonCommand = [
    "--import",
    "tsx",
    "packages/runtime-daemon/src/main.ts",
  ];
  try {
    const child = spawn(process.execPath, daemonCommand, {
      cwd: ROOT_DIR,
      env: {
        ...process.env,
        RAH_PORT: port,
      },
      stdio: ["ignore", logFd, logFd],
      detached: true,
    });
    writeFileSync(pidPath, `${child.pid}\n`);
    child.unref();
    return child;
  } finally {
    closeSync(logFd);
  }
}

async function ensureDaemon(daemonUrl, options = {}) {
  if (options.build === true || (options.build === "missing" && !clientBundleExists())) {
    await buildWebClient();
  }
  if (await daemonReady(daemonUrl)) {
    if (options.verbose) {
      process.stdout.write(`[rah] daemon already running at ${daemonUrl}\n`);
    }
    return;
  }

  const { logPath } = managedDaemonPaths(daemonUrl);
  const child = startDaemonDetached(daemonUrl);
  let earlyExit = null;
  child.once("exit", (code, signal) => {
    earlyExit = { code, signal };
  });

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (await daemonReady(daemonUrl)) {
      process.stdout.write(`[rah] daemon ready at ${daemonUrl}\n`);
      return;
    }
    if (earlyExit) {
      throw new Error(
        `RAH daemon exited before becoming ready (code ${earlyExit.code ?? "null"}, signal ${
          earlyExit.signal ?? "null"
        }). Check ${logPath}.`,
      );
    }
    await delay(250);
  }

  throw new Error(
    `Timed out waiting for daemon at ${daemonUrl}. Check ${logPath} for logs.`,
  );
}

function localNetworkUrls(daemonUrl) {
  const port = daemonPort(daemonUrl);
  const urls = [];
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && !entry.internal && isPrivateLanIpv4(entry.address)) {
        urls.push(`http://${entry.address}:${port}/`);
      }
    }
  }
  return urls;
}

function isPrivateLanIpv4(address) {
  const parts = address.split(".").map((part) => Number.parseInt(part, 10));
  if (parts.length !== 4 || parts.some((part) => !Number.isFinite(part))) {
    return false;
  }
  const [a, b] = parts;
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

async function printStatus(daemonUrl) {
  const ready = await daemonReady(daemonUrl);
  const pid = readManagedPid(daemonUrl);
  const { pidPath, logPath } = managedDaemonPaths(daemonUrl);
  const bundle = clientBundleExists() ? statSync(CLIENT_INDEX_PATH) : null;
  process.stdout.write(
    [
      `Daemon: ${ready ? "running" : "not running"} (${daemonUrl})`,
      `Managed pid: ${pid ? `${pid}${processAlive(pid) ? "" : " (stale)"}` : "none"}`,
      `Pid file: ${pidPath}`,
      `Log file: ${logPath}`,
      `Web build: ${bundle ? `${CLIENT_INDEX_PATH} (${bundle.mtime.toISOString()})` : "missing"}`,
    ].join("\n") + "\n",
  );
}

async function stopManagedDaemon(daemonUrl) {
  const pid = readManagedPid(daemonUrl);
  const { pidPath } = managedDaemonPaths(daemonUrl);
  if (!pid) {
    if (await daemonReady(daemonUrl)) {
      throw new Error("Daemon is running but has no RAH-managed pid file. Stop the process that started it.");
    }
    process.stdout.write("[rah] daemon is not running\n");
    return;
  }
  if (!processAlive(pid)) {
    try {
      unlinkSync(pidPath);
    } catch {
      // ignore stale pid cleanup failures
    }
    process.stdout.write(`[rah] removed stale daemon pid ${pid}\n`);
    return;
  }
  process.kill(pid, "SIGTERM");
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (!processAlive(pid) && !(await daemonReady(daemonUrl))) {
      break;
    }
    await delay(150);
  }
  if (processAlive(pid)) {
    process.kill(pid, "SIGKILL");
  }
  try {
    unlinkSync(pidPath);
  } catch {
    // ignore cleanup failures
  }
  process.stdout.write(`[rah] stopped daemon ${pid}\n`);
}

function openWorkbench(daemonUrl) {
  const url = `${daemonUrl.replace(/\/$/, "")}/`;
  const command =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "cmd"
        : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(command, args, { stdio: "ignore", detached: true });
  child.unref();
}

async function showLogs(daemonUrl, follow) {
  const { logPath } = managedDaemonPaths(daemonUrl);
  if (!existsSync(logPath)) {
    process.stdout.write(`[rah] log file does not exist yet: ${logPath}\n`);
    return;
  }
  const args = follow ? ["-n", "120", "-f", logPath] : ["-n", "120", logPath];
  await runCommand("tail", args, { cwd: ROOT_DIR });
}

async function handleManagementCommand(parsed) {
  if (parsed.command === "start") {
    await ensureDaemon(parsed.daemonUrl, { build: parsed.build, verbose: true });
    process.stdout.write(`Local: ${parsed.daemonUrl.replace(/\/$/, "")}/\n`);
    const lanUrls = localNetworkUrls(parsed.daemonUrl);
    if (lanUrls.length > 0) {
      process.stdout.write(`LAN: ${lanUrls.join("  ")}\n`);
    }
    if (parsed.open) {
      openWorkbench(parsed.daemonUrl);
    }
    return;
  }
  if (parsed.command === "status") {
    await printStatus(parsed.daemonUrl);
    return;
  }
  if (parsed.command === "stop") {
    await stopManagedDaemon(parsed.daemonUrl);
    return;
  }
  if (parsed.command === "restart") {
    await stopManagedDaemon(parsed.daemonUrl);
    await ensureDaemon(parsed.daemonUrl, { build: parsed.build, verbose: true });
    return;
  }
  if (parsed.command === "logs") {
    await showLogs(parsed.daemonUrl, parsed.follow);
  }
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

  if (parsed.command) {
    await handleManagementCommand(parsed);
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

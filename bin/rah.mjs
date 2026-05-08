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
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import WebSocket from "ws";

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_DAEMON_URL = "http://127.0.0.1:43111";
const CORE_LIVE_PROVIDERS = new Set(["codex", "claude", "opencode"]);
const SUPPORTED_PROVIDERS = CORE_LIVE_PROVIDERS;
const MANAGEMENT_COMMANDS = new Set(["start", "status", "stop", "restart", "logs", "attach"]);
const CLIENT_INDEX_PATH = join(ROOT_DIR, "packages", "client-web", "dist", "index.html");
const TERMINAL_MODE_RESET_SEQUENCE = [
  "\u001b[<1u",
  "\u001b[?1000l",
  "\u001b[?1002l",
  "\u001b[?1003l",
  "\u001b[?1005l",
  "\u001b[?1006l",
  "\u001b[?1015l",
  "\u001b[?1004l",
  "\u001b[?2004l",
  "\u001b[?2026l",
  "\u001b[?25h",
  "\u001b[0m",
].join("");
const CLAUDE_PERMISSION_MODES = new Set([
  "acceptEdits",
  "auto",
  "bypassPermissions",
  "default",
  "plan",
]);

function restoreTerminalApplicationModes(stdout) {
  if (!stdout.isTTY) {
    return;
  }
  stdout.write(TERMINAL_MODE_RESET_SEQUENCE);
  stdout.write("\r");
}

function printUsage() {
  process.stdout.write(
    [
      "Usage:",
      "  rah start",
      "  rah status",
      "  rah stop",
      "  rah restart",
      "  rah logs [--follow]",
      "  rah attach <rahSessionId>",
      "  rah <provider>",
      "  rah <provider> resume <providerSessionId>",
      "",
      "Providers:",
      "  codex | claude | opencode",
      "",
      "Options:",
      "  --cwd <dir>         Override working directory",
      "  --daemon-url <url>  Override daemon base URL",
      "  --mux <backend>     Experimental TUI mux backend (native | zellij)",
      "  --no-build          Skip web build for rah start",
      "  --no-open           Do not open the browser for rah start",
      "  --follow, -f        Follow logs for rah logs",
      "  --permission-mode <mode>",
      "                      Claude native TUI launch mode (default: bypassPermissions)",
      "                      Values: default | acceptEdits | auto | bypassPermissions | plan",
      "  --help              Show this help",
      "",
      "Current status:",
      "  codex/claude/opencode: daemon-owned PTY-first native TUI",
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
  let sessionId;
  const rest = [...argv];
  if (command === "attach") {
    sessionId = rest.shift();
    if (!sessionId) {
      throw new Error("Missing RAH session id after `attach`.");
    }
  }
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
  return { command, daemonUrl, build, open, follow, ...(sessionId ? { sessionId } : {}) };
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
  let muxBackend = process.env.RAH_MUX_BACKEND === "native" ? "native" : "zellij";

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
    if (option === "--mux") {
      const value = rest.shift();
      if (value !== "native" && value !== "zellij") {
        throw new Error("Unsupported mux backend. Use `native` or `zellij`.");
      }
      muxBackend = value;
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
    throw new Error(`Unknown argument: ${option}`);
  }

  return {
    help: false,
    provider,
    cwd: resolve(cwd),
    daemonUrl,
    muxBackend,
    ...(resumeProviderSessionId ? { resumeProviderSessionId } : {}),
    ...(claudePermissionMode ? { claudePermissionMode } : {}),
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
    return;
  }
  if (parsed.command === "attach") {
    await attachExistingRahSession(parsed);
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

function apiUrl(daemonUrl, pathname) {
  return new URL(pathname, daemonUrl).toString();
}

function ptyWebSocketUrl(daemonUrl, sessionId) {
  const url = new URL(daemonUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = `/api/pty/${encodeURIComponent(sessionId)}`;
  url.search = "replay=true";
  return url.toString();
}

async function postJson(daemonUrl, pathname, body) {
  const response = await fetch(apiUrl(daemonUrl, pathname), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-rah-client": "web",
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Request failed: ${response.status} ${response.statusText}${text ? `\n${text}` : ""}`);
  }
  return await response.json();
}

async function getJson(daemonUrl, pathname) {
  const response = await fetch(apiUrl(daemonUrl, pathname), {
    headers: {
      "x-rah-client": "web",
    },
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Request failed: ${response.status} ${response.statusText}${text ? `\n${text}` : ""}`);
  }
  return await response.json();
}

async function findLiveSessionSummary(daemonUrl, sessionId) {
  const response = await getJson(daemonUrl, "/api/sessions");
  return (response.sessions ?? []).find((summary) => summary?.session?.id === sessionId) ?? null;
}

async function liveSessionExists(daemonUrl, sessionId) {
  try {
    return (await findLiveSessionSummary(daemonUrl, sessionId)) !== null;
  } catch {
    return true;
  }
}

function providerModeId(parsed) {
  if (parsed.provider === "claude") {
    return parsed.claudePermissionMode;
  }
  return undefined;
}

function terminalClientDescriptor() {
  const clientId = `terminal:${process.pid}:${Date.now()}`;
  return {
    clientId,
    client: {
      id: clientId,
      kind: "terminal",
      connectionId: `pid:${process.pid}`,
      cols: process.stdout.columns || 100,
      rows: process.stdout.rows || 32,
    },
  };
}

async function startOrResumePtyFirstSession(parsed, client) {
  const modeId = providerModeId(parsed);
  const liveBackend = parsed.muxBackend === "zellij" ? "zellij_tui" : "native_tui";
  if (parsed.resumeProviderSessionId) {
    const result = await postJson(parsed.daemonUrl, "/api/sessions/resume", {
      provider: parsed.provider,
      providerSessionId: parsed.resumeProviderSessionId,
      cwd: parsed.cwd,
      liveBackend,
      ...(modeId ? { modeId } : {}),
      attach: {
        client: client.client,
        mode: "interactive",
        claimControl: true,
      },
    });
    return result.session;
  }
  const result = await postJson(parsed.daemonUrl, "/api/sessions/start", {
    provider: parsed.provider,
    cwd: parsed.cwd,
    liveBackend,
    ...(modeId ? { modeId } : {}),
    attach: {
      client: client.client,
      mode: "interactive",
      claimControl: true,
    },
  });
  return result.session;
}

function managedSessionFromSummary(summary) {
  if (summary?.session?.id) {
    return summary.session;
  }
  // Compatibility for older synthetic tests or callers that returned the
  // ManagedSession directly instead of the canonical SessionSummary envelope.
  if (summary?.id) {
    return summary;
  }
  throw new Error("Daemon returned an invalid session summary.");
}

function ptyIdFromSessionSummary(summary) {
  const session = managedSessionFromSummary(summary);
  return session.nativeTui?.terminalId || session.ptyId || session.id;
}

async function detachPtyFirstClient(daemonUrl, sessionId, clientId) {
  try {
    await postJson(daemonUrl, `/api/sessions/${encodeURIComponent(sessionId)}/detach`, {
      clientId,
    });
  } catch {
    // Detach is best-effort cleanup for a local terminal client. Failure must
    // not close or otherwise disturb the daemon-owned TUI session.
  }
}

function sendPtyResize(socket, sessionId, clientId) {
  if (socket.readyState !== WebSocket.OPEN) {
    return;
  }
  socket.send(JSON.stringify({
    type: "pty.resize",
    sessionId,
    clientId,
    cols: process.stdout.columns || 100,
    rows: process.stdout.rows || 32,
  }));
}

async function attachLocalTerminalToPty(daemonUrl, sessionId, clientId) {
  const socket = new WebSocket(ptyWebSocketUrl(daemonUrl, sessionId));
  const stdin = process.stdin;
  const stdout = process.stdout;
  const canUseRawMode = Boolean(stdin.isTTY && typeof stdin.setRawMode === "function");
  const inputDecoder = new StringDecoder("utf8");
  let cleanedUp = false;

  await new Promise((resolve, reject) => {
    const cleanup = () => {
      if (cleanedUp) {
        return;
      }
      cleanedUp = true;
      stdin.off("data", onInput);
      stdout.off?.("resize", onResize);
      if (canUseRawMode) {
        stdin.setRawMode(false);
      }
      restoreTerminalApplicationModes(stdout);
      stdin.pause();
    };

    const send = (payload) => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(payload));
      }
    };

    const onInput = (chunk) => {
      const data = inputDecoder.write(chunk);
      if (!data) {
        return;
      }
      send({
        type: "pty.input",
        sessionId,
        clientId,
        data,
      });
    };

    const onResize = () => {
      sendPtyResize(socket, sessionId, clientId);
    };

    socket.on("open", () => {
      if (canUseRawMode) {
        stdin.setRawMode(true);
      }
      stdin.resume();
      stdin.on("data", onInput);
      stdout.on?.("resize", onResize);
      sendPtyResize(socket, sessionId, clientId);
    });

    socket.on("message", (raw) => {
      let frame;
      try {
        frame = JSON.parse(raw.toString("utf8"));
      } catch {
        return;
      }
      if (frame.type === "pty.replay") {
        for (const chunk of frame.chunks ?? []) {
          stdout.write(chunk);
        }
        if (frame.status === "exited") {
          cleanup();
          socket.close();
          resolve(undefined);
        }
        return;
      }
      if (frame.type === "pty.output") {
        stdout.write(frame.data);
        return;
      }
      if (frame.type === "pty.exited") {
        cleanup();
        socket.close();
        if (typeof frame.exitCode === "number") {
          process.exitCode = frame.exitCode;
        }
        resolve(undefined);
      }
    });

    socket.on("close", () => {
      cleanup();
      resolve(undefined);
    });

    socket.on("error", (error) => {
      cleanup();
      reject(error);
    });
  });
}

function terminalSurfaceSize() {
  return {
    cols: process.stdout.columns || 100,
    rows: process.stdout.rows || 32,
  };
}

async function claimLocalTuiSurface(daemonUrl, sessionId, client) {
  const size = terminalSurfaceSize();
  await postJson(
    daemonUrl,
    `/api/sessions/${encodeURIComponent(sessionId)}/tui-surface/claim`,
    {
      clientId: client.clientId,
      clientKind: "terminal",
      cols: size.cols,
      rows: size.rows,
    },
  );
}

async function releaseLocalTuiSurface(daemonUrl, sessionId, clientId) {
  try {
    await postJson(
      daemonUrl,
      `/api/sessions/${encodeURIComponent(sessionId)}/tui-surface/release`,
      { clientId },
    );
  } catch {
    // Surface release is best-effort; the session itself remains daemon-owned.
  }
}

async function getTuiSurface(daemonUrl, sessionId) {
  try {
    return await getJson(daemonUrl, `/api/sessions/${encodeURIComponent(sessionId)}/tui-surface`);
  } catch {
    return {};
  }
}

async function waitForLocalZellijReattachKey(daemonUrl, sessionId) {
  const stdin = process.stdin;
  const stdout = process.stdout;
  if (!stdin.isTTY || typeof stdin.setRawMode !== "function") {
    stdout.write(`\r\n[rah] TUI is active in Web. Run \`rah attach ${sessionId}\` to reattach here.\r\n`);
    return false;
  }
  restoreTerminalApplicationModes(stdout);
  stdout.write("\r\n[rah] TUI is active in Web. Press Esc or Enter to reattach here, Ctrl-C to leave.\r\n");
  return await new Promise((resolve) => {
    const cleanup = () => {
      clearInterval(sessionPollTimer);
      stdin.off("data", onInput);
      stdin.setRawMode(false);
      stdin.pause();
    };
    const sessionPollTimer = setInterval(() => {
      void liveSessionExists(daemonUrl, sessionId).then((exists) => {
        if (exists) {
          return;
        }
        cleanup();
        stdout.write("\r\n[rah] Session was archived from another client.\r\n");
        resolve(false);
      });
    }, 750);
    sessionPollTimer.unref?.();
    const onInput = (chunk) => {
      const data = chunk.toString("utf8");
      if (data.includes("\u0003")) {
        cleanup();
        resolve(false);
        return;
      }
      if (data.includes("\u001b") || data.includes("\r") || data.includes("\n")) {
        cleanup();
        resolve(true);
      }
    };
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onInput);
  });
}

async function runZellijAttachUntilExitOrRevoked(daemonUrl, session, client) {
  const child = spawn(
    "zellij",
    [
      "attach",
      session.mux.sessionName,
      "options",
      "--mirror-session",
      "true",
      "--pane-frames",
      "false",
      "--show-startup-tips",
      "false",
    ],
    {
      cwd: session.cwd || ROOT_DIR,
      env: {
        ...process.env,
        ZELLIJ_SOCKET_DIR: session.mux.socketDir,
      },
      stdio: "inherit",
    },
  );
  let revoked = false;
  let sessionGone = false;
  let completed = false;
  const pollTimer = setInterval(() => {
    void (async () => {
      if (!(await liveSessionExists(daemonUrl, session.id))) {
        sessionGone = true;
        child.kill("SIGHUP");
        setTimeout(() => {
          if (!completed) {
            child.kill("SIGTERM");
          }
        }, 500).unref?.();
        return;
      }
      const { surface } = await getTuiSurface(daemonUrl, session.id);
      if (!surface || surface.clientId === client.clientId) {
        return;
      }
      revoked = true;
      child.kill("SIGHUP");
      setTimeout(() => {
        if (!completed) {
          child.kill("SIGTERM");
        }
      }, 500).unref?.();
    })();
  }, 250);
  pollTimer.unref?.();

  return await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      completed = true;
      clearInterval(pollTimer);
      restoreTerminalApplicationModes(process.stdout);
      if (revoked) {
        resolve({ revoked: true });
        return;
      }
      if (sessionGone) {
        resolve({ revoked: false, sessionGone: true });
        return;
      }
      if (signal) {
        resolve({ revoked: false, signal });
        return;
      }
      if (code && code !== 0) {
        reject(new Error(`zellij attach exited with code ${code}`));
        return;
      }
      resolve({ revoked: false });
    });
  });
}

async function attachLocalTerminalToZellij(daemonUrl, session, client) {
  if (!session?.mux || session.mux.backend !== "zellij") {
    throw new Error("Session does not expose zellij mux metadata.");
  }
  while (true) {
    await claimLocalTuiSurface(daemonUrl, session.id, client);
    const result = await runZellijAttachUntilExitOrRevoked(daemonUrl, session, client);
    if (!result.revoked) {
      await releaseLocalTuiSurface(daemonUrl, session.id, client.clientId);
      return;
    }
    const shouldReattach = await waitForLocalZellijReattachKey(daemonUrl, session.id);
    if (!shouldReattach) {
      await releaseLocalTuiSurface(daemonUrl, session.id, client.clientId);
      return;
    }
  }
}

async function attachExistingRahSession(parsed) {
  await ensureDaemon(parsed.daemonUrl);
  const summary = await findLiveSessionSummary(parsed.daemonUrl, parsed.sessionId);
  if (!summary) {
    throw new Error(`No live RAH session found for ${parsed.sessionId}.`);
  }
  const session = managedSessionFromSummary(summary);
  const client = terminalClientDescriptor();
  try {
    if (session.mux?.backend === "zellij") {
      await attachLocalTerminalToZellij(parsed.daemonUrl, session, client);
    } else {
      await attachLocalTerminalToPty(parsed.daemonUrl, ptyIdFromSessionSummary(summary), client.clientId);
    }
  } finally {
    await detachPtyFirstClient(parsed.daemonUrl, session.id, client.clientId);
  }
}

async function runPtyFirstProviderCommand(parsed) {
  await ensureDaemon(parsed.daemonUrl);
  const client = terminalClientDescriptor();
  const summary = await startOrResumePtyFirstSession(parsed, client);
  const session = managedSessionFromSummary(summary);
  const ptyId = ptyIdFromSessionSummary(summary);
  try {
    if (parsed.muxBackend === "zellij" && session.mux?.backend === "zellij") {
      await attachLocalTerminalToZellij(parsed.daemonUrl, session, client);
    } else {
      await attachLocalTerminalToPty(parsed.daemonUrl, ptyId, client.clientId);
    }
  } finally {
    await detachPtyFirstClient(parsed.daemonUrl, session.id, client.clientId);
  }
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

  if (parsed.provider) {
    await runPtyFirstProviderCommand(parsed);
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

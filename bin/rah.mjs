#!/usr/bin/env node

import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocket } from "ws";

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_DAEMON_URL = "http://127.0.0.1:43111";
const SUPPORTED_PROVIDERS = new Set(["codex", "claude", "gemini", "kimi"]);

function printUsage() {
  process.stdout.write(
    [
      "Usage:",
      "  rah <provider>",
      "  rah <provider> resume <providerSessionId>",
      "",
      "Providers:",
      "  codex | claude | gemini | kimi",
      "",
      "Options:",
      "  --cwd <dir>         Override working directory",
      "  --daemon-url <url>  Override daemon base URL",
      "  --help              Show this help",
      "",
      "Current status:",
      "  codex: stable live terminal wrapper",
      "  claude: phase-1 live terminal wrapper in progress",
      "  kimi: phase-1 live terminal wrapper in progress",
      "  gemini: wrapper skeleton only",
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
    throw new Error(`Unknown argument: ${option}`);
  }

  return {
    help: false,
    provider,
    cwd: resolve(cwd),
    daemonUrl,
    ...(resumeProviderSessionId ? { resumeProviderSessionId } : {}),
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

function wrapperControlUrl(daemonUrl) {
  const url = new URL(daemonUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/api/wrapper-control";
  url.search = "";
  return url.toString();
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

  await ensureDaemon(parsed.daemonUrl);

  const socket = new WebSocket(wrapperControlUrl(parsed.daemonUrl));
  let wrapperSessionId = null;
  let closed = false;

  const closeGracefully = () => {
    if (closed) {
      return;
    }
    closed = true;
    if (wrapperSessionId) {
      socket.send(
        JSON.stringify({
          type: "wrapper.exited",
          sessionId: wrapperSessionId,
        }),
      );
    }
    socket.close();
  };

  process.on("SIGINT", () => {
    closeGracefully();
  });
  process.on("SIGTERM", () => {
    closeGracefully();
  });

  socket.on("open", () => {
    const hello = {
      type: "wrapper.hello",
      provider: parsed.provider,
      cwd: parsed.cwd,
      rootDir: parsed.cwd,
      terminalPid: process.pid,
      launchCommand: process.argv.slice(0),
      ...(parsed.resumeProviderSessionId
        ? { resumeProviderSessionId: parsed.resumeProviderSessionId }
        : {}),
    };
    socket.send(JSON.stringify(hello));
  });

  socket.on("message", (raw) => {
    const message = JSON.parse(raw.toString("utf8"));
    if (message.type === "wrapper.ready") {
      wrapperSessionId = message.sessionId;
      process.stdout.write(
        [
          `[rah] wrapper connected`,
          `  sessionId: ${message.sessionId}`,
          `  surfaceId: ${message.surfaceId}`,
          `  operatorGroupId: ${message.operatorGroupId}`,
          `  web: ${parsed.daemonUrl}/`,
          `  note: provider TUI launch is not wired yet in this skeleton`,
          "",
        ].join("\n"),
      );
      socket.send(
        JSON.stringify({
          type: "wrapper.prompt_state.changed",
          sessionId: message.sessionId,
          state: "prompt_clean",
        }),
      );
      return;
    }
    if (message.type === "turn.enqueue") {
      process.stdout.write(
        `[rah] remote turn queued from ${message.queuedTurn.sourceSurfaceId}: ${message.queuedTurn.text}\n`,
      );
      return;
    }
    if (message.type === "turn.inject") {
      process.stdout.write(
        `[rah] remote turn ready to inject: ${message.queuedTurn.text}\n`,
      );
      return;
    }
    if (message.type === "turn.interrupt") {
      process.stdout.write(`[rah] remote interrupt requested\n`);
      return;
    }
    if (message.type === "permission.resolve") {
      process.stdout.write(
        `[rah] remote permission resolved for ${message.requestId}\n`,
      );
      return;
    }
    if (message.error) {
      process.stderr.write(`[rah] ${message.error}\n`);
    }
  });

  socket.on("close", () => {
    if (!closed) {
      process.stderr.write("[rah] wrapper control channel closed\n");
      process.exitCode = 1;
    }
  });

  socket.on("error", (error) => {
    process.stderr.write(`[rah] ${error.message}\n`);
    process.exitCode = 1;
  });
}

void main().catch((error) => {
  const daemonUrl =
    process.argv.includes("--daemon-url")
      ? process.argv[process.argv.indexOf("--daemon-url") + 1] ?? DEFAULT_DAEMON_URL
      : DEFAULT_DAEMON_URL;
  process.stderr.write(`[rah] ${formatCliError(error, daemonUrl)}\n`);
  process.exitCode = 1;
});

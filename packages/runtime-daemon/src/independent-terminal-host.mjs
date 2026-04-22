import * as pty from "node-pty";
import { chmodSync, existsSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import readline from "node:readline";

const require = createRequire(import.meta.url);

function cleanEnv() {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      env[key] = value;
    }
  }
  env.TERM = env.TERM || "xterm-256color";
  return env;
}

function prepareNodePtySpawnHelper() {
  try {
    const packageJsonPath = require.resolve("node-pty/package.json");
    const packageRoot = path.dirname(packageJsonPath);
    for (const helper of [
      path.join(packageRoot, "prebuilds", "darwin-arm64", "spawn-helper"),
      path.join(packageRoot, "prebuilds", "darwin-x64", "spawn-helper"),
    ]) {
      if (existsSync(helper)) {
        chmodSync(helper, 0o755);
      }
    }
  } catch {
    // ignore helper preparation failures
  }
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

prepareNodePtySpawnHelper();

const shell = process.env.SHELL || "/bin/zsh";
const cwd = process.argv[2] || process.env.HOME || "/";
const cols = Number.parseInt(process.argv[3] || "100", 10);
const rows = Number.parseInt(process.argv[4] || "32", 10);

let ptyProcess;
let ready = false;
const pendingWrites = [];
try {
  ptyProcess = pty.spawn(shell, ["-i"], {
    name: "xterm-256color",
    cols,
    rows,
    cwd,
    env: cleanEnv(),
  });
} catch (error) {
  send({
    type: "error",
    message: error instanceof Error ? error.message : String(error),
  });
  process.exit(1);
}

ptyProcess.onData((data) => {
  if (!ready) {
    ready = true;
    while (pendingWrites.length > 0) {
      ptyProcess.write(pendingWrites.shift());
    }
  }
  send({ type: "output", data });
});

ptyProcess.onExit((event) => {
  send({
    type: "exit",
    ...(event.exitCode !== undefined ? { exitCode: event.exitCode } : {}),
    ...(event.signal !== undefined ? { signal: String(event.signal) } : {}),
  });
  process.exit(0);
});

const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

rl.on("line", (line) => {
  if (!line.trim()) {
    return;
  }
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.type === "input" && typeof message.data === "string") {
    if (!ready) {
      pendingWrites.push(message.data);
    } else {
      ptyProcess.write(message.data);
    }
    return;
  }
  if (
    message.type === "resize" &&
    typeof message.cols === "number" &&
    typeof message.rows === "number"
  ) {
    ptyProcess.resize(message.cols, message.rows);
    return;
  }
  if (message.type === "close") {
    ptyProcess.kill();
  }
});

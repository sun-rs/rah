#!/usr/bin/env node

import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
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
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_DAEMON_URL = "http://127.0.0.1:43111";
const DEFAULT_DAEMON_HOST = process.env.RAH_HOST?.trim() || "0.0.0.0";
const MANAGEMENT_COMMANDS = new Set(["start", "status", "stop", "restart", "logs", "pair", "close", "archive"]);
const CLIENT_INDEX_PATH = join(ROOT_DIR, "packages", "client-web", "dist", "index.html");
const VOLATILE_CODEX_PARENT_ENV_KEYS = new Set([
  "CODEX_CI",
  "CODEX_SESSION_ID",
  "CODEX_THREAD_ID",
  "CODEX_TURN_ID",
]);
function printUsage() {
  process.stdout.write(
    [
      "Usage:",
      "  rah start",
      "  rah status",
      "  rah stop",
      "  rah restart",
      "  rah logs [--follow]",
      "  rah pair",
      "  rah close <rahSessionId>",
      "  rah council-mcp --council <councilId> --actor <actorId>",
      "",
      "Options:",
      "  --daemon-url <url>  Override daemon base URL",
      "  --no-build          Skip web build for rah start",
      "  --no-open           Do not open the browser for rah start",
      "  --follow, -f        Follow logs for rah logs",
      "  --help              Show this help",
      "",
      "Source workflow:",
      "  `rah start` builds the web client, starts the daemon in the background,",
      "  and writes pid/log files under ~/.rah/runtime-daemon.",
      "  By default RAH listens on all local interfaces for LAN access.",
      "  Set RAH_HOST=127.0.0.1 to restrict it to this Mac only.",
      "",
    ].join("\n"),
  );
}

function parseManagementArgs(command, argv) {
  let daemonUrl = DEFAULT_DAEMON_URL;
  let daemonUrlExplicit = false;
  let build = command === "start" || command === "restart";
  let open = command === "start";
  let follow = false;
  let sessionId;
  const rest = [...argv];
  if (command === "close" || command === "archive") {
    sessionId = rest.shift();
    if (!sessionId) {
      throw new Error(`Missing RAH session id after \`${command}\`.`);
    }
  }
  while (rest.length > 0) {
    const option = rest.shift();
    if (option === "--daemon-url" || option === "--daemon") {
      daemonUrl = rest.shift() ?? daemonUrl;
      daemonUrlExplicit = true;
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
  return {
    command,
    daemonUrl,
    daemonUrlExplicit,
    build,
    open,
    follow,
    ...(sessionId ? { sessionId } : {}),
  };
}

function parseCouncilMcpArgs(argv) {
  let daemonUrl = DEFAULT_DAEMON_URL;
  let daemonUrlExplicit = false;
  let councilId;
  let actorId;
  const rest = [...argv];
  while (rest.length > 0) {
    const option = rest.shift();
    if (option === "--daemon-url") {
      daemonUrl = rest.shift() ?? daemonUrl;
      daemonUrlExplicit = true;
      continue;
    }
    if (option === "--council") {
      councilId = rest.shift();
      continue;
    }
    if (option === "--actor") {
      actorId = rest.shift();
      continue;
    }
    throw new Error(`Unknown argument: ${option}`);
  }
  if (!councilId || !actorId) {
    throw new Error("rah council-mcp requires --council and --actor.");
  }
  return {
    help: false,
    command: "council-mcp",
    daemonUrl,
    daemonUrlExplicit,
    councilId,
    actorId,
    clientId: `mcp:${actorId}:${randomUUID()}`,
  };
}

function parseArgs(argv) {
  if (argv.length === 0 || argv.includes("--help")) {
    return { help: true };
  }

  const command = argv[0];
  if (command === "council-mcp") {
    return parseCouncilMcpArgs(argv.slice(1));
  }
  if (MANAGEMENT_COMMANDS.has(command)) {
    return {
      help: false,
      ...parseManagementArgs(command, argv.slice(1)),
    };
  }

  throw new Error(`Unsupported command: ${command}`);
}

async function daemonReady(daemonUrl) {
  try {
    const response = await fetch(new URL("/readyz", daemonUrl).toString(), {
      signal: AbortSignal.timeout(1_500),
    });
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

function resolveRahAuthHome() {
  const rahHome = process.env.RAH_HOME ? resolve(process.env.RAH_HOME) : join(homedir(), ".rah");
  return join(rahHome, "auth");
}

function readManagementToken() {
  try {
    const token = readFileSync(join(resolveRahAuthHome(), "management-token"), "utf8").trim();
    return token.length >= 32 ? token : null;
  } catch {
    return null;
  }
}

function managementHeaders(headers = {}) {
  const token = readManagementToken();
  return {
    ...headers,
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
}

function managedDaemonPaths(daemonUrl) {
  const port = daemonPort(daemonUrl);
  const root = resolveRahRuntimeHome();
  return {
    root,
    port,
    pidPath: join(root, `daemon-${port}.pid`),
    lockPath: join(root, `daemon-${port}.lock`),
    logPath: join(root, `daemon-${port}.log`),
  };
}

function clientBundleExists() {
  return existsSync(CLIENT_INDEX_PATH);
}

function readManagedRecord(daemonUrl) {
  const { pidPath } = managedDaemonPaths(daemonUrl);
  try {
    const raw = readFileSync(pidPath, "utf8").trim();
    if (!raw) {
      return null;
    }
    if (raw.startsWith("{")) {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return null;
      }
      const pid = Number.parseInt(String(parsed.pid ?? ""), 10);
      if (!Number.isFinite(pid) || pid <= 0) {
        return null;
      }
      return {
        ...parsed,
        pid,
        legacy: false,
      };
    }
    const pid = Number.parseInt(raw, 10);
    return Number.isFinite(pid) && pid > 0 ? { pid, legacy: true } : null;
  } catch {
    return null;
  }
}

function readManagedPid(daemonUrl) {
  return readManagedRecord(daemonUrl)?.pid ?? null;
}

function writeManagedRecord(daemonUrl, record) {
  const { root, pidPath, port } = managedDaemonPaths(daemonUrl);
  mkdirSync(root, { recursive: true });
  const payload = {
    schemaVersion: 1,
    name: "rah",
    port: Number.parseInt(port, 10),
    daemonUrl,
    rootDir: ROOT_DIR,
    updatedAt: new Date().toISOString(),
    ...record,
  };
  writeFileSync(pidPath, `${JSON.stringify(payload, null, 2)}\n`);
}

function writeManagedIdentity(daemonUrl, identity) {
  writeManagedRecord(daemonUrl, {
    pid: identity.pid,
    runtimeId: identity.runtimeId,
    startedAt: identity.startedAt,
    rootDir: identity.rootDir,
    ...(identity.version ? { version: identity.version } : {}),
    ...(identity.sourceRevision ? { sourceRevision: identity.sourceRevision } : {}),
    ...(typeof identity.sourceDirty === "boolean" ? { sourceDirty: identity.sourceDirty } : {}),
  });
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function processCommand(pid) {
  if (!Number.isInteger(pid) || pid <= 0 || process.platform === "win32") {
    return null;
  }
  try {
    const { stdout } = await execFileAsync("ps", ["-p", String(pid), "-o", "command="], {
      maxBuffer: 1024 * 1024,
    });
    const command = stdout.trim();
    return command || null;
  } catch {
    return null;
  }
}

async function processCwd(pid) {
  if (!Number.isInteger(pid) || pid <= 0 || process.platform === "win32") {
    return null;
  }
  try {
    const { stdout } = await execFileAsync("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], {
      maxBuffer: 1024 * 1024,
    });
    const line = stdout
      .split("\n")
      .find((entry) => entry.startsWith("n/"));
    return line ? line.slice(1) : null;
  } catch {
    return null;
  }
}

async function isRahDaemonPid(pid) {
  const command = await processCommand(pid);
  if (!isRahDaemonCommand(command)) {
    return false;
  }
  const cwd = await processCwd(pid);
  return cwd === ROOT_DIR;
}

function isRahDaemonCommand(command) {
  return Boolean(
    command &&
      command.includes("node") &&
      command.includes("packages/runtime-daemon/src/main.ts"),
  );
}

async function discoverListeningRahDaemonPids(daemonUrl) {
  if (process.platform === "win32") {
    return [];
  }
  const port = daemonPort(daemonUrl);
  let stdout = "";
  try {
    ({ stdout } = await execFileAsync(
      "lsof",
      ["-nP", `-tiTCP:${port}`, "-sTCP:LISTEN"],
      { maxBuffer: 1024 * 1024 },
    ));
  } catch {
    return [];
  }
  const candidates = [
    ...new Set(
      stdout
        .split(/\s+/)
        .map((value) => Number.parseInt(value, 10))
        .filter((value) => Number.isInteger(value) && value > 0),
    ),
  ];
  const rahPids = [];
  for (const pid of candidates) {
    if (await isRahDaemonPid(pid)) {
      rahPids.push(pid);
    }
  }
  return rahPids;
}

function isRuntimeIdentity(value) {
  return Boolean(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      value.name === "rah" &&
      typeof value.runtimeId === "string" &&
      typeof value.pid === "number" &&
      Number.isInteger(value.pid) &&
      value.pid > 0 &&
      typeof value.port === "number" &&
      Number.isInteger(value.port) &&
      typeof value.startedAt === "string" &&
      typeof value.rootDir === "string",
  );
}

function runtimeIdentityMatchesThisRah(identity, daemonUrl) {
  return (
    isRuntimeIdentity(identity) &&
    identity.rootDir === ROOT_DIR &&
    String(identity.port) === daemonPort(daemonUrl)
  );
}

async function fetchRuntimeIdentity(daemonUrl) {
  try {
    const response = await fetch(new URL("/api/runtime", daemonUrl).toString(), {
      headers: managementHeaders(),
      signal: AbortSignal.timeout(1_500),
    });
    if (!response.ok) {
      return null;
    }
    const identity = await response.json();
    return isRuntimeIdentity(identity) ? identity : null;
  } catch {
    return null;
  }
}

async function currentRuntimeIdentity(daemonUrl) {
  const identity = await fetchRuntimeIdentity(daemonUrl);
  if (!identity) {
    return null;
  }
  if (!runtimeIdentityMatchesThisRah(identity, daemonUrl)) {
    throw new Error(
      `Port ${daemonPort(daemonUrl)} is occupied by a different RAH daemon at ${identity.rootDir}.`,
    );
  }
  writeManagedIdentity(daemonUrl, identity);
  return identity;
}

async function syncManagedPidFromListeningDaemon(daemonUrl) {
  const { pidPath } = managedDaemonPaths(daemonUrl);
  const identity = await currentRuntimeIdentity(daemonUrl);
  if (identity) {
    return identity.pid;
  }
  const record = readManagedRecord(daemonUrl);
  const pid = record?.pid ?? null;
  const managedPid =
    pid && processAlive(pid) && (await isRahDaemonPid(pid)) ? pid : null;
  if (pid && !managedPid) {
    try {
      unlinkSync(pidPath);
    } catch {
      // ignore stale pid cleanup failures
    }
  }
  const discovered = await discoverListeningRahDaemonPids(daemonUrl);
  if (managedPid && discovered.includes(managedPid)) {
    if (record?.legacy !== false) {
      writeManagedRecord(daemonUrl, {
        pid: managedPid,
        source: "process-scan",
      });
    }
    return managedPid;
  }
  if (discovered.length !== 1) {
    return managedPid;
  }
  writeManagedRecord(daemonUrl, {
    pid: discovered[0],
    source: "process-scan",
  });
  return discovered[0];
}

async function withDaemonStartLock(daemonUrl, task) {
  const { root, lockPath } = managedDaemonPaths(daemonUrl);
  mkdirSync(root, { recursive: true });
  const deadline = Date.now() + 15_000;
  let lockFd = null;
  while (Date.now() < deadline) {
    try {
      lockFd = openSync(lockPath, "wx");
      writeFileSync(
        lockFd,
        JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }),
      );
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw error;
      }
      try {
        const raw = readFileSync(lockPath, "utf8");
        const lock = JSON.parse(raw);
        const lockPid = Number.parseInt(String(lock.pid ?? ""), 10);
        const createdMs = Date.parse(String(lock.createdAt ?? ""));
        const stale =
          !Number.isInteger(lockPid) ||
          !processAlive(lockPid) ||
          !Number.isFinite(createdMs) ||
          Date.now() - createdMs > 60_000;
        if (stale) {
          unlinkSync(lockPath);
          continue;
        }
      } catch {
        try {
          unlinkSync(lockPath);
          continue;
        } catch {
          // keep waiting if another process won the race
        }
      }
      await delay(100);
    }
  }
  if (lockFd === null) {
    throw new Error("Timed out waiting for RAH daemon start lock.");
  }
  try {
    return await task();
  } finally {
    try {
      closeSync(lockFd);
    } catch {
      // ignore lock fd cleanup failures
    }
    try {
      unlinkSync(lockPath);
    } catch {
      // ignore lock cleanup failures
    }
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
  const { root, port, logPath } = managedDaemonPaths(daemonUrl);
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
      env: daemonEnv(port),
      stdio: ["ignore", logFd, logFd],
      detached: true,
    });
    writeManagedRecord(daemonUrl, {
      pid: child.pid,
      status: "starting",
      launchedAt: new Date().toISOString(),
    });
    child.unref();
    return child;
  } finally {
    closeSync(logFd);
  }
}

function daemonEnv(port) {
  const env = { ...process.env };
  for (const key of VOLATILE_CODEX_PARENT_ENV_KEYS) {
    delete env[key];
  }
  env.RAH_HOST = DEFAULT_DAEMON_HOST;
  env.RAH_PORT = port;
  return env;
}

async function ensureDaemon(daemonUrl, options = {}) {
  const allowUnidentifiedReady = options.allowUnidentifiedReady === true;
  if (options.build === true || (options.build === "missing" && !clientBundleExists())) {
    await buildWebClient();
  }
  const currentIdentity = await currentRuntimeIdentity(daemonUrl);
  if (currentIdentity) {
    if (options.verbose) {
      process.stdout.write(`[rah] daemon already running at ${daemonUrl}\n`);
    }
    return;
  }
  if (await daemonReady(daemonUrl)) {
    const pid = allowUnidentifiedReady ? null : await syncManagedPidFromListeningDaemon(daemonUrl);
    if (!pid && !allowUnidentifiedReady) {
      throw new Error(`Port ${daemonPort(daemonUrl)} is occupied by a daemon that RAH cannot identify.`);
    }
    if (options.verbose) {
      process.stdout.write(`[rah] daemon already running at ${daemonUrl}\n`);
    }
    return;
  }

  await withDaemonStartLock(daemonUrl, async () => {
    const lockedIdentity = await currentRuntimeIdentity(daemonUrl);
    if (lockedIdentity) {
      if (options.verbose) {
        process.stdout.write(`[rah] daemon already running at ${daemonUrl}\n`);
      }
      return;
    }
    if (await daemonReady(daemonUrl)) {
      const pid = allowUnidentifiedReady ? null : await syncManagedPidFromListeningDaemon(daemonUrl);
      if (!pid && !allowUnidentifiedReady) {
        throw new Error(`Port ${daemonPort(daemonUrl)} is occupied by a daemon that RAH cannot identify.`);
      }
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
      const identity = await currentRuntimeIdentity(daemonUrl);
      if (identity || (await daemonReady(daemonUrl))) {
        if (!identity && !allowUnidentifiedReady) {
          await syncManagedPidFromListeningDaemon(daemonUrl);
        }
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
  });
}

function localNetworkUrls(daemonUrl, host = DEFAULT_DAEMON_HOST) {
  const normalizedHost = host.toLowerCase();
  if (
    normalizedHost === "localhost" ||
    normalizedHost === "::1" ||
    normalizedHost.startsWith("127.")
  ) {
    return [];
  }
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
  const identity = await currentRuntimeIdentity(daemonUrl);
  const pid = identity?.pid ?? (await syncManagedPidFromListeningDaemon(daemonUrl));
  const { pidPath, logPath } = managedDaemonPaths(daemonUrl);
  const bundle = clientBundleExists() ? statSync(CLIENT_INDEX_PATH) : null;
  process.stdout.write(
    [
      `Daemon: ${ready ? "running" : "not running"} (${daemonUrl})`,
      `Managed pid: ${pid ? `${pid}${processAlive(pid) ? "" : " (stale)"}` : "none"}`,
      ...(identity
        ? [
            `Runtime id: ${identity.runtimeId}`,
            `Runtime root: ${identity.rootDir}`,
            `Runtime source: ${identity.sourceRevision ?? "unknown"}${identity.sourceDirty ? " (dirty)" : ""}`,
          ]
        : []),
      `Pid file: ${pidPath}`,
      `Log file: ${logPath}`,
      `Web build: ${bundle ? `${CLIENT_INDEX_PATH} (${bundle.mtime.toISOString()})` : "missing"}`,
    ].join("\n") + "\n",
  );
}

async function waitForDaemonStopped(daemonUrl, pids) {
  const deadline = Date.now() + 35_000;
  while (Date.now() < deadline) {
    const anyAlive = pids.some((pid) => processAlive(pid));
    if (!anyAlive && !(await daemonReady(daemonUrl))) {
      return;
    }
    await delay(150);
  }
}

async function terminateDaemonPid(pid) {
  if (!processAlive(pid)) {
    return false;
  }
  process.kill(pid, "SIGTERM");
  return true;
}

async function stopManagedDaemon(daemonUrl) {
  const identity = await currentRuntimeIdentity(daemonUrl);
  if (identity) {
    await stopDaemonPids(daemonUrl, [identity.pid]);
    return;
  }

  const pid = readManagedPid(daemonUrl);
  const { pidPath } = managedDaemonPaths(daemonUrl);
  if (pid && (!processAlive(pid) || !(await isRahDaemonPid(pid)))) {
    try {
      unlinkSync(pidPath);
    } catch {
      // ignore stale pid cleanup failures
    }
    process.stdout.write(`[rah] removed stale daemon pid ${pid}\n`);
  }

  const discovered = await discoverListeningRahDaemonPids(daemonUrl);
  const managedPid =
    pid && processAlive(pid) && (await isRahDaemonPid(pid)) ? pid : null;
  const targetPids = [
    ...new Set(discovered.length > 0 ? discovered : managedPid ? [managedPid] : []),
  ];
  if (targetPids.length === 0) {
    if (await daemonReady(daemonUrl)) {
      throw new Error("Daemon is running but no RAH daemon process could be stopped.");
    }
    process.stdout.write("[rah] daemon is not running\n");
    return;
  }

  await stopDaemonPids(daemonUrl, targetPids);
}

async function stopDaemonPids(daemonUrl, targetPids) {
  const { pidPath } = managedDaemonPaths(daemonUrl);
  const stoppedPids = [];
  for (const targetPid of targetPids) {
    if (await terminateDaemonPid(targetPid)) {
      stoppedPids.push(targetPid);
    }
  }
  if (stoppedPids.length === 0) {
    process.stdout.write("[rah] daemon is not running\n");
    return;
  }
  await waitForDaemonStopped(daemonUrl, stoppedPids);
  for (const stoppedPid of stoppedPids) {
    if (processAlive(stoppedPid)) {
      process.kill(stoppedPid, "SIGKILL");
    }
  }
  try {
    unlinkSync(pidPath);
  } catch {
    // ignore cleanup failures
  }
  process.stdout.write(`[rah] stopped daemon ${stoppedPids.join(", ")}\n`);
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
  if (parsed.command === "pair") {
    const pairing = await postJson(parsed.daemonUrl, "/api/auth/pairing-code", {});
    process.stdout.write(
      [`Pairing code: ${pairing.code}`, `Expires: ${pairing.expiresAt}`].join("\n") + "\n",
    );
    return;
  }
  if (parsed.command === "close" || parsed.command === "archive") {
    await closeRahSession(parsed.daemonUrl, parsed.sessionId);
    process.stdout.write(`[rah] stopped session ${parsed.sessionId}\n`);
    return;
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

async function postJson(daemonUrl, pathname, body) {
  const response = await fetch(apiUrl(daemonUrl, pathname), {
    method: "POST",
    headers: {
      ...managementHeaders({
        "content-type": "application/json",
        "x-rah-client": "web",
      }),
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Request failed: ${response.status} ${response.statusText}${text ? `\n${text}` : ""}`);
  }
  return await response.json();
}

function councilMcpTools() {
  return [
    {
      name: "channel_join",
      description: [
        "Join the RAH council as this actor. Must be called before posting or waiting.",
        "Read recent_messages as private catch-up context, then enter the listening loop with channel_wait_new.",
      ].join(" "),
      inputSchema: { type: "object", additionalProperties: true },
    },
    {
      name: "channel_post",
      description: [
        "Post a text message to the RAH council.",
        "After posting a reply, immediately call channel_wait_new again; do not stop listening after a reply.",
      ].join(" "),
      inputSchema: {
        type: "object",
        properties: { content: { type: "string" }, text: { type: "string" }, reply_to: { type: "number" } },
        additionalProperties: true,
      },
    },
    {
      name: "channel_wait_new",
      description: [
        "Block until a newer message from another participant arrives, or until a heartbeat timeout.",
        "Use this proactively in an infinite listening loop: wait, process message if any, post if needed, then wait again.",
        "If the result has timed_out=true, this is NOT completion and NOT a reason to summarize; immediately call channel_wait_new again.",
        "The loop exits only when the user interrupts you, the council stops, or the tool returns ok=false/error.",
      ].join(" "),
      inputSchema: {
        type: "object",
        properties: {
          since_id: { type: "number" },
          timeout_s: { type: "number" },
          limit: { type: "number" },
        },
        additionalProperties: true,
      },
    },
    {
      name: "channel_history",
      description: "Read recent council messages.",
      inputSchema: {
        type: "object",
        properties: { since_id: { type: "number" }, limit: { type: "number" } },
        additionalProperties: true,
      },
    },
    {
      name: "channel_state",
      description: "Get council state, agents, last message id, claims, and pending controls.",
      inputSchema: { type: "object", additionalProperties: true },
    },
    {
      name: "channel_peek_inbox",
      description: "Non-blocking check for newer messages from other participants.",
      inputSchema: {
        type: "object",
        properties: { since_id: { type: "number" }, limit: { type: "number" } },
        additionalProperties: true,
      },
    },
    {
      name: "channel_set_status",
      description: "Update this actor's council status.",
      inputSchema: {
        type: "object",
        properties: { phase: { type: "string" }, detail: { type: "string" } },
        additionalProperties: true,
      },
    },
    {
      name: "channel_claim_file",
      description: "Claim a file before editing so other agents can avoid conflicts.",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
        additionalProperties: true,
      },
    },
    {
      name: "channel_release_file",
      description: "Release a previously claimed file.",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
        additionalProperties: true,
      },
    },
    {
      name: "channel_list_claims",
      description: "List active file claims in the council.",
      inputSchema: { type: "object", additionalProperties: true },
    },
    {
      name: "channel_send_control",
      description: "Send a control signal to another council participant.",
      inputSchema: {
        type: "object",
        properties: {
          target: { type: "string" },
          action: { type: "string" },
          task_id: { type: "string" },
          data: { type: "object" },
        },
        required: ["target", "action"],
        additionalProperties: true,
      },
    },
    {
      name: "channel_peek_control",
      description: "Non-blocking check for control signals addressed to this actor.",
      inputSchema: { type: "object", additionalProperties: true },
    },
  ];
}

function writeMcpResponse(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: id ?? null, result })}\n`);
}

function writeMcpError(id, error) {
  process.stdout.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: id ?? null,
      error: {
        code: -32000,
        message: error instanceof Error ? error.message : String(error),
      },
    })}\n`,
  );
}

async function runCouncilMcp(parsed) {
  const decoder = new StringDecoder("utf8");
  let buffer = "";
  process.stdin.on("data", (chunk) => {
    buffer += decoder.write(chunk);
    let newlineIndex;
    while ((newlineIndex = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (line) {
        void handleCouncilMcpLine(parsed, line);
      }
    }
  });
  process.stdin.on("end", () => {
    const line = `${buffer}${decoder.end()}`.trim();
    if (line) {
      void handleCouncilMcpLine(parsed, line);
    }
  });
  process.stdin.resume();
}

async function handleCouncilMcpLine(parsed, line) {
  let request;
  try {
    request = JSON.parse(line);
    if (request.method === "initialize") {
      writeMcpResponse(request.id, {
        protocolVersion: request.params?.protocolVersion ?? "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "rah-council", version: "1.0.0" },
      });
      return;
    }
    if (request.method === "notifications/initialized") {
      return;
    }
    if (request.method === "ping") {
      writeMcpResponse(request.id, {});
      return;
    }
    if (request.method === "tools/list") {
      writeMcpResponse(request.id, { tools: councilMcpTools() });
      return;
    }
    if (request.method === "resources/list") {
      writeMcpResponse(request.id, { resources: [] });
      return;
    }
    if (request.method === "prompts/list") {
      writeMcpResponse(request.id, { prompts: [] });
      return;
    }
    if (request.method !== "tools/call") {
      throw new Error(`Unsupported MCP method: ${request.method ?? "<missing>"}`);
    }
    const params = request.params ?? {};
    const response = await postJson(parsed.daemonUrl, "/api/council/mcp", {
      councilId: parsed.councilId,
      actorId: parsed.actorId,
      clientId: parsed.clientId,
      tool: params.name,
      arguments: params.arguments ?? {},
    });
    writeMcpResponse(request.id, {
      content: [{ type: "text", text: JSON.stringify(response.result) }],
      structuredContent: response.result,
    });
  } catch (error) {
    writeMcpError(request?.id, error);
  }
}

function apiClientDescriptor() {
  const clientId = `api:${process.pid}:${Date.now()}`;
  return {
    clientId,
    client: {
      id: clientId,
      kind: "api",
      connectionId: `pid:${process.pid}`,
    },
  };
}

async function closeRahSession(daemonUrl, sessionId) {
  const client = apiClientDescriptor();
  await postJson(daemonUrl, `/api/sessions/${encodeURIComponent(sessionId)}/attach`, {
    client: client.client,
    mode: "interactive",
    claimControl: false,
  });
  await postJson(daemonUrl, `/api/sessions/${encodeURIComponent(sessionId)}/close`, {
    clientId: client.clientId,
  });
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
    if (parsed.command === "council-mcp") {
      await runCouncilMcp(parsed);
      return;
    }
    await handleManagementCommand(parsed);
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

import { closeSync, constants, openSync, readSync, statSync } from "node:fs";
import { access } from "node:fs/promises";
import path from "node:path";
import { runBackgroundCommand } from "./background-command";

function containsPathSeparator(value: string): boolean {
  return value.includes("/") || value.includes("\\");
}

const FALLBACK_BINARY_DIRS = [
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/opt/local/bin",
  "/usr/bin",
  "/bin",
];

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

async function isExecutableFile(filePath: string): Promise<boolean> {
  try {
    const stats = statSync(filePath);
    if (!stats.isFile()) {
      return false;
    }
    await access(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function findCommandInPath(command: string): Promise<string | null> {
  const pathDirs = (process.env.PATH ?? "")
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);
  const candidates = [...new Set([...pathDirs, ...FALLBACK_BINARY_DIRS])];
  for (const dir of candidates) {
    const candidate = path.join(dir, command);
    if (await isExecutableFile(candidate)) {
      return candidate;
    }
  }
  return null;
}

async function findCommandFromLoginShell(command: string): Promise<string | null> {
  if (process.platform === "win32") {
    return null;
  }
  try {
    const result = await runBackgroundCommand({
      command: "/bin/zsh",
      args: ["-lc", `command -v ${shellQuote(command)}`],
      label: "provider binary lookup",
      timeoutMs: 2_000,
      maxStdoutBytes: 8_192,
      maxStderrBytes: 8_192,
    });
    const candidate = result.stdout.trim().split(/\r?\n/)[0];
    if (!candidate || !path.isAbsolute(candidate)) {
      return null;
    }
    return (await isExecutableFile(candidate)) ? candidate : null;
  } catch {
    return null;
  }
}

async function resolveBareCommand(command: string): Promise<string | null> {
  return (await findCommandInPath(command)) ?? (await findCommandFromLoginShell(command));
}

function missingExecutableMessage(envVar: string, command: string): string {
  return `Could not find executable '${command}'. Install it or set ${envVar} to a valid executable path.`;
}

export async function resolveConfiguredBinary(
  envVar: string,
  fallback: string,
): Promise<string> {
  const raw = process.env[envVar]?.trim();
  if (!raw) {
    const resolved = await resolveBareCommand(fallback);
    if (!resolved) {
      throw new Error(missingExecutableMessage(envVar, fallback));
    }
    return resolved;
  }
  if (!containsPathSeparator(raw)) {
    const resolved = await resolveBareCommand(raw);
    if (!resolved) {
      throw new Error(missingExecutableMessage(envVar, raw));
    }
    return resolved;
  }
  if (!path.isAbsolute(raw)) {
    throw new Error(`${envVar} must be a bare command or absolute path.`);
  }
  let isFile = false;
  try {
    isFile = statSync(raw).isFile();
  } catch {
    isFile = false;
  }
  if (!isFile) {
    throw new Error(`${envVar} must point to an executable file.`);
  }
  await access(raw, constants.X_OK);
  return raw;
}

function readShebang(binary: string): string | undefined {
  if (!path.isAbsolute(binary)) {
    return undefined;
  }
  let fd: number | undefined;
  try {
    fd = openSync(binary, "r");
    const buffer = Buffer.allocUnsafe(512);
    const bytesRead = readSync(fd, buffer, 0, buffer.length, 0);
    const firstLine = buffer.subarray(0, bytesRead).toString("utf8").split(/\r?\n/, 1)[0];
    return firstLine?.startsWith("#!") ? firstLine.slice(2).trim() : undefined;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      closeSync(fd);
    }
  }
}

function shebangArgv(binary: string, shebang: string): string[] | undefined {
  const parts = shebang.split(/\s+/).filter(Boolean);
  const interpreter = parts.shift();
  if (!interpreter) {
    return undefined;
  }
  if (path.basename(interpreter) === "env" && parts[0] === "-S") {
    parts.shift();
  }
  return [interpreter, ...parts, binary];
}

export function providerBinaryArgv(binary: string): string[] {
  const shebang = readShebang(binary);
  if (shebang) {
    return shebangArgv(binary, shebang) ?? [binary];
  }
  if (path.isAbsolute(binary) && /\.(?:cjs|mjs|js)$/i.test(binary)) {
    return [process.execPath, binary];
  }
  return [binary];
}

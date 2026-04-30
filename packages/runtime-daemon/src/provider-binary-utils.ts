import { constants, statSync } from "node:fs";
import { access } from "node:fs/promises";
import { execFile } from "node:child_process";
import path from "node:path";

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
  return await new Promise((resolve) => {
    const child = execFile(
      "/bin/zsh",
      ["-lc", `command -v ${shellQuote(command)}`],
      { timeout: 2_000, maxBuffer: 8_192 },
      async (error, stdout) => {
        if (error) {
          resolve(null);
          return;
        }
        const candidate = stdout.trim().split(/\r?\n/)[0];
        if (!candidate || !path.isAbsolute(candidate)) {
          resolve(null);
          return;
        }
        resolve((await isExecutableFile(candidate)) ? candidate : null);
      },
    );
    child.stdin?.destroy();
  });
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

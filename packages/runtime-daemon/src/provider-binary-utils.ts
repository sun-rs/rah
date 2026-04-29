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

export async function resolveConfiguredBinary(
  envVar: string,
  fallback: string,
): Promise<string> {
  const raw = process.env[envVar]?.trim();
  if (!raw) {
    return (await resolveBareCommand(fallback)) ?? fallback;
  }
  if (!containsPathSeparator(raw)) {
    return (await resolveBareCommand(raw)) ?? raw;
  }
  if (!path.isAbsolute(raw)) {
    throw new Error(`${envVar} must be a bare command or absolute path.`);
  }
  const stats = statSync(raw);
  if (!stats.isFile()) {
    throw new Error(`${envVar} must point to an executable file.`);
  }
  await access(raw, constants.X_OK);
  return raw;
}

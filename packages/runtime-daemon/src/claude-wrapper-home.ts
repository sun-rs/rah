import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  symlinkSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

const WRAPPER_HOMES_DIRNAME = "rah_wrappers";
const ISOLATED_ENTRY_NAMES = new Set([
  "backups",
  "cache",
  "history.jsonl",
  "projects",
  "rah_wrappers",
  "session-env",
  "sessions",
  "shell-snapshots",
]);
const ISOLATED_DIRECTORIES = [
  "backups",
  "cache",
  "projects",
  "session-env",
  "sessions",
  "shell-snapshots",
] as const;

export function resolveClaudeBaseHome(): string {
  return process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude");
}

export function resolveClaudeWrapperHomesRoot(baseHome = resolveClaudeBaseHome()): string {
  return path.join(baseHome, WRAPPER_HOMES_DIRNAME);
}

export function listClaudeWrapperHomes(baseHome = resolveClaudeBaseHome()): string[] {
  const root = resolveClaudeWrapperHomesRoot(baseHome);
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(root, entry.name));
  } catch {
    return [];
  }
}

export function createIsolatedClaudeWrapperHome(baseHome = resolveClaudeBaseHome()): string {
  const wrapperHomesRoot = resolveClaudeWrapperHomesRoot(baseHome);
  mkdirSync(wrapperHomesRoot, { recursive: true });
  const wrapperHome = mkdtempSync(path.join(wrapperHomesRoot, "claude-"));

  for (const entry of readdirSync(baseHome, { withFileTypes: true })) {
    if (ISOLATED_ENTRY_NAMES.has(entry.name)) {
      continue;
    }
    const sourcePath = path.join(baseHome, entry.name);
    const targetPath = path.join(wrapperHome, entry.name);
    if (!existsSync(targetPath)) {
      symlinkSync(sourcePath, targetPath);
    }
  }

  for (const dirName of ISOLATED_DIRECTORIES) {
    mkdirSync(path.join(wrapperHome, dirName), { recursive: true });
  }

  return wrapperHome;
}

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
  ".codex-global-state.json",
  ".tmp",
  "archived_sessions",
  "history.jsonl",
  "internal_storage.json",
  "log",
  "logs_2.sqlite",
  "logs_2.sqlite-shm",
  "logs_2.sqlite-wal",
  "rah_wrappers",
  "session_index.jsonl",
  "sessions",
  "shell_snapshots",
  "sqlite",
  "state_5.sqlite",
  "state_5.sqlite-shm",
  "state_5.sqlite-wal",
  "tmp",
]);
const ISOLATED_DIRECTORIES = [
  ".tmp",
  "archived_sessions",
  "log",
  "sessions",
  "shell_snapshots",
  "sqlite",
  "tmp",
] as const;

export function resolveCodexBaseHome(): string {
  return process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
}

export function resolveCodexWrapperHomesRoot(baseHome = resolveCodexBaseHome()): string {
  return path.join(baseHome, WRAPPER_HOMES_DIRNAME);
}

export function listCodexWrapperHomes(baseHome = resolveCodexBaseHome()): string[] {
  const root = resolveCodexWrapperHomesRoot(baseHome);
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(root, entry.name));
  } catch {
    return [];
  }
}

export function createIsolatedCodexWrapperHome(baseHome = resolveCodexBaseHome()): string {
  const wrapperHomesRoot = resolveCodexWrapperHomesRoot(baseHome);
  mkdirSync(wrapperHomesRoot, { recursive: true });
  const wrapperHome = mkdtempSync(path.join(wrapperHomesRoot, "codex-"));

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

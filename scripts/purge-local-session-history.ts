import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { createCodexStdioAppServerClient } from "../packages/runtime-daemon/src/codex-app-server-client";
import {
  deleteOpenCodeSession,
  startOpenCodeServer,
  stopOpenCodeServer,
} from "../packages/runtime-daemon/src/opencode-api";

const CONFIRM_TOKEN = "DELETE_NON_KEPT_SESSION_HISTORY";
const CODEX_ID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

type CodexThreadRow = {
  id: string;
  rollout_path: string;
  archived: number;
};

type OpenCodeSessionRow = {
  id: string;
  parent_id: string | null;
};

type FileRecord = {
  id: string;
  filePath: string;
  bytes: number;
  mtimeMs: number;
};

type RootRecord = {
  path: string;
  files: number;
  bytes: number;
};

type ResidualRecord = RootRecord & {
  label: string;
  recreateDirectory: boolean;
};

type CleanupManifest = {
  version: 1;
  runId: string;
  createdAt: string;
  home: string;
  keepIds: string[];
  auditDir: string;
  quarantineDir: string;
  codex: {
    databasePath: string;
    deleteThreadIds: string[];
    keepThreads: CodexThreadRow[];
    deleteFiles: FileRecord[];
    keepFiles: FileRecord[];
  };
  claude: RootRecord;
  gemini: RootRecord;
  opencode: {
    databasePath: string;
    deleteSessions: OpenCodeSessionRow[];
    legacyRoots: RootRecord[];
  };
  rah: {
    runtimeRoot: string;
    catalogPath: string;
    workbenchPath: string;
    sessionLibraryPath: string;
    derivedRoots: RootRecord[];
  };
  claudeConfigPath?: string;
  sessionResiduals?: ResidualRecord[];
};

type CleanupResult = {
  status: "applied" | "finalized" | "failed";
  runId: string;
  updatedAt: string;
  error?: string;
  verification?: ReturnType<typeof verifyCleanState>;
};

function parseArgs(argv: string[]) {
  const keepIds: string[] = [];
  let apply = false;
  let confirm = "";
  let finalizeDir = "";
  let resumeDir = "";
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--apply") {
      apply = true;
    } else if (arg === "--keep") {
      const value = argv[index + 1];
      if (!value) throw new Error("--keep requires a session id.");
      keepIds.push(value);
      index += 1;
    } else if (arg === "--confirm") {
      const value = argv[index + 1];
      if (!value) throw new Error("--confirm requires a token.");
      confirm = value;
      index += 1;
    } else if (arg === "--finalize") {
      const value = argv[index + 1];
      if (!value) throw new Error("--finalize requires an audit directory.");
      finalizeDir = value;
      index += 1;
    } else if (arg === "--resume") {
      const value = argv[index + 1];
      if (!value) throw new Error("--resume requires an audit directory.");
      resumeDir = value;
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return { keepIds: [...new Set(keepIds)], apply, confirm, finalizeDir, resumeDir };
}

function sqlJson<T>(databasePath: string, query: string): T[] {
  const output = execFileSync("sqlite3", ["-json", databasePath, query], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  }).trim();
  return output ? (JSON.parse(output) as T[]) : [];
}

function sqlNumber(databasePath: string, query: string): number {
  const output = execFileSync("sqlite3", [databasePath, query], {
    encoding: "utf8",
  }).trim();
  const value = Number(output);
  if (!Number.isFinite(value)) throw new Error(`Expected a numeric SQLite result: ${output}`);
  return value;
}

function sqliteBackup(databasePath: string, targetPath: string): void {
  mkdirSync(path.dirname(targetPath), { recursive: true });
  const escaped = targetPath.replaceAll("'", "''");
  execFileSync("sqlite3", [databasePath, `.backup '${escaped}'`], { stdio: "pipe" });
}

function isInside(candidate: string, parent: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function requireInside(candidate: string, parent: string, label: string): void {
  if (!isInside(candidate, parent)) {
    throw new Error(`Refusing ${label} outside ${parent}: ${candidate}`);
  }
}

function walkFiles(root: string, options: { allowSymlinks?: boolean } = {}): string[] {
  if (!existsSync(root)) return [];
  const result: string[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop()!;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const candidate = path.join(current, entry.name);
      if (entry.isSymbolicLink()) {
        if (!options.allowSymlinks) {
          throw new Error(`Refusing to traverse symbolic link in history root: ${candidate}`);
        }
        result.push(candidate);
        continue;
      }
      if (entry.isDirectory()) pending.push(candidate);
      else if (entry.isFile()) result.push(candidate);
    }
  }
  return result.sort();
}

function rootRecord(root: string): RootRecord {
  // Root records are moved as a single directory entry. Count symlinks as
  // leaf entries, but never follow them into unrelated user data.
  const files = walkFiles(root, { allowSymlinks: true });
  return {
    path: root,
    files: files.length,
    bytes: files.reduce((total, filePath) => total + lstatSync(filePath).size, 0),
  };
}

function residualRecord(
  targetPath: string,
  label: string,
  options: { recreateDirectory?: boolean } = {},
): ResidualRecord {
  if (!existsSync(targetPath)) {
    return {
      path: targetPath,
      label,
      recreateDirectory: options.recreateDirectory ?? false,
      files: 0,
      bytes: 0,
    };
  }
  const targetStat = lstatSync(targetPath);
  if (targetStat.isSymbolicLink()) {
    throw new Error(`Refusing to inventory symbolic-link history path: ${targetPath}`);
  }
  if (targetStat.isDirectory()) {
    return {
      ...rootRecord(targetPath),
      label,
      recreateDirectory: options.recreateDirectory ?? true,
    };
  }
  if (!targetStat.isFile()) {
    throw new Error(`Unsupported history path type: ${targetPath}`);
  }
  return {
    path: targetPath,
    label,
    recreateDirectory: false,
    files: 1,
    bytes: targetStat.size,
  };
}

function codexFileRecords(codexHome: string): FileRecord[] {
  const roots = [path.join(codexHome, "sessions"), path.join(codexHome, "archived_sessions")];
  return roots.flatMap((root) =>
    walkFiles(root)
      .filter((filePath) => filePath.endsWith(".jsonl"))
      .map((filePath) => {
        requireInside(filePath, root, "Codex rollout scan");
        const id = path.basename(filePath).match(CODEX_ID_PATTERN)?.[0];
        if (!id) throw new Error(`Codex rollout has no UUID in its filename: ${filePath}`);
        const fileStat = statSync(filePath);
        return { id, filePath, bytes: fileStat.size, mtimeMs: fileStat.mtimeMs };
      }),
  );
}

function makeRunId(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function buildManifest(keepIds: string[]): CleanupManifest {
  if (keepIds.length === 0) throw new Error("At least one --keep id is required.");
  for (const id of keepIds) {
    if (!CODEX_ID_PATTERN.test(id) || id.match(CODEX_ID_PATTERN)?.[0] !== id) {
      throw new Error(`Keep id is not a Codex UUID: ${id}`);
    }
  }

  const home = os.homedir();
  const codexHome = path.join(home, ".codex");
  const codexDatabase = path.join(codexHome, "state_5.sqlite");
  const codexThreads = sqlJson<CodexThreadRow>(
    codexDatabase,
    "select id, rollout_path, archived from threads order by id",
  );
  const keepSet = new Set(keepIds);
  const keepThreads = codexThreads.filter((row) => keepSet.has(row.id));
  if (keepThreads.length !== keepIds.length) {
    const found = new Set(keepThreads.map((row) => row.id));
    throw new Error(`Missing kept Codex database row(s): ${keepIds.filter((id) => !found.has(id)).join(", ")}`);
  }
  const allCodexFiles = codexFileRecords(codexHome);
  const keepFiles = allCodexFiles.filter((record) => keepSet.has(record.id));
  for (const id of keepIds) {
    const matches = keepFiles.filter((record) => record.id === id);
    if (matches.length !== 1) {
      throw new Error(`Expected exactly one rollout for kept Codex session ${id}; found ${matches.length}.`);
    }
    const thread = keepThreads.find((row) => row.id === id)!;
    if (path.resolve(thread.rollout_path) !== path.resolve(matches[0]!.filePath)) {
      throw new Error(`Kept Codex database path does not match its rollout for ${id}.`);
    }
  }

  const openCodeRoot = path.join(home, ".local", "share", "opencode");
  const openCodeDatabase = path.join(openCodeRoot, "opencode.db");
  const openCodeSessions = existsSync(openCodeDatabase)
    ? sqlJson<OpenCodeSessionRow>(
        openCodeDatabase,
        "select id, parent_id from session order by id",
      )
    : [];
  const legacyNames = ["session", "message", "part", "session_diff", "todo"];
  const runtimeRoot = path.join(home, ".rah", "runtime-daemon");
  const derivedNames = [
    "conversation-page-cache",
    "turn-directory",
    "gemini-history-cache",
    path.join("provider-archives", "claude"),
  ];
  const runId = makeRunId();
  const auditDir = path.join(runtimeRoot, "session-cleanup-audits", runId);
  const claudeRoot = path.join(home, ".claude");
  const geminiRoot = path.join(home, ".gemini");
  const sessionResiduals = [
    residualRecord(path.join(claudeRoot, "history.jsonl"), path.join("claude", "history.jsonl")),
    residualRecord(path.join(claudeRoot, "backups"), path.join("claude", "backups")),
    residualRecord(path.join(claudeRoot, "transcripts"), path.join("claude", "transcripts")),
    residualRecord(path.join(claudeRoot, "sessions"), path.join("claude", "sessions")),
    residualRecord(path.join(claudeRoot, "session-env"), path.join("claude", "session-env")),
    residualRecord(path.join(geminiRoot, "history"), path.join("gemini", "history")),
    residualRecord(path.join(openCodeRoot, "snapshot"), path.join("opencode", "snapshot")),
    residualRecord(path.join(openCodeRoot, "tool-output"), path.join("opencode", "tool-output")),
    residualRecord(
      path.join(openCodeRoot, "storage", "agent-usage-reminder"),
      path.join("opencode", "storage", "agent-usage-reminder"),
    ),
    residualRecord(
      path.join(openCodeRoot, "storage", "directory-agents"),
      path.join("opencode", "storage", "directory-agents"),
    ),
    residualRecord(
      path.join(openCodeRoot, "storage", "directory-readme"),
      path.join("opencode", "storage", "directory-readme"),
    ),
  ];
  return {
    version: 1,
    runId,
    createdAt: new Date().toISOString(),
    home,
    keepIds: [...keepIds].sort(),
    auditDir,
    quarantineDir: path.join(runtimeRoot, `session-cleanup-quarantine-${runId}`),
    codex: {
      databasePath: codexDatabase,
      deleteThreadIds: codexThreads.filter((row) => !keepSet.has(row.id)).map((row) => row.id),
      keepThreads,
      deleteFiles: allCodexFiles.filter((record) => !keepSet.has(record.id)),
      keepFiles,
    },
    claude: rootRecord(path.join(claudeRoot, "projects")),
    gemini: rootRecord(path.join(geminiRoot, "tmp")),
    opencode: {
      databasePath: openCodeDatabase,
      deleteSessions: sortOpenCodeSessionsChildFirst(openCodeSessions),
      legacyRoots: legacyNames.map((name) => rootRecord(path.join(openCodeRoot, "storage", name))),
    },
    rah: {
      runtimeRoot,
      catalogPath: path.join(runtimeRoot, "stored-session-cache", "catalog.json"),
      workbenchPath: path.join(runtimeRoot, "workbench-state.json"),
      sessionLibraryPath: path.join(runtimeRoot, "session-library.json"),
      derivedRoots: derivedNames.map((name) => rootRecord(path.join(runtimeRoot, name))),
    },
    claudeConfigPath: path.join(home, ".claude.json"),
    sessionResiduals,
  };
}

function sortOpenCodeSessionsChildFirst(rows: OpenCodeSessionRow[]): OpenCodeSessionRow[] {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const memo = new Map<string, number>();
  const depth = (id: string, stack = new Set<string>()): number => {
    const cached = memo.get(id);
    if (cached !== undefined) return cached;
    if (stack.has(id)) throw new Error(`OpenCode session parent cycle includes ${id}.`);
    stack.add(id);
    const parentId = byId.get(id)?.parent_id;
    const value = parentId && byId.has(parentId) ? depth(parentId, stack) + 1 : 0;
    stack.delete(id);
    memo.set(id, value);
    return value;
  };
  return [...rows].sort((left, right) => depth(right.id) - depth(left.id) || left.id.localeCompare(right.id));
}

function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  const digits = value >= 100 || index === 0 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(digits)} ${units[index]}`;
}

function manifestSummary(manifest: CleanupManifest) {
  const codexDeleteBytes = manifest.codex.deleteFiles.reduce((sum, file) => sum + file.bytes, 0);
  const codexKeepBytes = manifest.codex.keepFiles.reduce((sum, file) => sum + file.bytes, 0);
  const openCodeLegacyBytes = manifest.opencode.legacyRoots.reduce((sum, root) => sum + root.bytes, 0);
  const derivedBytes = manifest.rah.derivedRoots.reduce((sum, root) => sum + root.bytes, 0);
  const residualBytes = (manifest.sessionResiduals ?? []).reduce((sum, root) => sum + root.bytes, 0);
  return {
    runId: manifest.runId,
    keepIds: manifest.keepIds,
    codex: {
      deleteThreads: manifest.codex.deleteThreadIds.length,
      deleteRollouts: manifest.codex.deleteFiles.length,
      deleteBytes: codexDeleteBytes,
      deleteSize: formatBytes(codexDeleteBytes),
      keepThreads: manifest.codex.keepThreads.length,
      keepRollouts: manifest.codex.keepFiles.length,
      keepBytes: codexKeepBytes,
      keepSize: formatBytes(codexKeepBytes),
    },
    claude: { files: manifest.claude.files, bytes: manifest.claude.bytes, size: formatBytes(manifest.claude.bytes) },
    gemini: { files: manifest.gemini.files, bytes: manifest.gemini.bytes, size: formatBytes(manifest.gemini.bytes) },
    opencode: {
      sessions: manifest.opencode.deleteSessions.length,
      legacyFiles: manifest.opencode.legacyRoots.reduce((sum, root) => sum + root.files, 0),
      legacyBytes: openCodeLegacyBytes,
      legacySize: formatBytes(openCodeLegacyBytes),
    },
    rahDerived: {
      files: manifest.rah.derivedRoots.reduce((sum, root) => sum + root.files, 0),
      bytes: derivedBytes,
      size: formatBytes(derivedBytes),
    },
    sessionResiduals: {
      paths: manifest.sessionResiduals?.length ?? 0,
      files: (manifest.sessionResiduals ?? []).reduce((sum, root) => sum + root.files, 0),
      bytes: residualBytes,
      size: formatBytes(residualBytes),
    },
  };
}

function atomicJson(filePath: string, value: unknown): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.tmp`;
  const existingMode = existsSync(filePath) ? statSync(filePath).mode & 0o777 : undefined;
  writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    ...(existingMode === undefined ? {} : { mode: existingMode }),
  });
  if (existingMode !== undefined) chmodSync(tempPath, existingMode);
  renameSync(tempPath, filePath);
}

function backupFileIfPresent(sourcePath: string, targetPath: string): void {
  if (!existsSync(sourcePath)) return;
  mkdirSync(path.dirname(targetPath), { recursive: true });
  copyFileSync(sourcePath, targetPath);
}

function quarantinePath(sourcePath: string, quarantineDir: string, label: string): string | null {
  if (!existsSync(sourcePath)) return null;
  const sourceStat = lstatSync(sourcePath);
  if (sourceStat.isSymbolicLink()) throw new Error(`Refusing to quarantine symbolic link: ${sourcePath}`);
  const targetPath = path.join(quarantineDir, label);
  requireInside(targetPath, quarantineDir, "quarantine target");
  if (existsSync(targetPath)) throw new Error(`Quarantine target already exists: ${targetPath}`);
  mkdirSync(path.dirname(targetPath), { recursive: true });
  renameSync(sourcePath, targetPath);
  return targetPath;
}

async function deleteCodexThreads(manifest: CleanupManifest): Promise<void> {
  if (manifest.codex.deleteThreadIds.length === 0) return;
  const client = await createCodexStdioAppServerClient();
  const failures: Array<{ id: string; error: string }> = [];
  try {
    let completed = 0;
    for (const id of manifest.codex.deleteThreadIds) {
      try {
        await client.request("thread/delete", { threadId: id }, 60_000);
      } catch (error) {
        failures.push({ id, error: error instanceof Error ? error.message : String(error) });
      }
      completed += 1;
      if (completed % 50 === 0 || completed === manifest.codex.deleteThreadIds.length) {
        console.log(`[cleanup] Codex ${completed}/${manifest.codex.deleteThreadIds.length}`);
      }
    }
  } finally {
    await client.dispose();
  }

  for (const failure of failures) {
    const stillPresent = sqlNumber(
      manifest.codex.databasePath,
      `select count(*) from threads where id = '${failure.id.replaceAll("'", "''")}'`,
    ) > 0;
    if (!stillPresent) continue;
    console.warn(`[cleanup] retrying Codex ${failure.id} through codex delete --force`);
    execFileSync("codex", ["delete", "--force", failure.id], {
      stdio: "pipe",
      maxBuffer: 8 * 1024 * 1024,
    });
  }

  const keepSql = manifest.keepIds.map((id) => `'${id.replaceAll("'", "''")}'`).join(",");
  const remaining = sqlJson<{ id: string }>(
    manifest.codex.databasePath,
    `select id from threads where id not in (${keepSql}) order by id`,
  );
  if (remaining.length > 0) {
    throw new Error(`Codex still has ${remaining.length} non-kept database row(s).`);
  }
}

function quarantineOrphanedCodexFiles(manifest: CleanupManifest): void {
  const codexHome = path.dirname(manifest.codex.databasePath);
  const keepSet = new Set(manifest.keepIds);
  const remaining = codexFileRecords(codexHome).filter((record) => !keepSet.has(record.id));
  for (const record of remaining) {
    const rowCount = sqlNumber(
      manifest.codex.databasePath,
      `select count(*) from threads where id = '${record.id.replaceAll("'", "''")}'`,
    );
    if (rowCount !== 0) throw new Error(`Refusing to move indexed Codex rollout ${record.id}.`);
    const relative = path.relative(codexHome, record.filePath);
    quarantinePath(record.filePath, manifest.quarantineDir, path.join("codex-orphans", relative));
  }
}

async function deleteOpenCodeSessions(manifest: CleanupManifest): Promise<void> {
  if (!existsSync(manifest.opencode.databasePath) || manifest.opencode.deleteSessions.length === 0) return;
  const server = await startOpenCodeServer({ cwd: process.cwd() });
  const failures: Array<{ id: string; error: string }> = [];
  try {
    let completed = 0;
    for (const row of manifest.opencode.deleteSessions) {
      try {
        await deleteOpenCodeSession({ handle: server, providerSessionId: row.id });
      } catch (error) {
        const stillPresent = sqlNumber(
          manifest.opencode.databasePath,
          `select count(*) from session where id = '${row.id.replaceAll("'", "''")}'`,
        ) > 0;
        if (stillPresent) failures.push({ id: row.id, error: error instanceof Error ? error.message : String(error) });
      }
      completed += 1;
      if (completed % 50 === 0 || completed === manifest.opencode.deleteSessions.length) {
        console.log(`[cleanup] OpenCode ${completed}/${manifest.opencode.deleteSessions.length}`);
      }
    }
  } finally {
    await stopOpenCodeServer(server);
  }
  if (failures.length > 0) {
    throw new Error(`OpenCode failed to delete ${failures.length} session(s); first=${failures[0]!.id}: ${failures[0]!.error}`);
  }
  const remaining = sqlNumber(manifest.opencode.databasePath, "select count(*) from session");
  if (remaining !== 0) throw new Error(`OpenCode still has ${remaining} session row(s).`);
  execFileSync("sqlite3", [manifest.opencode.databasePath, "pragma wal_checkpoint(truncate); vacuum;"], {
    stdio: "pipe",
  });
}

function backupMutableState(manifest: CleanupManifest): void {
  const backupRoot = path.join(manifest.quarantineDir, "backups");
  mkdirSync(backupRoot, { recursive: true });
  sqliteBackup(manifest.codex.databasePath, path.join(backupRoot, "codex-state_5.sqlite"));
  if (existsSync(manifest.opencode.databasePath)) {
    sqliteBackup(manifest.opencode.databasePath, path.join(backupRoot, "opencode.db"));
  }
  backupFileIfPresent(manifest.rah.workbenchPath, path.join(backupRoot, "workbench-state.json"));
  backupFileIfPresent(manifest.rah.catalogPath, path.join(backupRoot, "stored-session-catalog.json"));
  backupFileIfPresent(manifest.rah.sessionLibraryPath, path.join(backupRoot, "session-library.json"));
  if (manifest.claudeConfigPath) {
    backupFileIfPresent(manifest.claudeConfigPath, path.join(backupRoot, "claude.json"));
  }
}

function quarantineFileProvidersAndDerivedState(manifest: CleanupManifest): void {
  const claudeProjects = manifest.claude.path;
  const geminiTmp = manifest.gemini.path;
  quarantinePath(claudeProjects, manifest.quarantineDir, "claude-projects");
  mkdirSync(claudeProjects, { recursive: true });
  quarantinePath(geminiTmp, manifest.quarantineDir, "gemini-tmp");
  mkdirSync(geminiTmp, { recursive: true });
  for (const root of manifest.opencode.legacyRoots) {
    const label = path.join("opencode-legacy", path.basename(root.path));
    quarantinePath(root.path, manifest.quarantineDir, label);
  }
  for (const root of manifest.rah.derivedRoots) {
    const relative = path.relative(manifest.rah.runtimeRoot, root.path);
    requireInside(root.path, manifest.rah.runtimeRoot, "RAH derived-state cleanup");
    quarantinePath(root.path, manifest.quarantineDir, path.join("rah-derived", relative));
  }
  for (const residual of manifest.sessionResiduals ?? []) {
    const targetStat = existsSync(residual.path) ? lstatSync(residual.path) : null;
    if (targetStat?.isSymbolicLink()) {
      throw new Error(`Refusing to quarantine symbolic-link history path: ${residual.path}`);
    }
    quarantinePath(residual.path, manifest.quarantineDir, path.join("session-residuals", residual.label));
    if (residual.recreateDirectory) mkdirSync(residual.path, { recursive: true });
  }
}

const CLAUDE_PROJECT_SESSION_METADATA = /^(?:lastAPI|lastCost$|lastDuration$|lastFps|lastGracefulShutdown$|lastHintSessionId$|lastLines|lastModelUsage$|lastSession|lastToolDuration$|lastTotal)/;

function scrubClaudeSessionMetadata(manifest: CleanupManifest): void {
  const configPath = manifest.claudeConfigPath;
  if (!configPath || !existsSync(configPath)) return;
  const config = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
  const projects = config.projects;
  if (!projects || typeof projects !== "object" || Array.isArray(projects)) return;
  for (const value of Object.values(projects)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    for (const key of Object.keys(value)) {
      if (CLAUDE_PROJECT_SESSION_METADATA.test(key)) delete (value as Record<string, unknown>)[key];
    }
  }
  atomicJson(configPath, config);
}

function rewriteRahState(manifest: CleanupManifest): void {
  const keepSet = new Set(manifest.keepIds);
  const keepIdentity = (value: unknown): boolean => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const candidate = value as { provider?: unknown; providerSessionId?: unknown };
    return candidate.provider === "codex" && typeof candidate.providerSessionId === "string" && keepSet.has(candidate.providerSessionId);
  };

  if (existsSync(manifest.rah.catalogPath)) {
    const catalog = JSON.parse(readFileSync(manifest.rah.catalogPath, "utf8")) as { version?: number; records?: unknown[] };
    const records = (Array.isArray(catalog.records) ? catalog.records : []).filter((record) => {
      if (!record || typeof record !== "object" || Array.isArray(record)) return false;
      return keepIdentity((record as { ref?: unknown }).ref);
    });
    if (records.length !== manifest.keepIds.length) {
      throw new Error(`RAH catalog contains ${records.length} kept record(s), expected ${manifest.keepIds.length}.`);
    }
    atomicJson(manifest.rah.catalogPath, { version: catalog.version ?? 1, records });
  }

  if (existsSync(manifest.rah.workbenchPath)) {
    const state = JSON.parse(readFileSync(manifest.rah.workbenchPath, "utf8")) as Record<string, unknown>;
    const sessions = (Array.isArray(state.sessions) ? state.sessions : []).filter(keepIdentity);
    const recentSessions = (Array.isArray(state.recentSessions) ? state.recentSessions : []).filter(keepIdentity);
    const filterOverrides = (value: unknown) => Object.fromEntries(
      Object.entries(value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {})
        .filter(([key]) => key.startsWith("codex:") && keepSet.has(key.slice("codex:".length))),
    );
    const keepRefs = sessions as Array<{ providerSessionId?: string; cwd?: string; rootDir?: string }>;
    const originalPins = Array.isArray(state.pinnedSidebarItems) ? state.pinnedSidebarItems : [];
    const pins = originalPins.flatMap((pin) => {
      if (!pin || typeof pin !== "object" || Array.isArray(pin)) return [];
      const candidate = pin as { workspaceDir?: unknown; itemKey?: unknown };
      if (typeof candidate.workspaceDir !== "string" || typeof candidate.itemKey !== "string") return [];
      const stable = /^session:codex:(.+)$/.exec(candidate.itemKey);
      if (stable && keepSet.has(stable[1]!)) return [candidate];
      const matches = keepRefs.filter((ref) => (ref.rootDir ?? ref.cwd) === candidate.workspaceDir);
      return matches.length === 1 && matches[0]!.providerSessionId
        ? [{ workspaceDir: candidate.workspaceDir, itemKey: `session:codex:${matches[0]!.providerSessionId}` }]
        : [];
    });
    const tuiMuxLiveSessions = (Array.isArray(state.tuiMuxLiveSessions) ? state.tuiMuxLiveSessions : []).filter(keepIdentity);
    atomicJson(manifest.rah.workbenchPath, {
      ...state,
      updatedAt: new Date().toISOString(),
      hiddenSessionKeys: [],
      sessionTitleOverrides: filterOverrides(state.sessionTitleOverrides),
      pendingSessionTitleOverrides: filterOverrides(state.pendingSessionTitleOverrides),
      sessions,
      recentSessions,
      tuiMuxLiveSessions,
      pinnedSidebarItems: pins,
    });
  }

  atomicJson(manifest.rah.sessionLibraryPath, {
    version: 1,
    updatedAt: new Date().toISOString(),
    archives: [],
  });

  if (existsSync(manifest.rah.runtimeRoot)) {
    for (const name of readdirSync(manifest.rah.runtimeRoot)) {
      if (!name.startsWith("workbench-state.json.") && !name.startsWith("workbench-state.json.bak.")) continue;
      const candidate = path.join(manifest.rah.runtimeRoot, name);
      if (candidate === manifest.rah.workbenchPath) continue;
      quarantinePath(candidate, manifest.quarantineDir, path.join("rah-stale-state", name));
    }
  }
}

function verifyCleanState(manifest: CleanupManifest) {
  const keepSet = new Set(manifest.keepIds);
  const codexRows = sqlJson<{ id: string; rollout_path: string }>(
    manifest.codex.databasePath,
    "select id, rollout_path from threads order by id",
  );
  const codexFiles = codexFileRecords(path.dirname(manifest.codex.databasePath));
  const openCodeSessions = existsSync(manifest.opencode.databasePath)
    ? sqlNumber(manifest.opencode.databasePath, "select count(*) from session")
    : 0;
  const claudeJsonl = walkFiles(manifest.claude.path).filter((filePath) => filePath.endsWith(".jsonl"));
  const geminiFiles = walkFiles(manifest.gemini.path);
  const catalog = existsSync(manifest.rah.catalogPath)
    ? JSON.parse(readFileSync(manifest.rah.catalogPath, "utf8")) as { records?: Array<{ ref?: { provider?: string; providerSessionId?: string } }> }
    : { records: [] };
  const catalogIds = (catalog.records ?? []).map((record) => record.ref?.providerSessionId).filter((id): id is string => Boolean(id));
  const workbench = existsSync(manifest.rah.workbenchPath)
    ? JSON.parse(readFileSync(manifest.rah.workbenchPath, "utf8")) as { sessions?: Array<{ providerSessionId?: string }>; recentSessions?: Array<{ providerSessionId?: string }>; hiddenSessionKeys?: unknown[] }
    : {};
  const workbenchIds = [...(workbench.sessions ?? []), ...(workbench.recentSessions ?? [])]
    .map((entry) => entry.providerSessionId)
    .filter((id): id is string => Boolean(id));
  const residualFiles = (manifest.sessionResiduals ?? []).flatMap((record) => {
    if (!existsSync(record.path)) return [];
    const recordStat = lstatSync(record.path);
    if (recordStat.isSymbolicLink()) return [record.path];
    if (recordStat.isDirectory()) return walkFiles(record.path, { allowSymlinks: true });
    return [record.path];
  });
  const claudeSessionMetadata = (() => {
    if (!manifest.claudeConfigPath || !existsSync(manifest.claudeConfigPath)) return [] as string[];
    const config = JSON.parse(readFileSync(manifest.claudeConfigPath, "utf8")) as { projects?: unknown };
    if (!config.projects || typeof config.projects !== "object" || Array.isArray(config.projects)) return [] as string[];
    return Object.entries(config.projects).flatMap(([projectPath, value]) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return [];
      return Object.keys(value)
        .filter((key) => CLAUDE_PROJECT_SESSION_METADATA.test(key))
        .map((key) => `${projectPath}:${key}`);
    });
  })();

  const assertions = {
    codexDatabaseOnlyKept: codexRows.length === manifest.keepIds.length && codexRows.every((row) => keepSet.has(row.id)),
    codexFilesOnlyKept: codexFiles.length === manifest.keepIds.length && codexFiles.every((file) => keepSet.has(file.id)),
    codexKeepFilesExist: manifest.keepIds.every((id) => codexFiles.filter((file) => file.id === id).length === 1),
    openCodeEmpty: openCodeSessions === 0,
    claudeEmpty: claudeJsonl.length === 0,
    geminiTmpEmpty: geminiFiles.length === 0,
    rahCatalogOnlyKept: catalogIds.length === manifest.keepIds.length && catalogIds.every((id) => keepSet.has(id)),
    rahWorkbenchOnlyKept: workbenchIds.every((id) => keepSet.has(id)) && (workbench.hiddenSessionKeys?.length ?? 0) === 0,
    sessionResidualsEmpty: residualFiles.length === 0,
    claudeSessionMetadataScrubbed: claudeSessionMetadata.length === 0,
  };
  const failed = Object.entries(assertions).filter(([, value]) => !value).map(([key]) => key);
  if (failed.length > 0) throw new Error(`Cleanup verification failed: ${failed.join(", ")}`);
  return {
    assertions,
    codexRows: codexRows.length,
    codexRollouts: codexFiles.length,
    codexBytes: codexFiles.reduce((sum, file) => sum + file.bytes, 0),
    openCodeSessions,
    claudeJsonl: claudeJsonl.length,
    geminiFiles: geminiFiles.length,
    rahCatalogRecords: catalogIds.length,
    sessionResidualFiles: residualFiles.length,
    claudeSessionMetadataFields: claudeSessionMetadata.length,
  };
}

async function applyCleanup(manifest: CleanupManifest): Promise<void> {
  mkdirSync(path.dirname(manifest.auditDir), { recursive: true });
  mkdirSync(manifest.auditDir, { recursive: false });
  mkdirSync(manifest.quarantineDir, { recursive: false });
  atomicJson(path.join(manifest.auditDir, "manifest.json"), manifest);
  backupMutableState(manifest);
  let result: CleanupResult;
  try {
    await deleteCodexThreads(manifest);
    quarantineOrphanedCodexFiles(manifest);
    await deleteOpenCodeSessions(manifest);
    quarantineFileProvidersAndDerivedState(manifest);
    scrubClaudeSessionMetadata(manifest);
    rewriteRahState(manifest);
    const verification = verifyCleanState(manifest);
    result = {
      status: "applied",
      runId: manifest.runId,
      updatedAt: new Date().toISOString(),
      verification,
    };
  } catch (error) {
    result = {
      status: "failed",
      runId: manifest.runId,
      updatedAt: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error),
    };
    atomicJson(path.join(manifest.auditDir, "result.json"), result);
    throw error;
  }
  atomicJson(path.join(manifest.auditDir, "result.json"), result);
  console.log(JSON.stringify({ auditDir: manifest.auditDir, quarantineDir: manifest.quarantineDir, result }, null, 2));
}

function readAuditRun(auditDir: string): {
  resolvedAuditDir: string;
  manifest: CleanupManifest;
  result: CleanupResult;
} {
  const resolvedAuditDir = path.resolve(auditDir);
  const manifestPath = path.join(resolvedAuditDir, "manifest.json");
  const resultPath = path.join(resolvedAuditDir, "result.json");
  if (!existsSync(manifestPath) || !existsSync(resultPath)) {
    throw new Error(`Incomplete cleanup audit directory: ${resolvedAuditDir}`);
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as CleanupManifest;
  const result = JSON.parse(readFileSync(resultPath, "utf8")) as CleanupResult;
  if (manifest.version !== 1 || path.resolve(manifest.auditDir) !== resolvedAuditDir) {
    throw new Error("Cleanup audit manifest does not match the requested directory.");
  }
  requireInside(resolvedAuditDir, path.join(manifest.rah.runtimeRoot, "session-cleanup-audits"), "cleanup audit access");
  requireInside(manifest.quarantineDir, manifest.rah.runtimeRoot, "cleanup quarantine access");
  if (!path.basename(manifest.quarantineDir).startsWith("session-cleanup-quarantine-")) {
    throw new Error(`Refusing unexpected quarantine path: ${manifest.quarantineDir}`);
  }
  return { resolvedAuditDir, manifest, result };
}

async function resumeCleanup(auditDir: string): Promise<void> {
  const { resolvedAuditDir, manifest, result: priorResult } = readAuditRun(auditDir);
  if (priorResult.status !== "failed") {
    throw new Error(`Only a failed cleanup run can be resumed; current status is ${priorResult.status}.`);
  }
  if (!existsSync(manifest.quarantineDir)) {
    throw new Error(`Cleanup quarantine is missing: ${manifest.quarantineDir}`);
  }

  let result: CleanupResult;
  try {
    const keepSet = new Set(manifest.keepIds);
    const codexRows = sqlJson<{ id: string }>(
      manifest.codex.databasePath,
      "select id from threads order by id",
    );
    if (codexRows.length !== manifest.keepIds.length || codexRows.some((row) => !keepSet.has(row.id))) {
      throw new Error("Refusing resume because Codex is not in the expected keep-only state.");
    }
    quarantineOrphanedCodexFiles(manifest);
    const openCodeSessions = existsSync(manifest.opencode.databasePath)
      ? sqlNumber(manifest.opencode.databasePath, "select count(*) from session")
      : 0;
    if (openCodeSessions !== 0) {
      throw new Error(`Refusing resume because OpenCode still has ${openCodeSessions} session row(s).`);
    }
    if (existsSync(manifest.opencode.databasePath)) {
      execFileSync("sqlite3", [manifest.opencode.databasePath, "pragma wal_checkpoint(truncate); vacuum;"], {
        stdio: "pipe",
      });
    }
    quarantineFileProvidersAndDerivedState(manifest);
    scrubClaudeSessionMetadata(manifest);
    rewriteRahState(manifest);
    const verification = verifyCleanState(manifest);
    result = {
      status: "applied",
      runId: manifest.runId,
      updatedAt: new Date().toISOString(),
      verification,
    };
  } catch (error) {
    result = {
      status: "failed",
      runId: manifest.runId,
      updatedAt: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error),
    };
    atomicJson(path.join(resolvedAuditDir, "result.json"), result);
    throw error;
  }
  atomicJson(path.join(resolvedAuditDir, "result.json"), result);
  console.log(JSON.stringify({ auditDir: resolvedAuditDir, quarantineDir: manifest.quarantineDir, result }, null, 2));
}

function finalizeCleanup(auditDir: string): void {
  const { resolvedAuditDir, manifest, result } = readAuditRun(auditDir);
  const resultPath = path.join(resolvedAuditDir, "result.json");
  if (result.status !== "applied") {
    throw new Error("Cleanup run is not eligible for finalization.");
  }
  const verification = verifyCleanState(manifest);
  if (existsSync(manifest.quarantineDir)) rmSync(manifest.quarantineDir, { recursive: true, force: false });
  const finalized: CleanupResult = {
    status: "finalized",
    runId: manifest.runId,
    updatedAt: new Date().toISOString(),
    verification,
  };
  atomicJson(resultPath, finalized);
  console.log(JSON.stringify({ auditDir: resolvedAuditDir, result: finalized }, null, 2));
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.finalizeDir) {
    if (args.apply || args.keepIds.length > 0 || args.resumeDir) {
      throw new Error("--finalize cannot be combined with --apply, --keep, or --resume.");
    }
    finalizeCleanup(args.finalizeDir);
    return;
  }
  if (args.resumeDir) {
    if (args.apply || args.keepIds.length > 0) {
      throw new Error("--resume cannot be combined with --apply or --keep.");
    }
    if (args.confirm !== CONFIRM_TOKEN) throw new Error(`--resume requires --confirm ${CONFIRM_TOKEN}.`);
    await resumeCleanup(args.resumeDir);
    return;
  }
  const manifest = buildManifest(args.keepIds);
  console.log(JSON.stringify(manifestSummary(manifest), null, 2));
  if (!args.apply) {
    console.log(`[dry-run] Pass --apply --confirm ${CONFIRM_TOKEN} to execute this exact policy.`);
    return;
  }
  if (args.confirm !== CONFIRM_TOKEN) throw new Error(`--apply requires --confirm ${CONFIRM_TOKEN}.`);
  await applyCleanup(manifest);
}

await main();

import { createHash, randomUUID } from "node:crypto";
import {
  constants,
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import {
  copyFile,
  link,
  mkdir,
  open,
  stat,
  unlink,
  utimes,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { StoredSessionRef } from "@rah/runtime-protocol";
import type { ClaudeStoredSessionRecord } from "./claude-session-files";
import { movePathToTrash } from "./trash";

const MANIFEST_VERSION = 1;

type ClaudeArchiveEntryState = "pending_archive" | "archived" | "pending_restore";

export interface ClaudeSessionArchiveManifestEntry {
  provider: "claude";
  providerSessionId: string;
  originalPath: string;
  archivedPath: string;
  archivedAt: string;
  sizeBytes: number;
  mtimeMs: number;
  sha256?: string;
  state: ClaudeArchiveEntryState;
  snapshot: StoredSessionRef;
}

interface ClaudeSessionArchiveManifest {
  version: 1;
  updatedAt: string;
  entries: ClaudeSessionArchiveManifestEntry[];
}

function resolveRahRoot(): string {
  return process.env.RAH_HOME ?? path.join(os.homedir(), ".rah");
}

function resolveClaudeConfigRoot(): string {
  return process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude");
}

function isPathInside(candidate: string, parent: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function safeSessionSegment(providerSessionId: string): string {
  const normalized = providerSessionId.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120);
  if (!normalized || normalized === "." || normalized === "..") {
    return createHash("sha256").update(providerSessionId).digest("hex");
  }
  return normalized;
}

function sameFile(left: string, right: string): boolean {
  try {
    const leftStat = statSync(left);
    const rightStat = statSync(right);
    return leftStat.dev === rightStat.dev && leftStat.ino === rightStat.ino;
  } catch {
    return false;
  }
}

function sanitizeEntry(
  value: unknown,
  archiveFilesRoot: string,
  claudeProjectsRoot: string,
): ClaudeSessionArchiveManifestEntry | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const entry = value as Partial<ClaudeSessionArchiveManifestEntry>;
  if (
    entry.provider !== "claude" ||
    typeof entry.providerSessionId !== "string" ||
    !entry.providerSessionId.trim() ||
    typeof entry.originalPath !== "string" ||
    typeof entry.archivedPath !== "string" ||
    typeof entry.archivedAt !== "string" ||
    !Number.isFinite(Date.parse(entry.archivedAt)) ||
    typeof entry.sizeBytes !== "number" ||
    !Number.isFinite(entry.sizeBytes) ||
    entry.sizeBytes < 0 ||
    typeof entry.mtimeMs !== "number" ||
    !Number.isFinite(entry.mtimeMs) ||
    (entry.state !== "pending_archive" &&
      entry.state !== "archived" &&
      entry.state !== "pending_restore") ||
    !entry.snapshot ||
    entry.snapshot.provider !== "claude" ||
    entry.snapshot.providerSessionId !== entry.providerSessionId
  ) {
    return null;
  }
  const originalPath = path.resolve(entry.originalPath);
  const archivedPath = path.resolve(entry.archivedPath);
  if (
    !originalPath.endsWith(".jsonl") ||
    !isPathInside(originalPath, claudeProjectsRoot) ||
    !isPathInside(archivedPath, archiveFilesRoot)
  ) {
    return null;
  }
  return {
    provider: "claude",
    providerSessionId: entry.providerSessionId,
    originalPath,
    archivedPath,
    archivedAt: entry.archivedAt,
    sizeBytes: Math.round(entry.sizeBytes),
    mtimeMs: entry.mtimeMs,
    ...(typeof entry.sha256 === "string" && /^[a-f0-9]{64}$/i.test(entry.sha256)
      ? { sha256: entry.sha256.toLowerCase() }
      : {}),
    state: entry.state,
    snapshot: { ...entry.snapshot },
  };
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("error", reject);
    stream.once("end", resolve);
  });
  return hash.digest("hex");
}

async function copyFileExclusive(sourcePath: string, targetPath: string): Promise<void> {
  await copyFile(sourcePath, targetPath, constants.COPYFILE_EXCL);
  const targetHandle = await open(targetPath, "r");
  try {
    await targetHandle.sync();
  } finally {
    await targetHandle.close();
  }
  const [sourceHash, targetHash] = await Promise.all([
    sha256File(sourcePath),
    sha256File(targetPath),
  ]);
  if (sourceHash !== targetHash) {
    await unlink(targetPath).catch(() => undefined);
    throw new Error(`Claude archive copy verification failed for ${sourcePath}.`);
  }
  await unlink(sourcePath);
}

async function moveFileExclusive(sourcePath: string, targetPath: string): Promise<void> {
  await mkdir(path.dirname(targetPath), { recursive: true });
  try {
    await link(sourcePath, targetPath);
    await unlink(sourcePath);
    return;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EXDEV" && code !== "EPERM" && code !== "EACCES") {
      throw error;
    }
  }
  await copyFileExclusive(sourcePath, targetPath);
}

export class ClaudeSessionArchiveStore {
  private readonly rootDir: string;
  private readonly filesRoot: string;
  private readonly manifestPath: string;
  private readonly claudeProjectsRoot: string;
  private entries = new Map<string, ClaudeSessionArchiveManifestEntry>();
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(options: { rootDir?: string; claudeConfigDir?: string } = {}) {
    this.rootDir =
      options.rootDir ?? path.join(resolveRahRoot(), "runtime-daemon", "provider-archives", "claude");
    this.filesRoot = path.join(this.rootDir, "files");
    this.manifestPath = path.join(this.rootDir, "manifest.json");
    this.claudeProjectsRoot = path.join(
      options.claudeConfigDir ?? resolveClaudeConfigRoot(),
      "projects",
    );
    this.load();
  }

  list(): ClaudeSessionArchiveManifestEntry[] {
    return [...this.entries.values()].map((entry) => ({
      ...entry,
      snapshot: { ...entry.snapshot },
    }));
  }

  find(providerSessionId: string): ClaudeSessionArchiveManifestEntry | undefined {
    const entry = this.entries.get(providerSessionId);
    return entry ? { ...entry, snapshot: { ...entry.snapshot } } : undefined;
  }

  async archive(record: ClaudeStoredSessionRecord): Promise<ClaudeSessionArchiveManifestEntry> {
    return await this.enqueue(async () => {
      const providerSessionId = record.ref.providerSessionId;
      const existing = this.entries.get(providerSessionId);
      if (existing?.state === "archived" && existsSync(existing.archivedPath)) {
        return { ...existing, snapshot: { ...existing.snapshot } };
      }
      if (existing) {
        throw new Error(`Claude archive ${providerSessionId} is in state ${existing.state}.`);
      }

      const originalPath = path.resolve(record.filePath);
      if (
        !originalPath.endsWith(".jsonl") ||
        !isPathInside(originalPath, this.claudeProjectsRoot)
      ) {
        throw new Error(`Refusing to archive a Claude history path outside projects: ${originalPath}`);
      }
      const sourceStat = await stat(originalPath);
      if (!sourceStat.isFile()) {
        throw new Error(`Claude history is not a regular file: ${originalPath}`);
      }
      const archivedPath = path.join(
        this.filesRoot,
        safeSessionSegment(providerSessionId),
        path.basename(originalPath),
      );
      if (existsSync(archivedPath)) {
        throw new Error(`Claude archive target already exists: ${archivedPath}`);
      }
      const entry: ClaudeSessionArchiveManifestEntry = {
        provider: "claude",
        providerSessionId,
        originalPath,
        archivedPath,
        archivedAt: new Date().toISOString(),
        sizeBytes: sourceStat.size,
        mtimeMs: sourceStat.mtimeMs,
        state: "pending_archive",
        snapshot: { ...record.ref },
      };
      this.entries.set(providerSessionId, entry);
      this.persist();
      try {
        await moveFileExclusive(originalPath, archivedPath);
        const [archivedStat, sha256] = await Promise.all([
          stat(archivedPath),
          sha256File(archivedPath),
        ]);
        if (archivedStat.size !== sourceStat.size) {
          throw new Error(`Claude archive size verification failed for ${providerSessionId}.`);
        }
        const archivedEntry: ClaudeSessionArchiveManifestEntry = {
          ...entry,
          sizeBytes: archivedStat.size,
          sha256,
          state: "archived",
        };
        this.entries.set(providerSessionId, archivedEntry);
        this.persist();
        return { ...archivedEntry, snapshot: { ...archivedEntry.snapshot } };
      } catch (error) {
        this.recoverPendingEntries();
        this.persist();
        throw error;
      }
    });
  }

  async restore(providerSessionId: string): Promise<string> {
    return await this.enqueue(async () => {
      const entry = this.entries.get(providerSessionId);
      if (!entry || entry.state !== "archived") {
        throw new Error(`Could not find archived Claude session ${providerSessionId}.`);
      }
      if (!existsSync(entry.archivedPath)) {
        throw new Error(`Archived Claude history is missing: ${entry.archivedPath}`);
      }
      if (existsSync(entry.originalPath)) {
        throw new Error(`Claude restore target already exists: ${entry.originalPath}`);
      }
      const archivedStat = await stat(entry.archivedPath);
      if (archivedStat.size !== entry.sizeBytes) {
        throw new Error(`Archived Claude history size changed for ${providerSessionId}.`);
      }
      if (entry.sha256 && (await sha256File(entry.archivedPath)) !== entry.sha256) {
        throw new Error(`Archived Claude history checksum changed for ${providerSessionId}.`);
      }
      this.entries.set(providerSessionId, { ...entry, state: "pending_restore" });
      this.persist();
      try {
        await moveFileExclusive(entry.archivedPath, entry.originalPath);
        const restoredTime = new Date(entry.mtimeMs);
        await utimes(entry.originalPath, restoredTime, restoredTime);
        this.entries.delete(providerSessionId);
        this.persist();
        return entry.originalPath;
      } catch (error) {
        this.recoverPendingEntries();
        this.persist();
        throw error;
      }
    });
  }

  async removeArchived(providerSessionId: string): Promise<boolean> {
    return await this.enqueue(async () => {
      const entry = this.entries.get(providerSessionId);
      if (!entry) {
        return false;
      }
      if (entry.state !== "archived") {
        throw new Error(`Claude archive ${providerSessionId} is in state ${entry.state}.`);
      }
      await movePathToTrash(entry.archivedPath);
      this.entries.delete(providerSessionId);
      this.persist();
      return true;
    });
  }

  async flush(): Promise<void> {
    await this.mutationQueue;
  }

  private load(): void {
    if (!existsSync(this.manifestPath)) {
      return;
    }
    try {
      const parsed = JSON.parse(readFileSync(this.manifestPath, "utf8")) as Partial<ClaudeSessionArchiveManifest>;
      if (parsed.version !== MANIFEST_VERSION || !Array.isArray(parsed.entries)) {
        throw new Error("Unsupported Claude archive manifest version.");
      }
      this.entries = new Map(
        parsed.entries
          .map((entry) => sanitizeEntry(entry, this.filesRoot, this.claudeProjectsRoot))
          .filter((entry): entry is ClaudeSessionArchiveManifestEntry => entry !== null)
          .map((entry) => [entry.providerSessionId, entry] as const),
      );
      if (this.recoverPendingEntries()) {
        this.persist();
      }
    } catch (error) {
      const quarantinePath = `${this.manifestPath}.corrupt-${Date.now()}`;
      try {
        renameSync(this.manifestPath, quarantinePath);
      } catch {
        // Preserve the original read failure; a later archive attempt will fail
        // safely if an object path already exists.
      }
      this.entries.clear();
      console.warn("[rah:claude-archive] quarantined unreadable manifest", {
        manifestPath: this.manifestPath,
        quarantinePath,
        error,
      });
    }
  }

  private recoverPendingEntries(): boolean {
    let changed = false;
    for (const [providerSessionId, entry] of [...this.entries]) {
      const originalExists = existsSync(entry.originalPath);
      const archivedExists = existsSync(entry.archivedPath);
      if (entry.state === "pending_archive") {
        if (archivedExists && !originalExists) {
          this.entries.set(providerSessionId, { ...entry, state: "archived" });
          changed = true;
        } else if (originalExists && !archivedExists) {
          this.entries.delete(providerSessionId);
          changed = true;
        } else if (originalExists && archivedExists && sameFile(entry.originalPath, entry.archivedPath)) {
          unlinkSync(entry.originalPath);
          this.entries.set(providerSessionId, { ...entry, state: "archived" });
          changed = true;
        }
      } else if (entry.state === "pending_restore") {
        if (originalExists && !archivedExists) {
          this.entries.delete(providerSessionId);
          changed = true;
        } else if (!originalExists && archivedExists) {
          this.entries.set(providerSessionId, { ...entry, state: "archived" });
          changed = true;
        } else if (originalExists && archivedExists && sameFile(entry.originalPath, entry.archivedPath)) {
          unlinkSync(entry.archivedPath);
          this.entries.delete(providerSessionId);
          changed = true;
        }
      }
    }
    return changed;
  }

  private persist(): void {
    mkdirSync(this.rootDir, { recursive: true });
    const temporaryPath = `${this.manifestPath}.${process.pid}.${randomUUID()}.tmp`;
    const manifest: ClaudeSessionArchiveManifest = {
      version: MANIFEST_VERSION,
      updatedAt: new Date().toISOString(),
      entries: [...this.entries.values()],
    };
    writeFileSync(temporaryPath, `${JSON.stringify(manifest, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    renameSync(temporaryPath, this.manifestPath);
  }

  private async enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationQueue.then(operation);
    this.mutationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return await result;
  }
}

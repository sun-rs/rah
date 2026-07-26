import { createHash, randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import {
  appendFile,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import type {
  ProcessOutputAppend,
  ProcessOutputSnapshot,
} from "@rah/runtime-protocol";

const STORE_VERSION = 1;
const DEFAULT_MAX_PENDING_BYTES_PER_ITEM = 1024 * 1024;
const DEFAULT_MAX_PENDING_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_RESIDENT_ENTRIES = 512;
const DEFAULT_MAX_TOTAL_BYTES = 512 * 1024 * 1024;
const DEFAULT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1_000;
const DEFAULT_MAINTENANCE_INTERVAL_MS = 15 * 60 * 1_000;
const DEFAULT_STALE_FILE_GRACE_MS = 5 * 60 * 1_000;
const DEFAULT_FLUSH_INTERVAL_MS = 25;
const DEFAULT_FLUSH_BATCH_BYTES = 64 * 1024;

type PersistedOutputManifest = {
  version: typeof STORE_VERSION;
  sessionId: string;
  turnId?: string;
  itemId: string;
  dataFile: string;
  completedAt: string;
  output: ProcessOutputSnapshot;
  complete: boolean;
};

type OutputEntry = {
  key: string;
  sessionId: string;
  turnId?: string;
  itemId: string;
  dataFile: string;
  dataPath: string;
  manifestPath: string;
  pending: string[];
  pendingBytes: number;
  acceptedBytes: number;
  expectedSequence: number;
  initialized: boolean;
  incomplete: boolean;
  writing?: Promise<void>;
  flushTimer?: ReturnType<typeof setTimeout>;
  completed?: ProcessOutputSnapshot;
  manifestWritten: boolean;
  lastTouchedAt: number;
};

export type ProcessOutputStoreOptions = {
  rootDir?: string;
  maxPendingBytesPerItem?: number;
  maxPendingBytes?: number;
  maxOutputBytes?: number;
  maxResidentEntries?: number;
  maxTotalBytes?: number;
  maxAgeMs?: number;
  maintenanceIntervalMs?: number;
  staleFileGraceMs?: number;
  flushIntervalMs?: number;
  flushBatchBytes?: number;
  now?: () => number;
};

export type StoredProcessOutput = {
  output: ProcessOutputSnapshot;
  text: string;
};

function resolveRahHome(): string {
  return process.env.RAH_HOME ?? path.join(os.homedir(), ".rah");
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

function parseManifest(value: unknown): PersistedOutputManifest | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const candidate = value as Partial<PersistedOutputManifest>;
  if (
    candidate.version !== STORE_VERSION ||
    typeof candidate.sessionId !== "string" ||
    typeof candidate.itemId !== "string" ||
    typeof candidate.dataFile !== "string" ||
    path.basename(candidate.dataFile) !== candidate.dataFile ||
    typeof candidate.completedAt !== "string" ||
    typeof candidate.complete !== "boolean" ||
    !candidate.output ||
    typeof candidate.output !== "object"
  ) {
    return undefined;
  }
  return candidate as PersistedOutputManifest;
}

/**
 * Append-only detail store for live process output.
 *
 * The provider notification path only queues bounded chunks. Filesystem I/O is
 * coalesced asynchronously per item and both per-item and global pending bytes
 * are capped. If storage cannot keep up, the semantic live tail remains valid
 * while full-detail availability is explicitly downgraded.
 */
export class ProcessOutputStore {
  private readonly rootDir: string;
  private readonly maxPendingBytesPerItem: number;
  private readonly maxPendingBytes: number;
  private readonly maxOutputBytes: number;
  private readonly maxResidentEntries: number;
  private readonly maxTotalBytes: number;
  private readonly maxAgeMs: number;
  private readonly maintenanceIntervalMs: number;
  private readonly staleFileGraceMs: number;
  private readonly flushIntervalMs: number;
  private readonly flushBatchBytes: number;
  private readonly now: () => number;
  private readonly entries = new Map<string, OutputEntry>();
  private totalPendingBytes = 0;
  private maintenancePromise: Promise<void> | undefined;
  private lastMaintenanceAt: number;

  constructor(options: ProcessOutputStoreOptions = {}) {
    this.rootDir =
      options.rootDir ?? path.join(resolveRahHome(), "runtime-daemon", "process-output");
    this.maxPendingBytesPerItem = Math.max(
      0,
      options.maxPendingBytesPerItem ?? DEFAULT_MAX_PENDING_BYTES_PER_ITEM,
    );
    this.maxPendingBytes = Math.max(
      0,
      options.maxPendingBytes ?? DEFAULT_MAX_PENDING_BYTES,
    );
    this.maxOutputBytes = Math.max(
      0,
      options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
    );
    this.maxResidentEntries = Math.max(
      1,
      options.maxResidentEntries ?? DEFAULT_MAX_RESIDENT_ENTRIES,
    );
    this.maxTotalBytes = Math.max(
      0,
      options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES,
    );
    this.maxAgeMs = Math.max(0, options.maxAgeMs ?? DEFAULT_MAX_AGE_MS);
    this.maintenanceIntervalMs = Math.max(
      0,
      options.maintenanceIntervalMs ?? DEFAULT_MAINTENANCE_INTERVAL_MS,
    );
    this.staleFileGraceMs = Math.max(
      0,
      options.staleFileGraceMs ?? DEFAULT_STALE_FILE_GRACE_MS,
    );
    this.flushIntervalMs = Math.max(
      0,
      options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS,
    );
    this.flushBatchBytes = Math.max(
      1,
      options.flushBatchBytes ?? DEFAULT_FLUSH_BATCH_BYTES,
    );
    this.now = options.now ?? Date.now;
    this.lastMaintenanceAt = this.now();
  }

  append(args: {
    sessionId: string;
    turnId?: string;
    output: ProcessOutputAppend;
  }): void {
    const entry = this.getOrCreateEntry(args);
    entry.lastTouchedAt = this.now();
    const bytes = Buffer.byteLength(args.output.data, "utf8");
    if (
      args.output.sequence !== entry.expectedSequence ||
      args.output.offsetBytes !== entry.acceptedBytes
    ) {
      entry.incomplete = true;
    }
    entry.expectedSequence = args.output.sequence + 1;
    entry.acceptedBytes = args.output.totalBytes;

    if (
      bytes === 0 ||
      entry.incomplete ||
      args.output.totalBytes > this.maxOutputBytes ||
      entry.pendingBytes + bytes > this.maxPendingBytesPerItem ||
      this.totalPendingBytes + bytes > this.maxPendingBytes
    ) {
      if (bytes > 0) {
        entry.incomplete = true;
      }
      return;
    }

    entry.pending.push(args.output.data);
    entry.pendingBytes += bytes;
    this.totalPendingBytes += bytes;
    entry.manifestWritten = false;
    this.scheduleFlush(entry, entry.pendingBytes >= this.flushBatchBytes);
  }

  complete(args: {
    sessionId: string;
    turnId?: string;
    output: ProcessOutputSnapshot;
  }): void {
    const entry = this.getOrCreateEntry(args);
    entry.lastTouchedAt = this.now();
    if (entry.acceptedBytes !== args.output.totalBytes) {
      entry.incomplete = true;
    }
    args.output.detailAvailable = !entry.incomplete;
    entry.completed = { ...args.output };
    entry.manifestWritten = false;
    this.scheduleFlush(entry, true);
    this.evictResidentEntries();
    if (
      this.now() - this.lastMaintenanceAt >=
      this.maintenanceIntervalMs
    ) {
      void this.runMaintenance().catch((error) => {
        console.warn("[rah] process output maintenance failed", { error });
      });
    }
  }

  async read(
    sessionId: string,
    itemId: string,
  ): Promise<StoredProcessOutput | undefined> {
    const key = this.entryKey(sessionId, itemId);
    const resident = this.entries.get(key);
    if (resident) {
      await this.drain(resident);
      if (resident.incomplete || !resident.completed) {
        return undefined;
      }
      try {
        return {
          output: resident.completed,
          text: await readFile(resident.dataPath, "utf8"),
        };
      } catch (error) {
        if (isNotFound(error)) {
          return undefined;
        }
        throw error;
      }
    }

    const sessionDir = this.sessionDir(sessionId);
    const manifestPath = path.join(sessionDir, `${digest(itemId)}.json`);
    let manifest: PersistedOutputManifest | undefined;
    try {
      manifest = parseManifest(
        JSON.parse(await readFile(manifestPath, "utf8")) as unknown,
      );
    } catch (error) {
      if (isNotFound(error) || error instanceof SyntaxError) {
        return undefined;
      }
      throw error;
    }
    if (
      !manifest ||
      manifest.sessionId !== sessionId ||
      manifest.itemId !== itemId ||
      !manifest.complete
    ) {
      return undefined;
    }
    try {
      return {
        output: manifest.output,
        text: await readFile(path.join(sessionDir, manifest.dataFile), "utf8"),
      };
    } catch (error) {
      if (isNotFound(error)) {
        return undefined;
      }
      throw error;
    }
  }

  async flush(): Promise<void> {
    await Promise.all([...this.entries.values()].map((entry) => this.drain(entry)));
  }

  async runMaintenance(): Promise<void> {
    if (this.maintenancePromise) {
      return this.maintenancePromise;
    }
    const maintenance = (async () => {
      await this.flush();
      await mkdir(this.rootDir, { recursive: true, mode: 0o700 });
      const activePaths = new Set(
        [...this.entries.values()]
          .filter(
            (entry) =>
              Boolean(entry.writing) ||
              Boolean(entry.flushTimer) ||
              entry.pending.length > 0 ||
              !entry.completed ||
              !entry.manifestWritten,
          )
          .flatMap((entry) => [entry.dataPath, entry.manifestPath]),
      );
      const records: Array<{
        manifestPath: string;
        dataPath: string;
        completedAtMs: number;
        bytes: number;
      }> = [];
      const sessionDirs: string[] = [];
      const rootEntries = await readdir(this.rootDir, { withFileTypes: true });
      for (const rootEntry of rootEntries) {
        if (!rootEntry.isDirectory()) {
          continue;
        }
        const sessionDir = path.join(this.rootDir, rootEntry.name);
        sessionDirs.push(sessionDir);
        const entries = await readdir(sessionDir, { withFileTypes: true });
        const referencedDataFiles = new Set<string>();
        for (const entry of entries) {
          if (!entry.isFile() || !entry.name.endsWith(".json")) {
            continue;
          }
          const manifestPath = path.join(sessionDir, entry.name);
          let manifest: PersistedOutputManifest | undefined;
          try {
            manifest = parseManifest(
              JSON.parse(await readFile(manifestPath, "utf8")) as unknown,
            );
          } catch {
            manifest = undefined;
          }
          if (!manifest) {
            await this.removeIfStale(manifestPath, activePaths);
            continue;
          }
          const dataPath = path.join(sessionDir, manifest.dataFile);
          referencedDataFiles.add(manifest.dataFile);
          if (
            activePaths.has(manifestPath) ||
            activePaths.has(dataPath)
          ) {
            continue;
          }
          try {
            const [manifestStat, dataStat] = await Promise.all([
              stat(manifestPath),
              stat(dataPath),
            ]);
            const completedAtMs = Date.parse(manifest.completedAt);
            records.push({
              manifestPath,
              dataPath,
              completedAtMs: Number.isFinite(completedAtMs)
                ? completedAtMs
                : manifestStat.mtimeMs,
              bytes: manifestStat.size + dataStat.size,
            });
          } catch (error) {
            if (!isNotFound(error)) {
              throw error;
            }
            await this.removeIfStale(manifestPath, activePaths);
          }
        }
        for (const entry of entries) {
          if (
            !entry.isFile() ||
            (entry.name.endsWith(".log") &&
              referencedDataFiles.has(entry.name))
          ) {
            continue;
          }
          if (entry.name.endsWith(".log") || entry.name.endsWith(".tmp")) {
            await this.removeIfStale(
              path.join(sessionDir, entry.name),
              activePaths,
            );
          }
        }
      }

      const remove = new Set<(typeof records)[number]>();
      const cutoff = this.now() - this.maxAgeMs;
      for (const record of records) {
        if (this.maxAgeMs === 0 || record.completedAtMs <= cutoff) {
          remove.add(record);
        }
      }
      let retainedBytes = 0;
      for (const record of [...records].sort(
        (left, right) => right.completedAtMs - left.completedAtMs,
      )) {
        if (remove.has(record)) {
          continue;
        }
        retainedBytes += record.bytes;
        if (retainedBytes > this.maxTotalBytes) {
          remove.add(record);
        }
      }
      await Promise.all(
        [...remove].flatMap((record) => [
          rm(record.manifestPath, { force: true }),
          rm(record.dataPath, { force: true }),
        ]),
      );
      if (remove.size > 0) {
        const removedPaths = new Set(
          [...remove].flatMap((record) => [
            record.manifestPath,
            record.dataPath,
          ]),
        );
        for (const [key, entry] of this.entries) {
          if (
            removedPaths.has(entry.manifestPath) ||
            removedPaths.has(entry.dataPath)
          ) {
            this.entries.delete(key);
          }
        }
      }
      await Promise.all(
        sessionDirs.map(async (sessionDir) => {
          try {
            await rm(sessionDir, { recursive: false });
          } catch {
            // A non-empty session directory is expected.
          }
        }),
      );
      this.lastMaintenanceAt = this.now();
    })();
    this.maintenancePromise = maintenance;
    try {
      await maintenance;
    } finally {
      if (this.maintenancePromise === maintenance) {
        this.maintenancePromise = undefined;
      }
    }
  }

  private entryKey(sessionId: string, itemId: string): string {
    return `${sessionId}\0${itemId}`;
  }

  private sessionDir(sessionId: string): string {
    return path.join(this.rootDir, digest(sessionId));
  }

  private getOrCreateEntry(args: {
    sessionId: string;
    turnId?: string;
    output: { itemId: string };
  }): OutputEntry {
    const key = this.entryKey(args.sessionId, args.output.itemId);
    const existing = this.entries.get(key);
    if (existing) {
      if (args.turnId !== undefined && existing.turnId === undefined) {
        existing.turnId = args.turnId;
      }
      return existing;
    }
    const sessionDir = this.sessionDir(args.sessionId);
    const dataFile = `${digest(args.output.itemId)}-${randomUUID()}.log`;
    const entry: OutputEntry = {
      key,
      sessionId: args.sessionId,
      ...(args.turnId !== undefined ? { turnId: args.turnId } : {}),
      itemId: args.output.itemId,
      dataFile,
      dataPath: path.join(sessionDir, dataFile),
      manifestPath: path.join(sessionDir, `${digest(args.output.itemId)}.json`),
      pending: [],
      pendingBytes: 0,
      acceptedBytes: 0,
      expectedSequence: 1,
      initialized: false,
      incomplete: false,
      manifestWritten: false,
      lastTouchedAt: this.now(),
    };
    this.entries.set(key, entry);
    return entry;
  }

  private scheduleFlush(entry: OutputEntry, urgent = false): void {
    if (entry.writing) {
      return;
    }
    if (entry.flushTimer) {
      if (!urgent) {
        return;
      }
      clearTimeout(entry.flushTimer);
      delete entry.flushTimer;
    }
    entry.flushTimer = setTimeout(() => {
      delete entry.flushTimer;
      this.startFlush(entry);
    }, urgent ? 0 : this.flushIntervalMs);
    entry.flushTimer.unref?.();
  }

  private startFlush(entry: OutputEntry): void {
    if (entry.writing) {
      return;
    }
    if (entry.flushTimer) {
      clearTimeout(entry.flushTimer);
      delete entry.flushTimer;
    }
    entry.writing = this.flushEntry(entry)
      .catch((error) => {
        entry.incomplete = true;
        console.warn("[rah] failed to persist process output", {
          sessionId: entry.sessionId,
          itemId: entry.itemId,
          error,
        });
      })
      .finally(() => {
        delete entry.writing;
        if (
          entry.pending.length > 0 ||
          (entry.completed && !entry.manifestWritten && !entry.incomplete)
        ) {
          this.scheduleFlush(entry, Boolean(entry.completed));
        }
      });
  }

  private async flushEntry(entry: OutputEntry): Promise<void> {
    if (!entry.initialized) {
      await mkdir(path.dirname(entry.dataPath), { recursive: true });
      await writeFile(entry.dataPath, "", "utf8");
      entry.initialized = true;
    }
    const chunks = entry.pending.splice(0);
    const bytes = entry.pendingBytes;
    entry.pendingBytes = 0;
    this.totalPendingBytes = Math.max(0, this.totalPendingBytes - bytes);
    if (chunks.length > 0) {
      await appendFile(entry.dataPath, chunks.join(""), "utf8");
    }
    if (entry.completed && entry.pending.length === 0) {
      const manifest: PersistedOutputManifest = {
        version: STORE_VERSION,
        sessionId: entry.sessionId,
        ...(entry.turnId !== undefined ? { turnId: entry.turnId } : {}),
        itemId: entry.itemId,
        dataFile: entry.dataFile,
        completedAt: new Date(this.now()).toISOString(),
        output: {
          ...entry.completed,
          detailAvailable: !entry.incomplete,
        },
        complete: !entry.incomplete,
      };
      const temporary = `${entry.manifestPath}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify(manifest), "utf8");
      await rename(temporary, entry.manifestPath);
      entry.completed = manifest.output;
      entry.manifestWritten = true;
    }
  }

  private async drain(entry: OutputEntry): Promise<void> {
    while (
      entry.writing ||
      entry.flushTimer ||
      entry.pending.length > 0 ||
      (entry.completed && !entry.manifestWritten && !entry.incomplete)
    ) {
      if (!entry.writing) {
        this.startFlush(entry);
      }
      await entry.writing;
    }
  }

  private evictResidentEntries(): void {
    if (this.entries.size <= this.maxResidentEntries) {
      return;
    }
    const candidates = [...this.entries.values()]
      .filter(
        (entry) =>
          entry.completed &&
          !entry.writing &&
          !entry.flushTimer &&
          entry.pending.length === 0,
      )
      .sort((left, right) => left.lastTouchedAt - right.lastTouchedAt);
    while (
      this.entries.size > this.maxResidentEntries &&
      candidates.length > 0
    ) {
      const candidate = candidates.shift()!;
      this.entries.delete(candidate.key);
    }
  }

  private async removeIfStale(
    candidatePath: string,
    activePaths: ReadonlySet<string>,
  ): Promise<void> {
    if (activePaths.has(candidatePath)) {
      return;
    }
    try {
      const candidateStat = await stat(candidatePath);
      if (
        this.now() - candidateStat.mtimeMs >=
        this.staleFileGraceMs
      ) {
        await rm(candidatePath, { force: true });
      }
    } catch (error) {
      if (!isNotFound(error)) {
        throw error;
      }
    }
  }
}

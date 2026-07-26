import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { CodexAppServerTurnsPage } from "./codex-app-server-turns-page";

const CACHE_VERSION = 2;
const HISTORICAL_BOUNDARY_BYTES = 64 * 1024;
const DEFAULT_MAX_ENTRY_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_MEMORY_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_MEMORY_ENTRIES = 128;
const DEFAULT_MAX_DISK_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_DISK_ENTRIES = 256;

export type RolloutRevision = {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
};

type CacheEnvelope = {
  version: typeof CACHE_VERSION;
  cacheKey: string;
  providerSessionId: string;
  page: CodexAppServerTurnsPage;
  historicalValidation?: HistoricalCacheValidation;
};

type MemoryEntry = {
  providerSessionId: string;
  bytes: number;
  page: CodexAppServerTurnsPage;
  historicalValidation?: HistoricalCacheValidation;
};

type HistoricalCacheValidation = {
  revision: RolloutRevision;
  boundaryStart: number;
  boundaryLength: number;
  boundaryHash: string;
};

export type CodexTurnPageCacheOptions = {
  rootDir?: string;
  maxEntryBytes?: number;
  maxMemoryBytes?: number;
  maxMemoryEntries?: number;
  maxDiskBytes?: number;
  maxDiskEntries?: number;
};

function resolveRahRuntimeHome(): string {
  return (
    process.env.RAH_HOME ?? path.join(os.homedir(), ".rah", "runtime-daemon")
  );
}

function hash(value: string, length = 32): string {
  return createHash("sha256").update(value).digest("hex").slice(0, length);
}

function providerPrefix(providerSessionId: string): string {
  return hash(providerSessionId, 16);
}

async function readRolloutRevision(
  rolloutPath: string,
): Promise<RolloutRevision> {
  const stats = await stat(rolloutPath);
  return {
    dev: stats.dev,
    ino: stats.ino,
    size: stats.size,
    mtimeMs: stats.mtimeMs,
  };
}

function isRolloutRevision(value: unknown): value is RolloutRevision {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const revision = value as Record<string, unknown>;
  return (
    typeof revision.dev === "number" &&
    typeof revision.ino === "number" &&
    typeof revision.size === "number" &&
    typeof revision.mtimeMs === "number"
  );
}

function isHistoricalCacheValidation(
  value: unknown,
): value is HistoricalCacheValidation {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const validation = value as Record<string, unknown>;
  return (
    isRolloutRevision(validation.revision) &&
    typeof validation.boundaryStart === "number" &&
    typeof validation.boundaryLength === "number" &&
    typeof validation.boundaryHash === "string"
  );
}

async function hashRolloutRange(
  rolloutPath: string,
  start: number,
  length: number,
): Promise<string | undefined> {
  if (start < 0 || length <= 0) {
    return undefined;
  }
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(rolloutPath, "r");
    const body = Buffer.allocUnsafe(length);
    let offset = 0;
    while (offset < length) {
      const { bytesRead } = await handle.read(
        body,
        offset,
        length - offset,
        start + offset,
      );
      if (bytesRead <= 0) {
        return undefined;
      }
      offset += bytesRead;
    }
    return createHash("sha256").update(body).digest("hex");
  } catch {
    return undefined;
  } finally {
    if (handle) {
      await handle.close().catch(() => {});
    }
  }
}

async function createHistoricalValidation(
  rolloutPath: string,
  revision: RolloutRevision,
): Promise<HistoricalCacheValidation | undefined> {
  const boundaryLength = Math.min(revision.size, HISTORICAL_BOUNDARY_BYTES);
  if (boundaryLength <= 0) {
    return undefined;
  }
  const boundaryStart = revision.size - boundaryLength;
  const boundaryHash = await hashRolloutRange(
    rolloutPath,
    boundaryStart,
    boundaryLength,
  );
  if (!boundaryHash) {
    return undefined;
  }
  return { revision, boundaryStart, boundaryLength, boundaryHash };
}

async function canReuseHistoricalPage(
  rolloutPath: string,
  currentRevision: RolloutRevision,
  validation: HistoricalCacheValidation | undefined,
): Promise<boolean> {
  if (!validation) {
    return false;
  }
  const cachedRevision = validation.revision;
  if (
    currentRevision.dev !== cachedRevision.dev ||
    currentRevision.ino !== cachedRevision.ino ||
    currentRevision.size < cachedRevision.size
  ) {
    return false;
  }
  if (
    currentRevision.size === cachedRevision.size &&
    currentRevision.mtimeMs !== cachedRevision.mtimeMs
  ) {
    return false;
  }
  return (
    (await hashRolloutRange(
      rolloutPath,
      validation.boundaryStart,
      validation.boundaryLength,
    )) === validation.boundaryHash
  );
}

function isTurnsPage(value: unknown): value is CodexAppServerTurnsPage {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const page = value as Record<string, unknown>;
  return Array.isArray(page.data);
}

function isCacheEnvelope(
  value: unknown,
  cacheKey: string,
  providerSessionId: string,
): value is CacheEnvelope {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const envelope = value as Record<string, unknown>;
  return (
    envelope.version === CACHE_VERSION &&
    envelope.cacheKey === cacheKey &&
    envelope.providerSessionId === providerSessionId &&
    (envelope.historicalValidation === undefined ||
      isHistoricalCacheValidation(envelope.historicalValidation)) &&
    isTurnsPage(envelope.page)
  );
}

/**
 * Cache for the official Codex `thread/turns/list` summary response.
 *
 * The newest page is bound to the exact rollout revision. Cursor-addressed
 * historical pages are immutable under Codex's append-only rollout contract,
 * so they survive ordinary growth after a boundary fingerprint confirms that
 * the prior file tail is unchanged. Truncation, replacement, or in-place
 * rewrites still miss. The cache contains provider-native pages, so each
 * caller materializes events with its own runtime session id.
 */
export class CodexTurnPageCache {
  private readonly rootDir: string;
  private readonly maxEntryBytes: number;
  private readonly maxMemoryBytes: number;
  private readonly maxMemoryEntries: number;
  private readonly maxDiskBytes: number;
  private readonly maxDiskEntries: number;
  private readonly memory = new Map<string, MemoryEntry>();
  private readonly inFlight = new Map<
    string,
    Promise<CodexAppServerTurnsPage>
  >();
  private readonly generationByProvider = new Map<string, number>();
  private memoryBytes = 0;
  private prunePromise: Promise<void> | undefined;

  constructor(options: CodexTurnPageCacheOptions = {}) {
    this.rootDir =
      options.rootDir ??
      path.join(resolveRahRuntimeHome(), "conversation-page-cache", "codex");
    this.maxEntryBytes = Math.max(
      1,
      options.maxEntryBytes ?? DEFAULT_MAX_ENTRY_BYTES,
    );
    this.maxMemoryBytes = Math.max(
      1,
      options.maxMemoryBytes ?? DEFAULT_MAX_MEMORY_BYTES,
    );
    this.maxMemoryEntries = Math.max(
      1,
      options.maxMemoryEntries ?? DEFAULT_MAX_MEMORY_ENTRIES,
    );
    this.maxDiskBytes = Math.max(
      1,
      options.maxDiskBytes ?? DEFAULT_MAX_DISK_BYTES,
    );
    this.maxDiskEntries = Math.max(
      1,
      options.maxDiskEntries ?? DEFAULT_MAX_DISK_ENTRIES,
    );
  }

  async getOrLoad(args: {
    providerSessionId: string;
    rolloutPath: string;
    cursor?: string;
    limit: number;
    sourceSettled: boolean;
    load(revision: RolloutRevision): Promise<CodexAppServerTurnsPage>;
  }): Promise<CodexAppServerTurnsPage> {
    const revision = await readRolloutRevision(args.rolloutPath);
    const historical = Boolean(args.cursor);
    const requestIdentity = {
      version: CACHE_VERSION,
      providerSessionId: args.providerSessionId,
      revision: historical
        ? { dev: revision.dev, ino: revision.ino }
        : revision,
      cursor: args.cursor ?? null,
      limit: args.limit,
      sortDirection: "desc",
      itemsView: "summary",
      // Liveness reconciliation only affects the newest page.
      sourceState: args.cursor
        ? "historical"
        : args.sourceSettled
          ? "settled"
          : "active",
    };
    const cacheKey = hash(JSON.stringify(requestIdentity));
    const memoryPage = await this.readMemory(
      cacheKey,
      args.rolloutPath,
      revision,
      historical,
    );
    if (memoryPage) {
      return memoryPage;
    }
    const diskPage = await this.readDisk(
      cacheKey,
      args.providerSessionId,
      args.rolloutPath,
      revision,
      historical,
    );
    if (diskPage) {
      return diskPage;
    }
    const pending = this.inFlight.get(cacheKey);
    if (pending) {
      return pending;
    }

    const generation =
      this.generationByProvider.get(args.providerSessionId) ?? 0;
    const promise = args
      .load(revision)
      .then(async (page) => {
        if (!isTurnsPage(page)) {
          throw new Error("Codex thread/turns/list returned an invalid page.");
        }
        if (
          (this.generationByProvider.get(args.providerSessionId) ?? 0) ===
          generation
        ) {
          const historicalValidation = historical
            ? await createHistoricalValidation(args.rolloutPath, revision)
            : undefined;
          if (!historical || historicalValidation) {
            await this.store(
              cacheKey,
              args.providerSessionId,
              page,
              historicalValidation,
            );
          }
        }
        return page;
      })
      .finally(() => {
        if (this.inFlight.get(cacheKey) === promise) {
          this.inFlight.delete(cacheKey);
        }
      });
    this.inFlight.set(cacheKey, promise);
    return promise;
  }

  async clear(providerSessionId: string): Promise<void> {
    this.generationByProvider.set(
      providerSessionId,
      (this.generationByProvider.get(providerSessionId) ?? 0) + 1,
    );
    for (const [cacheKey, entry] of this.memory) {
      if (entry.providerSessionId === providerSessionId) {
        this.memory.delete(cacheKey);
        this.memoryBytes -= entry.bytes;
      }
    }
    const prefix = `${providerPrefix(providerSessionId)}-`;
    try {
      for (const entry of await readdir(this.rootDir, { withFileTypes: true })) {
        if (
          entry.isFile() &&
          entry.name.startsWith(prefix) &&
          entry.name.endsWith(".json")
        ) {
          await rm(path.join(this.rootDir, entry.name), { force: true });
        }
      }
    } catch {
      // A missing or unreadable cache directory is equivalent to an empty cache.
    }
  }

  private cachePath(cacheKey: string, providerSessionId: string): string {
    return path.join(
      this.rootDir,
      `${providerPrefix(providerSessionId)}-${cacheKey}.json`,
    );
  }

  private async readMemory(
    cacheKey: string,
    rolloutPath: string,
    revision: RolloutRevision,
    historical: boolean,
  ): Promise<CodexAppServerTurnsPage | undefined> {
    const entry = this.memory.get(cacheKey);
    if (!entry) {
      return undefined;
    }
    if (
      historical &&
      !(await canReuseHistoricalPage(
        rolloutPath,
        revision,
        entry.historicalValidation,
      ))
    ) {
      this.memory.delete(cacheKey);
      this.memoryBytes -= entry.bytes;
      return undefined;
    }
    this.memory.delete(cacheKey);
    this.memory.set(cacheKey, entry);
    return entry.page;
  }

  private async readDisk(
    cacheKey: string,
    providerSessionId: string,
    rolloutPath: string,
    revision: RolloutRevision,
    historical: boolean,
  ): Promise<CodexAppServerTurnsPage | undefined> {
    const cachePath = this.cachePath(cacheKey, providerSessionId);
    try {
      const stats = await stat(cachePath);
      if (stats.size > this.maxEntryBytes) {
        await rm(cachePath, { force: true });
        return undefined;
      }
      const body = await readFile(cachePath, "utf8");
      const parsed: unknown = JSON.parse(body);
      if (!isCacheEnvelope(parsed, cacheKey, providerSessionId)) {
        await rm(cachePath, { force: true });
        return undefined;
      }
      if (
        historical &&
        !(await canReuseHistoricalPage(
          rolloutPath,
          revision,
          parsed.historicalValidation,
        ))
      ) {
        await rm(cachePath, { force: true });
        return undefined;
      }
      this.remember(cacheKey, {
        providerSessionId,
        bytes: Buffer.byteLength(body, "utf8"),
        page: parsed.page,
        ...(parsed.historicalValidation
          ? { historicalValidation: parsed.historicalValidation }
          : {}),
      });
      return parsed.page;
    } catch {
      return undefined;
    }
  }

  private async store(
    cacheKey: string,
    providerSessionId: string,
    page: CodexAppServerTurnsPage,
    historicalValidation?: HistoricalCacheValidation,
  ): Promise<void> {
    const envelope: CacheEnvelope = {
      version: CACHE_VERSION,
      cacheKey,
      providerSessionId,
      page,
      ...(historicalValidation ? { historicalValidation } : {}),
    };
    const body = `${JSON.stringify(envelope)}\n`;
    const bytes = Buffer.byteLength(body, "utf8");
    if (bytes > this.maxEntryBytes) {
      return;
    }
    this.remember(cacheKey, {
      providerSessionId,
      bytes,
      page,
      ...(historicalValidation ? { historicalValidation } : {}),
    });

    let tempPath: string | undefined;
    try {
      await mkdir(this.rootDir, { recursive: true, mode: 0o700 });
      const cachePath = this.cachePath(cacheKey, providerSessionId);
      tempPath = `${cachePath}.${process.pid}.${randomUUID()}.tmp`;
      await writeFile(tempPath, body, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      await rename(tempPath, cachePath);
      tempPath = undefined;
      // Persistence is complete at this point. Retention runs in one
      // coalesced background lane so a cache hit never waits for a directory
      // inventory and concurrent page loads cannot fan out pruning work.
      void this.schedulePruneDisk();
    } catch {
      if (tempPath) {
        await rm(tempPath, { force: true }).catch(() => {});
      }
      // The official response remains usable when persistence is unavailable.
    }
  }

  private remember(cacheKey: string, entry: MemoryEntry): void {
    const existing = this.memory.get(cacheKey);
    if (existing) {
      this.memoryBytes -= existing.bytes;
      this.memory.delete(cacheKey);
    }
    this.memory.set(cacheKey, entry);
    this.memoryBytes += entry.bytes;
    while (
      this.memory.size > this.maxMemoryEntries ||
      this.memoryBytes > this.maxMemoryBytes
    ) {
      const oldestKey = this.memory.keys().next().value as string | undefined;
      if (!oldestKey) {
        break;
      }
      const oldest = this.memory.get(oldestKey);
      this.memory.delete(oldestKey);
      this.memoryBytes -= oldest?.bytes ?? 0;
    }
  }

  private schedulePruneDisk(): Promise<void> {
    if (this.prunePromise) {
      return this.prunePromise;
    }
    const promise = this.pruneDisk().finally(() => {
      if (this.prunePromise === promise) {
        this.prunePromise = undefined;
      }
    });
    this.prunePromise = promise;
    return promise;
  }

  private async pruneDisk(): Promise<void> {
    try {
      const directoryEntries = await readdir(this.rootDir, {
        withFileTypes: true,
      });
      const entries: Array<{
        filePath: string;
        bytes: number;
        mtimeMs: number;
      }> = [];
      for (const entry of directoryEntries) {
        if (!entry.isFile() || !entry.name.endsWith(".json")) {
          continue;
        }
        const filePath = path.join(this.rootDir, entry.name);
        try {
          const stats = await stat(filePath);
          entries.push({
            filePath,
            bytes: stats.size,
            mtimeMs: stats.mtimeMs,
          });
        } catch {
          // A concurrent clear may remove an entry between readdir and stat.
        }
      }
      entries.sort((left, right) => left.mtimeMs - right.mtimeMs);
      let totalBytes = entries.reduce((sum, entry) => sum + entry.bytes, 0);
      while (
        entries.length > this.maxDiskEntries ||
        totalBytes > this.maxDiskBytes
      ) {
        const oldest = entries.shift();
        if (!oldest) {
          break;
        }
        await rm(oldest.filePath, { force: true });
        totalBytes -= oldest.bytes;
      }
    } catch {
      // Pruning is best-effort and must never block history reads.
    }
  }
}

import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  mkdirSync,
  openSync,
  readSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
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

function readRolloutRevision(rolloutPath: string): RolloutRevision {
  const stats = statSync(rolloutPath);
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

function hashRolloutRange(
  rolloutPath: string,
  start: number,
  length: number,
): string | undefined {
  if (start < 0 || length <= 0) {
    return undefined;
  }
  let fd: number | undefined;
  try {
    fd = openSync(rolloutPath, "r");
    const body = Buffer.allocUnsafe(length);
    let offset = 0;
    while (offset < length) {
      const bytesRead = readSync(
        fd,
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
    if (fd !== undefined) {
      closeSync(fd);
    }
  }
}

function createHistoricalValidation(
  rolloutPath: string,
  revision: RolloutRevision,
): HistoricalCacheValidation | undefined {
  const boundaryLength = Math.min(revision.size, HISTORICAL_BOUNDARY_BYTES);
  if (boundaryLength <= 0) {
    return undefined;
  }
  const boundaryStart = revision.size - boundaryLength;
  const boundaryHash = hashRolloutRange(
    rolloutPath,
    boundaryStart,
    boundaryLength,
  );
  if (!boundaryHash) {
    return undefined;
  }
  return { revision, boundaryStart, boundaryLength, boundaryHash };
}

function canReuseHistoricalPage(
  rolloutPath: string,
  currentRevision: RolloutRevision,
  validation: HistoricalCacheValidation | undefined,
): boolean {
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
    hashRolloutRange(
      rolloutPath,
      validation.boundaryStart,
      validation.boundaryLength,
    ) === validation.boundaryHash
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
    const revision = readRolloutRevision(args.rolloutPath);
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
    const memoryPage = this.readMemory(
      cacheKey,
      args.rolloutPath,
      revision,
      historical,
    );
    if (memoryPage) {
      return memoryPage;
    }
    const diskPage = this.readDisk(
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
      .then((page) => {
        if (!isTurnsPage(page)) {
          throw new Error("Codex thread/turns/list returned an invalid page.");
        }
        if (
          (this.generationByProvider.get(args.providerSessionId) ?? 0) ===
          generation
        ) {
          const historicalValidation = historical
            ? createHistoricalValidation(args.rolloutPath, revision)
            : undefined;
          if (!historical || historicalValidation) {
            this.store(
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

  clear(providerSessionId: string): void {
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
      for (const entry of readdirSync(this.rootDir, { withFileTypes: true })) {
        if (
          entry.isFile() &&
          entry.name.startsWith(prefix) &&
          entry.name.endsWith(".json")
        ) {
          rmSync(path.join(this.rootDir, entry.name), { force: true });
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

  private readMemory(
    cacheKey: string,
    rolloutPath: string,
    revision: RolloutRevision,
    historical: boolean,
  ): CodexAppServerTurnsPage | undefined {
    const entry = this.memory.get(cacheKey);
    if (!entry) {
      return undefined;
    }
    if (
      historical &&
      !canReuseHistoricalPage(rolloutPath, revision, entry.historicalValidation)
    ) {
      this.memory.delete(cacheKey);
      this.memoryBytes -= entry.bytes;
      return undefined;
    }
    this.memory.delete(cacheKey);
    this.memory.set(cacheKey, entry);
    return entry.page;
  }

  private readDisk(
    cacheKey: string,
    providerSessionId: string,
    rolloutPath: string,
    revision: RolloutRevision,
    historical: boolean,
  ): CodexAppServerTurnsPage | undefined {
    const cachePath = this.cachePath(cacheKey, providerSessionId);
    try {
      const stats = statSync(cachePath);
      if (stats.size > this.maxEntryBytes) {
        rmSync(cachePath, { force: true });
        return undefined;
      }
      const body = readFileSync(cachePath, "utf8");
      const parsed: unknown = JSON.parse(body);
      if (!isCacheEnvelope(parsed, cacheKey, providerSessionId)) {
        rmSync(cachePath, { force: true });
        return undefined;
      }
      if (
        historical &&
        !canReuseHistoricalPage(
          rolloutPath,
          revision,
          parsed.historicalValidation,
        )
      ) {
        rmSync(cachePath, { force: true });
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

  private store(
    cacheKey: string,
    providerSessionId: string,
    page: CodexAppServerTurnsPage,
    historicalValidation?: HistoricalCacheValidation,
  ): void {
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
      mkdirSync(this.rootDir, { recursive: true, mode: 0o700 });
      const cachePath = this.cachePath(cacheKey, providerSessionId);
      tempPath = `${cachePath}.${process.pid}.${randomUUID()}.tmp`;
      writeFileSync(tempPath, body, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      renameSync(tempPath, cachePath);
      tempPath = undefined;
      this.pruneDisk();
    } catch {
      if (tempPath) {
        rmSync(tempPath, { force: true });
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

  private pruneDisk(): void {
    try {
      const entries = readdirSync(this.rootDir, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
        .map((entry) => {
          const filePath = path.join(this.rootDir, entry.name);
          const stats = statSync(filePath);
          return { filePath, bytes: stats.size, mtimeMs: stats.mtimeMs };
        })
        .sort((left, right) => left.mtimeMs - right.mtimeMs);
      let totalBytes = entries.reduce((sum, entry) => sum + entry.bytes, 0);
      while (
        entries.length > this.maxDiskEntries ||
        totalBytes > this.maxDiskBytes
      ) {
        const oldest = entries.shift();
        if (!oldest) {
          break;
        }
        rmSync(oldest.filePath, { force: true });
        totalBytes -= oldest.bytes;
      }
    } catch {
      // Pruning is best-effort and must never block history reads.
    }
  }
}

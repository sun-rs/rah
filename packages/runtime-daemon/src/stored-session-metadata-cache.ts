import {
  createWriteStream,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import {
  mkdir as mkdirAsync,
  rename as renameAsync,
  rm as rmAsync,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ProviderKind, StoredSessionRef } from "@rah/runtime-protocol";
import { streamJsonChunks } from "./json-response-stream";
import type { StoredSessionCatalogRecord } from "./stored-session-catalog-types";

type StoredSessionMetadataCacheEntry = {
  ref: StoredSessionRef;
  size: number;
  mtimeMs: number;
  version?: number;
};

type StoredSessionMetadataCacheFile = {
  entries: Record<string, StoredSessionMetadataCacheEntry>;
};

type StoredSessionCatalogSnapshotFile = {
  version: 1;
  records: readonly StoredSessionCatalogRecord[];
};

function resolveRahHome(): string {
  return process.env.RAH_HOME ?? path.join(os.homedir(), ".rah", "runtime-daemon");
}

function cacheFilePath(provider: ProviderKind, rootDir = resolveRahHome()): string {
  return path.join(rootDir, "stored-session-cache", `${provider}.json`);
}

function catalogSnapshotPath(): string {
  return path.join(resolveRahHome(), "stored-session-cache", "catalog.json");
}

function isStoredSessionCatalogRecord(value: unknown): value is StoredSessionCatalogRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Partial<StoredSessionCatalogRecord>;
  return (
    typeof record.storagePath === "string" &&
    Boolean(record.ref) &&
    typeof record.ref === "object" &&
    !Array.isArray(record.ref) &&
    (record.ref.provider === "codex" ||
      record.ref.provider === "claude" ||
      record.ref.provider === "opencode") &&
    typeof record.ref.providerSessionId === "string"
  );
}

export function loadStoredSessionCatalogSnapshot(): StoredSessionCatalogRecord[] {
  try {
    const parsed = JSON.parse(
      readFileSync(catalogSnapshotPath(), "utf8"),
    ) as StoredSessionCatalogSnapshotFile;
    if (parsed.version !== 1 || !Array.isArray(parsed.records)) {
      return [];
    }
    return parsed.records.filter(isStoredSessionCatalogRecord);
  } catch {
    return [];
  }
}

export async function writeStoredSessionCatalogSnapshot(
  records: readonly StoredSessionCatalogRecord[],
): Promise<void> {
  const targetPath = catalogSnapshotPath();
  const temporaryPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
  await mkdirAsync(path.dirname(targetPath), { recursive: true });
  try {
    await pipeline(
      Readable.from(
        streamJsonChunks({
          version: 1,
          records,
        } satisfies StoredSessionCatalogSnapshotFile),
      ),
      createWriteStream(temporaryPath, {
        flags: "wx",
        mode: 0o600,
      }),
    );
    await renameAsync(temporaryPath, targetPath);
  } catch (error) {
    await rmAsync(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
}

export function loadStoredSessionMetadataCache(
  provider: ProviderKind,
  rootDir?: string,
): Map<string, StoredSessionMetadataCacheEntry> {
  try {
    const parsed = JSON.parse(
      readFileSync(cacheFilePath(provider, rootDir), "utf8"),
    ) as StoredSessionMetadataCacheFile;
    return new Map(Object.entries(parsed.entries ?? {}));
  } catch {
    return new Map();
  }
}

export function loadStoredSessionCatalogCache(
  provider: Extract<ProviderKind, "codex" | "claude">,
): StoredSessionCatalogRecord[] {
  return [...loadStoredSessionMetadataCache(provider).entries()].map(
    ([storagePath, entry]) => ({
      ref: entry.ref,
      storagePath,
      ...(provider === "codex"
        ? { archived: entry.ref.providerState?.archived === true }
        : {}),
    }),
  );
}

export function writeStoredSessionMetadataCache(
  provider: ProviderKind,
  entries: Map<string, StoredSessionMetadataCacheEntry>,
  rootDir?: string,
): void {
  const targetPath = cacheFilePath(provider, rootDir);
  mkdirSync(path.dirname(targetPath), { recursive: true });
  writeFileSync(
    targetPath,
    JSON.stringify({
      entries: Object.fromEntries(entries),
    } satisfies StoredSessionMetadataCacheFile),
  );
}

export function getCachedStoredSessionRef(args: {
  cache: Map<string, StoredSessionMetadataCacheEntry>;
  filePath: string;
  size: number;
  mtimeMs: number;
  version?: number;
}): StoredSessionRef | null {
  const cached = args.cache.get(args.filePath);
  if (!cached) {
    return null;
  }
  if (args.version !== undefined && cached.version !== args.version) {
    return null;
  }
  return cached.size === args.size && cached.mtimeMs === args.mtimeMs ? cached.ref : null;
}

export function getCachedStoredSessionHistoryMeta(args: {
  cache: Map<string, StoredSessionMetadataCacheEntry>;
  filePath: string;
  size: number;
  mtimeMs: number;
}): StoredSessionRef["historyMeta"] | undefined {
  const cached = args.cache.get(args.filePath);
  if (!cached || cached.size !== args.size || cached.mtimeMs !== args.mtimeMs) {
    return undefined;
  }
  return cached.ref.historyMeta;
}

export function setCachedStoredSessionRef(args: {
  cache: Map<string, StoredSessionMetadataCacheEntry>;
  filePath: string;
  size: number;
  mtimeMs: number;
  ref: StoredSessionRef;
  version?: number;
}): void {
  args.cache.set(args.filePath, {
    ref: args.ref,
    size: args.size,
    mtimeMs: args.mtimeMs,
    ...(args.version !== undefined ? { version: args.version } : {}),
  });
}

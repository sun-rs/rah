import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ProviderKind, StoredSessionRef } from "@rah/runtime-protocol";

type StoredSessionMetadataCacheEntry = {
  ref: StoredSessionRef;
  size: number;
  mtimeMs: number;
};

type StoredSessionMetadataCacheFile = {
  entries: Record<string, StoredSessionMetadataCacheEntry>;
};

function resolveRahHome(): string {
  return process.env.RAH_HOME ?? path.join(os.homedir(), ".rah", "runtime-daemon");
}

function cacheFilePath(provider: ProviderKind): string {
  return path.join(resolveRahHome(), "stored-session-cache", `${provider}.json`);
}

export function loadStoredSessionMetadataCache(
  provider: ProviderKind,
): Map<string, StoredSessionMetadataCacheEntry> {
  try {
    const parsed = JSON.parse(
      readFileSync(cacheFilePath(provider), "utf8"),
    ) as StoredSessionMetadataCacheFile;
    return new Map(Object.entries(parsed.entries ?? {}));
  } catch {
    return new Map();
  }
}

export function writeStoredSessionMetadataCache(
  provider: ProviderKind,
  entries: Map<string, StoredSessionMetadataCacheEntry>,
): void {
  const targetPath = cacheFilePath(provider);
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
}): StoredSessionRef | null {
  const cached = args.cache.get(args.filePath);
  if (!cached) {
    return null;
  }
  return cached.size === args.size && cached.mtimeMs === args.mtimeMs ? cached.ref : null;
}

export function setCachedStoredSessionRef(args: {
  cache: Map<string, StoredSessionMetadataCacheEntry>;
  filePath: string;
  size: number;
  mtimeMs: number;
  ref: StoredSessionRef;
}): void {
  args.cache.set(args.filePath, {
    ref: args.ref,
    size: args.size,
    mtimeMs: args.mtimeMs,
  });
}

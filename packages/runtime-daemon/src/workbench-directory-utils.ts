import { realpath } from "node:fs/promises";
import os from "node:os";
import path, { resolve } from "node:path";
import type { StoredSessionState } from "./session-store";

const DIRECTORY_IDENTITY_CACHE_LIMIT = 4_096;
const DIRECTORY_IDENTITY_REFRESH_MS = 60_000;

type DirectoryIdentityCacheEntry = {
  canonical: string;
  resolvedAt: number;
};

const directoryIdentityCache = new Map<string, DirectoryIdentityCacheEntry>();
const directoryIdentityInFlight = new Map<string, Promise<string>>();

export function normalizeDirectory(value: string | undefined): string | null {
  if (!value) {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const withoutTrailing = trimmed.replace(/[\\/]+$/, "") || trimmed[0] || "";
  if (withoutTrailing.startsWith("/private/var/")) {
    return withoutTrailing.slice("/private".length);
  }
  return withoutTrailing;
}

export function resolveUserPath(rawPath: string): string {
  const trimmed = rawPath.trim();
  if (!trimmed || trimmed === "~") {
    return os.homedir();
  }
  if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
    return resolve(os.homedir(), trimmed.slice(2));
  }
  return resolve(trimmed);
}

export function canonicalDirectoryKey(value: string | undefined): string | null {
  const normalized = normalizeDirectory(value);
  if (!normalized) {
    return null;
  }
  const absolute = resolve(normalized);
  const cached = directoryIdentityCache.get(absolute);
  if (cached) {
    // Refresh LRU order without ever touching the filesystem from a render,
    // list, or authorization comparison hot path.
    directoryIdentityCache.delete(absolute);
    directoryIdentityCache.set(absolute, cached);
    return cached.canonical;
  }
  return normalizeDirectory(absolute);
}

export async function canonicalDirectoryKeyAsync(
  value: string | undefined,
  options?: { forceRefresh?: boolean },
): Promise<string | null> {
  const normalized = normalizeDirectory(value);
  if (!normalized) {
    return null;
  }
  const absolute = resolve(normalized);
  const cached = directoryIdentityCache.get(absolute);
  if (
    cached &&
    !options?.forceRefresh &&
    Date.now() - cached.resolvedAt < DIRECTORY_IDENTITY_REFRESH_MS
  ) {
    return cached.canonical;
  }
  const existing = directoryIdentityInFlight.get(absolute);
  if (existing) {
    return await existing;
  }
  const resolution = resolveCanonicalDirectoryIdentity(absolute)
    .then((canonical) => {
      cacheDirectoryIdentity(absolute, canonical);
      cacheDirectoryIdentity(canonical, canonical);
      return canonical;
    })
    .finally(() => {
      directoryIdentityInFlight.delete(absolute);
    });
  directoryIdentityInFlight.set(absolute, resolution);
  return await resolution;
}

export async function primeCanonicalDirectoryKeys(
  values: readonly (string | undefined)[],
): Promise<void> {
  const unique = [...new Set(
    values
      .map((value) => normalizeDirectory(value))
      .filter((value): value is string => value !== null),
  )];
  await Promise.all(unique.map((value) => canonicalDirectoryKeyAsync(value)));
}

async function resolveCanonicalDirectoryIdentity(absolute: string): Promise<string> {
  const missingSegments: string[] = [];
  let existingPrefix = absolute;
  const root = path.parse(absolute).root;
  while (true) {
    try {
      const resolvedPrefix = await realpath(existingPrefix);
      return (
        normalizeDirectory(path.join(resolvedPrefix, ...missingSegments)) ??
        normalizeDirectory(absolute) ??
        absolute
      );
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (
        existingPrefix === root ||
        (code !== "ENOENT" && code !== "ENOTDIR")
      ) {
        return normalizeDirectory(absolute) ?? absolute;
      }
      missingSegments.unshift(path.basename(existingPrefix));
      existingPrefix = path.dirname(existingPrefix);
    }
  }
}

function cacheDirectoryIdentity(absolute: string, canonical: string): void {
  directoryIdentityCache.delete(absolute);
  directoryIdentityCache.set(absolute, {
    canonical,
    resolvedAt: Date.now(),
  });
  while (directoryIdentityCache.size > DIRECTORY_IDENTITY_CACHE_LIMIT) {
    const oldest = directoryIdentityCache.keys().next().value;
    if (typeof oldest !== "string") {
      break;
    }
    directoryIdentityCache.delete(oldest);
  }
}

export function sessionBelongsToWorkspace(
  sessionPath: string | undefined,
  workspaceDir: string,
): boolean {
  const normalizedSession = normalizeDirectory(sessionPath);
  const normalizedWorkspace = normalizeDirectory(workspaceDir);
  if (!normalizedSession || !normalizedWorkspace) {
    return false;
  }
  const sessionKey = canonicalDirectoryKey(normalizedSession) ?? normalizedSession;
  const workspaceKey = canonicalDirectoryKey(normalizedWorkspace) ?? normalizedWorkspace;
  if (normalizedWorkspace === "/" || normalizedWorkspace === "\\") {
    return true;
  }
  return (
    sessionKey === workspaceKey ||
    sessionKey.startsWith(`${workspaceKey}/`) ||
    sessionKey.startsWith(`${workspaceKey}\\`)
  );
}

export function findOwningWorkspaceDirectory(
  workspaceDirs: readonly string[],
  sessionPath: string | undefined,
): string | null {
  const candidates = workspaceDirs
    .map((workspaceDir) => {
      const directory = normalizeDirectory(workspaceDir);
      if (!directory) {
        return null;
      }
      return {
        directory,
        key: canonicalDirectoryKey(directory) ?? directory,
      };
    })
    .filter((candidate): candidate is { directory: string; key: string } => candidate !== null)
    .sort((left, right) => right.key.length - left.key.length);

  for (const candidate of candidates) {
    if (sessionBelongsToWorkspace(sessionPath, candidate.directory)) {
      return candidate.directory;
    }
  }
  return null;
}

export function isReadOnlyReplaySession(state: StoredSessionState): boolean {
  return (
    state.session.providerSessionId !== undefined &&
    !state.session.capabilities.steerInput &&
    !state.session.capabilities.livePermissions
  );
}

export function configuredWorkspaceDirs(
  rememberedWorkspaceDirs: readonly string[],
): string[] {
  const directories: string[] = [];
  const seen = new Set<string>();
  for (const rememberedWorkspaceDir of rememberedWorkspaceDirs) {
    const directory = normalizeDirectory(rememberedWorkspaceDir);
    const key = canonicalDirectoryKey(directory ?? undefined);
    if (!directory || !key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    directories.push(directory);
  }
  return directories;
}

export function workspaceDirsFromState(
  rememberedWorkspaceDirs: readonly string[],
  liveStates: readonly StoredSessionState[],
): string[] {
  const directories = configuredWorkspaceDirs(rememberedWorkspaceDirs);
  const seen = new Set(directories.map((directory) => canonicalDirectoryKey(directory)));
  for (const state of liveStates) {
    if (isReadOnlyReplaySession(state)) {
      continue;
    }
    const directory = normalizeDirectory(state.session.rootDir || state.session.cwd);
    const key = canonicalDirectoryKey(directory ?? undefined);
    if (directory && key && !seen.has(key)) {
      seen.add(key);
      directories.push(directory);
    }
  }
  return directories;
}

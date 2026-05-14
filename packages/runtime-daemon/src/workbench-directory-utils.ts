import { existsSync, realpathSync } from "node:fs";
import os from "node:os";
import path, { resolve } from "node:path";
import type { StoredSessionState } from "./session-store";

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
  const missingSegments: string[] = [];
  let existingPrefix = absolute;
  const root = path.parse(absolute).root;
  while (!existsSync(existingPrefix) && existingPrefix !== root) {
    missingSegments.unshift(path.basename(existingPrefix));
    existingPrefix = path.dirname(existingPrefix);
  }
  if (!existsSync(existingPrefix)) {
    return normalized;
  }
  try {
    return normalizeDirectory(path.join(realpathSync.native(existingPrefix), ...missingSegments));
  } catch {
    return normalized;
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

export function isReadOnlyReplaySession(state: StoredSessionState): boolean {
  return (
    state.session.providerSessionId !== undefined &&
    !state.session.capabilities.steerInput &&
    !state.session.capabilities.livePermissions
  );
}

export function workspaceDirsFromState(
  rememberedWorkspaceDirs: readonly string[],
  liveStates: readonly StoredSessionState[],
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

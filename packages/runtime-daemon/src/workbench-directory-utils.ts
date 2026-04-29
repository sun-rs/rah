import os from "node:os";
import { resolve } from "node:path";
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

export function sessionBelongsToWorkspace(
  sessionPath: string | undefined,
  workspaceDir: string,
): boolean {
  const normalizedSession = normalizeDirectory(sessionPath);
  const normalizedWorkspace = normalizeDirectory(workspaceDir);
  if (!normalizedSession || !normalizedWorkspace) {
    return false;
  }
  return (
    normalizedSession === normalizedWorkspace ||
    normalizedSession.startsWith(`${normalizedWorkspace}/`) ||
    normalizedSession.startsWith(`${normalizedWorkspace}\\`)
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
    if (!directory || seen.has(directory)) {
      continue;
    }
    seen.add(directory);
    directories.push(directory);
  }
  for (const state of liveStates) {
    if (isReadOnlyReplaySession(state)) {
      continue;
    }
    const directory = normalizeDirectory(state.session.rootDir || state.session.cwd);
    if (directory && !seen.has(directory)) {
      seen.add(directory);
      directories.push(directory);
    }
  }
  return directories;
}

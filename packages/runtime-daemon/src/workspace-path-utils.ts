import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import type {
  SessionFileResponse,
  SessionFileSearchItem,
} from "@rah/runtime-protocol";

const MAX_READABLE_FILE_BYTES = 1_000_000;

export type WorkspaceFileData = Omit<SessionFileResponse, "sessionId">;

export function getWorkspaceSnapshot(cwd: string) {
  return {
    cwd,
    nodes: readWorkspaceNodes(cwd),
  };
}

export function searchWorkspaceFilesInDirectory(
  cwd: string,
  query: string,
  limit = 100,
): SessionFileSearchItem[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return [];
  }
  try {
    const output = execFileSync("rg", ["--files", "."], {
      cwd,
      encoding: "utf8",
    });
    return output
      .split(/\r?\n/)
      .filter(Boolean)
      .filter((relativePath) => relativePath.toLowerCase().includes(normalizedQuery))
      .slice(0, limit)
      .map((relativePath) => ({
        path: relativePath,
        name: path.basename(relativePath),
        parentPath: path.dirname(relativePath) === "." ? "" : path.dirname(relativePath),
      }));
  } catch {
    return [];
  }
}

export function readWorkspaceFileData(
  cwd: string,
  targetPath: string,
  options?: { scopeRoot?: string },
): WorkspaceFileData {
  const resolvedPath = resolveWorkspacePath(options?.scopeRoot ?? cwd, targetPath);
  const stats = statSync(resolvedPath);
  if (!stats.isFile()) {
    throw new Error("Path is not a file.");
  }
  const buffer = readFileSync(resolvedPath);
  const truncated = buffer.byteLength > MAX_READABLE_FILE_BYTES;
  const contentBuffer = truncated ? buffer.subarray(0, MAX_READABLE_FILE_BYTES) : buffer;
  const binary = isLikelyBinary(contentBuffer);
  return {
    path: resolvedPath,
    content: binary ? "" : contentBuffer.toString("utf8"),
    binary,
    ...(truncated ? { truncated: true } : {}),
  };
}

export function readWorkspaceFileFromDirectory(
  cwd: string,
  targetPath: string,
  options?: { scopeRoot?: string },
): SessionFileResponse {
  return {
    sessionId: "",
    ...readWorkspaceFileData(cwd, targetPath, options),
  };
}

export function tryResolveGitRoot(cwd: string): string | null {
  try {
    const root = execFileSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
    }).trim();
    return root ? path.resolve(root) : null;
  } catch {
    return null;
  }
}

export function normalizeComparablePath(value: string): string {
  const resolved = path.resolve(value);
  return resolved.startsWith("/private/var/") ? resolved.slice("/private".length) : resolved;
}

export function isPathWithinBase(basePath: string, targetPath: string): boolean {
  const resolvedBase = normalizeComparablePath(basePath);
  const resolvedTarget = normalizeComparablePath(targetPath);
  const relativePath = path.relative(resolvedBase, resolvedTarget);
  return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

export function resolveWorkspacePath(cwd: string, targetPath: string): string {
  const scopeRoot = path.resolve(cwd);
  const cwdCandidate = tryResolveWithinBase(scopeRoot, targetPath);
  const gitRoot = tryResolveGitRoot(cwd);
  const gitRootCandidate =
    gitRoot && path.resolve(gitRoot) !== scopeRoot ? path.resolve(gitRoot, targetPath) : null;

  if (cwdCandidate && pathExists(cwdCandidate)) {
    return cwdCandidate;
  }
  if (
    gitRootCandidate &&
    isPathWithinBase(scopeRoot, gitRootCandidate) &&
    pathExists(gitRootCandidate)
  ) {
    return gitRootCandidate;
  }
  if (gitRootCandidate && isPathWithinBase(scopeRoot, gitRootCandidate)) {
    return gitRootCandidate;
  }
  if (cwdCandidate) {
    return cwdCandidate;
  }
  throw new Error("Path must remain inside the workspace.");
}

function tryResolveWithinBase(basePath: string, targetPath: string): string | null {
  const resolvedBase = path.resolve(basePath);
  const resolvedTarget = path.resolve(resolvedBase, targetPath);
  if (!isPathWithinBase(resolvedBase, resolvedTarget)) {
    return null;
  }
  return resolvedTarget;
}

function pathExists(targetPath: string): boolean {
  try {
    statSync(targetPath);
    return true;
  } catch {
    return false;
  }
}

function isLikelyBinary(buffer: Buffer): boolean {
  if (buffer.length === 0) {
    return false;
  }
  let nonPrintableCount = 0;
  for (const byte of buffer) {
    if (byte === 0) {
      return true;
    }
    if (byte < 32 && byte !== 9 && byte !== 10 && byte !== 13) {
      nonPrintableCount += 1;
    }
  }
  return nonPrintableCount / buffer.length > 0.1;
}

function readWorkspaceNodes(cwd: string) {
  try {
    return readdirSync(cwd, { withFileTypes: true })
      .slice(0, 200)
      .map((entry) => ({
        path: path.join(cwd, entry.name),
        name: entry.name,
        kind: entry.isDirectory() ? ("directory" as const) : ("file" as const),
      }));
  } catch {
    return [];
  }
}

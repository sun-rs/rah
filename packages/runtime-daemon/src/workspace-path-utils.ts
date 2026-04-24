import { execFile } from "node:child_process";
import { promises as fs, readdirSync } from "node:fs";
import path from "node:path";
import type {
  SessionFileResponse,
  SessionFileSearchItem,
} from "@rah/runtime-protocol";

const MAX_READABLE_FILE_BYTES = 1_000_000;

export type WorkspaceFileData = Omit<SessionFileResponse, "sessionId">;

async function execFileUtf8(
  command: string,
  args: string[],
  options?: { cwd?: string },
): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    execFile(command, args, { encoding: "utf8", ...(options?.cwd ? { cwd: options.cwd } : {}) }, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(stdout);
    });
  });
}

export function getWorkspaceSnapshot(cwd: string) {
  return {
    cwd,
    nodes: readWorkspaceNodes(cwd),
  };
}

export async function searchWorkspaceFilesInDirectoryAsync(
  cwd: string,
  query: string,
  limit = 100,
): Promise<SessionFileSearchItem[]> {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return [];
  }
  try {
    const output = await execFileUtf8("rg", ["--files", "."], { cwd });
    return output
      .split(/\r?\n/)
      .filter(Boolean)
      .map(normalizeWorkspaceSearchPath)
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

export async function readWorkspaceFileDataAsync(
  cwd: string,
  targetPath: string,
  options?: { scopeRoot?: string },
): Promise<WorkspaceFileData> {
  const resolvedPath = await resolveWorkspacePathAsync(options?.scopeRoot ?? cwd, targetPath);
  const stats = await fs.stat(resolvedPath);
  if (!stats.isFile()) {
    throw new Error("Path is not a file.");
  }
  const buffer = await fs.readFile(resolvedPath);
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

export async function readWorkspaceFileFromDirectoryAsync(
  cwd: string,
  targetPath: string,
  options?: { scopeRoot?: string },
): Promise<SessionFileResponse> {
  return {
    sessionId: "",
    ...(await readWorkspaceFileDataAsync(cwd, targetPath, options)),
  };
}

export async function tryResolveGitRootAsync(cwd: string): Promise<string | null> {
  try {
    const root = (await execFileUtf8("git", ["-C", cwd, "rev-parse", "--show-toplevel"])).trim();
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

export async function resolveWorkspacePathAsync(cwd: string, targetPath: string): Promise<string> {
  const scopeRoot = path.resolve(cwd);
  const cwdCandidate = tryResolveWithinBase(scopeRoot, targetPath);
  const gitRoot = await tryResolveGitRootAsync(cwd);
  const gitRootCandidate =
    gitRoot && path.resolve(gitRoot) !== scopeRoot ? path.resolve(gitRoot, targetPath) : null;

  if (cwdCandidate && (await pathExistsAsync(cwdCandidate))) {
    return cwdCandidate;
  }
  if (
    gitRootCandidate &&
    isPathWithinBase(scopeRoot, gitRootCandidate) &&
    (await pathExistsAsync(gitRootCandidate))
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

async function pathExistsAsync(targetPath: string): Promise<boolean> {
  try {
    await fs.stat(targetPath);
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

function normalizeWorkspaceSearchPath(relativePath: string): string {
  return relativePath.startsWith("./") ? relativePath.slice(2) : relativePath;
}

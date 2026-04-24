import { spawn } from "node:child_process";
import path from "node:path";
import type {
  GitChangedFile,
  GitDiffResponse,
  GitFileActionRequest,
  GitFileActionResponse,
  GitHunkActionRequest,
  GitHunkActionResponse,
  GitStatusResponse,
} from "@rah/runtime-protocol";
import {
  isPathWithinBase,
  normalizeComparablePath,
  resolveWorkspacePathAsync,
  tryResolveGitRootAsync,
} from "./workspace-path-utils";

type DiffStat = {
  added: number;
  removed: number;
  binary: boolean;
};

type ParsedFileDiff = {
  headerLines: string[];
  hunks: Array<{
    headerLine: string;
    bodyLines: string[];
  }>;
};

export type WorkspaceGitStatusData = {
  branch?: string;
  changedFiles: string[];
  stagedFiles: GitChangedFile[];
  unstagedFiles: GitChangedFile[];
  totalStaged: number;
  totalUnstaged: number;
};

export async function getWorkspaceGitStatusAsync(
  cwd: string,
  options?: { scopeRoot?: string },
): Promise<GitStatusResponse> {
  return {
    sessionId: "",
    ...(await getWorkspaceGitStatusDataAsync(cwd, options)),
  };
}

export async function getWorkspaceGitDiffAsync(
  cwd: string,
  targetPath: string,
  options?: { staged?: boolean; ignoreWhitespace?: boolean; scopeRoot?: string },
): Promise<GitDiffResponse["diff"]> {
  try {
    const gitBase = options?.scopeRoot ?? cwd;
    const gitCwd = await tryResolveGitRootAsync(gitBase);
    if (!gitCwd) {
      return "";
    }
    const relativeGitPath = await toGitPathAsync(gitBase, targetPath);
    const args = ["-C", gitCwd, "diff"];
    if (options?.staged) {
      args.push("--cached");
    }
    if (options?.ignoreWhitespace) {
      args.push("-w");
    }
    args.push("--", relativeGitPath);
    return await runGitCommand(gitCwd, args.slice(2));
  } catch {
    return "";
  }
}

export async function applyWorkspaceGitFileActionAsync(
  cwd: string,
  request: GitFileActionRequest,
  options?: { scopeRoot?: string },
): Promise<GitFileActionResponse> {
  const gitCwd = await getGitCommandCwdAsync(cwd);
  const relativeGitPath = await toGitPathAsync(options?.scopeRoot ?? cwd, request.path);
  if (request.action === "stage") {
    await execGitFileAsync(gitCwd, ["add", "--", relativeGitPath]);
  } else {
    await execGitFileAsync(gitCwd, ["restore", "--staged", "--", relativeGitPath]);
  }
  return {
    sessionId: "",
    path: request.path,
    ...(request.staged !== undefined ? { staged: request.staged } : {}),
    action: request.action,
    ok: true,
  };
}

export async function applyWorkspaceGitHunkActionAsync(
  cwd: string,
  request: GitHunkActionRequest,
  options?: { scopeRoot?: string },
): Promise<GitHunkActionResponse> {
  const gitCwd = await getGitCommandCwdAsync(cwd);
  const scopeRoot = options?.scopeRoot ?? cwd;
  const diff = await getWorkspaceGitDiffAsync(cwd, request.path, {
    ...(request.staged !== undefined ? { staged: request.staged } : {}),
    ignoreWhitespace: false,
    scopeRoot,
  });
  const parsed = parseSingleFileDiff(diff);
  if (!parsed) {
    throw new Error("No diff available for this file.");
  }
  const patch = buildSingleHunkPatch(parsed, request.hunkIndex);

  if (request.action === "stage") {
    if (request.staged) {
      throw new Error("Hunk is already staged.");
    }
    await execGitApplyAsync(gitCwd, ["--cached"], patch);
  } else if (request.action === "unstage") {
    if (!request.staged) {
      throw new Error("Only staged hunks can be unstaged.");
    }
    await execGitApplyAsync(gitCwd, ["--cached", "-R"], patch);
  } else {
    if (request.staged) {
      throw new Error("Revert is only supported for unstaged hunks.");
    }
    await execGitApplyAsync(gitCwd, ["-R"], patch);
  }

  return {
    sessionId: "",
    path: request.path,
    hunkIndex: request.hunkIndex,
    ...(request.staged !== undefined ? { staged: request.staged } : {}),
    action: request.action,
    ok: true,
  };
}

export async function getWorkspaceGitStatusDataAsync(
  cwd: string,
  options?: { scopeRoot?: string },
): Promise<WorkspaceGitStatusData> {
  return await tryReadGitStatusAsync(cwd, options);
}

async function tryReadGitStatusAsync(
  cwd: string,
  options?: { scopeRoot?: string },
): Promise<WorkspaceGitStatusData> {
  try {
    const scopeRoot = path.resolve(options?.scopeRoot ?? cwd);
    const gitCwd = await tryResolveGitRootAsync(options?.scopeRoot ?? cwd);
    if (!gitCwd) {
      return {
        changedFiles: [],
        stagedFiles: [],
        unstagedFiles: [],
        totalStaged: 0,
        totalUnstaged: 0,
      };
    }
    const output = await runGitCommand(gitCwd, ["status", "--porcelain", "--branch"]);
    const lines = output.split(/\r?\n/).filter(Boolean);
    const branchLine = lines[0] ?? "";
    const branchMatch = /^## ([^.\s]+)/.exec(branchLine);
    const unstagedStats = createDiffStatsMap(parseNumStat(await runGitNumstatAsync(gitCwd, false)));
    const stagedStats = createDiffStatsMap(parseNumStat(await runGitNumstatAsync(gitCwd, true)));
    const stagedFiles: GitChangedFile[] = [];
    const unstagedFiles: GitChangedFile[] = [];
    const changedFiles = new Set<string>();

    for (const line of lines.slice(1)) {
      if (line.startsWith("?? ")) {
        const rawPath = line.slice(3).trim();
        if (!rawPath || rawPath.endsWith("/")) {
          continue;
        }
        if (!isPathWithinBase(scopeRoot, path.resolve(gitCwd, rawPath))) {
          continue;
        }
        changedFiles.add(rawPath);
        unstagedFiles.push({
          path: rawPath,
          status: "untracked",
          staged: false,
          added: 0,
          removed: 0,
        });
        continue;
      }

      const indexStatus = line[0] ?? " ";
      const worktreeStatus = line[1] ?? " ";
      const rawPath = line.slice(3).trim();
      if (!rawPath) {
        continue;
      }
      const renameMatch = /^(.*?) -> (.*)$/.exec(rawPath);
      const resolvedPath = renameMatch ? renameMatch[2]!.trim() : rawPath;
      const oldPath = renameMatch ? renameMatch[1]!.trim() : undefined;
      if (!isPathWithinBase(scopeRoot, path.resolve(gitCwd, resolvedPath))) {
        continue;
      }
      changedFiles.add(resolvedPath);

      if (indexStatus !== " " && indexStatus !== "?") {
        const stats = stagedStats[resolvedPath] ?? { added: 0, removed: 0, binary: false };
        stagedFiles.push({
          path: resolvedPath,
          ...(oldPath ? { oldPath } : {}),
          status: getGitFileStatus(indexStatus),
          staged: true,
          added: stats.added,
          removed: stats.removed,
          ...(stats.binary ? { binary: true } : {}),
        });
      }

      if (worktreeStatus !== " " && worktreeStatus !== "?") {
        const stats = unstagedStats[resolvedPath] ?? { added: 0, removed: 0, binary: false };
        unstagedFiles.push({
          path: resolvedPath,
          ...(oldPath ? { oldPath } : {}),
          status: getGitFileStatus(worktreeStatus),
          staged: false,
          added: stats.added,
          removed: stats.removed,
          ...(stats.binary ? { binary: true } : {}),
        });
      }
    }

    return {
      ...(branchMatch ? { branch: branchMatch[1] } : {}),
      changedFiles: [...changedFiles],
      stagedFiles,
      unstagedFiles,
      totalStaged: stagedFiles.length,
      totalUnstaged: unstagedFiles.length,
    };
  } catch {
    return {
      changedFiles: [],
      stagedFiles: [],
      unstagedFiles: [],
      totalStaged: 0,
      totalUnstaged: 0,
    };
  }
}

async function getGitCommandCwdAsync(cwd: string): Promise<string> {
  return (await tryResolveGitRootAsync(cwd)) ?? cwd;
}

async function toGitPathAsync(cwd: string, targetPath: string): Promise<string> {
  const gitRoot = await tryResolveGitRootAsync(cwd);
  const resolvedTarget = await resolveWorkspacePathAsync(cwd, targetPath);
  const relativeBase = normalizeComparablePath(gitRoot ?? cwd);
  const relativePath = path.relative(relativeBase, normalizeComparablePath(resolvedTarget));
  return relativePath || path.basename(resolvedTarget);
}

async function runGitNumstatAsync(cwd: string, staged: boolean): Promise<string> {
  try {
    return await runGitCommand(cwd, ["diff", ...(staged ? ["--cached"] : []), "--numstat"]);
  } catch {
    return "";
  }
}

function parseNumStat(numStatOutput: string): Array<{
  path: string;
  added: number;
  removed: number;
  binary: boolean;
  oldPath?: string;
}> {
  const lines = numStatOutput.split(/\r?\n/).filter(Boolean);
  return lines.flatMap((line) => {
    const match = /^(\d+|-)\t(\d+|-)\t(.*)$/.exec(line);
    if (!match) {
      return [];
    }
    const added = match[1] === "-" ? 0 : Number.parseInt(match[1]!, 10);
    const removed = match[2] === "-" ? 0 : Number.parseInt(match[2]!, 10);
    const binary = match[1] === "-" || match[2] === "-";
    const normalized = normalizeNumstatPath(match[3] ?? "");
    return [
      {
        path: normalized.newPath,
        ...(normalized.oldPath ? { oldPath: normalized.oldPath } : {}),
        added,
        removed,
        binary,
      },
    ];
  });
}

function createDiffStatsMap(
  entries: Array<{ path: string; added: number; removed: number; binary: boolean; oldPath?: string }>,
): Record<string, DiffStat> {
  const stats: Record<string, DiffStat> = {};
  for (const entry of entries) {
    const value: DiffStat = {
      added: entry.added,
      removed: entry.removed,
      binary: entry.binary,
    };
    stats[entry.path] = value;
    if (entry.oldPath && !stats[entry.oldPath]) {
      stats[entry.oldPath] = value;
    }
  }
  return stats;
}

function normalizeNumstatPath(rawPath: string): { newPath: string; oldPath?: string } {
  const trimmed = rawPath.trim();
  if (!trimmed) {
    return { newPath: trimmed };
  }
  if (trimmed.includes("{") && trimmed.includes("=>") && trimmed.includes("}")) {
    const newPath = trimmed.replace(
      /\{([^{}]+?)\s*=>\s*([^{}]+?)\}/g,
      (_, _oldPart: string, newPart: string) => newPart.trim(),
    );
    const oldPath = trimmed.replace(
      /\{([^{}]+?)\s*=>\s*([^{}]+?)\}/g,
      (_, oldPart: string) => oldPart.trim(),
    );
    return { newPath, oldPath };
  }
  if (trimmed.includes("=>")) {
    const parts = trimmed.split(/\s*=>\s*/);
    const oldPath = parts[0]?.trim();
    const newPath = parts.at(-1)?.trim();
    if (newPath) {
      return { newPath, ...(oldPath ? { oldPath } : {}) };
    }
  }
  return { newPath: trimmed };
}

function getGitFileStatus(statusChar: string): GitChangedFile["status"] {
  switch (statusChar) {
    case "A":
      return "added";
    case "D":
      return "deleted";
    case "R":
    case "C":
      return "renamed";
    case "U":
      return "conflicted";
    case "?":
      return "untracked";
    case "M":
    default:
      return "modified";
  }
}

function parseSingleFileDiff(diffText: string): ParsedFileDiff | null {
  const lines = diffText.split(/\r?\n/);
  const headerLines: string[] = [];
  const hunks: ParsedFileDiff["hunks"] = [];
  let currentHunk: ParsedFileDiff["hunks"][number] | null = null;

  for (const line of lines) {
    if (!line) {
      continue;
    }
    if (
      line.startsWith("diff --git ") ||
      line.startsWith("index ") ||
      line.startsWith("--- ") ||
      line.startsWith("+++ ")
    ) {
      if (!currentHunk) {
        headerLines.push(line);
      }
      continue;
    }
    if (line.startsWith("@@ ")) {
      currentHunk = {
        headerLine: line,
        bodyLines: [],
      };
      hunks.push(currentHunk);
      continue;
    }
    if (currentHunk) {
      currentHunk.bodyLines.push(line);
    }
  }

  if (headerLines.length === 0 || hunks.length === 0) {
    return null;
  }
  return { headerLines, hunks };
}

function buildSingleHunkPatch(parsed: ParsedFileDiff, hunkIndex: number): string {
  const hunk = parsed.hunks[hunkIndex];
  if (!hunk) {
    throw new Error(`Unknown hunk index ${hunkIndex}`);
  }
  return [...parsed.headerLines, hunk.headerLine, ...hunk.bodyLines, ""].join("\n");
}

async function runGitCommand(
  cwd: string,
  args: string[],
  options?: { input?: string },
): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const child = spawn("git", ["-C", cwd, ...args], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve(stdout);
        return;
      }
      reject(new Error(stderr.trim() || `git ${args[0] ?? "command"} exited with code ${code}`));
    });
    if (options?.input !== undefined) {
      child.stdin.end(options.input);
      return;
    }
    child.stdin.end();
  });
}

async function execGitApplyAsync(cwd: string, args: string[], patch: string): Promise<void> {
  await runGitCommand(cwd, ["apply", "--recount", "--whitespace=nowarn", ...args, "-"], {
    input: patch,
  });
}

async function execGitFileAsync(cwd: string, args: string[]): Promise<void> {
  await runGitCommand(cwd, args);
}

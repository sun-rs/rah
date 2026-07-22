import { spawn } from "node:child_process";
import path from "node:path";
import type {
  GitBranchChangedFile,
  GitChangedFile,
  GitComparisonMode,
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
  baseBranch?: string;
  comparisonMode?: GitComparisonMode;
  comparisonBase?: string;
  branchOptions: string[];
  branchFiles: GitBranchChangedFile[];
  changedFiles: string[];
  stagedFiles: GitChangedFile[];
  unstagedFiles: GitChangedFile[];
  totalBranch: number;
  totalStaged: number;
  totalUnstaged: number;
};

export type WorkspaceGitStatusOptions = {
  scopeRoot?: string;
  baseBranch?: string;
};

export type WorkspaceGitDiffOptions = WorkspaceGitStatusOptions & {
  staged?: boolean;
  ignoreWhitespace?: boolean;
};

export async function getWorkspaceGitStatusAsync(
  cwd: string,
  options?: WorkspaceGitStatusOptions,
): Promise<GitStatusResponse> {
  return {
    sessionId: "",
    ...(await getWorkspaceGitStatusDataAsync(cwd, options)),
  };
}

export async function getWorkspaceGitDiffAsync(
  cwd: string,
  targetPath: string,
  options?: WorkspaceGitDiffOptions,
): Promise<GitDiffResponse["diff"]> {
  try {
    const gitBase = options?.scopeRoot ?? cwd;
    const gitCwd = await tryResolveGitRootAsync(gitBase);
    if (!gitCwd) {
      return "";
    }
    const relativeGitPath = await toGitPathAsync(gitBase, targetPath);
    if (await isUntrackedGitPathAsync(gitCwd, relativeGitPath)) {
      return await runGitCommand(
        gitCwd,
        [
          "diff",
          "--no-index",
          ...(options?.ignoreWhitespace ? ["-w"] : []),
          "--",
          "/dev/null",
          relativeGitPath,
        ],
        { acceptedExitCodes: [1] },
      );
    }
    const args = ["-C", gitCwd, "diff"];
    if (options?.baseBranch) {
      const comparison = await readBranchComparisonAsync(gitCwd, options.baseBranch);
      if (!comparison.comparisonBase) {
        return "";
      }
      args.push(comparison.comparisonBase);
    } else if (options?.staged) {
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
  options?: WorkspaceGitStatusOptions,
): Promise<WorkspaceGitStatusData> {
  return await tryReadGitStatusAsync(cwd, options);
}

async function tryReadGitStatusAsync(
  cwd: string,
  options?: WorkspaceGitStatusOptions,
): Promise<WorkspaceGitStatusData> {
  try {
    const scopeRoot = path.resolve(options?.scopeRoot ?? cwd);
    const gitCwd = await tryResolveGitRootAsync(options?.scopeRoot ?? cwd);
    if (!gitCwd) {
      return {
        branchOptions: [],
        branchFiles: [],
        changedFiles: [],
        stagedFiles: [],
        unstagedFiles: [],
        totalBranch: 0,
        totalStaged: 0,
        totalUnstaged: 0,
      };
    }
    const [output, comparison] = await Promise.all([
      runGitCommand(gitCwd, ["status", "--porcelain"]),
      readBranchComparisonAsync(gitCwd, options?.baseBranch),
    ]);
    const lines = output.split(/\r?\n/).filter(Boolean);
    const [unstagedStatsOutput, stagedStatsOutput, branchFiles] = await Promise.all([
      runGitNumstatAsync(gitCwd, false),
      runGitNumstatAsync(gitCwd, true),
      comparison.comparisonBase
        ? readBranchChangedFilesAsync(gitCwd, scopeRoot, comparison.comparisonBase)
        : Promise.resolve([]),
    ]);
    const unstagedStats = createDiffStatsMap(parseNumStat(unstagedStatsOutput));
    const stagedStats = createDiffStatsMap(parseNumStat(stagedStatsOutput));
    const stagedFiles: GitChangedFile[] = [];
    const unstagedFiles: GitChangedFile[] = [];
    const changedFiles = new Set<string>();
    const branchFilePaths = new Set(branchFiles.map((file) => file.path));

    for (const line of lines) {
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
        if (!branchFilePaths.has(rawPath)) {
          branchFiles.push({
            path: rawPath,
            status: "untracked",
            added: 0,
            removed: 0,
          });
          branchFilePaths.add(rawPath);
        }
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
      ...(comparison.currentBranch ? { branch: comparison.currentBranch } : {}),
      ...(comparison.baseBranch ? { baseBranch: comparison.baseBranch } : {}),
      ...(comparison.comparisonMode ? { comparisonMode: comparison.comparisonMode } : {}),
      ...(comparison.comparisonBase ? { comparisonBase: comparison.comparisonBase } : {}),
      branchOptions: comparison.branchOptions,
      branchFiles,
      changedFiles: [...changedFiles],
      stagedFiles,
      unstagedFiles,
      totalBranch: branchFiles.length,
      totalStaged: stagedFiles.length,
      totalUnstaged: unstagedFiles.length,
    };
  } catch {
    return {
      branchOptions: [],
      branchFiles: [],
      changedFiles: [],
      stagedFiles: [],
      unstagedFiles: [],
      totalBranch: 0,
      totalStaged: 0,
      totalUnstaged: 0,
    };
  }
}

type BranchComparison = {
  currentBranch?: string;
  baseBranch?: string;
  comparisonMode?: GitComparisonMode;
  comparisonBase?: string;
  branchOptions: string[];
};

async function readBranchComparisonAsync(
  gitCwd: string,
  requestedBaseBranch?: string,
): Promise<BranchComparison> {
  const [currentBranch, refsOutput, originHead, upstream] = await Promise.all([
    tryRunGitCommand(gitCwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]),
    tryRunGitCommand(gitCwd, [
      "for-each-ref",
      "--format=%(refname:short)%09%(symref)",
      "refs/heads",
      "refs/remotes",
    ]),
    tryRunGitCommand(gitCwd, [
      "symbolic-ref",
      "--quiet",
      "--short",
      "refs/remotes/origin/HEAD",
    ]),
    tryRunGitCommand(gitCwd, [
      "rev-parse",
      "--abbrev-ref",
      "--symbolic-full-name",
      "@{upstream}",
    ]),
  ]);
  const normalizedCurrentBranch = currentBranch.trim() || undefined;
  const availableRefs = refsOutput
    .split(/\r?\n/)
    .map((line) => {
      const [name, symbolicTarget] = line.split("\t");
      return symbolicTarget?.trim() ? "" : (name?.trim() ?? "");
    })
    .filter(
      (value) =>
        Boolean(value) && !value.endsWith("/HEAD"),
    );
  const branchOptions = [
    ...new Set([...(normalizedCurrentBranch ? [] : ["HEAD"]), ...availableRefs]),
  ].sort((left, right) => left.localeCompare(right));
  const available = new Set(branchOptions);
  const candidates = [
    requestedBaseBranch,
    normalizedCurrentBranch ?? "HEAD",
    originHead.trim(),
    "origin/main",
    "main",
    "origin/master",
    "master",
    upstream.trim(),
    ...branchOptions,
  ];
  const baseBranch = candidates.find(
    (candidate): candidate is string =>
      candidate !== undefined &&
      candidate.length > 0 &&
      available.has(candidate),
  );

  let comparisonMode: GitComparisonMode | undefined;
  let comparisonBase: string | undefined;
  if (baseBranch) {
    const currentRef = normalizedCurrentBranch ?? "HEAD";
    if (baseBranch === currentRef) {
      comparisonMode = "uncommitted";
      comparisonBase =
        (await tryRunGitCommand(gitCwd, ["rev-parse", "HEAD"])).trim() || "HEAD";
    } else {
      const mergeBase = (
        await tryRunGitCommand(gitCwd, ["merge-base", "HEAD", baseBranch])
      ).trim();
      if (mergeBase) {
        comparisonMode = "merge_base";
        comparisonBase = mergeBase;
      } else {
        // Unrelated histories have no common ancestor. A direct snapshot
        // comparison is still useful, but is exposed explicitly so clients do
        // not describe it as a PR-style divergence comparison.
        comparisonMode = "direct";
        comparisonBase = baseBranch;
      }
    }
  }

  return {
    ...(normalizedCurrentBranch ? { currentBranch: normalizedCurrentBranch } : {}),
    ...(baseBranch ? { baseBranch } : {}),
    ...(comparisonMode ? { comparisonMode } : {}),
    ...(comparisonBase ? { comparisonBase } : {}),
    branchOptions,
  };
}

async function readBranchChangedFilesAsync(
  gitCwd: string,
  scopeRoot: string,
  comparisonBase: string,
): Promise<GitBranchChangedFile[]> {
  const [nameStatusOutput, numStatOutput] = await Promise.all([
    runGitCommand(gitCwd, ["diff", "--name-status", "--find-renames", comparisonBase]),
    runGitCommand(gitCwd, ["diff", "--numstat", "--find-renames", comparisonBase]),
  ]);
  const stats = createDiffStatsMap(parseNumStat(numStatOutput));
  const files: GitBranchChangedFile[] = [];

  for (const line of nameStatusOutput.split(/\r?\n/).filter(Boolean)) {
    const parts = line.split("\t");
    const statusToken = parts[0] ?? "M";
    const statusChar = statusToken[0] ?? "M";
    const isRename = statusChar === "R" || statusChar === "C";
    const oldPath = isRename ? parts[1]?.trim() : undefined;
    const filePath = (isRename ? parts[2] : parts[1])?.trim();
    if (!filePath || !isPathWithinBase(scopeRoot, path.resolve(gitCwd, filePath))) {
      continue;
    }
    const fileStats = stats[filePath] ?? { added: 0, removed: 0, binary: false };
    files.push({
      path: filePath,
      ...(oldPath ? { oldPath } : {}),
      status: getGitFileStatus(statusChar),
      added: fileStats.added,
      removed: fileStats.removed,
      ...(fileStats.binary ? { binary: true } : {}),
    });
  }

  return files;
}

async function tryRunGitCommand(cwd: string, args: string[]): Promise<string> {
  try {
    return await runGitCommand(cwd, args);
  } catch {
    return "";
  }
}

async function isUntrackedGitPathAsync(cwd: string, targetPath: string): Promise<boolean> {
  const output = await tryRunGitCommand(cwd, [
    "ls-files",
    "--others",
    "--exclude-standard",
    "--",
    targetPath,
  ]);
  return output
    .split(/\r?\n/)
    .some((candidate) => candidate.trim() === targetPath);
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
  options?: { input?: string; acceptedExitCodes?: readonly number[] },
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
      if (code === 0 || (code !== null && options?.acceptedExitCodes?.includes(code))) {
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

import type {
  GitBranchChangedFile,
  GitChangedFile,
  GitComparisonMode,
  RahEvent,
} from "@rah/runtime-protocol";

export type InspectorTab = "files" | "changes" | "outputs" | "sources";
export type FileDetailMode = "file" | "diff";
export type DiffLayout = "unified" | "split";

export type DiffPreferences = {
  wrapLines: boolean;
  hideWhitespace: boolean;
  diffLayout: DiffLayout;
};

export type FileDetailSelection = {
  path: string;
  source: "files" | "changes" | "local" | "turn_changes";
  sessionId?: string;
  turnId?: string;
  staged?: boolean;
  baseBranch?: string;
  comparisonMode?: GitComparisonMode;
  baselineIsCurrent?: boolean;
  pureAddition?: boolean;
  binary?: boolean;
  oldPath?: string;
  status?: GitChangedFile["status"];
};

export type InspectorOpenFileRequest = {
  id: number;
  path: string;
  kind?: "local" | "turn_changes";
  sessionId?: string;
  turnId?: string;
};

export type DirectoryEntry = {
  name: string;
  type: "file" | "directory";
};

export type InspectorGitStatus = {
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

export type DiffContentRow = {
  key: string;
  kind: "add" | "remove" | "context";
  sign: "+" | "-" | "";
  lineNumber: number | null;
  oldLineNumber: number | null;
  newLineNumber: number | null;
  text: string;
};

export type DiffRow =
  | DiffContentRow
  | {
      key: string;
      kind: "hunk";
      sign: "@@";
      lineNumber: null;
      oldLineNumber: null;
      newLineNumber: null;
      text: string;
    };

export type SplitDiffCell = {
  key: string;
  kind: "add" | "remove" | "context";
  lineNumber: number;
  text: string;
};

export type SplitDiffRow =
  | {
      key: string;
      kind: "hunk";
      text: string;
    }
  | {
      key: string;
      kind: "pair";
      before: SplitDiffCell | null;
      after: SplitDiffCell | null;
    };

export type DiffSummary = {
  added: number;
  removed: number;
  isPureAddition: boolean;
};

export const DIFF_PREFERENCES_KEY = "rah.inspector-diff-preferences";
export const DIFF_PREFERENCES_VERSION = 2;
const DEFAULT_DIFF_PREFERENCES: DiffPreferences = {
  wrapLines: true,
  hideWhitespace: false,
  diffLayout: "unified",
};
export const INSPECTOR_TOOLBAR_ICON_BUTTON_CLASS =
  "icon-click-feedback inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-[var(--app-hint)] transition-colors hover:bg-[var(--app-bg)] hover:text-[var(--app-fg)]";

export function readDiffPreferences(): DiffPreferences {
  if (typeof window === "undefined") {
    return { ...DEFAULT_DIFF_PREFERENCES };
  }
  try {
    const raw = window.localStorage.getItem(DIFF_PREFERENCES_KEY);
    if (!raw) {
      return { ...DEFAULT_DIFF_PREFERENCES };
    }
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      wrapLines: parsed.wrapLines !== false,
      hideWhitespace: parsed.hideWhitespace === true,
      // Version 1 persisted the former split-by-default value even when the
      // user never selected it. Migrate that ambiguous value once, then keep
      // explicit version 2 choices stable.
      diffLayout:
        parsed.version === DIFF_PREFERENCES_VERSION && parsed.diffLayout === "split"
          ? "split"
          : "unified",
    };
  } catch {
    return { ...DEFAULT_DIFF_PREFERENCES };
  }
}

export function writeDiffPreferences(preferences: DiffPreferences): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(
    DIFF_PREFERENCES_KEY,
    JSON.stringify({ version: DIFF_PREFERENCES_VERSION, ...preferences }),
  );
}

export function getChangedFileStatusLabel(status: GitChangedFile["status"]): string {
  switch (status) {
    case "added":
      return "A";
    case "deleted":
      return "D";
    case "renamed":
      return "R";
    case "untracked":
      return "U";
    case "conflicted":
      return "C";
    case "modified":
    default:
      return "M";
  }
}

export function getChangedFileStatusTone(status: GitChangedFile["status"]): string {
  switch (status) {
    case "added":
      return "text-[var(--diff-add-text)]";
    case "deleted":
      return "text-[var(--diff-remove-text)]";
    case "renamed":
      return "text-sky-600 dark:text-sky-400";
    case "untracked":
      return "text-emerald-600 dark:text-emerald-400";
    case "conflicted":
      return "text-[var(--app-warning)]";
    case "modified":
    default:
      return "text-[var(--app-hint)]";
  }
}

export function getChangeScopeLabel(staged: boolean | undefined): string | null {
  if (staged === true) return "Staged";
  if (staged === false) return "Unstaged";
  return null;
}

export function joinPath(parentPath: string, name: string): string {
  if (!parentPath) {
    return name;
  }
  return parentPath.endsWith("/") ? `${parentPath}${name}` : `${parentPath}/${name}`;
}

export function getDisplayPath(filePath: string, workspaceRoot: string): string {
  if (!workspaceRoot) {
    return filePath;
  }
  if (filePath === workspaceRoot) {
    return ".";
  }
  if (filePath.startsWith(`${workspaceRoot}/`)) {
    return filePath.slice(workspaceRoot.length + 1);
  }
  return filePath;
}

export function getTurnArtifactErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.startsWith("Unknown turn artifact ")) {
    return "Exact changes are unavailable for this older turn. RAH does not reconstruct them from the workspace's current Git state.";
  }
  if (message.startsWith("Unknown turn file ")) {
    return "This file is not part of the frozen changes for this turn.";
  }
  if (message === "Turn artifact manifest is invalid.") {
    return "The frozen changes for this turn are damaged and cannot be inspected.";
  }
  return message;
}

export function isFileChangeObservation(event: RahEvent): boolean {
  if (!event.type.startsWith("observation.")) return false;
  const obs = (event.payload as { observation?: { kind?: string } }).observation;
  if (!obs) return false;
  return ["file.write", "file.edit", "patch.apply", "git.apply"].includes(obs.kind ?? "");
}

export function resolveCodeLanguage(path: string): string | null {
  const lower = path.toLowerCase();
  if (lower.endsWith(".ts")) return "typescript";
  if (lower.endsWith(".tsx")) return "tsx";
  if (lower.endsWith(".js") || lower.endsWith(".mjs") || lower.endsWith(".cjs")) return "javascript";
  if (lower.endsWith(".json") || lower.endsWith(".ipynb")) return "json";
  if (lower.endsWith(".rs")) return "rust";
  if (lower.endsWith(".toml")) return "toml";
  if (lower.endsWith(".md")) return "markdown";
  if (lower.endsWith(".py")) return "python";
  if (lower.endsWith(".sh")) return "bash";
  if (lower.endsWith(".yml") || lower.endsWith(".yaml")) return "yaml";
  if (lower.endsWith(".html")) return "html";
  if (lower.endsWith(".css")) return "css";
  if (lower.endsWith(".sql")) return "sql";
  return null;
}

export function buildDiffRows(diffContent: string): DiffRow[] {
  const lines = diffContent.split("\n");
  let oldLineNumber = 0;
  let newLineNumber = 0;
  const rows: DiffRow[] = [];

  for (const [index, line] of lines.entries()) {
    if (
      line.startsWith("diff --git ") ||
      line.startsWith("index ") ||
      line.startsWith("---") ||
      line.startsWith("+++")
    ) {
      continue;
    }

    const hunkMatch = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunkMatch) {
      oldLineNumber = Number.parseInt(hunkMatch[1]!, 10);
      newLineNumber = Number.parseInt(hunkMatch[2]!, 10);
      rows.push({
        key: `${index}-${line}`,
        kind: "hunk",
        sign: "@@",
        lineNumber: null,
        oldLineNumber: null,
        newLineNumber: null,
        text: line,
      });
      continue;
    }

    if (line.startsWith("+")) {
      rows.push({
        key: `${index}-${line}`,
        kind: "add",
        sign: "+",
        lineNumber: newLineNumber,
        oldLineNumber: null,
        newLineNumber,
        text: line.slice(1),
      });
      newLineNumber += 1;
      continue;
    }

    if (line.startsWith("-")) {
      rows.push({
        key: `${index}-${line}`,
        kind: "remove",
        sign: "-",
        lineNumber: oldLineNumber,
        oldLineNumber,
        newLineNumber: null,
        text: line.slice(1),
      });
      oldLineNumber += 1;
      continue;
    }

    rows.push({
      key: `${index}-${line}`,
      kind: "context",
      sign: "",
      lineNumber: newLineNumber,
      oldLineNumber,
      newLineNumber,
      text: line.startsWith(" ") ? line.slice(1) : line,
    });
    if (line !== "") {
      oldLineNumber += 1;
      newLineNumber += 1;
    }
  }

  return rows;
}

function toSplitDiffCell(
  row: DiffContentRow,
  side: "before" | "after",
): SplitDiffCell | null {
  const lineNumber = side === "before" ? row.oldLineNumber : row.newLineNumber;
  if (lineNumber === null) return null;
  return {
    key: `${row.key}:${side}`,
    kind: row.kind,
    lineNumber,
    text: row.text,
  };
}

/**
 * Aligns a unified diff into two visual columns without changing Git's diff
 * semantics. Consecutive removals and additions form one replacement block;
 * unmatched lines receive an explicit empty cell on the opposite side.
 */
export function buildSplitDiffRows(rows: readonly DiffRow[]): SplitDiffRow[] {
  const splitRows: SplitDiffRow[] = [];
  let removals: DiffContentRow[] = [];
  let additions: DiffContentRow[] = [];

  const flushChangeBlock = () => {
    const pairCount = Math.max(removals.length, additions.length);
    for (let index = 0; index < pairCount; index += 1) {
      const beforeRow = removals[index];
      const afterRow = additions[index];
      splitRows.push({
        key: `pair:${beforeRow?.key ?? "empty"}:${afterRow?.key ?? "empty"}`,
        kind: "pair",
        before: beforeRow ? toSplitDiffCell(beforeRow, "before") : null,
        after: afterRow ? toSplitDiffCell(afterRow, "after") : null,
      });
    }
    removals = [];
    additions = [];
  };

  for (const row of rows) {
    if (row.kind === "remove") {
      removals.push(row);
      continue;
    }
    if (row.kind === "add") {
      additions.push(row);
      continue;
    }

    flushChangeBlock();
    if (row.kind === "hunk") {
      splitRows.push({ key: `split:${row.key}`, kind: "hunk", text: row.text });
      continue;
    }

    splitRows.push({
      key: `split:${row.key}`,
      kind: "pair",
      before: toSplitDiffCell(row, "before"),
      after: toSplitDiffCell(row, "after"),
    });
  }

  flushChangeBlock();
  return splitRows;
}

export function summarizeDiffRows(rows: readonly DiffRow[]): DiffSummary {
  const added = rows.filter((row) => row.kind === "add").length;
  const removed = rows.filter((row) => row.kind === "remove").length;
  const hasContext = rows.some((row) => row.kind === "context");
  return {
    added,
    removed,
    isPureAddition: added > 0 && removed === 0 && !hasContext,
  };
}

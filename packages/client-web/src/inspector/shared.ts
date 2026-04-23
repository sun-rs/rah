import type { GitChangedFile, RahEvent } from "@rah/runtime-protocol";

export type InspectorTab = "files" | "changes" | "events";
export type FileDetailMode = "file" | "diff";

export type FileDetailSelection = {
  path: string;
  source: "files" | "changes";
  staged?: boolean;
  pureAddition?: boolean;
  binary?: boolean;
  oldPath?: string;
  status?: GitChangedFile["status"];
};

export type DirectoryEntry = {
  name: string;
  type: "file" | "directory";
};

export type InspectorGitStatus = {
  branch?: string;
  changedFiles: string[];
  stagedFiles: GitChangedFile[];
  unstagedFiles: GitChangedFile[];
  totalStaged: number;
  totalUnstaged: number;
};

export type DiffRow =
  | {
      key: string;
      kind: "add" | "remove" | "context";
      sign: "+" | "-" | "";
      lineNumber: number | null;
      text: string;
    }
  | {
      key: string;
      kind: "hunk";
      sign: "@@";
      lineNumber: null;
      text: string;
    };

export type DiffSummary = {
  added: number;
  removed: number;
  isPureAddition: boolean;
};

export const DIFF_PREFERENCES_KEY = "rah.inspector-diff-preferences";

export function readDiffPreferences(): {
  wrapLines: boolean;
  hideWhitespace: boolean;
} {
  if (typeof window === "undefined") {
    return { wrapLines: true, hideWhitespace: false };
  }
  try {
    const raw = window.localStorage.getItem(DIFF_PREFERENCES_KEY);
    if (!raw) {
      return { wrapLines: true, hideWhitespace: false };
    }
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      wrapLines: parsed.wrapLines !== false,
      hideWhitespace: parsed.hideWhitespace === true,
    };
  } catch {
    return { wrapLines: true, hideWhitespace: false };
  }
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

export function formatEventTimestamp(event: RahEvent): string {
  try {
    const date = new Date(event.ts);
    return date.toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return event.ts;
  }
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
  if (lower.endsWith(".json")) return "json";
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
      text: line.startsWith(" ") ? line.slice(1) : line,
    });
    if (line !== "") {
      oldLineNumber += 1;
      newLineNumber += 1;
    }
  }

  return rows;
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

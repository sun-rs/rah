import { useEffect, useMemo, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import type { GitChangedFile, RahEvent } from "@rah/runtime-protocol";
import {
  ChevronDown,
  ChevronRight,
  FileText,
  Folder,
  GitBranch,
  LoaderCircle,
  PanelRight,
  RefreshCcw,
  SquareTerminal,
  X,
} from "lucide-react";
import {
  applyGitFileAction,
  listDirectory,
  readGitDiff,
  readGitStatus,
  readSessionFile,
  readWorkspaceFile,
  readWorkspaceGitDiff,
  readWorkspaceGitStatus,
  searchSessionFiles,
  searchWorkspaceFilesByDirectory,
} from "./api";
import { useTheme } from "./hooks/useTheme";
import {
  DIFF_HIGHLIGHT_LIMITS,
  DIFF_PROGRESSIVE_RENDER,
  FILE_HIGHLIGHT_LIMITS,
  FILE_PROGRESSIVE_RENDER,
  getInitialVisibleCount,
  getNextVisibleCount,
  shouldHighlightPreview,
  shouldUseProgressiveRender,
} from "./inspector-performance";
import { ensureHighlighterLanguage, getHighlighter, highlightLines } from "./lib/shiki";

type InspectorTab = "files" | "changes" | "events";
type FileDetailMode = "file" | "diff";

type FileDetailSelection = {
  path: string;
  source: "files" | "changes";
  staged?: boolean;
  pureAddition?: boolean;
  binary?: boolean;
  oldPath?: string;
  status?: GitChangedFile["status"];
};

type DirectoryEntry = {
  name: string;
  type: "file" | "directory";
};

type DiffRow =
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

type DiffSummary = {
  added: number;
  removed: number;
  isPureAddition: boolean;
};

const DIFF_PREFERENCES_KEY = "rah.inspector-diff-preferences";

function readDiffPreferences(): {
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

function getChangedFileStatusLabel(status: GitChangedFile["status"]): string {
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

function getChangedFileStatusTone(status: GitChangedFile["status"]): string {
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

function getChangeScopeLabel(staged: boolean | undefined): string | null {
  if (staged === true) return "Staged";
  if (staged === false) return "Unstaged";
  return null;
}

function formatEventTimestamp(event: RahEvent): string {
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

function joinPath(parentPath: string, name: string): string {
  if (!parentPath) {
    return name;
  }
  return parentPath.endsWith("/") ? `${parentPath}${name}` : `${parentPath}/${name}`;
}

function getDisplayPath(filePath: string, workspaceRoot: string): string {
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

function isFileChangeObservation(event: RahEvent): boolean {
  if (!event.type.startsWith("observation.")) return false;
  const obs = (event.payload as { observation?: { kind?: string } }).observation;
  if (!obs) return false;
  return ["file.write", "file.edit", "patch.apply", "git.apply"].includes(obs.kind ?? "");
}

function resolveCodeLanguage(path: string): string | null {
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

function buildDiffRows(diffContent: string): DiffRow[] {
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

function summarizeDiffRows(rows: readonly DiffRow[]): DiffSummary {
  const added = rows.filter((row) => row.kind === "add").length;
  const removed = rows.filter((row) => row.kind === "remove").length;
  const hasContext = rows.some((row) => row.kind === "context");
  return {
    added,
    removed,
    isPureAddition: added > 0 && removed === 0 && !hasContext,
  };
}

function useHighlightedLineHtml(code: string | null, language: string | null) {
  const { colorScheme } = useTheme();
  const [htmlByLine, setHtmlByLine] = useState<string[]>([]);

  useEffect(() => {
    if (!language || code === null) {
      setHtmlByLine([]);
      return;
    }
    let cancelled = false;
    void getHighlighter()
      .then(async (highlighter) => {
        if (cancelled) return;
        const loaded = await ensureHighlighterLanguage(language);
        if (cancelled) return;
        if (!loaded) {
          setHtmlByLine([]);
          return;
        }
        const theme = colorScheme === "dark" ? "dark-plus" : "light-plus";
        const next = highlightLines(code, language, theme);
        setHtmlByLine(next);
      })
      .catch(() => {
        if (!cancelled) {
          setHtmlByLine([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [code, colorScheme, language]);

  return htmlByLine;
}

function ChangesFromEvents(props: { events: RahEvent[] }) {
  const items = useMemo(() => props.events.filter(isFileChangeObservation), [props.events]);

  if (items.length === 0) {
    return null;
  }

  return (
    <div className="space-y-3">
      {items.map((change, index) => {
        const obs = (change.payload as {
          observation?: { title?: string; description?: string; path?: string; kind?: string };
        }).observation;
        return (
          <div
            key={`${change.seq}-${index}`}
            className="rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] p-3"
          >
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0 truncate text-sm font-medium text-[var(--app-fg)]">
                {obs?.path ?? obs?.title ?? "Change"}
              </div>
              <div className="shrink-0 rounded border border-[var(--app-border)] bg-[var(--app-subtle-bg)] px-1.5 py-0.5 text-[11px] text-[var(--app-hint)]">
                {obs?.kind ?? "file-change"}
              </div>
            </div>
            {obs?.description ? (
              <div className="mt-1 text-xs text-[var(--app-hint)]">{obs.description}</div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function DiffDisplay(props: {
  rows: readonly DiffRow[];
  path: string;
  wrapLines: boolean;
}) {
  const language = useMemo(() => resolveCodeLanguage(props.path), [props.path]);
  const [visibleRowCount, setVisibleRowCount] = useState(() =>
    getInitialVisibleCount(props.rows.length, DIFF_PROGRESSIVE_RENDER),
  );

  useEffect(() => {
    setVisibleRowCount(getInitialVisibleCount(props.rows.length, DIFF_PROGRESSIVE_RENDER));
  }, [props.rows]);

  const visibleRows = useMemo(() => props.rows.slice(0, visibleRowCount), [props.rows, visibleRowCount]);
  const highlightableLines = useMemo(
    () => visibleRows.filter((row) => row.kind !== "hunk").map((row) => row.text),
    [visibleRows],
  );
  const highlightableContent = useMemo(() => highlightableLines.join("\n"), [highlightableLines]);
  const shouldHighlight = shouldHighlightPreview(
    language,
    highlightableLines.length,
    highlightableContent.length,
    DIFF_HIGHLIGHT_LIMITS,
  );
  const highlightedHtml = useHighlightedLineHtml(
    shouldHighlight ? highlightableContent : null,
    shouldHighlight ? language : null,
  );
  const progressive = shouldUseProgressiveRender(props.rows.length, DIFF_PROGRESSIVE_RENDER);
  const remainingRows = Math.max(0, props.rows.length - visibleRows.length);

  let highlightedIndex = 0;

  return (
    <div className="space-y-2">
      <div className="overflow-hidden rounded-md border border-[var(--app-border)] bg-[var(--app-bg)]">
        <div>
          {visibleRows.map((row) => {
            const toneClassName =
              row.kind === "add"
                ? "bg-[var(--diff-add-bg)] text-[var(--diff-add-text)]"
                : row.kind === "remove"
                  ? "bg-[var(--diff-remove-bg)] text-[var(--diff-remove-text)]"
                  : row.kind === "hunk"
                    ? "bg-[var(--diff-header-bg)] text-[var(--app-hint)] font-semibold"
                    : "bg-[var(--app-bg)] text-[var(--diff-context-text)]";
            const highlightedRowHtml =
              row.kind === "hunk" ? null : highlightedHtml[highlightedIndex++] ?? null;

            return (
              <div key={row.key} className={`grid grid-cols-[4rem_2rem_minmax(0,1fr)] ${toneClassName}`}>
                <div className="select-none border-r border-[var(--app-border)] px-3 py-0.5 text-xs font-mono opacity-70 text-right">
                  {row.lineNumber ?? ""}
                </div>
                <div className="select-none border-r border-[var(--app-border)] px-2 py-0.5 text-xs font-mono text-center">
                  {row.sign || " "}
                </div>
                <div className="px-3 py-0.5 text-xs font-mono">
                  {highlightedRowHtml ? (
                    <span
                      className={`[&_.line]:block ${
                        props.wrapLines
                          ? "[&_.line]:whitespace-pre-wrap [&_.line]:break-words"
                          : "[&_.line]:whitespace-pre"
                      }`}
                      dangerouslySetInnerHTML={{ __html: highlightedRowHtml }}
                    />
                  ) : (
                    <span className={props.wrapLines ? "whitespace-pre-wrap break-words" : "whitespace-pre"}>
                      {row.text || " "}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
      {progressive && remainingRows > 0 ? (
        <div className="flex items-center justify-between gap-3 rounded-md border border-[var(--app-border)] bg-[var(--app-subtle-bg)] px-3 py-2 text-xs text-[var(--app-hint)]">
          <span>
            Showing {visibleRows.length.toLocaleString()} of {props.rows.length.toLocaleString()} diff lines.
          </span>
          <button
            type="button"
            onClick={() =>
              setVisibleRowCount((current) => getNextVisibleCount(current, props.rows.length, DIFF_PROGRESSIVE_RENDER))
            }
            className="rounded-md bg-[var(--app-bg)] px-2.5 py-1 text-[var(--app-fg)] transition-colors hover:bg-[var(--app-border)]"
          >
            Load {Math.min(DIFF_PROGRESSIVE_RENDER.step, remainingRows).toLocaleString()} more
          </button>
        </div>
      ) : null}
    </div>
  );
}

function FileContentDisplay(props: { content: string; path: string; wrapLines: boolean }) {
  const lines = useMemo(() => props.content.split("\n"), [props.content]);
  const language = useMemo(() => resolveCodeLanguage(props.path), [props.path]);
  const [visibleLineCount, setVisibleLineCount] = useState(() =>
    getInitialVisibleCount(lines.length, FILE_PROGRESSIVE_RENDER),
  );

  useEffect(() => {
    setVisibleLineCount(getInitialVisibleCount(lines.length, FILE_PROGRESSIVE_RENDER));
  }, [lines.length, props.content]);

  const visibleLines = useMemo(() => lines.slice(0, visibleLineCount), [lines, visibleLineCount]);
  const visibleContent = useMemo(() => visibleLines.join("\n"), [visibleLines]);
  const shouldHighlight = shouldHighlightPreview(
    language,
    visibleLines.length,
    visibleContent.length,
    FILE_HIGHLIGHT_LIMITS,
  );
  const highlightedHtml = useHighlightedLineHtml(
    shouldHighlight ? visibleContent : null,
    shouldHighlight ? language : null,
  );
  const progressive = shouldUseProgressiveRender(lines.length, FILE_PROGRESSIVE_RENDER);
  const remainingLines = Math.max(0, lines.length - visibleLines.length);

  return (
    <div className="space-y-2">
      <div className="overflow-auto custom-scrollbar scrollbar-stable rounded-md border border-[var(--app-border)] bg-[var(--app-code-bg)]">
        <div className="grid grid-cols-[4rem_minmax(0,1fr)]">
          {visibleLines.map((line, index) => (
            <div key={`${index}-${line}`} className="contents">
              <div className="select-none border-r border-[var(--app-border)] px-3 py-0.5 text-xs font-mono text-[var(--app-hint)] text-right">
                {index + 1}
              </div>
              <div className="px-4 py-0.5 text-xs font-mono text-[var(--code-block-text)]">
                {highlightedHtml[index] ? (
                  <span
                    className={`[&_.line]:block ${
                      props.wrapLines
                        ? "[&_.line]:whitespace-pre-wrap [&_.line]:break-words"
                        : "[&_.line]:whitespace-pre"
                    }`}
                    dangerouslySetInnerHTML={{ __html: highlightedHtml[index]! }}
                  />
                ) : (
                  <span className={props.wrapLines ? "whitespace-pre-wrap break-words" : "whitespace-pre"}>
                    {line || " "}
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
      {progressive && remainingLines > 0 ? (
        <div className="flex items-center justify-between gap-3 rounded-md border border-[var(--app-border)] bg-[var(--app-subtle-bg)] px-3 py-2 text-[11px] text-[var(--app-hint)]">
          <span>
            Showing {visibleLines.length.toLocaleString()} of {lines.length.toLocaleString()} file lines.
          </span>
          <button
            type="button"
            onClick={() =>
              setVisibleLineCount((current) => getNextVisibleCount(current, lines.length, FILE_PROGRESSIVE_RENDER))
            }
            className="rounded-md bg-[var(--app-bg)] px-2.5 py-1 text-[var(--app-fg)] transition-colors hover:bg-[var(--app-border)]"
          >
            Load {Math.min(FILE_PROGRESSIVE_RENDER.step, remainingLines).toLocaleString()} more
          </button>
        </div>
      ) : null}
    </div>
  );
}

function EventsList(props: { events: RahEvent[] }) {
  return (
    <div className="space-y-2">
      {props.events.length > 0 ? (
        props.events.map((event) => {
          const payload = event.payload as Record<string, unknown>;
          let detail: string | null = null;
          if (event.type === "timeline.item.added" || event.type === "timeline.item.updated") {
            const item = (payload.item ?? {}) as { kind?: string; text?: string };
            detail = item.text ?? item.kind ?? null;
          } else if (event.type.startsWith("observation.")) {
            const obs = (payload.observation ?? {}) as { kind?: string; title?: string };
            detail = obs.title ?? obs.kind ?? null;
          } else if (event.type.startsWith("tool.call.")) {
            const tool = (payload.toolCall ?? {}) as { providerToolName?: string };
            detail = tool.providerToolName ?? null;
          } else if (event.type.startsWith("permission.")) {
            const req = (payload.request ?? {}) as { kind?: string; title?: string };
            detail = req.title ?? req.kind ?? null;
          } else if (event.type === "session.state.changed") {
            detail = (payload.state as string | undefined) ?? null;
          } else if (event.type === "turn.input.appended") {
            detail = (payload.text as string | undefined) ?? null;
          } else if (event.type === "turn.failed" || event.type === "session.failed") {
            detail = (payload.error as string | undefined) ?? null;
          }
          return (
            <div
              key={event.seq}
              className="rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] p-3"
            >
              <div className="flex items-center justify-between gap-2">
                <div className="text-xs font-semibold text-[var(--app-fg)]">{event.type}</div>
                <div className="text-xs text-[var(--app-hint)]">
                  {formatEventTimestamp(event)}
                </div>
              </div>
              {detail ? (
                <div className="mt-1 line-clamp-3 text-xs text-[var(--app-hint)]">{detail}</div>
              ) : null}
            </div>
          );
        })
      ) : (
        <div className="text-sm text-[var(--app-hint)]">No events.</div>
      )}
    </div>
  );
}

function DirectoryTreeNode(props: {
  path: string;
  depth: number;
  entry: DirectoryEntry;
  expandedPaths: ReadonlySet<string>;
  directoryEntriesByPath: ReadonlyMap<string, DirectoryEntry[]>;
  directoryErrorsByPath: ReadonlyMap<string, string>;
  directoryLoadingPaths: ReadonlySet<string>;
  onToggleDirectory: (path: string) => void;
  onOpenFile: (path: string) => void;
}) {
  const fullPath = joinPath(props.path, props.entry.name);
  const isDirectory = props.entry.type === "directory";
  const expanded = props.expandedPaths.has(fullPath);
  const loading = props.directoryLoadingPaths.has(fullPath);
  const childEntries = props.directoryEntriesByPath.get(fullPath) ?? [];
  const error = props.directoryErrorsByPath.get(fullPath) ?? null;

  return (
    <div>
      <button
        type="button"
        onClick={() => (isDirectory ? props.onToggleDirectory(fullPath) : props.onOpenFile(fullPath))}
        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-[var(--app-bg)]"
        style={{ paddingLeft: `${props.depth * 14 + 8}px` }}
      >
        {isDirectory ? (
          expanded ? (
            <ChevronDown size={14} className="shrink-0 text-[var(--app-hint)]" />
          ) : (
            <ChevronRight size={14} className="shrink-0 text-[var(--app-hint)]" />
          )
        ) : (
          <span className="inline-block h-[14px] w-[14px] shrink-0" />
        )}
        {isDirectory ? (
          <Folder size={14} className="shrink-0 text-[var(--app-hint)]" />
        ) : (
          <FileText size={14} className="shrink-0 text-[var(--app-hint)]" />
        )}
        <span
          className={`min-w-0 truncate text-sm ${
            isDirectory ? "font-medium text-[var(--app-fg)]" : "text-[var(--app-hint)]"
          }`}
        >
          {props.entry.name}
        </span>
      </button>

      {isDirectory && expanded ? (
        loading ? (
          <div
            className="px-2 py-2 text-xs text-[var(--app-hint)]"
            style={{ paddingLeft: `${props.depth * 14 + 36}px` }}
          >
            Loading…
          </div>
        ) : error ? (
          <div
            className="px-2 py-2 text-xs text-[var(--app-hint)]"
            style={{ paddingLeft: `${props.depth * 14 + 36}px` }}
          >
            {error}
          </div>
        ) : childEntries.length > 0 ? (
          <div className="space-y-0.5">
            {childEntries.map((entry) => (
              <DirectoryTreeNode
                key={`${fullPath}/${entry.name}`}
                path={fullPath}
                depth={props.depth + 1}
                entry={entry}
                expandedPaths={props.expandedPaths}
                directoryEntriesByPath={props.directoryEntriesByPath}
                directoryErrorsByPath={props.directoryErrorsByPath}
                directoryLoadingPaths={props.directoryLoadingPaths}
                onToggleDirectory={props.onToggleDirectory}
                onOpenFile={props.onOpenFile}
              />
            ))}
          </div>
        ) : (
          <div
            className="px-2 py-2 text-xs text-[var(--app-hint)]"
            style={{ paddingLeft: `${props.depth * 14 + 36}px` }}
          >
            Empty directory.
          </div>
        )
      ) : null}
    </div>
  );
}

function FileDetailPane(props: {
  sessionId: string | null;
  workspaceRoot: string;
  selection: FileDetailSelection;
  onRefreshChanges: () => void;
  onClose: () => void;
}) {
  const [diffContent, setDiffContent] = useState("");
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState("");
  const [fileLoading, setFileLoading] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const [binary, setBinary] = useState(false);
  const [truncated, setTruncated] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);
  const [fileActionPending, setFileActionPending] = useState<"stage" | "unstage" | null>(null);
  const [displayMode, setDisplayMode] = useState<FileDetailMode>(
    props.selection.source === "changes" ? "diff" : "file",
  );
  const [wrapLines, setWrapLines] = useState(() => readDiffPreferences().wrapLines);
  const [hideWhitespace, setHideWhitespace] = useState(() => readDiffPreferences().hideWhitespace);

  useEffect(() => {
    setDisplayMode(props.selection.source === "changes" ? "diff" : "file");
  }, [props.selection.path, props.selection.source]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    window.localStorage.setItem(
      DIFF_PREFERENCES_KEY,
      JSON.stringify({ wrapLines, hideWhitespace }),
    );
  }, [hideWhitespace, wrapLines]);

  useEffect(() => {
    let cancelled = false;
    setDiffLoading(true);
    setDiffError(null);
    const diffPromise = props.sessionId
      ? readGitDiff(props.sessionId, props.selection.path, {
          ...(props.selection.staged !== undefined ? { staged: props.selection.staged } : {}),
          ignoreWhitespace: hideWhitespace,
          ...(props.workspaceRoot ? { scopeRoot: props.workspaceRoot } : {}),
        })
      : readWorkspaceGitDiff(props.workspaceRoot, props.selection.path, {
          ...(props.selection.staged !== undefined ? { staged: props.selection.staged } : {}),
          ignoreWhitespace: hideWhitespace,
        });
    diffPromise
      .then((response) => {
        if (cancelled) return;
        setDiffContent(response.diff);
      })
      .catch((error) => {
        if (cancelled) return;
        setDiffError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (!cancelled) {
          setDiffLoading(false);
        }
      });

    setFileLoading(true);
    setFileError(null);
    setBinary(false);
    setTruncated(false);
    const filePromise = props.sessionId
      ? readSessionFile(props.sessionId, props.selection.path, {
          ...(props.workspaceRoot ? { scopeRoot: props.workspaceRoot } : {}),
        })
      : readWorkspaceFile(props.workspaceRoot, props.selection.path);
    filePromise
      .then((response) => {
        if (cancelled) return;
        setFileContent(response.content);
        setBinary(response.binary);
        setTruncated(Boolean(response.truncated));
      })
      .catch((error) => {
        if (cancelled) return;
        setFileError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (!cancelled) {
          setFileLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [
    hideWhitespace,
    props.selection.path,
    props.selection.staged,
    props.sessionId,
    props.workspaceRoot,
    reloadToken,
  ]);

  const diffRows = useMemo(() => buildDiffRows(diffContent), [diffContent]);
  const diffSummary = useMemo(() => summarizeDiffRows(diffRows), [diffRows]);
  const hasDiff = diffRows.length > 0;
  const shouldShowFileTab =
    props.selection.source === "files" || !diffSummary.isPureAddition;
  const displayPath = getDisplayPath(props.selection.path, props.workspaceRoot);
  const fileName = props.selection.path.split("/").pop() || props.selection.path;
  const selectionScopeLabel = getChangeScopeLabel(props.selection.staged);
  const isBinaryChange = props.selection.source === "changes" && props.selection.binary === true;
  const showDiffUnavailable =
    isBinaryChange && !hasDiff && !diffLoading && !diffError;
  const canApplyGitFileAction = Boolean(props.sessionId);

  const handleApplyFileAction = async (action: "stage" | "unstage") => {
    if (!props.sessionId) {
      return;
    }
    setFileActionPending(action);
    try {
      await applyGitFileAction(props.sessionId, {
        path: props.selection.path,
        action,
        ...(props.selection.staged !== undefined ? { staged: props.selection.staged } : {}),
      });
      props.onRefreshChanges();
      setReloadToken((value) => value + 1);
    } finally {
      setFileActionPending((current) => (current === action ? null : current));
    }
  };

  return (
    <Dialog.Root open onOpenChange={(open) => (!open ? props.onClose() : undefined)}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/45" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 flex h-[82vh] w-[min(1100px,92vw)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-2xl border border-[var(--app-border)] bg-[var(--app-bg)] shadow-2xl focus:outline-none max-md:inset-0 max-md:h-[100dvh] max-md:w-screen max-md:max-w-none max-md:translate-x-0 max-md:translate-y-0 max-md:rounded-none max-md:border-0 max-md:pt-[env(safe-area-inset-top)] max-md:pb-[env(safe-area-inset-bottom)]">
          <div className="flex items-start justify-between gap-4 border-b border-[var(--app-border)] px-4 py-3 md:px-5 md:py-4">
            <div className="min-w-0">
              <Dialog.Title className="truncate text-base font-semibold text-[var(--app-fg)]">
                {fileName}
              </Dialog.Title>
              <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-[var(--app-hint)]">
                <Dialog.Description className="min-w-0 truncate">{displayPath}</Dialog.Description>
                {selectionScopeLabel ? (
                  <span className="rounded border border-[var(--app-border)] bg-[var(--app-subtle-bg)] px-1.5 py-0.5 text-[11px] text-[var(--app-fg)]">
                    {selectionScopeLabel}
                  </span>
                ) : null}
                {props.selection.status ? (
                  <span
                    className={`rounded border border-[var(--app-border)] bg-[var(--app-subtle-bg)] px-1.5 py-0.5 text-[11px] ${getChangedFileStatusTone(props.selection.status)}`}
                  >
                    {getChangedFileStatusLabel(props.selection.status)}
                  </span>
                ) : null}
                {isBinaryChange ? (
                  <span className="rounded border border-[var(--app-border)] bg-[var(--app-subtle-bg)] px-1.5 py-0.5 text-[11px] text-[var(--app-fg)]">
                    Binary
                  </span>
                ) : null}
              </div>
              {props.selection.oldPath ? (
                <div className="mt-1 truncate text-xs text-[var(--app-hint)]">
                  {props.selection.oldPath} -&gt; {props.selection.path}
                </div>
              ) : null}
            </div>
            <Dialog.Close asChild>
              <button
                type="button"
                className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-[var(--app-hint)] transition-colors hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)]"
                aria-label="Close"
                title="Close"
              >
                <X size={16} />
              </button>
            </Dialog.Close>
          </div>

          {hasDiff && shouldShowFileTab ? (
            <div className="border-b border-[var(--app-border)] px-3 py-2 md:px-5 md:py-3">
              <div className="flex flex-col gap-2 md:flex-row md:items-center md:gap-3">
                <div className="flex w-full items-center gap-1 rounded-lg bg-[var(--app-subtle-bg)] p-1 md:flex-1">
                  <button
                    type="button"
                    onClick={() => setDisplayMode("diff")}
                    className={`flex-1 rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                      displayMode === "diff"
                        ? "bg-[var(--app-bg)] text-[var(--app-fg)] shadow-sm"
                        : "text-[var(--app-hint)] hover:text-[var(--app-fg)]"
                    }`}
                  >
                    Diff
                  </button>
                  <button
                    type="button"
                    onClick={() => setDisplayMode("file")}
                    className={`flex-1 rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                      displayMode === "file"
                        ? "bg-[var(--app-bg)] text-[var(--app-fg)] shadow-sm"
                        : "text-[var(--app-hint)] hover:text-[var(--app-fg)]"
                    }`}
                  >
                    File
                  </button>
                </div>
                <div className="flex flex-wrap items-center gap-1 md:shrink-0 md:justify-end">
                  {props.selection.source === "changes" && canApplyGitFileAction ? (
                    <button
                      type="button"
                      onClick={() => void handleApplyFileAction(props.selection.staged ? "unstage" : "stage")}
                      disabled={fileActionPending !== null}
                    className={`rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors disabled:opacity-50 ${
                        props.selection.staged
                          ? "bg-[var(--app-subtle-bg)] text-[var(--app-fg)]"
                          : "bg-[var(--app-fg)] text-[var(--app-bg)]"
                      }`}
                    >
                      {fileActionPending === "stage"
                        ? "Adding..."
                        : fileActionPending === "unstage"
                          ? "Reverting..."
                          : props.selection.staged
                            ? "Revert add"
                            : "Git add"}
                    </button>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => setWrapLines((value) => !value)}
                    className={`rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors ${
                      wrapLines
                        ? "bg-[var(--app-subtle-bg)] text-[var(--app-fg)]"
                        : "text-[var(--app-hint)] hover:bg-[var(--app-subtle-bg)]"
                    }`}
                  >
                    Wrap
                  </button>
                  <button
                    type="button"
                    onClick={() => setHideWhitespace((value) => !value)}
                    className={`rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors ${
                      hideWhitespace
                        ? "bg-[var(--app-subtle-bg)] text-[var(--app-fg)]"
                        : "text-[var(--app-hint)] hover:bg-[var(--app-subtle-bg)]"
                    }`}
                  >
                    Hide WS
                  </button>
                </div>
              </div>
            </div>
          ) : hasDiff ? (
            <div className="border-b border-[var(--app-border)] px-3 py-2 md:px-5 md:py-3">
              <div className="flex flex-wrap items-center justify-end gap-1">
                <button
                  type="button"
                  onClick={() => setWrapLines((value) => !value)}
                  className={`rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors ${
                    wrapLines
                      ? "bg-[var(--app-subtle-bg)] text-[var(--app-fg)]"
                      : "text-[var(--app-hint)] hover:bg-[var(--app-subtle-bg)]"
                  }`}
                >
                  Wrap
                </button>
                <button
                  type="button"
                  onClick={() => setHideWhitespace((value) => !value)}
                  className={`rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors ${
                    hideWhitespace
                      ? "bg-[var(--app-subtle-bg)] text-[var(--app-fg)]"
                      : "text-[var(--app-hint)] hover:bg-[var(--app-subtle-bg)]"
                  }`}
                >
                  Hide WS
                </button>
              </div>
            </div>
          ) : null}

          <div className="min-h-0 flex-1 overflow-auto custom-scrollbar scrollbar-stable p-3 md:p-5">
            {displayMode === "diff" ? (
              diffLoading ? (
                <div className="flex items-center gap-2 text-sm text-[var(--app-hint)]">
                  <LoaderCircle size={14} className="animate-spin" />
                  Loading diff…
                </div>
              ) : diffError ? (
                <div className="rounded-lg border border-[var(--app-border)] bg-[var(--app-warning-bg)] p-3 text-xs text-[var(--app-hint)]">
                  Diff unavailable: {diffError}
                </div>
              ) : hasDiff ? (
                <DiffDisplay
                  rows={diffRows}
                  path={props.selection.path}
                  wrapLines={wrapLines}
                />
              ) : showDiffUnavailable ? (
                <div className="rounded-lg border border-[var(--app-border)] bg-[var(--app-subtle-bg)] p-3 text-sm text-[var(--app-hint)]">
                  This binary change does not have a text diff preview.
                </div>
              ) : (
                <div className="text-sm text-[var(--app-hint)]">No diff for this file.</div>
              )
            ) : fileLoading ? (
              <div className="flex items-center gap-2 text-sm text-[var(--app-hint)]">
                <LoaderCircle size={14} className="animate-spin" />
                Loading file…
              </div>
            ) : fileError ? (
              <div className="rounded-lg border border-[var(--app-border)] bg-[var(--app-warning-bg)] p-3 text-xs text-[var(--app-hint)]">
                Failed to read file: {fileError}
              </div>
            ) : binary ? (
              <div className="text-sm text-[var(--app-hint)]">
                This file looks binary and cannot be previewed.
              </div>
            ) : (
              <div className="space-y-2">
                {truncated ? (
                  <div className="rounded-lg border border-[var(--app-border)] bg-[var(--app-subtle-bg)] p-2 text-[11px] text-[var(--app-hint)]">
                    Showing the first part of a large file.
                  </div>
                ) : null}
                <FileContentDisplay
                  path={props.selection.path}
                  content={fileContent || "File is empty."}
                  wrapLines={wrapLines}
                />
              </div>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function InspectorPane(props: {
  sessionId: string | null;
  workspaceRoot: string;
  events: RahEvent[];
  onCollapse?: () => void;
  onOpenTerminal?: () => void;
}) {
  const [activeTab, setActiveTab] = useState<InspectorTab>("changes");
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
  const [directoryEntriesByPath, setDirectoryEntriesByPath] = useState<Map<string, DirectoryEntry[]>>(
    new Map(),
  );
  const [directoryErrorsByPath, setDirectoryErrorsByPath] = useState<Map<string, string>>(new Map());
  const [directoryLoadingPaths, setDirectoryLoadingPaths] = useState<Set<string>>(new Set());
  const [gitStatus, setGitStatus] = useState<{
    branch?: string;
    changedFiles: string[];
    stagedFiles: GitChangedFile[];
    unstagedFiles: GitChangedFile[];
    totalStaged: number;
    totalUnstaged: number;
  } | null>(null);
  const [gitStatusLoading, setGitStatusLoading] = useState(false);
  const [gitStatusError, setGitStatusError] = useState<string | null>(null);
  const [fileSearchQuery, setFileSearchQuery] = useState("");
  const [fileSearchResults, setFileSearchResults] = useState<Array<{ path: string; name: string; parentPath: string }>>([]);
  const [fileSearchLoading, setFileSearchLoading] = useState(false);
  const [fileSearchError, setFileSearchError] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<FileDetailSelection | null>(null);

  useEffect(() => {
    if (!props.sessionId && activeTab === "events") {
      setActiveTab("changes");
    }
  }, [activeTab, props.sessionId]);

  const loadDirectory = async (directoryPath: string) => {
    setDirectoryLoadingPaths((current) => new Set(current).add(directoryPath));
    try {
      const response = await listDirectory(directoryPath);
      const sortedEntries = [...response.entries].sort((left, right) => {
        if (left.type === right.type) {
          return left.name.localeCompare(right.name);
        }
        return left.type === "directory" ? -1 : 1;
      });
      setDirectoryEntriesByPath((current) => {
        const next = new Map(current);
        next.set(directoryPath, sortedEntries);
        return next;
      });
      setDirectoryErrorsByPath((current) => {
        const next = new Map(current);
        next.delete(directoryPath);
        return next;
      });
    } catch (error) {
      setDirectoryErrorsByPath((current) => {
        const next = new Map(current);
        next.set(directoryPath, error instanceof Error ? error.message : String(error));
        return next;
      });
    } finally {
      setDirectoryLoadingPaths((current) => {
        const next = new Set(current);
        next.delete(directoryPath);
        return next;
      });
    }
  };

  const loadGitStatus = async () => {
    if (!props.workspaceRoot) {
      setGitStatus(null);
      setGitStatusError(null);
      setGitStatusLoading(false);
      return;
    }
    setGitStatusLoading(true);
    setGitStatusError(null);
    try {
      const response = props.sessionId
        ? await readGitStatus(props.sessionId, {
            ...(props.workspaceRoot ? { scopeRoot: props.workspaceRoot } : {}),
          })
        : await readWorkspaceGitStatus(props.workspaceRoot);
      setGitStatus({
        ...(response.branch ? { branch: response.branch } : {}),
        changedFiles: response.changedFiles,
        stagedFiles: response.stagedFiles ?? [],
        unstagedFiles: response.unstagedFiles ?? [],
        totalStaged: response.totalStaged ?? response.stagedFiles?.length ?? 0,
        totalUnstaged: response.totalUnstaged ?? response.unstagedFiles?.length ?? 0,
      });
    } catch (error) {
      setGitStatusError(error instanceof Error ? error.message : String(error));
      setGitStatus(null);
    } finally {
      setGitStatusLoading(false);
    }
  };

  useEffect(() => {
    setSelectedFile(null);
    setExpandedPaths(props.workspaceRoot ? new Set([props.workspaceRoot]) : new Set());
    setDirectoryEntriesByPath(new Map());
    setDirectoryErrorsByPath(new Map());
    if (props.workspaceRoot) {
      void loadDirectory(props.workspaceRoot);
    }
  }, [props.sessionId, props.workspaceRoot]);

  useEffect(() => {
    void loadGitStatus();
  }, [props.sessionId, props.workspaceRoot]);

  useEffect(() => {
    if (!fileSearchQuery.trim()) {
      setFileSearchResults([]);
      setFileSearchError(null);
      setFileSearchLoading(false);
      return;
    }
    if (!props.workspaceRoot) {
      setFileSearchResults([]);
      setFileSearchError(null);
      setFileSearchLoading(false);
      return;
    }
    let cancelled = false;
    const timeoutId = window.setTimeout(() => {
      setFileSearchLoading(true);
      setFileSearchError(null);
      const searchPromise = props.sessionId
        ? searchSessionFiles(
            props.sessionId,
            fileSearchQuery.trim(),
            100,
            props.workspaceRoot || undefined,
          )
        : searchWorkspaceFilesByDirectory(props.workspaceRoot, fileSearchQuery.trim(), 100);
      void searchPromise
        .then((response) => {
          if (cancelled) return;
          setFileSearchResults(response.files);
        })
        .catch((error) => {
          if (cancelled) return;
          setFileSearchError(error instanceof Error ? error.message : String(error));
          setFileSearchResults([]);
        })
        .finally(() => {
          if (!cancelled) {
            setFileSearchLoading(false);
          }
        });
    }, 150);
    return () => {
      cancelled = true;
      window.clearTimeout(timeoutId);
    };
  }, [fileSearchQuery, props.sessionId, props.workspaceRoot]);

  const toggleDirectory = (directoryPath: string) => {
    setExpandedPaths((current) => {
      const next = new Set(current);
      if (next.has(directoryPath)) {
        next.delete(directoryPath);
      } else {
        next.add(directoryPath);
        if (!directoryEntriesByPath.has(directoryPath) && !directoryLoadingPaths.has(directoryPath)) {
          void loadDirectory(directoryPath);
        }
      }
      return next;
    });
  };

  const openFile = (
    path: string,
    source: "files" | "changes",
    options?: {
      staged?: boolean;
      pureAddition?: boolean;
      binary?: boolean;
      oldPath?: string;
      status?: GitChangedFile["status"];
    },
  ) => {
    setSelectedFile({
      path,
      source,
      ...(options?.staged !== undefined ? { staged: options.staged } : {}),
      ...(options?.pureAddition !== undefined ? { pureAddition: options.pureAddition } : {}),
      ...(options?.binary !== undefined ? { binary: options.binary } : {}),
      ...(options?.oldPath !== undefined ? { oldPath: options.oldPath } : {}),
      ...(options?.status !== undefined ? { status: options.status } : {}),
    });
  };

  const topLevelEntries = props.workspaceRoot
    ? directoryEntriesByPath.get(props.workspaceRoot) ?? []
    : [];
  const changeCount =
    (gitStatus?.totalStaged ?? 0) + (gitStatus?.totalUnstaged ?? 0) ||
    gitStatus?.changedFiles.length ||
    0;
  const rootLabel = props.workspaceRoot.split("/").filter(Boolean).at(-1) ?? props.workspaceRoot;

  return (
    <div className="h-full flex flex-col">
      <div className="h-14 px-4 flex items-center justify-between shrink-0">
        <div className="min-w-0">
          <div className="text-sm font-medium text-[var(--app-fg)]">Inspector</div>
                  <div className="text-xs text-[var(--app-hint)] truncate">{props.workspaceRoot}</div>
        </div>
        <div className="flex items-center gap-1">
          {props.onOpenTerminal ? (
            <button
              type="button"
              className="inline-flex h-7 w-7 items-center justify-center rounded-md text-[var(--app-hint)] hover:bg-[var(--app-bg)] hover:text-[var(--app-fg)] transition-colors"
              onClick={props.onOpenTerminal}
              aria-label="Open terminal"
              title="Open terminal"
            >
              <SquareTerminal size={16} />
            </button>
          ) : null}
          {props.onCollapse ? (
            <button
              type="button"
              className="inline-flex h-7 w-7 items-center justify-center rounded-md text-[var(--app-hint)] hover:bg-[var(--app-bg)] hover:text-[var(--app-fg)] transition-colors"
              onClick={props.onCollapse}
              aria-label="Collapse inspector"
              title="Collapse inspector"
            >
              <PanelRight size={16} />
            </button>
          ) : null}
        </div>
      </div>
      <div className="shrink-0 px-3 py-2">
        <div className="overflow-x-auto custom-scrollbar scrollbar-stable">
        <div className="inline-flex min-w-full items-center gap-0.5 rounded-lg bg-[var(--app-bg)] p-0.5">
          <button
            type="button"
            className={`min-w-[5.5rem] flex-1 overflow-hidden rounded-md px-2 py-1 text-xs font-medium text-ellipsis whitespace-nowrap transition-colors ${
              activeTab === "changes"
                ? "bg-[var(--app-subtle-bg)] text-[var(--app-fg)]"
                : "text-[var(--app-hint)] hover:text-[var(--app-fg)] hover:bg-[var(--app-subtle-bg)]/50"
            }`}
            onClick={() => setActiveTab("changes")}
          >
            Changes {changeCount > 0 ? `(${changeCount})` : ""}
          </button>
          <button
            type="button"
            className={`min-w-[5.5rem] flex-1 overflow-hidden rounded-md px-2 py-1 text-xs font-medium text-ellipsis whitespace-nowrap transition-colors ${
              activeTab === "files"
                ? "bg-[var(--app-subtle-bg)] text-[var(--app-fg)]"
                : "text-[var(--app-hint)] hover:text-[var(--app-fg)] hover:bg-[var(--app-subtle-bg)]/50"
            }`}
            onClick={() => setActiveTab("files")}
          >
            Files
          </button>
          {props.sessionId ? (
            <button
              type="button"
              className={`min-w-[5.5rem] flex-1 overflow-hidden rounded-md px-2 py-1 text-xs font-medium text-ellipsis whitespace-nowrap transition-colors ${
                activeTab === "events"
                  ? "bg-[var(--app-subtle-bg)] text-[var(--app-fg)]"
                  : "text-[var(--app-hint)] hover:text-[var(--app-fg)] hover:bg-[var(--app-subtle-bg)]/50"
              }`}
              onClick={() => setActiveTab("events")}
            >
              Events {props.events.length > 0 ? `(${props.events.length})` : ""}
            </button>
          ) : null}
        </div>
        </div>
      </div>
      <div className="flex-1 overflow-y-scroll custom-scrollbar scrollbar-stable p-3">
        {activeTab === "changes" ? (
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <div className="flex items-center gap-2 text-sm font-medium text-[var(--app-fg)]">
                  <GitBranch size={14} className="text-[var(--app-hint)]" />
                  <span>{gitStatus?.branch ?? "detached"}</span>
                </div>
                <div className="text-xs text-[var(--app-hint)]">
                  {(gitStatus?.totalStaged ?? 0)} staged, {(gitStatus?.totalUnstaged ?? 0)} unstaged
                </div>
              </div>
              <button
                type="button"
                onClick={() => void loadGitStatus()}
                className="inline-flex h-7 w-7 items-center justify-center rounded-md text-[var(--app-hint)] hover:bg-[var(--app-bg)] hover:text-[var(--app-fg)] transition-colors"
                title="Refresh changes"
              >
                <RefreshCcw size={14} />
              </button>
            </div>
            {gitStatusLoading ? (
              <div className="flex items-center gap-2 text-sm text-[var(--app-hint)]">
                <LoaderCircle size={14} className="animate-spin" />
                Loading changes…
              </div>
            ) : gitStatusError ? (
              <div className="rounded-lg border border-[var(--app-border)] bg-[var(--app-warning-bg)] p-3 text-xs text-[var(--app-hint)]">
                {gitStatusError}
              </div>
            ) : changeCount === 0 ? (
              <div className="pt-8 text-center text-sm text-[var(--app-hint)]">No changes.</div>
            ) : (
              <div className="space-y-3">
                {gitStatus?.stagedFiles.length ? (
                  <div className="rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)]">
                    <div className="border-b border-[var(--app-border)] px-3 py-2 text-xs font-semibold text-[var(--diff-add-text)]">
                      Staged Changes ({gitStatus.stagedFiles.length})
                    </div>
                    <div className="space-y-1 p-2">
                      {gitStatus.stagedFiles.map((file) => (
                        <button
                          key={`staged-${file.path}`}
                          type="button"
                          onClick={() =>
                            openFile(file.path, "changes", {
                              staged: true,
                              pureAddition: file.status === "added" && file.removed === 0,
                              status: file.status,
                              ...(file.binary !== undefined ? { binary: file.binary } : {}),
                              ...(file.oldPath !== undefined ? { oldPath: file.oldPath } : {}),
                            })
                          }
                          className="flex w-full items-center gap-2 rounded-md border border-transparent bg-[var(--app-bg)] px-2.5 py-2 text-left transition-colors hover:border-[var(--app-border)] hover:bg-[var(--app-subtle-bg)]"
                        >
                          <FileText size={14} className="shrink-0 text-[var(--app-hint)]" />
                          <span className={`shrink-0 text-[10px] font-semibold ${getChangedFileStatusTone(file.status)}`}>
                            {getChangedFileStatusLabel(file.status)}
                          </span>
                          <span className="min-w-0 flex-1 truncate text-sm text-[var(--app-fg)]">
                            {file.path}
                          </span>
                          {file.oldPath ? (
                            <span className="hidden max-w-[14rem] truncate text-[11px] text-[var(--app-hint)] md:inline">
                              {file.oldPath} -&gt; {file.path}
                            </span>
                          ) : null}
                          {file.binary ? (
                            <span className="shrink-0 rounded border border-[var(--app-border)] px-1.5 py-0.5 text-[10px] text-[var(--app-hint)]">
                              BIN
                            </span>
                          ) : null}
                          <span className="flex shrink-0 items-center gap-1 text-[11px] font-mono">
                            {file.added ? (
                              <span className="text-[var(--diff-add-text)]">+{file.added}</span>
                            ) : null}
                            {file.removed ? (
                              <span className="text-[var(--diff-remove-text)]">-{file.removed}</span>
                            ) : null}
                          </span>
                        </button>
                      ))}
                    </div>
                  </div>
                ) : null}

                {gitStatus?.unstagedFiles.length ? (
                  <div className="rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)]">
                    <div className="border-b border-[var(--app-border)] px-3 py-2 text-xs font-semibold text-[var(--app-warning)]">
                      Unstaged Changes ({gitStatus.unstagedFiles.length})
                    </div>
                    <div className="space-y-1 p-2">
                      {gitStatus.unstagedFiles.map((file) => (
                        <button
                          key={`unstaged-${file.path}`}
                          type="button"
                          onClick={() =>
                            openFile(file.path, "changes", {
                              staged: false,
                              pureAddition: file.status === "added" && file.removed === 0,
                              status: file.status,
                              ...(file.binary !== undefined ? { binary: file.binary } : {}),
                              ...(file.oldPath !== undefined ? { oldPath: file.oldPath } : {}),
                            })
                          }
                          className="flex w-full items-center gap-2 rounded-md border border-transparent bg-[var(--app-bg)] px-2.5 py-2 text-left transition-colors hover:border-[var(--app-border)] hover:bg-[var(--app-subtle-bg)]"
                        >
                          <FileText size={14} className="shrink-0 text-[var(--app-hint)]" />
                          <span className={`shrink-0 text-[10px] font-semibold ${getChangedFileStatusTone(file.status)}`}>
                            {getChangedFileStatusLabel(file.status)}
                          </span>
                          <span className="min-w-0 flex-1 truncate text-sm text-[var(--app-fg)]">
                            {file.path}
                          </span>
                          {file.oldPath ? (
                            <span className="hidden max-w-[14rem] truncate text-[11px] text-[var(--app-hint)] md:inline">
                              {file.oldPath} -&gt; {file.path}
                            </span>
                          ) : null}
                          {file.binary ? (
                            <span className="shrink-0 rounded border border-[var(--app-border)] px-1.5 py-0.5 text-[10px] text-[var(--app-hint)]">
                              BIN
                            </span>
                          ) : null}
                          <span className="flex shrink-0 items-center gap-1 text-[11px] font-mono">
                            {file.added ? (
                              <span className="text-[var(--diff-add-text)]">+{file.added}</span>
                            ) : null}
                            {file.removed ? (
                              <span className="text-[var(--diff-remove-text)]">-{file.removed}</span>
                            ) : null}
                          </span>
                        </button>
                      ))}
                    </div>
                  </div>
                ) : null}
              </div>
            )}
            <ChangesFromEvents events={props.events} />
          </div>
        ) : activeTab === "files" ? (
          !props.workspaceRoot ? (
            <div className="text-sm text-[var(--app-hint)]">No workspace available.</div>
          ) : (
            <div className="space-y-3">
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium text-[var(--app-fg)]">{rootLabel}</div>
                  <div className="truncate text-[11px] text-[var(--app-hint)]">{props.workspaceRoot}</div>
                </div>
                <button
                  type="button"
                  onClick={() => void loadDirectory(props.workspaceRoot)}
                  className="inline-flex h-7 w-7 items-center justify-center rounded-md text-[var(--app-hint)] hover:bg-[var(--app-bg)] hover:text-[var(--app-fg)] transition-colors"
                  title="Refresh files"
                >
                  <RefreshCcw size={14} />
                </button>
              </div>
              <div className="rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] px-3 py-2">
                <input
                  value={fileSearchQuery}
                  onChange={(event) => setFileSearchQuery(event.target.value)}
                  placeholder="Search files"
                  className="w-full bg-transparent text-sm text-[var(--app-fg)] placeholder:text-[var(--app-hint)] focus:outline-none"
                  autoCapitalize="none"
                  autoCorrect="off"
                />
              </div>
              {fileSearchQuery.trim() ? (
                fileSearchLoading ? (
                  <div className="flex items-center gap-2 text-sm text-[var(--app-hint)]">
                    <LoaderCircle size={14} className="animate-spin" />
                    Searching files…
                  </div>
                ) : fileSearchError ? (
                  <div className="rounded-lg border border-[var(--app-border)] bg-[var(--app-warning-bg)] p-3 text-xs text-[var(--app-hint)]">
                    {fileSearchError}
                  </div>
                ) : fileSearchResults.length === 0 ? (
                  <div className="text-sm text-[var(--app-hint)]">No files match your search.</div>
                ) : (
                  <div className="space-y-1">
                    {fileSearchResults.map((file) => (
                      <button
                        key={file.path}
                        type="button"
                        onClick={() => openFile(file.path, "files")}
                        className="flex w-full items-center gap-2 rounded-md border border-transparent bg-[var(--app-bg)] px-2.5 py-2 text-left transition-colors hover:border-[var(--app-border)] hover:bg-[var(--app-subtle-bg)]"
                      >
                        <FileText size={14} className="shrink-0 text-[var(--app-hint)]" />
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm text-[var(--app-fg)]">{file.name}</div>
                          <div className="truncate text-[11px] text-[var(--app-hint)]">
                            {file.parentPath || "."}
                          </div>
                        </div>
                      </button>
                    ))}
                  </div>
                )
              ) : directoryLoadingPaths.has(props.workspaceRoot) && topLevelEntries.length === 0 ? (
                <div className="flex items-center gap-2 text-sm text-[var(--app-hint)]">
                  <LoaderCircle size={14} className="animate-spin" />
                  Loading files…
                </div>
              ) : directoryErrorsByPath.get(props.workspaceRoot) ? (
                <div className="rounded-lg border border-[var(--app-border)] bg-[var(--app-warning-bg)] p-3 text-xs text-[var(--app-hint)]">
                  {directoryErrorsByPath.get(props.workspaceRoot)}
                </div>
              ) : topLevelEntries.length === 0 ? (
                <div className="text-sm text-[var(--app-hint)]">No files in workspace.</div>
              ) : (
                <div className="space-y-0.5">
                  {topLevelEntries.map((entry) => (
                    <DirectoryTreeNode
                      key={`${props.workspaceRoot}/${entry.name}`}
                      path={props.workspaceRoot}
                      depth={0}
                      entry={entry}
                      expandedPaths={expandedPaths}
                      directoryEntriesByPath={directoryEntriesByPath}
                      directoryErrorsByPath={directoryErrorsByPath}
                      directoryLoadingPaths={directoryLoadingPaths}
                      onToggleDirectory={toggleDirectory}
                      onOpenFile={(path) => openFile(path, "files")}
                    />
                  ))}
                </div>
              )}
            </div>
          )
        ) : props.sessionId ? (
          <EventsList events={props.events} />
        ) : (
          <div className="text-sm text-[var(--app-hint)]">No events without a selected session.</div>
        )}
      </div>

      {selectedFile ? (
        <FileDetailPane
          sessionId={props.sessionId}
          workspaceRoot={props.workspaceRoot}
          selection={selectedFile}
          onRefreshChanges={() => void loadGitStatus()}
          onClose={() => setSelectedFile(null)}
        />
      ) : null}
    </div>
  );
}

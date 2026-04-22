import { useEffect, useMemo, useState } from "react";
import type { RahEvent } from "@rah/runtime-protocol";
import {
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  FileText,
  Folder,
  GitBranch,
  LoaderCircle,
  PanelRight,
  RefreshCcw,
} from "lucide-react";
import {
  listDirectory,
  readGitDiff,
  readGitStatus,
  readSessionFile,
} from "./api";

type InspectorTab = "files" | "changes" | "events";
type FileDetailMode = "file" | "diff";

type FileDetailSelection = {
  path: string;
  source: "files" | "changes";
};

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

function ChangesFromEvents(props: { events: RahEvent[] }) {
  const items = useMemo(() => props.events.filter(isFileChangeObservation), [props.events]);
  return (
    <div className="space-y-3">
      {items.length > 0 ? (
        items.map((change, index) => {
          const obs = (change.payload as {
            observation?: { title?: string; description?: string; path?: string; kind?: string };
          }).observation;
          return (
            <div
              key={`${change.seq}-${index}`}
              className="rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] p-3"
            >
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0 text-sm font-medium truncate text-[var(--app-fg)]">
                  {obs?.path ?? obs?.title ?? "Change"}
                </div>
                <div className="shrink-0 text-[10px] px-1.5 py-0.5 rounded bg-[var(--app-subtle-bg)] border border-[var(--app-border)] text-[var(--app-hint)]">
                  {obs?.kind ?? "file-change"}
                </div>
              </div>
              {obs?.description ? (
                <div className="mt-1 text-xs text-[var(--app-hint)]">{obs.description}</div>
              ) : null}
            </div>
          );
        })
      ) : (
        <div className="text-sm text-[var(--app-hint)]">No file changes yet.</div>
      )}
    </div>
  );
}

function DiffDisplay(props: { diffContent: string }) {
  const lines = props.diffContent.split("\n");

  return (
    <div className="overflow-hidden rounded-md border border-[var(--app-border)] bg-[var(--app-bg)]">
      {lines.map((line, index) => {
        const isAdd = line.startsWith("+") && !line.startsWith("+++");
        const isRemove = line.startsWith("-") && !line.startsWith("---");
        const isHunk = line.startsWith("@@");
        const isHeader = line.startsWith("+++") || line.startsWith("---");

        const className = [
          "whitespace-pre-wrap px-3 py-0.5 text-xs font-mono",
          isAdd ? "bg-[var(--app-diff-added-bg)] text-[var(--app-diff-added-text)]" : "",
          isRemove ? "bg-[var(--app-diff-removed-bg)] text-[var(--app-diff-removed-text)]" : "",
          isHunk ? "bg-[var(--app-subtle-bg)] text-[var(--app-hint)] font-semibold" : "",
          isHeader ? "text-[var(--app-hint)] font-semibold" : "",
        ]
          .filter(Boolean)
          .join(" ");

        const style = isAdd
          ? { borderLeft: "2px solid var(--app-git-staged-color)" }
          : isRemove
            ? { borderLeft: "2px solid var(--app-git-deleted-color)" }
            : undefined;

        return (
          <div key={`${index}-${line}`} className={className} style={style}>
            {line || " "}
          </div>
        );
      })}
    </div>
  );
}

function EventsList(props: { events: RahEvent[] }) {
  return (
    <div className="space-y-2">
      {props.events.length > 0 ? (
        props.events.map((event, index) => {
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
              key={`${event.seq}-${index}`}
              className="rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] p-3"
            >
              <div className="flex items-center justify-between gap-2">
                <div className="text-xs font-semibold text-[var(--app-fg)]">{event.type}</div>
                <div className="text-[11px] text-[var(--app-hint)]">
                  {formatEventTimestamp(event)}
                </div>
              </div>
              {detail ? (
                <div className="mt-1 text-xs text-[var(--app-hint)] line-clamp-3">{detail}</div>
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
  entry: { name: string; type: "file" | "directory" };
  expandedPaths: ReadonlySet<string>;
  directoryEntriesByPath: ReadonlyMap<string, Array<{ name: string; type: "file" | "directory" }>>;
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
        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-[var(--app-bg)] transition-colors"
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
          <div className="px-2 py-2 text-xs text-[var(--app-hint)]" style={{ paddingLeft: `${props.depth * 14 + 36}px` }}>
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
          <div className="px-2 py-2 text-xs text-[var(--app-hint)]" style={{ paddingLeft: `${props.depth * 14 + 36}px` }}>
            Empty directory.
          </div>
        )
      ) : null}
    </div>
  );
}

function FileDetailPane(props: {
  sessionId: string;
  workspaceRoot: string;
  selection: FileDetailSelection;
  onBack: () => void;
}) {
  const [diffContent, setDiffContent] = useState("");
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState("");
  const [fileLoading, setFileLoading] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const [binary, setBinary] = useState(false);
  const [truncated, setTruncated] = useState(false);
  const [displayMode, setDisplayMode] = useState<FileDetailMode>(
    props.selection.source === "changes" ? "diff" : "file",
  );

  useEffect(() => {
    setDisplayMode(props.selection.source === "changes" ? "diff" : "file");
  }, [props.selection.path, props.selection.source]);

  useEffect(() => {
    let cancelled = false;
    setDiffLoading(true);
    setDiffError(null);
    readGitDiff(props.sessionId, props.selection.path)
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
    readSessionFile(props.sessionId, props.selection.path)
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
  }, [props.selection.path, props.sessionId]);

  const displayPath = getDisplayPath(props.selection.path, props.workspaceRoot);
  const fileName = props.selection.path.split("/").pop() || props.selection.path;
  const hasDiff = diffContent.trim().length > 0;

  useEffect(() => {
    if (
      props.selection.source === "changes" &&
      !diffLoading &&
      !diffError &&
      !hasDiff &&
      !fileLoading &&
      !fileError &&
      !binary
    ) {
      setDisplayMode("file");
    }
  }, [
    binary,
    diffError,
    diffLoading,
    fileError,
    fileLoading,
    hasDiff,
    props.selection.source,
  ]);

  return (
    <div className="space-y-3">
      <div className="flex items-start gap-2">
        <button
          type="button"
          onClick={props.onBack}
          className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[var(--app-hint)] hover:bg-[var(--app-bg)] hover:text-[var(--app-fg)] transition-colors"
          title="Back"
        >
          <ArrowLeft size={16} />
        </button>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-[var(--app-fg)]">{fileName}</div>
          <div className="truncate text-[11px] text-[var(--app-hint)]">{displayPath}</div>
        </div>
      </div>

      {hasDiff ? (
        <div className="flex items-center gap-1 rounded-lg bg-[var(--app-bg)] p-0.5">
          <button
            type="button"
            onClick={() => setDisplayMode("diff")}
            className={`flex-1 rounded-md px-2 py-1 text-xs font-medium transition-colors ${
              displayMode === "diff"
                ? "bg-[var(--app-subtle-bg)] text-[var(--app-fg)]"
                : "text-[var(--app-hint)] hover:bg-[var(--app-subtle-bg)]/50 hover:text-[var(--app-fg)]"
            }`}
          >
            Diff
          </button>
          <button
            type="button"
            onClick={() => setDisplayMode("file")}
            className={`flex-1 rounded-md px-2 py-1 text-xs font-medium transition-colors ${
              displayMode === "file"
                ? "bg-[var(--app-subtle-bg)] text-[var(--app-fg)]"
                : "text-[var(--app-hint)] hover:bg-[var(--app-subtle-bg)]/50 hover:text-[var(--app-fg)]"
            }`}
          >
            File
          </button>
        </div>
      ) : null}

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
          <DiffDisplay diffContent={diffContent} />
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
        <div className="text-sm text-[var(--app-hint)]">This file looks binary and cannot be previewed.</div>
      ) : (
        <div className="space-y-2">
          {truncated ? (
            <div className="rounded-lg border border-[var(--app-border)] bg-[var(--app-subtle-bg)] p-2 text-[11px] text-[var(--app-hint)]">
              Showing the first part of a large file.
            </div>
          ) : null}
          <pre className="overflow-auto rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] p-3 text-xs font-mono whitespace-pre-wrap break-words">
            <code>{fileContent || "File is empty."}</code>
          </pre>
        </div>
      )}
    </div>
  );
}

export function InspectorPane(props: {
  sessionId: string;
  workspaceRoot: string;
  events: RahEvent[];
  onCollapse?: () => void;
}) {
  const [activeTab, setActiveTab] = useState<InspectorTab>("changes");
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
  const [directoryEntriesByPath, setDirectoryEntriesByPath] = useState<
    Map<string, Array<{ name: string; type: "file" | "directory" }>>
  >(new Map());
  const [directoryErrorsByPath, setDirectoryErrorsByPath] = useState<Map<string, string>>(new Map());
  const [directoryLoadingPaths, setDirectoryLoadingPaths] = useState<Set<string>>(new Set());
  const [gitStatus, setGitStatus] = useState<{ branch?: string; changedFiles: string[] } | null>(null);
  const [gitStatusLoading, setGitStatusLoading] = useState(false);
  const [gitStatusError, setGitStatusError] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<FileDetailSelection | null>(null);

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
    setGitStatusLoading(true);
    setGitStatusError(null);
    try {
      const response = await readGitStatus(props.sessionId);
      setGitStatus({
        ...(response.branch ? { branch: response.branch } : {}),
        changedFiles: response.changedFiles,
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
  }, [props.sessionId]);

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

  const openFile = (path: string, source: "files" | "changes") => {
    setSelectedFile({ path, source });
  };

  const topLevelEntries = props.workspaceRoot ? directoryEntriesByPath.get(props.workspaceRoot) ?? [] : [];
  const changeCount = gitStatus?.changedFiles.length ?? 0;
  const rootLabel = props.workspaceRoot.split("/").filter(Boolean).at(-1) ?? props.workspaceRoot;

  return (
    <div className="h-full flex flex-col">
      <div className="h-14 px-4 flex items-center justify-between shrink-0">
        <div className="min-w-0">
          <div className="text-sm font-medium text-[var(--app-fg)]">Inspector</div>
          <div className="text-[11px] text-[var(--app-hint)] truncate">{props.workspaceRoot}</div>
        </div>
        {props.onCollapse && (
          <button
            type="button"
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-[var(--app-hint)] hover:bg-[var(--app-bg)] hover:text-[var(--app-fg)] transition-colors"
            onClick={props.onCollapse}
            aria-label="Collapse inspector"
            title="Collapse inspector"
          >
            <PanelRight size={16} />
          </button>
        )}
      </div>
      <div className="shrink-0 px-3 py-2">
        <div className="flex items-center gap-0.5 rounded-lg bg-[var(--app-bg)] p-0.5">
          <button
            type="button"
            className={`flex-1 rounded-md px-2 py-1 text-xs font-medium transition-colors ${
              activeTab === "changes"
                ? "bg-[var(--app-subtle-bg)] text-[var(--app-fg)]"
                : "text-[var(--app-hint)] hover:text-[var(--app-fg)] hover:bg-[var(--app-subtle-bg)]/50"
            }`}
            onClick={() => {
              setActiveTab("changes");
              setSelectedFile(null);
            }}
          >
            Changes {changeCount > 0 ? `(${changeCount})` : ""}
          </button>
          <button
            type="button"
            className={`flex-1 rounded-md px-2 py-1 text-xs font-medium transition-colors ${
              activeTab === "files"
                ? "bg-[var(--app-subtle-bg)] text-[var(--app-fg)]"
                : "text-[var(--app-hint)] hover:text-[var(--app-fg)] hover:bg-[var(--app-subtle-bg)]/50"
            }`}
            onClick={() => {
              setActiveTab("files");
              setSelectedFile(null);
            }}
          >
            Files
          </button>
          <button
            type="button"
            className={`flex-1 rounded-md px-2 py-1 text-xs font-medium transition-colors ${
              activeTab === "events"
                ? "bg-[var(--app-subtle-bg)] text-[var(--app-fg)]"
                : "text-[var(--app-hint)] hover:text-[var(--app-fg)] hover:bg-[var(--app-subtle-bg)]/50"
            }`}
            onClick={() => {
              setActiveTab("events");
              setSelectedFile(null);
            }}
          >
            Events {props.events.length > 0 ? `(${props.events.length})` : ""}
          </button>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto custom-scrollbar p-3">
        {activeTab === "changes" ? (
          selectedFile ? (
            <FileDetailPane
              sessionId={props.sessionId}
              workspaceRoot={props.workspaceRoot}
              selection={selectedFile}
              onBack={() => setSelectedFile(null)}
            />
          ) : (
            <div className="space-y-3">
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 text-sm font-medium text-[var(--app-fg)]">
                    <GitBranch size={14} className="text-[var(--app-hint)]" />
                    <span>{gitStatus?.branch ?? "detached"}</span>
                  </div>
                  <div className="text-[11px] text-[var(--app-hint)]">
                    {changeCount} changed file{changeCount === 1 ? "" : "s"}
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
                <div className="text-sm text-[var(--app-hint)]">No file changes detected.</div>
              ) : (
                <div className="space-y-1">
                  {gitStatus?.changedFiles.map((filePath) => (
                    <button
                      key={filePath}
                      type="button"
                      onClick={() => openFile(filePath, "changes")}
                      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-[var(--app-bg)] transition-colors"
                    >
                      <FileText size={14} className="shrink-0 text-[var(--app-hint)]" />
                      <span className="min-w-0 truncate text-sm text-[var(--app-fg)]">
                        {filePath}
                      </span>
                    </button>
                  ))}
                </div>
              )}
              <ChangesFromEvents events={props.events} />
            </div>
          )
        ) : activeTab === "files" ? (
          selectedFile ? (
            <FileDetailPane
              sessionId={props.sessionId}
              workspaceRoot={props.workspaceRoot}
              selection={selectedFile}
              onBack={() => setSelectedFile(null)}
            />
          ) : !props.workspaceRoot ? (
            <div className="text-sm text-[var(--app-hint)]">No workspace available.</div>
          ) : (
            <div className="space-y-3">
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="text-sm font-medium text-[var(--app-fg)] truncate">{rootLabel}</div>
                  <div className="text-[11px] text-[var(--app-hint)] truncate">{props.workspaceRoot}</div>
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
              {directoryLoadingPaths.has(props.workspaceRoot) && topLevelEntries.length === 0 ? (
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
        ) : (
          <EventsList events={props.events} />
        )}
      </div>
    </div>
  );
}

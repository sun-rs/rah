import { ChevronDown, ChevronRight, FileText, Folder, LoaderCircle, RefreshCcw } from "lucide-react";
import type { DirectoryEntry } from "./shared";
import { joinPath } from "./shared";

type SearchFileResult = { path: string; name: string; parentPath: string };

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

export function InspectorFilesPane(props: {
  workspaceRoot: string;
  topLevelEntries: readonly DirectoryEntry[];
  expandedPaths: ReadonlySet<string>;
  directoryEntriesByPath: ReadonlyMap<string, DirectoryEntry[]>;
  directoryErrorsByPath: ReadonlyMap<string, string>;
  directoryLoadingPaths: ReadonlySet<string>;
  fileSearchQuery: string;
  fileSearchResults: readonly SearchFileResult[];
  fileSearchLoading: boolean;
  fileSearchError: string | null;
  onFileSearchQueryChange: (value: string) => void;
  onRefresh: () => void;
  onToggleDirectory: (path: string) => void;
  onOpenFile: (path: string) => void;
}) {
  if (!props.workspaceRoot) {
    return <div className="text-sm text-[var(--app-hint)]">No workspace available.</div>;
  }

  const rootLabel = props.workspaceRoot.split("/").filter(Boolean).at(-1) ?? props.workspaceRoot;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium text-[var(--app-fg)]">{rootLabel}</div>
          <div className="truncate text-[11px] text-[var(--app-hint)]">{props.workspaceRoot}</div>
        </div>
        <button
          type="button"
          onClick={props.onRefresh}
          className="inline-flex h-7 w-7 items-center justify-center rounded-md text-[var(--app-hint)] transition-colors hover:bg-[var(--app-bg)] hover:text-[var(--app-fg)]"
          title="Refresh files"
        >
          <RefreshCcw size={14} />
        </button>
      </div>
      <div className="rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] px-3 py-2">
        <input
          value={props.fileSearchQuery}
          onChange={(event) => props.onFileSearchQueryChange(event.target.value)}
          placeholder="Search files"
          className="w-full bg-transparent text-sm text-[var(--app-fg)] placeholder:text-[var(--app-hint)] focus:outline-none"
          autoCapitalize="none"
          autoCorrect="off"
        />
      </div>
      {props.fileSearchQuery.trim() ? (
        props.fileSearchLoading ? (
          <div className="flex items-center gap-2 text-sm text-[var(--app-hint)]">
            <LoaderCircle size={14} className="animate-spin" />
            Searching files…
          </div>
        ) : props.fileSearchError ? (
          <div className="rounded-lg border border-[var(--app-border)] bg-[var(--app-warning-bg)] p-3 text-xs text-[var(--app-hint)]">
            {props.fileSearchError}
          </div>
        ) : props.fileSearchResults.length === 0 ? (
          <div className="text-sm text-[var(--app-hint)]">No files match your search.</div>
        ) : (
          <div className="space-y-1">
            {props.fileSearchResults.map((file) => (
              <button
                key={file.path}
                type="button"
                onClick={() => props.onOpenFile(file.path)}
                className="flex w-full items-center gap-2 rounded-md border border-transparent bg-[var(--app-bg)] px-2.5 py-2 text-left transition-colors hover:border-[var(--app-border)] hover:bg-[var(--app-subtle-bg)]"
              >
                <FileText size={14} className="shrink-0 text-[var(--app-hint)]" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm text-[var(--app-fg)]">{file.name}</div>
                  <div className="truncate text-[11px] text-[var(--app-hint)]">{file.parentPath || "."}</div>
                </div>
              </button>
            ))}
          </div>
        )
      ) : props.directoryLoadingPaths.has(props.workspaceRoot) && props.topLevelEntries.length === 0 ? (
        <div className="flex items-center gap-2 text-sm text-[var(--app-hint)]">
          <LoaderCircle size={14} className="animate-spin" />
          Loading files…
        </div>
      ) : props.directoryErrorsByPath.get(props.workspaceRoot) ? (
        <div className="rounded-lg border border-[var(--app-border)] bg-[var(--app-warning-bg)] p-3 text-xs text-[var(--app-hint)]">
          {props.directoryErrorsByPath.get(props.workspaceRoot)}
        </div>
      ) : props.topLevelEntries.length === 0 ? (
        <div className="text-sm text-[var(--app-hint)]">No files in workspace.</div>
      ) : (
        <div className="space-y-0.5">
          {props.topLevelEntries.map((entry) => (
            <DirectoryTreeNode
              key={`${props.workspaceRoot}/${entry.name}`}
              path={props.workspaceRoot}
              depth={0}
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
      )}
    </div>
  );
}

import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight, Folder } from "lucide-react";
import { FileResourceIcon } from "../components/chat/FileResourceIcon";
import { getDisplayPath } from "./shared";

export type InspectorChangeTreeFile = {
  id: string;
  path: string;
  displayName?: string;
  additions?: number;
  deletions?: number;
  statusLabel?: string;
  statusTone?: string;
  scopeLabel?: string;
  binary?: boolean;
  oldPath?: string;
  onOpen: () => void;
};

export type InspectorChangeTreeDirectory = {
  kind: "directory";
  name: string;
  path: string;
  directories: InspectorChangeTreeDirectory[];
  files: InspectorChangeTreeFile[];
};

type MutableTreeDirectory = Omit<InspectorChangeTreeDirectory, "directories"> & {
  directoryMap: Map<string, MutableTreeDirectory>;
};

function createMutableDirectory(name: string, path: string): MutableTreeDirectory {
  return { kind: "directory", name, path, directoryMap: new Map(), files: [] };
}

function finalizeDirectory(directory: MutableTreeDirectory): InspectorChangeTreeDirectory {
  return {
    kind: "directory",
    name: directory.name,
    path: directory.path,
    directories: [...directory.directoryMap.values()]
      .sort((left, right) => left.name.localeCompare(right.name))
      .map(finalizeDirectory),
    files: [...directory.files].sort((left, right) => left.path.localeCompare(right.path)),
  };
}

export function buildInspectorChangeTree(
  files: readonly InspectorChangeTreeFile[],
  workspaceRoot: string,
): InspectorChangeTreeDirectory {
  const root = createMutableDirectory("", "");
  for (const file of files) {
    const displayPath = getDisplayPath(file.path, workspaceRoot)
      .replace(/^\.\//, "")
      .replace(/^\/+/, "");
    const segments = displayPath.split("/").filter(Boolean);
    const displayName = segments.pop() ?? (displayPath || file.path);
    let directory = root;
    for (const segment of segments) {
      const path = directory.path ? `${directory.path}/${segment}` : segment;
      let child = directory.directoryMap.get(segment);
      if (!child) {
        child = createMutableDirectory(segment, path);
        directory.directoryMap.set(segment, child);
      }
      directory = child;
    }
    directory.files.push({ ...file, displayName });
  }
  return finalizeDirectory(root);
}

function fileName(file: InspectorChangeTreeFile): string {
  return file.displayName ?? file.path.split("/").pop() ?? file.path;
}

function countFiles(directory: InspectorChangeTreeDirectory): number {
  return directory.files.length + directory.directories.reduce((count, child) => count + countFiles(child), 0);
}

function compactDirectory(directory: InspectorChangeTreeDirectory): {
  label: string;
  directory: InspectorChangeTreeDirectory;
} {
  let label = directory.name;
  let current = directory;
  while (current.files.length === 0 && current.directories.length === 1) {
    current = current.directories[0]!;
    label += `/${current.name}`;
  }
  return { label, directory: current };
}

function FileRow(props: { file: InspectorChangeTreeFile; depth: number }) {
  const additions = props.file.additions ?? 0;
  const deletions = props.file.deletions ?? 0;
  return (
    <button
      type="button"
      onClick={props.file.onOpen}
      className="flex min-h-[30px] w-full min-w-0 items-center gap-1.5 rounded-md py-1 pr-1.5 text-left transition-colors hover:bg-[var(--app-bg)]"
      style={{ paddingLeft: `${props.depth * 14 + 6}px` }}
      title={props.file.oldPath ? `${props.file.oldPath} → ${props.file.path}` : props.file.path}
    >
      <span className="inline-block h-[13px] w-[13px] shrink-0" />
      <FileResourceIcon path={props.file.path} size={15} className="shrink-0 text-[var(--app-hint)]" />
      <span className="min-w-0 flex-1 truncate text-[13px] text-[var(--app-fg)]">
        {fileName(props.file)}
      </span>
      {props.file.binary ? (
        <span className="shrink-0 text-[9px] font-medium text-[var(--app-hint)]">BIN</span>
      ) : null}
      {additions > 0 ? (
        <span className="shrink-0 text-[11px] font-medium text-[var(--diff-add-text)]">+{additions}</span>
      ) : null}
      {deletions > 0 ? (
        <span className="shrink-0 text-[11px] font-medium text-[var(--diff-remove-text)]">-{deletions}</span>
      ) : null}
      {props.file.scopeLabel ? (
        <span className="shrink-0 text-[9px] uppercase text-[var(--app-hint)]">{props.file.scopeLabel}</span>
      ) : null}
      {props.file.statusLabel ? (
        <span className={`w-3 shrink-0 text-center text-[11px] font-semibold ${props.file.statusTone ?? "text-[var(--app-hint)]"}`}>
          {props.file.statusLabel}
        </span>
      ) : null}
    </button>
  );
}

function DirectoryRow(props: {
  directory: InspectorChangeTreeDirectory;
  depth: number;
  queryActive: boolean;
  collapsedPaths: ReadonlySet<string>;
  onToggle: (path: string) => void;
}) {
  const compacted = compactDirectory(props.directory);
  const expanded = props.queryActive || !props.collapsedPaths.has(compacted.directory.path);
  return (
    <div>
      <button
        type="button"
        onClick={() => props.onToggle(compacted.directory.path)}
        className="flex min-h-[30px] w-full min-w-0 items-center gap-1.5 rounded-md py-1 pr-2 text-left transition-colors hover:bg-[var(--app-bg)]"
        style={{ paddingLeft: `${props.depth * 14 + 4}px` }}
        aria-expanded={expanded}
      >
        {expanded ? (
          <ChevronDown size={14} className="shrink-0 text-[var(--app-hint)]" />
        ) : (
          <ChevronRight size={14} className="shrink-0 text-[var(--app-hint)]" />
        )}
        <Folder size={15} className="shrink-0 text-[var(--app-hint)]" />
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-[var(--app-fg)]">
          {compacted.label}
        </span>
        <span className="shrink-0 text-[10px] tabular-nums text-[var(--app-hint)]">
          {countFiles(compacted.directory)}
        </span>
      </button>
      {expanded ? (
        <div>
          {compacted.directory.directories.map((directory) => (
            <DirectoryRow
              key={directory.path}
              directory={directory}
              depth={props.depth + 1}
              queryActive={props.queryActive}
              collapsedPaths={props.collapsedPaths}
              onToggle={props.onToggle}
            />
          ))}
          {compacted.directory.files.map((file) => (
            <FileRow key={file.id} file={file} depth={props.depth + 1} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function InspectorChangeTree(props: {
  files: readonly InspectorChangeTreeFile[];
  workspaceRoot: string;
  query?: string;
  emptyLabel?: string;
}) {
  const normalizedQuery = props.query?.trim().toLocaleLowerCase() ?? "";
  const filteredFiles = useMemo(
    () =>
      normalizedQuery
        ? props.files.filter((file) =>
            getDisplayPath(file.path, props.workspaceRoot).toLocaleLowerCase().includes(normalizedQuery),
          )
        : props.files,
    [normalizedQuery, props.files, props.workspaceRoot],
  );
  const tree = useMemo(
    () => buildInspectorChangeTree(filteredFiles, props.workspaceRoot),
    [filteredFiles, props.workspaceRoot],
  );
  const [collapsedPaths, setCollapsedPaths] = useState<Set<string>>(() => new Set());
  const toggle = (path: string) => {
    setCollapsedPaths((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  if (filteredFiles.length === 0) {
    return <div className="py-3 text-sm text-[var(--app-hint)]">{props.emptyLabel ?? "No matching files."}</div>;
  }

  return (
    <div data-testid="inspector-change-tree">
      {tree.directories.map((directory) => (
        <DirectoryRow
          key={directory.path}
          directory={directory}
          depth={0}
          queryActive={Boolean(normalizedQuery)}
          collapsedPaths={collapsedPaths}
          onToggle={toggle}
        />
      ))}
      {tree.files.map((file) => (
        <FileRow key={file.id} file={file} depth={0} />
      ))}
    </div>
  );
}

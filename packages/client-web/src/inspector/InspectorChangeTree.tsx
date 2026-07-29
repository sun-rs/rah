import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import {
  ChevronDown,
  ChevronRight,
  ChevronsDown,
  ChevronsUp,
  Folder,
} from "lucide-react";
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
  fileCount: number;
  directories: InspectorChangeTreeDirectory[];
  files: InspectorChangeTreeFile[];
};

type MutableTreeDirectory = Omit<
  InspectorChangeTreeDirectory,
  "directories" | "fileCount"
> & {
  directoryMap: Map<string, MutableTreeDirectory>;
};

function createMutableDirectory(name: string, path: string): MutableTreeDirectory {
  return { kind: "directory", name, path, directoryMap: new Map(), files: [] };
}

function finalizeDirectory(directory: MutableTreeDirectory): InspectorChangeTreeDirectory {
  const directories = [...directory.directoryMap.values()]
    .sort((left, right) => left.name.localeCompare(right.name))
    .map(finalizeDirectory);
  const files = [...directory.files].sort((left, right) =>
    left.path.localeCompare(right.path),
  );
  return {
    kind: "directory",
    name: directory.name,
    path: directory.path,
    fileCount:
      files.length +
      directories.reduce((count, child) => count + child.fileCount, 0),
    directories,
    files,
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

export type InspectorChangeTreeRow =
  | {
      kind: "directory";
      key: string;
      depth: number;
      label: string;
      directory: InspectorChangeTreeDirectory;
      expanded: boolean;
    }
  | {
      kind: "file";
      key: string;
      depth: number;
      file: InspectorChangeTreeFile;
    };

export function flattenInspectorChangeTree(
  tree: InspectorChangeTreeDirectory,
  expandedPaths: ReadonlySet<string>,
  queryActive = false,
): InspectorChangeTreeRow[] {
  const rows: InspectorChangeTreeRow[] = [];
  const appendDirectory = (
    source: InspectorChangeTreeDirectory,
    depth: number,
  ) => {
    const compacted = compactDirectory(source);
    const expanded =
      queryActive || expandedPaths.has(compacted.directory.path);
    rows.push({
      kind: "directory",
      key: `directory:${compacted.directory.path}`,
      depth,
      label: compacted.label,
      directory: compacted.directory,
      expanded,
    });
    if (!expanded) {
      return;
    }
    for (const directory of compacted.directory.directories) {
      appendDirectory(directory, depth + 1);
    }
    for (const file of compacted.directory.files) {
      rows.push({
        kind: "file",
        key: `file:${file.id}`,
        depth: depth + 1,
        file,
      });
    }
  };

  for (const directory of tree.directories) {
    appendDirectory(directory, 0);
  }
  for (const file of tree.files) {
    rows.push({
      kind: "file",
      key: `file:${file.id}`,
      depth: 0,
      file,
    });
  }
  return rows;
}

export function collectExpandableInspectorChangeTreePaths(
  tree: InspectorChangeTreeDirectory,
): string[] {
  const paths: string[] = [];
  const appendDirectory = (source: InspectorChangeTreeDirectory) => {
    const compacted = compactDirectory(source);
    paths.push(compacted.directory.path);
    for (const directory of compacted.directory.directories) {
      appendDirectory(directory);
    }
  };
  for (const directory of tree.directories) {
    appendDirectory(directory);
  }
  return paths;
}

export const INSPECTOR_CHANGE_TREE_ROW_HEIGHT_PX = 30;
const INSPECTOR_CHANGE_TREE_VIRTUAL_THRESHOLD = 100;
const INSPECTOR_CHANGE_TREE_OVERSCAN_ROWS = 8;

export function deriveInspectorChangeTreeVirtualWindow(input: {
  rowCount: number;
  visibleStartPx: number;
  visibleEndPx: number;
  rowHeightPx?: number;
  overscanRows?: number;
}): { start: number; end: number } {
  const rowHeightPx =
    input.rowHeightPx ?? INSPECTOR_CHANGE_TREE_ROW_HEIGHT_PX;
  const overscanRows =
    input.overscanRows ?? INSPECTOR_CHANGE_TREE_OVERSCAN_ROWS;
  return {
    start: Math.max(
      0,
      Math.floor(input.visibleStartPx / rowHeightPx) - overscanRows,
    ),
    end: Math.min(
      input.rowCount,
      Math.ceil(input.visibleEndPx / rowHeightPx) + overscanRows,
    ),
  };
}

function useInspectorChangeTreeVirtualWindow(
  rowCount: number,
): {
  start: number;
  end: number;
  virtual: boolean;
  rootRef: RefObject<HTMLDivElement | null>;
} {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const rafRef = useRef<number | null>(null);
  const virtual = rowCount > INSPECTOR_CHANGE_TREE_VIRTUAL_THRESHOLD;
  const [range, setRange] = useState(() => ({
    start: 0,
    end: Math.min(rowCount, INSPECTOR_CHANGE_TREE_VIRTUAL_THRESHOLD),
  }));

  const measure = useCallback(() => {
    const root = rootRef.current;
    if (!virtual || !root) {
      setRange((current) =>
        current.start === 0 && current.end === rowCount
          ? current
          : { start: 0, end: rowCount },
      );
      return;
    }
    const viewport = root.closest<HTMLElement>(
      '[data-rah-scroll-viewport="true"]',
    );
    if (!viewport) {
      setRange({ start: 0, end: Math.min(rowCount, 100) });
      return;
    }
    const rootRect = root.getBoundingClientRect();
    const viewportRect = viewport.getBoundingClientRect();
    const next = deriveInspectorChangeTreeVirtualWindow({
      rowCount,
      visibleStartPx: Math.max(0, viewportRect.top - rootRect.top),
      visibleEndPx: Math.max(
        0,
        Math.min(rootRect.height, viewportRect.bottom - rootRect.top),
      ),
    });
    setRange((current) =>
      current.start === next.start && current.end === next.end
        ? current
        : next,
    );
  }, [rowCount, virtual]);

  const scheduleMeasure = useCallback(() => {
    if (rafRef.current !== null) {
      return;
    }
    rafRef.current = window.requestAnimationFrame(() => {
      rafRef.current = null;
      measure();
    });
  }, [measure]);

  useLayoutEffect(() => {
    measure();
  }, [measure]);

  useEffect(() => {
    const root = rootRef.current;
    if (!virtual || !root) {
      return;
    }
    const viewport = root.closest<HTMLElement>(
      '[data-rah-scroll-viewport="true"]',
    );
    const content = viewport?.firstElementChild;
    viewport?.addEventListener("scroll", scheduleMeasure, { passive: true });
    window.addEventListener("resize", scheduleMeasure);
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(scheduleMeasure);
    observer?.observe(root);
    if (viewport) {
      observer?.observe(viewport);
    }
    if (content instanceof HTMLElement) {
      observer?.observe(content);
    }
    return () => {
      viewport?.removeEventListener("scroll", scheduleMeasure);
      window.removeEventListener("resize", scheduleMeasure);
      observer?.disconnect();
      if (rafRef.current !== null) {
        window.cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [scheduleMeasure, virtual]);

  return { ...range, virtual, rootRef };
}

function FileRow(props: { file: InspectorChangeTreeFile; depth: number }) {
  const additions = props.file.additions ?? 0;
  const deletions = props.file.deletions ?? 0;
  return (
    <button
      type="button"
      onClick={props.file.onOpen}
      className="flex h-[30px] w-full min-w-0 items-center gap-1.5 rounded-md py-1 pr-1.5 text-left transition-colors hover:bg-[var(--app-bg)]"
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
  row: Extract<InspectorChangeTreeRow, { kind: "directory" }>;
  depth: number;
  onToggle: (path: string) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => props.onToggle(props.row.directory.path)}
      className="flex h-[30px] w-full min-w-0 items-center gap-1.5 rounded-md py-1 pr-2 text-left transition-colors hover:bg-[var(--app-bg)]"
      style={{ paddingLeft: `${props.depth * 14 + 4}px` }}
      aria-expanded={props.row.expanded}
    >
      {props.row.expanded ? (
        <ChevronDown size={14} className="shrink-0 text-[var(--app-hint)]" />
      ) : (
        <ChevronRight size={14} className="shrink-0 text-[var(--app-hint)]" />
      )}
      <Folder size={15} className="shrink-0 text-[var(--app-hint)]" />
      <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-[var(--app-fg)]">
        {props.row.label}
      </span>
      <span className="shrink-0 text-[10px] tabular-nums text-[var(--app-hint)]">
        {props.row.directory.fileCount}
      </span>
    </button>
  );
}

export function InspectorChangeTree(props: {
  files: readonly InspectorChangeTreeFile[];
  workspaceRoot: string;
  query?: string;
  emptyLabel?: string;
  heading?: string;
  defaultExpanded?: boolean;
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
  const expandablePaths = useMemo(
    () => collectExpandableInspectorChangeTreePaths(tree),
    [tree],
  );
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(
    () => new Set(),
  );
  const [expandAllSelected, setExpandAllSelected] = useState(
    () => props.defaultExpanded === true,
  );
  const effectiveExpandedPaths = useMemo(
    () =>
      expandAllSelected
        ? new Set(expandablePaths)
        : expandedPaths,
    [expandAllSelected, expandablePaths, expandedPaths],
  );
  const allExpanded =
    expandablePaths.length > 0 &&
    expandablePaths.every((path) => effectiveExpandedPaths.has(path));
  const toggle = (path: string) => {
    setExpandedPaths(() => {
      const next = new Set(effectiveExpandedPaths);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
    setExpandAllSelected(false);
  };
  const toggleAll = () => {
    if (allExpanded) {
      setExpandedPaths(new Set());
      setExpandAllSelected(false);
      return;
    }
    setExpandedPaths(new Set(expandablePaths));
    setExpandAllSelected(true);
  };
  const rows = useMemo(
    () =>
      flattenInspectorChangeTree(
        tree,
        effectiveExpandedPaths,
        Boolean(normalizedQuery),
      ),
    [effectiveExpandedPaths, normalizedQuery, tree],
  );
  const virtualWindow = useInspectorChangeTreeVirtualWindow(rows.length);

  if (filteredFiles.length === 0) {
    return <div className="py-3 text-sm text-[var(--app-hint)]">{props.emptyLabel ?? "No matching files."}</div>;
  }

  return (
    <>
      {props.heading ? (
        <div className="flex h-[30px] items-center gap-0.5 px-1 text-xs font-semibold text-[var(--app-fg)]">
          <span className="min-w-0 truncate">{props.heading}</span>
          {!normalizedQuery && expandablePaths.length > 0 ? (
            <button
              type="button"
              onClick={toggleAll}
              aria-label={allExpanded ? "Collapse all changes" : "Expand all changes"}
              title={allExpanded ? "Collapse all changes" : "Expand all changes"}
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[var(--app-hint)] transition-colors hover:bg-[var(--app-bg)] hover:text-[var(--app-fg)]"
            >
              {allExpanded ? <ChevronsUp size={14} /> : <ChevronsDown size={14} />}
            </button>
          ) : null}
        </div>
      ) : null}
      <div
        ref={virtualWindow.rootRef}
        data-testid="inspector-change-tree"
        data-virtualized={virtualWindow.virtual ? "true" : "false"}
        className="relative"
        style={{
          height: `${rows.length * INSPECTOR_CHANGE_TREE_ROW_HEIGHT_PX}px`,
        }}
      >
      <div
        className="absolute inset-x-0 top-0"
        style={{
          transform: `translateY(${
            virtualWindow.start * INSPECTOR_CHANGE_TREE_ROW_HEIGHT_PX
          }px)`,
        }}
      >
        {rows
          .slice(virtualWindow.start, virtualWindow.end)
          .map((row) =>
            row.kind === "directory" ? (
              <DirectoryRow
                key={row.key}
                row={row}
                depth={row.depth}
                onToggle={toggle}
              />
            ) : (
              <FileRow key={row.key} file={row.file} depth={row.depth} />
            ),
          )}
      </div>
      </div>
    </>
  );
}

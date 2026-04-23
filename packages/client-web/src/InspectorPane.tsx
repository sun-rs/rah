import { useEffect, useState } from "react";
import type { RahEvent } from "@rah/runtime-protocol";
import {
  listDirectory,
  readGitStatus,
  readWorkspaceGitStatus,
  searchSessionFiles,
  searchWorkspaceFilesByDirectory,
} from "./api";
import { LoaderCircle } from "lucide-react";
import { InspectorChangesPane } from "./inspector/InspectorChangesPane";
import { InspectorFileDetailDialog } from "./inspector/InspectorFileDetailDialog";
import { InspectorFilesPane } from "./inspector/InspectorFilesPane";
import { InspectorHeader } from "./inspector/InspectorHeader";
import type { DirectoryEntry, FileDetailSelection, InspectorGitStatus, InspectorTab } from "./inspector/shared";
import { formatEventTimestamp } from "./inspector/shared";

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
  const [gitStatus, setGitStatus] = useState<InspectorGitStatus | null>(null);
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
      status?: FileDetailSelection["status"];
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
  return (
    <div className="h-full flex flex-col">
      <InspectorHeader
        workspaceRoot={props.workspaceRoot}
        activeTab={activeTab}
        changeCount={changeCount}
        eventCount={props.events.length}
        hasSession={Boolean(props.sessionId)}
        onTabChange={setActiveTab}
        {...(props.onCollapse ? { onCollapse: props.onCollapse } : {})}
        {...(props.onOpenTerminal ? { onOpenTerminal: props.onOpenTerminal } : {})}
      />
      <div className="flex-1 overflow-y-scroll custom-scrollbar scrollbar-stable p-3">
        {activeTab === "changes" ? (
          <InspectorChangesPane
            gitStatus={gitStatus}
            loading={gitStatusLoading}
            error={gitStatusError}
            events={props.events}
            onRefresh={() => void loadGitStatus()}
            onOpenFile={(selection) => setSelectedFile(selection)}
          />
        ) : activeTab === "files" ? (
          <InspectorFilesPane
            workspaceRoot={props.workspaceRoot}
            topLevelEntries={topLevelEntries}
            expandedPaths={expandedPaths}
            directoryEntriesByPath={directoryEntriesByPath}
            directoryErrorsByPath={directoryErrorsByPath}
            directoryLoadingPaths={directoryLoadingPaths}
            fileSearchQuery={fileSearchQuery}
            fileSearchResults={fileSearchResults}
            fileSearchLoading={fileSearchLoading}
            fileSearchError={fileSearchError}
            onFileSearchQueryChange={setFileSearchQuery}
            onRefresh={() => void loadDirectory(props.workspaceRoot)}
            onToggleDirectory={toggleDirectory}
            onOpenFile={(path) => openFile(path, "files")}
          />
        ) : props.sessionId ? (
          <EventsList events={props.events} />
        ) : (
          <div className="text-sm text-[var(--app-hint)]">No events without a selected session.</div>
        )}
      </div>

      {selectedFile ? (
        <InspectorFileDetailDialog
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

import { useCallback, useEffect, useRef, useState } from "react";
import type { TurnFileChangesResponse } from "@rah/runtime-protocol";
import {
  listDirectory,
  readSessionConversationResourceIndex,
  readTurnFileChanges,
  readWorkspaceGitStatus,
  searchSessionFiles,
  searchWorkspaceFilesByDirectory,
} from "./api";
import { SegmentedButton, SegmentedButtonLabel, SegmentedControl } from "./components/SegmentedControl";
import { InspectorChangesPane } from "./inspector/InspectorChangesPane";
import { InspectorFileDetailDialog } from "./inspector/InspectorFileDetailDialog";
import { InspectorFilesPane } from "./inspector/InspectorFilesPane";
import { InspectorHeader } from "./inspector/InspectorHeader";
import { InspectorResourcesPane } from "./inspector/InspectorResourcesPane";
import { InspectorTurnChangesPane } from "./inspector/InspectorTurnChangesPane";
import { useReviewOverlay } from "./inspector/ReviewOverlay";
import {
  invalidateCachedConversationResourceIndex,
  loadCachedConversationResourceIndex,
  readCachedConversationResourceIndex,
  subscribeConversationResourceIndex,
  type ConversationResourceIndex,
} from "./inspector/conversation-resource-index";
import {
  loadCachedSessionInspectorPrimary,
  normalizeInspectorGitStatus,
  readCachedSessionInspectorPrimary,
  readSessionInspectorGitStatus,
  subscribeSessionInspectorPrimary,
  type SessionInspectorPrimarySnapshot,
} from "./inspector/session-inspector-primary-cache";
import type {
  DirectoryEntry,
  FileDetailSelection,
  InspectorGitStatus,
  InspectorOpenFileRequest,
  InspectorTab,
} from "./inspector/shared";
import { getTurnArtifactErrorMessage } from "./inspector/shared";
import { OverlayScrollArea } from "./components/OverlayScrollArea";

type InspectorChangeScope = "turn" | "workspace";

export function InspectorPane(props: {
  sessionId: string | null;
  workspaceRoot: string;
  onOpenTerminal?: () => void;
  onClosePanel?: () => void;
  openFileRequest?: InspectorOpenFileRequest | null;
}) {
  const initialTurnRequest =
    props.openFileRequest?.kind === "turn_changes" &&
    props.openFileRequest.sessionId &&
    props.openFileRequest.turnId
      ? {
          sessionId: props.openFileRequest.sessionId,
          turnId: props.openFileRequest.turnId,
        }
      : null;
  const [activeTab, setActiveTab] = useState<InspectorTab>("changes");
  const [changeScope, setChangeScope] = useState<InspectorChangeScope>(
    initialTurnRequest ? "turn" : "workspace",
  );
  const [activeTurnTarget, setActiveTurnTarget] = useState<{
    sessionId: string;
    turnId: string;
  } | null>(initialTurnRequest);
  const [turnChanges, setTurnChanges] = useState<TurnFileChangesResponse | null>(null);
  const [turnChangesLoading, setTurnChangesLoading] = useState(false);
  const [turnChangesError, setTurnChangesError] = useState<string | null>(null);
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
  const [directoryEntriesByPath, setDirectoryEntriesByPath] = useState<Map<string, DirectoryEntry[]>>(
    new Map(),
  );
  const [directoryErrorsByPath, setDirectoryErrorsByPath] = useState<Map<string, string>>(new Map());
  const [directoryLoadingPaths, setDirectoryLoadingPaths] = useState<Set<string>>(new Set());
  const [gitStatus, setGitStatus] = useState<InspectorGitStatus | null>(null);
  const [selectedBaseBranch, setSelectedBaseBranch] = useState<string | undefined>(undefined);
  const [gitStatusLoading, setGitStatusLoading] = useState(false);
  const [gitStatusError, setGitStatusError] = useState<string | null>(null);
  const [fileSearchQuery, setFileSearchQuery] = useState("");
  const [fileSearchResults, setFileSearchResults] = useState<Array<{ path: string; name: string; parentPath: string }>>([]);
  const [fileSearchLoading, setFileSearchLoading] = useState(false);
  const [fileSearchError, setFileSearchError] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<FileDetailSelection | null>(null);
  const { openReview } = useReviewOverlay();
  const gitStatusRequestRef = useRef(0);
  const turnChangesRequestRef = useRef(0);
  const initialResourceCache = props.sessionId
    ? readCachedConversationResourceIndex(props.sessionId)
    : undefined;
  const [resourceIndexState, setResourceIndexState] = useState<{
    sessionId: string | null;
    index: ConversationResourceIndex;
    indexing: boolean;
    validated: boolean;
    error: string | null;
    warning: string | null;
  }>(() => ({
    sessionId: props.sessionId,
    index: initialResourceCache?.index ?? { outputs: [], sources: [] },
    indexing: Boolean(props.sessionId && !initialResourceCache?.validated),
    validated: initialResourceCache?.validated ?? !props.sessionId,
    error: initialResourceCache?.error ?? null,
    warning: initialResourceCache?.warning ?? null,
  }));
  const indexedResources =
    resourceIndexState.sessionId === props.sessionId
      ? resourceIndexState.index
      : { outputs: [], sources: [] };
  const resourceIndexing =
    resourceIndexState.sessionId === props.sessionId
      ? resourceIndexState.indexing
      : Boolean(props.sessionId);
  const resourceIndexError =
    resourceIndexState.sessionId === props.sessionId
      ? resourceIndexState.error
      : null;
  const resourceIndexWarning =
    resourceIndexState.sessionId === props.sessionId
      ? resourceIndexState.warning
      : null;
  const resourceIndexValidated =
    resourceIndexState.sessionId === props.sessionId
      ? resourceIndexState.validated
      : false;
  const outputResources = indexedResources.outputs;
  const sourceResources = indexedResources.sources;
  useEffect(() => {
    if (!props.sessionId) {
      setResourceIndexState({
        sessionId: null,
        index: { outputs: [], sources: [] },
        indexing: false,
        validated: true,
        error: null,
        warning: null,
      });
      return;
    }
    const sessionId = props.sessionId;
    const cached = readCachedConversationResourceIndex(sessionId);
    setResourceIndexState({
      sessionId,
      index: cached?.index ?? { outputs: [], sources: [] },
      indexing: !cached?.validated,
      validated: cached?.validated ?? false,
      error: cached?.error ?? null,
      warning: cached?.warning ?? null,
    });
    return subscribeConversationResourceIndex(sessionId, (snapshot) => {
      setResourceIndexState((current) => {
        if (current.sessionId !== sessionId) {
          return current;
        }
        if (!snapshot) {
          return {
            sessionId,
            index: { outputs: [], sources: [] },
            indexing: true,
            validated: false,
            error: null,
            warning: null,
          };
        }
        return {
          sessionId,
          index: snapshot.index,
          indexing: !snapshot.validated,
          validated: snapshot.validated,
          error: snapshot.error ?? null,
          warning: snapshot.warning ?? null,
        };
      });
    });
    // Historical indexing is owned by the session-view preload coordinators
    // for the selected Chat and visible Canvas panes. This component only
    // observes its cache, so opening a tab cannot launch a lower-priority scan
    // ahead of Chat or Changes/Files.
  }, [props.sessionId]);

  const retryResourceIndex = () => {
    if (!props.sessionId) return;
    const sessionId = props.sessionId;
    invalidateCachedConversationResourceIndex(sessionId);
    void loadCachedConversationResourceIndex({
      sessionId,
      dependencies: {
        readIndex: readSessionConversationResourceIndex,
      },
    }).catch(() => undefined);
  };

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

  const loadGitStatus = async (baseBranch?: string) => {
    const requestId = gitStatusRequestRef.current + 1;
    gitStatusRequestRef.current = requestId;
    const sessionId = props.sessionId;
    const workspaceRoot = props.workspaceRoot;
    if (!workspaceRoot) {
      setGitStatus(null);
      setGitStatusError(null);
      setGitStatusLoading(false);
      return;
    }
    setGitStatusLoading(true);
    setGitStatusError(null);
    try {
      const defaultSessionComparison =
        sessionId &&
        (!baseBranch ||
          (gitStatus?.comparisonMode === "uncommitted" &&
            baseBranch === (gitStatus.branch ?? gitStatus.baseBranch)));
      if (defaultSessionComparison) {
        const snapshot = await loadCachedSessionInspectorPrimary({
          sessionId,
          workspaceRoot,
          refresh: true,
        });
        if (gitStatusRequestRef.current !== requestId) {
          return;
        }
        setGitStatus(snapshot.gitStatus);
        setSelectedBaseBranch(snapshot.gitStatus?.baseBranch);
        setGitStatusError(snapshot.gitStatusError);
        return;
      }
      const response = sessionId
        ? await readSessionInspectorGitStatus({
            sessionId,
            workspaceRoot,
            ...(baseBranch ? { baseBranch } : {}),
          })
        : await readWorkspaceGitStatus(workspaceRoot, {
            ...(baseBranch ? { baseBranch } : {}),
          });
      if (gitStatusRequestRef.current !== requestId) {
        return;
      }
      setGitStatus(normalizeInspectorGitStatus(response));
      setSelectedBaseBranch(response.baseBranch);
    } catch (error) {
      if (gitStatusRequestRef.current !== requestId) {
        return;
      }
      setGitStatusError(error instanceof Error ? error.message : String(error));
      setGitStatus(null);
    } finally {
      if (gitStatusRequestRef.current === requestId) {
        setGitStatusLoading(false);
      }
    }
  };

  const loadTurnChanges = useCallback(
    async (target: { sessionId: string; turnId: string }) => {
      const requestId = turnChangesRequestRef.current + 1;
      turnChangesRequestRef.current = requestId;
      setTurnChangesLoading(true);
      setTurnChangesError(null);
      try {
        const response = await readTurnFileChanges(target.sessionId, target.turnId);
        if (turnChangesRequestRef.current !== requestId) {
          return;
        }
        setTurnChanges(response);
      } catch (error) {
        if (turnChangesRequestRef.current !== requestId) {
          return;
        }
        setTurnChanges(null);
        setTurnChangesError(getTurnArtifactErrorMessage(error));
      } finally {
        if (turnChangesRequestRef.current === requestId) {
          setTurnChangesLoading(false);
        }
      }
    },
    [],
  );

  useEffect(() => {
    turnChangesRequestRef.current += 1;
    setSelectedFile(null);
    setChangeScope("workspace");
    setSelectedBaseBranch(undefined);
    setActiveTurnTarget(null);
    setTurnChanges(null);
    setTurnChangesLoading(false);
    setTurnChangesError(null);
    setExpandedPaths(props.workspaceRoot ? new Set([props.workspaceRoot]) : new Set());
    setDirectoryEntriesByPath(new Map());
    setDirectoryErrorsByPath(new Map());
    setDirectoryLoadingPaths(
      props.workspaceRoot ? new Set([props.workspaceRoot]) : new Set(),
    );
    if (!props.sessionId && props.workspaceRoot) {
      void loadDirectory(props.workspaceRoot);
    }
    if (!props.sessionId || !props.workspaceRoot) {
      return;
    }
    const sessionId = props.sessionId;
    const workspaceRoot = props.workspaceRoot;
    const applySnapshot = (snapshot: SessionInspectorPrimarySnapshot) => {
      setGitStatus(snapshot.gitStatus);
      setSelectedBaseBranch(snapshot.gitStatus?.baseBranch);
      setGitStatusError(snapshot.gitStatusError);
      setGitStatusLoading(!snapshot.complete);
      setDirectoryEntriesByPath((current) => {
        const next = new Map(current);
        next.set(workspaceRoot, snapshot.rootEntries);
        return next;
      });
      setDirectoryErrorsByPath((current) => {
        const next = new Map(current);
        if (snapshot.directoryError) {
          next.set(workspaceRoot, snapshot.directoryError);
        } else {
          next.delete(workspaceRoot);
        }
        return next;
      });
      setDirectoryLoadingPaths((current) => {
        const next = new Set(current);
        if (snapshot.complete) {
          next.delete(workspaceRoot);
        } else {
          next.add(workspaceRoot);
        }
        return next;
      });
    };
    const cached = readCachedSessionInspectorPrimary(sessionId, workspaceRoot);
    if (cached) {
      applySnapshot(cached);
    } else {
      setGitStatusLoading(true);
    }
    return subscribeSessionInspectorPrimary(
      sessionId,
      workspaceRoot,
      applySnapshot,
    );
  }, [props.sessionId, props.workspaceRoot]);

  useEffect(() => {
    if (changeScope === "workspace" && !props.sessionId) {
      void loadGitStatus(undefined);
    }
  }, [changeScope, props.sessionId, props.workspaceRoot]);

  useEffect(() => {
    const request = props.openFileRequest;
    if (!request?.path) {
      return;
    }
    if (
      request.kind === "turn_changes" &&
      request.sessionId &&
      request.turnId
    ) {
      const target = {
        sessionId: request.sessionId,
        turnId: request.turnId,
      };
      setActiveTab("changes");
      setChangeScope("turn");
      setActiveTurnTarget(target);
      setSelectedFile({
        path: request.path,
        source: "turn_changes",
        sessionId: request.sessionId,
        turnId: request.turnId,
      });
      void loadTurnChanges(target);
      return;
    }
    setActiveTab("files");
    setSelectedFile({
      path: request.path,
      source: "local",
    });
  }, [loadTurnChanges, props.openFileRequest?.id]);

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
    source: FileDetailSelection["source"],
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
    changeScope === "turn" && activeTurnTarget
      ? turnChanges?.fileChanges.files.length ?? 0
      : gitStatus?.totalBranch ?? gitStatus?.changedFiles.length ?? 0;
  return (
    <div className="h-full flex flex-col">
      <InspectorHeader
        workspaceRoot={props.workspaceRoot}
        activeTab={activeTab}
        changeCount={changeCount}
        outputCount={
          resourceIndexValidated || outputResources.length > 0
            ? outputResources.length
            : null
        }
        sourceCount={
          resourceIndexValidated || sourceResources.length > 0
            ? sourceResources.length
            : null
        }
        onTabChange={setActiveTab}
        {...(props.onOpenTerminal ? { onOpenTerminal: props.onOpenTerminal } : {})}
        {...(props.onClosePanel ? { onClosePanel: props.onClosePanel } : {})}
      />
      <OverlayScrollArea className="min-h-0 flex-1" viewportClassName="h-full px-3 py-2" scrollAriaLabel="Inspector">
        {activeTab === "changes" ? (
          <div className="space-y-3">
            {activeTurnTarget ? (
              <SegmentedControl
                size="compact"
                className="grid w-full grid-cols-2"
                role="tablist"
                ariaLabel="Change scope"
              >
                <SegmentedButton
                  size="compact"
                  selected={changeScope === "turn"}
                  onClick={() => setChangeScope("turn")}
                  role="tab"
                  aria-selected={changeScope === "turn"}
                >
                  <SegmentedButtonLabel size="compact">This turn</SegmentedButtonLabel>
                </SegmentedButton>
                <SegmentedButton
                  size="compact"
                  selected={changeScope === "workspace"}
                  onClick={() => setChangeScope("workspace")}
                  role="tab"
                  aria-selected={changeScope === "workspace"}
                >
                  <SegmentedButtonLabel size="compact">Workspace</SegmentedButtonLabel>
                </SegmentedButton>
              </SegmentedControl>
            ) : null}
            {changeScope === "turn" && activeTurnTarget ? (
              <InspectorTurnChangesPane
                workspaceRoot={props.workspaceRoot}
                response={turnChanges}
                loading={turnChangesLoading}
                error={turnChangesError}
                onRetry={() => void loadTurnChanges(activeTurnTarget)}
                onReview={() => {
                  if (!turnChanges) {
                    return;
                  }
                  openReview({
                    scope: {
                      kind: "turn",
                      sessionId: turnChanges.sessionId,
                      turnId: turnChanges.turnId,
                      workspaceRoot: props.workspaceRoot,
                      files: turnChanges.fileChanges.files,
                      totalAdditions: turnChanges.fileChanges.totalAdditions,
                      totalDeletions: turnChanges.fileChanges.totalDeletions,
                      truncated: turnChanges.truncated,
                    },
                  });
                }}
                onOpenFile={setSelectedFile}
              />
            ) : (
              <InspectorChangesPane
                workspaceRoot={props.workspaceRoot}
                gitStatus={gitStatus}
                loading={gitStatusLoading}
                error={gitStatusError}
                onRefresh={() => void loadGitStatus(selectedBaseBranch)}
                onBaseBranchChange={(baseBranch) => {
                  setSelectedBaseBranch(baseBranch);
                  void loadGitStatus(baseBranch);
                }}
                onOpenFile={(selection) => setSelectedFile(selection)}
              />
            )}
          </div>
        ) : activeTab === "outputs" ? (
          <InspectorResourcesPane
            workspaceRoot={props.workspaceRoot}
            resources={outputResources}
            description="Files and media explicitly generated or delivered by this conversation."
            loading={resourceIndexing}
            error={resourceIndexError}
            warning={resourceIndexWarning}
            emptyLabel="No outputs yet."
            testId="inspector-outputs-list"
            onRetry={retryResourceIndex}
            onOpenFile={(path) =>
              openFile(
                path,
                path.startsWith("/") && !path.startsWith(`${props.workspaceRoot}/`)
                  ? "local"
                  : "files",
              )
            }
            onOpenUrl={(url) => window.open(url, "_blank", "noopener,noreferrer")}
          />
        ) : activeTab === "sources" ? (
          <InspectorResourcesPane
            workspaceRoot={props.workspaceRoot}
            resources={sourceResources}
            description="Attachments, web pages, and external references recorded in provider history. The session does not need to run in RAH."
            loading={resourceIndexing}
            error={resourceIndexError}
            warning={resourceIndexWarning}
            emptyLabel="No attachments, web pages, or external references were recorded for this session."
            testId="inspector-sources-list"
            onRetry={retryResourceIndex}
            onOpenFile={(path) =>
              openFile(
                path,
                path.startsWith("/") && !path.startsWith(`${props.workspaceRoot}/`)
                  ? "local"
                  : "files",
              )
            }
            onOpenUrl={(url) => window.open(url, "_blank", "noopener,noreferrer")}
          />
        ) : (
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
        )}
      </OverlayScrollArea>

      {selectedFile ? (
        <InspectorFileDetailDialog
          sessionId={props.sessionId}
          workspaceRoot={props.workspaceRoot}
          selection={selectedFile}
          onRefreshChanges={() => void loadGitStatus(selectedBaseBranch)}
          onClose={() => setSelectedFile(null)}
        />
      ) : null}
    </div>
  );
}

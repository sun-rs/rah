import { useEffect, useMemo, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { LoaderCircle, X } from "lucide-react";
import { applyGitFileAction, readGitDiff, readSessionFile, readWorkspaceFile, readWorkspaceGitDiff } from "../api";
import type { FileDetailSelection } from "./shared";
import { DiffDisplay, FileContentDisplay } from "./InspectorPreviewDisplays";
import {
  buildDiffRows,
  getChangeScopeLabel,
  getChangedFileStatusLabel,
  getChangedFileStatusTone,
  getDisplayPath,
  readDiffPreferences,
  summarizeDiffRows,
} from "./shared";

export function InspectorFileDetailDialog(props: {
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
  const [displayMode, setDisplayMode] = useState<"file" | "diff">(
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
      "rah.inspector-diff-preferences",
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
        if (!cancelled) {
          setDiffContent(response.diff);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setDiffError(error instanceof Error ? error.message : String(error));
        }
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
        if (!cancelled) {
          setFileContent(response.content);
          setBinary(response.binary);
          setTruncated(Boolean(response.truncated));
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setFileError(error instanceof Error ? error.message : String(error));
        }
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
  const shouldShowFileTab = props.selection.source === "files" || !diffSummary.isPureAddition;
  const displayPath = getDisplayPath(props.selection.path, props.workspaceRoot);
  const fileName = props.selection.path.split("/").pop() || props.selection.path;
  const selectionScopeLabel = getChangeScopeLabel(props.selection.staged);
  const isBinaryChange = props.selection.source === "changes" && props.selection.binary === true;
  const showDiffUnavailable = isBinaryChange && !hasDiff && !diffLoading && !diffError;
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
                <DiffDisplay rows={diffRows} path={props.selection.path} wrapLines={wrapLines} />
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
              <div className="text-sm text-[var(--app-hint)]">This file looks binary and cannot be previewed.</div>
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

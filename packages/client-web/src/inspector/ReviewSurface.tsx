import { useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronUp,
  FileDiff,
  LoaderCircle,
  Search,
  Space,
  WrapText,
} from "lucide-react";
import { FileResourceIcon } from "../components/chat/FileResourceIcon";
import {
  SegmentedButton,
  SegmentedButtonLabel,
  SegmentedControl,
} from "../components/SegmentedControl";
import {
  readGitDiff,
  readTurnFileDiff,
  readWorkspaceGitDiff,
} from "../api";
import { DiffDisplay } from "./InspectorPreviewDisplays";
import {
  buildDiffRows,
  getDisplayPath,
  getTurnArtifactErrorMessage,
  readDiffPreferences,
  type DiffLayout,
  writeDiffPreferences,
} from "./shared";
import {
  buildReviewDiffRequest,
  normalizeReviewFiles,
  reviewScopeContentIdentity,
  reviewScopeIdentity,
  type ReviewDiffRequest,
  type ReviewScope,
} from "./review-contract";

export type { ReviewScope } from "./review-contract";

function readReviewDiff(request: ReviewDiffRequest) {
  switch (request.kind) {
    case "turn":
      return readTurnFileDiff(
        request.sessionId,
        request.turnId,
        request.path,
      );
    case "session-workspace":
      return readGitDiff(request.sessionId, request.path, {
        staged: request.staged,
        ignoreWhitespace: request.ignoreWhitespace,
        ...(request.scopeRoot ? { scopeRoot: request.scopeRoot } : {}),
      });
    case "workspace":
      return readWorkspaceGitDiff(request.workspaceRoot, request.path, {
        staged: request.staged,
        ignoreWhitespace: request.ignoreWhitespace,
      });
  }
}

function useSemanticallyStableValue<T>(value: T, identity: string): T {
  const stable = useRef({ identity, value });
  if (stable.current.identity !== identity) {
    stable.current = { identity, value };
  }
  return stable.current.value;
}

export function ReviewSurface(props: { scope: ReviewScope; initialPath?: string }) {
  const [query, setQuery] = useState("");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [diffContent, setDiffContent] = useState("");
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [diffTruncated, setDiffTruncated] = useState(false);
  const [mobileFilesOpen, setMobileFilesOpen] = useState(false);
  const [wrapLines, setWrapLines] = useState(
    () => readDiffPreferences().wrapLines,
  );
  const [hideWhitespace, setHideWhitespace] = useState(
    () => readDiffPreferences().hideWhitespace,
  );
  const [diffLayout, setDiffLayout] = useState<DiffLayout>(
    () => readDiffPreferences().diffLayout,
  );
  const contentIdentity = reviewScopeContentIdentity(props.scope);
  const scope = useSemanticallyStableValue(props.scope, contentIdentity);
  const identity = reviewScopeIdentity(scope);
  const files = useMemo(
    () => normalizeReviewFiles(scope),
    [scope],
  );
  const filteredFiles = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    return normalizedQuery
      ? files.filter((file) =>
          file.path.toLocaleLowerCase().includes(normalizedQuery),
        )
      : files;
  }, [files, query]);
  const selectedFile =
    files.find((file) => file.key === selectedKey) ?? files[0] ?? null;
  const diffRows = useMemo(() => buildDiffRows(diffContent), [diffContent]);
  const totals = useMemo(
    () =>
      scope.kind === "turn"
        ? {
            additions: scope.totalAdditions,
            deletions: scope.totalDeletions,
          }
        : files.reduce(
            (current, file) => ({
              additions: current.additions + file.additions,
              deletions: current.deletions + file.deletions,
            }),
            { additions: 0, deletions: 0 },
          ),
    [files, scope],
  );

  useEffect(() => {
    setQuery("");
    setMobileFilesOpen(false);
    setSelectedKey(
      props.initialPath
        ? files.find((file) => file.path === props.initialPath)?.key ?? null
        : null,
    );
  }, [files, identity, props.initialPath]);

  useEffect(() => {
    setSelectedKey((current) =>
      current && files.some((file) => file.key === current)
        ? current
        : files[0]?.key ?? null,
    );
  }, [files]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    writeDiffPreferences({ wrapLines, hideWhitespace, diffLayout });
  }, [diffLayout, hideWhitespace, wrapLines]);

  useEffect(() => {
    let cancelled = false;
    if (!selectedFile) {
      setDiffContent("");
      setDiffError(null);
      setDiffLoading(false);
      setDiffTruncated(false);
      return () => {
        cancelled = true;
      };
    }

    setDiffContent("");
    setDiffError(null);
    setDiffLoading(true);
    setDiffTruncated(false);

    const request = readReviewDiff(
      buildReviewDiffRequest(scope, selectedFile, hideWhitespace),
    );

    void request
      .then((response) => {
        if (cancelled) {
          return;
        }
        setDiffContent(response.diff);
        setDiffTruncated(
          scope.kind === "turn" &&
            "truncated" in response &&
            response.truncated === true,
        );
      })
      .catch((error: unknown) => {
        if (cancelled) {
          return;
        }
        setDiffError(
          scope.kind === "turn"
            ? getTurnArtifactErrorMessage(error)
            : error instanceof Error
              ? error.message
              : String(error),
        );
      })
      .finally(() => {
        if (!cancelled) {
          setDiffLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [hideWhitespace, scope, selectedFile]);

  return (
    <div
      className="flex min-h-0 flex-1 flex-col"
      data-testid="review-surface"
    >
      <div className="flex min-h-11 shrink-0 flex-wrap items-center gap-2 border-b border-[var(--app-border)] px-3 py-2">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <FileDiff size={15} className="shrink-0 text-[var(--app-hint)]" />
          <span className="text-sm font-medium text-[var(--app-fg)]">
            {files.length} {files.length === 1 ? "file" : "files"}
          </span>
          <span className="text-xs font-medium text-[var(--app-success)]">
            +{totals.additions}
          </span>
          <span className="text-xs font-medium text-[var(--app-danger)]">
            -{totals.deletions}
          </span>
          {scope.kind === "turn" && scope.truncated ? (
            <span className="truncate text-xs text-[var(--app-warning)]">
              Stored snapshot is truncated
            </span>
          ) : null}
        </div>
        <SegmentedControl
          size="compact"
          className="flex w-[9rem] shrink-0 gap-1"
          role="group"
          ariaLabel="Diff layout"
        >
          <SegmentedButton
            size="compact"
            selected={diffLayout === "unified"}
            onClick={() => setDiffLayout("unified")}
            className="flex-1"
            aria-pressed={diffLayout === "unified"}
          >
            <SegmentedButtonLabel size="compact">Unified</SegmentedButtonLabel>
          </SegmentedButton>
          <SegmentedButton
            size="compact"
            selected={diffLayout === "split"}
            onClick={() => setDiffLayout("split")}
            className="flex-1"
            aria-pressed={diffLayout === "split"}
          >
            <SegmentedButtonLabel size="compact">Split</SegmentedButtonLabel>
          </SegmentedButton>
        </SegmentedControl>
        <button
          type="button"
          className={`icon-click-feedback inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-xs transition-colors ${
            wrapLines
              ? "bg-[var(--app-selected-bg)] text-[var(--app-selected-fg)]"
              : "text-[var(--app-hint)] hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)]"
          }`}
          aria-pressed={wrapLines}
          onClick={() => setWrapLines((current) => !current)}
          title="Wrap diff lines"
        >
          <WrapText size={14} />
          Wrap
        </button>
        {scope.kind === "workspace" ? (
          <button
            type="button"
            className={`icon-click-feedback inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-xs transition-colors ${
              hideWhitespace
                ? "bg-[var(--app-selected-bg)] text-[var(--app-selected-fg)]"
                : "text-[var(--app-hint)] hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)]"
            }`}
            aria-pressed={hideWhitespace}
            onClick={() => setHideWhitespace((current) => !current)}
            title="Ignore whitespace changes"
          >
            <Space size={14} />
            Whitespace
          </button>
        ) : null}
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_19rem] max-md:grid-cols-1 max-md:grid-rows-[auto_minmax(0,1fr)]">
        <div className="flex min-h-0 flex-col overflow-hidden p-3 max-md:order-2">
          {!selectedFile ? (
            <div className="flex h-full min-h-40 items-center justify-center text-sm text-[var(--app-hint)]">
              No changes to review.
            </div>
          ) : diffLoading ? (
            <div className="flex h-full min-h-40 items-center justify-center gap-2 text-sm text-[var(--app-hint)]">
              <LoaderCircle size={15} className="animate-spin" />
              Loading diff…
            </div>
          ) : diffError ? (
            <div className="rounded-md bg-[var(--app-warning-bg)] px-3 py-2 text-sm text-[var(--app-hint)]">
              {diffError}
            </div>
          ) : selectedFile.binary ? (
            <div className="flex h-full min-h-40 items-center justify-center text-sm text-[var(--app-hint)]">
              Binary changes cannot be rendered as text.
            </div>
          ) : diffRows.length === 0 ? (
            <div className="flex h-full min-h-40 items-center justify-center text-sm text-[var(--app-hint)]">
              No textual diff is available for this file.
            </div>
          ) : (
            <div className="flex h-full min-h-0 flex-col gap-2">
              {diffTruncated ? (
                <div className="rounded-md bg-[var(--app-warning-bg)] px-3 py-2 text-xs text-[var(--app-hint)]">
                  This frozen file diff exceeded the stored limit.
                </div>
              ) : null}
              <DiffDisplay
                rows={diffRows}
                path={selectedFile.path}
                wrapLines={wrapLines}
                layout={diffLayout}
                fillAvailable
              />
            </div>
          )}
        </div>

        <button
          type="button"
          className="hidden min-h-11 w-full min-w-0 items-center gap-2 border-b border-[var(--app-border)] bg-[var(--app-subtle-bg)] px-3 text-left max-md:flex"
          aria-expanded={mobileFilesOpen}
          aria-controls="review-mobile-file-list"
          onClick={() => setMobileFilesOpen((current) => !current)}
        >
          <FileResourceIcon
            path={selectedFile?.path ?? ""}
            size={15}
            className="shrink-0 text-[var(--app-hint)]"
          />
          <span className="min-w-0 flex-1 truncate text-xs text-[var(--app-fg)]">
            {selectedFile
              ? getDisplayPath(selectedFile.path, scope.workspaceRoot)
              : "Choose a changed file"}
          </span>
          <span className="shrink-0 text-[11px] text-[var(--app-hint)]">
            {files.length} {files.length === 1 ? "file" : "files"}
          </span>
          {mobileFilesOpen ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
        </button>
        <aside
          id="review-mobile-file-list"
          className={`flex min-h-0 flex-col border-l border-[var(--app-border)] bg-[var(--app-subtle-bg)] max-md:order-1 max-md:max-h-52 max-md:border-b max-md:border-l-0 ${
            mobileFilesOpen ? "max-md:flex" : "max-md:hidden"
          }`}
        >
          <label className="relative m-2 block shrink-0">
            <Search
              size={14}
              className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--app-hint)]"
            />
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.currentTarget.value)}
              className="h-8 w-full rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] pl-8 pr-2 text-xs text-[var(--app-fg)] outline-none focus:border-[var(--app-focus)]"
              placeholder="Filter files…"
              aria-label="Filter review files"
            />
          </label>
          <div className="min-h-0 flex-1 overflow-auto px-1.5 pb-2">
            {filteredFiles.map((file) => (
              <button
                key={file.key}
                type="button"
                onClick={() => {
                  setSelectedKey(file.key);
                  setMobileFilesOpen(false);
                }}
                className={`flex min-h-9 w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors ${
                  file.key === selectedFile?.key
                    ? "bg-[var(--app-selected-bg)] text-[var(--app-selected-fg)]"
                    : "text-[var(--app-fg)] hover:bg-[var(--app-bg)]"
                }`}
                title={file.path}
              >
                <FileResourceIcon path={file.path} size={15} className="shrink-0 text-[var(--app-hint)]" />
                <span className="min-w-0 flex-1 truncate text-xs">
                  {getDisplayPath(file.path, scope.workspaceRoot)}
                </span>
                <span className="shrink-0 text-[10px] font-medium text-[var(--app-success)]">
                  +{file.additions}
                </span>
                <span className="shrink-0 text-[10px] font-medium text-[var(--app-danger)]">
                  -{file.deletions}
                </span>
                {file.staged !== null ? (
                  <span className="shrink-0 text-[9px] uppercase text-[var(--app-hint)]">
                    {file.staged ? "S" : "U"}
                  </span>
                ) : null}
              </button>
            ))}
            {filteredFiles.length === 0 ? (
              <div className="px-2 py-4 text-center text-xs text-[var(--app-hint)]">
                No matching files.
              </div>
            ) : null}
          </div>
        </aside>
      </div>
    </div>
  );
}

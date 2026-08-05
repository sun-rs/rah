import { useMemo, useState } from "react";
import type { GitBranchChangedFile } from "@rah/runtime-protocol";
import { ChevronDown, GitBranch, LoaderCircle, RefreshCcw } from "lucide-react";
import { InspectorChangeTree, type InspectorChangeTreeFile } from "./InspectorChangeTree";
import { InspectorFileFilter } from "./InspectorFileFilter";
import type { FileDetailSelection, InspectorGitStatus } from "./shared";
import {
  getChangedFileStatusLabel,
  getChangedFileStatusTone,
  INSPECTOR_TOOLBAR_ICON_BUTTON_CLASS,
} from "./shared";

const COMPARISON_LABEL_CLASS =
  "block h-[15px] select-none font-sans text-[10px] font-[var(--app-font-weight)] uppercase leading-[15px] tracking-[0.025em] text-[var(--app-hint)]";

const COMPARISON_VALUE_TEXT_CLASS =
  "font-sans text-sm font-[var(--app-font-weight)] leading-[18px] text-[var(--app-fg)]";

function toTreeFile(
  file: GitBranchChangedFile,
  baselineBranch: string | undefined,
  comparisonMode: InspectorGitStatus["comparisonMode"],
  baselineIsCurrent: boolean,
  onOpenFile: (selection: FileDetailSelection) => void,
): InspectorChangeTreeFile {
  return {
    id: `worktree:${baselineBranch ?? "HEAD"}:${file.path}`,
    path: file.path,
    additions: file.added,
    deletions: file.removed,
    statusLabel: getChangedFileStatusLabel(file.status),
    statusTone: getChangedFileStatusTone(file.status),
    ...(file.binary !== undefined ? { binary: file.binary } : {}),
    ...(file.oldPath !== undefined ? { oldPath: file.oldPath } : {}),
    onOpen: () =>
      onOpenFile({
        path: file.path,
        source: "changes",
        ...(baselineBranch ? { baseBranch: baselineBranch } : {}),
        ...(comparisonMode ? { comparisonMode } : {}),
        ...(baselineIsCurrent ? { baselineIsCurrent: true } : {}),
        pureAddition: file.status === "added" || file.status === "untracked",
        status: file.status,
        ...(file.binary !== undefined ? { binary: file.binary } : {}),
        ...(file.oldPath !== undefined ? { oldPath: file.oldPath } : {}),
      }),
  };
}

export function InspectorChangesPane(props: {
  workspaceRoot: string;
  gitStatus: InspectorGitStatus | null;
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
  onBaseBranchChange: (baseBranch: string) => void;
  onOpenFile: (selection: FileDetailSelection) => void;
}) {
  const [query, setQuery] = useState("");
  const files = props.gitStatus?.branchFiles ?? [];
  const branchOptions = props.gitStatus?.branchOptions ?? [];
  const changeCount = props.gitStatus?.totalBranch ?? files.length;
  const baselineBranch = props.gitStatus?.baseBranch ?? props.gitStatus?.branch;
  const hasGitRepository = Boolean(
    props.gitStatus?.branch ||
      props.gitStatus?.baseBranch ||
      props.gitStatus?.comparisonMode ||
      branchOptions.length,
  );
  const isCurrentBranch =
    Boolean(baselineBranch) && baselineBranch === props.gitStatus?.branch;
  const comparisonMode = props.gitStatus?.comparisonMode;
  const isUncommitted = comparisonMode === "uncommitted" || isCurrentBranch;
  const showBaselineSelector = Boolean(baselineBranch && branchOptions.length);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const matchingFiles = useMemo(
    () => files.filter((file) => file.path.toLocaleLowerCase().includes(normalizedQuery)),
    [files, normalizedQuery],
  );
  const treeFiles = useMemo(
    () =>
      matchingFiles.map((file) =>
        toTreeFile(
          file,
          baselineBranch,
          comparisonMode,
          isUncommitted,
          props.onOpenFile,
        ),
      ),
    [baselineBranch, comparisonMode, isUncommitted, matchingFiles, props.onOpenFile],
  );

  const scopeDescription = !hasGitRepository
    ? "Git changes are unavailable at this workspace root"
    : isUncommitted
      ? "Staged, unstaged, and untracked files"
      : comparisonMode === "merge_base"
        ? `Committed since the shared ancestor with ${baselineBranch}, plus local changes`
        : baselineBranch
          ? `Current workspace snapshot compared directly with ${baselineBranch}`
          : "Current workspace snapshot";

  return (
    <div className="space-y-2">
      <div className="space-y-1.5">
        <div
          className={`grid min-w-0 gap-x-3 gap-y-0.5 ${
            showBaselineSelector
              ? "grid-cols-[minmax(0,5fr)_minmax(0,7fr)]"
              : "grid-cols-1"
          }`}
        >
          <span className={COMPARISON_LABEL_CLASS}>Current workspace</span>
          {showBaselineSelector ? (
            <span className={COMPARISON_LABEL_CLASS}>Against</span>
          ) : null}
          <div
            className={`flex h-7 min-w-0 items-center gap-1.5 ${COMPARISON_VALUE_TEXT_CLASS}`}
            title={
              hasGitRepository
                ? `Current branch: ${props.gitStatus?.branch ?? "detached HEAD"}`
                : "No Git repository at this workspace root"
            }
          >
            <GitBranch size={14} className="shrink-0" />
            <span className="truncate">
              {hasGitRepository
                ? (props.gitStatus?.branch ?? "detached HEAD")
                : "No Git repository"}
            </span>
          </div>
          {showBaselineSelector && baselineBranch ? (
            <div className="relative min-w-0">
              <select
                aria-label="Against branch"
                value={baselineBranch}
                onChange={(event) => props.onBaseBranchChange(event.target.value)}
                disabled={props.loading}
                title={
                  isUncommitted
                    ? "Use the current branch HEAD: show only uncommitted changes"
                    : `Show changes since the shared ancestor with ${baselineBranch}`
                }
                className={`h-7 w-full cursor-pointer appearance-none truncate rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] py-1 pl-2 pr-6 outline-none transition-colors hover:bg-[var(--app-hover)] focus-visible:ring-2 focus-visible:ring-[var(--app-accent)] disabled:cursor-wait ${COMPARISON_VALUE_TEXT_CLASS}`}
              >
                {branchOptions.map((branch) => (
                  <option key={branch} value={branch}>
                    {branch === props.gitStatus?.branch
                      ? "HEAD · uncommitted changes"
                      : branch}
                  </option>
                ))}
              </select>
              <ChevronDown
                size={13}
                aria-hidden="true"
                className="pointer-events-none absolute right-1 top-1/2 -translate-y-1/2 text-[var(--app-hint)]"
              />
            </div>
          ) : null}
        </div>
        {props.gitStatus ? (
          <div className="truncate text-[10px] text-[var(--app-hint)]" title={scopeDescription}>
            {scopeDescription}
          </div>
        ) : null}
      </div>

      <InspectorFileFilter
        value={query}
        onChange={setQuery}
        placeholder="Filter changed files…"
        ariaLabel="Filter changed files"
        actions={
          <button
            type="button"
            onClick={props.onRefresh}
            className={INSPECTOR_TOOLBAR_ICON_BUTTON_CLASS}
            title="Refresh changes"
            aria-label="Refresh changes"
          >
            <RefreshCcw size={14} />
          </button>
        }
      />

      {props.loading ? (
        <div className="flex items-center gap-2 text-sm text-[var(--app-hint)]">
          <LoaderCircle size={14} className="animate-spin" />
          Loading changes…
        </div>
      ) : props.error ? (
        <div className="rounded-lg border border-[var(--app-border)] bg-[var(--app-warning-bg)] p-3 text-xs text-[var(--app-hint)]">
          {props.error}
        </div>
      ) : !hasGitRepository ? (
        <div className="py-3 text-sm text-[var(--app-hint)]">
          No Git repository at this workspace root.
        </div>
      ) : changeCount === 0 ? (
        <div className="py-3 text-sm text-[var(--app-hint)]">
          {isUncommitted
            ? "No uncommitted changes."
            : `No changes since diverging from ${baselineBranch ?? "the selected branch"}.`}
        </div>
      ) : matchingFiles.length === 0 ? (
        <div className="py-3 text-sm text-[var(--app-hint)]">No changed files match your filter.</div>
      ) : (
        <section>
          <InspectorChangeTree
            key={`${props.workspaceRoot}:${baselineBranch ?? "HEAD"}:${comparisonMode ?? "uncommitted"}`}
            files={treeFiles}
            workspaceRoot={props.workspaceRoot}
            query={query}
            defaultExpanded
            heading={
              isUncommitted
              ? `Uncommitted changes (${matchingFiles.length})`
              : comparisonMode === "merge_base"
                ? `Since diverging from ${baselineBranch ?? "selected branch"} (${matchingFiles.length})`
                : `Snapshot differences from ${baselineBranch ?? "selected branch"} (${matchingFiles.length})`
            }
          />
        </section>
      )}
    </div>
  );
}

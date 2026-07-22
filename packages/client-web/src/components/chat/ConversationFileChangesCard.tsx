import type { ConversationTurnFileChangesProjection } from "@rah/runtime-protocol";
import { ChevronDown, FilePlus2, ScanSearch } from "lucide-react";
import { useState } from "react";

const INITIAL_VISIBLE_FILE_COUNT = 3;
const FILE_REVEAL_BATCH = 50;

function splitFilePath(path: string): { directory: string; basename: string } {
  const separator = path.lastIndexOf("/");
  return separator < 0
    ? { directory: "", basename: path }
    : {
        directory: path.slice(0, separator + 1),
        basename: path.slice(separator + 1),
      };
}

export function ConversationFileChangesCard(props: {
  fileChanges: ConversationTurnFileChangesProjection;
  onOpenFile?: (path: string) => void;
  onReview?: () => void;
}) {
  const [visibleCount, setVisibleCount] = useState(INITIAL_VISIBLE_FILE_COUNT);
  const fileCount = props.fileChanges.files.length;
  const visibleFiles = props.fileChanges.files.slice(0, visibleCount);
  const remainingCount = Math.max(0, fileCount - visibleFiles.length);
  const expanded = visibleCount > INITIAL_VISIBLE_FILE_COUNT;

  return (
    <div
      className="overflow-hidden rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)]"
      data-testid="conversation-turn-file-changes"
    >
      <div className="flex min-h-11 min-w-0 items-center gap-2.5 px-3 py-1.5">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-[var(--app-subtle-bg)] text-[var(--app-hint)]">
          <FilePlus2 size={16} />
        </div>
        <div className="flex min-w-0 flex-1 items-center gap-2.5">
          <div className="shrink-0 text-[13px] font-medium text-[var(--app-fg)]">
            Changed {fileCount} {fileCount === 1 ? "file" : "files"}
          </div>
          <div className="flex min-w-0 items-center gap-1.5 text-[11px] font-medium">
            <span className="text-[var(--app-success)]">
              +{props.fileChanges.totalAdditions}
            </span>
            <span className="text-[var(--app-danger)]">
              -{props.fileChanges.totalDeletions}
            </span>
          </div>
        </div>
        {props.onReview ? (
          <button
            type="button"
            className="icon-click-feedback inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-[var(--app-hint)] transition-colors hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)]"
            onClick={props.onReview}
            aria-label="Review this turn"
            title="Review this turn"
          >
            <ScanSearch size={15} />
          </button>
        ) : null}
      </div>
      <div className="divide-y divide-[var(--app-border)] border-t border-[var(--app-border)]">
        {visibleFiles.map((file) => {
          const { directory, basename } = splitFilePath(file.path);
          const content = (
            <>
              <span className="min-w-0 flex-1 truncate text-sm">
                {directory ? (
                  <span className="text-[var(--app-muted)]">{directory}</span>
                ) : null}
                <span className="text-[var(--app-fg)]">{basename}</span>
              </span>
              <span className="shrink-0 text-sm font-medium text-[var(--app-success)]">
                +{file.additions}
              </span>
              <span className="shrink-0 text-sm font-medium text-[var(--app-danger)]">
                -{file.deletions}
              </span>
            </>
          );
          return props.onOpenFile ? (
            <button
              key={file.path}
              type="button"
              className="flex min-h-9 w-full min-w-0 items-center gap-2 px-3 py-1.5 text-left transition-colors hover:bg-[var(--app-subtle-bg)] focus-visible:bg-[var(--app-subtle-bg)]"
              title={`Open ${file.path}`}
              onClick={() => props.onOpenFile?.(file.path)}
            >
              {content}
            </button>
          ) : (
            <div
              key={file.path}
              className="flex min-h-9 min-w-0 items-center gap-2 px-3 py-1.5"
              title={file.path}
            >
              {content}
            </div>
          );
        })}
        {remainingCount > 0 ? (
          <button
            type="button"
            className="flex min-h-9 w-full items-center gap-1.5 px-3 py-1.5 text-left text-[11px] font-medium text-[var(--app-muted)] transition-colors hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)]"
            aria-expanded={expanded}
            onClick={() =>
              setVisibleCount((current) =>
                Math.min(fileCount, current + FILE_REVEAL_BATCH),
              )
            }
          >
            {remainingCount <= FILE_REVEAL_BATCH
              ? `Show ${remainingCount} more`
              : `Show next ${FILE_REVEAL_BATCH} · ${remainingCount} remaining`}
            <ChevronDown size={13} />
          </button>
        ) : expanded ? (
          <button
            type="button"
            className="flex min-h-9 w-full items-center gap-1.5 px-3 py-1.5 text-left text-[11px] font-medium text-[var(--app-muted)] transition-colors hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)]"
            aria-expanded={expanded}
            onClick={() => setVisibleCount(INITIAL_VISIBLE_FILE_COUNT)}
          >
            Collapse files
            <ChevronDown size={13} className="rotate-180" />
          </button>
        ) : null}
      </div>
    </div>
  );
}

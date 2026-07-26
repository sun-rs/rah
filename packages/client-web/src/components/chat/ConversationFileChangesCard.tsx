import type { ConversationTurnFileChangesProjection } from "@rah/runtime-protocol";
import { ChevronDown } from "lucide-react";
import { useState } from "react";
import { CodexChangedFilesIcon } from "./codex-file-icon-assets";

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

function ChangeCounts(props: { additions: number; deletions: number }) {
  return (
    <div className="inline-flex shrink-0 items-center gap-1.5 text-sm font-medium tabular-nums">
      <span className="text-[var(--app-success)]">
        +{props.additions}
      </span>
      <span className="text-[var(--app-danger)]">
        -{props.deletions}
      </span>
    </div>
  );
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
      className="overflow-hidden rounded-lg border border-[var(--turn-resource-border)] bg-[var(--app-bg)]"
      data-testid="conversation-turn-file-changes"
    >
      <div className="flex min-h-11 min-w-0 items-center gap-2 border-b border-[var(--turn-resource-border)] px-3 py-1.5">
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-[var(--app-subtle-bg)] text-[var(--app-hint)]">
          <CodexChangedFilesIcon className="h-5 w-5" />
        </div>
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <div className="min-w-0 truncate text-sm font-medium text-[var(--app-fg)]">
            Changed {fileCount} {fileCount === 1 ? "file" : "files"}
          </div>
          <ChangeCounts
            additions={props.fileChanges.totalAdditions}
            deletions={props.fileChanges.totalDeletions}
          />
        </div>
        {props.onReview ? (
          <button
            type="button"
            className="icon-click-feedback inline-flex h-7 shrink-0 items-center justify-center rounded-md border border-[var(--app-border)] bg-transparent px-2.5 text-sm font-medium text-[var(--app-muted)] transition-colors hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)] focus-visible:bg-[var(--app-subtle-bg)] focus-visible:text-[var(--app-fg)] active:bg-[var(--app-border)] active:text-[var(--app-fg)]"
            onClick={props.onReview}
            aria-label="审查本轮变动"
            title="审查本轮变动"
          >
            审查
          </button>
        ) : null}
      </div>
      <div className="pb-1">
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
              <ChangeCounts
                additions={file.additions}
                deletions={file.deletions}
              />
            </>
          );
          return props.onOpenFile ? (
            <button
              key={file.path}
              type="button"
              className="flex min-h-8 w-full min-w-0 items-center gap-2 px-3 py-1 text-left transition-colors hover:bg-[var(--app-subtle-bg)] focus-visible:bg-[var(--app-subtle-bg)]"
              title={`Open ${file.path}`}
              onClick={() => props.onOpenFile?.(file.path)}
            >
              {content}
            </button>
          ) : (
            <div
              key={file.path}
              className="flex min-h-8 min-w-0 items-center gap-2 px-3 py-1"
              title={file.path}
            >
              {content}
            </div>
          );
        })}
        {remainingCount > 0 ? (
          <button
            type="button"
            className="flex min-h-8 w-full items-center gap-2 px-3 py-1 text-left text-sm font-medium text-[var(--app-muted)] transition-colors hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)]"
            aria-expanded={expanded}
            onClick={() =>
              setVisibleCount((current) =>
                Math.min(fileCount, current + FILE_REVEAL_BATCH),
              )
            }
            data-testid="conversation-turn-file-changes-footer"
          >
            <span className="flex min-w-0 flex-1 items-center gap-1.5">
              {remainingCount <= FILE_REVEAL_BATCH
                ? `Show ${remainingCount} more`
                : `Show next ${FILE_REVEAL_BATCH} · ${remainingCount} remaining`}
              <ChevronDown size={13} />
            </span>
          </button>
        ) : expanded ? (
          <button
            type="button"
            className="flex min-h-8 w-full items-center gap-2 px-3 py-1 text-left text-sm font-medium text-[var(--app-muted)] transition-colors hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)]"
            aria-expanded={expanded}
            onClick={() => setVisibleCount(INITIAL_VISIBLE_FILE_COUNT)}
            data-testid="conversation-turn-file-changes-footer"
          >
            <span className="flex min-w-0 flex-1 items-center gap-1.5">
              Collapse files
              <ChevronDown size={13} className="rotate-180" />
            </span>
          </button>
        ) : null}
      </div>
    </div>
  );
}

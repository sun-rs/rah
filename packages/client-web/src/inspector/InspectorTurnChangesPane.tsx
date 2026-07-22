import { useMemo, useState } from "react";
import type { TurnFileChangesResponse } from "@rah/runtime-protocol";
import { LoaderCircle, ScanSearch } from "lucide-react";
import { InspectorChangeTree, type InspectorChangeTreeFile } from "./InspectorChangeTree";
import { InspectorFileFilter } from "./InspectorFileFilter";
import type { FileDetailSelection } from "./shared";
import { INSPECTOR_TOOLBAR_ICON_BUTTON_CLASS } from "./shared";

export function InspectorTurnChangesPane(props: {
  workspaceRoot: string;
  response: TurnFileChangesResponse | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  onReview?: () => void;
  onOpenFile: (selection: FileDetailSelection) => void;
}) {
  const [query, setQuery] = useState("");
  const response = props.response;
  const treeFiles = useMemo<InspectorChangeTreeFile[]>(
    () =>
      response?.fileChanges.files.map((file) => ({
        id: `turn:${response.turnId}:${file.path}`,
        path: file.path,
        additions: file.additions,
        deletions: file.deletions,
        onOpen: () =>
          props.onOpenFile({
            path: file.path,
            source: "turn_changes",
            sessionId: response.sessionId,
            turnId: response.turnId,
          }),
      })) ?? [],
    [props.onOpenFile, response],
  );

  if (props.loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-[var(--app-hint)]">
        <LoaderCircle size={14} className="animate-spin" />
        Loading this turn…
      </div>
    );
  }

  if (props.error) {
    return (
      <div className="space-y-2">
        <div className="rounded-lg border border-[var(--app-border)] bg-[var(--app-warning-bg)] p-3 text-xs text-[var(--app-hint)]">
          {props.error}
        </div>
        <button type="button" className="text-xs font-medium text-[var(--app-fg)]" onClick={props.onRetry}>
          Retry
        </button>
      </div>
    );
  }

  if (!response) {
    return (
      <div className="text-sm text-[var(--app-hint)]">
        Open a completed turn’s file list to inspect its frozen changes.
      </div>
    );
  }

  const files = response.fileChanges.files;

  return (
    <div className="space-y-2" data-testid="inspector-turn-changes">
      <div className="flex min-w-0 items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-sm font-medium text-[var(--app-fg)]">
            Changed {files.length} {files.length === 1 ? "file" : "files"}
          </div>
          <div className="mt-0.5 flex items-center gap-2 text-xs text-[var(--app-hint)]">
            <span className="font-medium text-[var(--diff-add-text)]">
              +{response.fileChanges.totalAdditions}
            </span>
            <span className="font-medium text-[var(--diff-remove-text)]">
              -{response.fileChanges.totalDeletions}
            </span>
            <span title={response.capturedAt}>
              Frozen at {new Date(response.capturedAt).toLocaleTimeString()}
            </span>
          </div>
        </div>
      </div>

      {files.length > 0 ? (
        <InspectorFileFilter
          value={query}
          onChange={setQuery}
          placeholder="Filter changed files…"
          ariaLabel="Filter this turn's changed files"
          actions={
            props.onReview ? (
              <button
                type="button"
                className={INSPECTOR_TOOLBAR_ICON_BUTTON_CLASS}
                onClick={props.onReview}
                title="Review this turn"
                aria-label="Review this turn"
              >
                <ScanSearch size={14} />
              </button>
            ) : null
          }
        />
      ) : null}

      {response.truncated ? (
        <div className="rounded-md bg-[var(--app-warning-bg)] px-2.5 py-2 text-xs text-[var(--app-hint)]">
          This turn exceeded the stored diff limit. Available files remain inspectable.
        </div>
      ) : null}

      {files.length === 0 ? (
        <div className="text-sm text-[var(--app-hint)]">No file changes in this turn.</div>
      ) : (
        <InspectorChangeTree
          files={treeFiles}
          workspaceRoot={props.workspaceRoot}
          query={query}
          emptyLabel="No changed files match your filter."
        />
      )}
    </div>
  );
}

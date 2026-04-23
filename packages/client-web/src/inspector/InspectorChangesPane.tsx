import type { RahEvent } from "@rah/runtime-protocol";
import { FileText, GitBranch, LoaderCircle, RefreshCcw } from "lucide-react";
import type { FileDetailSelection, InspectorGitStatus } from "./shared";
import {
  getChangedFileStatusLabel,
  getChangedFileStatusTone,
  isFileChangeObservation,
} from "./shared";

function ChangesFromEvents(props: { events: RahEvent[] }) {
  const items = props.events.filter(isFileChangeObservation);

  if (items.length === 0) {
    return null;
  }

  return (
    <div className="space-y-3">
      {items.map((change, index) => {
        const obs = (change.payload as {
          observation?: { title?: string; description?: string; path?: string; kind?: string };
        }).observation;
        return (
          <div
            key={`${change.seq}-${index}`}
            className="rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] p-3"
          >
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0 truncate text-sm font-medium text-[var(--app-fg)]">
                {obs?.path ?? obs?.title ?? "Change"}
              </div>
              <div className="shrink-0 rounded border border-[var(--app-border)] bg-[var(--app-subtle-bg)] px-1.5 py-0.5 text-[11px] text-[var(--app-hint)]">
                {obs?.kind ?? "file-change"}
              </div>
            </div>
            {obs?.description ? (
              <div className="mt-1 text-xs text-[var(--app-hint)]">{obs.description}</div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

export function InspectorChangesPane(props: {
  gitStatus: InspectorGitStatus | null;
  loading: boolean;
  error: string | null;
  events: RahEvent[];
  onRefresh: () => void;
  onOpenFile: (selection: FileDetailSelection) => void;
}) {
  const changeCount =
    (props.gitStatus?.totalStaged ?? 0) + (props.gitStatus?.totalUnstaged ?? 0) ||
    props.gitStatus?.changedFiles.length ||
    0;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-sm font-medium text-[var(--app-fg)]">
            <GitBranch size={14} className="text-[var(--app-hint)]" />
            <span>{props.gitStatus?.branch ?? "detached"}</span>
          </div>
          <div className="text-xs text-[var(--app-hint)]">
            {(props.gitStatus?.totalStaged ?? 0)} staged, {(props.gitStatus?.totalUnstaged ?? 0)} unstaged
          </div>
        </div>
        <button
          type="button"
          onClick={props.onRefresh}
          className="inline-flex h-7 w-7 items-center justify-center rounded-md text-[var(--app-hint)] transition-colors hover:bg-[var(--app-bg)] hover:text-[var(--app-fg)]"
          title="Refresh changes"
        >
          <RefreshCcw size={14} />
        </button>
      </div>
      {props.loading ? (
        <div className="flex items-center gap-2 text-sm text-[var(--app-hint)]">
          <LoaderCircle size={14} className="animate-spin" />
          Loading changes…
        </div>
      ) : props.error ? (
        <div className="rounded-lg border border-[var(--app-border)] bg-[var(--app-warning-bg)] p-3 text-xs text-[var(--app-hint)]">
          {props.error}
        </div>
      ) : changeCount === 0 ? (
        <div className="pt-8 text-center text-sm text-[var(--app-hint)]">No changes.</div>
      ) : (
        <div className="space-y-3">
          {props.gitStatus?.stagedFiles.length ? (
            <div className="rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)]">
              <div className="border-b border-[var(--app-border)] px-3 py-2 text-xs font-semibold text-[var(--diff-add-text)]">
                Staged Changes ({props.gitStatus.stagedFiles.length})
              </div>
              <div className="space-y-1 p-2">
                {props.gitStatus.stagedFiles.map((file) => (
                  <button
                    key={`staged-${file.path}`}
                    type="button"
                    onClick={() =>
                      props.onOpenFile({
                        path: file.path,
                        source: "changes",
                        staged: true,
                        pureAddition: file.status === "added" && file.removed === 0,
                        status: file.status,
                        ...(file.binary !== undefined ? { binary: file.binary } : {}),
                        ...(file.oldPath !== undefined ? { oldPath: file.oldPath } : {}),
                      })
                    }
                    className="flex w-full items-center gap-2 rounded-md border border-transparent bg-[var(--app-bg)] px-2.5 py-2 text-left transition-colors hover:border-[var(--app-border)] hover:bg-[var(--app-subtle-bg)]"
                  >
                    <FileText size={14} className="shrink-0 text-[var(--app-hint)]" />
                    <span className={`shrink-0 text-[10px] font-semibold ${getChangedFileStatusTone(file.status)}`}>
                      {getChangedFileStatusLabel(file.status)}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-sm text-[var(--app-fg)]">
                      {file.path}
                    </span>
                    {file.oldPath ? (
                      <span className="hidden max-w-[14rem] truncate text-[11px] text-[var(--app-hint)] md:inline">
                        {file.oldPath} -&gt; {file.path}
                      </span>
                    ) : null}
                    {file.binary ? (
                      <span className="shrink-0 rounded border border-[var(--app-border)] px-1.5 py-0.5 text-[10px] text-[var(--app-hint)]">
                        BIN
                      </span>
                    ) : null}
                    <span className="flex shrink-0 items-center gap-1 text-[11px] font-mono">
                      {file.added ? <span className="text-[var(--diff-add-text)]">+{file.added}</span> : null}
                      {file.removed ? <span className="text-[var(--diff-remove-text)]">-{file.removed}</span> : null}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          {props.gitStatus?.unstagedFiles.length ? (
            <div className="rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)]">
              <div className="border-b border-[var(--app-border)] px-3 py-2 text-xs font-semibold text-[var(--app-warning)]">
                Unstaged Changes ({props.gitStatus.unstagedFiles.length})
              </div>
              <div className="space-y-1 p-2">
                {props.gitStatus.unstagedFiles.map((file) => (
                  <button
                    key={`unstaged-${file.path}`}
                    type="button"
                    onClick={() =>
                      props.onOpenFile({
                        path: file.path,
                        source: "changes",
                        staged: false,
                        pureAddition: file.status === "added" && file.removed === 0,
                        status: file.status,
                        ...(file.binary !== undefined ? { binary: file.binary } : {}),
                        ...(file.oldPath !== undefined ? { oldPath: file.oldPath } : {}),
                      })
                    }
                    className="flex w-full items-center gap-2 rounded-md border border-transparent bg-[var(--app-bg)] px-2.5 py-2 text-left transition-colors hover:border-[var(--app-border)] hover:bg-[var(--app-subtle-bg)]"
                  >
                    <FileText size={14} className="shrink-0 text-[var(--app-hint)]" />
                    <span className={`shrink-0 text-[10px] font-semibold ${getChangedFileStatusTone(file.status)}`}>
                      {getChangedFileStatusLabel(file.status)}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-sm text-[var(--app-fg)]">
                      {file.path}
                    </span>
                    {file.oldPath ? (
                      <span className="hidden max-w-[14rem] truncate text-[11px] text-[var(--app-hint)] md:inline">
                        {file.oldPath} -&gt; {file.path}
                      </span>
                    ) : null}
                    {file.binary ? (
                      <span className="shrink-0 rounded border border-[var(--app-border)] px-1.5 py-0.5 text-[10px] text-[var(--app-hint)]">
                        BIN
                      </span>
                    ) : null}
                    <span className="flex shrink-0 items-center gap-1 text-[11px] font-mono">
                      {file.added ? <span className="text-[var(--diff-add-text)]">+{file.added}</span> : null}
                      {file.removed ? <span className="text-[var(--diff-remove-text)]">-{file.removed}</span> : null}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      )}
      <ChangesFromEvents events={props.events} />
    </div>
  );
}

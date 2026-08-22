import { LoaderCircle } from "lucide-react";
import { DiffDisplay } from "./InspectorPreviewDisplays";
import type { DiffLayout, DiffRow } from "./shared";

export function FileInspectionDiffSurface(props: {
  path: string | null;
  rows: DiffRow[];
  loading: boolean;
  error: string | null;
  truncated: boolean;
  binary?: boolean;
  wrapLines: boolean;
  layout: DiffLayout;
  emptyLabel?: string;
  errorPrefix?: string;
  truncatedLabel?: string;
}) {
  if (!props.path) {
    return (
      <div className="flex h-full min-h-40 items-center justify-center text-sm text-[var(--app-hint)]">
        No changes to review.
      </div>
    );
  }
  if (props.loading) {
    return (
      <div className="flex h-full min-h-40 items-center justify-center gap-2 text-sm text-[var(--app-hint)]">
        <LoaderCircle size={15} className="animate-spin" />
        Loading diff…
      </div>
    );
  }
  if (props.error) {
    return (
      <div className="rounded-md bg-[var(--app-warning-bg)] px-3 py-2 text-sm text-[var(--app-hint)]">
        {props.errorPrefix ?? ""}{props.error}
      </div>
    );
  }
  if (props.binary) {
    return (
      <div className="flex h-full min-h-40 items-center justify-center text-sm text-[var(--app-hint)]">
        Binary changes cannot be rendered as text.
      </div>
    );
  }
  if (props.rows.length === 0) {
    return (
      <div className="flex h-full min-h-40 flex-col items-center justify-center gap-3 text-sm text-[var(--app-hint)]">
        {props.truncated ? (
          <div className="rounded-md bg-[var(--app-warning-bg)] px-3 py-2 text-xs">
            {props.truncatedLabel ?? "This file diff exceeded the stored limit."}
          </div>
        ) : null}
        <span>{props.emptyLabel ?? "No textual diff is available for this file."}</span>
      </div>
    );
  }
  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      {props.truncated ? (
        <div className="rounded-md bg-[var(--app-warning-bg)] px-3 py-2 text-xs text-[var(--app-hint)]">
          {props.truncatedLabel ?? "This file diff exceeded the stored limit."}
        </div>
      ) : null}
      <DiffDisplay
        rows={props.rows}
        path={props.path}
        wrapLines={props.wrapLines}
        layout={props.layout}
        fillAvailable
      />
    </div>
  );
}

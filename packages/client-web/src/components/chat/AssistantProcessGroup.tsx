import { useState, type ReactNode } from "react";
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  LoaderCircle,
  Terminal,
} from "lucide-react";
import type { FeedEntry } from "../../types";
import {
  buildProcessDetailRows,
  formatAssistantProcessDuration,
  type AssistantProcessGroup as AssistantProcessGroupModel,
} from "./assistant-process-groups";

function CommandBatch(props: {
  entries: FeedEntry[];
  status: "running" | "completed" | "failed";
  renderEntry: (entry: FeedEntry) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const label = props.status === "running" ? "Running multiple commands" : "Ran multiple commands";
  const tone =
    props.status === "failed"
      ? "text-[var(--app-warning)]"
      : "text-[var(--app-hint)]";

  return (
    <div className="min-w-0">
      <button
        type="button"
        className={`flex min-h-8 w-full items-center gap-2 py-1 text-left text-xs font-medium ${tone}`}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <Terminal size={13} className="shrink-0" />
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {props.status === "failed" ? <span className="shrink-0">Failed</span> : null}
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
      </button>
      {open ? (
        <div className="mt-1 space-y-2 pl-5">
          {props.entries.map((entry) => (
            <div key={entry.key}>{props.renderEntry(entry)}</div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function AssistantProcessGroup(props: {
  group: AssistantProcessGroupModel;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  renderEntry: (entry: FeedEntry) => ReactNode;
}) {
  const detailRows = buildProcessDetailRows(props.group.entries);
  const duration = formatAssistantProcessDuration(props.group.durationMs);
  const label = props.group.completed
    ? duration
      ? `Worked ${duration}`
      : "Work details"
    : props.group.active
      ? "Working"
      : "Work interrupted";
  const canCollapse = props.group.completed;

  return (
    <section className="min-w-0" data-testid="assistant-process-group">
      <button
        type="button"
        className={`flex min-h-8 w-full items-center gap-2 py-1 text-left text-xs font-medium text-[var(--app-hint)] transition-colors ${
          canCollapse ? "hover:text-[var(--app-fg)]" : "cursor-default"
        }`}
        aria-expanded={props.expanded}
        disabled={!canCollapse}
        onClick={() => {
          if (canCollapse) {
            props.onExpandedChange(!props.expanded);
          }
        }}
      >
        {props.group.active ? (
          <LoaderCircle size={13} className="shrink-0 animate-spin" />
        ) : props.group.failedCount > 0 ? (
          <AlertTriangle size={13} className="shrink-0 text-[var(--app-warning)]" />
        ) : null}
        <span>{label}</span>
        {props.group.failedCount > 0 ? (
          <span className="text-[var(--app-warning)]">
            {props.group.failedCount} failed
          </span>
        ) : null}
        {canCollapse ? (
          props.expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />
        ) : null}
      </button>
      {props.expanded ? (
        <div className="mt-3 space-y-2.5">
          {detailRows.map((row) =>
            row.kind === "command_batch" ? (
              <CommandBatch
                key={row.key}
                entries={row.entries}
                status={row.status}
                renderEntry={props.renderEntry}
              />
            ) : row.kind === "reasoning_batch" ? (
              <div key={row.key}>{props.renderEntry(row.entry)}</div>
            ) : (
              <div key={row.key}>{props.renderEntry(row.entry)}</div>
            ),
          )}
        </div>
      ) : null}
    </section>
  );
}

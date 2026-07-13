import { useState, type ReactNode } from "react";
import type { ConversationActivityKind } from "@rah/runtime-protocol";
import { AlertTriangle, ChevronDown, ChevronRight, LoaderCircle } from "lucide-react";
import type { FeedEntry } from "../../types";
import { ConversationActivityIcon, conversationActivityLabel } from "./conversation-activity-display";
import {
  buildProcessDetailRows,
  formatAssistantProcessDuration,
  type AssistantProcessGroup as AssistantProcessGroupModel,
} from "./assistant-process-groups";

function ActivityBatch(props: {
  activityKind: ConversationActivityKind;
  entries: FeedEntry[];
  runningCount: number;
  interruptedCount: number;
  issueCount: number;
  failureCount: number;
  renderEntry: (entry: FeedEntry) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const running = props.runningCount > 0;
  const label = conversationActivityLabel(props.activityKind, props.entries.length, running);
  const tone =
    props.failureCount > 0
      ? "text-[var(--app-danger)]"
      : props.issueCount > 0
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
        <span className="shrink-0">
          <ConversationActivityIcon kind={props.activityKind} />
        </span>
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {props.failureCount > 0 ? <span className="shrink-0">Failed</span> : null}
        {props.issueCount > 0 ? <span className="shrink-0">Review result</span> : null}
        {props.interruptedCount > 0 && !running ? (
          <span className="shrink-0">Interrupted</span>
        ) : null}
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
  detailLoading?: boolean;
  renderEntry: (entry: FeedEntry) => ReactNode;
}) {
  const detailRows = buildProcessDetailRows(props.group.entries);
  const duration = formatAssistantProcessDuration(props.group.durationMs);
  const activityFailureCount = props.group.activities.reduce(
    (total, activity) => total + activity.failureCount,
    0,
  );
  const activityIssueCount = props.group.activities.reduce(
    (total, activity) => total + activity.issueCount,
    0,
  );
  const reviewResults = activityFailureCount > 0 || activityIssueCount > 0;
  const label =
    props.group.turnStatus === "failed"
      ? duration
        ? `Failed after ${duration}`
        : "Work failed"
      : props.group.turnStatus === "interrupted"
        ? duration
          ? `Interrupted after ${duration}`
          : "Work interrupted"
        : props.group.completed
          ? duration
            ? `Worked ${duration}`
            : "Work details"
          : props.group.active
            ? "Working"
            : "Work interrupted";
  const canCollapse =
    props.group.completed ||
    props.group.turnStatus === "interrupted" ||
    props.group.turnStatus === "failed";

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
        ) : props.group.turnStatus === "failed" ? (
          <AlertTriangle size={13} className="shrink-0 text-[var(--app-danger)]" />
        ) : reviewResults ? (
          <AlertTriangle size={13} className="shrink-0 text-[var(--app-warning)]" />
        ) : null}
        <span>{label}</span>
        {reviewResults && props.group.turnStatus !== "failed" ? (
          <span className="text-[var(--app-warning)]">Review results</span>
        ) : null}
        {canCollapse ? (
          props.expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />
        ) : null}
      </button>
      {props.expanded ? (
        <div className="mt-3 space-y-2.5">
          {props.detailLoading ? (
            <div className="flex min-h-8 items-center gap-2 text-xs text-[var(--app-hint)]">
              <LoaderCircle size={13} className="animate-spin" />
              <span>Loading work details...</span>
            </div>
          ) : detailRows.length === 0 && props.group.detailsAvailable ? (
            <div className="text-xs text-[var(--app-hint)]">Work details unavailable.</div>
          ) : detailRows.map((row) =>
            row.kind === "activity_batch" ? (
              <ActivityBatch
                key={row.key}
                activityKind={row.activityKind}
                entries={row.entries}
                runningCount={row.runningCount}
                interruptedCount={row.interruptedCount}
                issueCount={row.issueCount}
                failureCount={row.failureCount}
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

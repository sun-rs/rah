import { memo, useMemo, useState, type ReactNode } from "react";
import type {
  ConversationActivityBatchSummary,
  ConversationActivityKind,
  ConversationItemDetailKind,
} from "@rah/runtime-protocol";
import { ChevronDown, ChevronRight, LoaderCircle } from "lucide-react";
import type { FeedEntry } from "../../types";
import { ConversationActivityIcon } from "./conversation-activity-display";
import {
  buildProcessDetailRows,
  formatAssistantProcessDuration,
  type AssistantProcessGroup as AssistantProcessGroupModel,
} from "./assistant-process-groups";
import { ProcessActivityEntry } from "./ProcessActivityEntry";

function ActivityBatch(props: {
  activityKind: ConversationActivityKind;
  summary: ConversationActivityBatchSummary;
  entries: FeedEntry[];
  runningCount: number;
  interruptedCount: number;
  issueCount: number;
  failureCount: number;
  onLoadConversationItemDetail?: (
    kind: ConversationItemDetailKind,
    itemId: string,
  ) => Promise<void> | void;
  onOpenLocalFile?: (path: string) => void;
}) {
  // Worked is the turn-level disclosure. Each uninterrupted activity run is a
  // second disclosure and starts compact; opening it reveals its individual
  // operations, whose own disclosures reveal command output or file detail.
  const [open, setOpen] = useState(false);
  const running = props.runningCount > 0;
  const label = activityBatchLabel(props.summary, running);
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
        className={`assistant-process-activity-summary group flex w-full items-center gap-2 text-left text-xs font-medium outline-none ${tone}`}
        aria-expanded={open}
        data-testid="assistant-process-activity-summary"
        onClick={() => setOpen((value) => !value)}
      >
        <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-sm group-focus-visible:text-[var(--app-accent)]">
          <ConversationActivityIcon kind={props.activityKind} />
        </span>
        <span className="min-w-0 flex-1 truncate group-focus-visible:underline group-focus-visible:underline-offset-4">{label}</span>
        {props.failureCount > 0 ? <span className="shrink-0">Failed</span> : null}
        {props.interruptedCount > 0 && !running ? (
          <span className="shrink-0">Interrupted</span>
        ) : null}
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
      </button>
      {open ? (
        <div className="mt-0.5 space-y-0.5">
          {props.entries.map((entry) => (
            <ProcessActivityEntry
              key={entry.key}
              entry={entry}
              {...(props.onOpenLocalFile
                ? { onOpenLocalFile: props.onOpenLocalFile }
                : {})}
              {...(props.onLoadConversationItemDetail && entry.kind === "tool_call"
                ? {
                    onLoadDetail: () =>
                      props.onLoadConversationItemDetail?.("tool_call", entry.toolCall.id),
                  }
                : props.onLoadConversationItemDetail && entry.kind === "observation"
                  ? {
                      onLoadDetail: () =>
                        props.onLoadConversationItemDetail?.("observation", entry.observation.id),
                    }
                  : {})}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function activityBatchLabel(
  summary: ConversationActivityBatchSummary,
  running: boolean,
): string {
  const commandCount = summary.commandCount || summary.totalCount;
  const commandNoun = `${commandCount} command${commandCount === 1 ? "" : "s"}`;
  switch (summary.kind) {
    case "file_change":
      return running ? "Editing files" : "Edited files";
    case "file_read_command":
      return running
        ? `Reading files and running ${commandNoun}`
        : `Read files and ran ${commandNoun}`;
    case "file_read":
      return running ? "Reading files" : "Read files";
    case "command":
      return running ? `Running ${commandNoun}` : `Ran ${commandNoun}`;
    case "web":
      return running ? "Using the web" : "Used the web";
    case "git":
      return running ? "Using Git" : "Used Git";
    case "subagent":
      return running ? "Coordinating subagents" : "Coordinated subagents";
    case "plan":
      return running ? "Updating plan" : "Updated plan";
    case "automation":
      return running ? "Running automation" : "Ran automation";
    case "tool":
      return `${running ? "Using" : "Used"} ${summary.totalCount} tool${summary.totalCount === 1 ? "" : "s"}`;
  }
}

export const AssistantProcessGroup = memo(function AssistantProcessGroup(props: {
  group: AssistantProcessGroupModel;
  expanded: boolean;
  onExpandedChange: (
    group: AssistantProcessGroupModel,
    expanded: boolean,
    anchor: HTMLElement,
  ) => void;
  detailLoading?: boolean;
  onLoadConversationItemDetail?: (
    kind: ConversationItemDetailKind,
    itemId: string,
  ) => Promise<void> | void;
  onOpenLocalFile?: (path: string) => void;
  renderEntry: (entry: FeedEntry) => ReactNode;
}) {
  const detailRows = useMemo(
    () =>
      buildProcessDetailRows(props.group.entries, {
        includeTransientStatus: !props.group.completed,
      }),
    [props.group.completed, props.group.entries],
  );
  const duration = formatAssistantProcessDuration(props.group.durationMs);
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
  const processSettled =
    props.group.completed ||
    props.group.turnStatus === "interrupted" ||
    props.group.turnStatus === "failed";
  const hasProcessDetails =
    detailRows.length > 0 ||
    props.group.detailsAvailable === true ||
    props.detailLoading === true;
  const canCollapse = processSettled && hasProcessDetails;
  const showDetails = props.expanded && hasProcessDetails;

  return (
    <section className="min-w-0" data-testid="assistant-process-group">
      <button
        type="button"
        className={`assistant-process-summary group flex w-full items-center gap-2 text-left text-xs font-medium text-[var(--app-hint)] outline-none transition-colors focus-visible:text-[var(--app-fg)] ${
          canCollapse ? "hover:text-[var(--app-fg)]" : "cursor-default"
        }`}
        aria-expanded={showDetails}
        disabled={!canCollapse}
        data-testid="assistant-process-group-toggle"
        onClick={(event) => {
          if (canCollapse) {
            props.onExpandedChange(
              props.group,
              !showDetails,
              event.currentTarget,
            );
          }
        }}
      >
        {props.group.active ? (
          <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-sm group-focus-visible:text-[var(--app-accent)]">
            <LoaderCircle size={13} className="animate-spin" />
          </span>
        ) : null}
        <span className="min-w-0 truncate group-focus-visible:underline group-focus-visible:underline-offset-4">{label}</span>
        {canCollapse ? (
          showDetails ? <ChevronDown size={14} /> : <ChevronRight size={14} />
        ) : null}
      </button>
      {showDetails ? (
        <div
          {...(props.group.hasFinalAnswer
            ? { "data-testid": "assistant-process-final-divider" }
            : {})}
          className={`assistant-process-details ${
            props.group.hasFinalAnswer
              ? "border-b border-[var(--app-border)]"
              : ""
          }`}
        >
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
                summary={row.summary}
                entries={row.entries}
                runningCount={row.runningCount}
                interruptedCount={row.interruptedCount}
                issueCount={row.issueCount}
                failureCount={row.failureCount}
                {...(props.onOpenLocalFile
                  ? { onOpenLocalFile: props.onOpenLocalFile }
                  : {})}
                {...(props.onLoadConversationItemDetail
                  ? { onLoadConversationItemDetail: props.onLoadConversationItemDetail }
                  : {})}
              />
            ) : row.kind === "reasoning_batch" ? (
              <div key={row.key}>{props.renderEntry(row.entry)}</div>
            ) : (
              <div
                key={row.key}
                className={
                  row.entry.kind === "timeline" && row.entry.item.kind === "compaction"
                    ? "assistant-process-compaction-slot"
                    : undefined
                }
              >
                {props.renderEntry(row.entry)}
              </div>
            ),
          )}
        </div>
      ) : props.group.hasFinalAnswer ? (
        <div
          className="border-b border-[var(--app-border)]"
          data-testid="assistant-process-final-divider"
          aria-hidden="true"
        />
      ) : null}
    </section>
  );
});

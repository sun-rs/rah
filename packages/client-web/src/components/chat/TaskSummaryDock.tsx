import { useId, useState } from "react";
import { Check, ChevronDown, ChevronUp, Circle, ListChecks, LoaderCircle } from "lucide-react";
import { usePwaDisplayMode } from "../../hooks/usePwaDisplayMode";
import { MarkdownRenderer } from "./MarkdownRenderer";
import { CodexChangedFilesIcon } from "./codex-file-icon-assets";
import { ConversationActivityIcon, conversationActivityLabel } from "./conversation-activity-display";
import { currentPlanProgress, type CurrentPlan } from "./current-plan";

function turnStatusLabel(status: CurrentPlan["turn"]["status"]): string {
  switch (status) {
    case "in_progress":
      return "Working";
    case "completed":
      return "Completed";
    case "interrupted":
      return "Interrupted";
    case "failed":
      return "Failed";
  }
}

export function TaskSummaryDock(props: {
  plan: CurrentPlan;
  onOpenLocalFile?: (path: string) => void;
  onReviewChanges?: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const detailsId = useId();
  const isPwaDisplayMode = usePwaDisplayMode();
  const progress = currentPlanProgress(props.plan);
  const planTitle = props.plan.item.text.match(/^#\s+(.+)$/m)?.[1]?.trim() || "Plan";
  const status = turnStatusLabel(props.plan.turn.status);
  const activities = props.plan.turn.activities.filter((activity) => activity.totalCount > 0);
  const fileChanges = props.plan.turn.fileChanges;
  const hasFileChanges = Boolean(fileChanges?.files.length);
  const overlayVisibilityClassName = isPwaDisplayMode
    ? expanded
      ? "visible pointer-events-auto opacity-100"
      : "invisible pointer-events-none opacity-0"
    : "invisible pointer-events-none opacity-0 group-hover:visible group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:visible group-focus-within:pointer-events-auto group-focus-within:opacity-100";

  return (
    <section
      className="chat-task-summary relative z-[40] shrink-0 px-4 pb-2 pt-1"
      aria-label="Task summary"
    >
      <div className="group relative mx-auto w-fit max-w-full">
        <div
          id={detailsId}
          data-testid="task-summary-overlay"
          className={`absolute bottom-[calc(100%-1px)] left-1/2 w-[min(42rem,calc(100vw-2rem))] -translate-x-1/2 overflow-hidden rounded-xl border border-[var(--app-border)] bg-[var(--app-bg)] shadow-xl transition-[opacity,visibility] duration-150 ${overlayVisibilityClassName}`}
        >
          <div className="rah-scroll-overlay max-h-[min(28rem,58dvh)] overflow-y-auto px-4 py-3">
            {planTitle !== "Plan" ? (
              <div className="mb-2 text-xs font-medium text-[var(--app-fg)]">{planTitle}</div>
            ) : null}
            {props.plan.item.explanation ? (
              <p className="mb-2 text-xs leading-5 text-[var(--app-hint)]">
                {props.plan.item.explanation}
              </p>
            ) : null}
            {props.plan.item.steps?.length ? (
              <ol className="space-y-1.5 text-sm">
                {props.plan.item.steps.map((step, index) => (
                  <li key={`${index}:${step.text}`} className="flex min-w-0 items-start gap-2">
                    {step.status === "completed" ? (
                      <Check size={14} className="mt-0.5 shrink-0 text-[var(--app-success)]" />
                    ) : step.status === "in_progress" ? (
                      <LoaderCircle
                        size={14}
                        className="mt-0.5 shrink-0 animate-spin text-[var(--app-resource-link)]"
                      />
                    ) : (
                      <Circle size={12} className="mt-1 shrink-0 text-[var(--app-hint)]" />
                    )}
                    <span
                      className={
                        step.status === "completed"
                          ? "min-w-0 text-[var(--app-hint)] line-through"
                          : "min-w-0 text-[var(--app-fg)]"
                      }
                    >
                      {step.text}
                    </span>
                  </li>
                ))}
              </ol>
            ) : (
              <MarkdownRenderer
                className="prose-chat text-sm leading-relaxed"
                content={props.plan.item.text}
                {...(props.onOpenLocalFile ? { onOpenLocalFile: props.onOpenLocalFile } : {})}
              />
            )}
            {activities.length > 0 || hasFileChanges ? (
              <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 border-t border-[var(--app-border)] pt-2 text-xs text-[var(--app-hint)]">
                {activities.map((activity) => (
                  <span key={activity.kind} className="inline-flex items-center gap-1.5">
                    <ConversationActivityIcon kind={activity.kind} size={12} />
                    {conversationActivityLabel(
                      activity.kind,
                      activity.totalCount,
                      activity.runningCount > 0,
                    )}
                  </span>
                ))}
                {fileChanges?.files.length ? (
                  <button
                    type="button"
                    className="inline-flex min-h-7 items-center gap-1.5 rounded-md px-1.5 text-[var(--app-hint)] transition-colors hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)]"
                    onClick={props.onReviewChanges}
                    disabled={!props.onReviewChanges}
                    aria-label="Review files changed by this turn"
                  >
                    <CodexChangedFilesIcon className="h-3.5 w-3.5" />
                    <span>
                      {fileChanges.files.length}{" "}
                      {fileChanges.files.length === 1 ? "file" : "files"} changed
                    </span>
                    <span className="font-medium text-[var(--app-success)]">
                      +{fileChanges.totalAdditions}
                    </span>
                    <span className="font-medium text-[var(--app-danger)]">
                      -{fileChanges.totalDeletions}
                    </span>
                  </button>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
        <button
          type="button"
          className="flex min-h-9 max-w-full min-w-0 items-center gap-2 rounded-xl border border-[var(--app-border)] bg-[var(--app-bg)] px-3 text-left text-sm text-[var(--app-fg)] transition-colors hover:bg-[var(--app-subtle-bg)]"
          onClick={() => {
            if (isPwaDisplayMode) {
              setExpanded((value) => !value);
            }
          }}
          aria-controls={detailsId}
          aria-expanded={isPwaDisplayMode ? expanded : undefined}
        >
          <ListChecks size={15} className="shrink-0 text-[var(--app-hint)]" />
          <span className="shrink-0 font-medium">Task summary</span>
          <span className="min-w-0 truncate text-xs text-[var(--app-hint)]">
            {`${status} · `}
            {progress ? `${progress.completed}/${progress.total}` : planTitle}
            {progress?.activeStep ? ` · ${progress.activeStep}` : ""}
          </span>
          <span className="ml-auto shrink-0 text-[var(--app-hint)]">
            {isPwaDisplayMode && expanded ? (
              <ChevronDown size={15} />
            ) : (
              <ChevronUp size={15} />
            )}
          </span>
        </button>
      </div>
    </section>
  );
}

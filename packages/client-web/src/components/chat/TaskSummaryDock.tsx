import React, { useState } from "react";
import type { ConversationTurnProjection } from "@rah/runtime-protocol";
import { Check, ChevronDown, ChevronUp, Circle, ListChecks, LoaderCircle } from "lucide-react";
import { MarkdownRenderer } from "./MarkdownRenderer";
import { ConversationActivityIcon, conversationActivityLabel } from "./conversation-activity-display";
import { currentPlanProgress, type CurrentPlan } from "./current-plan";

function turnStatusLabel(turn: ConversationTurnProjection | undefined): string | null {
  switch (turn?.status) {
    case "in_progress":
      return "Working";
    case "completed":
      return "Completed";
    case "interrupted":
      return "Interrupted";
    case "failed":
      return "Failed";
    default:
      return null;
  }
}

export function TaskSummaryDock(props: {
  plan: CurrentPlan;
  turn?: ConversationTurnProjection;
  onOpenLocalFile?: (path: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const progress = currentPlanProgress(props.plan);
  const planTitle = props.plan.item.text.match(/^#\s+(.+)$/m)?.[1]?.trim() || "Plan";
  const status = turnStatusLabel(props.turn);
  const activities = props.turn?.activities.filter((activity) => activity.totalCount > 0) ?? [];

  return (
    <section
      className="chat-task-summary shrink-0 border-t border-[var(--app-border)] bg-[var(--app-bg)] px-4 py-2"
      aria-label="Task summary"
    >
      <div className="mx-auto w-full min-w-0 max-w-3xl">
        <button
          type="button"
          className="flex min-h-8 w-full min-w-0 items-center gap-2 rounded-md px-1.5 text-left text-sm text-[var(--app-fg)] transition-colors hover:bg-[var(--app-subtle-bg)]"
          onClick={() => setExpanded((value) => !value)}
          aria-expanded={expanded}
        >
          <ListChecks size={15} className="shrink-0 text-[var(--app-hint)]" />
          <span className="shrink-0 font-medium">Task summary</span>
          <span className="min-w-0 truncate text-xs text-[var(--app-hint)]">
            {status ? `${status} · ` : ""}
            {progress ? `${progress.completed}/${progress.total}` : planTitle}
            {progress?.activeStep ? ` · ${progress.activeStep}` : ""}
          </span>
          <span className="ml-auto shrink-0 text-[var(--app-hint)]">
            {expanded ? <ChevronDown size={15} /> : <ChevronUp size={15} />}
          </span>
        </button>
        {expanded ? (
          <div className="rah-scroll-overlay mt-2 max-h-64 overflow-y-auto px-1.5 pb-1">
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
                      <LoaderCircle size={14} className="mt-0.5 shrink-0 text-[var(--app-resource-link)]" />
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
                fallbackClassName="whitespace-pre-wrap break-words [overflow-wrap:anywhere] text-sm leading-relaxed"
                {...(props.onOpenLocalFile ? { onOpenLocalFile: props.onOpenLocalFile } : {})}
              />
            )}
            {activities.length > 0 ? (
              <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5 border-t border-[var(--app-border)] pt-2 text-xs text-[var(--app-hint)]">
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
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </section>
  );
}

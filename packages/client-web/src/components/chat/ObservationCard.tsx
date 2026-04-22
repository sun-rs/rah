import type { WorkbenchObservation } from "@rah/runtime-protocol";
import { Activity, CheckCircle2, Clock3, Search, XCircle } from "lucide-react";
import { ActivityArtifacts } from "./ActivityArtifacts";
import { CompactEventCard } from "./CompactEventCard";

function statusMeta(status: "running" | "completed" | "failed") {
  switch (status) {
    case "running":
      return {
        label: "Running",
        className: "bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/20",
        icon: <Clock3 size={12} />,
      };
    case "completed":
      return {
        label: "Completed",
        className:
          "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20",
        icon: <CheckCircle2 size={12} />,
      };
    case "failed":
      return {
        label: "Failed",
        className: "bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/20",
        icon: <XCircle size={12} />,
      };
  }
}

function subjectSummary(observation: WorkbenchObservation) {
  const parts: string[] = [];
  if (observation.subject?.command) {
    parts.push(observation.subject.command);
  }
  if (observation.subject?.query) {
    parts.push(`query: ${observation.subject.query}`);
  }
  if (observation.subject?.files?.length) {
    parts.push(`${observation.subject.files.length} files`);
  }
  if (observation.subject?.urls?.length) {
    parts.push(`${observation.subject.urls.length} urls`);
  }
  if (observation.durationMs !== undefined) {
    parts.push(`${observation.durationMs}ms`);
  }
  if (observation.exitCode !== undefined) {
    parts.push(`exit ${observation.exitCode}`);
  }
  return parts.join(" · ");
}

export function ObservationCard(props: {
  observation: WorkbenchObservation;
  status: "running" | "completed" | "failed";
  error?: string;
}) {
  const status = statusMeta(props.status);
  const summary = subjectSummary(props.observation);

  return (
    <CompactEventCard
      label="Event"
      title={props.observation.title}
      {...(props.observation.summary ? { subtitle: props.observation.summary } : {})}
      status={
        <span
          className={`inline-flex shrink-0 items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] font-medium ${status.className}`}
        >
          {status.icon}
          <span>{status.label}</span>
        </span>
      }
      tone={props.status === "failed" ? "danger" : "default"}
    >
      <div className="space-y-2">
        <div className="flex items-center gap-2 text-[11px] font-medium text-[var(--app-hint)]">
          <Activity size={13} className="text-[var(--app-hint)]" />
          <span>{props.observation.kind}</span>
        </div>
        {summary ? (
          <div className="flex items-start gap-2 text-[11px] text-[var(--app-hint)]">
            <Search size={12} className="mt-0.5 shrink-0" />
            <span className="break-words">{summary}</span>
          </div>
        ) : null}
        {props.error ? (
          <div className="rounded-lg border border-[var(--app-danger)] bg-[var(--app-danger-bg)] px-3 py-2 text-xs text-[var(--app-fg)]">
            {props.error}
          </div>
        ) : null}
        {props.observation.detail?.artifacts?.length ? (
          <ActivityArtifacts artifacts={props.observation.detail.artifacts} />
        ) : null}
      </div>
    </CompactEventCard>
  );
}

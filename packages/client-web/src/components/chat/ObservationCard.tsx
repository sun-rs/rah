import type { WorkbenchObservation } from "@rah/runtime-protocol";
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Clock3,
  FileText,
  GitBranch,
  Hammer,
  PencilLine,
  Search,
  Terminal,
  TestTube2,
  Wrench,
} from "lucide-react";
import { ActivityArtifacts } from "./ActivityArtifacts";
import { CompactEventCard } from "./CompactEventCard";

function isSearchNoMatches(observation: WorkbenchObservation) {
  return observation.metrics?.semanticStatus === "search_no_matches";
}

function statusMeta(status: "running" | "completed" | "failed", observation: WorkbenchObservation) {
  if (status === "completed" && isSearchNoMatches(observation)) {
    return {
      label: "No matches",
      className: "bg-neutral-500/10 text-[var(--app-hint)] border-[var(--app-border)]",
      icon: <Search size={12} />,
    };
  }

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
        label: "Result failed",
        className: "bg-amber-500/10 text-amber-700 dark:text-amber-300 border-amber-500/25",
        icon: <AlertTriangle size={12} />,
      };
  }
}

function isCommandBackedObservation(observation: WorkbenchObservation) {
  return Boolean(observation.subject?.command);
}

function compactSubtitle(observation: WorkbenchObservation) {
  if (isCommandBackedObservation(observation)) {
    return undefined;
  }
  return observation.summary;
}

function observationIcon(observation: WorkbenchObservation) {
  switch (observation.kind) {
    case "test.run":
      return <TestTube2 size={14} />;
    case "build.run":
    case "lint.run":
      return <Hammer size={14} />;
    case "command.run":
      return <Terminal size={14} />;
    case "file.read":
    case "file.list":
      return <FileText size={14} />;
    case "file.search":
    case "web.search":
    case "web.fetch":
      return <Search size={14} />;
    case "file.write":
    case "file.edit":
    case "patch.apply":
    case "git.apply":
      return <PencilLine size={14} />;
    case "git.status":
    case "git.diff":
      return <GitBranch size={14} />;
    case "mcp.call":
    case "subagent.lifecycle":
      return <Wrench size={14} />;
    default:
      return <Activity size={14} />;
  }
}

function expandedMetaSummary(observation: WorkbenchObservation) {
  const parts: string[] = [];
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

function hasTextOutputArtifact(observation: WorkbenchObservation) {
  return Boolean(
    observation.detail?.artifacts?.some(
      (artifact) =>
        artifact.kind === "text" &&
        (artifact.label === "output" ||
          artifact.label === "stdout" ||
          artifact.label === "stderr") &&
        artifact.text.trim().length > 0,
    ),
  );
}

function shouldShowErrorBlock(observation: WorkbenchObservation, error: string | undefined) {
  if (!error) {
    return false;
  }
  if (isCommandBackedObservation(observation) && observation.exitCode !== undefined) {
    return false;
  }
  return !hasTextOutputArtifact(observation);
}

export function ObservationCard(props: {
  observation: WorkbenchObservation;
  status: "running" | "completed" | "failed";
  error?: string;
}) {
  const status = statusMeta(props.status, props.observation);
  const subtitle = compactSubtitle(props.observation);
  const metaSummary = expandedMetaSummary(props.observation);
  const statusLabel =
    props.status === "failed" && props.observation.exitCode !== undefined
      ? `${status.label} · exit ${props.observation.exitCode}`
      : status.label;
  const showError = shouldShowErrorBlock(props.observation, props.error);

  return (
    <CompactEventCard
      label="Event"
      hideLabel
      title={props.observation.title}
      icon={observationIcon(props.observation)}
      {...(subtitle ? { subtitle } : {})}
      status={
        <span
          className={`inline-flex shrink-0 items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] font-medium ${status.className}`}
        >
          {status.icon}
          <span>{statusLabel}</span>
        </span>
      }
      tone={props.status === "failed" ? "warning" : "default"}
    >
      <div className="space-y-2">
        <div className="flex items-center gap-2 text-[11px] font-medium text-[var(--app-hint)]">
          <Activity size={13} className="text-[var(--app-hint)]" />
          <span>{props.observation.kind}</span>
        </div>
        {metaSummary ? (
          <div className="flex items-start gap-2 text-[11px] text-[var(--app-hint)]">
            <Search size={12} className="mt-0.5 shrink-0" />
            <span className="break-words">{metaSummary}</span>
          </div>
        ) : null}
        {showError ? (
          <div className="rounded-lg border border-[var(--app-warning)] bg-[var(--app-warning-bg)] px-3 py-2 text-xs text-[var(--app-fg)]">
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

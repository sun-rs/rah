import type { ToolCall, ToolCallArtifact } from "@rah/runtime-protocol";
import { useState } from "react";
import {
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  LoaderCircle,
  Terminal,
  Wrench,
  XCircle,
} from "lucide-react";
import { ActivityArtifacts } from "./ActivityArtifacts";

function statusBadge(status: "running" | "completed" | "failed") {
  switch (status) {
    case "running":
      return {
        label: "Running",
        className: "bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/20",
        icon: <LoaderCircle size={12} className="animate-spin" />,
      };
    case "completed":
      return {
        label: "Completed",
        className: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20",
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

function fallbackArtifacts(toolCall: ToolCall): ToolCallArtifact[] {
  if (toolCall.detail?.artifacts?.length) {
    return toolCall.detail.artifacts;
  }
  if (toolCall.input && Object.keys(toolCall.input).length > 0) {
    return [{ kind: "json", label: "input", value: toolCall.input }];
  }
  if (toolCall.result && Object.keys(toolCall.result).length > 0) {
    return [{ kind: "json", label: "result", value: toolCall.result }];
  }
  return [];
}

function toolIcon(toolCall: ToolCall) {
  if (
    toolCall.family === "shell" ||
    toolCall.family === "test" ||
    toolCall.family === "build" ||
    toolCall.family === "lint"
  ) {
    return <Terminal size={16} className="text-[var(--app-hint)]" />;
  }
  return <Wrench size={16} className="text-[var(--app-hint)]" />;
}

export function ToolCallCard(props: {
  toolCall: ToolCall;
  status: "running" | "completed" | "failed";
  error?: string;
}) {
  const [open, setOpen] = useState(false);
  const badge = statusBadge(props.status);
  const artifacts = fallbackArtifacts(props.toolCall);
  const expandable =
    artifacts.length > 0 ||
    Boolean(props.toolCall.summary) ||
    Boolean(props.error) ||
    Boolean(props.toolCall.result && Object.keys(props.toolCall.result).length > 0);
  const detailText =
    props.error ??
    props.toolCall.summary ??
    (props.toolCall.title !== props.toolCall.providerToolName ? props.toolCall.title : null);
  const toneClassName =
    props.status === "failed"
      ? "border-[var(--app-danger)]/25 bg-[var(--app-danger)]/8"
      : "border-[var(--app-border)] bg-[var(--app-subtle-bg)]";

  return (
    <div className={`w-full rounded-lg border ${toneClassName}`}>
      <button
        type="button"
        disabled={!expandable}
        onClick={() => {
          if (expandable) {
            setOpen((value) => !value);
          }
        }}
        className="flex w-full items-center gap-3 px-3 py-2 text-left disabled:cursor-default"
      >
        <div className="shrink-0">{toolIcon(props.toolCall)}</div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-[13px] leading-5">
            <span className="shrink-0 font-medium text-[var(--app-fg)]">
              {props.toolCall.providerToolName}
            </span>
            {detailText ? (
              <span className="truncate text-[var(--app-hint)]">{detailText}</span>
            ) : null}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span
            className={`inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] font-medium ${badge.className}`}
          >
            {badge.icon}
            <span>{badge.label}</span>
          </span>
          {expandable ? (
            <div className="text-[var(--app-hint)]">
              {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            </div>
          ) : null}
        </div>
      </button>
      {expandable && open ? (
        <div className="border-t border-[var(--app-border)] px-3 py-2.5">
          <div className="space-y-2">
            {props.toolCall.summary && props.toolCall.summary !== detailText ? (
              <div className="text-xs text-[var(--app-hint)]">{props.toolCall.summary}</div>
            ) : null}
            {props.toolCall.title &&
            props.toolCall.title !== props.toolCall.providerToolName &&
            props.toolCall.title !== props.toolCall.summary &&
            props.toolCall.title !== detailText ? (
              <div className="text-xs text-[var(--app-hint)]">{props.toolCall.title}</div>
            ) : null}
            {props.error ? (
              <div className="rounded-lg border border-[var(--app-danger)]/30 bg-[var(--app-danger)]/10 px-3 py-2 text-xs text-[var(--app-fg)]">
                {props.error}
              </div>
            ) : null}
            <ActivityArtifacts artifacts={artifacts} />
          </div>
        </div>
      ) : null}
    </div>
  );
}

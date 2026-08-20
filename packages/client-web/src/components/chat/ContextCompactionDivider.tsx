import type { TimelineItem } from "@rah/runtime-protocol";
import { ArrowUpToLine } from "lucide-react";

export function ContextCompactionDivider(props: {
  item: Extract<TimelineItem, { kind: "compaction" }>;
}) {
  const active = props.item.status === "started";
  const countSuffix =
    props.item.count && props.item.count > 1 ? ` · ${props.item.count} passes` : "";
  const triggerSuffix = props.item.trigger ? ` · ${props.item.trigger}` : "";
  const label = `${
    active ? "Compacting context" : "Context compacted"
  }${countSuffix}${triggerSuffix}`;
  return (
    <div
      className="assistant-process-compaction flex min-w-0 items-center gap-2 text-xs font-medium text-[var(--app-hint)]"
      data-testid="context-compaction-divider"
      data-status={active ? "running" : "completed"}
      role="separator"
      aria-label={label}
    >
      <span
        aria-hidden="true"
        className="h-px min-w-4 flex-1 bg-[var(--app-border)]"
        data-testid="context-compaction-rule-start"
      />
      <span className="inline-flex shrink-0 items-center gap-1.5">
        <span className="inline-flex h-5 w-5 items-center justify-center" aria-hidden="true">
          <ArrowUpToLine size={12} aria-hidden="true" />
        </span>
        <span className={active ? "assistant-process-active-text" : undefined}>{label}</span>
      </span>
      <span
        aria-hidden="true"
        className="h-px min-w-4 flex-1 bg-[var(--app-border)]"
        data-testid="context-compaction-rule-end"
      />
    </div>
  );
}

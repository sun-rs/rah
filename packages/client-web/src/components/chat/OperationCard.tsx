import type { RuntimeOperation } from "@rah/runtime-protocol";
import { Cog, ExternalLink, Shield } from "lucide-react";
import { CompactEventCard } from "./CompactEventCard";

function operationIcon(kind: RuntimeOperation["kind"]) {
  if (kind === "governance") {
    return <Shield size={14} className="text-[var(--app-hint)]" />;
  }
  return <Cog size={14} className="text-[var(--app-hint)]" />;
}

export function OperationCard(props: {
  operation: RuntimeOperation;
  status: "started" | "resolved" | "requested";
}) {
  return (
    <CompactEventCard
      label="Operation"
      title={props.operation.name}
      subtitle={props.operation.target}
      status={
        <span className="inline-flex shrink-0 rounded-full border border-[var(--app-border)] bg-[var(--app-bg)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--app-hint)]">
          {props.status}
        </span>
      }
    >
      <div className="space-y-2">
        <div className="flex items-center gap-2 text-[11px] font-medium text-[var(--app-hint)]">
          {operationIcon(props.operation.kind)}
          <span>{props.operation.kind}</span>
        </div>
        {props.operation.reason ? (
          <div className="text-xs text-[var(--app-fg)]">{props.operation.reason}</div>
        ) : null}
        {props.operation.input ? (
          <div className="rounded-lg bg-[var(--app-code-bg)] px-3 py-2">
            <div className="mb-1 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--app-hint)]">
              <ExternalLink size={12} />
              <span>Input</span>
            </div>
            <pre className="max-w-full overflow-x-auto custom-scrollbar text-xs text-[var(--app-fg)]">
              <code>{JSON.stringify(props.operation.input, null, 2)}</code>
            </pre>
          </div>
        ) : null}
      </div>
    </CompactEventCard>
  );
}

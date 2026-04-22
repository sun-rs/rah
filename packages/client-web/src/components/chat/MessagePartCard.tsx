import type { MessagePartRef } from "@rah/runtime-protocol";
import { Boxes } from "lucide-react";
import { CompactEventCard } from "./CompactEventCard";

export function MessagePartCard(props: {
  part: MessagePartRef;
  status: "added" | "updated" | "streaming" | "removed";
}) {
  return (
    <CompactEventCard
      label="Part"
      title={props.part.kind}
      status={
        <span className="inline-flex rounded-full border border-[var(--app-border)] bg-[var(--app-bg)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--app-hint)]">
          {props.status}
        </span>
      }
    >
      <div className="space-y-2">
        <div className="flex items-center gap-2 text-[11px] font-medium text-[var(--app-hint)]">
          <Boxes size={13} className="text-[var(--app-hint)]" />
          <span className="min-w-0 break-all">{props.part.messageId}</span>
        </div>
        {props.part.text ? (
          <pre className="max-w-full overflow-x-auto custom-scrollbar rounded-lg bg-[var(--app-code-bg)] px-3 py-2 text-xs text-[var(--app-fg)]">
            <code>{props.part.text}</code>
          </pre>
        ) : null}
        {props.part.metadata ? (
          <pre className="max-w-full overflow-x-auto custom-scrollbar rounded-lg bg-[var(--app-code-bg)] px-3 py-2 text-xs text-[var(--app-fg)]">
            <code>{JSON.stringify(props.part.metadata, null, 2)}</code>
          </pre>
        ) : null}
      </div>
    </CompactEventCard>
  );
}

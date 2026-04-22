import { Info } from "lucide-react";

export function SystemNotice(props: { content: string }) {
  return (
    <div className="flex items-start justify-center gap-2 text-sm text-[var(--app-hint)]">
      <Info size={14} className="mt-0.5 shrink-0" />
      <span className="min-w-0 text-center break-words [overflow-wrap:anywhere]">
        {props.content}
      </span>
    </div>
  );
}

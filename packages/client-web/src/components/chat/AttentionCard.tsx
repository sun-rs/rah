import type { AttentionItem } from "@rah/runtime-protocol";
import { AlertTriangle, Bell, Siren } from "lucide-react";
import { CompactEventCard } from "./CompactEventCard";

function attentionMeta(level: AttentionItem["level"]) {
  switch (level) {
    case "critical":
      return {
        icon: <Siren size={16} className="text-[var(--app-danger)]" />,
        className: "border-[var(--app-danger)]/30 bg-[var(--app-danger)]/10",
      };
    case "warning":
      return {
        icon: <AlertTriangle size={16} className="text-[var(--app-warning)]" />,
        className: "border-[var(--app-warning)]/30 bg-[var(--app-warning)]/10",
      };
    case "info":
    default:
      return {
        icon: <Bell size={16} className="text-[var(--app-hint)]" />,
        className: "border-[var(--app-border)] bg-[var(--app-subtle-bg)]",
      };
  }
}

export function AttentionCard(props: { item: AttentionItem }) {
  const meta = attentionMeta(props.item.level);
  return (
    <CompactEventCard
      label="Attention"
      title={props.item.title}
      subtitle={props.item.body}
      tone={props.item.level === "critical" ? "danger" : props.item.level === "warning" ? "warning" : "default"}
      status={<span className="shrink-0">{meta.icon}</span>}
    />
  );
}

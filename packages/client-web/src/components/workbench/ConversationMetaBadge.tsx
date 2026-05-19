import type { ReactNode } from "react";

export type ConversationMetaTone =
  | "running"
  | "stopped"
  | "working"
  | "permission"
  | "council"
  | "context";

export type ConversationMetaBadgeWidth = "status" | "context";

export function conversationMetaToneClassName(tone: ConversationMetaTone): string {
  switch (tone) {
    case "running":
      return "border-emerald-500/20 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400";
    case "stopped":
      return "border-[var(--app-border)] bg-[var(--app-subtle-bg)] text-[var(--app-hint)]";
    case "working":
      return "border-sky-500/20 bg-sky-500/10 text-sky-600 dark:text-sky-400";
    case "permission":
      return "border-orange-500/20 bg-orange-500/10 text-orange-700 dark:text-orange-400";
    case "council":
      return "border-orange-500/25 bg-orange-500/10 text-orange-700 dark:text-orange-300";
    case "context":
      return "border-[var(--app-border)] bg-[var(--app-bg)] text-[var(--app-hint)]";
  }
}

export function ConversationMetaBadge(props: {
  tone: ConversationMetaTone;
  children: ReactNode;
  title?: string;
  ariaLabel?: string;
  width?: ConversationMetaBadgeWidth;
}) {
  const widthClassName =
    props.width === "context"
      ? "w-[5.75rem]"
      : props.width === "status"
        ? "w-[4.75rem]"
        : "";
  return (
    <span
      className={`inline-flex h-5 shrink-0 items-center justify-center gap-1 overflow-hidden rounded-md border px-1.5 text-[10px] font-medium leading-none ${widthClassName} ${conversationMetaToneClassName(props.tone)}`}
      title={props.title}
      aria-label={props.ariaLabel}
    >
      {props.children}
    </span>
  );
}

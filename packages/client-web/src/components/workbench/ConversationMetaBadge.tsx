import { Fragment, type ReactNode } from "react";
import { Activity, Circle, CircleStop } from "lucide-react";
import type {
  ConversationHeaderState,
  ConversationHeaderStateIcon,
} from "./conversation-header-meta";

export type ConversationMetaTone =
  | "running"
  | "stopped"
  | "working"
  | "permission"
  | "failed"
  | "council"
  | "context";

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
    case "failed":
      return "border-rose-500/25 bg-rose-500/10 text-rose-700 dark:text-rose-400";
    case "council":
      return "border-orange-500/25 bg-orange-500/10 text-orange-700 dark:text-orange-300";
    case "context":
      return "border-[var(--app-border)] bg-[var(--app-bg)] text-[var(--app-hint)]";
  }
}

export const CONVERSATION_META_BADGE_BASE_CLASS =
  "inline-flex h-5 min-w-0 shrink-0 items-center justify-center gap-1 overflow-hidden rounded-md border text-[10px] font-medium leading-[1.2]";
export const CONVERSATION_META_BADGE_PADDING_CLASS = "px-1.5";
export const CONVERSATION_META_BADGE_TRAILING_SPACE_PADDING_CLASS = "pl-1.5 pr-2.5";
export const CONVERSATION_META_BADGE_CLASS =
  `${CONVERSATION_META_BADGE_BASE_CLASS} ${CONVERSATION_META_BADGE_PADDING_CLASS}`;
export const CONVERSATION_META_BADGE_ICON_CLASS =
  "inline-flex h-3 w-3 shrink-0 items-center justify-center leading-none [&>svg]:block";
export const CONVERSATION_META_BADGE_LABEL_CLASS =
  "relative -top-[0.75px] block min-w-0 truncate leading-[12px]";
export const CONVERSATION_META_BADGE_PWA_ICON_CLASS =
  `${CONVERSATION_META_BADGE_ICON_CLASS} relative top-[0.75px]`;
export const CONVERSATION_META_BADGE_PWA_LABEL_CLASS =
  "relative top-[0.75px] block min-w-0 truncate leading-[12px]";
export const CONVERSATION_STATE_META_BADGE_CLASS = "";
export const CONVERSATION_STATE_META_BADGE_ICON_CLASS = CONVERSATION_META_BADGE_ICON_CLASS;
export const CONVERSATION_STATE_META_BADGE_LABEL_CLASS = CONVERSATION_META_BADGE_LABEL_CLASS;

export type ConversationHeaderMetaSlot = "status" | "context" | "count" | "source";

export type ConversationHeaderMetaItem = {
  slot: ConversationHeaderMetaSlot;
  node: ReactNode;
};

export const CONVERSATION_HEADER_META_ORDER: readonly ConversationHeaderMetaSlot[] = [
  "status",
  "context",
  "count",
  "source",
];

const CONVERSATION_HEADER_META_ORDER_INDEX = new Map(
  CONVERSATION_HEADER_META_ORDER.map((slot, index) => [slot, index]),
);

export function orderConversationHeaderMetaItems(
  items: readonly ConversationHeaderMetaItem[],
): ConversationHeaderMetaItem[] {
  return [...items].sort((left, right) => {
    const leftIndex = CONVERSATION_HEADER_META_ORDER_INDEX.get(left.slot) ?? Number.MAX_SAFE_INTEGER;
    const rightIndex = CONVERSATION_HEADER_META_ORDER_INDEX.get(right.slot) ?? Number.MAX_SAFE_INTEGER;
    return leftIndex - rightIndex;
  });
}

export function ConversationHeaderMetaList(props: {
  items: readonly ConversationHeaderMetaItem[];
}) {
  return (
    <>
      {orderConversationHeaderMetaItems(props.items).map((item) => (
        <Fragment key={item.slot}>{item.node}</Fragment>
      ))}
    </>
  );
}

export function ConversationHeaderStateIconView(props: { icon: ConversationHeaderStateIcon }) {
  switch (props.icon) {
    case "running":
      return <Circle size={6} className="fill-current" />;
    case "activity":
      return <Activity size={10} />;
    case "stopped":
      return <CircleStop size={10} />;
  }
  return null;
}

export function ConversationMetaBadge(props: {
  tone: ConversationMetaTone;
  children?: ReactNode;
  icon?: ReactNode;
  label?: ReactNode;
  title?: string;
  ariaLabel?: string;
  paddingClassName?: string;
  iconClassName?: string;
  labelClassName?: string;
  className?: string;
}) {
  const paddingClassName = props.paddingClassName ?? CONVERSATION_META_BADGE_PADDING_CLASS;
  const iconClassName = props.iconClassName ?? CONVERSATION_META_BADGE_ICON_CLASS;
  const labelClassName = props.labelClassName ?? CONVERSATION_META_BADGE_LABEL_CLASS;
  return (
    <span
      className={`${CONVERSATION_META_BADGE_BASE_CLASS} ${paddingClassName} ${conversationMetaToneClassName(props.tone)} ${props.className ?? ""}`}
      title={props.title}
      aria-label={props.ariaLabel}
    >
      {props.icon ? (
        <span className={iconClassName}>{props.icon}</span>
      ) : null}
      {props.label !== undefined ? (
        <span className={labelClassName}>{props.label}</span>
      ) : null}
      {props.children}
    </span>
  );
}

export function ConversationStateMetaBadge(props: {
  state: ConversationHeaderState;
  iconClassName?: string;
  labelClassName?: string;
}) {
  return (
    <ConversationMetaBadge
      tone={props.state.tone}
      title={props.state.title}
      ariaLabel={props.state.title}
      icon={<ConversationHeaderStateIconView icon={props.state.icon} />}
      label={props.state.label}
      paddingClassName={CONVERSATION_META_BADGE_TRAILING_SPACE_PADDING_CLASS}
      {...(props.iconClassName ? { iconClassName: props.iconClassName } : {})}
      {...(props.labelClassName ? { labelClassName: props.labelClassName } : {})}
    />
  );
}

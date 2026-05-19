import type { ReactNode } from "react";
import { Info, Rows3, Trash2 } from "lucide-react";

export type ChatBrowserRowBadge = {
  label: string;
  title?: string | undefined;
  tone?: "neutral" | "running" | undefined;
  className?: string | undefined;
};

export type ChatBrowserRowMeta = {
  label: string;
  title?: string | undefined;
  icon?: ReactNode | undefined;
};

function badgeClassName(badge: ChatBrowserRowBadge): string {
  if (badge.className) {
    return badge.className;
  }
  if (badge.tone === "running") {
    return "border-emerald-500/20 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400";
  }
  return "border-[var(--app-border)] bg-[var(--app-bg)] text-[var(--app-hint)]";
}

export function ChatBrowserRow(props: {
  title: string;
  subtitle?: string | null | undefined;
  detail?: string | null | undefined;
  leading: ReactNode;
  selected?: boolean | undefined;
  badge?: ChatBrowserRowBadge | null | undefined;
  meta?: ChatBrowserRowMeta | null | undefined;
  timeLabel?: string | null | undefined;
  onOpen: () => void;
  onInfo?: (() => void) | undefined;
  infoLabel?: string | undefined;
  onDelete?: (() => void) | undefined;
  deleteLabel?: string | undefined;
  deleteDisabled?: boolean | undefined;
  actions?: ReactNode | undefined;
  dataSessionId?: string | undefined;
  dataProviderSessionId?: string | undefined;
  dataSessionSource?: string | undefined;
}) {
  const rowClassName = `w-full rounded-lg border px-3 py-2 text-[var(--app-hint)] transition-colors ${
    props.selected
      ? "border-[var(--app-border)] bg-[var(--app-subtle-bg)] text-[var(--app-fg)]"
      : "border-transparent hover:border-[var(--app-border)] hover:bg-[var(--app-bg)]"
  }`;
  const badge = props.badge;
  const meta = props.meta;

  return (
    <div
      className={rowClassName}
      data-session-id={props.dataSessionId}
      data-provider-session-id={props.dataProviderSessionId}
      data-session-source={props.dataSessionSource}
    >
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3">
        <button
          type="button"
          onClick={props.onOpen}
          data-session-id={props.dataSessionId}
          data-provider-session-id={props.dataProviderSessionId}
          data-session-source={props.dataSessionSource}
          className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-2 rounded-md text-left focus:outline-none focus:ring-1 focus:ring-[var(--ring)]"
        >
          <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center overflow-hidden">
            {props.leading}
          </span>
          <span className="min-w-0">
            <span className="block truncate text-sm font-medium leading-5 text-[var(--app-fg)]" title={props.title}>
              {props.title}
            </span>
            {props.subtitle ? (
              <span className="mt-1 block truncate text-xs leading-4 text-[var(--app-hint)]" title={props.subtitle}>
                {props.subtitle}
              </span>
            ) : null}
            {props.detail ? (
              <span className="mt-1 block truncate text-xs leading-4 text-[var(--app-hint)]" title={props.detail}>
                {props.detail}
              </span>
            ) : null}
          </span>
        </button>

        <div className="flex shrink-0 items-center justify-end gap-2">
          {badge ? (
            <span
              className={`inline-flex rounded-full border px-2 py-0.5 text-[11px] font-medium ${badgeClassName(badge)}`}
              title={badge.title}
            >
              {badge.label}
            </span>
          ) : null}
          {meta ? (
            <span
              className="inline-flex items-center gap-1 rounded-full border border-[var(--app-border)] bg-[var(--app-subtle-bg)] px-2 py-0.5 text-[11px] font-medium tabular-nums text-[var(--app-hint)]"
              title={meta.title}
            >
              <span className="inline-flex h-3 w-3 items-center justify-center">
                {meta.icon ?? <Rows3 size={12} />}
              </span>
              <span>{meta.label}</span>
            </span>
          ) : null}
          {props.timeLabel ? (
            <span className="min-w-[3.5rem] text-right text-xs text-[var(--app-hint)]">
              {props.timeLabel}
            </span>
          ) : null}
          {props.actions ?? null}
          {!props.actions && props.onInfo ? (
            <button
              type="button"
              onClick={props.onInfo}
              className="icon-click-feedback inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-transparent text-[var(--app-hint)] transition-colors hover:border-[var(--app-border)] hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)]"
              aria-label={props.infoLabel ?? "Show chat info"}
              title={props.infoLabel ?? "Info"}
            >
              <Info size={14} />
            </button>
          ) : null}
          {!props.actions && props.onDelete ? (
            <button
              type="button"
              disabled={props.deleteDisabled}
              onClick={props.onDelete}
              className="icon-click-feedback inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-transparent text-[var(--app-hint)] transition-colors hover:border-[var(--app-border)] hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-danger)] disabled:opacity-40"
              aria-label={props.deleteLabel ?? "Delete chat"}
              title={props.deleteLabel ?? "Delete"}
            >
              <Trash2 size={14} />
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

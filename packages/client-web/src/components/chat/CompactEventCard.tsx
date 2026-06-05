import { ChevronDown, ChevronRight } from "lucide-react";
import { useState } from "react";

export function CompactEventCard(props: {
  label: string;
  title: string;
  subtitle?: string;
  icon?: React.ReactNode;
  status?: React.ReactNode;
  tone?: "default" | "warning" | "danger";
  hideLabel?: boolean;
  defaultOpen?: boolean;
  footer?: React.ReactNode;
  onExpand?: () => void;
  children?: React.ReactNode;
}) {
  const [open, setOpen] = useState(props.defaultOpen ?? false);
  const expandable = props.children !== undefined && props.children !== null;
  const showLabel = !props.hideLabel;
  const toneClassName =
    props.tone === "danger"
      ? "border-[var(--app-danger)] bg-[var(--app-danger-bg)]"
      : props.tone === "warning"
        ? "border-[var(--app-warning)] bg-[var(--app-warning-bg)]"
        : "border-[var(--app-border)] bg-[var(--app-subtle-bg)]";

  return (
    <div className="flex items-start justify-start gap-3">
      <div className={`w-full max-w-full rounded-lg border ${toneClassName}`}>
        <button
          type="button"
          disabled={!expandable}
          onClick={() => {
            if (expandable) {
              setOpen((value) => {
                const next = !value;
                if (next) {
                  props.onExpand?.();
                }
                return next;
              });
            }
          }}
          className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left disabled:cursor-default"
        >
          <div className="min-w-0 flex-1">
            {showLabel ? (
              <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--app-hint)]">
                {props.label}
              </div>
            ) : null}
            <div
              className={`${showLabel ? "mt-0.5" : ""} flex min-w-0 items-center gap-2 text-[13px] font-medium leading-5 text-[var(--app-fg)]`}
            >
              {props.icon ? <span className="shrink-0 text-[var(--app-hint)]">{props.icon}</span> : null}
              <span className="truncate">{props.title}</span>
            </div>
            {props.subtitle ? (
              <div className="mt-0.5 truncate text-[11px] leading-4 text-[var(--app-hint)]">
                {props.subtitle}
              </div>
            ) : null}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {props.status}
            {expandable ? (
              <div className="text-[var(--app-hint)]">
                {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              </div>
            ) : null}
          </div>
        </button>
        {props.footer ? (
          <div className="border-t border-[var(--app-border)] px-3 py-2.5">
            {props.footer}
          </div>
        ) : null}
        {expandable && open ? (
          <div className="border-t border-[var(--app-border)] px-3 py-2.5">{props.children}</div>
        ) : null}
      </div>
    </div>
  );
}

import type { ReactNode } from "react";
import { AlertTriangle, Info, RefreshCcw, X } from "lucide-react";

export function StatusCallout(props: {
  tone?: "info" | "warning" | "danger";
  title: string;
  body: string;
  primaryLabel?: string;
  onPrimary?: () => void;
  secondaryLabel?: string;
  onSecondary?: () => void;
  icon?: ReactNode;
}) {
  const tone = props.tone ?? "info";
  const className =
    tone === "danger"
      ? "border-[var(--app-danger)] bg-[var(--app-danger-bg)]"
      : tone === "warning"
        ? "border-[var(--app-warning)] bg-[var(--app-warning-bg)]"
        : "border-[var(--app-border)] bg-[var(--app-subtle-bg)]";
  const icon =
    props.icon ??
    (tone === "danger" || tone === "warning" ? (
      <AlertTriangle size={16} className="text-[var(--app-warning)]" />
    ) : (
      <Info size={16} className="text-[var(--app-hint)]" />
    ));

  return (
    <div className={`rounded-xl border px-4 py-3 shadow-lg ${className}`}>
      <div className="flex items-start gap-3">
        <div className="mt-0.5 shrink-0">{icon}</div>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-[var(--app-fg)]">{props.title}</div>
          <div className="mt-1 text-sm text-[var(--app-hint)] break-words [overflow-wrap:anywhere]">
            {props.body}
          </div>
          {props.onPrimary || props.onSecondary ? (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              {props.onPrimary && props.primaryLabel ? (
                <button
                  type="button"
                  className="inline-flex items-center gap-2 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90 transition-colors"
                  onClick={props.onPrimary}
                >
                  <RefreshCcw size={12} />
                  <span>{props.primaryLabel}</span>
                </button>
              ) : null}
              {props.onSecondary && props.secondaryLabel ? (
                <button
                  type="button"
                  className="inline-flex items-center gap-2 rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] px-3 py-1.5 text-xs font-medium text-[var(--app-fg)] hover:bg-[var(--app-subtle-bg)] transition-colors"
                  onClick={props.onSecondary}
                >
                  <X size={12} />
                  <span>{props.secondaryLabel}</span>
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

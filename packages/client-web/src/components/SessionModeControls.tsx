import { Shield } from "lucide-react";
import type { SessionModeChoice } from "../session-mode-ui";

export function SessionModeControls(props: {
  accessModes: SessionModeChoice[];
  selectedAccessModeId: string | null;
  planModeAvailable: boolean;
  planModeEnabled: boolean;
  disabled?: boolean;
  compact?: boolean;
  variant?: "compact" | "toolbar";
  onAccessModeChange: (modeId: string) => void;
  onPlanModeToggle: (enabled: boolean) => void;
}) {
  if (props.accessModes.length === 0 && !props.planModeAvailable) {
    return null;
  }
  const variant = props.variant ?? (props.compact ? "compact" : "toolbar");
  const compact = variant === "compact";
  const compactControlClassName =
    "h-8 rounded-md border border-[var(--app-border)] bg-[var(--app-subtle-bg)] px-2 text-[11px] text-[var(--app-fg)]";
  const toolbarAccessClassName =
    "relative inline-flex h-8 md:h-9 w-8 md:w-[6.75rem] shrink-0 items-center justify-center md:justify-start gap-1.5 rounded-full border border-[var(--app-border)] bg-[var(--app-bg)]/90 px-0 md:px-2 text-[11px] text-[var(--app-fg)] transition-colors hover:bg-[var(--app-subtle-bg)]";
  const showAccessSelect = props.accessModes.length > 0;
  const selectedAccessLabel =
    props.accessModes.find((mode) => mode.id === props.selectedAccessModeId)?.label ?? "Access";

  return (
    <div className={`flex items-center gap-1.5 ${compact ? "min-h-8" : "min-h-8 md:min-h-9"}`}>
      {showAccessSelect ? (
        variant === "compact" ? (
          <label className="flex items-center gap-2 text-[11px] text-[var(--app-hint)]">
            <span className="sr-only">Access mode</span>
            <Shield size={13} className="text-[var(--app-hint)]" />
            <select
              value={props.selectedAccessModeId ?? ""}
              disabled={props.disabled}
              onChange={(event) => props.onAccessModeChange(event.target.value)}
              className={`${compactControlClassName} min-w-[6.25rem] max-w-[7.5rem]`}
            >
              {props.accessModes.map((mode) => (
                <option key={mode.id} value={mode.id}>
                  {mode.label}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <label className={toolbarAccessClassName} title={selectedAccessLabel}>
            <span className="sr-only">Access mode</span>
            <Shield size={12} className="shrink-0 text-[var(--app-hint)]" />
            {props.accessModes.length > 1 ? (
              <select
                value={props.selectedAccessModeId ?? ""}
                disabled={props.disabled}
                onChange={(event) => props.onAccessModeChange(event.target.value)}
                className="absolute inset-0 cursor-pointer opacity-0 md:static md:inset-auto md:min-w-0 md:flex-1 md:appearance-none md:bg-transparent md:text-[11px] md:text-[var(--app-fg)] md:opacity-100 md:focus:outline-none"
              >
                {props.accessModes.map((mode) => (
                  <option key={mode.id} value={mode.id}>
                    {mode.label}
                  </option>
                ))}
              </select>
            ) : (
              <span className="hidden min-w-0 flex-1 truncate md:block">
                {selectedAccessLabel}
              </span>
            )}
          </label>
        )
      ) : null}
      {props.planModeAvailable ? (
        variant === "compact" ? (
          <button
            type="button"
            disabled={props.disabled}
            onClick={() => props.onPlanModeToggle(!props.planModeEnabled)}
            className={`${compactControlClassName} inline-flex items-center gap-1.5 ${props.planModeEnabled ? "border-sky-500/40 text-sky-600 dark:text-sky-400" : "text-[var(--app-hint)]"}`}
            aria-pressed={props.planModeEnabled}
            title="Toggle plan mode"
          >
            <span>Plan</span>
          </button>
        ) : (
          <button
            type="button"
            disabled={props.disabled}
            onClick={() => props.onPlanModeToggle(!props.planModeEnabled)}
            className={`inline-flex h-8 md:h-9 w-10 md:w-14 shrink-0 items-center justify-center rounded-full text-[11px] transition-colors ${
              props.planModeEnabled
                ? "bg-sky-500/12 font-semibold text-sky-700 dark:text-sky-300"
                : "font-medium text-[var(--app-hint)] hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)]"
            }`}
            aria-pressed={props.planModeEnabled}
            title="Toggle plan mode"
          >
            Plan
          </button>
        )
      ) : null}
    </div>
  );
}

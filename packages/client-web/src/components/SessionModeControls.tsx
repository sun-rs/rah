import { Shield, ToggleLeft, ToggleRight } from "lucide-react";
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
  const toolbarPillClassName =
    "inline-flex h-8 md:h-9 items-center gap-1.5 rounded-full border border-[var(--app-border)] bg-[var(--app-bg)]/90 pl-2 pr-2 text-[11px] text-[var(--app-fg)] transition-colors hover:bg-[var(--app-subtle-bg)]";
  const showAccessSelect = props.accessModes.length > 1;
  const selectedAccessLabel =
    props.accessModes.find((mode) => mode.id === props.selectedAccessModeId)?.label ?? "Access";
  const toolbarSelectWidthRem = Math.min(
    Math.max(selectedAccessLabel.length * 0.5 + 0.9, 3.5),
    5.6,
  );

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
          <label className={toolbarPillClassName}>
            <span className="sr-only">Access mode</span>
            <Shield size={12} className="shrink-0 text-[var(--app-hint)]" />
            <select
              value={props.selectedAccessModeId ?? ""}
              disabled={props.disabled}
              onChange={(event) => props.onAccessModeChange(event.target.value)}
              className="appearance-none bg-transparent text-[11px] text-[var(--app-fg)] focus:outline-none"
              style={{ width: `${toolbarSelectWidthRem}rem` }}
            >
              {props.accessModes.map((mode) => (
                <option key={mode.id} value={mode.id}>
                  {mode.label}
                </option>
              ))}
            </select>
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
            {props.planModeEnabled ? <ToggleRight size={14} /> : <ToggleLeft size={14} />}
            <span>Plan</span>
          </button>
        ) : (
          <button
            type="button"
            disabled={props.disabled}
            onClick={() => props.onPlanModeToggle(!props.planModeEnabled)}
            className={`inline-flex h-8 md:h-9 items-center gap-1.5 rounded-full px-2.5 text-[11px] transition-colors ${
              props.planModeEnabled
                ? "bg-sky-500/12 text-sky-700 dark:text-sky-300"
                : "bg-[var(--app-subtle-bg)]/95 text-[var(--app-hint)] hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)]"
            }`}
            aria-pressed={props.planModeEnabled}
            title="Toggle plan mode"
          >
            <span className={`font-medium ${props.planModeEnabled ? "tracking-[0.01em]" : ""}`}>Plan</span>
            <span
              className={`rounded-full px-1.5 py-0.5 text-[10px] leading-none ${
                props.planModeEnabled
                  ? "bg-sky-500/14 text-sky-700 dark:text-sky-300"
                  : "bg-[var(--app-bg)]/80 text-[var(--app-hint)]"
              }`}
            >
              {props.planModeEnabled ? "On" : "Off"}
            </span>
          </button>
        )
      ) : null}
    </div>
  );
}

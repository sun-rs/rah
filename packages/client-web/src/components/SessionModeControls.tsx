import { Shield, ToggleLeft, ToggleRight } from "lucide-react";
import type { SessionModeChoice } from "../session-mode-ui";

export function SessionModeControls(props: {
  accessModes: SessionModeChoice[];
  selectedAccessModeId: string | null;
  planModeAvailable: boolean;
  planModeEnabled: boolean;
  disabled?: boolean;
  compact?: boolean;
  onAccessModeChange: (modeId: string) => void;
  onPlanModeToggle: (enabled: boolean) => void;
}) {
  if (props.accessModes.length === 0 && !props.planModeAvailable) {
    return null;
  }
  const compact = props.compact ?? false;
  const controlClassName = compact
    ? "h-8 rounded-md border border-[var(--app-border)] bg-[var(--app-subtle-bg)] px-2 text-[11px] text-[var(--app-fg)]"
    : "h-10 rounded-xl border border-[var(--app-border)] bg-[var(--app-subtle-bg)] px-3 text-sm text-[var(--app-fg)]";
  const showAccessSelect = props.accessModes.length > 1;

  return (
    <div className={`flex items-center gap-2 ${compact ? "min-h-8" : "min-h-10"}`}>
      {showAccessSelect ? (
        <label className={`flex items-center gap-2 ${compact ? "text-[11px]" : "text-xs"} text-[var(--app-hint)]`}>
          <span className="sr-only">Access mode</span>
          <Shield size={compact ? 13 : 14} className="text-[var(--app-hint)]" />
          <select
            value={props.selectedAccessModeId ?? ""}
            disabled={props.disabled}
            onChange={(event) => props.onAccessModeChange(event.target.value)}
            className={controlClassName}
          >
            {props.accessModes.map((mode) => (
              <option key={mode.id} value={mode.id}>
                {mode.label}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {props.planModeAvailable ? (
        <button
          type="button"
          disabled={props.disabled}
          onClick={() => props.onPlanModeToggle(!props.planModeEnabled)}
          className={`${controlClassName} inline-flex items-center gap-1.5 ${props.planModeEnabled ? "border-sky-500/40 text-sky-600 dark:text-sky-400" : "text-[var(--app-hint)]"}`}
          aria-pressed={props.planModeEnabled}
          title="Toggle plan mode"
        >
          {props.planModeEnabled ? <ToggleRight size={compact ? 14 : 16} /> : <ToggleLeft size={compact ? 14 : 16} />}
          <span>{compact ? "Plan" : props.planModeEnabled ? "Plan on" : "Plan off"}</span>
        </button>
      ) : null}
    </div>
  );
}

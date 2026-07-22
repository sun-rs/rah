import type { ReactNode } from "react";
import { Search } from "lucide-react";

export function InspectorFileFilter(props: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  ariaLabel?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="flex -translate-y-px items-center gap-2">
      <label className="relative min-w-0 flex-1">
        <Search
          size={14}
          className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--app-hint)]"
        />
        <input
          type="search"
          value={props.value}
          onChange={(event) => props.onChange(event.currentTarget.value)}
          placeholder={props.placeholder ?? "Filter files…"}
          aria-label={props.ariaLabel ?? "Filter files"}
          className="h-8 w-full rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] pl-8 pr-3 text-[13px] text-[var(--app-fg)] placeholder:text-[var(--app-hint)] focus:outline-none"
          autoCapitalize="none"
          autoCorrect="off"
        />
      </label>
      {props.actions}
    </div>
  );
}

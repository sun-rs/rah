import type { ReactNode } from "react";
import { ChevronUp } from "lucide-react";

export function DirectoryPathBackRow(props: {
  path: string;
  canGoUp: boolean;
  leadingIcon?: ReactNode;
  onGoUp: () => void;
}) {
  return (
    <div className="border-b border-[var(--app-border)] bg-[var(--app-subtle-bg)] px-3 py-2 shrink-0">
      <button
        type="button"
        onClick={props.onGoUp}
        disabled={!props.canGoUp}
        className="icon-click-feedback flex h-9 w-full min-w-0 items-center gap-2 rounded-lg px-2 text-left text-[var(--app-fg)] transition-colors hover:bg-[var(--app-bg)] disabled:cursor-default disabled:opacity-55 disabled:hover:bg-transparent"
        aria-label={`Go up from ${props.path}`}
        title={props.canGoUp ? "Go up" : props.path}
      >
        <ChevronUp size={16} className="shrink-0 text-[var(--app-hint)]" />
        {props.leadingIcon}
        <span className="min-w-0 truncate text-sm font-medium" title={props.path}>
          {props.path}
        </span>
      </button>
    </div>
  );
}

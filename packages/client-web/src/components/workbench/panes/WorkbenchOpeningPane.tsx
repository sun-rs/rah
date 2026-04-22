import type { PendingSessionTransition } from "../../../session-transition-contract";
import { LoaderCircle, Menu } from "lucide-react";
import { ProviderLogo } from "../../ProviderLogo";
import { providerLabel } from "../../../types";

export function WorkbenchOpeningPane(props: {
  openingSession: PendingSessionTransition;
  sidebarOpen: boolean;
  onOpenLeft: () => void;
  onExpandSidebar: () => void;
}) {
  return (
    <>
      <header className="h-14 flex items-center justify-between gap-3 border-b border-[var(--app-border)] px-4 bg-[var(--app-bg)]/80 backdrop-blur-sm shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <button
            type="button"
            className="inline-flex h-8 w-8 items-center justify-center rounded-md text-[var(--app-hint)] hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)] transition-colors md:hidden"
            onClick={props.onOpenLeft}
            aria-label="Open sidebar"
          >
            <Menu size={18} />
          </button>
          {!props.sidebarOpen && (
            <button
              type="button"
              className="hidden md:inline-flex h-7 w-7 items-center justify-center rounded-md text-[var(--app-hint)] hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)] transition-colors"
              onClick={props.onExpandSidebar}
              aria-label="Expand sidebar"
              title="Expand sidebar"
            >
              <Menu size={16} />
            </button>
          )}
          <div className="min-w-0">
            <div className="text-sm font-medium text-[var(--app-fg)]">
              {props.openingSession.kind === "new"
                ? "Starting session"
                : props.openingSession.kind === "claim_history"
                  ? "Claiming history session"
                  : "Opening history session"}
            </div>
            <div className="text-[11px] text-[var(--app-hint)]">
              Preparing content…
            </div>
          </div>
        </div>
      </header>
      <div className="flex-1 overflow-y-auto custom-scrollbar">
        <div className="mx-auto flex min-h-full w-full max-w-2xl items-center justify-center px-6 py-8 md:px-10 md:py-12">
          <div className="w-full rounded-3xl border border-[var(--app-border)] bg-[var(--app-bg)] px-6 py-8 text-center shadow-sm md:px-12 md:py-14">
            <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-[var(--app-subtle-bg)] md:h-20 md:w-20">
              <ProviderLogo provider={props.openingSession.provider} className="h-8 w-8 md:h-12 md:w-12" />
            </div>
            <div className="mt-4 inline-flex items-center gap-2 rounded-full border border-[var(--app-border)] bg-[var(--app-subtle-bg)] px-3 py-1 text-xs font-medium text-[var(--app-hint)] md:mt-6 md:px-4 md:py-1.5 md:text-sm">
              <LoaderCircle size={14} className="animate-spin md:h-4 md:w-4" />
              <span>
                {props.openingSession.kind === "new"
                  ? "Starting…"
                  : props.openingSession.kind === "claim_history"
                    ? "Claiming…"
                    : "Opening…"}
              </span>
            </div>
            <div className="mt-4 text-lg font-semibold text-[var(--app-fg)] md:mt-8 md:text-3xl md:tracking-tight">
              {props.openingSession.title ??
                (props.openingSession.kind === "new"
                  ? `${providerLabel(props.openingSession.provider)} session`
                  : "History session")}
            </div>
            <div className="mx-auto mt-2 max-w-md text-sm text-[var(--app-hint)] md:mt-4 md:max-w-lg md:text-base md:leading-7">
              {props.openingSession.kind === "new"
                ? `Launching ${providerLabel(props.openingSession.provider)} and preparing the workspace.`
                : props.openingSession.kind === "claim_history"
                  ? `Claiming ${providerLabel(props.openingSession.provider)} session for live control and rebuilding the timeline.`
                  : `Restoring ${providerLabel(props.openingSession.provider)} session and rebuilding the timeline.`}
            </div>
            {props.openingSession.cwd ? (
              <div className="mx-auto mt-4 max-w-lg rounded-2xl bg-[var(--app-subtle-bg)] px-4 py-3 text-left md:mt-8 md:px-6 md:py-5">
                <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--app-hint)] md:text-xs">
                  Workspace
                </div>
                <div className="mt-1 truncate text-sm text-[var(--app-fg)] md:mt-2 md:text-base" title={props.openingSession.cwd}>
                  {props.openingSession.cwd}
                </div>
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </>
  );
}

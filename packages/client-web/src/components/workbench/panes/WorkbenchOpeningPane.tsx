import type { PendingSessionTransition } from "../../../session-transition-contract";
import { LoaderCircle } from "lucide-react";
import { ProviderLogo } from "../../ProviderLogo";
import { providerLabel } from "../../../types";
import { ConversationHeader } from "../shells/ConversationHeader";

export function WorkbenchOpeningPane(props: {
  openingSession: PendingSessionTransition;
  sidebarOpen: boolean;
  onOpenLeft: () => void;
  onExpandSidebar: () => void;
  showLeftSidebarControls?: boolean;
}) {
  const showLeftSidebarControls = props.showLeftSidebarControls ?? true;
  const openingLabel =
    props.openingSession.kind === "new"
      ? "Starting session"
      : props.openingSession.kind === "resume_history"
        ? "Resuming session"
        : "Opening history session";
  const progressLabel =
    props.openingSession.kind === "new"
      ? "Starting"
      : props.openingSession.kind === "resume_history"
        ? "Resuming"
        : "Opening";
  const sessionTitle =
    props.openingSession.title ??
    (props.openingSession.kind === "new"
      ? `${providerLabel(props.openingSession.provider)} session`
      : "History session");
  return (
    <>
      <ConversationHeader
        title={openingLabel}
        titleText={openingLabel}
        identity={
          <ProviderLogo provider={props.openingSession.provider} className="h-5 w-5" />
        }
        meta="Preparing content…"
        sidebarOpen={props.sidebarOpen}
        showLeftSidebarControls={showLeftSidebarControls}
        onOpenLeft={props.onOpenLeft}
        onExpandSidebar={props.onExpandSidebar}
      />
      <div className="flex-1 overflow-y-auto rah-scroll-panel rah-scroll-panel-y">
        <div className="mx-auto flex min-h-full w-full max-w-2xl items-center px-5 py-8 min-[700px]:px-8">
          <div className="w-full py-6">
            <div className="flex items-start gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-[var(--app-subtle-bg)]">
                <ProviderLogo provider={props.openingSession.provider} className="h-6 w-6" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-base font-semibold text-[var(--app-fg)]" title={sessionTitle}>
                  {sessionTitle}
                </div>
                <div className="mt-1 inline-flex items-center gap-1.5 text-sm text-[var(--app-hint)]">
                  <LoaderCircle size={13} className="shrink-0 animate-spin" />
                  <span>{progressLabel} {providerLabel(props.openingSession.provider)} session…</span>
                </div>
              </div>
            </div>
            <div className="mt-5 border-t border-[var(--app-border)] pt-4 text-sm leading-6 text-[var(--app-hint)]">
              {props.openingSession.kind === "new"
                ? `Launching ${providerLabel(props.openingSession.provider)} and preparing the workspace.`
                : props.openingSession.kind === "resume_history"
                  ? "Reconnecting to the provider while keeping the loaded conversation in place."
                  : "Loading the initial conversation window and session metadata."}
            </div>
            {props.openingSession.cwd ? (
              <div className="mt-3 flex min-w-0 items-baseline gap-2 text-xs">
                <span className="shrink-0 font-medium text-[var(--app-hint)]">Workspace</span>
                <div className="min-w-0 truncate font-mono text-[var(--app-fg)]" title={props.openingSession.cwd}>
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

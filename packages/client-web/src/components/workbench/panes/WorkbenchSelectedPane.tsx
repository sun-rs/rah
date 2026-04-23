import { useEffect, useRef, type RefObject } from "react";
import type { PermissionResponseRequest, SessionSummary } from "@rah/runtime-protocol";
import { Archive, ArrowUp, Menu, PanelRight, Plus, Square, X } from "lucide-react";
import { providerLabel } from "../../../types";
import type { SessionProjection } from "../../../types";
import { ChatThread } from "../../chat/ChatThread";
import { ProviderLogo } from "../../ProviderLogo";
import { TokenizedTextarea } from "../../TokenizedTextarea";
import { COMPOSER_LAYOUT, type ComposerSurface } from "../../../composer-contract";
import type { InlineWorkbenchNotice } from "../../../workbench-notice-contract";

export function WorkbenchSelectedPane(props: {
  selectedSummary: SessionSummary;
  selectedProjection: SessionProjection | null;
  selectedIsReadOnlyReplay: boolean;
  sidebarOpen: boolean;
  rightSidebarOpen: boolean;
  isAttached: boolean;
  interactionNotice: InlineWorkbenchNotice | null;
  historyNotice: InlineWorkbenchNotice | null;
  hideToolCallsInChat: boolean;
  canLoadOlderHistory: boolean;
  historyLoading: boolean;
  canRespondToPermission: boolean;
  onPermissionRespond: (requestId: string, response: PermissionResponseRequest) => void;
  composerSurface: ComposerSurface;
  composerRef: RefObject<HTMLTextAreaElement | null>;
  draft: string;
  sendPending: boolean;
  onDraftChange: (value: string) => void;
  onSend: () => void;
  onClaimHistory: () => void;
  onClaimControl: () => void;
  onInterrupt: () => void;
  onOpenFileReference: () => void;
  onLoadOlderHistory: () => void;
  onOpenLeft: () => void;
  onExpandSidebar: () => void;
  onOpenRight: () => void;
  onExpandInspector: () => void;
  onFloatingAnchorOffsetChange: (offsetPx: number) => void;
  onArchiveOrClose: () => void;
}) {
  const composerContainerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const node = composerContainerRef.current;
    if (!node) {
      return;
    }

    const updateAnchor = () => {
      props.onFloatingAnchorOffsetChange(Math.ceil(node.getBoundingClientRect().height) + 12);
    };

    updateAnchor();
    if (typeof ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver(updateAnchor);
    observer.observe(node);
    return () => {
      observer.disconnect();
    };
  }, [props.onFloatingAnchorOffsetChange]);

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
          <ProviderLogo provider={props.selectedSummary.session.provider} className="h-6 w-6" />
          <div className="min-w-0">
            <div className="text-sm font-medium truncate text-[var(--app-fg)]">
              {props.selectedSummary.session.title ?? props.selectedSummary.session.id}
            </div>
            <div className="flex items-center gap-2 text-[11px] md:text-xs text-[var(--app-hint)] mt-0.5">
              <span className="capitalize hidden sm:inline">{providerLabel(props.selectedSummary.session.provider)}</span>
              <span className="hidden sm:inline">·</span>
              <span>{props.selectedSummary.session.runtimeState}</span>
              {props.selectedIsReadOnlyReplay ? (
                <>
                  <span className="hidden sm:inline">·</span>
                  <span className="inline-flex rounded-full border border-[var(--app-border)] bg-[var(--app-subtle-bg)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--app-hint)]">
                    History
                  </span>
                </>
              ) : (
                <>
                  <span className="hidden sm:inline">·</span>
                  <span className="inline-flex rounded-full border border-emerald-500/20 bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-medium text-emerald-600 dark:text-emerald-400">
                    Live
                  </span>
                </>
              )}
              {props.selectedSummary.usage?.percentRemaining !== undefined ? (
                <>
                  <span className="hidden sm:inline">·</span>
                  <span className="hidden sm:inline">{props.selectedSummary.usage.percentRemaining}% context</span>
                </>
              ) : null}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <button
            type="button"
            className="inline-flex h-8 items-center justify-center rounded-md border border-[var(--app-border)] px-2 text-xs text-[var(--app-hint)] hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)] disabled:opacity-40 transition-colors"
            disabled={!props.isAttached}
            onClick={props.onArchiveOrClose}
            title={
              !props.isAttached
                ? "This client is not attached"
                : props.selectedIsReadOnlyReplay
                  ? "Close this history view"
                  : "Archive this live session"
            }
          >
            {props.selectedIsReadOnlyReplay ? (
              <>
                <X size={14} className="mr-1" />
                <span>Close</span>
              </>
            ) : (
              <>
                <Archive size={14} className="mr-1" />
                <span>Archive</span>
              </>
            )}
          </button>
          {!props.rightSidebarOpen && (
            <button
              type="button"
              className="hidden md:inline-flex h-7 w-7 items-center justify-center rounded-md text-[var(--app-hint)] hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)] transition-colors"
              onClick={props.onExpandInspector}
              aria-label="Expand inspector"
              title="Expand inspector"
            >
              <PanelRight size={16} />
            </button>
          )}
          <button
            type="button"
            className="inline-flex h-8 w-8 items-center justify-center rounded-md text-[var(--app-hint)] hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)] transition-colors md:hidden"
            onClick={props.onOpenRight}
            aria-label="Open inspector"
          >
            <PanelRight size={18} />
          </button>
        </div>
      </header>

      {props.interactionNotice ? (
        <div className="shrink-0 border-b border-[var(--app-border)] bg-[var(--app-subtle-bg)] px-4 py-3 text-sm text-[var(--app-hint)]">
          {props.interactionNotice.message}
        </div>
      ) : null}
      {props.historyNotice ? (
        <div className="shrink-0 border-b border-[var(--app-border)] bg-[var(--app-subtle-bg)] px-4 py-2 text-xs text-[var(--app-hint)]">
          {props.historyNotice.message}
        </div>
      ) : null}

      <ChatThread
        key={props.selectedSummary.session.id}
        sessionId={props.selectedSummary.session.id}
        feed={props.selectedProjection?.feed ?? []}
        hideToolCalls={props.hideToolCallsInChat}
        canLoadOlderHistory={props.canLoadOlderHistory}
        historyLoading={props.historyLoading}
        onLoadOlderHistory={props.onLoadOlderHistory}
        canRespondToPermission={props.canRespondToPermission}
        onPermissionRespond={props.onPermissionRespond}
      />

      <div
        ref={composerContainerRef}
        className="shrink-0 bg-[var(--app-bg)] px-3 pt-2 md:px-4 md:pt-3"
        style={COMPOSER_LAYOUT.bottomPaddingStyle}
      >
        {props.composerSurface.kind === "history_claim" ? (
          <div className="mx-auto max-w-3xl">
            <div className="flex items-center justify-between gap-3 rounded-xl border border-[var(--app-border)] bg-[var(--app-subtle-bg)] px-4 py-3">
              <div className="min-w-0">
                <div className="text-sm font-medium text-[var(--app-fg)]">History only</div>
                <div className="text-xs text-[var(--app-hint)]">Claim control to continue here.</div>
              </div>
              <button
                type="button"
                disabled={props.composerSurface.actionPending}
                onClick={props.onClaimHistory}
                className="shrink-0 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground transition-colors hover:opacity-90 disabled:opacity-50"
              >
                {props.composerSurface.actionLabel}
              </button>
            </div>
          </div>
        ) : props.composerSurface.kind === "unavailable" ? (
          <div className="mx-auto max-w-3xl">
            <div className="w-full rounded-xl border border-[var(--app-border)] bg-[var(--app-subtle-bg)] px-4 py-3 text-sm text-[var(--app-hint)]">
              Input is unavailable for this session.
            </div>
          </div>
        ) : props.composerSurface.kind === "claim_control" ? (
          <div className="mx-auto max-w-3xl">
            <div className="flex items-center justify-between gap-3 rounded-xl border border-[var(--app-border)] bg-[var(--app-subtle-bg)] px-4 py-3">
              <div className="min-w-0">
                <div className="text-sm font-medium text-[var(--app-fg)]">Claim control</div>
                <div className="text-xs text-[var(--app-hint)]">Claim control to continue here.</div>
              </div>
              <button
                type="button"
                disabled={props.composerSurface.actionPending}
                onClick={props.onClaimControl}
                className="shrink-0 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground transition-colors hover:opacity-90 disabled:opacity-50"
              >
                {props.composerSurface.actionLabel}
              </button>
            </div>
          </div>
        ) : (
          <div className="mx-auto max-w-3xl">
            <div
              className={
                props.composerSurface.showStopButton
                  ? COMPOSER_LAYOUT.composeGridWithStopClassName
                  : COMPOSER_LAYOUT.composeGridWithoutStopClassName
              }
            >
              <button
                type="button"
                onClick={props.onOpenFileReference}
                className={COMPOSER_LAYOUT.roundSecondaryButtonClassName}
                title="Insert file or folder reference"
              >
                <Plus size={18} />
              </button>
              <TokenizedTextarea
                ref={props.composerRef}
                textareaClassName={COMPOSER_LAYOUT.textareaClassName}
                contentClassName={COMPOSER_LAYOUT.textareaContentClassName}
                value={props.draft}
                onChange={props.onDraftChange}
                placeholder="Message…"
                rows={1}
                onKeyDown={(e) => {
                  const nativeEvent = e.nativeEvent as KeyboardEvent;
                  if (
                    e.key === "Enter" &&
                    !e.shiftKey &&
                    !nativeEvent.isComposing &&
                    nativeEvent.keyCode !== 229
                  ) {
                    e.preventDefault();
                    if (!props.sendPending) {
                      props.onSend();
                    }
                  }
                }}
              />
              {props.composerSurface.showStopButton ? (
                <div className={COMPOSER_LAYOUT.stopWrapperClassName}>
                  <span className={COMPOSER_LAYOUT.stopSpinnerClassName} />
                  <button
                    type="button"
                    onClick={props.onInterrupt}
                    className={COMPOSER_LAYOUT.stopButtonClassName}
                  >
                    <Square size={16} fill="currentColor" />
                  </button>
                </div>
              ) : null}
              <button
                type="button"
                disabled={props.sendPending || !props.draft.trim()}
                onClick={props.onSend}
                className={COMPOSER_LAYOUT.roundPrimaryButtonClassName}
              >
                <ArrowUp size={18} />
              </button>
            </div>
          </div>
        )}
      </div>
    </>
  );
}

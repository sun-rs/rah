import { useEffect, useRef, useState, type RefObject } from "react";
import type { ContextUsage, PermissionResponseRequest, ProviderModelCatalog, SessionSummary } from "@rah/runtime-protocol";
import { Archive, ArrowUp, Ellipsis, EyeOff, Info, Menu, PanelRight, PencilLine, Plus, Trash2, X } from "lucide-react";
import { providerLabel } from "../../../types";
import type { SessionProjection } from "../../../types";
import { ChatThread } from "../../chat/ChatThread";
import { ProviderLogo } from "../../ProviderLogo";
import { SessionControlPopover } from "../../SessionControlPopover";
import { TokenizedTextarea } from "../../TokenizedTextarea";
import { COMPOSER_LAYOUT, type ComposerSurface } from "../../../composer-contract";
import type { InlineWorkbenchNotice } from "../../../workbench-notice-contract";
import { SessionInfoDialog } from "../dialogs/SessionInfoDialog";
import { resolveSessionModeControlState, type SessionModeChoice } from "../../../session-mode-ui";
import { isSessionControlLocked } from "../../../session-capabilities";

function formatContextPercent(value: number): string {
  const clamped = Math.max(0, Math.min(100, value));
  const rounded = Math.round(clamped * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

function formatFullTokens(value: number): string {
  return Math.max(0, Math.round(value)).toLocaleString("en-US");
}

function resolveContextUsageDisplay(
  usage: ContextUsage | undefined,
): { label: string; compactLabel: string; ariaLabel: string; tooltip: string } | null {
  if (usage?.percentUsed === undefined && usage?.percentRemaining === undefined) {
    return null;
  }

  const percentRemainingValue = usage.percentRemaining ?? 100 - usage.percentUsed!;
  const percentRemaining = formatContextPercent(percentRemainingValue);
  const label = `${percentRemaining}% context`;
  const compactLabel = `${percentRemaining}%`;
  const usedTokens = usage.usedTokens;
  const contextWindow = usage.contextWindow;

  if (
    usedTokens === undefined ||
    contextWindow === undefined ||
    !Number.isFinite(usedTokens) ||
    !Number.isFinite(contextWindow)
  ) {
    return {
      label,
      compactLabel,
      ariaLabel: `Context remaining: ${percentRemaining}%`,
      tooltip: `Remaining ${percentRemaining}%`,
    };
  }

  const qualifier = usage.precision === "estimated" ? "Estimated used context" : "Used context";
  const tooltip = `${qualifier}: ${formatFullTokens(usedTokens)} / ${formatFullTokens(
    contextWindow,
  )} tokens`;
  return {
    label,
    compactLabel,
    ariaLabel: `${tooltip} · ${percentRemaining}% remaining`,
    tooltip,
  };
}

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
  claimAccessModes: SessionModeChoice[];
  selectedClaimAccessModeId: string | null;
  claimPlanModeAvailable: boolean;
  claimPlanModeEnabled: boolean;
  claimModePending: boolean;
  selectedClaimModelId: string | null;
  selectedClaimReasoningId: string | null;
  onDraftChange: (value: string) => void;
  onSend: () => void;
  onClaimHistory: () => void;
  onClaimAccessModeChange: (modeId: string) => void;
  onClaimPlanModeToggle: (enabled: boolean) => void;
  onClaimModelChange: (modelId: string, defaultReasoningId?: string | null) => void;
  onClaimReasoningChange: (reasoningId: string) => void;
  onClaimControl: () => void;
  onInterrupt: () => void;
  onOpenFileReference: () => void;
  fileReferenceDisabled?: boolean;
  onLoadOlderHistory: () => void | Promise<void>;
  onOpenLeft: () => void;
  onExpandSidebar: () => void;
  onOpenRight: () => void;
  onExpandInspector: () => void;
  onToggleInspector?: () => void;
  onFloatingAnchorOffsetChange: (offsetPx: number) => void;
  onHideSession?: () => void;
  onArchiveOrClose: () => void;
  onDeleteSession: () => void;
  canArchiveSession: boolean;
  canDeleteSession: boolean;
  canShowSessionInfo: boolean;
  canRenameSession: boolean;
  canSwitchSessionModes: boolean;
  canSwitchSessionModel: boolean;
  modeChangePending: boolean;
  modelCatalog: ProviderModelCatalog | null;
  modelCatalogLoading: boolean;
  modelChangePending: boolean;
  onRenameSession: () => void;
  onSetSessionMode: (modeId: string) => void;
  onSetSessionModel: (modelId: string, reasoningId?: string | null) => void;
  compactComposerPrompts?: boolean | "auto";
  compactSessionMeta?: boolean | "auto";
  showInspectorToggle?: boolean;
  reserveInspectorToggleSpace?: boolean;
}) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const composerContainerRef = useRef<HTMLDivElement | null>(null);
  const sessionMenuRef = useRef<HTMLDivElement | null>(null);
  const lastFloatingAnchorOffsetRef = useRef<number | null>(null);
  const [sessionMenuOpen, setSessionMenuOpen] = useState(false);
  const [sessionInfoOpen, setSessionInfoOpen] = useState(false);
  const [paneWidth, setPaneWidth] = useState<number | null>(null);
  const effectivePaneWidth = paneWidth ?? Number.POSITIVE_INFINITY;
  const sessionMetaMode = props.compactSessionMeta ?? "auto";
  const compactSessionMeta =
    sessionMetaMode === "auto"
      ? effectivePaneWidth < 720
      : sessionMetaMode === true;
  const compactComposerPrompts =
    props.compactComposerPrompts === "auto"
      ? effectivePaneWidth < 640
      : props.compactComposerPrompts === true;
  const archiveOrCloseDisabled =
    !props.isAttached || (!props.selectedIsReadOnlyReplay && !props.canArchiveSession);
  const liveModeControl = resolveSessionModeControlState({
    provider: props.selectedSummary.session.provider,
    summary: props.selectedSummary,
    catalog: props.modelCatalog,
  });
  const contextUsageDisplay = resolveContextUsageDisplay(props.selectedSummary.usage);
  const showLiveAccessModeControl = Boolean(
    props.canSwitchSessionModes &&
      props.selectedSummary.session.mode &&
      props.selectedSummary.session.mode.availableModes.length > 0,
  );
  const showLivePlanModeControl =
    props.canSwitchSessionModes && liveModeControl.planModeAvailable;
  const showLiveModelControl =
    props.canSwitchSessionModel && Boolean(props.modelCatalog || props.modelCatalogLoading);
  const composerActionPending =
    props.composerSurface.kind === "history_claim" ||
    props.composerSurface.kind === "claim_control"
      ? props.composerSurface.actionPending
      : false;
  const sessionControlBusy = isSessionControlLocked(props.selectedSummary);
  const claimSessionControlDisabled =
    sessionControlBusy ||
    props.claimModePending ||
    props.modelChangePending ||
    composerActionPending;
  const stopDisabled =
    props.composerSurface.kind === "compose" && props.composerSurface.stopDisabled === true;
  const showInspectorToggle = props.showInspectorToggle !== false;
  const claimComposerButtonClassName =
    "inline-flex h-8 shrink-0 items-center justify-center rounded-lg bg-primary px-3 text-xs font-medium text-primary-foreground transition-colors hover:opacity-90 disabled:opacity-50";
  const claimControlButtonClassName =
    "icon-click-feedback inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] text-[var(--app-hint)] hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)] disabled:opacity-40";
  const renderClaimComposer = (args: {
    title: string;
    actionLabel: string;
    actionPending: boolean;
    onClaim: () => void;
  }) => (
    <div className="flex min-h-10 w-full items-center justify-between gap-2 rounded-xl border border-[var(--app-border)] bg-[var(--app-subtle-bg)] px-2 py-1 md:min-h-9 lg:min-h-8">
      <div className="min-w-0 flex-1 truncate px-1">
        <span className="text-sm font-medium text-[var(--app-fg)]">{args.title}</span>
        {!compactComposerPrompts ? (
          <span className="ml-2 text-xs text-[var(--app-hint)]">
            Claim control to continue here.
          </span>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-2.5">
      <SessionControlPopover
        accessModes={props.claimAccessModes}
        selectedAccessModeId={props.selectedClaimAccessModeId}
        planModeAvailable={props.claimPlanModeAvailable}
        planModeEnabled={props.claimPlanModeEnabled}
        modeDisabled={props.claimModePending || args.actionPending}
        modelCatalog={props.modelCatalog}
        modelCatalogLoading={props.modelCatalogLoading}
        selectedModelId={props.selectedClaimModelId}
        selectedReasoningId={props.selectedClaimReasoningId}
        modelDisabled={props.modelChangePending || args.actionPending}
        disabled={claimSessionControlDisabled}
        showModel
        align="right"
        buttonClassName={claimControlButtonClassName}
        onAccessModeChange={props.onClaimAccessModeChange}
        onPlanModeToggle={props.onClaimPlanModeToggle}
        onModelChange={props.onClaimModelChange}
        onReasoningChange={props.onClaimReasoningChange}
      />
      <button
        type="button"
        disabled={args.actionPending}
        onClick={args.onClaim}
        className={claimComposerButtonClassName}
      >
        {args.actionLabel}
      </button>
      </div>
    </div>
  );

  useEffect(() => {
    const node = rootRef.current;
    if (!node) return;

    const updateWidth = () => {
      setPaneWidth(Math.floor(node.getBoundingClientRect().width));
    };

    updateWidth();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", updateWidth);
      return () => window.removeEventListener("resize", updateWidth);
    }
    const observer = new ResizeObserver(updateWidth);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const node = composerContainerRef.current;
    if (!node) return;

    const updateAnchor = () => {
      const nextOffset = Math.ceil(node.getBoundingClientRect().height) + 12;
      if (lastFloatingAnchorOffsetRef.current === nextOffset) return;
      lastFloatingAnchorOffsetRef.current = nextOffset;
      props.onFloatingAnchorOffsetChange(nextOffset);
    };

    updateAnchor();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(updateAnchor);
    observer.observe(node);
    return () => observer.disconnect();
  }, [props.onFloatingAnchorOffsetChange]);

  useEffect(() => {
    if (!sessionMenuOpen) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (!sessionMenuRef.current?.contains(event.target as Node)) {
        setSessionMenuOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSessionMenuOpen(false);
    };
    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [sessionMenuOpen]);

  return (
    <div ref={rootRef} className="flex h-full min-h-0 flex-col">
      <header
        className={`relative z-20 h-14 flex items-center justify-between gap-3 border-b border-[var(--app-border)] pl-4 ${
          props.reserveInspectorToggleSpace ? "pr-14" : "pr-4"
        } bg-[var(--app-bg)]/80 backdrop-blur-sm shrink-0`}
      >
        <div className="flex items-center gap-2 min-w-0">
          <button
            type="button"
            className="icon-click-feedback inline-flex h-8 w-8 items-center justify-center rounded-md text-[var(--app-hint)] hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)] md:hidden"
            onClick={props.onOpenLeft}
            aria-label="Open sidebar"
          >
            <Menu size={18} />
          </button>
          {!props.sidebarOpen && (
            <button
              type="button"
              className="icon-click-feedback hidden md:inline-flex h-7 w-7 items-center justify-center rounded-md text-[var(--app-hint)] hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)]"
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
            {compactSessionMeta ? (
              <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[11px] text-[var(--app-hint)]">
                <span
                  className={`group relative inline-flex min-w-0 shrink-0 rounded-full border px-1.5 py-0.5 text-[10px] font-medium ${
                    props.selectedIsReadOnlyReplay
                      ? "border-[var(--app-border)] bg-[var(--app-subtle-bg)] text-[var(--app-hint)]"
                      : "border-emerald-500/20 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                  }`}
                  aria-label={contextUsageDisplay?.ariaLabel}
                  tabIndex={contextUsageDisplay ? 0 : undefined}
                >
                  <span className="cursor-default truncate">
                    {props.selectedIsReadOnlyReplay ? "History" : "Live"}
                    {contextUsageDisplay ? ` ${contextUsageDisplay.compactLabel}` : ""}
                  </span>
                  {contextUsageDisplay ? (
                    <span
                      role="tooltip"
                      className="pointer-events-none absolute left-0 top-full z-50 mt-1 hidden max-w-[16rem] whitespace-nowrap rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] px-2 py-1 text-[11px] text-[var(--app-fg)] shadow-lg group-hover:block group-focus:block"
                    >
                      {contextUsageDisplay.tooltip}
                    </span>
                  ) : null}
                </span>
              </div>
            ) : (
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
              {contextUsageDisplay ? (
                <>
                  <span className="inline">·</span>
                  <span
                    className="group relative inline-flex items-center"
                    aria-label={contextUsageDisplay.ariaLabel}
                    tabIndex={0}
                  >
                    <span className="cursor-default">{contextUsageDisplay.label}</span>
                    <span
                      role="tooltip"
                      className="pointer-events-none absolute left-1/2 top-full z-50 mt-1.5 -translate-x-1/2 whitespace-nowrap rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] px-2 py-1 text-[11px] font-medium text-[var(--app-fg)] opacity-0 shadow-lg transition-opacity duration-150 group-hover:opacity-100 group-focus:opacity-100"
                    >
                      {contextUsageDisplay.tooltip}
                    </span>
                  </span>
                  </>
                ) : null}
              </div>
            )}
            </div>
          </div>
        <div className="flex items-center gap-1 shrink-0">
          <div ref={sessionMenuRef} className="relative">
            <button
              type="button"
              className="icon-click-feedback inline-flex h-8 w-8 items-center justify-center rounded-md border border-[var(--app-border)] text-[var(--app-hint)] hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)]"
              onClick={() => setSessionMenuOpen((open) => !open)}
              aria-label="Session actions"
              title="Session actions"
            >
              <Ellipsis size={16} />
            </button>
            {sessionMenuOpen ? (
              <div className="absolute right-0 top-[calc(100%+0.375rem)] z-50 min-w-[10rem] rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] p-1 shadow-xl">
                {props.canShowSessionInfo ? (
                  <button
                    type="button"
                    className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm text-[var(--app-fg)] transition-colors hover:bg-[var(--app-subtle-bg)]"
                    onClick={() => {
                      setSessionMenuOpen(false);
                      setSessionInfoOpen(true);
                    }}
                  >
                    <Info size={14} />
                    <span>Info</span>
                  </button>
                ) : null}
                {props.canRenameSession ? (
                  <button
                    type="button"
                    className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm text-[var(--app-fg)] transition-colors hover:bg-[var(--app-subtle-bg)]"
                    onClick={() => {
                      setSessionMenuOpen(false);
                      props.onRenameSession();
                    }}
                  >
                    <PencilLine size={14} />
                    <span>Rename</span>
                  </button>
                ) : null}
                {props.canDeleteSession ? (
                  <button
                    type="button"
                    className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm text-[var(--app-danger)] transition-colors hover:bg-[var(--app-subtle-bg)]"
                    onClick={() => {
                      setSessionMenuOpen(false);
                      props.onDeleteSession();
                    }}
                  >
                    <Trash2 size={14} />
                    <span>Delete</span>
                  </button>
                ) : null}
              </div>
            ) : null}
          </div>
          <button
            type="button"
            className="inline-flex h-8 items-center justify-center rounded-md border border-[var(--app-border)] px-2 text-xs text-[var(--app-hint)] hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)] disabled:opacity-40 transition-colors"
            disabled={archiveOrCloseDisabled}
            onClick={props.onArchiveOrClose}
            title={
              !props.isAttached
                ? "This client is not attached"
                : props.selectedIsReadOnlyReplay
                  ? "Close this history view"
                  : props.canArchiveSession
                    ? "Archive this live session"
                    : "This provider session cannot be archived from RAH"
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
          {props.onHideSession && !props.selectedIsReadOnlyReplay ? (
            <button
              type="button"
              className="inline-flex h-8 items-center justify-center rounded-md border border-[var(--app-border)] px-2 text-xs text-[var(--app-hint)] transition-colors hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)]"
              onClick={props.onHideSession}
              title="Hide this session without closing it"
            >
              <EyeOff size={14} className="mr-1" />
              <span>Hide</span>
            </button>
          ) : null}
          {showInspectorToggle ? (
            <button
              type="button"
              className="icon-click-feedback hidden h-8 w-8 items-center justify-center rounded-md border border-[var(--app-border)] text-[var(--app-hint)] hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)] md:inline-flex"
              onClick={props.onToggleInspector ?? props.onExpandInspector}
              aria-label={props.rightSidebarOpen ? "Collapse inspector" : "Expand inspector"}
              title={props.rightSidebarOpen ? "Collapse inspector" : "Expand inspector"}
            >
              <PanelRight size={16} />
            </button>
          ) : null}
          {showInspectorToggle ? (
            <button
              type="button"
              className="icon-click-feedback inline-flex h-8 w-8 items-center justify-center rounded-md text-[var(--app-hint)] hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)] md:hidden"
              onClick={props.onOpenRight}
              aria-label="Open inspector"
            >
              <PanelRight size={18} />
            </button>
          ) : null}
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
        className="shrink-0 bg-[var(--app-bg)]"
        style={COMPOSER_LAYOUT.bottomPaddingStyle}
      >
        <div className="mx-auto max-w-3xl px-3 pt-2 md:px-4 md:pt-3">
          {props.composerSurface.kind === "history_claim" ? (
            renderClaimComposer({
              title: "History only",
              actionLabel: props.composerSurface.actionLabel,
              actionPending: props.composerSurface.actionPending,
              onClaim: props.onClaimHistory,
            })
          ) : props.composerSurface.kind === "unavailable" ? (
            <div className="w-full rounded-xl border border-[var(--app-border)] bg-[var(--app-subtle-bg)] px-4 py-3 text-sm text-[var(--app-hint)]">
              Input is unavailable for this session.
            </div>
          ) : props.composerSurface.kind === "claim_control" ? (
            renderClaimComposer({
              title: "Claim control",
              actionLabel: props.composerSurface.actionLabel,
              actionPending: props.composerSurface.actionPending,
              onClaim: props.onClaimControl,
            })
          ) : (
            <div className="relative">
              {/* Compose grid: attach | settings | textarea | [stop] | send */}
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
                  disabled={props.fileReferenceDisabled}
                  className={`${COMPOSER_LAYOUT.attachButtonClassName} disabled:cursor-not-allowed disabled:opacity-40`}
                  title={
                    props.fileReferenceDisabled
                      ? "File references are available in single-session view."
                      : "Insert file or folder reference"
                  }
                >
                  <Plus size={18} />
                </button>

                <SessionControlPopover
                  accessModes={showLiveAccessModeControl ? liveModeControl.accessModes : []}
                  selectedAccessModeId={liveModeControl.selectedAccessModeId}
                  planModeAvailable={showLivePlanModeControl}
                  planModeEnabled={liveModeControl.planModeEnabled}
                  modeDisabled={sessionControlBusy || props.modeChangePending}
                  modelCatalog={props.modelCatalog}
                  modelCatalogLoading={props.modelCatalogLoading}
                  selectedModelId={props.selectedSummary.session.model?.currentModelId ?? null}
                  selectedReasoningId={
                    props.selectedSummary.session.model?.currentReasoningId ?? null
                  }
                  modelDisabled={sessionControlBusy || props.modelChangePending}
                  disabled={props.modeChangePending || props.modelChangePending}
                  locked={sessionControlBusy}
                  lockedMessage="Session controls are locked while this session is thinking."
                  showModel={showLiveModelControl}
                  buttonClassName={COMPOSER_LAYOUT.settingsButtonClassName}
                  onAccessModeChange={props.onSetSessionMode}
                  onPlanModeToggle={(enabled) => {
                    props.onSetSessionMode(
                      enabled ? "plan" : liveModeControl.selectedAccessModeId ?? "default",
                    );
                  }}
                  onModelChange={(modelId, defaultReasoningId) => {
                    props.onSetSessionModel(modelId, defaultReasoningId);
                  }}
                  onReasoningChange={(reasoningId) => {
                    props.onSetSessionModel(
                      props.selectedSummary.session.model?.currentModelId ?? "",
                      reasoningId,
                    );
                  }}
                />

                <div className="relative min-w-0">
                  <TokenizedTextarea
                    ref={props.composerRef}
                    textareaClassName={COMPOSER_LAYOUT.textareaClassName}
                    contentClassName={COMPOSER_LAYOUT.textareaContentClassName}
                    value={props.draft}
                    onChange={props.onDraftChange}
                    placeholder=""
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
                </div>

                {props.composerSurface.showStopButton ? (
                  <div className={COMPOSER_LAYOUT.stopWrapperClassName}>
                    <span className={COMPOSER_LAYOUT.stopSpinnerClassName} />
                    <button
                      type="button"
                      disabled={stopDisabled}
                      onClick={stopDisabled ? undefined : props.onInterrupt}
                      title={
                        props.composerSurface.kind === "compose"
                          ? props.composerSurface.stopTitle
                          : undefined
                      }
                      className={COMPOSER_LAYOUT.stopButtonClassName}
                    >
                      <span className="sr-only">Stop generating</span>
                    </button>
                  </div>
                ) : null}

                <button
                  type="button"
                  disabled={props.sendPending || !props.draft.trim()}
                  onClick={props.onSend}
                  className={COMPOSER_LAYOUT.sendButtonClassName}
                >
                  <ArrowUp size={18} />
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
      <SessionInfoDialog
        open={sessionInfoOpen}
        summary={props.selectedSummary}
        projection={props.selectedProjection}
        onOpenChange={setSessionInfoOpen}
      />
    </div>
  );
}

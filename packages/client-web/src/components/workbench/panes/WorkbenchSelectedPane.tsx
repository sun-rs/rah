import { useEffect, useRef, useState, type RefObject } from "react";
import type { ContextUsage, PermissionResponseRequest, ProviderModelCatalog, SessionSummary } from "@rah/runtime-protocol";
import {
  Activity,
  ArrowUp,
  Circle,
  CircleStop,
  Ellipsis,
  EyeOff,
  Info,
  Menu,
  PanelRight,
  PencilLine,
  Plus,
  Square,
  Trash2,
  UsersRound,
  X,
} from "lucide-react";
import type { SessionProjection } from "../../../types";
import { TerminalPane } from "../../../TerminalPane";
import { ChatThread } from "../../chat/ChatThread";
import { ProviderLogo } from "../../ProviderLogo";
import { SessionControlPopover } from "../../SessionControlPopover";
import { TokenizedTextarea } from "../../TokenizedTextarea";
import { canSubmitComposerInput, COMPOSER_LAYOUT, type ComposerSurface } from "../../../composer-contract";
import {
  HEADER_ACTION_GROUP_CLASS,
  HEADER_DANGER_TEXT_BUTTON_CLASS,
  HEADER_ICON_BUTTON_CLASS,
  HEADER_SEGMENTED_BUTTON_BASE_CLASS,
  HEADER_SEGMENTED_CONTROL_CLASS,
  HEADER_TEXT_BUTTON_CLASS,
} from "../header-button-styles";
import {
  ConversationMetaBadge,
} from "../ConversationMetaBadge";
import {
  resolveConversationHeaderState,
  type ConversationHeaderStateIcon,
} from "../conversation-header-meta";
import type { InlineWorkbenchNotice } from "../../../workbench-notice-contract";
import { SessionInfoDialog } from "../dialogs/SessionInfoDialog";
import {
  codexPlanModeId,
  resolveSessionModeControlState,
  type SessionModeChoice,
} from "../../../session-mode-ui";
import { isSessionControlLocked } from "../../../session-capabilities";
import { closeNativeTuiClient } from "../../../api";
import {
  resolveActiveSessionTuiSurface,
  shouldDetachPreviousSessionTui,
  type ActiveSessionTuiSurface,
} from "../../../tui-surface-lifecycle";
import { providerLabel } from "../../../types";

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

type SessionViewMode = "chat" | "tui";

function ConversationHeaderStateIconView(props: { icon: ConversationHeaderStateIcon }) {
  switch (props.icon) {
    case "running":
      return <Circle size={9} className="fill-current" />;
    case "activity":
      return <Activity size={10} />;
    case "stopped":
      return <CircleStop size={10} />;
  }
  return null;
}

function shouldRenderInteractionNotice(notice: InlineWorkbenchNotice | null): notice is InlineWorkbenchNotice {
  if (!notice) {
    return false;
  }
  // Generic read-only/observe states are already expressed by the composer
  // surface. Keep this banner for actionable native-TUI diagnostics, queued
  // input, stopped TUI, and warning states.
  return notice.message !== "History only. Claim running control for input and approvals." &&
    notice.message !== "Observe only.";
}

export function WorkbenchSelectedPane(props: {
  selectedSummary: SessionSummary;
  clientId: string;
  selectedProjection: SessionProjection | null;
  selectedIsReadOnlyReplay: boolean;
  sidebarOpen: boolean;
  rightSidebarOpen: boolean;
  isAttached: boolean;
  interactionNotice: InlineWorkbenchNotice | null;
  historyNotice: InlineWorkbenchNotice | null;
  hideToolCallsInChat: boolean;
  hideOpenCodeReasoningInChat: boolean;
  hideGeminiReasoningInChat: boolean;
  showModelInfoInChat: boolean;
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
  onStopOrClose: () => void;
  onDeleteSession: () => void;
  canStopSession: boolean;
  canDeleteSession: boolean;
  canShowSessionInfo: boolean;
  canRenameSession: boolean;
  canSwitchSessionModes: boolean;
  canSwitchSessionModel: boolean;
  modeChangePending: boolean;
  modelCatalog: ProviderModelCatalog | null;
  modelCatalogLoading: boolean;
  modelChangePending: boolean;
  onRequestModelCatalogRefresh?: (() => void) | undefined;
  onRenameSession: () => void;
  onSetSessionMode: (modeId: string) => void;
  onSetSessionModel: (modelId: string, reasoningId?: string | null) => void;
  compactComposerPrompts?: boolean | "auto";
  compactSessionMeta?: boolean | "auto";
  showInspectorToggle?: boolean;
  inspectorToggleOpen?: boolean;
  inspectorToggleDisabled?: boolean;
  inspectorToggleTitle?: string;
  inspectorToggleClassName?: string;
  reserveRightPanelToggleSpace?: boolean;
}) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const composerContainerRef = useRef<HTMLDivElement | null>(null);
  const sessionMenuRef = useRef<HTMLDivElement | null>(null);
  const lastFloatingAnchorOffsetRef = useRef<number | null>(null);
  const nativeTui = props.selectedSummary.session.nativeTui;
  const nativeTuiAvailable = Boolean(nativeTui?.viewAvailable);
  const nativeChatMirrorAvailable =
    nativeTuiAvailable && props.selectedSummary.session.capabilities.chatMirror === true;
  const preferredSessionViewMode: SessionViewMode = "chat";
  const sessionViewResetKey = [
    props.selectedSummary.session.id,
    nativeTuiAvailable ? "native" : "chat",
    nativeChatMirrorAvailable ? "mirror" : "no-mirror",
  ].join(":");
  const sessionViewResetKeyRef = useRef(sessionViewResetKey);
  const [sessionMenuOpen, setSessionMenuOpen] = useState(false);
  const [sessionInfoOpen, setSessionInfoOpen] = useState(false);
  const [paneWidth, setPaneWidth] = useState<number | null>(null);
  const [sessionViewMode, setSessionViewMode] = useState<SessionViewMode>(preferredSessionViewMode);
  const [openedTuiTerminalIds, setOpenedTuiTerminalIds] = useState<Set<string>>(() => new Set());
  const [closedTuiTerminalIds, setClosedTuiTerminalIds] = useState<Set<string>>(() => new Set());
  const activeSessionTuiRef = useRef<ActiveSessionTuiSurface>(null);
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
  const stopOrCloseDisabled =
    !props.isAttached || (!props.selectedIsReadOnlyReplay && !props.canStopSession);
  const liveModeControl = resolveSessionModeControlState({
    provider: props.selectedSummary.session.provider,
    summary: props.selectedSummary,
    catalog: props.modelCatalog,
  });
  const contextUsageDisplay = resolveContextUsageDisplay(props.selectedSummary.usage);
  const isCouncilSession = props.selectedSummary.session.origin?.kind === "council";
  const sessionLifecycleStatus = props.selectedIsReadOnlyReplay
    ? "stopped"
    : props.selectedSummary.session.status;
  const sessionPhase =
    isCouncilSession && props.selectedSummary.session.phase === "working"
      ? "ready"
      : props.selectedSummary.session.phase;
  const sessionHeaderState = resolveConversationHeaderState({
    status: sessionLifecycleStatus,
    phase: sessionPhase,
  });
  const effectiveSessionViewMode =
    nativeTuiAvailable && sessionViewMode === "tui" ? "tui" : "chat";
  const showComposer =
    effectiveSessionViewMode === "chat" || props.composerSurface.kind !== "compose";
  const terminalHasControl =
    props.isAttached && props.selectedSummary.controlLease.holderClientId === props.clientId;
  const terminalTuiClientActive = nativeTui
    ? !closedTuiTerminalIds.has(nativeTui.terminalId)
    : true;
  const markCurrentTuiOpened = () => {
    if (!nativeTui) {
      return;
    }
    const terminalId = nativeTui.terminalId;
    setOpenedTuiTerminalIds((current) => {
      if (current.has(terminalId)) {
        return current;
      }
      const next = new Set(current);
      next.add(terminalId);
      return next;
    });
  };
  const setTerminalTuiClientActive = (active: boolean) => {
    if (!nativeTui) {
      return;
    }
    const terminalId = nativeTui.terminalId;
    if (active) {
      setOpenedTuiTerminalIds((current) => {
        if (current.has(terminalId)) {
          return current;
        }
        const next = new Set(current);
        next.add(terminalId);
        return next;
      });
    }
    setClosedTuiTerminalIds((current) => {
      const next = new Set(current);
      if (active) {
        next.delete(terminalId);
      } else {
        next.add(terminalId);
      }
      return next;
    });
  };
  const showLiveAccessModeControl = Boolean(
    props.canSwitchSessionModes &&
      props.selectedSummary.session.mode &&
      props.selectedSummary.session.mode.availableModes.length > 0,
  );
  const showLivePlanModeControl =
    props.canSwitchSessionModes && liveModeControl.planModeAvailable;
  const showLiveModelControl =
    props.canSwitchSessionModel && Boolean(props.modelCatalog || props.modelCatalogLoading);
  const runningSessionControlUnavailableMessage =
    !showLiveAccessModeControl &&
    !showLivePlanModeControl &&
    !showLiveModelControl &&
    props.selectedSummary.session.liveBackend === "tui_mux"
      ? `${providerLabel(props.selectedSummary.session.provider)} runs as a native TUI session here. Change model or permissions inside the provider TUI, or choose them before launch/resume.`
      : undefined;
  const composerActionPending =
    props.composerSurface.kind === "history_claim" ||
    props.composerSurface.kind === "claim_control"
      ? props.composerSurface.actionPending
      : false;
  const sessionControlBusy = isSessionControlLocked(props.selectedSummary);
  const nativeTuiPromptDirty =
    props.composerSurface.kind === "compose" && nativeTui?.promptState === "prompt_dirty";
  const claimSessionControlDisabled =
    sessionControlBusy ||
    props.claimModePending ||
    props.modelChangePending ||
    composerActionPending;
  const stopDisabled =
    props.composerSurface.kind === "compose" && props.composerSurface.stopDisabled === true;
  const sendDisabled = !canSubmitComposerInput({
    composerSurface: props.composerSurface,
    draft: props.draft,
    sendPending: props.sendPending,
    nativeTuiPromptState: nativeTui?.promptState,
  });
  const claimComposerButtonClassName =
    "inline-flex h-8 shrink-0 items-center justify-center rounded-lg bg-primary px-3 text-xs font-medium text-primary-foreground transition-colors hover:opacity-90 disabled:opacity-50";
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
        buttonClassName={COMPOSER_LAYOUT.settingsButtonClassName}
        onOpen={props.onRequestModelCatalogRefresh}
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
    if (sessionViewResetKeyRef.current === sessionViewResetKey) {
      return;
    }
    sessionViewResetKeyRef.current = sessionViewResetKey;
    setSessionViewMode(preferredSessionViewMode);
  }, [
    nativeChatMirrorAvailable,
    nativeTuiAvailable,
    preferredSessionViewMode,
    props.selectedSummary.session.id,
    sessionViewResetKey,
  ]);

  useEffect(() => {
    const current = resolveActiveSessionTuiSurface({
      terminalId: nativeTui?.terminalId ?? null,
      clientId: props.clientId,
      openedTerminalIds: openedTuiTerminalIds,
      closedTerminalIds: closedTuiTerminalIds,
    });
    const previous = activeSessionTuiRef.current;
    if (shouldDetachPreviousSessionTui(previous, current)) {
      void closeNativeTuiClient(previous.terminalId, { clientId: previous.clientId }).catch(() => undefined);
    }
    activeSessionTuiRef.current = current;
  }, [closedTuiTerminalIds, nativeTui, openedTuiTerminalIds, props.clientId, terminalTuiClientActive]);

  useEffect(() => {
    return () => {
      const activeTui = activeSessionTuiRef.current;
      if (!activeTui) {
        return;
      }
      void closeNativeTuiClient(activeTui.terminalId, { clientId: activeTui.clientId }).catch(() => undefined);
      activeSessionTuiRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (showComposer) {
      return;
    }
    props.onFloatingAnchorOffsetChange(12);
  }, [props.onFloatingAnchorOffsetChange, showComposer]);

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

  const inspectorToggleOpen = props.inspectorToggleOpen ?? props.rightSidebarOpen;

  return (
    <div ref={rootRef} className="flex h-full min-h-0 flex-col">
      <header
        className={`relative z-20 flex h-14 shrink-0 items-center justify-between gap-3 border-b border-[var(--app-border)] bg-[var(--app-bg)]/80 pl-4 pr-4 backdrop-blur-sm ${
          props.reserveRightPanelToggleSpace
            ? "md:pr-[calc(max(1rem,env(safe-area-inset-right))+2.75rem)]"
            : ""
        }`}
      >
        <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
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
              className="icon-click-feedback hidden h-8 w-8 items-center justify-center rounded-md text-[var(--app-hint)] hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)] md:inline-flex"
              onClick={props.onExpandSidebar}
              aria-label="Expand sidebar"
              title="Expand sidebar"
            >
              <Menu size={18} />
            </button>
          )}
          <ProviderLogo provider={props.selectedSummary.session.provider} className="h-6 w-6 shrink-0" />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium truncate text-[var(--app-fg)]">
              {props.selectedSummary.session.title ?? props.selectedSummary.session.id}
            </div>
            <div className="mt-0.5 flex min-w-0 items-center gap-1.5 overflow-hidden text-[11px] text-[var(--app-hint)]">
              <ConversationMetaBadge
                tone={sessionHeaderState.tone}
                title={sessionHeaderState.title}
                ariaLabel={sessionHeaderState.title}
              >
                <ConversationHeaderStateIconView icon={sessionHeaderState.icon} />
                <span>{sessionHeaderState.label}</span>
              </ConversationMetaBadge>
              {contextUsageDisplay ? (
                <span
                  className="group relative inline-flex shrink-0"
                  aria-label={contextUsageDisplay.ariaLabel}
                  tabIndex={0}
                >
                  <ConversationMetaBadge
                    tone="context"
                    title={contextUsageDisplay.tooltip}
                    {...(compactSessionMeta ? {} : { width: "context" as const })}
                  >
                    <span>{compactSessionMeta ? contextUsageDisplay.compactLabel : contextUsageDisplay.label}</span>
                  </ConversationMetaBadge>
                  <span
                    role="tooltip"
                    className="pointer-events-none absolute left-1/2 top-full z-50 mt-1.5 -translate-x-1/2 whitespace-nowrap rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] px-2 py-1 text-[11px] font-medium text-[var(--app-fg)] opacity-0 shadow-lg transition-opacity duration-150 group-hover:opacity-100 group-focus:opacity-100"
                  >
                    {contextUsageDisplay.tooltip}
                  </span>
                </span>
              ) : null}
              {isCouncilSession ? (
                <ConversationMetaBadge
                  tone="council"
                  title="Council agent session"
                  ariaLabel="Council agent session"
                >
                  <UsersRound size={10} />
                  <span className={compactSessionMeta ? "sr-only" : ""}>Council</span>
                </ConversationMetaBadge>
              ) : null}
            </div>
          </div>
        </div>
        <div className={HEADER_ACTION_GROUP_CLASS}>
          {nativeTuiAvailable ? (
            <div className={HEADER_SEGMENTED_CONTROL_CLASS}>
              {(["chat", "tui"] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  className={`${HEADER_SEGMENTED_BUTTON_BASE_CLASS} ${
                    effectiveSessionViewMode === mode
                      ? "bg-[var(--app-bg)] text-[var(--app-fg)] shadow-sm"
                      : "text-[var(--app-hint)] hover:text-[var(--app-fg)]"
                  }`}
                  onClick={() => {
                    if (mode === "tui") {
                      markCurrentTuiOpened();
                    }
                    setSessionViewMode(mode);
                  }}
                  aria-pressed={effectiveSessionViewMode === mode}
                  title={mode === "chat" ? "Show structured chat mirror" : "Show native TUI"}
                >
                  {mode === "chat" ? "Chat" : "TUI"}
                </button>
              ))}
            </div>
          ) : null}
          <div ref={sessionMenuRef} className="relative">
            <button
              type="button"
              className={HEADER_ICON_BUTTON_CLASS}
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
            className={
              props.selectedIsReadOnlyReplay
                ? HEADER_TEXT_BUTTON_CLASS
                : HEADER_DANGER_TEXT_BUTTON_CLASS
            }
            disabled={stopOrCloseDisabled}
            onClick={props.onStopOrClose}
            title={
              !props.isAttached
                ? "This client is not attached"
                : props.selectedIsReadOnlyReplay
                  ? "Close this history view"
                  : props.canStopSession
                    ? "Stop this running session"
                    : "This provider session cannot be stopped from RAH"
            }
          >
            {props.selectedIsReadOnlyReplay ? (
              <>
                <X size={14} className="min-[900px]:mr-1" />
                <span className="hidden min-[900px]:inline">Close</span>
              </>
            ) : (
              <>
                <Square size={14} className="min-[900px]:mr-1" />
                <span className="hidden min-[900px]:inline">Stop</span>
              </>
            )}
          </button>
          {props.onHideSession && !props.selectedIsReadOnlyReplay ? (
            <button
              type="button"
              className={HEADER_TEXT_BUTTON_CLASS}
              onClick={props.onHideSession}
              title="Hide this session without closing it"
            >
              <EyeOff size={14} className="min-[900px]:mr-1" />
              <span className="hidden min-[900px]:inline">Hide</span>
            </button>
          ) : null}
          {props.showInspectorToggle ? (
            <button
              type="button"
              className={`${HEADER_ICON_BUTTON_CLASS} ${props.inspectorToggleClassName ?? ""}`}
              onClick={props.onToggleInspector}
              disabled={props.inspectorToggleDisabled || !props.onToggleInspector}
              aria-label={inspectorToggleOpen ? "Collapse inspector" : "Expand inspector"}
              title={
                props.inspectorToggleTitle ??
                (inspectorToggleOpen ? "Collapse inspector" : "Expand inspector")
              }
            >
              <PanelRight size={16} />
            </button>
          ) : null}
        </div>
      </header>

      {shouldRenderInteractionNotice(props.interactionNotice) ? (
        <div
          className={`shrink-0 border-b px-4 py-2 text-xs ${
            props.interactionNotice.tone === "warning"
              ? "border-amber-500/20 bg-amber-500/10 text-amber-700 dark:text-amber-300"
              : "border-[var(--app-border)] bg-[var(--app-subtle-bg)] text-[var(--app-hint)]"
          }`}
        >
          {props.interactionNotice.message}
        </div>
      ) : props.historyNotice ? (
        <div className="shrink-0 border-b border-[var(--app-border)] bg-[var(--app-subtle-bg)] px-4 py-2 text-xs text-[var(--app-hint)]">
          {props.historyNotice.message}
        </div>
      ) : null}

      {effectiveSessionViewMode === "tui" && nativeTui ? (
        <div className="min-h-0 flex-1 bg-[var(--app-bg)] p-2 md:p-3">
          <TerminalPane
            key={nativeTui.terminalId}
            terminalId={nativeTui.terminalId}
            clientId={props.clientId}
            hasControl={terminalHasControl}
            tuiClientCloseEnabled
            tuiClientActive={terminalTuiClientActive}
            onTuiClientActiveChange={setTerminalTuiClientActive}
            scrollback={600}
            replayTailBytes={512 * 1024}
            maxWriteBatchChars={128 * 1024}
          />
        </div>
      ) : (
        <ChatThread
          key={props.selectedSummary.session.id}
          sessionId={props.selectedSummary.session.id}
          feed={props.selectedProjection?.feed ?? []}
          hideToolCalls={props.hideToolCallsInChat}
          hideOpenCodeReasoning={props.hideOpenCodeReasoningInChat}
          hideGeminiReasoning={props.hideGeminiReasoningInChat}
          showModelInfo={props.showModelInfoInChat}
          provider={props.selectedSummary.session.provider}
          canLoadOlderHistory={props.canLoadOlderHistory}
          historyLoading={props.historyLoading}
          onLoadOlderHistory={props.onLoadOlderHistory}
          canRespondToPermission={props.canRespondToPermission}
          onPermissionRespond={props.onPermissionRespond}
        />
      )}

      {showComposer ? (
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
                  {...(runningSessionControlUnavailableMessage
                    ? { unavailableMessage: runningSessionControlUnavailableMessage }
                    : {})}
                  showModel={showLiveModelControl}
                  buttonClassName={COMPOSER_LAYOUT.settingsButtonClassName}
                  onOpen={props.onRequestModelCatalogRefresh}
                  onAccessModeChange={(modeId) => {
                    props.onSetSessionMode(
                      props.selectedSummary.session.provider === "codex" &&
                        liveModeControl.planModeEnabled
                        ? codexPlanModeId(modeId) ?? modeId
                        : modeId,
                    );
                  }}
                  onPlanModeToggle={(enabled) => {
                    props.onSetSessionMode(
                      enabled
                        ? props.selectedSummary.session.provider === "codex"
                          ? codexPlanModeId(liveModeControl.selectedAccessModeId) ?? "plan"
                          : "plan"
                        : liveModeControl.selectedAccessModeId ?? "default",
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
                    ariaLabel="Message composer"
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
                        if (!sendDisabled) {
                          props.onSend();
                        }
                      }
                    }}
                  />
                </div>

                {props.composerSurface.showStopButton ? (
                  <div className={COMPOSER_LAYOUT.stopWrapperClassName}>
                    {props.composerSurface.kind === "compose" &&
                    props.composerSurface.stopSpinner !== false ? (
                      <span className={COMPOSER_LAYOUT.stopSpinnerClassName} />
                    ) : null}
                    <button
                      type="button"
                      disabled={stopDisabled}
                      onClick={stopDisabled ? undefined : props.onInterrupt}
                      title={
                        props.composerSurface.kind === "compose"
                          ? props.composerSurface.stopTitle
                          : undefined
                      }
                      className={
                        props.composerSurface.kind === "compose" &&
                        props.composerSurface.stopTone === "warning"
                          ? COMPOSER_LAYOUT.stopWarningButtonClassName
                          : COMPOSER_LAYOUT.stopButtonClassName
                      }
                    >
                      {props.composerSurface.kind === "compose" &&
                      props.composerSurface.stopTone === "warning" ? (
                        <span aria-hidden="true">Esc</span>
                      ) : null}
                      <span className="sr-only">
                        {props.composerSurface.kind === "compose" &&
                        props.composerSurface.stopAriaLabel
                          ? props.composerSurface.stopAriaLabel
                          : "Stop generating"}
                      </span>
                    </button>
                  </div>
                ) : null}

                <button
                  type="button"
                  disabled={sendDisabled}
                  onClick={props.onSend}
                  aria-label="Send message"
                  title={
                    nativeTuiPromptDirty
                      ? "Clear the current TUI prompt before sending from Chat."
                      : undefined
                  }
                  className={COMPOSER_LAYOUT.sendButtonClassName}
                >
                  <ArrowUp size={18} />
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
      ) : null}
      <SessionInfoDialog
        open={sessionInfoOpen}
        summary={props.selectedSummary}
        projection={props.selectedProjection}
        onOpenChange={setSessionInfoOpen}
      />
    </div>
  );
}

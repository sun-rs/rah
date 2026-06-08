import { Suspense, lazy, useEffect, useRef, useState, type RefObject } from "react";
import type {
  ContextUsage,
  PermissionResponseRequest,
  ProviderModelCatalog,
  SessionHistoryItemDetailKind,
  SessionSummary,
} from "@rah/runtime-protocol";
import {
  ArrowUp,
  Info,
  MessageSquareText,
  PencilLine,
  Plus,
  SquareTerminal,
  Trash2,
  UsersRound,
} from "lucide-react";
import type { SessionProjection } from "../../../types";
import { ChatThread } from "../../chat/ChatThread";
import { ProviderLogo } from "../../ProviderLogo";
import { SessionControlPopover } from "../../SessionControlPopover";
import { TokenizedTextarea } from "../../TokenizedTextarea";
import { importWithStaleReload } from "../../../lazy-module-reload";
import { canSubmitComposerInput, COMPOSER_LAYOUT, type ComposerSurface } from "../../../composer-contract";
import {
  HEADER_MENU_DANGER_ITEM_CLASS,
  HEADER_MENU_ITEM_CLASS,
  HEADER_SEGMENTED_BUTTON_ACTIVE_CLASS,
  HEADER_SEGMENTED_BUTTON_BASE_CLASS,
  HEADER_SEGMENTED_BUTTON_INACTIVE_CLASS,
  HEADER_SEGMENTED_CONTROL_BASE_CLASS,
  HEADER_SEGMENTED_CONTROL_CLASS,
  HEADER_SEGMENTED_LABEL_CLASS,
} from "../header-button-styles";
import {
  ConversationHeader,
  ConversationHeaderIconButton,
  ConversationHeaderMoreButton,
  ConversationHeaderPanelToggleButton,
  ConversationHeaderStopButton,
} from "../shells/ConversationHeader";
import { ConversationPageShell } from "../shells/ConversationPageShell";
import {
  ConversationHeaderMetaList,
  ConversationMetaBadge,
  CONVERSATION_META_BADGE_PADDING_CLASS,
  CONVERSATION_META_BADGE_TRAILING_SPACE_PADDING_CLASS,
  ConversationStateMetaBadge,
  type ConversationHeaderMetaItem,
} from "../ConversationMetaBadge";
import {
  resolveConversationHeaderState,
} from "../conversation-header-meta";
import type { InlineWorkbenchNotice } from "../../../workbench-notice-contract";
import { SessionInfoDialog } from "../dialogs/SessionInfoDialog";
import {
  codexPlanModeId,
  resolveSessionModeControlState,
  type SessionModeChoice,
} from "../../../session-mode-ui";
import {
  isSessionControlLocked,
  sessionTuiTerminalId,
  shouldRequestInitialTuiReplay,
} from "../../../session-capabilities";
import { closeNativeTuiClient } from "../../../api";
import { usePwaDisplayMode } from "../../../hooks/usePwaDisplayMode";
import {
  resolveActiveSessionTuiSurface,
  shouldDetachPreviousSessionTui,
  type ActiveSessionTuiSurface,
} from "../../../tui-surface-lifecycle";
import { providerLabel } from "../../../types";

const TerminalPane = lazy(async () => ({
  default: (await importWithStaleReload(() => import("../../../TerminalPane"))).TerminalPane,
}));
const SESSION_TUI_REPLAY_TAIL_BYTES = 96 * 1024;

function formatContextPercent(value: number): string {
  const clamped = Math.max(0, Math.min(100, value));
  const rounded = Math.round(clamped * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

function formatCompactContextPercent(value: number): string {
  const clamped = Math.max(0, Math.min(100, value));
  if (clamped > 0 && clamped < 1) {
    return "<1";
  }
  return String(Math.round(clamped));
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
  const compactPercentRemaining = formatCompactContextPercent(percentRemainingValue);
  const label = `${compactPercentRemaining}%`;
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
      compactLabel: label,
      ariaLabel: `Context remaining: ${percentRemaining}%`,
      tooltip: `Context remaining: ${percentRemaining}%`,
    };
  }

  const qualifier = usage.precision === "estimated" ? "Estimated used context" : "Used context";
  const tooltip = `${qualifier}: ${formatFullTokens(usedTokens)} / ${formatFullTokens(
    contextWindow,
  )} tokens`;
  return {
    label,
    compactLabel: label,
    ariaLabel: `${tooltip} · ${percentRemaining}% remaining`,
    tooltip,
  };
}

type SessionViewMode = "chat" | "tui";

function shouldRenderInteractionNotice(notice: InlineWorkbenchNotice | null): notice is InlineWorkbenchNotice {
  if (!notice) {
    return false;
  }
  // Generic read-only/observe states are already expressed by the composer
  // surface. Keep this banner for actionable native-TUI diagnostics, queued
  // input, stopped TUI, and warning states.
  return notice.message !== "History only. Resume to continue here." &&
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
  onOpenLocalFile?: (path: string) => void;
  onLoadHistoryItemDetail?: (
    kind: SessionHistoryItemDetailKind,
    itemId: string,
  ) => Promise<void> | void;
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
  showViewCloseButton?: boolean;
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
  const tuiTerminalId = sessionTuiTerminalId(props.selectedSummary);
  const sessionTuiAvailable = Boolean(tuiTerminalId);
  const sessionChatMirrorAvailable =
    sessionTuiAvailable && props.selectedSummary.session.capabilities.chatMirror === true;
  const preferredSessionViewMode: SessionViewMode = "chat";
  const sessionViewResetKey = [
    props.selectedSummary.session.id,
    sessionTuiAvailable ? "tui" : "chat",
    sessionChatMirrorAvailable ? "mirror" : "no-mirror",
  ].join(":");
  const sessionViewResetKeyRef = useRef(sessionViewResetKey);
  const [sessionMenuOpen, setSessionMenuOpen] = useState(false);
  const [sessionInfoOpen, setSessionInfoOpen] = useState(false);
  const [paneWidth, setPaneWidth] = useState<number | null>(null);
  const [sessionViewMode, setSessionViewMode] = useState<SessionViewMode>(preferredSessionViewMode);
  const [openedTuiTerminalIds, setOpenedTuiTerminalIds] = useState<Set<string>>(() => new Set());
  const [closedTuiTerminalIds, setClosedTuiTerminalIds] = useState<Set<string>>(() => new Set());
  const activeSessionTuiRef = useRef<ActiveSessionTuiSurface>(null);
  const isPwaDisplayMode = usePwaDisplayMode();
  const selectedFeed = props.selectedProjection?.feed ?? [];
  const initialChatLoading =
    props.selectedIsReadOnlyReplay &&
    selectedFeed.length === 0 &&
    props.selectedProjection?.history.authoritativeApplied !== true;
  const effectivePaneWidth = paneWidth ?? Number.POSITIVE_INFINITY;
  const sessionMetaMode = props.compactSessionMeta ?? "auto";
  const compactSessionMeta =
    sessionMetaMode === "auto"
      ? effectivePaneWidth < 720
      : sessionMetaMode === true;
  const compactSessionViewToggle = isPwaDisplayMode || effectivePaneWidth < 760;
  const showViewCloseButton = props.showViewCloseButton ?? true;
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
  const sessionHeaderMetaItems: ConversationHeaderMetaItem[] = [
    {
      slot: "status",
      node: <ConversationStateMetaBadge state={sessionHeaderState} />,
    },
  ];
  if (contextUsageDisplay) {
    sessionHeaderMetaItems.push({
      slot: "context",
      node: (
        <span
          className="group relative inline-flex shrink-0"
          aria-label={contextUsageDisplay.ariaLabel}
          tabIndex={0}
        >
          <ConversationMetaBadge
            tone="context"
            title={contextUsageDisplay.tooltip}
            label={compactSessionMeta ? contextUsageDisplay.compactLabel : contextUsageDisplay.label}
          />
          <span
            role="tooltip"
            className="pointer-events-none absolute left-1/2 top-full z-50 mt-1.5 -translate-x-1/2 whitespace-nowrap rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] px-2 py-1 text-[11px] font-medium text-[var(--app-fg)] opacity-0 shadow-lg transition-opacity duration-150 group-hover:opacity-100 group-focus:opacity-100"
          >
            {contextUsageDisplay.tooltip}
          </span>
        </span>
      ),
    });
  }
  if (isCouncilSession) {
    sessionHeaderMetaItems.push({
      slot: "source",
      node: (
        <ConversationMetaBadge
          tone="council"
          title="Council agent session"
          ariaLabel="Council agent session"
          icon={<UsersRound size={10} />}
          label={compactSessionMeta ? undefined : "Council"}
          paddingClassName={
            compactSessionMeta
              ? CONVERSATION_META_BADGE_PADDING_CLASS
              : CONVERSATION_META_BADGE_TRAILING_SPACE_PADDING_CLASS
          }
        />
      ),
    });
  }
  const showSessionDeleteMenuItem = props.canDeleteSession || sessionLifecycleStatus === "running";
  const sessionDeleteDisabled = !props.canDeleteSession || sessionLifecycleStatus === "running";
  const sessionDeleteTitle =
    sessionLifecycleStatus === "running"
      ? "Running sessions cannot be deleted"
      : props.canDeleteSession
        ? "Delete session"
        : "This session cannot be deleted";
  const effectiveSessionViewMode =
    sessionTuiAvailable && sessionViewMode === "tui" ? "tui" : "chat";
  const showComposer =
    effectiveSessionViewMode === "chat" || props.composerSurface.kind !== "compose";
  const terminalHasControl =
    props.isAttached && props.selectedSummary.controlLease.holderClientId === props.clientId;
  const terminalTuiClientActive = tuiTerminalId
    ? !closedTuiTerminalIds.has(tuiTerminalId)
    : true;
  const terminalInitialReplay = shouldRequestInitialTuiReplay(props.selectedSummary);
  const markCurrentTuiOpened = () => {
    if (!tuiTerminalId) {
      return;
    }
    const terminalId = tuiTerminalId;
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
    if (!tuiTerminalId) {
      return;
    }
    const terminalId = tuiTerminalId;
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
  const renderClaimComposer = (args: {
    title: string;
    description: string;
    actionLabel: string;
    actionPending: boolean;
    onClaim: () => void;
  }) => (
    <div className={COMPOSER_LAYOUT.claimRowClassName}>
      <div className="min-w-0 flex-1 truncate px-1">
        <span className="text-sm font-medium text-[var(--app-fg)]">{args.title}</span>
        {!compactComposerPrompts ? (
          <span className="ml-2 text-xs text-[var(--app-hint)]">
            {args.description}
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
          className={COMPOSER_LAYOUT.claimButtonClassName}
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
    preferredSessionViewMode,
    props.selectedSummary.session.id,
    sessionChatMirrorAvailable,
    sessionViewResetKey,
    sessionTuiAvailable,
  ]);

  useEffect(() => {
    const current = resolveActiveSessionTuiSurface({
      terminalId: tuiTerminalId,
      clientId: props.clientId,
      openedTerminalIds: openedTuiTerminalIds,
      closedTerminalIds: closedTuiTerminalIds,
    });
    const previous = activeSessionTuiRef.current;
    if (shouldDetachPreviousSessionTui(previous, current)) {
      void closeNativeTuiClient(previous.terminalId, { clientId: previous.clientId }).catch(() => undefined);
    }
    activeSessionTuiRef.current = current;
  }, [closedTuiTerminalIds, openedTuiTerminalIds, props.clientId, terminalTuiClientActive, tuiTerminalId]);

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
    <ConversationPageShell rootRef={rootRef}>
      <ConversationHeader
        sidebarOpen={props.sidebarOpen}
        onOpenLeft={props.onOpenLeft}
        onExpandSidebar={props.onExpandSidebar}
        reserveRightPanelToggleSpace={Boolean(props.reserveRightPanelToggleSpace)}
        compactCloseAction={isPwaDisplayMode}
        identity={
          <ProviderLogo provider={props.selectedSummary.session.provider} className="h-6 w-6" />
        }
        title={props.selectedSummary.session.title ?? props.selectedSummary.session.id}
        titleText={props.selectedSummary.session.title ?? props.selectedSummary.session.id}
        meta={<ConversationHeaderMetaList items={sessionHeaderMetaItems} />}
        actions={
          <>
          {sessionTuiAvailable ? (
            <>
              <ConversationHeaderIconButton
                className={compactSessionViewToggle ? "" : "md:hidden"}
                onClick={() => {
                  const nextMode = effectiveSessionViewMode === "chat" ? "tui" : "chat";
                  if (nextMode === "tui") {
                    markCurrentTuiOpened();
                  }
                  setSessionViewMode(nextMode);
                }}
                aria-label={effectiveSessionViewMode === "chat" ? "Show native TUI" : "Show chat"}
                title={effectiveSessionViewMode === "chat" ? "Show native TUI" : "Show chat"}
              >
                {effectiveSessionViewMode === "chat" ? (
                  <SquareTerminal size={15} />
                ) : (
                  <MessageSquareText size={15} />
                )}
              </ConversationHeaderIconButton>
              {!compactSessionViewToggle ? (
                <div className={`${HEADER_SEGMENTED_CONTROL_BASE_CLASS} hidden md:inline-flex`}>
                  {(["chat", "tui"] as const).map((mode) => (
                    <button
                      key={mode}
                      type="button"
                      className={`${HEADER_SEGMENTED_BUTTON_BASE_CLASS} ${
                        effectiveSessionViewMode === mode
                          ? HEADER_SEGMENTED_BUTTON_ACTIVE_CLASS
                          : HEADER_SEGMENTED_BUTTON_INACTIVE_CLASS
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
                      <span className={HEADER_SEGMENTED_LABEL_CLASS}>
                        {mode === "chat" ? "Chat" : "TUI"}
                      </span>
                    </button>
                  ))}
                </div>
              ) : null}
            </>
          ) : null}
          {!props.selectedIsReadOnlyReplay ? (
            <ConversationHeaderStopButton
              disabled={stopOrCloseDisabled}
              onClick={props.onStopOrClose}
              ariaLabel="Stop session"
              title={
                !props.isAttached
                  ? "This client is not attached"
                  : props.canStopSession
                    ? "Stop this running session"
                    : "This provider session cannot be stopped from RAH"
              }
            />
          ) : null}
          <div ref={sessionMenuRef} className="relative">
            <ConversationHeaderMoreButton
              onClick={() => setSessionMenuOpen((open) => !open)}
              open={sessionMenuOpen}
              ariaLabel="Session actions"
              title="Session actions"
            />
            {sessionMenuOpen ? (
              <div className="absolute right-0 top-[calc(100%+0.375rem)] z-50 min-w-[10rem] rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] p-1 shadow-xl">
                {props.canShowSessionInfo ? (
                  <button
                    type="button"
                    className={HEADER_MENU_ITEM_CLASS}
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
                    className={HEADER_MENU_ITEM_CLASS}
                    onClick={() => {
                      setSessionMenuOpen(false);
                      props.onRenameSession();
                    }}
                  >
                    <PencilLine size={14} />
                    <span>Rename</span>
                  </button>
                ) : null}
                {showSessionDeleteMenuItem ? (
                  <button
                    type="button"
                    className={
                      sessionDeleteDisabled ? HEADER_MENU_ITEM_CLASS : HEADER_MENU_DANGER_ITEM_CLASS
                    }
                    disabled={sessionDeleteDisabled}
                    title={sessionDeleteTitle}
                    aria-label={sessionDeleteTitle}
                    onClick={() => {
                      if (sessionDeleteDisabled) {
                        return;
                      }
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
          </>
        }
        closeAction={
          showViewCloseButton && props.selectedIsReadOnlyReplay
            ? {
                ariaLabel: "Close history view",
                title: !props.isAttached ? "This client is not attached" : "Close history view",
                disabled: stopOrCloseDisabled,
                onClick: props.onStopOrClose,
              }
            : showViewCloseButton && props.onHideSession && !props.selectedIsReadOnlyReplay
              ? {
                  ariaLabel: "Close session view",
                  title: "Close session view",
                  onClick: props.onHideSession,
                }
              : null
        }
        trailingActions={
          props.showInspectorToggle ? (
            <ConversationHeaderPanelToggleButton
              onClick={props.onToggleInspector}
              disabled={props.inspectorToggleDisabled || !props.onToggleInspector}
              ariaLabel={inspectorToggleOpen ? "Collapse inspector" : "Expand inspector"}
              open={inspectorToggleOpen}
              className={props.inspectorToggleClassName ?? ""}
              title={
                props.inspectorToggleTitle ??
                (inspectorToggleOpen ? "Collapse inspector" : "Expand inspector")
              }
            />
          ) : null
        }
      />

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

      {effectiveSessionViewMode === "tui" && tuiTerminalId ? (
        <div className="min-h-0 flex-1 bg-[var(--app-bg)] p-2 md:p-3">
          <Suspense
            fallback={
              <div className="flex h-full min-h-0 items-center justify-center rounded-xl border border-[var(--app-border)] bg-[var(--app-subtle-bg)] text-xs text-[var(--app-hint)]">
                Preparing TUI...
              </div>
            }
          >
            <TerminalPane
              key={tuiTerminalId}
              terminalId={tuiTerminalId}
              clientId={props.clientId}
              hasControl={terminalHasControl}
              tuiClientCloseEnabled
              tuiClientActive={terminalTuiClientActive}
              onTuiClientActiveChange={setTerminalTuiClientActive}
              initialReplay={terminalInitialReplay}
              scrollback={600}
              replayTailBytes={SESSION_TUI_REPLAY_TAIL_BYTES}
              maxWriteBatchChars={128 * 1024}
            />
          </Suspense>
        </div>
      ) : (
        <ChatThread
          key={props.selectedSummary.session.id}
          sessionId={props.selectedSummary.session.id}
          feed={selectedFeed}
          hideToolCalls={props.hideToolCallsInChat}
          hideOpenCodeReasoning={props.hideOpenCodeReasoningInChat}
          hideGeminiReasoning={props.hideGeminiReasoningInChat}
          showModelInfo={props.showModelInfoInChat}
          provider={props.selectedSummary.session.provider}
          canLoadOlderHistory={props.canLoadOlderHistory}
          historyLoading={props.historyLoading}
          initialLoading={initialChatLoading}
          onLoadOlderHistory={props.onLoadOlderHistory}
          {...(props.onLoadHistoryItemDetail
            ? { onLoadHistoryItemDetail: props.onLoadHistoryItemDetail }
            : {})}
          canRespondToPermission={props.canRespondToPermission}
          onPermissionRespond={props.onPermissionRespond}
          {...(props.onOpenLocalFile ? { onOpenLocalFile: props.onOpenLocalFile } : {})}
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
              description: "Resume to continue here.",
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
              description: "Claim control to continue here.",
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
    </ConversationPageShell>
  );
}

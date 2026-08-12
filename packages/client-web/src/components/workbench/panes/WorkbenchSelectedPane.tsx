import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ClipboardEventHandler, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import type {
  ContextUsage,
  PermissionResponseRequest,
  ProviderModelCatalog,
  ConversationItemDetailKind,
  SessionInputAnnotation,
  SessionQueuedInput,
  SessionSummary,
  ConversationTurnDirectoryItem,
} from "@rah/runtime-protocol";
import {
  Archive,
  ArrowUp,
  Columns3,
  Info,
  GitFork,
  LoaderCircle,
  MessageSquareText,
  PanelRightOpen,
  PencilLine,
  RefreshCcw,
  Rows3,
  SquareTerminal,
  Trash2,
} from "lucide-react";
import type { FeedEntry, SessionProjection } from "../../../types";
import { ChatThread } from "../../chat/ChatThread";
import { ProviderLogo } from "../../ProviderLogo";
import { CouncilLogo } from "../../CouncilLogo";
import { SessionModeControls } from "../../SessionModeControls";
import { SessionModelControls } from "../../SessionModelControls";
import { TokenizedTextarea } from "../../TokenizedTextarea";
import { ComposerAttachmentBadge } from "../../ComposerAttachmentBadge";
import { ComposerAttachmentControl } from "../../ComposerAttachmentControl";
import { ComposerAnnotationBadge } from "../../ComposerAnnotationBadge";
import {
  UnifiedComposerSurface,
  UnifiedComposerToolbar,
} from "../../UnifiedComposerSurface";
import { ComposerInputQueue } from "./ComposerInputQueue";
import type { ComposerAttachmentItem } from "../../../hooks/useComposerAttachments";
import { shouldSubmitComposerOnEnter } from "../../../composer-keyboard";
import {
  canSubmitComposerInput,
  COMPOSER_LAYOUT,
  COMPOSER_PLACEHOLDER,
  shouldShowComposerStopAction,
  type ComposerSurface,
} from "../../../composer-contract";
import {
  HEADER_MENU_DANGER_ITEM_CLASS,
  HEADER_MENU_ITEM_CLASS,
  HEADER_SEGMENTED_BUTTON_ACTIVE_CLASS,
  HEADER_SEGMENTED_BUTTON_BASE_CLASS,
  HEADER_SEGMENTED_BUTTON_INACTIVE_CLASS,
  HEADER_SEGMENTED_CONTROL_BASE_CLASS,
  HEADER_SEGMENTED_LABEL_CLASS,
  HEADER_TEXT_BUTTON_CLASS,
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
  type ConversationHeaderMetaItem,
} from "../ConversationMetaBadge";
import type { InlineWorkbenchNotice } from "../../../workbench-notice-contract";
import { SessionInfoDialog } from "../dialogs/SessionInfoDialog";
import {
  codexPlanModeId,
  resolveSessionModeControlState,
  type SessionModeChoice,
} from "../../../session-mode-ui";
import {
  isSessionControlLocked,
} from "../../../session-capabilities";
import { usePwaDisplayMode } from "../../../hooks/usePwaDisplayMode";
import {
  activateSessionTuiTerminal,
  PROVIDER_TUI_REPLAY_TAIL_BYTES,
  shouldReplayInitialSessionTuiOutput,
} from "../../../tui-surface-lifecycle";
import {
  conversationFeedWithInputQueue,
  conversationTurnsToFeed,
  stableConversationLocalFeed,
} from "../../../conversation-feed";
import type { SessionSideLayout } from "../session/session-side-state";
import type { SelectedConversationText } from "../../../composer-annotations";

const SESSION_TUI_SCROLLBACK_LINES = 600;
const TerminalPane = lazy(async () => ({
  default: (await import("../../../TerminalPane")).TerminalPane,
}));

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
): {
  label: string;
  compactLabel: string;
  ariaLabel: string;
  tooltip: string;
  percentUsed: number;
} | null {
  if (usage?.percentUsed === undefined && usage?.percentRemaining === undefined) {
    return null;
  }

  const percentRemainingValue = usage.percentRemaining ?? 100 - usage.percentUsed!;
  const percentRemaining = formatContextPercent(percentRemainingValue);
  const compactPercentRemaining = formatCompactContextPercent(percentRemainingValue);
  const label = `${compactPercentRemaining}%`;
  const percentUsed = Math.max(0, Math.min(100, 100 - percentRemainingValue));
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
      percentUsed,
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
    percentUsed,
  };
}

function ComposerContextIndicator(props: {
  display: NonNullable<ReturnType<typeof resolveContextUsageDisplay>>;
}) {
  const rootRef = useRef<HTMLSpanElement | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) {
      return;
    }
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer, true);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer, true);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  return (
    <span
      ref={rootRef}
      className="rah-chat-composer-secondary relative inline-flex shrink-0"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        type="button"
        className="inline-flex h-10 w-8 items-center justify-center rounded-full text-[var(--app-hint)] transition-colors hover:bg-[var(--app-subtle-bg)] md:h-9 lg:h-8"
        aria-label={props.display.ariaLabel}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={(event) => {
          event.preventDefault();
          setOpen((current) => !current);
        }}
      >
        <span
          className="relative h-[18px] w-[18px] rounded-full"
          style={{
            background: `conic-gradient(var(--app-hint) ${props.display.percentUsed}%, color-mix(in srgb, var(--app-hint) 20%, transparent) 0)`,
          }}
          aria-hidden="true"
        >
          <span className="absolute inset-[3px] rounded-full bg-[var(--app-bg)]" />
        </span>
      </button>
      {open ? (
        <span
          role="tooltip"
          className="absolute bottom-full right-0 z-[110] mb-2 w-max max-w-[min(18rem,calc(100vw-2rem))] rounded-xl border border-[var(--app-border)] bg-[var(--app-bg)] px-3 py-2 text-left text-xs leading-5 text-[var(--app-fg)] shadow-lg"
        >
          <span className="block text-[var(--app-hint)]">Context window</span>
          <span className="block font-medium">{props.display.tooltip}</span>
        </span>
      ) : null}
    </span>
  );
}

type SessionViewMode = "chat" | "tui";

function shouldRenderInteractionNotice(notice: InlineWorkbenchNotice | null): notice is InlineWorkbenchNotice {
  if (!notice) {
    return false;
  }
  // Generic read-only/observe states are already expressed by the composer
  // surface. Keep this banner for actionable native-TUI diagnostics, queued
  // input, stopped TUI, and warning states.
  return notice.message !== "History only. Resume this session for input and approvals." &&
    notice.message !== "Observe only.";
}

function chatThreadKeyForSession(summary: SessionSummary): string {
  const providerSessionId = summary.session.providerSessionId?.trim();
  return providerSessionId
    ? `${summary.session.provider}:${providerSessionId}`
    : summary.session.id;
}

export function WorkbenchSelectedPane(props: {
  selectedSummary: SessionSummary;
  clientId: string;
  selectedProjection: SessionProjection | null;
  conversationNavigationRevision?: number;
  selectedIsReadOnlyReplay: boolean;
  sidebarOpen: boolean;
  rightSidebarOpen: boolean;
  isAttached: boolean;
  interactionNotice: InlineWorkbenchNotice | null;
  generationActive: boolean;
  hideToolCallsInChat: boolean;
  hideOpenCodeReasoningInChat: boolean;
  showModelInfoInChat: boolean;
  turnDirectory?: readonly ConversationTurnDirectoryItem[] | undefined;
  onEnsureTurnDirectory?: () => void | Promise<void>;
  onLoadTurnHistory?: (turnId: string) => void | Promise<void>;
  canRespondToPermission: boolean;
  onPermissionRespond: (requestId: string, response: PermissionResponseRequest) => void;
  onOpenLocalFile?: (path: string) => void;
  onOpenTurnFileChange?: (turnId: string, path: string) => void;
  onLoadConversationItemDetail?: (
    kind: ConversationItemDetailKind,
    itemId: string,
  ) => Promise<void> | void;
  onLoadConversationTurnDetail?: (turnId: string) => Promise<void> | void;
  composerSurface: ComposerSurface;
  composerRef: RefObject<HTMLTextAreaElement | null>;
  draft: string;
  draftAttachments?: readonly ComposerAttachmentItem[] | undefined;
  draftAttachmentCount?: number | undefined;
  draftAnnotations?: readonly SessionInputAnnotation[] | undefined;
  draftAnnotationCount?: number | undefined;
  attachmentUploadPending?: boolean | undefined;
  attachmentError?: string | null | undefined;
  sendPending: boolean;
  resumeAccessModes: SessionModeChoice[];
  selectedResumeAccessModeId: string | null;
  resumePlanModeAvailable: boolean;
  resumePlanModeEnabled: boolean;
  resumeModePending: boolean;
  selectedResumeModelId: string | null;
  selectedResumeReasoningId: string | null;
  onDraftChange: (value: string) => void;
  onComposerPaste?: ClipboardEventHandler<HTMLTextAreaElement> | undefined;
  onUploadFiles?: ((files: readonly File[]) => void | Promise<void>) | undefined;
  onRemoveDraftAttachment?: ((index: number) => void) | undefined;
  onRemoveLastDraftAttachment?: (() => void) | undefined;
  onClearDraftAnnotations?: (() => void) | undefined;
  onAddSelectedText?: ((selection: SelectedConversationText) => void) | undefined;
  onSelectedTextMoreDetails?: ((selection: SelectedConversationText) => void) | undefined;
  onSend: () => void;
  onUpdateQueuedInput: (clientMessageId: string, text: string) => Promise<void> | void;
  onDeleteQueuedInput: (clientMessageId: string) => Promise<void> | void;
  onReorderQueuedInput: (clientMessageId: string, position: number) => Promise<void> | void;
  onSteerQueuedInput: (clientMessageId: string) => Promise<void> | void;
  onOpenQueuedInputSide?: (item: SessionQueuedInput) => Promise<void> | void;
  onResumeAccessModeChange: (modeId: string) => void;
  onResumePlanModeToggle: (enabled: boolean) => void;
  onResumeModelChange: (modelId: string, defaultReasoningId?: string | null) => void;
  onResumeReasoningChange: (reasoningId: string) => void;
  onClaimControl: () => void;
  onInterrupt: () => void;
  onOpenFileReference: () => void;
  fileReferenceDisabled?: boolean;
  onLoadOlderHistory: () => void | Promise<void>;
  onOpenLeft: () => void;
  onExpandSidebar: () => void;
  showLeftSidebarControls?: boolean;
  onOpenRight: () => void;
  onExpandInspector: () => void;
  onToggleInspector?: () => void;
  onFloatingAnchorOffsetChange: (offsetPx: number) => void;
  onHideSession?: () => void;
  onStopOrClose: () => void;
  onDeleteSession: () => void;
  onArchiveSession: () => void;
  onForkSession?: (() => void) | undefined;
  onCreateSide?: (() => void) | undefined;
  onRecreateSide?: (() => void) | undefined;
  canStopSession: boolean;
  canArchiveSession: boolean;
  canForkSession?: boolean;
  canCreateSide?: boolean;
  branchOperationKind?: "fork" | "side" | null;
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
  sideTaskCount?: number;
  sideTaskLayout?: SessionSideLayout;
  onSideTaskLayoutChange?: (layout: SessionSideLayout) => void;
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
  const [pwaComposerExpanded, setPwaComposerExpanded] = useState(false);
  const [sessionViewMode, setSessionViewMode] = useState<SessionViewMode>(preferredSessionViewMode);
  const [openedTuiTerminalIds, setOpenedTuiTerminalIds] = useState<Set<string>>(() => new Set());
  const [closedTuiTerminalIds, setClosedTuiTerminalIds] = useState<Set<string>>(() => new Set());
  const onLoadOlderHistoryRef = useRef(props.onLoadOlderHistory);
  const onLoadConversationItemDetailRef = useRef(props.onLoadConversationItemDetail);
  const onPermissionRespondRef = useRef(props.onPermissionRespond);
  const onOpenLocalFileRef = useRef(props.onOpenLocalFile);
  const onOpenTurnFileChangeRef = useRef(props.onOpenTurnFileChange);

  onLoadOlderHistoryRef.current = props.onLoadOlderHistory;
  onLoadConversationItemDetailRef.current = props.onLoadConversationItemDetail;
  onPermissionRespondRef.current = props.onPermissionRespond;
  onOpenLocalFileRef.current = props.onOpenLocalFile;
  onOpenTurnFileChangeRef.current = props.onOpenTurnFileChange;

  const handleChatLoadOlderHistory = useCallback(() => {
    return onLoadOlderHistoryRef.current();
  }, []);

  const handleChatLoadConversationItemDetail = useCallback(
    (kind: ConversationItemDetailKind, itemId: string) =>
      onLoadConversationItemDetailRef.current?.(kind, itemId),
    [],
  );

  const handleChatPermissionRespond = useCallback(
    (requestId: string, response: PermissionResponseRequest) =>
      onPermissionRespondRef.current(requestId, response),
    [],
  );

  const handleChatOpenLocalFile = useCallback((path: string) => {
    onOpenLocalFileRef.current?.(path);
  }, []);
  const handleChatOpenTurnFileChange = useCallback((turnId: string, path: string) => {
    onOpenTurnFileChangeRef.current?.(turnId, path);
  }, []);
  const isPwaDisplayMode = usePwaDisplayMode();
  const effectivePaneWidth = paneWidth ?? Number.POSITIVE_INFINITY;
  const sessionMetaMode = props.compactSessionMeta ?? "auto";
  const compactSessionMeta =
    sessionMetaMode === "auto"
      ? effectivePaneWidth < 720
      : sessionMetaMode === true;
  const compactSessionViewToggle = isPwaDisplayMode;
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
  const chatThreadKey = chatThreadKeyForSession(props.selectedSummary);
  const conversation = props.selectedProjection?.conversation;
  const conversationLocalFeedRef = useRef<readonly FeedEntry[]>([]);
  const conversationLocalFeed = stableConversationLocalFeed(
    props.selectedProjection?.feed ?? [],
    conversationLocalFeedRef.current,
  );
  conversationLocalFeedRef.current = conversationLocalFeed;
  const chatFeed = useMemo(
    () => conversationTurnsToFeed(
      conversation?.turns ?? [],
      conversationFeedWithInputQueue(
        conversationLocalFeed,
        props.selectedSummary.session.inputQueue ?? [],
      ),
    ),
    [
      conversation?.revision,
      conversation?.turns,
      conversationLocalFeed,
      props.selectedSummary.session.inputQueue,
    ],
  );
  const chatCanLoadOlderHistory = Boolean(conversation?.nextCursor);
  const chatHistoryLoading = conversation?.phase === "loading";
  const isCouncilSession = props.selectedSummary.session.origin?.kind === "council";
  const sessionLifecycleStatus = props.selectedIsReadOnlyReplay
    ? "stopped"
    : props.selectedSummary.session.status;
  const sessionHeaderMetaItems: ConversationHeaderMetaItem[] = [];
  if (isCouncilSession) {
    sessionHeaderMetaItems.push({
      slot: "source",
      node: (
        <ConversationMetaBadge
          tone="council"
          appearance="inline"
          title="Council agent session"
          ariaLabel="Council agent session"
          icon={<CouncilLogo className="h-3.5 w-3.5" variant="bare" />}
          label={compactSessionMeta ? undefined : "Council"}
        />
      ),
    });
  }
  const showSessionDeleteMenuItem = props.canDeleteSession || sessionLifecycleStatus === "running";
  const showSessionArchiveMenuItem = props.canArchiveSession || sessionLifecycleStatus === "running";
  const sessionArchiveDisabled = !props.canArchiveSession || sessionLifecycleStatus === "running";
  const sessionArchiveTitle =
    sessionLifecycleStatus === "running"
      ? "Stop this session before archiving it"
      : props.canArchiveSession
        ? "Archive session"
        : "This provider session cannot be archived from RAH";
  const sessionDeleteDisabled = !props.canDeleteSession || sessionLifecycleStatus === "running";
  const sessionDeleteTitle =
    sessionLifecycleStatus === "running"
      ? "Running sessions cannot be deleted"
      : props.canDeleteSession
        ? "Delete session"
        : "This session cannot be deleted";
  const effectiveSessionViewMode =
    nativeTuiAvailable && sessionViewMode === "tui" ? "tui" : "chat";
  const showComposer =
    effectiveSessionViewMode === "chat" || props.composerSurface.kind !== "compose";
  const terminalHasControl =
    props.isAttached && props.selectedSummary.controlLease.holderClientId === props.clientId;
  const terminalTuiClientActive = nativeTui
    ? !closedTuiTerminalIds.has(nativeTui.terminalId)
    : true;
  const terminalInitialReplay = shouldReplayInitialSessionTuiOutput({
    liveBackend: props.selectedSummary.session.liveBackend,
  });
  const activateCurrentTuiView = () => {
    if (!nativeTui) {
      return;
    }
    const terminalId = nativeTui.terminalId;
    const current = activateSessionTuiTerminal({
      terminalId,
      openedTerminalIds: openedTuiTerminalIds,
      closedTerminalIds: closedTuiTerminalIds,
    });
    setOpenedTuiTerminalIds(current.openedTerminalIds);
    setClosedTuiTerminalIds(current.closedTerminalIds);
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
  const resumeOnSend =
    props.composerSurface.kind === "compose" &&
    props.composerSurface.resumeOnSend === true;
  const useResumeConfiguration =
    resumeOnSend ||
    props.resumeModePending ||
    (props.sendPending && props.selectedSummary.session.phase === "starting");
  const composerActionPending =
    props.composerSurface.kind === "claim_control"
      ? props.composerSurface.actionPending
      : false;
  const sessionControlBusy = isSessionControlLocked(props.selectedSummary);
  const nativeTuiPromptDirty =
    props.composerSurface.kind === "compose" && nativeTui?.promptState === "prompt_dirty";
  const resumeSessionControlPending =
    props.resumeModePending || props.sendPending || composerActionPending;
  const stopDisabled =
    props.composerSurface.kind === "compose" && props.composerSurface.stopDisabled === true;
  const sendDisabled = !canSubmitComposerInput({
    composerSurface: props.composerSurface,
    draft: props.draft,
    attachmentCount: props.draftAttachmentCount ?? 0,
    sendPending: props.sendPending || props.attachmentUploadPending === true,
    nativeTuiPromptState: nativeTui?.promptState,
  });
  const showStopAction = shouldShowComposerStopAction({
    composerSurface: props.composerSurface,
    draft: props.draft,
    attachmentCount: props.draftAttachmentCount ?? 0,
  });
  const resumeComposerButtonClassName =
    "inline-flex h-8 w-[6.75rem] shrink-0 items-center justify-center rounded-lg bg-primary px-3 text-xs font-medium text-primary-foreground transition-colors hover:opacity-90 disabled:opacity-50";
  const renderResumeComposer = (args: {
    title: string;
    actionLabel: string;
    actionPending: boolean;
    onResume: () => void;
  }) => (
    <div className="rah-responsive-composer-shell flex min-h-10 w-full flex-col gap-1 rounded-xl border border-[var(--app-border)] bg-[var(--app-bg)] px-2 py-1 md:flex-row md:items-center md:justify-between md:gap-2 md:min-h-9 lg:min-h-8">
      <div className="min-w-0 flex-1 truncate px-1">
        <span className="text-sm font-medium text-[var(--app-fg)]">{args.title}</span>
        {!compactComposerPrompts ? (
          <span className="ml-2 text-xs text-[var(--app-hint)]">
            Resume to continue here.
          </span>
        ) : null}
      </div>
      <div
        className="flex min-w-0 flex-wrap items-center justify-end gap-1 md:flex-nowrap md:gap-1.5"
        data-resume-composer-controls="true"
      >
        <SessionModeControls
          variant="composer"
          accessModes={props.resumeAccessModes}
          selectedAccessModeId={props.selectedResumeAccessModeId}
          planModeAvailable={props.resumePlanModeAvailable}
          planModeEnabled={props.resumePlanModeEnabled}
          disabled={resumeSessionControlPending || args.actionPending}
          onOpen={props.onRequestModelCatalogRefresh}
          onAccessModeChange={props.onResumeAccessModeChange}
          onPlanModeToggle={props.onResumePlanModeToggle}
        />
        <SessionModelControls
          appearance="composer"
          catalog={props.modelCatalog}
          loading={props.modelCatalogLoading}
          selectedModelId={props.selectedResumeModelId}
          selectedReasoningId={props.selectedResumeReasoningId}
          disabled={resumeSessionControlPending || args.actionPending}
          onOpen={props.onRequestModelCatalogRefresh}
          onModelChange={props.onResumeModelChange}
          onReasoningChange={props.onResumeReasoningChange}
        />
        <button
          type="button"
          disabled={args.actionPending}
          onClick={args.onResume}
          className={resumeComposerButtonClassName}
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
    setPwaComposerExpanded(false);
  }, [props.selectedSummary.session.id]);

  useEffect(() => {
    if (showComposer) {
      return;
    }
    setPwaComposerExpanded(false);
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

  const focusPwaComposerFromPointer = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!isPwaDisplayMode) {
        return;
      }
      setPwaComposerExpanded(true);
      const target = event.target;
      if (!(target instanceof Element)) {
        return;
      }
      if (
        target.closest(
          "button,a,input,select,summary,[role='button'],[role='option'],[contenteditable='true']",
        )
      ) {
        return;
      }
      const textarea = props.composerRef.current;
      if (!textarea || textarea.disabled || document.activeElement === textarea) {
        return;
      }
      // iOS only opens the software keyboard when focus occurs synchronously
      // inside the trusted pointer gesture. Waiting for the expanded layout to
      // render turns this into the familiar two-tap composer interaction.
      textarea.focus({ preventScroll: true });
    },
    [isPwaDisplayMode, props.composerRef],
  );

  useEffect(() => {
    if (!isPwaDisplayMode || !showComposer) {
      return;
    }
    const blurComposerOutside = (event: PointerEvent) => {
      const textarea = props.composerRef.current;
      const target = event.target;
      if (target instanceof Node && composerContainerRef.current?.contains(target)) {
        return;
      }
      const targetElement =
        target instanceof Element ? target : target instanceof Node ? target.parentElement : null;
      if (
        targetElement?.closest(
          '[data-session-access-panel="true"],[data-session-model-panel="true"]',
        )
      ) {
        return;
      }
      setPwaComposerExpanded(false);
      if (textarea && document.activeElement === textarea) {
        textarea.blur();
      }
    };
    window.addEventListener("pointerdown", blurComposerOutside, true);
    return () => window.removeEventListener("pointerdown", blurComposerOutside, true);
  }, [isPwaDisplayMode, props.composerRef, showComposer]);

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
  const draftAttachments = props.draftAttachments ?? [];
  const draftAnnotations = props.draftAnnotations ?? [];

  return (
    <ConversationPageShell
      rootRef={rootRef}
      fileViewerAnchorId={props.selectedSummary.session.id}
    >
      <ConversationHeader
        sidebarOpen={props.sidebarOpen}
        onOpenLeft={props.onOpenLeft}
        onExpandSidebar={props.onExpandSidebar}
        showLeftSidebarControls={props.showLeftSidebarControls ?? true}
        compactCloseAction={isPwaDisplayMode}
        identity={
          <ProviderLogo provider={props.selectedSummary.session.provider} className="h-6 w-6" />
        }
        title={props.selectedSummary.session.title ?? props.selectedSummary.session.id}
        titleText={props.selectedSummary.session.title ?? props.selectedSummary.session.id}
        meta={
          sessionHeaderMetaItems.length > 0 ? (
            <ConversationHeaderMetaList items={sessionHeaderMetaItems} appearance="inline" />
          ) : undefined
        }
        actions={
          <>
          {nativeTuiAvailable ? (
            <>
              <ConversationHeaderIconButton
                className={compactSessionViewToggle ? "" : "md:hidden"}
                onClick={() => {
                  const nextMode = effectiveSessionViewMode === "chat" ? "tui" : "chat";
                  if (nextMode === "tui") {
                    activateCurrentTuiView();
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
                          activateCurrentTuiView();
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
          {(props.sideTaskCount ?? 0) > 1 &&
          props.sideTaskLayout &&
          props.onSideTaskLayoutChange ? (
            <button
              type="button"
              className={`${HEADER_TEXT_BUTTON_CLASS} gap-1 bg-[var(--app-subtle-bg)]`}
              onClick={() =>
                props.onSideTaskLayoutChange?.(
                  props.sideTaskLayout === "columns" ? "stack" : "columns",
                )
              }
              aria-label={
                props.sideTaskLayout === "columns"
                  ? `Stack ${props.sideTaskCount} Side tasks`
                  : `Show ${props.sideTaskCount} Side tasks side by side`
              }
              title={
                props.sideTaskLayout === "columns"
                  ? `Stack ${props.sideTaskCount} Side tasks`
                  : `Show ${props.sideTaskCount} Side tasks side by side`
              }
            >
              {props.sideTaskLayout === "columns" ? (
                <Columns3 size={13} />
              ) : (
                <Rows3 size={13} />
              )}
              <span>{props.sideTaskCount}</span>
            </button>
          ) : (props.sideTaskCount ?? 0) === 1 ? (
            <span
              className="inline-flex h-8 items-center gap-1 rounded-md border border-transparent bg-[var(--app-subtle-bg)] px-2 text-xs font-medium text-[var(--app-hint)]"
              title="1 open Side task"
            >
              <PanelRightOpen size={13} />
              1
            </span>
          ) : null}
          {props.branchOperationKind ? (
            <ConversationHeaderIconButton
              disabled
              aria-label={
                props.branchOperationKind === "fork"
                  ? "Creating new task"
                  : "Opening Side task"
              }
              title={
                props.branchOperationKind === "fork"
                  ? "Creating new task from the latest completed turn"
                  : "Opening Side task from the latest completed turn"
              }
            >
              <LoaderCircle size={15} className="animate-spin" />
            </ConversationHeaderIconButton>
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
                {props.canForkSession && props.onForkSession ? (
                  <button
                    type="button"
                    className={HEADER_MENU_ITEM_CLASS}
                    disabled={Boolean(props.branchOperationKind)}
                    aria-label="Continue in new task"
                    title="Starts another task in the same workspace. File changes are shared."
                    onClick={() => {
                      setSessionMenuOpen(false);
                      props.onForkSession?.();
                    }}
                  >
                    <GitFork size={14} />
                    <span className="flex min-w-0 flex-col items-start">
                      <span>
                        {props.branchOperationKind === "fork"
                          ? "Creating..."
                          : "Continue in new task"}
                      </span>
                      <span className="text-[10px] font-normal text-[var(--app-hint)]">
                        Shares this workspace
                      </span>
                    </span>
                  </button>
                ) : null}
                {props.canCreateSide && props.onCreateSide ? (
                  <button
                    type="button"
                    className={HEADER_MENU_ITEM_CLASS}
                    disabled={Boolean(props.branchOperationKind)}
                    aria-label="Open Side task"
                    title="Opens an ephemeral Side task in the same workspace. File changes are shared."
                    onClick={() => {
                      setSessionMenuOpen(false);
                      props.onCreateSide?.();
                    }}
                  >
                    <PanelRightOpen size={14} />
                    <span className="flex min-w-0 flex-col items-start">
                      <span>
                        {props.branchOperationKind === "side"
                          ? "Opening..."
                          : "Open Side task"}
                      </span>
                      <span className="text-[10px] font-normal text-[var(--app-hint)]">
                        Ephemeral, shared workspace
                      </span>
                    </span>
                  </button>
                ) : null}
                {props.selectedSummary.session.relationship?.kind === "side" &&
                props.selectedSummary.session.relationship.sideState === "expired" &&
                props.onRecreateSide ? (
                  <button
                    type="button"
                    className={HEADER_MENU_ITEM_CLASS}
                    onClick={() => {
                      setSessionMenuOpen(false);
                      props.onRecreateSide?.();
                    }}
                  >
                    <RefreshCcw size={14} />
                    <span>Start replacement Side</span>
                  </button>
                ) : null}
                {showSessionArchiveMenuItem ? (
                  <button
                    type="button"
                    className={HEADER_MENU_ITEM_CLASS}
                    disabled={sessionArchiveDisabled}
                    title={sessionArchiveTitle}
                    aria-label={sessionArchiveTitle}
                    onClick={() => {
                      if (sessionArchiveDisabled) {
                        return;
                      }
                      setSessionMenuOpen(false);
                      props.onArchiveSession();
                    }}
                  >
                    <Archive size={14} />
                    <span>Archive</span>
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
      ) : null}

      {effectiveSessionViewMode === "tui" && nativeTui ? (
        <div className="min-h-0 flex-1 bg-[var(--app-bg)] p-2 md:p-3">
          <Suspense
            fallback={
              <div className="flex h-full items-center justify-center text-xs text-[var(--app-hint)]">
                Loading terminal…
              </div>
            }
          >
            <TerminalPane
              key={nativeTui.terminalId}
              terminalId={nativeTui.terminalId}
              clientId={props.clientId}
              hasControl={terminalHasControl}
              tuiClientCloseEnabled
              tuiClientActive={terminalTuiClientActive}
              onTuiClientActiveChange={setTerminalTuiClientActive}
              exclusiveNativeSurfaceControl={props.selectedSummary.session.liveBackend !== "native_local_server"}
              initialReplay={terminalInitialReplay}
              scrollback={SESSION_TUI_SCROLLBACK_LINES}
              replayTailBytes={PROVIDER_TUI_REPLAY_TAIL_BYTES}
              maxWriteBatchChars={128 * 1024}
            />
          </Suspense>
        </div>
      ) : (
        <ChatThread
          key={chatThreadKey}
          sessionId={props.selectedSummary.session.id}
          navigationRevision={props.conversationNavigationRevision ?? 0}
          feed={chatFeed}
          conversationTurns={conversation?.turns ?? []}
          hideToolCalls={props.hideToolCallsInChat}
          hideOpenCodeReasoning={props.hideOpenCodeReasoningInChat}
          showModelInfo={props.showModelInfoInChat}
          provider={props.selectedSummary.session.provider}
          canLoadOlderHistory={chatCanLoadOlderHistory}
          historyLoading={chatHistoryLoading}
          historyError={
            conversation?.phase === "error"
              ? conversation.lastError ?? "Canonical conversation history is unavailable."
              : null
          }
          onRetryHistory={handleChatLoadOlderHistory}
          turnDirectory={props.turnDirectory}
          onEnsureTurnDirectory={props.onEnsureTurnDirectory}
          onLoadTurnHistory={props.onLoadTurnHistory}
          generationActive={props.generationActive}
          onLoadOlderHistory={handleChatLoadOlderHistory}
          {...(props.onLoadConversationItemDetail
            ? { onLoadConversationItemDetail: handleChatLoadConversationItemDetail }
            : {})}
          {...(props.onLoadConversationTurnDetail
            ? { onLoadConversationTurnDetail: props.onLoadConversationTurnDetail }
            : {})}
          canRespondToPermission={props.canRespondToPermission}
          onPermissionRespond={handleChatPermissionRespond}
          {...(props.onOpenLocalFile ? { onOpenLocalFile: handleChatOpenLocalFile } : {})}
          {...(props.onOpenTurnFileChange
            ? { onOpenTurnFileChange: handleChatOpenTurnFileChange }
            : {})}
          {...(props.onAddSelectedText
            ? { onAddSelectedText: props.onAddSelectedText }
            : {})}
          {...(props.onSelectedTextMoreDetails
            ? { onSelectedTextMoreDetails: props.onSelectedTextMoreDetails }
            : {})}
        />
      )}

      {showComposer ? (
        <div
          ref={composerContainerRef}
          className="shrink-0 bg-[var(--app-bg)]"
          style={COMPOSER_LAYOUT.bottomPaddingStyle}
        >
        <div className="mx-auto max-w-3xl px-0 pt-2 md:px-4 md:pt-3">
          {props.composerSurface.kind === "unavailable" ? (
            <div className="w-full rounded-xl border border-[var(--app-border)] bg-[var(--app-subtle-bg)] px-4 py-3 text-sm text-[var(--app-hint)]">
              Input is unavailable for this session.
            </div>
          ) : props.composerSurface.kind === "claim_control" ? (
            renderResumeComposer({
              title: "Resume session",
              actionLabel: props.composerSurface.actionLabel,
              actionPending: props.composerSurface.actionPending,
              onResume: props.onClaimControl,
            })
          ) : (
            <div className="relative">
              <ComposerInputQueue
                items={props.selectedSummary.session.inputQueue ?? []}
                canSteer={
                  props.selectedSummary.session.provider === "codex" &&
                  props.selectedSummary.session.capabilities.steerInput === true &&
                  props.selectedSummary.session.phase === "working"
                }
                onUpdate={props.onUpdateQueuedInput}
                onDelete={props.onDeleteQueuedInput}
                onReorder={props.onReorderQueuedInput}
                onSteer={props.onSteerQueuedInput}
                {...(props.onOpenQueuedInputSide &&
                props.selectedSummary.session.capabilities.branching?.side
                  ? { onOpenSide: props.onOpenQueuedInputSide }
                  : {})}
              />
              <UnifiedComposerSurface
                surface="chat"
                isPwa={isPwaDisplayMode}
                expanded={isPwaDisplayMode && pwaComposerExpanded}
                className={COMPOSER_LAYOUT.composeGridClassName}
                onFocusCapture={() => {
                  if (isPwaDisplayMode) {
                    setPwaComposerExpanded(true);
                  }
                }}
                onPointerDownCapture={focusPwaComposerFromPointer}
              >
                <div
                  className="rah-chat-composer-input relative flex min-w-0 flex-col"
                >
                  {draftAnnotations.length > 0 || draftAttachments.length > 0 ? (
                    <div className="rah-chat-composer-context flex max-w-full flex-wrap items-start gap-2 px-1 pb-1.5">
                      <ComposerAnnotationBadge
                        items={draftAnnotations}
                        onClear={props.onClearDraftAnnotations}
                      />
                      <ComposerAttachmentBadge
                        items={draftAttachments}
                        onRemove={props.onRemoveDraftAttachment}
                        layout={
                          isPwaDisplayMode && draftAttachments.length > 1
                            ? "stack"
                            : "row"
                        }
                      />
                    </div>
                  ) : null}
                  <TokenizedTextarea
                    ref={props.composerRef}
                    textareaClassName={COMPOSER_LAYOUT.textareaClassName}
                    contentClassName={COMPOSER_LAYOUT.textareaContentClassName}
                    value={props.draft}
                    scopeKey={`session:${props.selectedSummary.session.id}`}
                    ariaLabel="Message composer"
                    onChange={props.onDraftChange}
                    onPaste={props.onComposerPaste}
                    placeholder={COMPOSER_PLACEHOLDER}
                    rows={1}
                    onKeyDown={(e) => {
                      if (
                        e.key === "Backspace" &&
                        props.draft.length === 0 &&
                        draftAttachments.length > 0
                      ) {
                        e.preventDefault();
                        props.onRemoveLastDraftAttachment?.();
                        return;
                      }
                      if (shouldSubmitComposerOnEnter(e)) {
                        e.preventDefault();
                        if (!sendDisabled) {
                          props.onSend();
                        }
                      }
                    }}
                  />
                </div>

                <UnifiedComposerToolbar
                  leading={
                    <>
                      {props.onUploadFiles ? (
                        <ComposerAttachmentControl
                          buttonClassName={COMPOSER_LAYOUT.attachButtonClassName}
                          {...(props.fileReferenceDisabled !== undefined
                            ? { referenceDisabled: props.fileReferenceDisabled }
                            : {})}
                          referenceDisabledTitle="File references are available in single-session view."
                          onReferenceWorkspaceFile={props.onOpenFileReference}
                          onUploadFiles={props.onUploadFiles}
                          {...(props.attachmentUploadPending !== undefined
                            ? { uploadPending: props.attachmentUploadPending }
                            : {})}
                        />
                      ) : null}

                      {props.composerSurface.kind === "compose" ? (
                        <div className="rah-chat-composer-secondary min-w-0">
                          <SessionModeControls
                            variant="composer"
                            accessModes={
                              useResumeConfiguration
                                ? props.resumeAccessModes
                                : liveModeControl.accessModes
                            }
                            selectedAccessModeId={
                              useResumeConfiguration
                                ? props.selectedResumeAccessModeId
                                : liveModeControl.selectedAccessModeId
                            }
                            planModeAvailable={
                              useResumeConfiguration
                                ? props.resumePlanModeAvailable
                                : liveModeControl.planModeAvailable
                            }
                            planModeEnabled={
                              useResumeConfiguration
                                ? props.resumePlanModeEnabled
                                : liveModeControl.planModeEnabled
                            }
                            disabled={
                              useResumeConfiguration
                                ? resumeSessionControlPending
                                : !props.canSwitchSessionModes ||
                                  sessionControlBusy ||
                                  props.modeChangePending
                            }
                            onOpen={props.onRequestModelCatalogRefresh}
                            onAccessModeChange={(modeId) => {
                              if (useResumeConfiguration) {
                                props.onResumeAccessModeChange(modeId);
                                return;
                              }
                              props.onSetSessionMode(
                                props.selectedSummary.session.provider === "codex" &&
                                  liveModeControl.planModeEnabled
                                  ? codexPlanModeId(modeId) ?? modeId
                                  : modeId,
                              );
                            }}
                            onPlanModeToggle={(enabled) => {
                              if (useResumeConfiguration) {
                                props.onResumePlanModeToggle(enabled);
                                return;
                              }
                              props.onSetSessionMode(
                                enabled
                                  ? props.selectedSummary.session.provider === "codex"
                                    ? codexPlanModeId(
                                        liveModeControl.selectedAccessModeId,
                                      ) ?? "plan"
                                    : "plan"
                                  : liveModeControl.selectedAccessModeId ?? "default",
                              );
                            }}
                          />
                        </div>
                      ) : null}
                    </>
                  }
                  trailing={
                    <>
                      {contextUsageDisplay ? (
                        <ComposerContextIndicator display={contextUsageDisplay} />
                      ) : null}
                      {props.composerSurface.kind === "compose" ? (
                        <div className="rah-chat-composer-secondary rah-chat-composer-model-control min-w-0">
                          <SessionModelControls
                            appearance="composer"
                            catalog={props.modelCatalog}
                            selectedModelId={
                              useResumeConfiguration
                                ? props.selectedResumeModelId
                                : props.selectedSummary.session.model?.currentModelId ?? null
                            }
                            selectedReasoningId={
                              useResumeConfiguration
                                ? props.selectedResumeReasoningId
                                : props.selectedSummary.session.model?.currentReasoningId ?? null
                            }
                            loading={props.modelCatalogLoading}
                            disabled={
                              useResumeConfiguration
                                ? resumeSessionControlPending
                                : !props.canSwitchSessionModel ||
                                  sessionControlBusy ||
                                  props.modelChangePending
                            }
                            onOpen={props.onRequestModelCatalogRefresh}
                            onModelChange={(modelId, defaultReasoningId) => {
                              if (useResumeConfiguration) {
                                props.onResumeModelChange(modelId, defaultReasoningId);
                                return;
                              }
                              props.onSetSessionModel(modelId, defaultReasoningId);
                            }}
                            onReasoningChange={(reasoningId) => {
                              if (useResumeConfiguration) {
                                props.onResumeReasoningChange(reasoningId);
                                return;
                              }
                              props.onSetSessionModel(
                                props.selectedSummary.session.model?.currentModelId ?? "",
                                reasoningId,
                              );
                            }}
                          />
                        </div>
                      ) : null}

                      {showStopAction ? (
                        <button
                          type="button"
                          data-composer-primary-action="stop"
                          disabled={stopDisabled}
                          onClick={stopDisabled ? undefined : props.onInterrupt}
                          aria-label={
                            props.composerSurface.kind === "compose" &&
                            props.composerSurface.stopAriaLabel
                              ? props.composerSurface.stopAriaLabel
                              : "Stop generating"
                          }
                          title={
                            props.composerSurface.kind === "compose"
                              ? props.composerSurface.stopTitle
                              : undefined
                          }
                          className={
                            props.composerSurface.kind === "compose" &&
                            props.composerSurface.stopTone === "warning"
                              ? COMPOSER_LAYOUT.stopWarningActionButtonClassName
                              : COMPOSER_LAYOUT.primaryActionButtonClassName
                          }
                        >
                          {props.composerSurface.kind === "compose" &&
                          props.composerSurface.stopTone === "warning" ? (
                            <span aria-hidden="true">Esc</span>
                          ) : (
                            <span
                              aria-hidden="true"
                              className="block h-2.5 w-2.5 rounded-[2px] bg-current"
                            />
                          )}
                        </button>
                      ) : (
                        <button
                          type="button"
                          data-composer-primary-action="send"
                          disabled={sendDisabled}
                          onClick={props.onSend}
                          aria-label="Send message"
                          title={
                            nativeTuiPromptDirty
                              ? "Clear the current TUI prompt before sending from Chat."
                              : undefined
                          }
                          className={COMPOSER_LAYOUT.primaryActionButtonClassName}
                        >
                          <ArrowUp className="h-[18px] w-[18px] md:h-4 md:w-4" />
                        </button>
                      )}
                    </>
                  }
                />
              </UnifiedComposerSurface>
              {props.attachmentError ? (
                <p className="mt-1 px-2 text-xs text-destructive" role="status">
                  {props.attachmentError}
                </p>
              ) : null}
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

import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import type { FeedEntry } from "../../types";
import type { SelectedConversationText } from "../../composer-annotations";
import type {
  ConversationTurnProjection,
  ConversationTurnFileChangesProjection,
  PermissionResponseRequest,
  ProviderKind,
  ConversationItemDetailKind,
  ConversationTurnDirectoryItem,
  TimelineItem,
} from "@rah/runtime-protocol";
import {
  AlertCircle,
  ArrowDown,
  ArrowUpToLine,
  Circle,
  CircleCheckBig,
  CircleDashed,
  FileText,
  Info,
  Link2,
  ListChecks,
  Sparkles,
} from "lucide-react";
import { AssistantMessage } from "./AssistantMessage";
import { AssistantTurnCopyAction } from "./AssistantTurnCopyAction";
import { AssistantProcessGroup } from "./AssistantProcessGroup";
import { AssistantTurnHeader } from "./AssistantTurnHeader";
import { ContextCompactionDivider } from "./ContextCompactionDivider";
import { ConversationTurnNavigator } from "./ConversationTurnNavigator";
import { TaskSummaryDock } from "./TaskSummaryDock";
import { ConversationFileChangesCard } from "./ConversationFileChangesCard";
import { ReviewDialog } from "../../inspector/ReviewDialog";
import type { ReviewScope } from "../../inspector/ReviewSurface";
import { MarkdownRenderer } from "./MarkdownRenderer";
import { MessagePartCard } from "./MessagePartCard";
import { ObservationCard } from "./ObservationCard";
import { OperationCard } from "./OperationCard";
import { PermissionCard } from "./PermissionCard";
import { Reasoning } from "./Reasoning";
import { SystemNotice } from "./SystemNotice";
import { ToolCallCard } from "./ToolCallCard";
import { UserMessage } from "./UserMessage";
import {
  SelectedTextOverlay,
  type SelectedTextOverlayState,
} from "./SelectedTextOverlay";
import {
  defaultAssistantProcessGroupExpanded,
  type ChatDisplayRow,
} from "./assistant-process-groups";
import { buildAssistantTurnHeaders } from "./assistant-turn-headers";
import {
  buildConversationTurnNavigationItems,
  visibleConversationTurnKeys,
  type ConversationTurnNavigationItem,
} from "./conversation-turn-navigation";
import {
  advanceLatestReplyAutoNavigationState,
  createLatestReplyAutoNavigationState,
  latestNavigableAssistantReplyKey,
  latestVisibleUserMessageKey,
  resolveLatestReplyStartTarget,
  type LatestReplyAutoNavigationState,
} from "./latest-reply-navigation";
import {
  buildVirtualFeedLayout,
  estimateFeedEntryHeight,
  projectVirtualAnchorScrollTop,
  resolveVirtualFeedWindow,
  VIRTUAL_FEED_ROW_GAP_PX,
} from "./virtualized-feed-layout";
import { resolvePrependAnchorScrollTop } from "./prepend-scroll-anchor";
import { visibleFeedEntries } from "./chat-feed-filtering";
import { latestCurrentPlan, withoutInlinePlans } from "./current-plan";
import { usePwaDisplayMode } from "../../hooks/usePwaDisplayMode";
import {
  conversationDisplayRows,
  conversationFinalAssistantKeys,
} from "../../conversation-feed";
import {
  advanceBottomFollowSettle,
  createBottomFollowSettleState,
} from "./bottom-follow-settling";

const BOTTOM_STICK_THRESHOLD_PX = 120;
const TOP_HISTORY_TRIGGER_PX = 96;
const TOP_HISTORY_REARM_PX = 220;
const VIEWPORT_RESIZE_EPSILON_PX = 4;
const BOTTOM_RESIZE_SETTLE_FRAMES = 2;
const BOTTOM_FOREGROUND_SETTLE_FRAMES = 4;
const BOTTOM_USER_JUMP_SETTLE_FRAMES = 8;
const NO_COPYABLE_ASSISTANT_KEYS: ReadonlySet<string> = new Set();
const PROCESS_TO_FINAL_ROW_GAP_PX = 10;
const DESKTOP_CHAT_DISPLAY_ROW_GAP_PX = 14;
const PWA_CHAT_DISPLAY_ROW_GAP_PX = 12;

function isDocumentHidden(): boolean {
  return typeof document !== "undefined" && document.visibilityState === "hidden";
}

function isScrollNearBottom(node: HTMLElement): boolean {
  return node.scrollHeight - node.clientHeight - node.scrollTop <= BOTTOM_STICK_THRESHOLD_PX;
}

function chatDisplayRowGapPx(
  row: ChatDisplayRow,
  index: number,
  rows: readonly ChatDisplayRow[],
  defaultRowGapPx = VIRTUAL_FEED_ROW_GAP_PX,
): number {
  const nextRow = rows[index + 1];
  if (row.kind === "assistant_process_group" && nextRow?.kind === "feed_entry") {
    return PROCESS_TO_FINAL_ROW_GAP_PX;
  }
  if (
    row.kind === "feed_entry" &&
    nextRow?.kind === "turn_file_changes"
  ) {
    return 10;
  }
  if (nextRow?.kind === "turn_copy_action") {
    return 8;
  }
  return defaultRowGapPx;
}

function estimateChatDisplayRowHeight(row: ChatDisplayRow): number {
  if (row.kind === "assistant_process_group") {
    return defaultAssistantProcessGroupExpanded(row) ? 180 : 33;
  }
  if (row.kind === "turn_file_changes") {
    return 50;
  }
  if (row.kind === "turn_copy_action") {
    return 28;
  }
  return estimateFeedEntryHeight(row.entry);
}

function TimelineCard(props: {
  icon: React.ReactNode;
  title: string;
  subtitle?: string;
  tone?: "default" | "warning" | "danger";
  children: React.ReactNode;
}) {
  const toneClassName =
    props.tone === "danger"
      ? "border-[var(--app-danger)] bg-[var(--app-danger-bg)]"
      : props.tone === "warning"
        ? "border-[var(--app-warning)] bg-[var(--app-warning-bg)]"
        : "border-[var(--app-border)] bg-[var(--app-subtle-bg)]";

  return (
    <div className="flex items-start justify-start gap-3">
      <div className={`w-full rounded-lg border px-3 py-2 ${toneClassName}`}>
        <div className="flex items-center gap-2 text-sm font-medium text-[var(--app-fg)]">
          {props.icon}
          <span>{props.title}</span>
        </div>
        {props.subtitle ? (
          <div className="mt-0.5 text-xs text-[var(--app-hint)]">{props.subtitle}</div>
        ) : null}
        <div className="mt-2 text-[var(--app-fg)]">{props.children}</div>
      </div>
    </div>
  );
}

function renderTimelineItem(item: TimelineItem, options: {
  entryKey?: string;
  sessionId?: string;
  canCopyAssistant?: boolean;
  onOpenLocalFile?: (path: string) => void;
  onLoadDetail?: () => Promise<void> | void;
} = {}) {
  switch (item.kind) {
    case "user_message":
      return (
        <UserMessage
          content={item.text}
          imageCount={item.imageCount}
          attachments={item.attachments}
          entryKey={options.entryKey}
          onOpenLocalFile={options.onOpenLocalFile}
          onLoadDetail={options.onLoadDetail}
        />
      );
    case "assistant_message":
      return (
        <AssistantMessage
          content={item.text}
          {...(item.content ? { contentParts: item.content } : {})}
          {...(options.sessionId ? { sessionId: options.sessionId } : {})}
          {...(options.entryKey ? { entryKey: options.entryKey } : {})}
          variant={
            item.phase === "final_answer" || options.canCopyAssistant
              ? "final"
              : "process"
          }
          {...(options.onOpenLocalFile ? { onOpenLocalFile: options.onOpenLocalFile } : {})}
        />
      );
    case "reasoning":
      return (
        <Reasoning
          text={item.text}
          {...(options.onOpenLocalFile ? { onOpenLocalFile: options.onOpenLocalFile } : {})}
        />
      );
    case "plan":
      return (
        <TimelineCard
          icon={<Sparkles size={14} className="text-[var(--app-hint)]" />}
          title="Plan"
        >
          <MarkdownRenderer
            className="prose-chat text-sm leading-relaxed"
            content={item.text}
            {...(options.onOpenLocalFile ? { onOpenLocalFile: options.onOpenLocalFile } : {})}
          />
        </TimelineCard>
      );
    case "step":
      return (
        <TimelineCard
          icon={
            item.status === "completed" ? (
              <CircleCheckBig size={14} className="text-[var(--app-success)]" />
            ) : item.status === "interrupted" ? (
              <AlertCircle size={14} className="text-[var(--app-warning)]" />
            ) : (
              <CircleDashed size={14} className="text-[var(--app-hint)]" />
            )
          }
          title={item.title}
          subtitle={item.status}
          tone={item.status === "interrupted" ? "warning" : "default"}
        >
          {item.text ? <div className="whitespace-pre-wrap text-xs">{item.text}</div> : null}
        </TimelineCard>
      );
    case "todo":
      return (
        <TimelineCard
          icon={<ListChecks size={14} className="text-[var(--app-hint)]" />}
          title="Checklist"
        >
          <div className="space-y-1">
            {item.items.map((todo) => (
              <div key={`${todo.text}:${todo.completed}`} className="flex items-start gap-2">
                {todo.completed ? (
                  <CircleCheckBig size={14} className="mt-0.5 shrink-0 text-[var(--app-success)]" />
                ) : (
                  <Circle size={14} className="mt-0.5 shrink-0 text-[var(--app-hint)]" />
                )}
                <div
                  className={`text-xs ${
                    todo.completed ? "text-[var(--app-hint)] line-through" : "text-[var(--app-fg)]"
                  }`}
                >
                  {todo.text}
                </div>
              </div>
            ))}
          </div>
        </TimelineCard>
      );
    case "system":
      return <SystemNotice content={item.text} />;
    case "error":
      return <SystemNotice content={`Error: ${item.text}`} />;
    case "retry":
      return (
        <SystemNotice
          content={`Retry ${item.attempt}${item.error ? `: ${item.error}` : ""}`}
        />
      );
    case "side_question":
      return (
        <TimelineCard
          icon={<Info size={14} className="text-[var(--app-hint)]" />}
          title="Side question"
          subtitle={item.question}
        >
          <div className="space-y-1 text-xs">
            {item.response ? (
              <div className="rounded-md bg-[var(--app-bg)] px-2 py-1.5 break-words [overflow-wrap:anywhere]">
                {item.response}
              </div>
            ) : null}
            {item.error ? (
              <div className="rounded-md border border-[var(--app-danger)] bg-[var(--app-danger-bg)] px-2 py-1.5 text-[var(--app-danger)] break-words [overflow-wrap:anywhere]">
                {item.error}
              </div>
            ) : null}
          </div>
        </TimelineCard>
      );
    case "attachment":
      return (
        <TimelineCard
          icon={<FileText size={14} className="text-[var(--app-hint)]" />}
          title={item.label}
        >
          <div className="space-y-1 text-xs">
            {item.path ? (
              <div className="rounded-md bg-[var(--app-bg)] px-2 py-1.5 font-mono break-all">
                {item.path}
              </div>
            ) : null}
            {item.url ? (
              <a
                href={item.url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex max-w-full items-center gap-1.5 break-all underline underline-offset-2"
              >
                <Link2 size={12} />
                <span>{item.url}</span>
              </a>
            ) : null}
          </div>
        </TimelineCard>
      );
    case "compaction":
      return <ContextCompactionDivider item={item} />;
  }
}

function renderEntry(
  entry: FeedEntry,
  sessionId: string,
  canRespondToPermission: boolean | undefined,
  onPermissionRespond: (requestId: string, response: PermissionResponseRequest) => void,
  onOpenLocalFile: ((path: string) => void) | undefined,
  onLoadConversationItemDetail:
    | ((kind: ConversationItemDetailKind, itemId: string) => Promise<void> | void)
    | undefined,
  onLoadConversationTurnDetail:
    | ((turnId: string) => Promise<void> | void)
    | undefined,
  copyableAssistantKeys: ReadonlySet<string>,
) {
  switch (entry.kind) {
    case "timeline":
      return renderTimelineItem(entry.item, {
        entryKey: entry.key,
        sessionId,
        canCopyAssistant: copyableAssistantKeys.has(entry.key),
        ...(onOpenLocalFile ? { onOpenLocalFile } : {}),
        ...(entry.item.kind === "user_message" &&
        (entry.canonicalTurnId || entry.turnId) &&
        onLoadConversationTurnDetail
          ? {
              onLoadDetail: () =>
                onLoadConversationTurnDetail(entry.canonicalTurnId ?? entry.turnId!),
            }
          : {}),
      });
    case "tool_call":
      return (
        <ToolCallCard
          toolCall={entry.toolCall}
          status={entry.status}
          {...(entry.error !== undefined ? { error: entry.error } : {})}
          {...(onLoadConversationItemDetail
            ? {
                onLoadDetail: () =>
                  onLoadConversationItemDetail("tool_call", entry.toolCall.id),
              }
            : {})}
        />
      );
    case "permission":
      return (
        <PermissionCard
          request={entry.request}
          {...(entry.resolution !== undefined ? { resolution: entry.resolution } : {})}
          {...(canRespondToPermission !== undefined ? { canRespond: canRespondToPermission } : {})}
          onRespond={onPermissionRespond}
        />
      );
    case "observation":
      return (
        <ObservationCard
          observation={entry.observation}
          status={entry.status}
          {...(entry.error !== undefined ? { error: entry.error } : {})}
          {...(onLoadConversationItemDetail
            ? {
                onLoadDetail: () =>
                  onLoadConversationItemDetail("observation", entry.observation.id),
              }
            : {})}
        />
      );
    case "operation":
      return <OperationCard operation={entry.operation} status={entry.status} />;
    case "message_part":
      return <MessagePartCard part={entry.part} status={entry.status} />;
    case "runtime_status":
      return (
        <SystemNotice
          content={
            entry.detail ??
            (entry.retryCount !== undefined
              ? `Retrying… ${entry.retryCount}`
              : `Runtime: ${entry.status}`)
          }
        />
      );
    case "notification":
      return (
        <SystemNotice
          content={`${entry.title}${entry.body ? ` — ${entry.body}` : ""}`}
        />
      );
  }
}

function MeasuredFeedEntry(props: {
  entryKey: string;
  isLastEntry: boolean;
  rowGapPx: number;
  onHeightChange: (entryKey: string, height: number) => void;
  children: React.ReactNode;
}) {
  const rowRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    const node = contentRef.current;
    if (!node) {
      return;
    }

    const report = () => {
      props.onHeightChange(props.entryKey, node.offsetHeight);
    };

    report();
    if (typeof ResizeObserver === "undefined") {
      return;
    }

    const observer = new ResizeObserver(report);
    observer.observe(node);
    return () => observer.disconnect();
  }, [props.entryKey, props.onHeightChange]);

  return (
    <div
      ref={rowRef}
      data-feed-entry-key={props.entryKey}
      className="min-w-0 max-w-full"
      style={
        props.isLastEntry || props.rowGapPx <= 0
          ? undefined
          : { paddingBottom: `${props.rowGapPx}px` }
      }
    >
      <div ref={contentRef} className="min-w-0 max-w-full">
        {props.children}
      </div>
    </div>
  );
}

export const ChatThread = memo(function ChatThread(props: {
  sessionId: string;
  navigationRevision?: number;
  feed: FeedEntry[];
  conversationTurns: readonly ConversationTurnProjection[];
  hideToolCalls?: boolean;
  hideOpenCodeReasoning?: boolean;
  showModelInfo?: boolean;
  provider?: ProviderKind;
  canLoadOlderHistory?: boolean;
  historyLoading?: boolean;
  historyError?: string | null;
  generationActive?: boolean;
  onLoadOlderHistory?: () => void | Promise<void>;
  onRetryHistory?: () => void | Promise<void>;
  turnDirectory?: readonly ConversationTurnDirectoryItem[] | undefined;
  onEnsureTurnDirectory?: (() => void | Promise<void>) | undefined;
  onLoadTurnHistory?: ((turnId: string) => void | Promise<void>) | undefined;
  onLoadConversationItemDetail?: (
    kind: ConversationItemDetailKind,
    itemId: string,
  ) => Promise<void> | void;
  onLoadConversationTurnDetail?: (turnId: string) => Promise<void> | void;
  canRespondToPermission?: boolean;
  onPermissionRespond: (requestId: string, response: PermissionResponseRequest) => void;
  onOpenLocalFile?: (path: string) => void;
  onOpenTurnFileChange?: (turnId: string, path: string) => void;
  onAddSelectedText?: (selection: SelectedConversationText) => void;
  onSelectedTextMoreDetails?: (selection: SelectedConversationText) => void;
}) {
  type PrependAnchor = {
    scrollHeight: number;
    scrollTop: number;
    entryKey: string | null;
    offsetTop: number | null;
  };
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const rowsOriginRef = useRef<HTMLDivElement | null>(null);
  const previousEntryCountRef = useRef(0);
  const loadingOlderRef = useRef(false);
  const stickToBottomRef = useRef(true);
  const userDetachedFromBottomRef = useRef(false);
  const sessionSwitchBottomLockRef = useRef(true);
  const returnToBottomOnVisibleRef = useRef(true);
  const pendingVisibleBottomRestoreRef = useRef(false);
  const prependAnchorRef = useRef<PrependAnchor | null>(null);
  const lastScrollTopRef = useRef(0);
  const lastClientHeightRef = useRef(0);
  const touchScrollYRef = useRef<number | null>(null);
  const topHistoryAutoLoadArmedRef = useRef(true);
  const textSelectionDragActiveRef = useRef(false);
  const textSelectionListenerCleanupRef = useRef<(() => void) | null>(null);
  const pendingMeasuredHeightUpdateRef = useRef(false);
  const measuredHeightsRef = useRef<Map<string, number>>(new Map());
  const scrollRafRef = useRef<number | null>(null);
  const bottomFollowRafRef = useRef<number | null>(null);
  const measuredHeightsRafRef = useRef<number | null>(null);
  const topHistoryLoadRafRef = useRef<number | null>(null);
  const prependAnchorRestoreRafRef = useRef<number | null>(null);
  const latestReplyStartTargetRef = useRef<ReturnType<typeof resolveLatestReplyStartTarget>>(null);
  const turnNavigationRafRef = useRef<number | null>(null);
  const turnNavigationReleaseRafRef = useRef<number | null>(null);
  const turnNavigationActiveRef = useRef(false);
  const pendingTurnNavigationIdRef = useRef<string | null>(null);
  const ensureTurnDirectoryRef = useRef(props.onEnsureTurnDirectory);
  const latestReplyAutoNavigationRef = useRef<LatestReplyAutoNavigationState>({
    latestUserKey: null,
    latestReplyKey: null,
    generationActive: Boolean(props.generationActive),
    armed: Boolean(props.generationActive),
    pendingReplyKey: null,
  });
  const consumePendingAutoLatestReplyScrollRef = useRef<() => boolean>(() => true);
  const autoNavigatedLatestReplyKeysRef = useRef(new Set<string>());
  const autoLoadedInterruptedTurnIdsRef = useRef(new Set<string>());
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const [measuredHeightsVersion, setMeasuredHeightsVersion] = useState(0);
  const [viewport, setViewport] = useState({ scrollTop: 0, height: 0, contentTopOffset: 0 });
  const [textSelectionDragActive, setTextSelectionDragActive] = useState(false);
  const [selectedTextOverlay, setSelectedTextOverlay] =
    useState<SelectedTextOverlayState | null>(null);
  const selectionCaptureRafRef = useRef<number | null>(null);
  const [processGroupExpansionOverrides, setProcessGroupExpansionOverrides] = useState(
    () => new Map<string, boolean>(),
  );
  const [loadingProcessTurnIds, setLoadingProcessTurnIds] = useState(
    () => new Set<string>(),
  );
  const loadingProcessTurnIdsRef = useRef(loadingProcessTurnIds);
  loadingProcessTurnIdsRef.current = loadingProcessTurnIds;
  const [reviewScope, setReviewScope] = useState<ReviewScope | null>(null);
  const isPwaDisplayMode = usePwaDisplayMode();
  const resolveChatDisplayRowGapPx = useCallback(
    (row: ChatDisplayRow, index: number, rows: readonly ChatDisplayRow[]) =>
      chatDisplayRowGapPx(
        row,
        index,
        rows,
        isPwaDisplayMode
          ? PWA_CHAT_DISPLAY_ROW_GAP_PX
          : DESKTOP_CHAT_DISPLAY_ROW_GAP_PX,
      ),
    [isPwaDisplayMode],
  );
  const projectedFeed = props.feed;
  const visibleEntriesWithPlans = useMemo(
    () =>
      visibleFeedEntries(
        projectedFeed,
        props.hideToolCalls ?? false,
        props.hideOpenCodeReasoning ?? false,
        props.provider,
      ),
    [
      projectedFeed,
      props.hideToolCalls,
      props.hideOpenCodeReasoning,
      props.provider,
    ],
  );
  const activeVisibleEntriesWithPlans = useMemo(
    () =>
      visibleFeedEntries(
        projectedFeed,
        false,
        props.hideOpenCodeReasoning ?? false,
        props.provider,
      ),
    [projectedFeed, props.hideOpenCodeReasoning, props.provider],
  );
  const currentPlan = useMemo(
    () => latestCurrentPlan(props.conversationTurns),
    [props.conversationTurns],
  );
  const openTurnReview = useCallback(
    (turnId: string, fileChanges: ConversationTurnFileChangesProjection) => {
      setReviewScope({
        kind: "turn",
        sessionId: props.sessionId,
        turnId,
        workspaceRoot: "",
        files: fileChanges.files,
        totalAdditions: fileChanges.totalAdditions,
        totalDeletions: fileChanges.totalDeletions,
        truncated: false,
      });
    },
    [props.sessionId],
  );
  const currentPlanTurnId =
    currentPlan?.turn.providerTurnId ?? currentPlan?.turn.id ?? null;
  const currentPlanFileChanges = currentPlan?.turn.fileChanges;
  useEffect(() => {
    if (!currentPlanTurnId || !currentPlanFileChanges) {
      return;
    }
    setReviewScope((current) => {
      if (
        current?.kind !== "turn" ||
        current.turnId !== currentPlanTurnId ||
        (current.files === currentPlanFileChanges.files &&
          current.totalAdditions === currentPlanFileChanges.totalAdditions &&
          current.totalDeletions === currentPlanFileChanges.totalDeletions)
      ) {
        return current;
      }
      return {
        ...current,
        files: currentPlanFileChanges.files,
        totalAdditions: currentPlanFileChanges.totalAdditions,
        totalDeletions: currentPlanFileChanges.totalDeletions,
      };
    });
  }, [currentPlanFileChanges, currentPlanTurnId]);
  const entries = useMemo(
    () => withoutInlinePlans(visibleEntriesWithPlans),
    [visibleEntriesWithPlans],
  );
  const activeEntries = useMemo(
    () => withoutInlinePlans(activeVisibleEntriesWithPlans),
    [activeVisibleEntriesWithPlans],
  );
  const copyableAssistantKeys = useMemo(
    () => conversationFinalAssistantKeys(props.conversationTurns),
    [props.conversationTurns],
  );
  const renderProcessEntry = useCallback(
    (entry: FeedEntry) =>
      renderEntry(
        entry,
        props.sessionId,
        props.canRespondToPermission,
        props.onPermissionRespond,
        props.onOpenLocalFile,
        props.onLoadConversationItemDetail,
        props.onLoadConversationTurnDetail,
        NO_COPYABLE_ASSISTANT_KEYS,
      ),
    [
      props.canRespondToPermission,
      props.onLoadConversationItemDetail,
      props.onLoadConversationTurnDetail,
      props.onOpenLocalFile,
      props.onPermissionRespond,
      props.sessionId,
    ],
  );
  const assistantTurnHeaders = useMemo(
    () => buildAssistantTurnHeaders(entries, copyableAssistantKeys),
    [copyableAssistantKeys, entries],
  );
  const latestVisibleUserKey = useMemo(
    () => latestVisibleUserMessageKey(entries),
    [entries],
  );
  const latestNavigableReplyKey = useMemo(
    () => latestNavigableAssistantReplyKey(entries, copyableAssistantKeys),
    [copyableAssistantKeys, entries],
  );
  const displayRows = useMemo(
    () =>
      conversationDisplayRows(props.conversationTurns, entries, activeEntries, {
        generationActive: props.generationActive === true,
      }),
    [activeEntries, entries, props.conversationTurns, props.generationActive],
  );
  useEffect(() => {
    autoLoadedInterruptedTurnIdsRef.current.clear();
  }, [props.sessionId]);
  useEffect(() => {
    if (!props.onLoadConversationTurnDetail) {
      return;
    }
    for (const row of displayRows) {
      if (
        row.kind !== "assistant_process_group" ||
        row.turnStatus !== "interrupted" ||
        !row.detailsAvailable ||
        !row.turnId ||
        !(
          processGroupExpansionOverrides.get(row.key) ??
          defaultAssistantProcessGroupExpanded(row)
        ) ||
        autoLoadedInterruptedTurnIdsRef.current.has(row.turnId)
      ) {
        continue;
      }
      const turnId = row.turnId;
      autoLoadedInterruptedTurnIdsRef.current.add(turnId);
      setLoadingProcessTurnIds((current) => new Set(current).add(turnId));
      void Promise.resolve(props.onLoadConversationTurnDetail(turnId)).finally(() => {
        setLoadingProcessTurnIds((current) => {
          const next = new Set(current);
          next.delete(turnId);
          return next;
        });
      });
    }
  }, [
    displayRows,
    processGroupExpansionOverrides,
    props.onLoadConversationTurnDetail,
  ]);
  const virtualLayout = useMemo(
    () =>
      buildVirtualFeedLayout(
        displayRows,
        measuredHeightsRef.current,
        resolveChatDisplayRowGapPx,
        estimateChatDisplayRowHeight,
      ),
    [displayRows, measuredHeightsVersion, resolveChatDisplayRowGapPx],
  );
  const turnNavigationItems = useMemo(
    () =>
      isPwaDisplayMode
        ? []
        : buildConversationTurnNavigationItems(
            entries,
            virtualLayout,
            props.turnDirectory ?? [],
            props.conversationTurns,
          ),
    [entries, isPwaDisplayMode, props.conversationTurns, props.turnDirectory, virtualLayout],
  );
  const activeTurnNavigationKeys = useMemo(
    () =>
      visibleConversationTurnKeys({
        items: turnNavigationItems,
        scrollTop: viewport.scrollTop,
        viewportHeight: viewport.height,
        contentTopOffset: viewport.contentTopOffset,
      }),
    [turnNavigationItems, viewport.contentTopOffset, viewport.height, viewport.scrollTop],
  );
  const shouldVirtualize =
    displayRows.length > 140 && viewport.height > 0 && !textSelectionDragActive;
  const virtualScrollTop = useMemo(() => {
    const anchor = prependAnchorRef.current;
    if (!anchor?.entryKey || anchor.offsetTop === null) {
      return viewport.scrollTop;
    }
    return (
      projectVirtualAnchorScrollTop({
        layout: virtualLayout,
        entryKey: anchor.entryKey,
        viewportOffset: anchor.offsetTop,
        contentTopOffset: viewport.contentTopOffset,
      }) ?? viewport.scrollTop
    );
  }, [virtualLayout, viewport.contentTopOffset, viewport.scrollTop]);
  const virtualWindow = useMemo(
    () =>
      shouldVirtualize
        ? resolveVirtualFeedWindow({
            layout: virtualLayout,
            scrollTop: virtualScrollTop,
            viewportHeight: viewport.height,
          })
        : {
            startIndex: 0,
            endIndex: displayRows.length,
            topSpacerHeight: 0,
            bottomSpacerHeight: 0,
          },
    [displayRows.length, shouldVirtualize, virtualLayout, viewport.height, virtualScrollTop],
  );
  const visibleRowsWindow = displayRows.slice(virtualWindow.startIndex, virtualWindow.endIndex);
  const latestReplyStartTarget = useMemo(
    () =>
      resolveLatestReplyStartTarget({
        entries,
        layout: virtualLayout,
        measuredHeights: measuredHeightsRef.current,
        scrollTop: viewport.scrollTop,
        viewportHeight: viewport.height,
        contentTopOffset: viewport.contentTopOffset,
        navigableAssistantKeys: copyableAssistantKeys,
      }),
    [copyableAssistantKeys, entries, measuredHeightsVersion, virtualLayout, viewport.contentTopOffset, viewport.height, viewport.scrollTop],
  );

  useLayoutEffect(() => {
    ensureTurnDirectoryRef.current = props.onEnsureTurnDirectory;
  }, [props.onEnsureTurnDirectory]);

  useEffect(() => {
    latestReplyStartTargetRef.current = latestReplyStartTarget;
  }, [latestReplyStartTarget]);

  const syncViewport = useCallback(() => {
    const node = containerRef.current;
    if (!node) {
      return;
    }
    const rowsOrigin = rowsOriginRef.current;
    const contentTopOffset = rowsOrigin
      ? node.scrollTop + rowsOrigin.getBoundingClientRect().top - node.getBoundingClientRect().top
      : 0;
    setViewport((current) =>
      current.scrollTop === node.scrollTop &&
      current.height === node.clientHeight &&
      Math.abs(current.contentTopOffset - contentTopOffset) < 0.5
        ? current
        : {
            scrollTop: node.scrollTop,
            height: node.clientHeight,
            contentTopOffset,
          },
    );
  }, []);

  const handleEntryHeightChange = useCallback((entryKey: string, height: number) => {
    const roundedHeight = Math.max(1, Math.ceil(height));
    if (measuredHeightsRef.current.get(entryKey) === roundedHeight) {
      return;
    }
    measuredHeightsRef.current.set(entryKey, roundedHeight);
    if (textSelectionDragActiveRef.current) {
      pendingMeasuredHeightUpdateRef.current = true;
      return;
    }
    if (measuredHeightsRafRef.current !== null) {
      return;
    }
    measuredHeightsRafRef.current = requestAnimationFrame(() => {
      measuredHeightsRafRef.current = null;
      setMeasuredHeightsVersion((version) => version + 1);
    });
  }, []);

  const scrollToBottomNow = useCallback(() => {
    const node = containerRef.current;
    if (!node) {
      return null;
    }
    const targetScrollTop = Math.max(0, node.scrollHeight - node.clientHeight);
    const moved = Math.abs(node.scrollTop - targetScrollTop) >= 0.5;
    if (moved) {
      node.scrollTop = targetScrollTop;
    }
    lastScrollTopRef.current = node.scrollTop;
    stickToBottomRef.current = true;
    userDetachedFromBottomRef.current = false;
    returnToBottomOnVisibleRef.current = true;
    pendingVisibleBottomRestoreRef.current = false;
    setShowScrollToBottom(false);
    if (moved) {
      syncViewport();
    }
    return { extent: targetScrollTop, moved };
  }, [syncViewport]);

  const scheduleScrollToBottom = useCallback(() => {
    if (bottomFollowRafRef.current !== null) {
      return;
    }
    bottomFollowRafRef.current = requestAnimationFrame(() => {
      bottomFollowRafRef.current = null;
      scrollToBottomNow();
    });
  }, [scrollToBottomNow]);

  const settleScrollToBottomOverFrames = useCallback((frames: number) => {
    if (bottomFollowRafRef.current !== null) {
      cancelAnimationFrame(bottomFollowRafRef.current);
      bottomFollowRafRef.current = null;
    }
    let settleState = createBottomFollowSettleState(frames);
    const runSettlePass = () => {
      bottomFollowRafRef.current = null;
      const sample = scrollToBottomNow();
      if (!sample) {
        return;
      }
      const advanced = advanceBottomFollowSettle(settleState, sample);
      settleState = advanced.state;
      if (advanced.shouldContinue) {
        bottomFollowRafRef.current = requestAnimationFrame(runSettlePass);
      }
    };
    runSettlePass();
  }, [scrollToBottomNow]);

  const settleScrollToBottomAfterResize = useCallback(() => {
    settleScrollToBottomOverFrames(BOTTOM_RESIZE_SETTLE_FRAMES);
  }, [settleScrollToBottomOverFrames]);

  const detachBottomFollowing = useCallback(() => {
    const node = containerRef.current;
    stickToBottomRef.current = false;
    userDetachedFromBottomRef.current = true;
    sessionSwitchBottomLockRef.current = false;
    returnToBottomOnVisibleRef.current = false;
    pendingVisibleBottomRestoreRef.current = false;
    if (bottomFollowRafRef.current !== null) {
      cancelAnimationFrame(bottomFollowRafRef.current);
      bottomFollowRafRef.current = null;
    }
    if (node && node.scrollHeight > node.clientHeight) {
      setShowScrollToBottom(true);
    }
  }, []);

  const captureProcessDisclosureAnchor = useCallback(
    (anchorElement: HTMLElement) => {
      const node = containerRef.current;
      const row = anchorElement.closest<HTMLElement>("[data-feed-entry-key]");
      if (!node || !row) {
        return;
      }
      detachBottomFollowing();
      const containerTop = node.getBoundingClientRect().top;
      prependAnchorRef.current = {
        scrollHeight: node.scrollHeight,
        scrollTop: node.scrollTop,
        entryKey: row.dataset.feedEntryKey ?? null,
        offsetTop: row.getBoundingClientRect().top - containerTop,
      };
    },
    [detachBottomFollowing],
  );

  const handleProcessGroupExpandedChange = useCallback(
    (
      group: Extract<ChatDisplayRow, { kind: "assistant_process_group" }>,
      expanded: boolean,
      anchor: HTMLElement,
    ) => {
      captureProcessDisclosureAnchor(anchor);
      setProcessGroupExpansionOverrides((current) => {
        const next = new Map(current);
        next.set(group.key, expanded);
        return next;
      });
      const loadTurnDetail = props.onLoadConversationTurnDetail;
      if (
        !expanded ||
        !group.detailsAvailable ||
        !group.turnId ||
        !loadTurnDetail ||
        loadingProcessTurnIdsRef.current.has(group.turnId)
      ) {
        return;
      }
      const turnId = group.turnId;
      const loading = new Set(loadingProcessTurnIdsRef.current).add(turnId);
      loadingProcessTurnIdsRef.current = loading;
      setLoadingProcessTurnIds(loading);
      void Promise.resolve(loadTurnDetail(turnId)).finally(() => {
        setLoadingProcessTurnIds((current) => {
          const next = new Set(current);
          next.delete(turnId);
          loadingProcessTurnIdsRef.current = next;
          return next;
        });
      });
    },
    [captureProcessDisclosureAnchor, props.onLoadConversationTurnDetail],
  );

  const restoreBottomAfterForeground = useCallback(() => {
    if (
      !returnToBottomOnVisibleRef.current &&
      !pendingVisibleBottomRestoreRef.current &&
      !sessionSwitchBottomLockRef.current
    ) {
      return;
    }
    settleScrollToBottomOverFrames(BOTTOM_FOREGROUND_SETTLE_FRAMES);
  }, [settleScrollToBottomOverFrames]);

  const captureVisiblePrependAnchor = useCallback((): PrependAnchor | null => {
    const node = containerRef.current;
    if (!node) {
      return null;
    }
    const containerTop = node.getBoundingClientRect().top;
    const entryNodes = Array.from(
      node.querySelectorAll<HTMLElement>("[data-feed-entry-key]"),
    );
    const visibleNode =
      entryNodes.find((entryNode) => entryNode.getBoundingClientRect().bottom > containerTop + 1) ??
      entryNodes[0] ??
      null;
    return {
      scrollHeight: node.scrollHeight,
      scrollTop: node.scrollTop,
      entryKey: visibleNode?.dataset.feedEntryKey ?? null,
      offsetTop: visibleNode ? visibleNode.getBoundingClientRect().top - containerTop : null,
    };
  }, []);

  const restoreVisiblePrependAnchor = useCallback((): boolean => {
    const node = containerRef.current;
    const anchor = prependAnchorRef.current;
    if (!node || !anchor) {
      return false;
    }

    const containerTop = node.getBoundingClientRect().top;
    const anchorNode =
      anchor.entryKey === null
        ? null
        : Array.from(node.querySelectorAll<HTMLElement>("[data-feed-entry-key]")).find(
            (entryNode) => entryNode.dataset.feedEntryKey === anchor.entryKey,
          ) ?? null;
    const nextScrollTop = resolvePrependAnchorScrollTop({
      currentScrollTop: node.scrollTop,
      anchorScrollTop: anchor.scrollTop,
      currentScrollHeight: node.scrollHeight,
      anchorScrollHeight: anchor.scrollHeight,
      currentViewportOffset: anchorNode
        ? anchorNode.getBoundingClientRect().top - containerTop
        : null,
      anchorViewportOffset: anchor.offsetTop,
    });

    if (Math.abs(node.scrollTop - nextScrollTop) >= 0.5) {
      node.scrollTop = nextScrollTop;
    }
    prependAnchorRef.current = {
      ...anchor,
      scrollHeight: node.scrollHeight,
      scrollTop: node.scrollTop,
    };
    lastScrollTopRef.current = node.scrollTop;
    syncViewport();
    return true;
  }, [syncViewport]);

  const schedulePrependAnchorRestore = useCallback(() => {
    if (prependAnchorRestoreRafRef.current !== null) {
      return;
    }
    prependAnchorRestoreRafRef.current = requestAnimationFrame(() => {
      prependAnchorRestoreRafRef.current = null;
      restoreVisiblePrependAnchor();
    });
  }, [restoreVisiblePrependAnchor]);

  useLayoutEffect(() => {
    if (prependAnchorRef.current) {
      restoreVisiblePrependAnchor();
    }
  }, [processGroupExpansionOverrides, restoreVisiblePrependAnchor]);

  const releaseSettledPrependAnchor = useCallback(() => {
    if (props.historyLoading || loadingOlderRef.current) {
      return;
    }
    prependAnchorRef.current = null;
    if (prependAnchorRestoreRafRef.current !== null) {
      cancelAnimationFrame(prependAnchorRestoreRafRef.current);
      prependAnchorRestoreRafRef.current = null;
    }
  }, [props.historyLoading]);

  const isInTopHistoryLoadZone = useCallback((node: HTMLElement): boolean => {
    return (
      node.scrollTop <= TOP_HISTORY_TRIGGER_PX ||
      node.scrollHeight <= node.clientHeight + TOP_HISTORY_TRIGGER_PX
    );
  }, []);

  const hasTooLittleHistoryContent = useCallback((node: HTMLElement): boolean => {
    return node.scrollHeight <= node.clientHeight + TOP_HISTORY_TRIGGER_PX;
  }, []);

  const requestOlderHistoryLoad = useCallback((): boolean => {
    const node = containerRef.current;
    if (
      !node ||
      !props.canLoadOlderHistory ||
      !props.onLoadOlderHistory ||
      props.historyLoading ||
      loadingOlderRef.current ||
      turnNavigationActiveRef.current ||
      textSelectionDragActiveRef.current ||
      !topHistoryAutoLoadArmedRef.current ||
      !isInTopHistoryLoadZone(node)
    ) {
      return false;
    }
    topHistoryAutoLoadArmedRef.current = false;
    loadingOlderRef.current = true;
    prependAnchorRef.current = captureVisiblePrependAnchor();
    const loadResult = props.onLoadOlderHistory();
    void Promise.resolve(loadResult).finally(() => {
      loadingOlderRef.current = false;
    });
    return true;
  }, [
    captureVisiblePrependAnchor,
    isInTopHistoryLoadZone,
    props.canLoadOlderHistory,
    props.historyLoading,
    props.onLoadOlderHistory,
  ]);

  const scheduleTopHistoryLoad = useCallback(() => {
    if (topHistoryLoadRafRef.current !== null) {
      return;
    }
    topHistoryLoadRafRef.current = requestAnimationFrame(() => {
      topHistoryLoadRafRef.current = null;
      requestOlderHistoryLoad();
    });
  }, [requestOlderHistoryLoad]);

  useLayoutEffect(() => {
    previousEntryCountRef.current = 0;
    loadingOlderRef.current = false;
    stickToBottomRef.current = true;
    userDetachedFromBottomRef.current = false;
    sessionSwitchBottomLockRef.current = true;
    prependAnchorRef.current = null;
    lastScrollTopRef.current = 0;
    lastClientHeightRef.current = 0;
    touchScrollYRef.current = null;
    topHistoryAutoLoadArmedRef.current = true;
    textSelectionDragActiveRef.current = false;
    textSelectionListenerCleanupRef.current?.();
    textSelectionListenerCleanupRef.current = null;
    pendingMeasuredHeightUpdateRef.current = false;
    setTextSelectionDragActive(false);
    measuredHeightsRef.current = new Map();
    if (scrollRafRef.current !== null) {
      cancelAnimationFrame(scrollRafRef.current);
      scrollRafRef.current = null;
    }
    if (bottomFollowRafRef.current !== null) {
      cancelAnimationFrame(bottomFollowRafRef.current);
      bottomFollowRafRef.current = null;
    }
    if (measuredHeightsRafRef.current !== null) {
      cancelAnimationFrame(measuredHeightsRafRef.current);
      measuredHeightsRafRef.current = null;
    }
    if (topHistoryLoadRafRef.current !== null) {
      cancelAnimationFrame(topHistoryLoadRafRef.current);
      topHistoryLoadRafRef.current = null;
    }
    if (prependAnchorRestoreRafRef.current !== null) {
      cancelAnimationFrame(prependAnchorRestoreRafRef.current);
      prependAnchorRestoreRafRef.current = null;
    }
    if (turnNavigationRafRef.current !== null) {
      cancelAnimationFrame(turnNavigationRafRef.current);
      turnNavigationRafRef.current = null;
    }
    if (turnNavigationReleaseRafRef.current !== null) {
      cancelAnimationFrame(turnNavigationReleaseRafRef.current);
      turnNavigationReleaseRafRef.current = null;
    }
    turnNavigationActiveRef.current = false;
    latestReplyAutoNavigationRef.current = createLatestReplyAutoNavigationState({
      latestUserKey: latestVisibleUserKey,
      latestReplyKey: latestNavigableReplyKey,
      generationActive: Boolean(props.generationActive),
    });
    autoNavigatedLatestReplyKeysRef.current = new Set();
    pendingTurnNavigationIdRef.current = null;
    setMeasuredHeightsVersion(0);
    setViewport({ scrollTop: 0, height: 0, contentTopOffset: 0 });
    setShowScrollToBottom(false);
    setProcessGroupExpansionOverrides(new Map());
    const node = containerRef.current;
    if (node) {
      node.scrollTop = node.scrollHeight;
      lastScrollTopRef.current = node.scrollTop;
    }
  }, [props.navigationRevision, props.sessionId]);

  useEffect(() => {
    return () => {
      if (scrollRafRef.current !== null) {
        cancelAnimationFrame(scrollRafRef.current);
        scrollRafRef.current = null;
      }
      if (bottomFollowRafRef.current !== null) {
        cancelAnimationFrame(bottomFollowRafRef.current);
        bottomFollowRafRef.current = null;
      }
      if (measuredHeightsRafRef.current !== null) {
        cancelAnimationFrame(measuredHeightsRafRef.current);
        measuredHeightsRafRef.current = null;
      }
      if (topHistoryLoadRafRef.current !== null) {
        cancelAnimationFrame(topHistoryLoadRafRef.current);
        topHistoryLoadRafRef.current = null;
      }
      if (turnNavigationRafRef.current !== null) {
        cancelAnimationFrame(turnNavigationRafRef.current);
        turnNavigationRafRef.current = null;
      }
      if (turnNavigationReleaseRafRef.current !== null) {
        cancelAnimationFrame(turnNavigationReleaseRafRef.current);
        turnNavigationReleaseRafRef.current = null;
      }
      turnNavigationActiveRef.current = false;
      textSelectionListenerCleanupRef.current?.();
      textSelectionListenerCleanupRef.current = null;
      latestReplyAutoNavigationRef.current.pendingReplyKey = null;
    };
  }, []);

  const finishTextSelectionDrag = useCallback(() => {
    textSelectionListenerCleanupRef.current?.();
    textSelectionListenerCleanupRef.current = null;
    if (!textSelectionDragActiveRef.current) {
      return;
    }
    textSelectionDragActiveRef.current = false;
    setTextSelectionDragActive(false);
    if (pendingMeasuredHeightUpdateRef.current) {
      pendingMeasuredHeightUpdateRef.current = false;
      setMeasuredHeightsVersion((version) => version + 1);
    }
    syncViewport();
  }, [syncViewport]);

  const handlePotentialTextSelectionStart = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    if (event.button !== 0 || event.defaultPrevented) {
      return;
    }
    setSelectedTextOverlay(null);
    const target = event.target as HTMLElement | null;
    const interactiveTarget = target?.closest(
      "button,a,input,textarea,select,summary,[role='button'],[contenteditable='true']",
    );
    const selectableInteractiveText = target?.closest(
      "[data-selectable-conversation-text='true']",
    );
    if (interactiveTarget && !selectableInteractiveText) {
      return;
    }

    finishTextSelectionDrag();
    const startX = event.clientX;
    const startY = event.clientY;

    const handleMouseMove = (moveEvent: MouseEvent) => {
      if (textSelectionDragActiveRef.current) {
        return;
      }
      const distance =
        Math.abs(moveEvent.clientX - startX) + Math.abs(moveEvent.clientY - startY);
      if (distance < 4) {
        return;
      }
      textSelectionDragActiveRef.current = true;
      setTextSelectionDragActive(true);
    };

    const cleanup = () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", finishTextSelectionDrag);
      window.removeEventListener("blur", finishTextSelectionDrag);
    };

    textSelectionListenerCleanupRef.current = cleanup;
    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", finishTextSelectionDrag);
    window.addEventListener("blur", finishTextSelectionDrag);
  }, [finishTextSelectionDrag]);

  const captureSelectedText = useCallback(() => {
    selectionCaptureRafRef.current = null;
    if (!props.onAddSelectedText && !props.onSelectedTextMoreDetails) {
      return;
    }
    const selection = window.getSelection();
    const contentNode = contentRef.current;
    if (!selection || selection.isCollapsed || selection.rangeCount === 0 || !contentNode) {
      setSelectedTextOverlay(null);
      return;
    }
    const range = selection.getRangeAt(0);
    if (
      !contentNode.contains(range.startContainer) ||
      !contentNode.contains(range.endContainer)
    ) {
      setSelectedTextOverlay(null);
      return;
    }
    const sourceForNode = (node: Node) =>
      (node.nodeType === Node.ELEMENT_NODE
        ? (node as Element)
        : node.parentElement
      )?.closest<HTMLElement>("[data-selection-source='conversation-message']") ?? null;
    const startSource = sourceForNode(range.startContainer);
    const endSource = sourceForNode(range.endContainer);
    if (!startSource || startSource !== endSource) {
      setSelectedTextOverlay(null);
      return;
    }
    const text = selection.toString().trim();
    const rect = range.getClientRects().item(0) ?? range.getBoundingClientRect();
    if (!text || (rect.width <= 0 && rect.height <= 0)) {
      setSelectedTextOverlay(null);
      return;
    }
    const role = startSource.dataset.selectionRole;
    setSelectedTextOverlay({
      selection: {
        text,
        source: {
          sessionId: props.sessionId,
          ...(startSource.dataset.selectionEntryKey
            ? { entryKey: startSource.dataset.selectionEntryKey }
            : {}),
          ...(role === "assistant" || role === "user" ? { role } : {}),
        },
      },
      anchor: { left: rect.left, top: rect.top, bottom: rect.bottom },
    });
  }, [props.onAddSelectedText, props.onSelectedTextMoreDetails, props.sessionId]);

  const handlePotentialTextSelectionEnd = useCallback(() => {
    if (selectionCaptureRafRef.current !== null) {
      cancelAnimationFrame(selectionCaptureRafRef.current);
    }
    selectionCaptureRafRef.current = requestAnimationFrame(captureSelectedText);
  }, [captureSelectedText]);

  useEffect(() => {
    const node = containerRef.current;
    if (!node) {
      return;
    }
    const dismiss = () => setSelectedTextOverlay(null);
    node.addEventListener("scroll", dismiss, { passive: true });
    window.addEventListener("resize", dismiss);
    return () => {
      node.removeEventListener("scroll", dismiss);
      window.removeEventListener("resize", dismiss);
      if (selectionCaptureRafRef.current !== null) {
        cancelAnimationFrame(selectionCaptureRafRef.current);
        selectionCaptureRafRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    setSelectedTextOverlay(null);
    window.getSelection()?.removeAllRanges();
  }, [props.sessionId]);

  useEffect(() => {
    if (!selectedTextOverlay) {
      return;
    }
    const dismissOutsideOverlay = (event: PointerEvent) => {
      const target = event.target;
      if (
        target instanceof Element &&
        target.closest("[data-selected-text-overlay='true']")
      ) {
        return;
      }
      setSelectedTextOverlay(null);
    };
    document.addEventListener("pointerdown", dismissOutsideOverlay, true);
    return () => document.removeEventListener("pointerdown", dismissOutsideOverlay, true);
  }, [selectedTextOverlay]);

  useEffect(() => {
    const node = containerRef.current;
    if (!node) {
      return;
    }

    const updateStickiness = () => {
      if (textSelectionDragActiveRef.current) {
        lastScrollTopRef.current = node.scrollTop;
        return;
      }
      const previousStickToBottom = stickToBottomRef.current;
      const previousReturnToBottom = returnToBottomOnVisibleRef.current;
      const scrollingUp = node.scrollTop < lastScrollTopRef.current;
      const previousClientHeight = lastClientHeightRef.current;
      const clientHeightChanged =
        previousClientHeight > 0 &&
        Math.abs(node.clientHeight - previousClientHeight) > VIEWPORT_RESIZE_EPSILON_PX;
      lastClientHeightRef.current = node.clientHeight;
      if (
        clientHeightChanged &&
        !scrollingUp &&
        !userDetachedFromBottomRef.current &&
        (previousStickToBottom || previousReturnToBottom || sessionSwitchBottomLockRef.current)
      ) {
        settleScrollToBottomAfterResize();
        return;
      }
      const isAtBottom = isScrollNearBottom(node);
      const isExactlyAtBottom =
        node.scrollHeight - node.clientHeight - node.scrollTop <= 2;
      if (isExactlyAtBottom && !scrollingUp) {
        userDetachedFromBottomRef.current = false;
      }
      const shouldStickToBottom = isAtBottom && !userDetachedFromBottomRef.current;
      const contentNeedsMoreHistory = hasTooLittleHistoryContent(node);
      stickToBottomRef.current = shouldStickToBottom;
      if (!isDocumentHidden()) {
        returnToBottomOnVisibleRef.current =
          shouldStickToBottom || sessionSwitchBottomLockRef.current;
      }
      if (!shouldStickToBottom) {
        sessionSwitchBottomLockRef.current = false;
      }
      setShowScrollToBottom(
        !shouldStickToBottom && node.scrollHeight > node.clientHeight,
      );

      if (node.scrollTop > TOP_HISTORY_REARM_PX || contentNeedsMoreHistory) {
        topHistoryAutoLoadArmedRef.current = true;
      }
      if (
        topHistoryAutoLoadArmedRef.current &&
        isInTopHistoryLoadZone(node)
      ) {
        requestOlderHistoryLoad();
      }
      lastScrollTopRef.current = node.scrollTop;
      if (scrollRafRef.current !== null) {
        cancelAnimationFrame(scrollRafRef.current);
      }
      scrollRafRef.current = requestAnimationFrame(() => {
        scrollRafRef.current = null;
        syncViewport();
      });
    };

    updateStickiness();
    node.addEventListener("scroll", updateStickiness, { passive: true });
    return () => {
      node.removeEventListener("scroll", updateStickiness);
    };
  }, [
    props.canLoadOlderHistory,
    props.historyLoading,
    props.onLoadOlderHistory,
    hasTooLittleHistoryContent,
    isInTopHistoryLoadZone,
    requestOlderHistoryLoad,
    props.sessionId,
    settleScrollToBottomAfterResize,
    syncViewport,
  ]);

  useEffect(() => {
    const node = containerRef.current;
    if (!node) {
      return;
    }
    const handleWheel = (event: WheelEvent) => {
      releaseSettledPrependAnchor();
      if (event.deltaY < 0) {
        detachBottomFollowing();
      }
    };
    const handleTouchStart = (event: TouchEvent) => {
      releaseSettledPrependAnchor();
      touchScrollYRef.current = event.touches[0]?.clientY ?? null;
    };
    const handlePointerDown = () => {
      releaseSettledPrependAnchor();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        event.key === "ArrowUp" ||
        event.key === "ArrowDown" ||
        event.key === "PageUp" ||
        event.key === "PageDown" ||
        event.key === "Home" ||
        event.key === "End" ||
        event.key === " "
      ) {
        releaseSettledPrependAnchor();
      }
    };
    const handleTouchMove = (event: TouchEvent) => {
      const nextY = event.touches[0]?.clientY ?? null;
      const previousY = touchScrollYRef.current;
      if (nextY !== null && previousY !== null && nextY - previousY > 2) {
        detachBottomFollowing();
      }
      touchScrollYRef.current = nextY;
    };
    const handleTouchEnd = () => {
      touchScrollYRef.current = null;
    };

    node.addEventListener("wheel", handleWheel, { passive: true });
    node.addEventListener("touchstart", handleTouchStart, { passive: true });
    node.addEventListener("touchmove", handleTouchMove, { passive: true });
    node.addEventListener("touchend", handleTouchEnd, { passive: true });
    node.addEventListener("touchcancel", handleTouchEnd, { passive: true });
    node.addEventListener("pointerdown", handlePointerDown, { passive: true });
    node.addEventListener("keydown", handleKeyDown);
    return () => {
      node.removeEventListener("wheel", handleWheel);
      node.removeEventListener("touchstart", handleTouchStart);
      node.removeEventListener("touchmove", handleTouchMove);
      node.removeEventListener("touchend", handleTouchEnd);
      node.removeEventListener("touchcancel", handleTouchEnd);
      node.removeEventListener("pointerdown", handlePointerDown);
      node.removeEventListener("keydown", handleKeyDown);
    };
  }, [detachBottomFollowing, releaseSettledPrependAnchor]);

  useEffect(() => {
    const rememberHiddenStickiness = () => {
      const node = containerRef.current;
      if (!node) {
        return;
      }
      returnToBottomOnVisibleRef.current =
        sessionSwitchBottomLockRef.current ||
        stickToBottomRef.current ||
        (!userDetachedFromBottomRef.current && isScrollNearBottom(node));
    };

    const handleVisibilityChange = () => {
      if (isDocumentHidden()) {
        rememberHiddenStickiness();
        return;
      }
      restoreBottomAfterForeground();
      requestAnimationFrame(() => consumePendingAutoLatestReplyScrollRef.current());
    };

    const handleForeground = () => {
      if (!isDocumentHidden()) {
        restoreBottomAfterForeground();
        requestAnimationFrame(() => consumePendingAutoLatestReplyScrollRef.current());
      }
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("focus", handleForeground);
    window.addEventListener("pageshow", handleForeground);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("focus", handleForeground);
      window.removeEventListener("pageshow", handleForeground);
    };
  }, [restoreBottomAfterForeground]);

  useEffect(() => {
    const node = containerRef.current;
    if (!node || typeof ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver(() => {
      const previousClientHeight = lastClientHeightRef.current;
      const clientHeightChanged =
        previousClientHeight <= 0 ||
        Math.abs(node.clientHeight - previousClientHeight) > VIEWPORT_RESIZE_EPSILON_PX;
      lastClientHeightRef.current = node.clientHeight;
      if (!clientHeightChanged) {
        syncViewport();
        return;
      }
      const shouldFollowBottom =
        !userDetachedFromBottomRef.current &&
        (stickToBottomRef.current ||
          returnToBottomOnVisibleRef.current ||
          sessionSwitchBottomLockRef.current);
      if (!shouldFollowBottom) {
        syncViewport();
        return;
      }
      if (isDocumentHidden()) {
        pendingVisibleBottomRestoreRef.current = true;
        syncViewport();
        return;
      }
      settleScrollToBottomAfterResize();
    });
    observer.observe(node);
    syncViewport();
    return () => observer.disconnect();
  }, [props.sessionId, settleScrollToBottomAfterResize, syncViewport]);

  useEffect(() => {
    const node = containerRef.current;
    const content = contentRef.current;
    if (!node || !content || typeof ResizeObserver === "undefined") {
      return;
    }

    const observer = new ResizeObserver(() => {
      if (prependAnchorRef.current) {
        schedulePrependAnchorRestore();
        return;
      }
      if (textSelectionDragActiveRef.current) {
        return;
      }
      if (userDetachedFromBottomRef.current) {
        return;
      }
      if (!stickToBottomRef.current && !sessionSwitchBottomLockRef.current) {
        return;
      }
      if (isDocumentHidden()) {
        pendingVisibleBottomRestoreRef.current = true;
        return;
      }
      scheduleScrollToBottom();
      if (!props.historyLoading) {
        sessionSwitchBottomLockRef.current = false;
      }
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, [
    props.historyLoading,
    props.sessionId,
    schedulePrependAnchorRestore,
    scheduleScrollToBottom,
  ]);

  useLayoutEffect(() => {
    const node = containerRef.current;
    if (!node) {
      return;
    }
    if (textSelectionDragActiveRef.current) {
      previousEntryCountRef.current = displayRows.length;
      return;
    }
    const anchor = prependAnchorRef.current;
    if (anchor) {
      restoreVisiblePrependAnchor();
      if (
        !props.historyLoading &&
        props.canLoadOlderHistory &&
        props.onLoadOlderHistory &&
        hasTooLittleHistoryContent(node)
      ) {
        topHistoryAutoLoadArmedRef.current = true;
        scheduleTopHistoryLoad();
      }
      if (!props.historyLoading) {
        loadingOlderRef.current = false;
      }
      previousEntryCountRef.current = displayRows.length;
      return;
    }

    const shouldForceBottom = sessionSwitchBottomLockRef.current;
    if (shouldForceBottom) {
      if (isDocumentHidden()) {
        pendingVisibleBottomRestoreRef.current = true;
        previousEntryCountRef.current = displayRows.length;
        return;
      }
      node.scrollTop = node.scrollHeight;
      lastScrollTopRef.current = node.scrollTop;
      stickToBottomRef.current = true;
      userDetachedFromBottomRef.current = false;
      returnToBottomOnVisibleRef.current = true;
      setShowScrollToBottom(false);
      if (!props.historyLoading) {
        sessionSwitchBottomLockRef.current = false;
      }
    } else if (displayRows.length > previousEntryCountRef.current && stickToBottomRef.current) {
      if (isDocumentHidden()) {
        pendingVisibleBottomRestoreRef.current = true;
        previousEntryCountRef.current = displayRows.length;
        return;
      }
      scrollToBottomNow();
    }
    previousEntryCountRef.current = displayRows.length;
  }, [
    displayRows,
    hasTooLittleHistoryContent,
    isInTopHistoryLoadZone,
    measuredHeightsVersion,
    props.canLoadOlderHistory,
    props.historyLoading,
    props.onLoadOlderHistory,
    props.sessionId,
    restoreVisiblePrependAnchor,
    scrollToBottomNow,
    scheduleTopHistoryLoad,
  ]);

  const handleScrollToBottom = () => {
    stickToBottomRef.current = true;
    userDetachedFromBottomRef.current = false;
    sessionSwitchBottomLockRef.current = false;
    returnToBottomOnVisibleRef.current = true;
    pendingVisibleBottomRestoreRef.current = false;
    prependAnchorRef.current = null;
    topHistoryAutoLoadArmedRef.current = false;
    settleScrollToBottomOverFrames(BOTTOM_USER_JUMP_SETTLE_FRAMES);
  };

  const scrollToLatestReplyStart = useCallback((target: NonNullable<ReturnType<typeof resolveLatestReplyStartTarget>>) => {
    const node = containerRef.current;
    if (!node) {
      return;
    }
    stickToBottomRef.current = false;
    userDetachedFromBottomRef.current = true;
    sessionSwitchBottomLockRef.current = false;
    returnToBottomOnVisibleRef.current = false;
    pendingVisibleBottomRestoreRef.current = false;
    prependAnchorRef.current = null;
    if (bottomFollowRafRef.current !== null) {
      cancelAnimationFrame(bottomFollowRafRef.current);
      bottomFollowRafRef.current = null;
    }

    const containerTop = node.getBoundingClientRect().top;
    const targetNode =
      Array.from(node.querySelectorAll<HTMLElement>("[data-feed-entry-key]")).find(
        (entryNode) => entryNode.dataset.feedEntryKey === target.entryKey,
      ) ?? null;
    if (targetNode) {
      node.scrollTop += targetNode.getBoundingClientRect().top - containerTop;
    } else {
      node.scrollTop = target.targetScrollTop;
    }
    lastScrollTopRef.current = node.scrollTop;
    setShowScrollToBottom(node.scrollHeight > node.clientHeight);
    syncViewport();
  }, [syncViewport]);

  const handleScrollToLatestReplyStart = () => {
    if (!latestReplyStartTarget) {
      return;
    }
    scrollToLatestReplyStart(latestReplyStartTarget);
  };

  const consumePendingAutoLatestReplyScroll = useCallback(() => {
    const pendingReplyKey = latestReplyAutoNavigationRef.current.pendingReplyKey;
    if (!pendingReplyKey) {
      return true;
    }
    if (isDocumentHidden()) {
      return false;
    }
    if (
      userDetachedFromBottomRef.current ||
      (!stickToBottomRef.current &&
        !returnToBottomOnVisibleRef.current &&
        !sessionSwitchBottomLockRef.current)
    ) {
      latestReplyAutoNavigationRef.current.pendingReplyKey = null;
      return true;
    }
    const target = latestReplyStartTargetRef.current;
    if (!target || target.entryKey !== pendingReplyKey) {
      return false;
    }
    latestReplyAutoNavigationRef.current.pendingReplyKey = null;
    if (autoNavigatedLatestReplyKeysRef.current.has(target.entryKey)) {
      return true;
    }
    autoNavigatedLatestReplyKeysRef.current.add(target.entryKey);
    scrollToLatestReplyStart(target);
    return true;
  }, [scrollToLatestReplyStart]);

  consumePendingAutoLatestReplyScrollRef.current = consumePendingAutoLatestReplyScroll;

  useEffect(() => {
    const previous = latestReplyAutoNavigationRef.current;
    const next = advanceLatestReplyAutoNavigationState(previous, {
      latestUserKey: latestVisibleUserKey,
      latestReplyKey: latestNavigableReplyKey,
      generationActive: Boolean(props.generationActive),
    });
    latestReplyAutoNavigationRef.current = next;
    if (!next.pendingReplyKey || next.pendingReplyKey === previous.pendingReplyKey) {
      return;
    }
    consumePendingAutoLatestReplyScroll();
  }, [
    consumePendingAutoLatestReplyScroll,
    latestNavigableReplyKey,
    latestVisibleUserKey,
    props.generationActive,
  ]);

  useEffect(() => {
    consumePendingAutoLatestReplyScroll();
  }, [consumePendingAutoLatestReplyScroll, latestReplyStartTarget]);

  const releaseTurnNavigationAfterLayout = useCallback(() => {
    if (turnNavigationReleaseRafRef.current !== null) {
      cancelAnimationFrame(turnNavigationReleaseRafRef.current);
    }
    turnNavigationReleaseRafRef.current = requestAnimationFrame(() => {
      turnNavigationReleaseRafRef.current = requestAnimationFrame(() => {
        turnNavigationReleaseRafRef.current = null;
        turnNavigationActiveRef.current = false;
      });
    });
  }, []);

  const navigateToLoadedTurn = useCallback((item: ConversationTurnNavigationItem) => {
    const node = containerRef.current;
    if (!node || !item.anchorEntryKey || item.startOffset === undefined) {
      turnNavigationActiveRef.current = false;
      return;
    }
    turnNavigationActiveRef.current = true;
    detachBottomFollowing();
    prependAnchorRef.current = null;
    const findTargetNode = () =>
      Array.from(node.querySelectorAll<HTMLElement>("[data-feed-entry-key]")).find(
        (entryNode) => entryNode.dataset.feedEntryKey === item.anchorEntryKey,
      ) ?? null;
    const alignTargetNode = (targetNode: HTMLElement) => {
      const delta = targetNode.getBoundingClientRect().top - node.getBoundingClientRect().top;
      if (Math.abs(delta) >= 0.5) {
        node.scrollTop += delta;
      }
      lastScrollTopRef.current = node.scrollTop;
      setShowScrollToBottom(node.scrollHeight > node.clientHeight);
      syncViewport();
      releaseTurnNavigationAfterLayout();
    };
    const mountedTarget = findTargetNode();
    if (mountedTarget) {
      alignTargetNode(mountedTarget);
      return;
    }

    node.scrollTop = item.startOffset + viewport.contentTopOffset;
    lastScrollTopRef.current = node.scrollTop;
    setShowScrollToBottom(node.scrollHeight > node.clientHeight);
    syncViewport();
    if (turnNavigationRafRef.current !== null) {
      cancelAnimationFrame(turnNavigationRafRef.current);
    }
    let attemptsRemaining = 5;
    const settle = () => {
      turnNavigationRafRef.current = null;
      if (containerRef.current !== node) {
        turnNavigationActiveRef.current = false;
        return;
      }
      const targetNode = findTargetNode();
      if (targetNode) {
        alignTargetNode(targetNode);
        return;
      }
      attemptsRemaining -= 1;
      if (attemptsRemaining > 0) {
        turnNavigationRafRef.current = requestAnimationFrame(settle);
      } else {
        releaseTurnNavigationAfterLayout();
      }
    };
    turnNavigationRafRef.current = requestAnimationFrame(settle);
  }, [detachBottomFollowing, releaseTurnNavigationAfterLayout, syncViewport, viewport.contentTopOffset]);

  const handleNavigateToTurn = useCallback(
    (item: ConversationTurnNavigationItem) => {
      turnNavigationActiveRef.current = true;
      if (item.anchorEntryKey && item.startOffset !== undefined) {
        pendingTurnNavigationIdRef.current = null;
        navigateToLoadedTurn(item);
        return;
      }
      if (!item.turnId || !props.onLoadTurnHistory) {
        turnNavigationActiveRef.current = false;
        return;
      }
      detachBottomFollowing();
      pendingTurnNavigationIdRef.current = item.turnId;
      void Promise.resolve(props.onLoadTurnHistory(item.turnId)).catch(() => {
        if (pendingTurnNavigationIdRef.current === item.turnId) {
          pendingTurnNavigationIdRef.current = null;
        }
        turnNavigationActiveRef.current = false;
      });
    },
    [detachBottomFollowing, navigateToLoadedTurn, props.onLoadTurnHistory],
  );

  useEffect(() => {
    const turnId = pendingTurnNavigationIdRef.current;
    if (!turnId) {
      return;
    }
    const item = turnNavigationItems.find(
      (candidate) =>
        candidate.turnId === turnId &&
        candidate.anchorEntryKey !== undefined &&
        candidate.startOffset !== undefined,
    );
    if (!item) {
      return;
    }
    pendingTurnNavigationIdRef.current = null;
    navigateToLoadedTurn(item);
  }, [navigateToLoadedTurn, turnNavigationItems]);

  return (
    <div
      className="chat-thread-shell relative flex min-h-0 flex-1 flex-col"
      data-conversation-source="canonical"
      data-chat-density={isPwaDisplayMode ? "mobile" : "desktop"}
      data-turn-navigation={isPwaDisplayMode ? "hidden" : "visible"}
    >
      <div className="relative min-h-0 flex-1">
        <div
          ref={containerRef}
          data-testid="chat-thread-scroll-container"
          className="chat-thread-scroll-container h-full overflow-y-scroll overflow-x-hidden rah-scroll-main scrollbar-stable px-4 py-5 [overflow-anchor:none]"
          onMouseDownCapture={handlePotentialTextSelectionStart}
          onMouseUpCapture={handlePotentialTextSelectionEnd}
        >
          <div ref={contentRef} className="mx-auto w-full min-w-0 max-w-3xl">
          {props.historyError ? (
            <div className="mb-5 flex items-start justify-between gap-3 rounded-lg border border-[var(--app-danger)]/30 bg-[var(--app-danger)]/10 px-3 py-2.5 text-sm text-[var(--app-danger)]">
              <div className="flex min-w-0 items-start gap-2">
                <AlertCircle size={16} className="mt-0.5 shrink-0" />
                <span className="min-w-0 break-words">{props.historyError}</span>
              </div>
              {props.onRetryHistory ? (
                <button
                  type="button"
                  className="icon-click-feedback shrink-0 rounded-md border border-current/25 px-2 py-1 text-xs font-semibold hover:bg-[var(--app-bg)]/50"
                  onClick={() => void props.onRetryHistory?.()}
                >
                  Retry
                </button>
              ) : null}
            </div>
          ) : null}
          {props.historyLoading && props.canLoadOlderHistory ? (
            <div className="flex justify-center pb-5">
              <div className="rounded-full border border-[var(--app-border)] bg-[var(--app-bg)] px-2.5 py-1 text-[10px] font-medium uppercase tracking-[0.14em] text-[var(--app-hint)]">
                Loading older history
              </div>
            </div>
          ) : null}
          <div ref={rowsOriginRef} aria-hidden="true" />
          {virtualWindow.topSpacerHeight > 0 ? (
            <div
              aria-hidden="true"
              data-chat-virtual-spacer="top"
              style={{ height: `${virtualWindow.topSpacerHeight}px` }}
            />
          ) : null}
          {visibleRowsWindow.map((row, windowIndex) => {
            const absoluteEntryIndex = virtualWindow.startIndex + windowIndex;
            const assistantHeaderKey =
              row.kind === "feed_entry"
                ? row.key
                : row.kind === "assistant_process_group"
                  ? row.entries.find((entry) => assistantTurnHeaders.has(entry.key))?.key
                  : undefined;
            const showAssistantTurnHeader =
              Boolean(props.showModelInfo && props.provider) &&
              assistantHeaderKey !== undefined &&
              assistantTurnHeaders.has(assistantHeaderKey);
            const runtimeModel =
              row.kind === "assistant_process_group"
                ? row.runtimeModel ??
                  (assistantHeaderKey ? assistantTurnHeaders.get(assistantHeaderKey) : undefined)
                : row.kind === "feed_entry"
                  ? assistantTurnHeaders.get(row.key)
                  : undefined;
            const rowGapPx =
              absoluteEntryIndex >= displayRows.length - 1
                ? 0
                : resolveChatDisplayRowGapPx(
                    row,
                    absoluteEntryIndex,
                    displayRows,
                  );
            return (
              <MeasuredFeedEntry
                key={row.key}
                entryKey={row.key}
                isLastEntry={absoluteEntryIndex >= displayRows.length - 1}
                rowGapPx={rowGapPx}
                onHeightChange={handleEntryHeightChange}
              >
                {showAssistantTurnHeader && props.provider ? (
                  <AssistantTurnHeader
                    provider={props.provider}
                    {...(runtimeModel ? { runtimeModel } : {})}
                  />
                ) : null}
                {row.kind === "assistant_process_group" ? (
                  <AssistantProcessGroup
                    group={row}
                    detailLoading={Boolean(
                      row.turnId && loadingProcessTurnIds.has(row.turnId)
                    )}
                    expanded={
                      processGroupExpansionOverrides.get(row.key) ??
                      defaultAssistantProcessGroupExpanded(row)
                    }
                    onExpandedChange={handleProcessGroupExpandedChange}
                    {...(props.onLoadConversationItemDetail
                      ? { onLoadConversationItemDetail: props.onLoadConversationItemDetail }
                      : {})}
                    {...(props.onOpenLocalFile
                      ? { onOpenLocalFile: props.onOpenLocalFile }
                      : {})}
                    renderEntry={renderProcessEntry}
                  />
                ) : row.kind === "turn_file_changes" ? (
                  <ConversationFileChangesCard
                    fileChanges={row.fileChanges}
                    onReview={() => openTurnReview(row.turnId, row.fileChanges)}
                    {...(props.onOpenTurnFileChange
                      ? {
                          onOpenFile: (path: string) =>
                            props.onOpenTurnFileChange?.(row.turnId, path),
                        }
                      : {})}
                  />
                ) : row.kind === "turn_copy_action" ? (
                  <AssistantTurnCopyAction content={row.content} />
                ) : (
                  renderEntry(
                    row.entry,
                    props.sessionId,
                    props.canRespondToPermission,
                    props.onPermissionRespond,
                    props.onOpenLocalFile,
                    props.onLoadConversationItemDetail,
                    props.onLoadConversationTurnDetail,
                    copyableAssistantKeys,
                  )
                )}
              </MeasuredFeedEntry>
            );
          })}
          {virtualWindow.bottomSpacerHeight > 0 ? (
            <div
              aria-hidden="true"
              data-chat-virtual-spacer="bottom"
              style={{ height: `${virtualWindow.bottomSpacerHeight}px` }}
            />
          ) : null}
            <div ref={bottomRef} />
          </div>
        </div>

        {!isPwaDisplayMode ? (
          <ConversationTurnNavigator
            items={turnNavigationItems}
            activeKeys={activeTurnNavigationKeys}
            onNavigate={handleNavigateToTurn}
            onEnsureItems={() => ensureTurnDirectoryRef.current?.()}
          />
        ) : null}

        {latestReplyStartTarget || showScrollToBottom ? (
          <div className="absolute bottom-4 left-1/2 z-[30] flex -translate-x-1/2 flex-col items-center gap-2">
            {latestReplyStartTarget ? (
              <button
                type="button"
                onClick={handleScrollToLatestReplyStart}
                className="flex h-9 w-9 items-center justify-center rounded-full border border-[var(--app-border)] bg-[var(--app-bg)] text-[var(--app-fg)] shadow-lg transition-all duration-200 hover:scale-110 hover:bg-[var(--app-subtle-bg)] active:scale-95"
                aria-label="Read latest reply from start"
                title="Read latest reply"
              >
                <ArrowUpToLine size={16} />
              </button>
            ) : null}
            {showScrollToBottom ? (
              <button
                type="button"
                onClick={handleScrollToBottom}
                className="flex h-9 w-9 items-center justify-center rounded-full border border-[var(--app-border)] bg-[var(--app-bg)] text-[var(--app-fg)] shadow-lg transition-all duration-200 hover:scale-110 hover:bg-[var(--app-subtle-bg)] active:scale-95"
                aria-label="Scroll to bottom"
                title="Scroll to bottom"
              >
                <ArrowDown size={16} />
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
      {selectedTextOverlay && props.onAddSelectedText && props.onSelectedTextMoreDetails ? (
        <SelectedTextOverlay
          state={selectedTextOverlay}
          onAddToTask={props.onAddSelectedText}
          onMoreDetails={props.onSelectedTextMoreDetails}
          onDismiss={() => setSelectedTextOverlay(null)}
        />
      ) : null}
      {currentPlan ? (
        <TaskSummaryDock
          key={currentPlan.key}
          plan={currentPlan}
          {...(currentPlanTurnId && currentPlanFileChanges?.files.length
            ? {
                onReviewChanges: () =>
                  openTurnReview(currentPlanTurnId, currentPlanFileChanges),
              }
            : {})}
          {...(props.onOpenLocalFile ? { onOpenLocalFile: props.onOpenLocalFile } : {})}
        />
      ) : null}
      {reviewScope ? (
        <ReviewDialog
          scope={reviewScope}
          onClose={() => setReviewScope(null)}
        />
      ) : null}
    </div>
  );
});

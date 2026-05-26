import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { FeedEntry } from "../../types";
import type { PermissionResponseRequest, ProviderKind, TimelineItem } from "@rah/runtime-protocol";
import {
  AlertCircle,
  ArrowDown,
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
import { AssistantTurnHeader } from "./AssistantTurnHeader";
import { MarkdownRenderer } from "./MarkdownRenderer";
import { MessagePartCard } from "./MessagePartCard";
import { ObservationCard } from "./ObservationCard";
import { OperationCard } from "./OperationCard";
import { PermissionCard } from "./PermissionCard";
import { Reasoning } from "./Reasoning";
import { SystemNotice } from "./SystemNotice";
import { ToolCallCard } from "./ToolCallCard";
import { UserMessage } from "./UserMessage";
import { buildAssistantTurnHeaders } from "./assistant-turn-headers";
import {
  buildVirtualFeedLayout,
  resolveVirtualFeedWindow,
} from "./virtualized-feed-layout";
import { visibleFeedEntries } from "./chat-feed-filtering";

const BOTTOM_STICK_THRESHOLD_PX = 120;
const TOP_HISTORY_TRIGGER_PX = 96;
const TOP_HISTORY_REARM_PX = 220;
const VIEWPORT_RESIZE_EPSILON_PX = 4;

function isDocumentHidden(): boolean {
  return typeof document !== "undefined" && document.visibilityState === "hidden";
}

function isScrollNearBottom(node: HTMLElement): boolean {
  return node.scrollHeight - node.clientHeight - node.scrollTop <= BOTTOM_STICK_THRESHOLD_PX;
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
} = {}) {
  switch (item.kind) {
    case "user_message":
      return <UserMessage content={item.text} entryKey={options.entryKey} />;
    case "assistant_message":
      return <AssistantMessage content={item.text} />;
    case "reasoning":
      return <Reasoning text={item.text} />;
    case "plan":
      return (
        <TimelineCard
          icon={<Sparkles size={14} className="text-[var(--app-hint)]" />}
          title="Plan"
        >
          <MarkdownRenderer
            className="prose-chat text-sm leading-relaxed"
            content={item.text}
            fallbackClassName="whitespace-pre-wrap break-words [overflow-wrap:anywhere] text-sm leading-relaxed"
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
      return (
        <SystemNotice
          content={`Compaction ${item.status}${item.trigger ? ` (${item.trigger})` : ""}`}
        />
      );
  }
}

function renderEntry(
  entry: FeedEntry,
  canRespondToPermission: boolean | undefined,
  onPermissionRespond: (requestId: string, response: PermissionResponseRequest) => void,
) {
  switch (entry.kind) {
    case "timeline":
      return renderTimelineItem(entry.item, {
        entryKey: entry.key,
      });
    case "tool_call":
      return (
        <ToolCallCard
          toolCall={entry.toolCall}
          status={entry.status}
          {...(entry.error !== undefined ? { error: entry.error } : {})}
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
  onHeightChange: (entryKey: string, height: number) => void;
  children: React.ReactNode;
}) {
  const rowRef = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    const node = rowRef.current;
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
    >
      {props.children}
    </div>
  );
}

export function ChatThread(props: {
  sessionId: string;
  feed: FeedEntry[];
  hideToolCalls?: boolean;
  hideOpenCodeReasoning?: boolean;
  hideGeminiReasoning?: boolean;
  showModelInfo?: boolean;
  provider?: ProviderKind;
  canLoadOlderHistory?: boolean;
  historyLoading?: boolean;
  onLoadOlderHistory?: () => void | Promise<void>;
  canRespondToPermission?: boolean;
  onPermissionRespond: (requestId: string, response: PermissionResponseRequest) => void;
}) {
  type PrependAnchor = {
    scrollHeight: number;
    scrollTop: number;
    entryKey: string | null;
    offsetTop: number | null;
    settlePassesRemaining: number;
  };
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
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
  const measuredHeightsRef = useRef<Map<string, number>>(new Map());
  const scrollRafRef = useRef<number | null>(null);
  const bottomFollowRafRef = useRef<number | null>(null);
  const measuredHeightsRafRef = useRef<number | null>(null);
  const visibilityRestoreRafRef = useRef<number | null>(null);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const [measuredHeightsVersion, setMeasuredHeightsVersion] = useState(0);
  const [viewport, setViewport] = useState({ scrollTop: 0, height: 0 });
  const entries = useMemo(
    () =>
      visibleFeedEntries(
        props.feed,
        props.hideToolCalls ?? false,
        props.hideOpenCodeReasoning ?? false,
        props.hideGeminiReasoning ?? false,
        props.provider,
      ),
    [
      props.feed,
      props.hideToolCalls,
      props.hideOpenCodeReasoning,
      props.hideGeminiReasoning,
      props.provider,
    ],
  );
  const assistantTurnHeaders = useMemo(
    () => buildAssistantTurnHeaders(entries),
    [entries],
  );
  const virtualLayout = useMemo(
    () => buildVirtualFeedLayout(entries, measuredHeightsRef.current),
    [entries, measuredHeightsVersion],
  );
  const shouldVirtualize = entries.length > 140 && viewport.height > 0;
  const virtualWindow = useMemo(
    () =>
      shouldVirtualize
        ? resolveVirtualFeedWindow({
            layout: virtualLayout,
            scrollTop: viewport.scrollTop,
            viewportHeight: viewport.height,
          })
        : {
            startIndex: 0,
            endIndex: entries.length,
            topSpacerHeight: 0,
            bottomSpacerHeight: 0,
          },
    [entries.length, shouldVirtualize, virtualLayout, viewport.height, viewport.scrollTop],
  );
  const visibleEntriesWindow = entries.slice(virtualWindow.startIndex, virtualWindow.endIndex);

  const syncViewport = useCallback(() => {
    const node = containerRef.current;
    if (!node) {
      return;
    }
    setViewport((current) =>
      current.scrollTop === node.scrollTop && current.height === node.clientHeight
        ? current
        : {
            scrollTop: node.scrollTop,
            height: node.clientHeight,
          },
    );
  }, []);

  const handleEntryHeightChange = useCallback((entryKey: string, height: number) => {
    const roundedHeight = Math.max(1, Math.ceil(height));
    if (measuredHeightsRef.current.get(entryKey) === roundedHeight) {
      return;
    }
    measuredHeightsRef.current.set(entryKey, roundedHeight);
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
      return;
    }
    node.scrollTop = node.scrollHeight;
    lastScrollTopRef.current = node.scrollTop;
    stickToBottomRef.current = true;
    userDetachedFromBottomRef.current = false;
    returnToBottomOnVisibleRef.current = true;
    pendingVisibleBottomRestoreRef.current = false;
    setShowScrollToBottom(false);
    syncViewport();
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

  const settleScrollToBottomAfterResize = useCallback(() => {
    scrollToBottomNow();
    if (bottomFollowRafRef.current !== null) {
      cancelAnimationFrame(bottomFollowRafRef.current);
    }
    bottomFollowRafRef.current = requestAnimationFrame(() => {
      bottomFollowRafRef.current = null;
      scrollToBottomNow();
    });
  }, [scrollToBottomNow]);

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

  const restoreBottomAfterForeground = useCallback(() => {
    if (
      !returnToBottomOnVisibleRef.current &&
      !pendingVisibleBottomRestoreRef.current &&
      !sessionSwitchBottomLockRef.current
    ) {
      return;
    }
    scrollToBottomNow();
    if (visibilityRestoreRafRef.current !== null) {
      cancelAnimationFrame(visibilityRestoreRafRef.current);
    }
    visibilityRestoreRafRef.current = requestAnimationFrame(() => {
      visibilityRestoreRafRef.current = null;
      scrollToBottomNow();
    });
  }, [scrollToBottomNow]);

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
      settlePassesRemaining: 3,
    };
  }, []);

  useEffect(() => {
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
    if (visibilityRestoreRafRef.current !== null) {
      cancelAnimationFrame(visibilityRestoreRafRef.current);
      visibilityRestoreRafRef.current = null;
    }
    setMeasuredHeightsVersion(0);
    setViewport({ scrollTop: 0, height: 0 });
    setShowScrollToBottom(false);
  }, [props.sessionId]);

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
      if (visibilityRestoreRafRef.current !== null) {
        cancelAnimationFrame(visibilityRestoreRafRef.current);
        visibilityRestoreRafRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    const node = containerRef.current;
    if (!node) {
      return;
    }

    const updateStickiness = () => {
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
      const contentNeedsMoreHistory =
        node.scrollHeight <= node.clientHeight + TOP_HISTORY_TRIGGER_PX;
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
        props.canLoadOlderHistory &&
        props.onLoadOlderHistory &&
        !props.historyLoading &&
        !loadingOlderRef.current &&
        topHistoryAutoLoadArmedRef.current &&
        ((scrollingUp && node.scrollTop <= TOP_HISTORY_TRIGGER_PX) || contentNeedsMoreHistory)
      ) {
        topHistoryAutoLoadArmedRef.current = false;
        loadingOlderRef.current = true;
        prependAnchorRef.current = captureVisiblePrependAnchor();
        const loadResult = props.onLoadOlderHistory();
        void Promise.resolve(loadResult).finally(() => {
          loadingOlderRef.current = false;
        });
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
    captureVisiblePrependAnchor,
    props.canLoadOlderHistory,
    props.historyLoading,
    props.onLoadOlderHistory,
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
      if (event.deltaY < 0) {
        detachBottomFollowing();
      }
    };
    const handleTouchStart = (event: TouchEvent) => {
      touchScrollYRef.current = event.touches[0]?.clientY ?? null;
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
    return () => {
      node.removeEventListener("wheel", handleWheel);
      node.removeEventListener("touchstart", handleTouchStart);
      node.removeEventListener("touchmove", handleTouchMove);
      node.removeEventListener("touchend", handleTouchEnd);
      node.removeEventListener("touchcancel", handleTouchEnd);
    };
  }, [detachBottomFollowing]);

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
    };

    const handleForeground = () => {
      if (!isDocumentHidden()) {
        restoreBottomAfterForeground();
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
  }, [props.historyLoading, props.sessionId, scheduleScrollToBottom]);

  useLayoutEffect(() => {
    const node = containerRef.current;
    if (!node) {
      return;
    }
    const anchor = prependAnchorRef.current;
    if (anchor) {
      const containerTop = node.getBoundingClientRect().top;
      const anchorNode =
        anchor.entryKey === null
          ? null
          : Array.from(node.querySelectorAll<HTMLElement>("[data-feed-entry-key]")).find(
              (entryNode) => entryNode.dataset.feedEntryKey === anchor.entryKey,
            ) ?? null;
      if (anchorNode && anchor.offsetTop !== null) {
        const currentOffsetTop = anchorNode.getBoundingClientRect().top - containerTop;
        node.scrollTop += currentOffsetTop - anchor.offsetTop;
      } else {
        const nextScrollTop =
          anchor.scrollTop + (node.scrollHeight - anchor.scrollHeight);
        node.scrollTop = nextScrollTop;
      }
      lastScrollTopRef.current = node.scrollTop;
      if (
        node.scrollTop > TOP_HISTORY_REARM_PX ||
        node.scrollHeight <= node.clientHeight + TOP_HISTORY_TRIGGER_PX
      ) {
        topHistoryAutoLoadArmedRef.current = true;
      }
      const nextSettlePassesRemaining = props.historyLoading
        ? anchor.settlePassesRemaining
        : anchor.settlePassesRemaining - 1;
      if (!props.historyLoading) {
        loadingOlderRef.current = false;
      }
      if (props.historyLoading || nextSettlePassesRemaining > 0) {
        prependAnchorRef.current = {
          ...anchor,
          scrollHeight: node.scrollHeight,
          scrollTop: node.scrollTop,
          settlePassesRemaining: nextSettlePassesRemaining,
        };
      } else {
        prependAnchorRef.current = null;
        loadingOlderRef.current = false;
      }
      previousEntryCountRef.current = entries.length;
      return;
    }

    const shouldForceBottom = sessionSwitchBottomLockRef.current;
    if (shouldForceBottom) {
      if (isDocumentHidden()) {
        pendingVisibleBottomRestoreRef.current = true;
        previousEntryCountRef.current = entries.length;
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
    } else if (entries.length > previousEntryCountRef.current && stickToBottomRef.current) {
      if (isDocumentHidden()) {
        pendingVisibleBottomRestoreRef.current = true;
        previousEntryCountRef.current = entries.length;
        return;
      }
      scrollToBottomNow();
    }
    previousEntryCountRef.current = entries.length;
  }, [
    entries,
    measuredHeightsVersion,
    props.historyLoading,
    props.sessionId,
    scrollToBottomNow,
  ]);

  const handleScrollToBottom = () => {
    stickToBottomRef.current = true;
    userDetachedFromBottomRef.current = false;
    returnToBottomOnVisibleRef.current = true;
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={containerRef}
        data-testid="chat-thread-scroll-container"
        className="h-full overflow-y-scroll overflow-x-hidden rah-scroll-main scrollbar-stable px-4 py-5 [overflow-anchor:none]"
      >
        <div ref={contentRef} className="mx-auto w-full min-w-0 max-w-3xl space-y-5">
        {props.historyLoading && props.canLoadOlderHistory ? (
          <div className="flex justify-center">
            <div className="rounded-full border border-[var(--app-border)] bg-[var(--app-bg)] px-2.5 py-1 text-[10px] font-medium uppercase tracking-[0.14em] text-[var(--app-hint)]">
              Loading older history
            </div>
          </div>
        ) : null}
        {virtualWindow.topSpacerHeight > 0 ? (
          <div
            aria-hidden="true"
            style={{ height: `${virtualWindow.topSpacerHeight}px` }}
          />
        ) : null}
        {visibleEntriesWindow.map((entry) => {
          const showAssistantTurnHeader =
            Boolean(props.showModelInfo && props.provider) &&
            assistantTurnHeaders.has(entry.key);
          const runtimeModel = assistantTurnHeaders.get(entry.key);
          return (
            <MeasuredFeedEntry
              key={entry.key}
              entryKey={entry.key}
              onHeightChange={handleEntryHeightChange}
            >
              {showAssistantTurnHeader && props.provider ? (
                <AssistantTurnHeader
                  provider={props.provider}
                  {...(runtimeModel ? { runtimeModel } : {})}
                />
              ) : null}
              {renderEntry(
                entry,
                props.canRespondToPermission,
                props.onPermissionRespond,
              )}
            </MeasuredFeedEntry>
          );
        })}
        {virtualWindow.bottomSpacerHeight > 0 ? (
          <div
            aria-hidden="true"
            style={{ height: `${virtualWindow.bottomSpacerHeight}px` }}
          />
        ) : null}
        <div ref={bottomRef} />
        </div>
      </div>

      {/* Scroll-to-bottom button */}
      {showScrollToBottom ? (
        <button
          type="button"
          onClick={handleScrollToBottom}
          className="absolute bottom-4 left-1/2 z-[30] flex h-9 w-9 -translate-x-1/2 items-center justify-center rounded-full border border-[var(--app-border)] bg-[var(--app-bg)] text-[var(--app-fg)] shadow-lg transition-all duration-200 hover:scale-110 hover:bg-[var(--app-subtle-bg)] active:scale-95"
          aria-label="Scroll to bottom"
        >
          <ArrowDown size={16} />
        </button>
      ) : null}
    </div>
  );
}

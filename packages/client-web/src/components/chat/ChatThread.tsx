import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { FeedEntry } from "../../types";
import type { PermissionResponseRequest, TimelineItem } from "@rah/runtime-protocol";
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
  RefreshCcw,
  Sparkles,
} from "lucide-react";
import { AssistantMessage } from "./AssistantMessage";
import { AttentionCard } from "./AttentionCard";
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
  buildVirtualFeedLayout,
  resolveVirtualFeedWindow,
} from "./virtualized-feed-layout";

const TOOL_BACKED_OBSERVATION_KINDS = new Set([
  "file.read",
  "file.list",
  "file.search",
  "file.write",
  "file.edit",
  "patch.apply",
  "command.run",
  "test.run",
  "build.run",
  "lint.run",
  "git.status",
  "git.diff",
  "git.apply",
  "web.search",
  "web.fetch",
  "mcp.call",
  "subagent.lifecycle",
]);

const BOTTOM_STICK_THRESHOLD_PX = 120;
const TOP_HISTORY_TRIGGER_PX = 96;
const TOP_HISTORY_REARM_PX = 220;

function visibleFeedEntries(feed: FeedEntry[], hideToolCalls: boolean): FeedEntry[] {
  const toolIds = new Set(
    feed.flatMap((entry) =>
      entry.kind === "tool_call" ? [entry.toolCall.id] : [],
    ),
  );

  return feed.filter((entry) => {
    if (hideToolCalls && entry.kind === "tool_call" && entry.status === "completed") {
      return false;
    }
    if (entry.kind !== "observation") {
      return true;
    }
    if (
      hideToolCalls &&
      entry.status === "completed" &&
      TOOL_BACKED_OBSERVATION_KINDS.has(entry.observation.kind)
    ) {
      return false;
    }
    const providerCallId = entry.observation.subject?.providerCallId;
    if (!providerCallId) {
      return true;
    }
    if (!TOOL_BACKED_OBSERVATION_KINDS.has(entry.observation.kind)) {
      return true;
    }
    return !toolIds.has(providerCallId);
  });
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

function renderTimelineItem(item: TimelineItem) {
  switch (item.kind) {
    case "user_message":
      return <UserMessage content={item.text} />;
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
      return renderTimelineItem(entry.item);
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
    case "attention":
      return <AttentionCard item={entry.item} />;
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
  canLoadOlderHistory?: boolean;
  historyLoading?: boolean;
  onLoadOlderHistory?: () => void;
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
  const sessionSwitchBottomLockRef = useRef(true);
  const prependAnchorRef = useRef<PrependAnchor | null>(null);
  const lastScrollTopRef = useRef(0);
  const topHistoryAutoLoadArmedRef = useRef(true);
  const measuredHeightsRef = useRef<Map<string, number>>(new Map());
  const scrollRafRef = useRef<number | null>(null);
  const measuredHeightsRafRef = useRef<number | null>(null);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const [measuredHeightsVersion, setMeasuredHeightsVersion] = useState(0);
  const [viewport, setViewport] = useState({ scrollTop: 0, height: 0 });
  const entries = useMemo(
    () => visibleFeedEntries(props.feed, props.hideToolCalls ?? false),
    [props.feed, props.hideToolCalls],
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
    sessionSwitchBottomLockRef.current = true;
    prependAnchorRef.current = null;
    lastScrollTopRef.current = 0;
    topHistoryAutoLoadArmedRef.current = true;
    measuredHeightsRef.current = new Map();
    if (scrollRafRef.current !== null) {
      cancelAnimationFrame(scrollRafRef.current);
      scrollRafRef.current = null;
    }
    if (measuredHeightsRafRef.current !== null) {
      cancelAnimationFrame(measuredHeightsRafRef.current);
      measuredHeightsRafRef.current = null;
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
      if (measuredHeightsRafRef.current !== null) {
        cancelAnimationFrame(measuredHeightsRafRef.current);
        measuredHeightsRafRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    const node = containerRef.current;
    if (!node) {
      return;
    }

    const updateStickiness = () => {
      const distanceToBottom =
        node.scrollHeight - node.clientHeight - node.scrollTop;
      const isAtBottom = distanceToBottom <= BOTTOM_STICK_THRESHOLD_PX;
      stickToBottomRef.current = isAtBottom;
      if (!isAtBottom) {
        sessionSwitchBottomLockRef.current = false;
      }
      setShowScrollToBottom(!isAtBottom && node.scrollHeight > node.clientHeight);

       const scrollingUp = node.scrollTop < lastScrollTopRef.current;
       if (node.scrollTop > TOP_HISTORY_REARM_PX) {
         topHistoryAutoLoadArmedRef.current = true;
       }
      if (
        props.canLoadOlderHistory &&
        props.onLoadOlderHistory &&
         !props.historyLoading &&
         !loadingOlderRef.current &&
         topHistoryAutoLoadArmedRef.current &&
         scrollingUp &&
         node.scrollTop <= TOP_HISTORY_TRIGGER_PX
       ) {
         topHistoryAutoLoadArmedRef.current = false;
         loadingOlderRef.current = true;
         prependAnchorRef.current = captureVisiblePrependAnchor();
         props.onLoadOlderHistory();
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
    syncViewport,
  ]);

  useEffect(() => {
    const node = containerRef.current;
    if (!node || typeof ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver(() => {
      syncViewport();
    });
    observer.observe(node);
    syncViewport();
    return () => observer.disconnect();
  }, [props.sessionId, syncViewport]);

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
      if (!stickToBottomRef.current && !sessionSwitchBottomLockRef.current) {
        return;
      }
      node.scrollTop = node.scrollHeight;
      lastScrollTopRef.current = node.scrollTop;
      stickToBottomRef.current = true;
      setShowScrollToBottom(false);
      if (!props.historyLoading) {
        sessionSwitchBottomLockRef.current = false;
      }
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, [props.historyLoading, props.sessionId]);

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
      const nextSettlePassesRemaining = props.historyLoading
        ? anchor.settlePassesRemaining
        : anchor.settlePassesRemaining - 1;
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
      node.scrollTop = node.scrollHeight;
      lastScrollTopRef.current = node.scrollTop;
      stickToBottomRef.current = true;
      setShowScrollToBottom(false);
      if (!props.historyLoading) {
        sessionSwitchBottomLockRef.current = false;
      }
    } else if (entries.length > previousEntryCountRef.current && stickToBottomRef.current) {
      bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    }
    previousEntryCountRef.current = entries.length;
  }, [entries, measuredHeightsVersion, props.historyLoading, props.sessionId]);

  const handleScrollToBottom = () => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  return (
    <div
      ref={containerRef}
      className="relative flex-1 overflow-y-scroll overflow-x-hidden custom-scrollbar scrollbar-stable px-4 py-5"
    >
      <div ref={contentRef} className="mx-auto w-full min-w-0 max-w-3xl space-y-5">
        {props.historyLoading ? (
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
        {visibleEntriesWindow.map((entry) => (
          <MeasuredFeedEntry
            key={entry.key}
            entryKey={entry.key}
            onHeightChange={handleEntryHeightChange}
          >
            {renderEntry(entry, props.canRespondToPermission, props.onPermissionRespond)}
          </MeasuredFeedEntry>
        ))}
        {virtualWindow.bottomSpacerHeight > 0 ? (
          <div
            aria-hidden="true"
            style={{ height: `${virtualWindow.bottomSpacerHeight}px` }}
          />
        ) : null}
        <div ref={bottomRef} />
      </div>

      {/* Scroll-to-bottom button */}
      {showScrollToBottom ? (
        <button
          type="button"
          onClick={handleScrollToBottom}
          className="fixed left-1/2 z-[30] flex h-9 w-9 -translate-x-1/2 items-center justify-center rounded-full border border-[var(--app-border)] bg-[var(--app-bg)] text-[var(--app-fg)] shadow-lg transition-all duration-200 hover:scale-110 hover:bg-[var(--app-subtle-bg)] active:scale-95"
          style={{ bottom: "var(--workbench-floating-anchor, calc(env(safe-area-inset-bottom, 0px) + 5.75rem))" }}
          aria-label="Scroll to bottom"
        >
          <ArrowDown size={16} />
        </button>
      ) : null}
    </div>
  );
}

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
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
import ReactMarkdown from "react-markdown";
import { AssistantMessage } from "./AssistantMessage";
import { AttentionCard } from "./AttentionCard";
import { MessagePartCard } from "./MessagePartCard";
import { ObservationCard } from "./ObservationCard";
import { OperationCard } from "./OperationCard";
import { PermissionCard } from "./PermissionCard";
import { Reasoning } from "./Reasoning";
import { SystemNotice } from "./SystemNotice";
import { ToolCallCard } from "./ToolCallCard";
import { UserMessage } from "./UserMessage";

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
      ? "border-[var(--app-danger)]/30 bg-[var(--app-danger)]/10"
      : props.tone === "warning"
        ? "border-[var(--app-warning)]/30 bg-[var(--app-warning)]/10"
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
          <div className="prose-chat text-sm leading-relaxed">
            <ReactMarkdown>{item.text}</ReactMarkdown>
          </div>
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
              <div className="rounded-md bg-[var(--app-bg)] px-2 py-1.5">{item.response}</div>
            ) : null}
            {item.error ? (
              <div className="rounded-md bg-[var(--app-danger)]/10 px-2 py-1.5 text-[var(--app-danger)]">
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
                className="inline-flex items-center gap-1.5 underline underline-offset-2"
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

export function ChatThread(props: {
  feed: FeedEntry[];
  hideToolCalls?: boolean;
  canLoadOlderHistory?: boolean;
  historyLoading?: boolean;
  onLoadOlderHistory?: () => void;
  canRespondToPermission?: boolean;
  onPermissionRespond: (requestId: string, response: PermissionResponseRequest) => void;
}) {
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const previousEntryCountRef = useRef(0);
  const loadingOlderRef = useRef(false);
  const stickToBottomRef = useRef(true);
  const prependAnchorRef = useRef<{ scrollHeight: number; scrollTop: number } | null>(null);
  const lastScrollTopRef = useRef(0);
  const topHistoryAutoLoadArmedRef = useRef(true);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const entries = useMemo(
    () => visibleFeedEntries(props.feed, props.hideToolCalls ?? false),
    [props.feed, props.hideToolCalls],
  );

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
         prependAnchorRef.current = {
           scrollHeight: node.scrollHeight,
           scrollTop: node.scrollTop,
         };
         props.onLoadOlderHistory();
       }
       lastScrollTopRef.current = node.scrollTop;
    };

    updateStickiness();
    node.addEventListener("scroll", updateStickiness, { passive: true });
    return () => {
      node.removeEventListener("scroll", updateStickiness);
    };
  }, []);

  useLayoutEffect(() => {
    const node = containerRef.current;
    const anchor = prependAnchorRef.current;
    if (node && anchor) {
      const nextScrollTop =
        anchor.scrollTop + (node.scrollHeight - anchor.scrollHeight);
      node.scrollTop = nextScrollTop;
      prependAnchorRef.current = null;
      loadingOlderRef.current = false;
      previousEntryCountRef.current = entries.length;
      return;
    }

    if (entries.length > previousEntryCountRef.current && stickToBottomRef.current) {
      bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    }
    previousEntryCountRef.current = entries.length;
  }, [entries]);

  const handleScrollToBottom = () => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  return (
    <div ref={containerRef} className="relative flex-1 overflow-y-auto custom-scrollbar px-4 py-5">
      <div className="mx-auto max-w-3xl space-y-5">
        {props.historyLoading ? (
          <div className="flex justify-center">
            <div className="rounded-full border border-[var(--app-border)] bg-[var(--app-bg)] px-2.5 py-1 text-[10px] font-medium uppercase tracking-[0.14em] text-[var(--app-hint)]">
              Loading older history
            </div>
          </div>
        ) : null}
        {entries.map((entry) => (
          <div key={entry.key}>
            {renderEntry(entry, props.canRespondToPermission, props.onPermissionRespond)}
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      {/* Scroll-to-bottom button */}
      {showScrollToBottom ? (
        <button
          type="button"
          onClick={handleScrollToBottom}
          className="absolute bottom-5 left-1/2 z-10 flex h-9 w-9 -translate-x-1/2 items-center justify-center rounded-full border border-[var(--app-border)] bg-[var(--app-bg)] text-[var(--app-fg)] shadow-lg transition-all duration-200 hover:scale-110 hover:bg-[var(--app-subtle-bg)] active:scale-95"
          aria-label="Scroll to bottom"
        >
          <ArrowDown size={16} />
        </button>
      ) : null}
    </div>
  );
}

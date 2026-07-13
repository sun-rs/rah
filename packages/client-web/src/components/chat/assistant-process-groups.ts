import type {
  ConversationActivityKind,
  ConversationActivitySummary,
  ConversationOutputProjection,
  ConversationTurnStatus,
  TimelineRuntimeModel,
} from "@rah/runtime-protocol";
import {
  conversationActivityKindForMessagePart,
  conversationActivityKindForObservation,
  conversationActivityKindForToolFamily,
} from "@rah/runtime-protocol";
import type { FeedEntry } from "../../types";

export type AssistantProcessGroup = {
  kind: "assistant_process_group";
  key: string;
  entries: FeedEntry[];
  completed: boolean;
  active: boolean;
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  activities: readonly ConversationActivitySummary[];
  runtimeModel?: TimelineRuntimeModel;
  turnStatus?: ConversationTurnStatus;
  turnId?: string;
  detailsAvailable?: boolean;
};

export type ChatDisplayRow =
  | { kind: "feed_entry"; key: string; entry: FeedEntry }
  | AssistantProcessGroup
  | {
      kind: "turn_outputs";
      key: string;
      outputs: ConversationOutputProjection[];
    };

type ReasoningFeedEntry = Extract<FeedEntry, { kind: "timeline" }> & {
  item: Extract<Extract<FeedEntry, { kind: "timeline" }>["item"], { kind: "reasoning" }>;
};

export type ProcessDetailRow =
  | { kind: "entry"; key: string; entry: FeedEntry }
  | { kind: "reasoning_batch"; key: string; entry: FeedEntry; count: number }
  | {
      kind: "activity_batch";
      key: string;
      activityKind: ConversationActivityKind;
      entries: FeedEntry[];
      runningCount: number;
      interruptedCount: number;
      issueCount: number;
      failureCount: number;
    };

export function formatAssistantProcessDuration(durationMs: number | undefined): string | null {
  if (durationMs === undefined) {
    return null;
  }
  const seconds = Math.max(1, Math.floor(durationMs / 1_000));
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return remainder > 0 ? `${minutes}m ${remainder}s` : `${minutes}m`;
}

function entryActivityKind(entry: FeedEntry): ConversationActivityKind | null {
  switch (entry.kind) {
    case "tool_call":
      return conversationActivityKindForToolFamily(entry.toolCall.family);
    case "observation":
      return conversationActivityKindForObservation(entry.observation.kind);
    case "operation":
      return entry.operation.kind === "automation" ? "automation" : "tool";
    case "message_part":
      return conversationActivityKindForMessagePart(entry.part.kind);
    default:
      return null;
  }
}

function isReasoningEntry(
  entry: FeedEntry,
): entry is ReasoningFeedEntry {
  return entry.kind === "timeline" && entry.item.kind === "reasoning";
}

function entryStatus(entry: FeedEntry): "running" | "completed" | "interrupted" | "failed" {
  if (entry.kind === "tool_call" || entry.kind === "observation") return entry.status;
  if (entry.kind === "message_part") {
    if (entry.status === "streaming") return "running";
    if (entry.status === "removed") return "interrupted";
  }
  return "completed";
}

function entryHasCommandResult(entry: FeedEntry): boolean {
  if (entry.kind === "observation") return entry.observation.exitCode !== undefined;
  return (
    entry.kind === "tool_call" &&
    typeof entry.toolCall.result?.exitCode === "number"
  );
}

function activityBatchCounts(entries: readonly FeedEntry[]) {
  let runningCount = 0;
  let interruptedCount = 0;
  let issueCount = 0;
  let failureCount = 0;
  for (const entry of entries) {
    const status = entryStatus(entry);
    if (status === "running") runningCount += 1;
    if (status === "interrupted") interruptedCount += 1;
    if (status === "failed") {
      if (entryHasCommandResult(entry)) issueCount += 1;
      else failureCount += 1;
    }
  }
  return { runningCount, interruptedCount, issueCount, failureCount };
}

export function buildProcessDetailRows(entries: readonly FeedEntry[]): ProcessDetailRow[] {
  const rows: ProcessDetailRow[] = [];
  let pendingActivityKind: ConversationActivityKind | null = null;
  let pendingActivityEntries: FeedEntry[] = [];
  let pendingReasoning: ReasoningFeedEntry[] = [];

  const flushActivity = () => {
    if (!pendingActivityKind || pendingActivityEntries.length === 0) {
      return;
    }
    rows.push({
      kind: "activity_batch",
      key: `activity-batch:${pendingActivityKind}:${pendingActivityEntries[0]!.key}`,
      activityKind: pendingActivityKind,
      entries: pendingActivityEntries,
      ...activityBatchCounts(pendingActivityEntries),
    });
    pendingActivityKind = null;
    pendingActivityEntries = [];
  };

  const flushReasoning = () => {
    if (pendingReasoning.length === 0) {
      return;
    }
    const first = pendingReasoning[0]!;
    const uniqueTexts = [...new Set(pendingReasoning.map((entry) => entry.item.text.trim()))]
      .filter(Boolean);
    rows.push({
      kind: "reasoning_batch",
      key: `reasoning-batch:${first.key}`,
      count: pendingReasoning.length,
      entry: {
        ...first,
        key: `reasoning-batch:${first.key}`,
        item: { ...first.item, text: uniqueTexts.join("\n\n") },
      },
    });
    pendingReasoning = [];
  };

  for (const entry of entries) {
    const activityKind = entryActivityKind(entry);
    if (activityKind && activityKind !== "tool") {
      flushReasoning();
      if (pendingActivityKind !== activityKind) {
        flushActivity();
        pendingActivityKind = activityKind;
      }
      pendingActivityEntries.push(entry);
      continue;
    }
    if (isReasoningEntry(entry)) {
      flushActivity();
      pendingReasoning.push(entry);
      continue;
    }
    flushActivity();
    flushReasoning();
    rows.push({ kind: "entry", key: entry.key, entry });
  }
  flushActivity();
  flushReasoning();
  return rows;
}

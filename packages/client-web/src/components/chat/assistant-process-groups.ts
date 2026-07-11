import type { ConversationTurnStatus, TimelineRuntimeModel } from "@rah/runtime-protocol";
import type { FeedEntry } from "../../types";
import { isInternalUserReminder } from "./assistant-turn-headers";

export type AssistantProcessGroup = {
  kind: "assistant_process_group";
  key: string;
  entries: FeedEntry[];
  completed: boolean;
  active: boolean;
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  failedCount: number;
  runtimeModel?: TimelineRuntimeModel;
  turnStatus?: ConversationTurnStatus;
  turnId?: string;
  detailsAvailable?: boolean;
};

export type ChatDisplayRow =
  | { kind: "feed_entry"; key: string; entry: FeedEntry }
  | AssistantProcessGroup;

type ReasoningFeedEntry = Extract<FeedEntry, { kind: "timeline" }> & {
  item: Extract<Extract<FeedEntry, { kind: "timeline" }>["item"], { kind: "reasoning" }>;
};

export type ProcessDetailRow =
  | { kind: "entry"; key: string; entry: FeedEntry }
  | { kind: "reasoning_batch"; key: string; entry: FeedEntry; count: number }
  | {
      kind: "command_batch";
      key: string;
      entries: FeedEntry[];
      status: "running" | "completed" | "interrupted" | "failed";
    };

function isVisibleUserBoundary(entry: FeedEntry): boolean {
  return (
    entry.kind === "timeline" &&
    entry.item.kind === "user_message" &&
    !isInternalUserReminder(entry.item.text)
  );
}

function isFinalAssistantEntry(
  entry: FeedEntry,
  finalAssistantKeys: ReadonlySet<string>,
): boolean {
  if (entry.kind !== "timeline" || entry.item.kind !== "assistant_message") {
    return false;
  }
  if (entry.item.phase === "final_answer") {
    return true;
  }
  return entry.item.phase === undefined && finalAssistantKeys.has(entry.key);
}

function isAssistantProcessEntry(
  entry: FeedEntry,
  finalAssistantKeys: ReadonlySet<string>,
): boolean {
  switch (entry.kind) {
    case "timeline":
      if (entry.item.kind === "assistant_message") {
        return !isFinalAssistantEntry(entry, finalAssistantKeys);
      }
      return (
        entry.item.kind === "reasoning" ||
        entry.item.kind === "plan" ||
        entry.item.kind === "step" ||
        entry.item.kind === "todo" ||
        entry.item.kind === "compaction"
      );
    case "tool_call":
    case "message_part":
    case "observation":
    case "operation":
      return true;
    case "permission":
    case "runtime_status":
    case "notification":
      return false;
  }
}

function runtimeModelFromEntries(entries: readonly FeedEntry[]): TimelineRuntimeModel | undefined {
  for (const entry of entries) {
    if (
      entry.kind === "timeline" &&
      (entry.item.kind === "assistant_message" ||
        entry.item.kind === "reasoning" ||
        entry.item.kind === "step") &&
      entry.item.runtimeModel
    ) {
      return entry.item.runtimeModel;
    }
  }
  return undefined;
}

function failedEntryCount(entries: readonly FeedEntry[]): number {
  return entries.filter((entry) => {
    if (entry.kind === "tool_call" || entry.kind === "observation") {
      return entry.status === "failed";
    }
    return entry.kind === "timeline" && entry.item.kind === "error";
  }).length;
}

function durationBetween(startedAt: string, completedAt: string): number | undefined {
  const startedMs = Date.parse(startedAt);
  const completedMs = Date.parse(completedAt);
  if (!Number.isFinite(startedMs) || !Number.isFinite(completedMs) || completedMs < startedMs) {
    return undefined;
  }
  return completedMs - startedMs;
}

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

export function buildAssistantProcessRows(
  entries: readonly FeedEntry[],
  options: {
    finalAssistantKeys: ReadonlySet<string>;
    generationActive: boolean;
  },
): ChatDisplayRow[] {
  let latestSegmentIndex = 0;
  let scannedSegmentIndex = 0;
  const finalAnswerAtBySegment = new Map<number, string>();
  for (const entry of entries) {
    if (isVisibleUserBoundary(entry)) {
      latestSegmentIndex += 1;
      scannedSegmentIndex += 1;
      continue;
    }
    if (isFinalAssistantEntry(entry, options.finalAssistantKeys)) {
      finalAnswerAtBySegment.set(scannedSegmentIndex, entry.ts);
    }
  }

  const rows: ChatDisplayRow[] = [];
  let segmentIndex = 0;
  let segmentStartedAt: string | undefined;
  let pendingProcessEntries: FeedEntry[] = [];

  const flushProcessEntries = () => {
    if (pendingProcessEntries.length === 0) {
      return;
    }
    const firstEntry = pendingProcessEntries[0]!;
    const groupCompletedAt = finalAnswerAtBySegment.get(segmentIndex);
    const completed = groupCompletedAt !== undefined;
    const active =
      !completed && options.generationActive && segmentIndex === latestSegmentIndex;
    const startedAt = segmentStartedAt ?? firstEntry.ts;
    const runtimeModel = runtimeModelFromEntries(pendingProcessEntries);
    const durationMs = groupCompletedAt
      ? durationBetween(startedAt, groupCompletedAt)
      : undefined;
    rows.push({
      kind: "assistant_process_group",
      key: `assistant-process:${firstEntry.turnId ?? "unscoped"}:${firstEntry.key}`,
      entries: pendingProcessEntries,
      completed,
      active,
      startedAt,
      ...(groupCompletedAt ? { completedAt: groupCompletedAt } : {}),
      ...(durationMs !== undefined ? { durationMs } : {}),
      failedCount: failedEntryCount(pendingProcessEntries),
      ...(runtimeModel ? { runtimeModel } : {}),
    });
    pendingProcessEntries = [];
  };

  for (const entry of entries) {
    if (isVisibleUserBoundary(entry)) {
      flushProcessEntries();
      segmentIndex += 1;
      segmentStartedAt = entry.ts;
      rows.push({ kind: "feed_entry", key: entry.key, entry });
      continue;
    }
    if (isFinalAssistantEntry(entry, options.finalAssistantKeys)) {
      flushProcessEntries();
      rows.push({ kind: "feed_entry", key: entry.key, entry });
      continue;
    }
    if (isAssistantProcessEntry(entry, options.finalAssistantKeys)) {
      pendingProcessEntries.push(entry);
      continue;
    }
    flushProcessEntries();
    rows.push({ kind: "feed_entry", key: entry.key, entry });
  }
  flushProcessEntries();
  return rows;
}

const COMMAND_TOOL_FAMILIES = new Set(["shell", "test", "build", "lint"]);
const COMMAND_OBSERVATION_KINDS = new Set([
  "command.run",
  "test.run",
  "build.run",
  "lint.run",
]);

function isCommandEntry(entry: FeedEntry): boolean {
  if (entry.kind === "tool_call") {
    return COMMAND_TOOL_FAMILIES.has(entry.toolCall.family);
  }
  return (
    entry.kind === "observation" &&
    COMMAND_OBSERVATION_KINDS.has(entry.observation.kind)
  );
}

function isReasoningEntry(
  entry: FeedEntry,
): entry is ReasoningFeedEntry {
  return entry.kind === "timeline" && entry.item.kind === "reasoning";
}

function commandBatchStatus(
  entries: readonly FeedEntry[],
): "running" | "completed" | "interrupted" | "failed" {
  if (
    entries.some(
      (entry) =>
        (entry.kind === "tool_call" || entry.kind === "observation") &&
        entry.status === "failed",
    )
  ) {
    return "failed";
  }
  if (
    entries.some(
      (entry) =>
        (entry.kind === "tool_call" || entry.kind === "observation") &&
        entry.status === "running",
    )
  ) {
    return "running";
  }
  if (
    entries.some(
      (entry) =>
        (entry.kind === "tool_call" || entry.kind === "observation") &&
        entry.status === "interrupted",
    )
  ) {
    return "interrupted";
  }
  return "completed";
}

export function buildProcessDetailRows(entries: readonly FeedEntry[]): ProcessDetailRow[] {
  const rows: ProcessDetailRow[] = [];
  let pendingCommands: FeedEntry[] = [];
  let pendingReasoning: ReasoningFeedEntry[] = [];

  const flushCommands = () => {
    if (pendingCommands.length === 0) {
      return;
    }
    if (pendingCommands.length === 1) {
      const entry = pendingCommands[0]!;
      rows.push({ kind: "entry", key: entry.key, entry });
    } else {
      rows.push({
        kind: "command_batch",
        key: `command-batch:${pendingCommands[0]!.key}`,
        entries: pendingCommands,
        status: commandBatchStatus(pendingCommands),
      });
    }
    pendingCommands = [];
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
    if (isCommandEntry(entry)) {
      flushReasoning();
      pendingCommands.push(entry);
      continue;
    }
    if (isReasoningEntry(entry)) {
      flushCommands();
      pendingReasoning.push(entry);
      continue;
    }
    flushCommands();
    flushReasoning();
    rows.push({ kind: "entry", key: entry.key, entry });
  }
  flushCommands();
  flushReasoning();
  return rows;
}

import type {
  ConversationItemProjection,
  ConversationItemStatus,
  ConversationTurnProjection,
  TimelineRuntimeModel,
} from "@rah/runtime-protocol";
import type { FeedEntry } from "./types";
import type { ChatDisplayRow } from "./components/chat/assistant-process-groups";

export function conversationV2ItemFeedKey(itemId: string): string {
  return `conversation-v2:${itemId}`;
}

function terminalStatus(
  status: ConversationItemStatus,
): "running" | "completed" | "interrupted" | "failed" {
  if (status === "pending" || status === "running") {
    return "running";
  }
  return status;
}

function itemTimestamp(
  turn: ConversationTurnProjection,
  item: ConversationItemProjection,
): string {
  return item.startedAt ?? item.completedAt ?? turn.startedAt ?? turn.completedAt ?? "1970-01-01T00:00:00.000Z";
}

function itemToFeedEntry(
  turn: ConversationTurnProjection,
  item: ConversationItemProjection,
): FeedEntry | null {
  const key = conversationV2ItemFeedKey(item.id);
  const ts = itemTimestamp(turn, item);
  const turnId = turn.providerTurnId ?? turn.id;
  const common = {
    key,
    ts,
    turnId,
  };

  switch (item.content.kind) {
    case "timeline": {
      const timelineItem = item.content.item;
      const normalized =
        timelineItem.kind === "assistant_message"
          ? {
              ...timelineItem,
              ...(item.role === "final"
                ? { phase: "final_answer" as const }
                : item.role === "process"
                  ? { phase: "commentary" as const }
                  : {}),
            }
          : timelineItem;
      return {
        ...common,
        kind: "timeline",
        item: normalized,
        ...(turn.providerTurnId ? { providerTurnId: turn.providerTurnId } : {}),
        sourceProvider: item.source.provider,
      };
    }
    case "tool": {
      const status = terminalStatus(item.status);
      const useCanonicalDetailId = Boolean(turn.providerTurnId && item.providerItemId);
      return {
        ...common,
        kind: "tool_call",
        toolCall: {
          ...item.content.toolCall,
          id: useCanonicalDetailId ? item.id : item.content.toolCall.id,
          detailAvailable:
            item.detailAvailable ?? item.content.toolCall.detailAvailable ?? false,
        },
        status,
        ...(item.content.error ? { error: item.content.error } : {}),
      };
    }
    case "observation": {
      const status = terminalStatus(item.status);
      const observationStatus = status === "interrupted" ? "canceled" : status;
      const useCanonicalDetailId = Boolean(turn.providerTurnId && item.providerItemId);
      return {
        ...common,
        kind: "observation",
        observation: {
          ...item.content.observation,
          id: useCanonicalDetailId ? item.id : item.content.observation.id,
          status: observationStatus,
          detailAvailable:
            item.detailAvailable ?? item.content.observation.detailAvailable ?? false,
        },
        status,
        ...(item.content.error ? { error: item.content.error } : {}),
      };
    }
    case "permission":
      return item.content.request
        ? {
            ...common,
            kind: "permission",
            request: item.content.request,
            ...(item.content.resolution ? { resolution: item.content.resolution } : {}),
          }
        : null;
    case "operation":
      return {
        ...common,
        kind: "operation",
        operation: item.content.operation,
        status:
          item.status === "pending" || item.status === "running" ? "started" : "resolved",
      };
    case "message_part":
      return {
        ...common,
        kind: "message_part",
        part: item.content.part,
        status:
          item.status === "pending" || item.status === "running"
            ? "streaming"
            : item.status === "interrupted"
              ? "removed"
              : "updated",
      };
  }
}

export function conversationV2TurnsToFeed(
  turns: readonly ConversationTurnProjection[],
): FeedEntry[] {
  const feed: FeedEntry[] = [];
  for (const turn of turns) {
    for (const item of turn.items) {
      const entry = itemToFeedEntry(turn, item);
      if (entry) {
        feed.push(entry);
      }
    }
  }
  return feed;
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

function durationBetween(startedAt: string | undefined, completedAt: string | undefined) {
  if (!startedAt || !completedAt) {
    return undefined;
  }
  const startedMs = Date.parse(startedAt);
  const completedMs = Date.parse(completedAt);
  if (!Number.isFinite(startedMs) || !Number.isFinite(completedMs) || completedMs < startedMs) {
    return undefined;
  }
  return completedMs - startedMs;
}

export function conversationV2FinalAssistantKeys(
  turns: readonly ConversationTurnProjection[],
): Set<string> {
  const keys = new Set<string>();
  for (const turn of turns) {
    if (turn.status === "in_progress") {
      continue;
    }
    const finalItem =
      (turn.finalAnswerItemId
        ? turn.items.find((item) => item.id === turn.finalAnswerItemId)
        : undefined) ?? [...turn.items].reverse().find((item) => item.role === "final");
    if (
      finalItem?.content.kind === "timeline" &&
      finalItem.content.item.kind === "assistant_message"
    ) {
      keys.add(conversationV2ItemFeedKey(finalItem.id));
    }
  }
  return keys;
}

/**
 * Builds turn-level rows from canonical roles and lifecycle. FeedEntry remains
 * only the leaf rendering contract during migration; it no longer decides
 * process/final grouping for Conversation V2.
 */
export function conversationV2DisplayRows(
  turns: readonly ConversationTurnProjection[],
  visibleEntries: readonly FeedEntry[],
): ChatDisplayRow[] {
  const entryByKey = new Map(visibleEntries.map((entry) => [entry.key, entry]));
  const rows: ChatDisplayRow[] = [];

  for (const turn of turns) {
    const processEntries = turn.items
      .filter((item) => item.role === "process")
      .map((item) => entryByKey.get(conversationV2ItemFeedKey(item.id)))
      .filter((entry): entry is FeedEntry => entry !== undefined);
    const firstProcessItemId = turn.items.find((item) => item.role === "process")?.id;
    let processInserted = false;
    const insertProcessGroup = () => {
      if (
        processInserted ||
        (processEntries.length === 0 && turn.itemsView !== "summary")
      ) {
        return;
      }
      const settled = turn.status !== "in_progress";
      const runtimeModel = runtimeModelFromEntries(processEntries);
      const durationMs =
        turn.durationMs ?? durationBetween(turn.startedAt, turn.completedAt);
      rows.push({
        kind: "assistant_process_group",
        key: `conversation-process:${turn.id}`,
        entries: processEntries,
        completed: settled,
        active: turn.status === "in_progress",
        startedAt:
          turn.startedAt ??
          processEntries[0]?.ts ??
          turn.completedAt ??
          "1970-01-01T00:00:00.000Z",
        ...(turn.completedAt ? { completedAt: turn.completedAt } : {}),
        ...(durationMs !== undefined ? { durationMs } : {}),
        failedCount: turn.failedItemCount,
        ...(runtimeModel ? { runtimeModel } : {}),
        turnStatus: turn.status,
        turnId: turn.id,
        ...(turn.itemsView === "summary" ? { detailsAvailable: true } : {}),
      });
      processInserted = true;
    };

    for (const item of turn.items) {
      const entry = entryByKey.get(conversationV2ItemFeedKey(item.id));
      if (item.role === "process") {
        if (!processInserted && item.id === firstProcessItemId && processEntries.length > 0) {
          insertProcessGroup();
        }
        continue;
      }
      if (item.role === "final") {
        insertProcessGroup();
      }
      if (entry) {
        rows.push({ kind: "feed_entry", key: entry.key, entry });
      }
    }
    insertProcessGroup();
  }

  return rows;
}

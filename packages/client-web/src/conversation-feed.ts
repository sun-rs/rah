import type {
  ConversationItemProjection,
  ConversationItemStatus,
  ConversationTurnProjection,
  SessionQueuedInput,
  TimelineRuntimeModel,
} from "@rah/runtime-protocol";
import type { FeedEntry } from "./types";
import type { ChatDisplayRow } from "./components/chat/assistant-process-groups";

export function conversationItemFeedKey(itemId: string): string {
  return `conversation:${itemId}`;
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
  const key = conversationItemFeedKey(item.id);
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

export function conversationTurnsToFeed(
  turns: readonly ConversationTurnProjection[],
  localFeed: readonly FeedEntry[] = [],
): FeedEntry[] {
  const feed: FeedEntry[] = [];
  const canonicalClientMessageIds = new Set<string>();
  for (const turn of turns) {
    for (const item of turn.items) {
      const entry = itemToFeedEntry(turn, item);
      if (entry) {
        feed.push(entry);
        if (
          entry.kind === "timeline" &&
          entry.item.kind === "user_message" &&
          entry.item.clientMessageId
        ) {
          canonicalClientMessageIds.add(entry.item.clientMessageId);
        }
      }
    }
  }
  for (const entry of localFeed) {
    if (
      entry.kind !== "timeline" ||
      entry.item.kind !== "user_message" ||
      !entry.key.startsWith("optimistic:user:") ||
      entry.turnId !== undefined ||
      entry.canonicalTurnId !== undefined ||
      entry.providerTurnId !== undefined ||
      (entry.item.clientMessageId && canonicalClientMessageIds.has(entry.item.clientMessageId))
    ) {
      continue;
    }
    feed.push(entry);
  }
  return feed;
}

/**
 * Keeps the runtime-owned input queue out of the conversation timeline. Queue
 * items are rendered by the composer queue and enter the transcript only when
 * they are actually sent or guided into a provider turn.
 */
export function conversationFeedWithInputQueue(
  feed: readonly FeedEntry[],
  inputQueue: readonly SessionQueuedInput[],
): FeedEntry[] {
  void inputQueue;
  return [...feed];
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

export function conversationFinalAssistantKeys(
  turns: readonly ConversationTurnProjection[],
): Set<string> {
  const keys = new Set<string>();
  for (const turn of turns) {
    const finalItem =
      (turn.finalAnswerItemId
        ? turn.items.find((item) => item.id === turn.finalAnswerItemId)
        : undefined) ?? [...turn.items].reverse().find((item) => item.role === "final");
    if (
      finalItem?.content.kind === "timeline" &&
      finalItem.content.item.kind === "assistant_message"
    ) {
      keys.add(conversationItemFeedKey(finalItem.id));
    }
  }
  return keys;
}

/**
 * Builds turn-level rows from canonical roles and lifecycle. FeedEntry remains
 * only the leaf rendering contract; it does not decide
 * process/final grouping for the canonical conversation protocol.
 */
export function conversationDisplayRows(
  turns: readonly ConversationTurnProjection[],
  visibleEntries: readonly FeedEntry[],
  activeVisibleEntries: readonly FeedEntry[] = visibleEntries,
): ChatDisplayRow[] {
  const entryByKey = new Map(visibleEntries.map((entry) => [entry.key, entry]));
  const activeEntryByKey = new Map(
    activeVisibleEntries.map((entry) => [entry.key, entry]),
  );
  const rows: ChatDisplayRow[] = [];
  const pendingUserEntries = visibleEntries
    .filter(
      (entry): entry is Extract<FeedEntry, { kind: "timeline" }> =>
        entry.kind === "timeline" &&
        entry.item.kind === "user_message" &&
        entry.key.startsWith("optimistic:user:"),
    )
    .sort((left, right) => Date.parse(left.ts) - Date.parse(right.ts));
  let pendingUserIndex = 0;

  const insertPendingUsersBefore = (turn: ConversationTurnProjection) => {
    const turnStartedAt = turn.startedAt ? Date.parse(turn.startedAt) : Number.NaN;
    while (pendingUserIndex < pendingUserEntries.length) {
      const entry = pendingUserEntries[pendingUserIndex]!;
      const entryStartedAt = Date.parse(entry.ts);
      const belongsBeforeTurn =
        Number.isFinite(turnStartedAt) &&
        (!Number.isFinite(entryStartedAt) || entryStartedAt <= turnStartedAt);
      if (!belongsBeforeTurn) {
        break;
      }
      rows.push({ kind: "feed_entry", key: entry.key, entry });
      pendingUserIndex += 1;
    }
  };

  for (const turn of turns) {
    insertPendingUsersBefore(turn);
    const finalItem =
      (turn.finalAnswerItemId
        ? turn.items.find((item) => item.id === turn.finalAnswerItemId)
        : undefined) ?? [...turn.items].reverse().find((item) => item.role === "final");
    const processSettled = turn.status !== "in_progress" || finalItem !== undefined;
    // Process groups are already collapsed once a turn settles. Keep their
    // complete entry set available so an explicit Worked expansion cannot
    // disappear merely because completed tool cards are hidden globally.
    const processEntryByKey = activeEntryByKey;
    const processEntries = turn.items
      .filter((item) => item.role === "process")
      .map((item) => processEntryByKey.get(conversationItemFeedKey(item.id)))
      .filter((entry): entry is FeedEntry => entry !== undefined);
    const firstProcessItemId = turn.items.find((item) => item.role === "process")?.id;
    const processCompletedAt =
      turn.completedAt ??
      (finalItem ? itemTimestamp(turn, finalItem) : undefined);
    const durationMs =
      turn.durationMs ?? durationBetween(turn.startedAt, processCompletedAt);
    let processInserted = false;
    let outputsInserted = false;
    let fileChangesInserted = false;
    const insertProcessGroup = () => {
      const hasProcessEvidence =
        processEntries.length > 0 || turn.activities.length > 0;
      const completedSummaryNeedsRow =
        turn.itemsView === "summary" &&
        turn.status === "completed" &&
        finalItem !== undefined &&
        durationMs !== undefined;
      const lifecycleNeedsRow =
        turn.status === "failed" ||
        turn.status === "interrupted" ||
        (turn.status === "in_progress" && finalItem === undefined) ||
        completedSummaryNeedsRow;
      if (
        processInserted ||
        (!hasProcessEvidence && !lifecycleNeedsRow)
      ) {
        return;
      }
      const runtimeModel = runtimeModelFromEntries(processEntries);
      rows.push({
        kind: "assistant_process_group",
        key: `conversation-process:${turn.id}`,
        entries: processEntries,
        completed: processSettled,
        active: turn.status === "in_progress" && !processSettled,
        startedAt:
          turn.startedAt ??
          processEntries[0]?.ts ??
          turn.completedAt ??
          "1970-01-01T00:00:00.000Z",
        ...(processCompletedAt ? { completedAt: processCompletedAt } : {}),
        ...(durationMs !== undefined ? { durationMs } : {}),
        activities: turn.activities,
        ...(runtimeModel ? { runtimeModel } : {}),
        turnStatus: turn.status,
        turnId: turn.id,
        ...(turn.itemsView === "summary" &&
        (hasProcessEvidence || completedSummaryNeedsRow)
          ? { detailsAvailable: true }
          : {}),
      });
      processInserted = true;
    };

    const insertTurnArtifacts = () => {
      // Canonical outputs can arrive with the native final answer before the
      // provider lifecycle completion. File changes describe the completed
      // turn snapshot and stay hidden until that lifecycle is settled.
      if (
        !outputsInserted &&
        (turn.outputs?.length ?? 0) > 0 &&
        (turn.status !== "in_progress" || finalItem !== undefined)
      ) {
        rows.push({
          kind: "turn_outputs",
          key: `conversation-outputs:${turn.id}`,
          outputs: turn.outputs ?? [],
        });
        outputsInserted = true;
      }
      if (
        !fileChangesInserted &&
        turn.status !== "in_progress" &&
        (turn.fileChanges?.files.length ?? 0) > 0
      ) {
        rows.push({
          kind: "turn_file_changes",
          key: `conversation-file-changes:${turn.id}`,
          turnId: turn.id,
          fileChanges: turn.fileChanges!,
        });
        fileChangesInserted = true;
      }
    };

    for (const item of turn.items) {
      const entry = entryByKey.get(conversationItemFeedKey(item.id));
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
      if (item.id === finalItem?.id) {
        insertTurnArtifacts();
      }
    }
    insertProcessGroup();
    insertTurnArtifacts();
  }

  for (; pendingUserIndex < pendingUserEntries.length; pendingUserIndex += 1) {
    const entry = pendingUserEntries[pendingUserIndex]!;
    rows.push({ kind: "feed_entry", key: entry.key, entry });
  }

  return rows;
}

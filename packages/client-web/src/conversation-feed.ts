import type {
  ConversationItemProjection,
  ConversationItemStatus,
  ConversationTurnProjection,
  SessionQueuedInput,
  TimelineRuntimeModel,
} from "@rah/runtime-protocol";
import type { FeedEntry } from "./types";
import {
  buildProcessDetailRows,
  type ChatDisplayRow,
} from "./components/chat/assistant-process-groups";

const feedEntriesByTurn = new WeakMap<
  ConversationTurnProjection,
  readonly FeedEntry[]
>();
const displayRowsByTurn = new WeakMap<
  ConversationTurnProjection,
  readonly ChatDisplayRow[]
>();

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
        canonicalItemId: item.id,
        canonicalTurnId: turn.id,
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

function canonicalFeedEntriesForTurn(
  turn: ConversationTurnProjection,
): readonly FeedEntry[] {
  const cached = feedEntriesByTurn.get(turn);
  if (cached) {
    return cached;
  }
  const entries = turn.items
    .map((item) => itemToFeedEntry(turn, item))
    .filter((entry): entry is FeedEntry => entry !== null);
  feedEntriesByTurn.set(turn, entries);
  return entries;
}

type UserTimelineEntry = Extract<FeedEntry, { kind: "timeline" }> & {
  item: Extract<
    Extract<FeedEntry, { kind: "timeline" }>["item"],
    { kind: "user_message" }
  >;
};

function isUserTimelineEntry(entry: FeedEntry): entry is UserTimelineEntry {
  return entry.kind === "timeline" && entry.item.kind === "user_message";
}

/**
 * The canonical conversation only consumes unresolved optimistic user
 * messages from the legacy live feed. Process output, tool details, and other
 * data-plane entries must not invalidate the chat transcript.
 *
 * Returning the previous array when those optimistic entries are unchanged
 * gives the React boundary a stable semantic dependency even while the
 * provider is producing high-volume command output.
 */
export function stableConversationLocalFeed(
  currentFeed: readonly FeedEntry[],
  previousFeed: readonly FeedEntry[] = [],
): readonly FeedEntry[] {
  const nextFeed = currentFeed.filter(
    (entry) =>
      isUserTimelineEntry(entry) &&
      entry.key.startsWith("optimistic:user:"),
  );
  return sameReferences(previousFeed, nextFeed) ? previousFeed : nextFeed;
}

function userEntryBelongsToTurn(
  entry: UserTimelineEntry,
  turn: ConversationTurnProjection,
): boolean {
  return (
    entry.canonicalTurnId === turn.id ||
    (turn.providerTurnId !== undefined &&
      (entry.providerTurnId === turn.providerTurnId ||
        entry.turnId === turn.providerTurnId)) ||
    entry.turnId === turn.id
  );
}

function userEntriesAreEquivalent(
  localEntry: UserTimelineEntry,
  canonicalEntry: UserTimelineEntry,
): boolean {
  const localClientMessageId = localEntry.item.clientMessageId;
  const canonicalClientMessageId = canonicalEntry.item.clientMessageId;
  if (
    localClientMessageId !== undefined &&
    canonicalClientMessageId !== undefined &&
    localClientMessageId === canonicalClientMessageId
  ) {
    return true;
  }

  const localMessageId = localEntry.item.messageId;
  const canonicalMessageId = canonicalEntry.item.messageId;
  if (
    localMessageId !== undefined &&
    canonicalMessageId !== undefined &&
    localMessageId === canonicalMessageId
  ) {
    return true;
  }

  if (
    localEntry.canonicalItemId !== undefined &&
    canonicalEntry.canonicalItemId !== undefined &&
    localEntry.canonicalItemId === canonicalEntry.canonicalItemId
  ) {
    return true;
  }

  return (
    localEntry.item.text === canonicalEntry.item.text &&
    ((localEntry.canonicalTurnId !== undefined &&
      localEntry.canonicalTurnId === canonicalEntry.canonicalTurnId) ||
      (localEntry.providerTurnId !== undefined &&
        localEntry.providerTurnId === canonicalEntry.providerTurnId) ||
      (localEntry.turnId !== undefined &&
        (localEntry.turnId === canonicalEntry.turnId ||
          localEntry.turnId === canonicalEntry.canonicalTurnId ||
          localEntry.turnId === canonicalEntry.providerTurnId)))
  );
}

export function conversationTurnsToFeed(
  turns: readonly ConversationTurnProjection[],
  localFeed: readonly FeedEntry[] = [],
): FeedEntry[] {
  const feed: FeedEntry[] = [];
  const canonicalUserEntries: UserTimelineEntry[] = [];
  for (const turn of turns) {
    for (const entry of canonicalFeedEntriesForTurn(turn)) {
      feed.push(entry);
      if (isUserTimelineEntry(entry)) {
        canonicalUserEntries.push(entry);
      }
    }
  }
  for (const entry of localFeed) {
    if (
      !isUserTimelineEntry(entry) ||
      !entry.key.startsWith("optimistic:user:")
    ) {
      continue;
    }
    if (
      canonicalUserEntries.some((canonicalEntry) =>
        userEntriesAreEquivalent(entry, canonicalEntry),
      )
    ) {
      continue;
    }
    const unresolved =
      entry.turnId === undefined &&
      entry.canonicalTurnId === undefined &&
      entry.providerTurnId === undefined;
    const belongsToLoadedTurn = turns.some((turn) =>
      userEntryBelongsToTurn(entry, turn),
    );
    if (!unresolved && !belongsToLoadedTurn) {
      continue;
    }
    feed.push(entry);
  }
  return feed;
}

/**
 * Queued follow-ups stay in the composer queue. A submitting item is different:
 * RAH has already handed it to the provider and owns it until turn acceptance,
 * so it must remain visible as the user's message even after a page refresh.
 * The canonical provider item replaces this projection by client message id.
 */
export function conversationFeedWithInputQueue(
  feed: readonly FeedEntry[],
  inputQueue: readonly SessionQueuedInput[],
): FeedEntry[] {
  const next = [...feed];
  const visibleClientMessageIds = new Set(
    feed.flatMap((entry) =>
      isUserTimelineEntry(entry) && entry.item.clientMessageId
        ? [entry.item.clientMessageId]
        : [],
    ),
  );
  for (const input of inputQueue) {
    if (
      (input.state ?? "queued") !== "submitting" ||
      visibleClientMessageIds.has(input.clientMessageId)
    ) {
      continue;
    }
    next.push({
      key: `submitting:user:${input.clientMessageId}`,
      kind: "timeline",
      item: {
        kind: "user_message",
        text: input.text,
        clientMessageId: input.clientMessageId,
        ...(input.clientTurnId ? { clientTurnId: input.clientTurnId } : {}),
        ...(input.attachments?.length
          ? {
              attachments: input.attachments,
              imageCount: input.attachments.filter(
                (attachment) => attachment.kind === "image",
              ).length,
            }
          : {}),
      },
      ts: input.queuedAt,
    });
    visibleClientMessageIds.add(input.clientMessageId);
  }
  return next;
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

function sameReferences<T>(
  left: readonly T[],
  right: readonly T[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function sameDisplayRow(
  left: ChatDisplayRow,
  right: ChatDisplayRow,
): boolean {
  if (left.kind !== right.kind || left.key !== right.key) {
    return false;
  }
  if (left.kind === "feed_entry" && right.kind === "feed_entry") {
    return left.entry === right.entry;
  }
  if (
    left.kind === "assistant_process_group" &&
    right.kind === "assistant_process_group"
  ) {
    return (
      sameReferences(left.entries, right.entries) &&
      left.completed === right.completed &&
      left.active === right.active &&
      left.hasFinalAnswer === right.hasFinalAnswer &&
      left.startedAt === right.startedAt &&
      left.completedAt === right.completedAt &&
      left.durationMs === right.durationMs &&
      left.activities === right.activities &&
      left.runtimeModel === right.runtimeModel &&
      left.turnStatus === right.turnStatus &&
      left.turnId === right.turnId &&
      left.detailsAvailable === right.detailsAvailable
    );
  }
  if (
    left.kind === "turn_file_changes" &&
    right.kind === "turn_file_changes"
  ) {
    return (
      left.turnId === right.turnId &&
      left.fileChanges === right.fileChanges
    );
  }
  return (
    left.kind === "turn_copy_action" &&
    right.kind === "turn_copy_action" &&
    left.content === right.content
  );
}

function stableDisplayRowsForTurn(
  turn: ConversationTurnProjection,
  rows: readonly ChatDisplayRow[],
): readonly ChatDisplayRow[] {
  const cached = displayRowsByTurn.get(turn);
  if (
    cached &&
    cached.length === rows.length &&
    cached.every((row, index) => sameDisplayRow(row, rows[index]!))
  ) {
    return cached;
  }
  displayRowsByTurn.set(turn, rows);
  return rows;
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
  options: { generationActive?: boolean } = {},
): ChatDisplayRow[] {
  const entryByKey = new Map(visibleEntries.map((entry) => [entry.key, entry]));
  const activeEntryByKey = new Map(
    activeVisibleEntries.map((entry) => [entry.key, entry]),
  );
  const rows: ChatDisplayRow[] = [];
  const supplementalUserEntries = visibleEntries
    .filter(
      (entry): entry is UserTimelineEntry =>
        isUserTimelineEntry(entry) &&
        entry.key.startsWith("optimistic:user:"),
    )
    .sort((left, right) => Date.parse(left.ts) - Date.parse(right.ts));
  const supplementalUsersByTurn = new Map<string, UserTimelineEntry[]>();
  const pendingUserEntries: UserTimelineEntry[] = [];
  for (const entry of supplementalUserEntries) {
    const ownerTurn = turns.find((turn) => userEntryBelongsToTurn(entry, turn));
    if (!ownerTurn) {
      pendingUserEntries.push(entry);
      continue;
    }
    const current = supplementalUsersByTurn.get(ownerTurn.id) ?? [];
    current.push(entry);
    supplementalUsersByTurn.set(ownerTurn.id, current);
  }
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
    for (const entry of supplementalUsersByTurn.get(turn.id) ?? []) {
      rows.push({ kind: "feed_entry", key: entry.key, entry });
    }
    const turnRowsStart = rows.length;
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
    let fileChangesInserted = false;
    let copyActionInserted = false;
    const insertProcessGroup = () => {
      const renderableProcessRows = buildProcessDetailRows(processEntries, {
        includeTransientStatus: !processSettled,
      });
      const hasProcessEvidence =
        renderableProcessRows.length > 0 || turn.activities.length > 0;
      const hasHydratableProcessDetails =
        hasProcessEvidence || turn.processDetailsAvailable === true;
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
        hasFinalAnswer: finalItem !== undefined,
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
        hasHydratableProcessDetails
          ? { detailsAvailable: true }
          : {}),
      });
      processInserted = true;
    };

    const insertTurnArtifacts = () => {
      // Outputs belong to the session resource index (Inspector). Rendering
      // them here duplicates deliverables already linked from the answer.
      // The chat stream owns only the completed turn's file-change summary.
      if (
        !fileChangesInserted &&
        turn.status !== "in_progress" &&
        (turn.fileChanges?.files.length ?? 0) > 0
      ) {
        rows.push({
          kind: "turn_file_changes",
          key: `conversation-file-changes:${turn.id}`,
          // Artifact storage is keyed by the provider-owned turn identity.
          // The canonical id is only a projection identity and may change
          // when a stored turn is hydrated.
          turnId: turn.providerTurnId ?? turn.id,
          fileChanges: turn.fileChanges!,
        });
        fileChangesInserted = true;
      }
    };

    const insertTurnCopyAction = () => {
      if (
        copyActionInserted ||
        finalItem?.content.kind !== "timeline" ||
        finalItem.content.item.kind !== "assistant_message" ||
        !entryByKey.has(conversationItemFeedKey(finalItem.id))
      ) {
        return;
      }
      rows.push({
        kind: "turn_copy_action",
        key: `conversation-copy-action:${turn.id}`,
        content: finalItem.content.item.text,
      });
      copyActionInserted = true;
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
    insertTurnCopyAction();
    const renderedTurnRows = rows.slice(turnRowsStart);
    const stableTurnRows = stableDisplayRowsForTurn(turn, renderedTurnRows);
    if (stableTurnRows !== renderedTurnRows) {
      rows.splice(
        turnRowsStart,
        renderedTurnRows.length,
        ...stableTurnRows,
      );
    }
  }

  for (; pendingUserIndex < pendingUserEntries.length; pendingUserIndex += 1) {
    const entry = pendingUserEntries[pendingUserIndex]!;
    rows.push({ kind: "feed_entry", key: entry.key, entry });
  }

  const latestPendingUser = supplementalUserEntries.at(-1);
  const hasCanonicalActiveTurn = turns.some(
    (turn) => turn.status === "in_progress" && turn.finalAnswerItemId === undefined,
  );
  if (options.generationActive && latestPendingUser && !hasCanonicalActiveTurn) {
    const clientTurnId = latestPendingUser.item.clientTurnId;
    rows.push({
      kind: "assistant_process_group",
      key: `conversation-process:optimistic:${clientTurnId ?? latestPendingUser.key}`,
      entries: [],
      completed: false,
      active: true,
      hasFinalAnswer: false,
      startedAt: latestPendingUser.ts,
      activities: [],
      turnStatus: "in_progress",
      ...(clientTurnId ? { turnId: clientTurnId } : {}),
    });
  }

  return rows;
}

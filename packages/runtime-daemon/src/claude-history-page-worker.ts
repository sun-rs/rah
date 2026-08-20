import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import type {
  ConversationEvidencePage,
  ConversationTurnProjection,
  RahEvent,
} from "@rah/runtime-protocol";
import type { ClaudeStoredSessionRecord } from "./claude-session-files";
import {
  getClaudeStoredSessionHistoryPage,
  readClaudeStoredSessionTurnWindow,
} from "./claude-session-files";
import { projectConversation } from "./conversation-projector";
import { summarizeHistoryPage } from "./history-event-projection";
import { serveBackgroundIpcTask } from "./background-ipc-task";

const DEFAULT_RESPONSE_BUDGET_BYTES = 4 * 1024 * 1024;
const MAX_COMPACT_STRING_BYTES = 32 * 1024;
const MAX_COMPACT_COLLECTION_ITEMS = 128;
const MAX_COMPACT_DEPTH = 32;

export type ClaudeHistoryPageWorkerRequest = {
  kind: "claude-history-summary-page";
  sessionId: string;
  record: ClaudeStoredSessionRecord;
  cursor?: string;
  limit: number;
  responseBudgetBytes?: number;
};

export type ClaudeHistoryPageWorkerResponse =
  | { ok: true; page: ConversationEvidencePage }
  | { ok: false; error: string };

type ClaudeTurnCursor = {
  beforeProviderTurnId: string;
};

type ClaudeOffsetCursor = {
  version: 2;
  snapshotEndOffset: number;
  endOffset: number;
};

type DecodedClaudeCursor =
  | { kind: "offset"; value: ClaudeOffsetCursor }
  | { kind: "legacy-turn"; value: ClaudeTurnCursor };

function encodeCursor(value: ClaudeTurnCursor | ClaudeOffsetCursor): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function decodeCursor(value: string | undefined): DecodedClaudeCursor | undefined {
  if (!value) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    ) as Partial<ClaudeTurnCursor & ClaudeOffsetCursor>;
    if (
      parsed.version === 2 &&
      typeof parsed.snapshotEndOffset === "number" &&
      Number.isSafeInteger(parsed.snapshotEndOffset) &&
      parsed.snapshotEndOffset >= 0 &&
      typeof parsed.endOffset === "number" &&
      Number.isSafeInteger(parsed.endOffset) &&
      parsed.endOffset >= 0 &&
      parsed.endOffset <= parsed.snapshotEndOffset
    ) {
      return {
        kind: "offset",
        value: {
          version: 2,
          snapshotEndOffset: parsed.snapshotEndOffset,
          endOffset: parsed.endOffset,
        },
      };
    }
    return typeof parsed.beforeProviderTurnId === "string"
      ? {
          kind: "legacy-turn",
          value: { beforeProviderTurnId: parsed.beforeProviderTurnId },
        }
      : undefined;
  } catch {
    return undefined;
  }
}

function truncateUtf8(value: string, maxBytes: number): string {
  const source = Buffer.from(value, "utf8");
  if (source.byteLength <= maxBytes) {
    return value;
  }
  let end = Math.max(0, maxBytes - Buffer.byteLength("\n…", "utf8"));
  while (end > 0 && (source[end]! & 0xc0) === 0x80) {
    end -= 1;
  }
  return `${source.subarray(0, end).toString("utf8")}\n…`;
}

function compactTransportValue(
  value: unknown,
  depth = 0,
  maxStringBytes = MAX_COMPACT_STRING_BYTES,
): unknown {
  if (typeof value === "string") {
    return truncateUtf8(value, maxStringBytes);
  }
  if (
    value === null ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    value === undefined
  ) {
    return value;
  }
  if (depth >= MAX_COMPACT_DEPTH) {
    return "[nested value omitted]";
  }
  if (Array.isArray(value)) {
    const maxItems =
      maxStringBytes >= 4 * 1024
        ? MAX_COMPACT_COLLECTION_ITEMS
        : maxStringBytes >= 1024
          ? 32
          : 8;
    return value
      .slice(0, maxItems)
      .map((item) => compactTransportValue(item, depth + 1, maxStringBytes));
  }
  if (typeof value === "object") {
    const maxItems =
      maxStringBytes >= 4 * 1024
        ? MAX_COMPACT_COLLECTION_ITEMS
        : maxStringBytes >= 1024
          ? 32
          : 8;
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, maxItems)
        .map(([key, item]) => [
          key,
          compactTransportValue(item, depth + 1, maxStringBytes),
        ]),
    );
  }
  return String(value);
}

function stableEventId(
  sessionId: string,
  event: RahEvent,
  ordinal: number,
): string {
  const digest = createHash("sha256")
    .update(
      [
        sessionId,
        event.type,
        event.turnId ?? "",
        event.ts,
        ordinal,
      ].join("\0"),
    )
    .digest("base64url")
    .slice(0, 24);
  return `history:${sessionId}:${digest}`;
}

function hasTerminalEvent(
  events: readonly RahEvent[],
  providerTurnId: string,
): boolean {
  return events.some(
    (event) =>
      event.turnId === providerTurnId &&
      (event.type === "turn.completed" ||
        event.type === "turn.failed" ||
        event.type === "turn.canceled"),
  );
}

function syntheticTerminalEvent(args: {
  sessionId: string;
  turn: ConversationTurnProjection;
  seq: number;
}): RahEvent | undefined {
  const providerTurnId = args.turn.providerTurnId;
  if (!providerTurnId) {
    return undefined;
  }
  const ts =
    args.turn.completedAt ??
    args.turn.startedAt ??
    new Date(0).toISOString();
  const common = {
    id: stableEventId(
      args.sessionId,
      {
        id: "",
        sessionId: args.sessionId,
        seq: args.seq,
        ts,
        type: "turn.completed",
        source: {
          provider: "claude",
          channel: "structured_persisted",
          authority: "derived",
        },
        turnId: providerTurnId,
        payload: {},
      },
      args.seq,
    ),
    sessionId: args.sessionId,
    seq: args.seq,
    ts,
    source: {
      provider: "claude" as const,
      channel: "structured_persisted" as const,
      authority: "derived" as const,
    },
    turnId: providerTurnId,
  };
  if (args.turn.status === "interrupted") {
    return {
      ...common,
      type: "turn.canceled",
      payload: { reason: "interrupted", completedAt: ts },
    };
  }
  if (args.turn.status === "failed") {
    return {
      ...common,
      type: "turn.failed",
      payload: {
        error: args.turn.error?.message ?? "Claude turn failed.",
        completedAt: ts,
      },
    };
  }
  return {
    ...common,
    type: "turn.completed",
    payload: { completedAt: ts },
  };
}

type ClaudeTurnEventGroup = {
  turnId?: string;
  events: RahEvent[];
};

function groupEventsByTurn(events: readonly RahEvent[]): ClaudeTurnEventGroup[] {
  const groups: ClaudeTurnEventGroup[] = [];
  for (const event of events) {
    const previous = groups.at(-1);
    if (event.turnId && previous?.turnId === event.turnId) {
      previous.events.push(event);
      continue;
    }
    groups.push({
      ...(event.turnId ? { turnId: event.turnId } : {}),
      events: [event],
    });
  }
  return groups;
}

function timelineItemKind(event: RahEvent): string | undefined {
  if (event.type !== "timeline.item.added") {
    return undefined;
  }
  const payload = event.payload as {
    item?: { kind?: unknown };
  };
  return typeof payload.item?.kind === "string"
    ? payload.item.kind
    : undefined;
}

function assistantMessagePhase(event: RahEvent): string | undefined {
  if (timelineItemKind(event) !== "assistant_message") {
    return undefined;
  }
  const payload = event.payload as {
    item?: { phase?: unknown };
  };
  return typeof payload.item?.phase === "string"
    ? payload.item.phase
    : undefined;
}

function terminalEvent(event: RahEvent): boolean {
  return (
    event.type === "turn.completed" ||
    event.type === "turn.failed" ||
    event.type === "turn.canceled"
  );
}

function essentialTurnEventIndexes(events: readonly RahEvent[]): number[] {
  const indexes = new Set<number>();
  const firstStarted = events.findIndex((event) => event.type === "turn.started");
  if (firstStarted >= 0) {
    indexes.add(firstStarted);
  }
  const firstUser = events.findIndex(
    (event) => timelineItemKind(event) === "user_message",
  );
  if (firstUser >= 0) {
    indexes.add(firstUser);
  }
  let finalAssistant = -1;
  let lastAssistant = -1;
  let lastTerminal = -1;
  let lastError = -1;
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]!;
    if (timelineItemKind(event) === "assistant_message") {
      lastAssistant = index;
      if (assistantMessagePhase(event) === "final_answer") {
        finalAssistant = index;
      }
    }
    if (terminalEvent(event)) {
      lastTerminal = index;
    }
    if (timelineItemKind(event) === "error") {
      lastError = index;
    }
    if (timelineItemKind(event) === "compaction") {
      indexes.add(index);
    }
  }
  if (finalAssistant >= 0) {
    indexes.add(finalAssistant);
  } else if (lastAssistant >= 0) {
    indexes.add(lastAssistant);
  }
  if (lastError >= 0) {
    indexes.add(lastError);
  }
  if (lastTerminal >= 0) {
    indexes.add(lastTerminal);
  }
  if (indexes.size === 0 && events.length > 0) {
    indexes.add(0);
    indexes.add(events.length - 1);
  }
  return [...indexes].sort((left, right) => left - right);
}

function serializedEventsBytes(events: readonly RahEvent[]): number {
  return Buffer.byteLength(JSON.stringify(events), "utf8");
}

function compactEvents(
  events: readonly RahEvent[],
  maxStringBytes: number,
): RahEvent[] {
  return events.map(
    (event) =>
      compactTransportValue(event, 0, maxStringBytes) as RahEvent,
  );
}

/**
 * Reduces one oversized turn without producing orphan tool or assistant rows.
 * The user message, final assistant message and terminal state are retained as
 * a semantic turn envelope; optional process events are added only when they
 * fit the remaining transport budget.
 */
function compactOversizedTurn(
  events: readonly RahEvent[],
  maxBytes: number,
): RahEvent[] {
  const essentialIndexes = essentialTurnEventIndexes(events);
  for (const maxStringBytes of [4096, 2048, 1024, 512, 128]) {
    const essential = compactEvents(
      essentialIndexes.map((index) => events[index]!),
      maxStringBytes,
    );
    if (serializedEventsBytes(essential) > maxBytes) {
      continue;
    }
    const selected = new Map(
      essentialIndexes.map((index, ordinal) => [index, essential[ordinal]!] as const),
    );
    for (let index = events.length - 1; index >= 0; index -= 1) {
      if (selected.has(index)) {
        continue;
      }
      const candidateEvent = compactEvents([events[index]!], maxStringBytes)[0]!;
      const candidate = [...selected, [index, candidateEvent] as const]
        .sort(([left], [right]) => left - right)
        .map(([, event]) => event);
      if (serializedEventsBytes(candidate) <= maxBytes) {
        selected.set(index, candidateEvent);
      }
    }
    return [...selected]
      .sort(([left], [right]) => left - right)
      .map(([, event]) => event);
  }
  throw new Error(
    `Claude turn envelope exceeds the ${maxBytes}-byte response budget.`,
  );
}

export function boundClaudeSummaryPage(
  page: ConversationEvidencePage,
  maxBytes: number,
  cursorBeforeTurn?: (providerTurnId: string) => string | undefined,
): ConversationEvidencePage {
  const summarized = summarizeHistoryPage(page);
  const safeBudget = Math.max(64 * 1024, maxBytes);
  const compactedEvents = compactEvents(
    summarized.events,
    MAX_COMPACT_STRING_BYTES,
  );
  const sourceGroups = groupEventsByTurn(compactedEvents);
  const {
    events: _summarizedEvents,
    nextCursor: sourceNextCursor,
    approximateBytes: _sourceApproximateBytes,
    ...pageEnvelope
  } = summarized;
  const envelopeBytes = Buffer.byteLength(
    JSON.stringify({ ...pageEnvelope, events: [] }),
    "utf8",
  );
  const eventBudget = Math.max(16 * 1024, safeBudget - envelopeBytes - 2048);
  const retainedGroups: ClaudeTurnEventGroup[] = [];
  let retainedBytes = 0;
  let droppedWholeTurnPrefix = false;
  for (let index = sourceGroups.length - 1; index >= 0; index -= 1) {
    const group = sourceGroups[index]!;
    const remainingBytes = eventBudget - retainedBytes;
    let groupEvents = group.events;
    let groupBytes = serializedEventsBytes(groupEvents);
    if (groupBytes > remainingBytes && retainedGroups.length === 0) {
      groupEvents = compactOversizedTurn(group.events, remainingBytes);
      groupBytes = serializedEventsBytes(groupEvents);
    }
    if (groupBytes > remainingBytes) {
      droppedWholeTurnPrefix = true;
      break;
    }
    retainedGroups.unshift({
      ...(group.turnId ? { turnId: group.turnId } : {}),
      events: groupEvents,
    });
    retainedBytes += groupBytes;
  }
  const retained = retainedGroups
    .flatMap((group) => group.events)
    .map((event, index) => ({ ...event, seq: index + 1 }));
  const oldestRetainedTurnId =
    retainedGroups.find((group) => group.turnId)?.turnId ??
    retained.find((event) => event.turnId)?.turnId;
  const nextCursor =
    droppedWholeTurnPrefix && oldestRetainedTurnId
      ? cursorBeforeTurn?.(oldestRetainedTurnId) ??
        encodeCursor({ beforeProviderTurnId: oldestRetainedTurnId })
      : sourceNextCursor;
  const bounded: ConversationEvidencePage = {
    ...pageEnvelope,
    events: retained,
    ...(nextCursor ? { nextCursor } : {}),
  };
  bounded.approximateBytes = Buffer.byteLength(JSON.stringify(bounded), "utf8");
  if (bounded.approximateBytes > safeBudget) {
    throw new Error(
      `Claude history page exceeded its ${safeBudget}-byte response budget.`,
    );
  }
  return bounded;
}

function buildLegacyClaudeHistorySummaryPage(
  request: ClaudeHistoryPageWorkerRequest,
): ConversationEvidencePage {
  const source = getClaudeStoredSessionHistoryPage({
    sessionId: request.sessionId,
    record: request.record,
    limit: Number.MAX_SAFE_INTEGER,
  });
  const reboundEvents = source.events.map(
    (event, index) =>
      ({
        ...event,
        id: stableEventId(request.sessionId, event, index),
        sessionId: request.sessionId,
        seq: index + 1,
      }) as RahEvent,
  );
  const projection = projectConversation(request.sessionId, reboundEvents, {
    assumeSettled: true,
  });
  const cursor = decodeCursor(request.cursor);
  let endExclusive = projection.turns.length;
  if (cursor?.kind === "legacy-turn") {
    const anchorIndex = projection.turns.findIndex(
      (turn) => turn.providerTurnId === cursor.value.beforeProviderTurnId,
    );
    if (anchorIndex < 0) {
      throw new Error("Claude history cursor no longer exists in the transcript.");
    }
    endExclusive = anchorIndex;
  } else if (request.cursor) {
    // Compatibility with the older timestamp cursor.
    endExclusive = projection.turns.findIndex(
      (turn) => (turn.startedAt ?? "") >= request.cursor!,
    );
    if (endExclusive < 0) {
      endExclusive = projection.turns.length;
    }
  }
  const safeLimit = Math.max(1, Math.min(request.limit, 100));
  const start = Math.max(0, endExclusive - safeLimit);
  const selectedTurns = projection.turns.slice(start, endExclusive);
  const eventsByTurn = new Map<string, RahEvent[]>();
  for (const event of reboundEvents) {
    if (!event.turnId) {
      continue;
    }
    const events = eventsByTurn.get(event.turnId) ?? [];
    events.push(event);
    eventsByTurn.set(event.turnId, events);
  }
  const events: RahEvent[] = [];
  for (const turn of selectedTurns) {
    const providerTurnId = turn.providerTurnId;
    if (!providerTurnId) {
      continue;
    }
    const turnEvents = eventsByTurn.get(providerTurnId) ?? [];
    events.push(...turnEvents);
    if (!hasTerminalEvent(turnEvents, providerTurnId)) {
      const terminal = syntheticTerminalEvent({
        sessionId: request.sessionId,
        turn,
        seq: events.length + 1,
      });
      if (terminal) {
        events.push(terminal);
      }
    }
  }
  const nextCursor =
    start > 0 && selectedTurns[0]?.providerTurnId
      ? encodeCursor({
          beforeProviderTurnId: selectedTurns[0].providerTurnId,
        })
      : undefined;
  const page: ConversationEvidencePage = {
    sessionId: request.sessionId,
    events: events.map((event, index) => ({ ...event, seq: index + 1 })),
    detailMode: "summary",
    ...(nextCursor ? { nextCursor } : {}),
  };
  return boundClaudeSummaryPage(
    page,
    request.responseBudgetBytes ?? DEFAULT_RESPONSE_BUDGET_BYTES,
  );
}

function offsetCursor(args: {
  snapshotEndOffset: number;
  endOffset: number;
}): string {
  return encodeCursor({
    version: 2,
    snapshotEndOffset: args.snapshotEndOffset,
    endOffset: args.endOffset,
  });
}

/**
 * Native Claude history pages are byte-windowed. The cursor freezes the file
 * length observed by the initial request and points at a complete user-turn
 * boundary, so subsequent pages never need to replay the newer prefix.
 */
export function buildClaudeHistorySummaryPage(
  request: ClaudeHistoryPageWorkerRequest,
): ConversationEvidencePage {
  const decoded = decodeCursor(request.cursor);
  if (request.cursor && decoded?.kind !== "offset") {
    // Keep in-flight cursors produced before the offset protocol deployable.
    // New responses always use offset cursors, so this full-file path ages out
    // naturally instead of remaining on the normal browsing path.
    return buildLegacyClaudeHistorySummaryPage(request);
  }

  const fileSize = statSync(request.record.filePath).size;
  const snapshotEndOffset =
    decoded?.kind === "offset" ? decoded.value.snapshotEndOffset : fileSize;
  const endOffset =
    decoded?.kind === "offset" ? decoded.value.endOffset : snapshotEndOffset;
  if (fileSize < snapshotEndOffset || endOffset > snapshotEndOffset) {
    throw new Error("Claude history source was truncated while paging.");
  }

  const safeLimit = Math.max(1, Math.min(request.limit, 100));
  const source = readClaudeStoredSessionTurnWindow({
    sessionId: request.sessionId,
    record: request.record,
    endOffset,
    limit: safeLimit,
  });
  const reboundEvents = source.events.map(
    (event, index) =>
      ({
        ...event,
        id: stableEventId(request.sessionId, event, index),
        sessionId: request.sessionId,
        seq: index + 1,
      }) as RahEvent,
  );
  const projection = projectConversation(request.sessionId, reboundEvents, {
    assumeSettled: true,
  });
  const eventsByTurn = new Map<string, RahEvent[]>();
  for (const event of reboundEvents) {
    if (!event.turnId) {
      continue;
    }
    const events = eventsByTurn.get(event.turnId) ?? [];
    events.push(event);
    eventsByTurn.set(event.turnId, events);
  }
  const events: RahEvent[] = [];
  for (const turn of projection.turns) {
    const providerTurnId = turn.providerTurnId;
    if (!providerTurnId) {
      continue;
    }
    const turnEvents = eventsByTurn.get(providerTurnId) ?? [];
    events.push(...turnEvents);
    if (!hasTerminalEvent(turnEvents, providerTurnId)) {
      const terminal = syntheticTerminalEvent({
        sessionId: request.sessionId,
        turn,
        seq: events.length + 1,
      });
      if (terminal) {
        events.push(terminal);
      }
    }
  }
  const nextCursor =
    source.nextEndOffset !== undefined
      ? offsetCursor({ snapshotEndOffset, endOffset: source.nextEndOffset })
      : undefined;
  const page: ConversationEvidencePage = {
    sessionId: request.sessionId,
    events: events.map((event, index) => ({ ...event, seq: index + 1 })),
    detailMode: "summary",
    ...(nextCursor ? { nextCursor } : {}),
  };
  return boundClaudeSummaryPage(
    page,
    request.responseBudgetBytes ?? DEFAULT_RESPONSE_BUDGET_BYTES,
    (providerTurnId) => {
      const turnStartOffset = source.turnStartOffsets.get(providerTurnId);
      return turnStartOffset === undefined
        ? undefined
        : offsetCursor({ snapshotEndOffset, endOffset: turnStartOffset });
    },
  );
}

serveBackgroundIpcTask<
  ClaudeHistoryPageWorkerRequest,
  ClaudeHistoryPageWorkerResponse
>({
  label: "Claude history page worker",
  handle: (request) => {
    if (request.kind !== "claude-history-summary-page") {
      throw new Error("Unknown Claude history worker request.");
    }
    return {
      ok: true,
      page: buildClaudeHistorySummaryPage(request),
    };
  },
  onError: (error) => ({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
  }),
  maxResponseBytes: 8 * 1024 * 1024,
});

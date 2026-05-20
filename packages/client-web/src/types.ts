import type {
  ListSessionsResponse,
  ManagedSession,
  MessagePartRef,
  PermissionRequest,
  PermissionResolution,
  ProviderKind,
  RahEvent,
  RuntimeOperation,
  SessionSummary,
  TimelineIdentity,
  TimelineItem,
  TimelineRuntimeModel,
  ToolCallArtifact,
  ToolCall,
  ToolCallDetail,
  WorkbenchObservation,
} from "@rah/runtime-protocol";
import { conversationStateFromRuntimeState } from "@rah/runtime-protocol";

export type SessionsResponse = ListSessionsResponse;

const PROVISIONAL_USER_ECHO_WINDOW_MS = 5_000;
const COMPOSITE_USER_ECHO_WINDOW_MS = 15_000;

export type FeedEntry =
  | {
      key: string;
      kind: "timeline";
      item: TimelineItem;
      ts: string;
      turnId?: string;
      canonicalItemId?: TimelineIdentity["canonicalItemId"];
      canonicalTurnId?: TimelineIdentity["canonicalTurnId"];
      sourceProvider?: ProviderKind | "system";
    }
  | {
      key: string;
      kind: "tool_call";
      toolCall: ToolCall;
      status: "running" | "completed" | "failed";
      error?: string;
      ts: string;
      turnId?: string;
    }
  | {
      key: string;
      kind: "message_part";
      part: MessagePartRef;
      status: "added" | "updated" | "streaming" | "removed";
      ts: string;
      turnId?: string;
    }
  | {
      key: string;
      kind: "observation";
      observation: WorkbenchObservation;
      status: "running" | "completed" | "failed";
      error?: string;
      ts: string;
      turnId?: string;
    }
  | {
      key: string;
      kind: "permission";
      request: PermissionRequest;
      resolution?: PermissionResolution;
      ts: string;
      turnId?: string;
    }
  | {
      key: string;
      kind: "operation";
      operation: RuntimeOperation;
      status: "started" | "resolved" | "requested";
      ts: string;
      turnId?: string;
    }
  | {
      key: string;
      kind: "runtime_status";
      status: Extract<RahEvent, { type: "runtime.status" }>["payload"]["status"];
      detail?: string;
      retryCount?: number;
      ts: string;
      turnId?: string;
    }
  | {
      key: string;
      kind: "notification";
      level: Extract<RahEvent, { type: "notification.emitted" }>["payload"]["level"];
      title: string;
      body: string;
      url?: string;
      ts: string;
      turnId?: string;
      canonicalTurnId?: TimelineIdentity["canonicalTurnId"];
      interruptAnchorKey?: string;
    };

interface InterruptIntent {
  requestedAt: string;
  anchorKey?: string;
  turnId?: string;
  canonicalTurnId?: TimelineIdentity["canonicalTurnId"];
}

export interface SessionProjection {
  summary: SessionSummary;
  feed: FeedEntry[];
  events: RahEvent[];
  lastSeq: number;
  currentRuntimeStatus?: Extract<RahEvent, { type: "runtime.status" }>["payload"]["status"];
  history: HistorySyncState;
  pendingInterrupt?: InterruptIntent;
}

export interface HistorySyncState {
  phase: "idle" | "loading" | "ready" | "error";
  nextCursor: string | null;
  nextBeforeTs: string | null;
  generation: number;
  authoritativeApplied: boolean;
  lastError: string | null;
}

export function markPendingInterruptIntent(current: SessionProjection): SessionProjection {
  const anchor = findLastInterruptIntentAnchor(current.feed);
  const intent: InterruptIntent = {
    requestedAt: new Date().toISOString(),
    ...(anchor?.key !== undefined ? { anchorKey: anchor.key } : {}),
    ...(anchor?.turnId !== undefined ? { turnId: anchor.turnId } : {}),
    ...(anchor?.canonicalTurnId !== undefined ? { canonicalTurnId: anchor.canonicalTurnId } : {}),
  };
  return {
    ...current,
    pendingInterrupt: intent,
  };
}

function findLastInterruptIntentAnchor(feed: FeedEntry[]):
  | { key: string; turnId?: string; canonicalTurnId?: TimelineIdentity["canonicalTurnId"] }
  | undefined {
  for (let index = feed.length - 1; index >= 0; index--) {
    const entry = feed[index];
    if (
      !entry ||
      entry.kind === "notification" ||
      entry.kind === "runtime_status"
    ) {
      continue;
    }
    return {
      key: entry.key,
      ...("turnId" in entry && entry.turnId !== undefined ? { turnId: entry.turnId } : {}),
      ...("canonicalTurnId" in entry && entry.canonicalTurnId !== undefined
        ? { canonicalTurnId: entry.canonicalTurnId }
        : {}),
    };
  }
  return undefined;
}

export interface SessionMap {
  sessions: Map<string, SessionProjection>;
  storedSessionIds: string[];
}

type MergeableTimelineItem = Extract<
  TimelineItem,
  | { kind: "user_message"; text: string }
  | { kind: "assistant_message"; text: string }
  | { kind: "reasoning"; text: string }
>;
type TimelineEntry = Extract<FeedEntry, { kind: "timeline" }>;
type TimelineIdentityFields = Pick<TimelineEntry, "canonicalItemId" | "canonicalTurnId">;

export function createSessionMap(response: SessionsResponse): SessionMap {
  const sessions = new Map<string, SessionProjection>();
  for (const summary of response.sessions) {
    sessions.set(summary.session.id, {
      summary,
      feed: [],
      events: [],
      lastSeq: 0,
      history: initialHistorySyncState(),
    });
  }
  return {
    sessions,
    storedSessionIds: response.storedSessions.map(
      (stored) => `${stored.provider}:${stored.providerSessionId}`,
    ),
  };
}

export function initialHistorySyncState(): HistorySyncState {
  return {
    phase: "idle",
    nextCursor: null,
    nextBeforeTs: null,
    generation: 0,
    authoritativeApplied: false,
    lastError: null,
  };
}

function isIsoTsAtLeast(left: string | undefined, right: string | undefined): boolean {
  if (!left || !right) {
    return true;
  }
  return left >= right;
}

function shouldApplySummaryMutation(current: SessionProjection, event: RahEvent): boolean {
  switch (event.type) {
    case "session.started":
      return isIsoTsAtLeast(event.payload.session.updatedAt, current.summary.session.updatedAt);
    case "session.state.changed":
    case "session.native_tui.prompt_state.changed":
    case "permission.requested":
    case "permission.resolved":
    case "usage.updated":
      return true;
    case "control.claimed":
    case "control.released":
      return isIsoTsAtLeast(event.ts, current.summary.session.updatedAt);
    default:
      return true;
  }
}

function sessionSummaryIsActivelyRunning(summary: SessionSummary): boolean {
  return summary.session.status === "running" && [
    "starting",
    "working",
    "stopping",
  ].includes(summary.session.phase);
}

function nextRuntimeStatusForEvent(
  current: SessionProjection,
  nextSummary: SessionSummary,
  event: RahEvent,
): Extract<RahEvent, { type: "runtime.status" }>["payload"]["status"] | undefined {
  if (event.type === "runtime.status") {
    return event.payload.status;
  }
  if (event.type === "turn.completed" || event.type === "turn.failed" || event.type === "turn.canceled") {
    return undefined;
  }
  if (!sessionSummaryIsActivelyRunning(nextSummary)) {
    return undefined;
  }
  return current.currentRuntimeStatus;
}

function summaryWithRuntimeState(
  current: SessionProjection,
  state: SessionProjection["summary"]["session"]["runtimeState"],
  updatedAt: string,
): SessionProjection["summary"] {
  return {
    ...current.summary,
    session: {
      ...current.summary.session,
      ...conversationStateFromRuntimeState(state),
      runtimeState: state,
      updatedAt,
    },
  };
}

function summaryWithTurnFailure(
  current: SessionProjection,
  error: string,
  updatedAt: string,
): SessionProjection["summary"] {
  const next = summaryWithRuntimeState(current, "failed", updatedAt);
  const previousError = current.summary.session.runtimeDiagnostics?.lastError?.trim();
  const nextError = error.trim();
  const lastError =
    previousError && !isGenericRuntimeError(previousError) && isGenericRuntimeError(nextError)
      ? previousError
      : nextError;
  return {
    ...next,
    session: {
      ...next.session,
      runtimeDiagnostics: {
        ...(next.session.runtimeDiagnostics ?? {}),
        lastError,
      },
    },
  };
}

function isGenericRuntimeError(message: string): boolean {
  return (
    message.includes("Unexpected server error. Check server logs for details.") ||
    /^TUI client exited(?: with code \d+)?$/.test(message)
  );
}

function summaryWithUpdatedAt(
  current: SessionProjection,
  updatedAt: string,
): SessionProjection["summary"] {
  if (!isIsoTsAtLeast(updatedAt, current.summary.session.updatedAt)) {
    return current.summary;
  }
  return {
    ...current.summary,
    session: {
      ...current.summary.session,
      updatedAt,
    },
  };
}

function createTimelineEntry(
  entry: Omit<Extract<FeedEntry, { kind: "timeline" }>, "turnId">,
  turnId?: string,
): Extract<FeedEntry, { kind: "timeline" }> {
  if (turnId === undefined) {
    return entry;
  }
  return {
    ...entry,
    turnId,
  };
}

function createToolCallEntry(
  entry: Omit<Extract<FeedEntry, { kind: "tool_call" }>, "turnId">,
  turnId?: string,
): Extract<FeedEntry, { kind: "tool_call" }> {
  if (turnId === undefined) {
    return entry;
  }
  return {
    ...entry,
    turnId,
  };
}

function createMessagePartEntry(
  entry: Omit<Extract<FeedEntry, { kind: "message_part" }>, "turnId">,
  turnId?: string,
): Extract<FeedEntry, { kind: "message_part" }> {
  if (turnId === undefined) {
    return entry;
  }
  return {
    ...entry,
    turnId,
  };
}

function createPermissionEntry(
  entry: Omit<Extract<FeedEntry, { kind: "permission" }>, "turnId">,
  turnId?: string,
): Extract<FeedEntry, { kind: "permission" }> {
  if (turnId === undefined) {
    return entry;
  }
  return {
    ...entry,
    turnId,
  };
}

function createObservationEntry(
  entry: Omit<Extract<FeedEntry, { kind: "observation" }>, "turnId">,
  turnId?: string,
): Extract<FeedEntry, { kind: "observation" }> {
  if (turnId === undefined) {
    return entry;
  }
  return {
    ...entry,
    turnId,
  };
}

function createOperationEntry(
  entry: Omit<Extract<FeedEntry, { kind: "operation" }>, "turnId">,
  turnId?: string,
): Extract<FeedEntry, { kind: "operation" }> {
  if (turnId === undefined) {
    return entry;
  }
  return {
    ...entry,
    turnId,
  };
}

function createRuntimeStatusEntry(
  entry: Omit<Extract<FeedEntry, { kind: "runtime_status" }>, "turnId">,
  turnId?: string,
): Extract<FeedEntry, { kind: "runtime_status" }> {
  if (turnId === undefined) {
    return entry;
  }
  return {
    ...entry,
    turnId,
  };
}

function createNotificationEntry(
  entry: Omit<Extract<FeedEntry, { kind: "notification" }>, "turnId">,
  turnId?: string,
): Extract<FeedEntry, { kind: "notification" }> {
  if (turnId === undefined) {
    return entry;
  }
  return {
    ...entry,
    turnId,
  };
}

function applyTimelineEvent(
  feed: FeedEntry[],
  event: Extract<RahEvent, { type: "timeline.item.added" | "timeline.item.updated" }>,
): FeedEntry[] {
  const identityFields = readTimelineIdentityFields(event);
  if (identityFields.canonicalItemId !== undefined) {
    const canonicalIndex = feed.findIndex(
      (candidate) =>
        candidate.kind === "timeline" &&
        candidate.canonicalItemId === identityFields.canonicalItemId,
    );
    if (canonicalIndex >= 0) {
      const next = [...feed];
      const current = next[canonicalIndex] as Extract<FeedEntry, { kind: "timeline" }>;
      const item = mergeOrReplaceTimelineItem(current.item, event.payload.item, event.type);
      next[canonicalIndex] = createTimelineEntry(
        {
          key: current.key,
          kind: "timeline",
          item,
          ts: event.ts,
          sourceProvider: event.source.provider,
          ...mergeTimelineIdentityFields(current, identityFields),
        },
        event.turnId ?? current.turnId,
      );
      return next;
    }
  }

  const clientMessageId = readTimelineClientMessageId(event.payload.item);
  if (clientMessageId) {
    const clientMessageIndex = feed.findIndex(
      (candidate) =>
        candidate.kind === "timeline" &&
        candidate.item.kind === "user_message" &&
        readTimelineClientMessageId(candidate.item) === clientMessageId &&
        canMergeTimelineCanonicalIdentity(candidate, identityFields),
    );
    if (clientMessageIndex >= 0) {
      const next = [...feed];
      const current = next[clientMessageIndex] as Extract<FeedEntry, { kind: "timeline" }>;
      next[clientMessageIndex] = createTimelineEntry(
        {
          key: current.key,
          kind: "timeline",
          item: event.payload.item,
          ts: event.ts,
          sourceProvider: event.source.provider,
          ...mergeTimelineIdentityFields(current, identityFields),
        },
        event.turnId ?? current.turnId,
      );
      return next;
    }
  }

  const messageId = readTimelineMessageId(event.payload.item);
  if (messageId) {
    const messageIndex = feed.findIndex(
      (candidate) =>
        candidate.kind === "timeline" &&
        candidate.item.kind === event.payload.item.kind &&
        readTimelineMessageId(candidate.item) === messageId &&
        canMergeTimelineCanonicalIdentity(candidate, identityFields),
    );
    if (messageIndex >= 0) {
      const next = [...feed];
      const current = next[messageIndex] as Extract<FeedEntry, { kind: "timeline" }>;
      const item = mergeOrReplaceTimelineItem(current.item, event.payload.item, event.type);
      next[messageIndex] = createTimelineEntry(
        {
          key: current.key,
          kind: "timeline",
          item,
          ts: event.ts,
          sourceProvider: event.source.provider,
          ...mergeTimelineIdentityFields(current, identityFields),
        },
        event.turnId ?? current.turnId,
      );
      return next;
    }
  }

  if (event.type === "timeline.item.added" && event.payload.item.kind === "user_message") {
    const incomingUserItem = event.payload.item;
    const weakEchoIndex = findWeakUserEchoIndex(feed, incomingUserItem, identityFields, event.ts);
    if (weakEchoIndex >= 0) {
      const weakEcho = feed[weakEchoIndex] as Extract<FeedEntry, { kind: "timeline" }>;
      if (
        isAuthoritativeUserMessageEntry(weakEcho) &&
        !isAuthoritativeUserMessage(incomingUserItem, identityFields)
      ) {
        return feed;
      }
      if (
        identityFields.canonicalItemId === undefined &&
        incomingUserItem.messageId === undefined &&
        incomingUserItem.clientMessageId === undefined
      ) {
        return feed;
      }
      const next = [...feed];
      next[weakEchoIndex] = createTimelineEntry(
        {
          key: weakEcho.key,
          kind: "timeline",
          item: event.payload.item,
          ts: event.ts,
          sourceProvider: event.source.provider,
          ...mergeTimelineIdentityFields(weakEcho, identityFields),
        },
        event.turnId ?? weakEcho.turnId,
      );
      return next;
    }

    const duplicateIndex = findOptimisticUserMessageIndex(
      feed,
      incomingUserItem.text,
      identityFields,
    );
    if (duplicateIndex >= 0) {
      const next = [...feed];
      const duplicate = next[duplicateIndex] as Extract<FeedEntry, { kind: "timeline" }>;
      next[duplicateIndex] = createTimelineEntry(
        {
          key: duplicate.key,
          kind: "timeline",
          item: event.payload.item,
          ts: event.ts,
          sourceProvider: event.source.provider,
          ...mergeTimelineIdentityFields(duplicate, identityFields),
        },
        event.turnId ?? duplicate.turnId,
      );
      return next;
    }

    const duplicateEchoIndex = findSameTurnUserEchoIndex(
      feed,
      incomingUserItem.text,
      event.turnId,
    );
    if (duplicateEchoIndex >= 0) {
      const next = [...feed];
      const duplicate = next[duplicateEchoIndex] as Extract<FeedEntry, { kind: "timeline" }>;
      next[duplicateEchoIndex] = createTimelineEntry(
        {
          key: duplicate.key,
          kind: "timeline",
          item: event.payload.item,
          ts: event.ts,
          sourceProvider: event.source.provider,
          ...mergeTimelineIdentityFields(duplicate, identityFields),
        },
        event.turnId ?? duplicate.turnId,
      );
      return next;
    }

    if (event.source.provider === "gemini" && isAuthoritativeUserMessage(incomingUserItem, identityFields)) {
      const compositeEchoIndexes = findCompositeOptimisticUserEchoIndexes(
        feed,
        incomingUserItem.text,
        identityFields,
        event.ts,
      );
      if (compositeEchoIndexes.length > 1) {
        const firstIndex = compositeEchoIndexes[0]!;
        const removedIndexes = new Set(compositeEchoIndexes.slice(1));
        const firstEcho = feed[firstIndex] as Extract<FeedEntry, { kind: "timeline" }>;
        const replacement = createTimelineEntry(
          {
            key: firstEcho.key,
            kind: "timeline",
            item: event.payload.item,
            ts: event.ts,
            sourceProvider: event.source.provider,
            ...mergeTimelineIdentityFields(firstEcho, identityFields),
          },
          event.turnId ?? firstEcho.turnId,
        );
        return feed
          .map((entry, index) => (index === firstIndex ? replacement : entry))
          .filter((_entry, index) => !removedIndexes.has(index));
      }
    }
  }

  const latestEntry = feed.at(-1);
  if (
    event.type === "timeline.item.added" &&
    event.turnId !== undefined &&
    latestEntry?.kind === "timeline" &&
    latestEntry.turnId === event.turnId &&
    canMergeTimelineCanonicalIdentity(latestEntry, identityFields) &&
    canMergeTimelineText(latestEntry.item, event.payload.item) &&
    canMergeTimelineIdentity(latestEntry.item, event.payload.item)
  ) {
    const next = [...feed];
    next[next.length - 1] = {
      ...latestEntry,
      item: {
        ...latestEntry.item,
        text: mergeTimelineText(
          latestEntry.item as MergeableTimelineItem,
          event.payload.item as MergeableTimelineItem,
        ),
        ...assistantRuntimeModelPatch(latestEntry.item, event.payload.item),
      },
      ts: event.ts,
      sourceProvider: event.source.provider,
      ...mergeTimelineIdentityFields(latestEntry, identityFields),
    };
    return next;
  }

  const key =
    identityFields.canonicalItemId !== undefined
      ? `timeline:${identityFields.canonicalItemId}`
      : `${event.turnId ?? "session"}:${event.payload.item.kind}:${event.seq}`;
  const entry = createTimelineEntry(
    {
      key,
      kind: "timeline",
      item: event.payload.item,
      ts: event.ts,
      sourceProvider: event.source.provider,
      ...identityFields,
    },
    event.turnId,
  );
  if (event.type === "timeline.item.updated") {
    const index = feed.findIndex((candidate) => candidate.key === key);
    if (index >= 0) {
      const next = [...feed];
      next[index] = entry;
      return next;
    }
  }
  return insertTimelineEntry(feed, entry, event);
}

function insertTimelineEntry(
  feed: FeedEntry[],
  entry: Extract<FeedEntry, { kind: "timeline" }>,
  _event: Extract<RahEvent, { type: "timeline.item.added" | "timeline.item.updated" }>,
): FeedEntry[] {
  // Live mirrors must preserve daemon event order. Provider timestamps can move
  // backwards or arrive later than RAH runtime notices, especially for Claude
  // JSONL and provider-local history mirrors. Older history is merged through
  // prependHistoryPage, not by re-sorting live events here.
  return [...feed, entry];
}

function findOptimisticUserMessageIndex(
  feed: FeedEntry[],
  text: string,
  incomingIdentity: TimelineIdentityFields,
): number {
  for (let index = 0; index < feed.length; index++) {
    const candidate = feed[index];
    if (
      candidate?.kind !== "timeline" ||
      candidate.item.kind !== "user_message" ||
      candidate.item.text !== text
    ) {
      continue;
    }
    if (!canMergeTimelineCanonicalIdentity(candidate, incomingIdentity)) {
      continue;
    }
    if (isOptimisticUserMessageEntry(candidate)) {
      return index;
    }
  }
  return -1;
}

function findCompositeOptimisticUserEchoIndexes(
  feed: FeedEntry[],
  text: string,
  incomingIdentity: TimelineIdentityFields,
  incomingTs: string,
): number[] {
  if (!text.includes("\n\n")) {
    return [];
  }
  const candidates = feed
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => {
      if (!isOptimisticUserMessageEntry(entry)) {
        return false;
      }
      if (!canMergeTimelineCanonicalIdentity(entry, incomingIdentity)) {
        return false;
      }
      return timelineTimestampsWithinMs(entry.ts, incomingTs, COMPOSITE_USER_ECHO_WINDOW_MS);
    }) as Array<{ entry: Extract<FeedEntry, { kind: "timeline" }>; index: number }>;

  for (let start = 0; start < candidates.length; start += 1) {
    const indexes: number[] = [];
    const parts: string[] = [];
    for (let cursor = start; cursor < candidates.length; cursor += 1) {
      const candidate = candidates[cursor]!;
      indexes.push(candidate.index);
      parts.push(candidate.entry.item.kind === "user_message" ? candidate.entry.item.text : "");
      const joined = parts.join("\n\n");
      if (joined === text && indexes.length > 1) {
        return indexes;
      }
      if (!text.startsWith(joined)) {
        break;
      }
    }
  }
  return [];
}

function findWeakUserEchoIndex(
  feed: FeedEntry[],
  incoming: Extract<TimelineItem, { kind: "user_message" }>,
  incomingIdentity: TimelineIdentityFields,
  incomingTs: string,
): number {
  const incomingAuthoritative = isAuthoritativeUserMessage(incoming, incomingIdentity);
  const incomingProvisional = isProvisionalClientUserMessage(incoming, incomingIdentity);
  const incomingWeak = !incomingAuthoritative;
  for (let index = feed.length - 1; index >= 0; index--) {
    const candidate = feed[index];
    if (
      candidate?.kind !== "timeline" ||
      candidate.item.kind !== "user_message" ||
      candidate.item.text !== incoming.text
    ) {
      continue;
    }
    const candidateIsUnresolvedOptimistic =
      candidate.key.startsWith("optimistic:user:") && candidate.turnId === undefined;
    const candidateAuthoritative =
      !candidateIsUnresolvedOptimistic && isAuthoritativeUserMessageEntry(candidate);
    const candidateProvisional =
      !candidateIsUnresolvedOptimistic && isProvisionalClientUserMessageEntry(candidate);
    if (
      ((incomingProvisional && candidateAuthoritative) ||
        (incomingAuthoritative && candidateProvisional)) &&
      !timelineTimestampsWithinMs(candidate.ts, incomingTs, PROVISIONAL_USER_ECHO_WINDOW_MS)
    ) {
      continue;
    }
    if ((incomingWeak && candidateAuthoritative) || (incomingAuthoritative && !candidateAuthoritative)) {
      return index;
    }
  }
  return -1;
}

function isAuthoritativeUserMessage(
  item: Extract<TimelineItem, { kind: "user_message" }>,
  identity: TimelineIdentityFields,
): boolean {
  return identity.canonicalItemId !== undefined || item.messageId !== undefined;
}

function isAuthoritativeUserMessageEntry(
  entry: Extract<FeedEntry, { kind: "timeline" }>,
): boolean {
  return (
    entry.item.kind === "user_message" &&
    (entry.canonicalItemId !== undefined || entry.item.messageId !== undefined)
  );
}

function isProvisionalClientUserMessage(
  item: Extract<TimelineItem, { kind: "user_message" }>,
  identity: TimelineIdentityFields,
): boolean {
  return (
    identity.canonicalItemId === undefined &&
    item.messageId === undefined &&
    item.clientMessageId !== undefined
  );
}

function isProvisionalClientUserMessageEntry(
  entry: Extract<FeedEntry, { kind: "timeline" }>,
): boolean {
  return (
    entry.item.kind === "user_message" &&
    entry.canonicalItemId === undefined &&
    entry.item.messageId === undefined &&
    entry.item.clientMessageId !== undefined
  );
}

function timelineTimestampsWithinMs(leftTs: string, rightTs: string, maxMs: number): boolean {
  const leftMs = Date.parse(leftTs);
  const rightMs = Date.parse(rightTs);
  if (!Number.isFinite(leftMs) || !Number.isFinite(rightMs)) {
    return false;
  }
  return Math.abs(leftMs - rightMs) <= maxMs;
}

function findSameTurnUserEchoIndex(
  feed: FeedEntry[],
  text: string,
  incomingTurnId: string | undefined,
): number {
  if (incomingTurnId === undefined) {
    return -1;
  }
  for (let index = feed.length - 1; index >= 0; index--) {
    const candidate = feed[index];
    if (
      candidate?.kind === "notification" ||
      candidate?.kind === "runtime_status"
    ) {
      continue;
    }
    if (candidate?.kind !== "timeline") {
      continue;
    }
    if (
      candidate.turnId === incomingTurnId &&
      candidate.item.kind === "user_message" &&
      candidate.item.text === text
    ) {
      return index;
    }
  }
  return -1;
}

function isOptimisticUserMessageEntry(
  entry: FeedEntry,
): entry is Extract<FeedEntry, { kind: "timeline" }> {
  return (
    entry.kind === "timeline" &&
    entry.key.startsWith("optimistic:user:") &&
    entry.turnId === undefined &&
    entry.item.kind === "user_message"
  );
}

function readTimelineIdentityFields(
  event: Extract<RahEvent, { type: "timeline.item.added" | "timeline.item.updated" }>,
): TimelineIdentityFields {
  const identity = event.payload.identity;
  if (identity === undefined) {
    return {};
  }
  return {
    canonicalItemId: identity.canonicalItemId,
    canonicalTurnId: identity.canonicalTurnId,
  };
}

function mergeTimelineIdentityFields(
  current: TimelineEntry,
  incoming: TimelineIdentityFields,
): TimelineIdentityFields {
  return {
    ...(current.canonicalItemId !== undefined ? { canonicalItemId: current.canonicalItemId } : {}),
    ...(current.canonicalTurnId !== undefined ? { canonicalTurnId: current.canonicalTurnId } : {}),
    ...incoming,
  };
}

function canMergeTimelineCanonicalIdentity(
  current: TimelineEntry,
  incoming: TimelineIdentityFields,
): boolean {
  if (
    current.canonicalItemId !== undefined &&
    incoming.canonicalItemId !== undefined &&
    current.canonicalItemId !== incoming.canonicalItemId
  ) {
    return false;
  }
  return true;
}

function mergeOrReplaceTimelineItem(
  current: TimelineItem,
  incoming: TimelineItem,
  eventType: "timeline.item.added" | "timeline.item.updated",
): TimelineItem {
  if (eventType === "timeline.item.updated") {
    return preserveAssistantRuntimeModel(current, incoming);
  }
  if (!canMergeTimelineText(current, incoming)) {
    return preserveAssistantRuntimeModel(current, incoming);
  }
  const mergeableIncoming = incoming as MergeableTimelineItem;
  const mergeableCurrent = current as MergeableTimelineItem;
  return {
    ...mergeableCurrent,
    ...mergeableIncoming,
    text: mergeTimelineText(mergeableCurrent, mergeableIncoming),
    ...assistantRuntimeModelPatch(current, incoming),
  };
}

function assistantRuntimeModelPatch(current: TimelineItem, incoming: TimelineItem) {
  const runtimeModel =
    timelineItemRuntimeModel(incoming) ?? timelineItemRuntimeModel(current);
  return runtimeModel ? { runtimeModel } : {};
}

type RuntimeModelTimelineItem =
  | Extract<TimelineItem, { kind: "assistant_message" }>
  | Extract<TimelineItem, { kind: "reasoning" }>
  | Extract<TimelineItem, { kind: "step" }>;

function preserveAssistantRuntimeModel(current: TimelineItem, incoming: TimelineItem): TimelineItem {
  if (
    !timelineItemSupportsRuntimeModel(current) ||
    !timelineItemSupportsRuntimeModel(incoming) ||
    incoming.runtimeModel !== undefined
  ) {
    return incoming;
  }
  const runtimeModel = timelineItemRuntimeModel(current);
  return {
    ...incoming,
    ...(runtimeModel !== undefined ? { runtimeModel } : {}),
  };
}

function timelineItemSupportsRuntimeModel(
  item: TimelineItem,
): item is RuntimeModelTimelineItem {
  return item.kind === "assistant_message" || item.kind === "reasoning" || item.kind === "step";
}

function timelineItemRuntimeModel(item: TimelineItem): TimelineRuntimeModel | undefined {
  return timelineItemSupportsRuntimeModel(item) ? item.runtimeModel : undefined;
}

function readTimelineMessageId(item: TimelineItem): string | undefined {
  if (item.kind === "user_message" || item.kind === "assistant_message") {
    return item.messageId;
  }
  return undefined;
}

function readTimelineClientMessageId(item: TimelineItem): string | undefined {
  return item.kind === "user_message" ? item.clientMessageId : undefined;
}

function canMergeTimelineIdentity(current: TimelineItem, incoming: TimelineItem): boolean {
  const currentMessageId = readTimelineMessageId(current);
  const incomingMessageId = readTimelineMessageId(incoming);
  if (currentMessageId !== undefined || incomingMessageId !== undefined) {
    return currentMessageId !== undefined && currentMessageId === incomingMessageId;
  }
  return true;
}

function canMergeTimelineText(
  current: TimelineItem,
  incoming: TimelineItem,
): current is MergeableTimelineItem {
  if (
    current.kind !== "user_message" &&
    current.kind !== "assistant_message" &&
    current.kind !== "reasoning"
  ) {
    return false;
  }
  return incoming.kind === current.kind;
}

function mergeTimelineText(
  current: MergeableTimelineItem,
  incoming: MergeableTimelineItem,
): string {
  if (incoming.text.startsWith(current.text)) {
    return incoming.text;
  }
  if (current.text.endsWith(incoming.text)) {
    return current.text;
  }
  return `${current.text}${incoming.text}`;
}

function mergeToolCallDetail(
  current: ToolCallDetail | undefined,
  incoming: ToolCallDetail | undefined,
): ToolCallDetail | undefined {
  if (!current) {
    return incoming;
  }
  if (!incoming) {
    return current;
  }
  return {
    artifacts: mergeArtifacts(current.artifacts, incoming.artifacts),
  };
}

function mergeTextArtifact(
  current: Extract<ToolCallArtifact, { kind: "text" }>,
  incoming: Extract<ToolCallArtifact, { kind: "text" }>,
): Extract<ToolCallArtifact, { kind: "text" }> {
  if (incoming.text.startsWith(current.text)) {
    return incoming;
  }
  if (current.text.endsWith(incoming.text)) {
    return current;
  }
  return {
    ...current,
    text: `${current.text}${incoming.text}`,
  };
}

function mergeArtifacts(
  current: ToolCallArtifact[],
  incoming: ToolCallArtifact[],
): ToolCallArtifact[] {
  const next = [...current];
  for (const artifact of incoming) {
    if (artifact.kind === "command") {
      const index = next.findIndex(
        (candidate) =>
          candidate.kind === "command" &&
          candidate.command === artifact.command &&
          candidate.cwd === artifact.cwd,
      );
      if (index < 0) {
        next.push(artifact);
      }
      continue;
    }
    if (artifact.kind === "text") {
      const index = next.findIndex(
        (candidate) => candidate.kind === "text" && candidate.label === artifact.label,
      );
      if (index < 0) {
        next.push(artifact);
        continue;
      }
      const currentArtifact = next[index];
      if (currentArtifact?.kind === "text") {
        next[index] = mergeTextArtifact(currentArtifact, artifact);
      }
      continue;
    }
    if (artifact.kind === "file_refs") {
      const index = next.findIndex((candidate) => candidate.kind === "file_refs");
      if (index < 0) {
        next.push(artifact);
        continue;
      }
      const currentArtifact = next[index];
      if (currentArtifact?.kind === "file_refs") {
        next[index] = {
          kind: "file_refs",
          files: [...new Set([...currentArtifact.files, ...artifact.files])],
        };
      }
      continue;
    }
    if (artifact.kind === "diff") {
      const index = next.findIndex(
        (candidate) => candidate.kind === "diff" && candidate.format === artifact.format,
      );
      if (index < 0) {
        next.push(artifact);
        continue;
      }
      const currentArtifact = next[index];
      if (currentArtifact?.kind === "diff") {
        if (artifact.text.startsWith(currentArtifact.text)) {
          next[index] = artifact;
        } else if (!currentArtifact.text.includes(artifact.text)) {
          next[index] = {
            ...currentArtifact,
            text: `${currentArtifact.text}\n\n${artifact.text}`,
          };
        }
      }
      continue;
    }
    if (artifact.kind === "urls") {
      const index = next.findIndex((candidate) => candidate.kind === "urls");
      if (index < 0) {
        next.push(artifact);
        continue;
      }
      const currentArtifact = next[index];
      if (currentArtifact?.kind === "urls") {
        next[index] = {
          kind: "urls",
          urls: [...new Set([...currentArtifact.urls, ...artifact.urls])],
        };
      }
      continue;
    }
    next.push(artifact);
  }
  return next;
}

function withMergedToolDetail(toolCall: ToolCall, detail: ToolCallDetail | undefined): ToolCall {
  const merged = mergeToolCallDetail(toolCall.detail, detail);
  if (merged === undefined) {
    return toolCall;
  }
  return {
    ...toolCall,
    detail: merged,
  };
}

function applyToolCallEvent(
  feed: FeedEntry[],
  event: Extract<
    RahEvent,
    | { type: "tool.call.started" }
    | { type: "tool.call.delta" }
    | { type: "tool.call.completed" }
    | { type: "tool.call.failed" }
  >,
): FeedEntry[] {
  if (event.type === "tool.call.started") {
    const key = `tool:${event.payload.toolCall.id}`;
    const existingIndex = feed.findIndex(
      (candidate) => candidate.kind === "tool_call" && candidate.key === key,
    );
    if (existingIndex >= 0) {
      const existing = feed[existingIndex];
      if (!existing || existing.kind !== "tool_call") {
        return feed;
      }
      if (existing.status === "completed" || existing.status === "failed") {
        return feed;
      }
      const mergedDetail = mergeToolCallDetail(
        existing.toolCall.detail,
        event.payload.toolCall.detail,
      );
      const nextFeed = [...feed];
      nextFeed[existingIndex] = createToolCallEntry(
        {
          ...existing,
          toolCall: {
            ...event.payload.toolCall,
            ...(mergedDetail !== undefined ? { detail: mergedDetail } : {}),
          },
          status: "running",
          ts: event.ts,
        },
        event.turnId ?? existing.turnId,
      );
      return nextFeed;
    }
    const next = createToolCallEntry(
      {
        key,
        kind: "tool_call",
        toolCall: event.payload.toolCall,
        status: "running",
        ts: event.ts,
      },
      event.turnId,
    );
    return [...feed, next];
  }

  if (event.type === "tool.call.delta") {
    const key = `tool:${event.payload.toolCallId}`;
    const index = feed.findIndex(
      (candidate) => candidate.kind === "tool_call" && candidate.key === key,
    );
    if (index < 0) {
      return [
        ...feed,
        createToolCallEntry(
          {
            key,
            kind: "tool_call",
            toolCall: {
              id: event.payload.toolCallId,
              family: "other",
              providerToolName: "unknown",
              title: "Tool update",
              detail: event.payload.detail,
            },
            status: "running",
            ts: event.ts,
          },
          event.turnId,
        ),
      ];
    }
    const current = feed[index];
    if (!current || current.kind !== "tool_call") {
      return feed;
    }
    const next = [...feed];
    next[index] = createToolCallEntry(
      {
        ...current,
        toolCall: withMergedToolDetail(current.toolCall, event.payload.detail),
        status: "running",
        ts: event.ts,
      },
      current.turnId,
    );
    return next;
  }

  const key =
    event.type === "tool.call.completed"
      ? `tool:${event.payload.toolCall.id}`
      : `tool:${event.payload.toolCallId}`;
  const index = feed.findIndex(
    (candidate) => candidate.kind === "tool_call" && candidate.key === key,
  );
  if (index < 0) {
    if (event.type === "tool.call.completed") {
      return [
        ...feed,
        createToolCallEntry(
          {
            key,
            kind: "tool_call",
            toolCall: event.payload.toolCall,
            status: "completed",
            ts: event.ts,
          },
          event.turnId,
        ),
      ];
    }
    return [
      ...feed,
      createToolCallEntry(
        {
          key,
          kind: "tool_call",
          toolCall: {
            id: event.payload.toolCallId,
            family: "other",
            providerToolName: "unknown",
            title: "Tool failed",
            ...(event.payload.detail !== undefined ? { detail: event.payload.detail } : {}),
          },
          status: "failed",
          ts: event.ts,
          error: event.payload.error,
        },
        event.turnId,
      ),
    ];
  }
  const current = feed[index];
  if (!current || current.kind !== "tool_call") {
    return feed;
  }
  const nextToolCall =
    event.type === "tool.call.completed"
      ? (() => {
          const mergedDetail = mergeToolCallDetail(
            current.toolCall.detail,
            event.payload.toolCall.detail,
          );
          return {
            ...current.toolCall,
            ...event.payload.toolCall,
            ...(mergedDetail !== undefined ? { detail: mergedDetail } : {}),
          };
        })()
      : withMergedToolDetail(current.toolCall, event.payload.detail);
  const nextEntry = createToolCallEntry(
    {
      key: current.key,
      kind: "tool_call",
      toolCall: nextToolCall,
      status: event.type === "tool.call.completed" ? "completed" : "failed",
      ts: event.ts,
      ...(event.type === "tool.call.failed" ? { error: event.payload.error } : {}),
    },
    current.turnId,
  );
  const next = [...feed];
  next[index] = nextEntry;
  return next;
}

function applyMessagePartEvent(
  feed: FeedEntry[],
  event: Extract<
    RahEvent,
    | { type: "message.part.added" }
    | { type: "message.part.updated" }
    | { type: "message.part.delta" }
    | { type: "message.part.removed" }
  >,
): FeedEntry[] {
  const messageId =
    event.type === "message.part.removed" ? event.payload.messageId : event.payload.part.messageId;
  const partId =
    event.type === "message.part.removed" ? event.payload.partId : event.payload.part.partId;
  const key = `part:${messageId}:${partId}`;
  const index = feed.findIndex(
    (candidate) => candidate.kind === "message_part" && candidate.key === key,
  );

  if (event.type === "message.part.removed") {
    const entry = createMessagePartEntry(
      {
        key,
        kind: "message_part",
        part: {
          messageId,
          partId,
          kind: "unknown",
        },
        status: "removed",
        ts: event.ts,
      },
      event.turnId,
    );
    if (index < 0) {
      return [...feed, entry];
    }
    const next = [...feed];
    next[index] = entry;
    return next;
  }

  const incoming = event.payload.part;
  if (!shouldDisplayMessagePart(incoming)) {
    if (index < 0) {
      return feed;
    }
    return feed.filter((candidate) => candidate.kind !== "message_part" || candidate.key !== key);
  }
  const status =
    event.type === "message.part.delta"
      ? "streaming"
      : event.type === "message.part.updated"
        ? "updated"
        : "added";
  if (index < 0) {
    const text = incoming.text ?? incoming.delta;
    const part = text !== undefined ? { ...incoming, text } : incoming;
    return [
      ...feed,
      createMessagePartEntry(
        {
          key,
          kind: "message_part",
          part,
          status,
          ts: event.ts,
        },
        event.turnId,
      ),
    ];
  }

  const current = feed[index];
  if (!current || current.kind !== "message_part") {
    return feed;
  }
  const nextText =
    event.type === "message.part.delta"
      ? `${current.part.text ?? ""}${incoming.delta ?? incoming.text ?? ""}`
      : incoming.text ?? current.part.text;
  const nextPart: MessagePartRef = {
    ...current.part,
    ...incoming,
    ...(nextText !== undefined ? { text: nextText } : {}),
  };
  const next = [...feed];
  next[index] = createMessagePartEntry(
    {
      key,
      kind: "message_part",
      part: nextPart,
      status,
      ts: event.ts,
    },
    current.turnId,
  );
  return next;
}

function shouldDisplayMessagePart(part: MessagePartRef): boolean {
  return part.kind !== "text" && part.kind !== "reasoning" && part.kind !== "step";
}

function applyPermissionEvent(
  feed: FeedEntry[],
  event: Extract<RahEvent, { type: "permission.requested" | "permission.resolved" }>,
  resolvedPermissionRequestIds: ReadonlySet<string>,
): FeedEntry[] {
  if (event.type === "permission.requested") {
    if (resolvedPermissionRequestIds.has(event.payload.request.id)) {
      return removePermissionArtifacts(feed, event.payload.request.id);
    }
    const key = `perm:${event.payload.request.id}`;
    const index = feed.findIndex(
      (candidate) => candidate.kind === "permission" && candidate.key === key,
    );
    if (index < 0) {
      return [
        ...feed,
        createPermissionEntry(
          {
            key,
            kind: "permission",
            request: event.payload.request,
            ts: event.ts,
          },
          event.turnId,
        ),
      ];
    }
    const current = feed[index];
    if (!current || current.kind !== "permission") {
      return feed;
    }
    if (current.resolution !== undefined) {
      return feed;
    }
    const next = [...feed];
    next[index] = createPermissionEntry(
      {
        key: current.key,
        kind: "permission",
        request: event.payload.request,
        ts: event.ts,
      },
      event.turnId ?? current.turnId,
    );
    return next;
  }

  return removePermissionArtifacts(feed, event.payload.resolution.requestId);
}

function removePermissionArtifacts(feed: FeedEntry[], requestId: string): FeedEntry[] {
  const key = `perm:${requestId}`;
  return feed.filter((entry) => {
    if (entry.kind === "permission") {
      return entry.key !== key && entry.request.id !== requestId;
    }
    return true;
  });
}

function clearPendingPermissionEntriesForTurn(
  feed: FeedEntry[],
  event: Extract<RahEvent, { type: "turn.completed" | "turn.failed" | "turn.canceled" }>,
): FeedEntry[] {
  if (!event.turnId) {
    return feed;
  }
  const pendingRequestIds = new Set(
    feed
      .filter(
        (entry): entry is Extract<FeedEntry, { kind: "permission" }> =>
          entry.kind === "permission" &&
          entry.turnId === event.turnId &&
          entry.resolution === undefined,
      )
      .map((entry) => entry.request.id),
  );
  if (pendingRequestIds.size === 0) {
    return feed;
  }
  return feed.filter((entry) => {
    if (entry.kind === "permission") {
      return !(entry.turnId === event.turnId && pendingRequestIds.has(entry.request.id));
    }
    return true;
  });
}

function applyObservationEvent(
  feed: FeedEntry[],
  event: Extract<
    RahEvent,
    | { type: "observation.started" }
    | { type: "observation.updated" }
    | { type: "observation.completed" }
    | { type: "observation.failed" }
  >,
): FeedEntry[] {
  const key = `obs:${event.payload.observation.id}`;
  const status =
    event.type === "observation.failed"
      ? "failed"
      : event.type === "observation.completed"
        ? "completed"
        : "running";
  const nextEntry = createObservationEntry(
    {
      key,
      kind: "observation",
      observation: event.payload.observation,
      status,
      ts: event.ts,
      ...(event.type === "observation.failed" ? { error: event.payload.error } : {}),
    },
    event.turnId,
  );
  const index = feed.findIndex(
    (candidate) => candidate.kind === "observation" && candidate.key === key,
  );
  if (index < 0) {
    return [...feed, nextEntry];
  }
  const next = [...feed];
  next[index] = nextEntry;
  return next;
}

function applyOperationEvent(
  feed: FeedEntry[],
  event: Extract<
    RahEvent,
    | { type: "operation.started" }
    | { type: "operation.resolved" }
    | { type: "operation.requested" }
  >,
): FeedEntry[] {
  const key = `operation:${event.payload.operation.id}`;
  const status =
    event.type === "operation.started"
      ? "started"
      : event.type === "operation.resolved"
        ? "resolved"
        : "requested";
  const entry = createOperationEntry(
    {
      key,
      kind: "operation",
      operation: event.payload.operation,
      status,
      ts: event.ts,
    },
    event.turnId,
  );
  const index = feed.findIndex(
    (candidate) => candidate.kind === "operation" && candidate.key === key,
  );
  if (index < 0) {
    return [...feed, entry];
  }
  const next = [...feed];
  next[index] = entry;
  return next;
}

function applyRuntimeStatusEvent(
  feed: FeedEntry[],
  event: Extract<RahEvent, { type: "runtime.status" }>,
): FeedEntry[] {
  void event;
  // Runtime status is session chrome, not transcript content. Keeping retry /
  // reconnect state out of the feed prevents it from reordering around turn
  // notices when live and persisted events interleave.
  return feed;
}

function applyTurnStepEvent(
  feed: FeedEntry[],
  event: Extract<
    RahEvent,
    { type: "turn.step.started" | "turn.step.completed" | "turn.step.interrupted" }
  >,
): FeedEntry[] {
  const index = event.payload.index ?? 0;
  const key = `${event.turnId}:step:${index}`;
  const existingIndex = feed.findIndex(
    (candidate) => candidate.kind === "timeline" && candidate.key === key,
  );
  const existing = existingIndex >= 0 ? feed[existingIndex] : undefined;
  const existingStep =
    existing?.kind === "timeline" && existing.item.kind === "step" ? existing.item : undefined;
  const eventTitle = event.type === "turn.step.started" ? event.payload.title : undefined;
  if (
    event.source.provider === "opencode" &&
    eventTitle === undefined &&
    existingStep?.title === undefined
  ) {
    // OpenCode emits anonymous step markers for internal model/tool cycles.
    // Tool calls and reasoning already carry the user-visible content; showing
    // these markers as chat cards creates confusing "Step N / stop" bubbles.
    return feed;
  }
  const title =
    event.type === "turn.step.started"
      ? eventTitle ?? existingStep?.title ?? `Step ${index + 1}`
      : existingStep?.title ?? `Step ${index + 1}`;
  const status =
    event.type === "turn.step.started"
      ? "started"
      : event.type === "turn.step.completed"
        ? "completed"
        : "interrupted";
  const text =
    event.type === "turn.step.completed" || event.type === "turn.step.interrupted"
      ? event.payload.reason
      : undefined;
  const entry = createTimelineEntry(
    {
      key,
      kind: "timeline",
      item: {
        kind: "step",
        title,
        status,
        ...(text ? { text } : {}),
        ...(event.payload.runtimeModel !== undefined ? { runtimeModel: event.payload.runtimeModel } : {}),
      },
      ts: event.ts,
      sourceProvider: event.source.provider,
    },
    event.turnId,
  );
  if (existingIndex < 0) {
    return [...feed, entry];
  }
  const next = [...feed];
  next[existingIndex] = entry;
  return next;
}

function applyNotificationEvent(
  feed: FeedEntry[],
  event: Extract<RahEvent, { type: "notification.emitted" }>,
): FeedEntry[] {
  return [
    ...feed,
    createNotificationEntry(
      {
        key: `${event.turnId ?? "session"}:notification:${event.seq}`,
        kind: "notification",
        level: event.payload.level,
        title: event.payload.title,
        body: event.payload.body,
        ...(event.payload.url !== undefined ? { url: event.payload.url } : {}),
        ts: event.ts,
      },
      event.turnId,
    ),
  ];
}

function applyTurnCanceledEvent(
  feed: FeedEntry[],
  event: Extract<RahEvent, { type: "turn.canceled" }>,
  pendingInterrupt: InterruptIntent | undefined,
): { feed: FeedEntry[]; pendingInterrupt?: InterruptIntent | undefined } {
  const canonicalTurnId = event.payload.identity?.canonicalTurnId;
  const turnKey = canonicalTurnId ?? event.turnId;
  const intentMatches =
    pendingInterrupt !== undefined &&
    (pendingInterrupt.canonicalTurnId === undefined ||
      canonicalTurnId === undefined ||
      pendingInterrupt.canonicalTurnId === canonicalTurnId) &&
    (pendingInterrupt.turnId === undefined ||
      event.turnId === undefined ||
      pendingInterrupt.turnId === event.turnId);
  const intentAnchorKey = intentMatches ? pendingInterrupt?.anchorKey : undefined;
  const resolvedAnchorKey =
    intentAnchorKey ??
    findLastTurnAnchorKey(feed, { turnId: event.turnId, canonicalTurnId }) ??
    findExistingInterruptAnchorKey(feed, {
      turnId: event.turnId,
      canonicalTurnId,
    }) ??
    (hasOrphanInterruptNotice(feed) ? findLastTurnAnchorKey(feed, {}) : undefined) ??
    (turnKey === undefined ? findLastTurnAnchorKey(feed, {}) : undefined);
  const key =
    turnKey !== undefined && resolvedAnchorKey === undefined
      ? `${turnKey}:turn:canceled`
      : resolvedAnchorKey !== undefined
        ? `anchor:${resolvedAnchorKey}:turn:canceled`
        : `event:${event.id}:turn:canceled`;
  const entry = createNotificationEntry(
    {
      key,
      kind: "notification",
      level: "info",
      title: "Conversation interrupted",
      body: "The previous turn was interrupted.",
      ts: event.ts,
      ...(canonicalTurnId !== undefined ? { canonicalTurnId } : {}),
      ...(resolvedAnchorKey !== undefined ? { interruptAnchorKey: resolvedAnchorKey } : {}),
    },
    event.turnId,
  );
  const nextFeed = upsertTurnAnchoredNotification(feed, entry, {
    turnId: event.turnId,
    canonicalTurnId,
    anchorKey: resolvedAnchorKey,
  });
  return {
    feed: dedupeInterruptNotices(nextFeed),
    ...(intentMatches ? {} : pendingInterrupt !== undefined ? { pendingInterrupt } : {}),
  };
}

function findExistingInterruptAnchorKey(
  feed: FeedEntry[],
  anchor: { turnId?: string | undefined; canonicalTurnId?: string | undefined },
): string | undefined {
  for (let index = feed.length - 1; index >= 0; index--) {
    const entry = feed[index];
    if (entry?.kind !== "notification" || !isInterruptNotice(entry)) {
      continue;
    }
    if (
      anchor.canonicalTurnId !== undefined &&
      entry.canonicalTurnId !== undefined &&
      entry.canonicalTurnId !== anchor.canonicalTurnId
    ) {
      continue;
    }
    if (
      anchor.turnId !== undefined &&
      entry.turnId !== undefined &&
      entry.turnId !== anchor.turnId
    ) {
      continue;
    }
    if (entry.interruptAnchorKey !== undefined) {
      return entry.interruptAnchorKey;
    }
  }
  return undefined;
}

function isInterruptNotice(entry: Extract<FeedEntry, { kind: "notification" }>): boolean {
  return (
    entry.title === "Conversation interrupted" &&
    entry.body === "The previous turn was interrupted."
  );
}

function upsertTurnAnchoredNotification(
  feed: FeedEntry[],
  entry: Extract<FeedEntry, { kind: "notification" }>,
  anchor: {
    turnId?: string | undefined;
    canonicalTurnId?: string | undefined;
    anchorKey?: string | undefined;
  },
): FeedEntry[] {
  const resolvedAnchorKey = anchor.anchorKey ?? findLastTurnAnchorKey(feed, anchor);
  const stripped = feed.filter((candidate) =>
    !isSameTurnNotification(candidate, entry, { ...anchor, anchorKey: resolvedAnchorKey }) &&
    !isSameVisibleTurnInterruptNotice(feed, candidate, resolvedAnchorKey),
  );
  const anchorIndex = resolvedAnchorKey !== undefined
    ? stripped.findIndex((candidate) => candidate.key === resolvedAnchorKey)
    : findLastTurnAnchorIndex(stripped, anchor);
  if (anchorIndex < 0) {
    return [...stripped, entry];
  }
  return [
    ...stripped.slice(0, anchorIndex + 1),
    entry,
    ...stripped.slice(anchorIndex + 1),
  ];
}

function isSameVisibleTurnInterruptNotice(
  feed: FeedEntry[],
  candidate: FeedEntry,
  anchorKey: string | undefined,
): boolean {
  if (
    anchorKey === undefined ||
    candidate.kind !== "notification" ||
    !isInterruptNotice(candidate)
  ) {
    return false;
  }
  if (isOrphanInterruptNotice(candidate)) {
    return true;
  }
  if (candidate.interruptAnchorKey === undefined) {
    return false;
  }
  const anchorIndex = feed.findIndex((entry) => entry.key === anchorKey);
  const candidateAnchorIndex = feed.findIndex((entry) => entry.key === candidate.interruptAnchorKey);
  if (anchorIndex < 0 || candidateAnchorIndex < 0) {
    return false;
  }
  const anchorTurnStart = findLastUserMessageIndexAtOrBefore(feed, anchorIndex);
  const candidateTurnStart = findLastUserMessageIndexAtOrBefore(feed, candidateAnchorIndex);
  return anchorTurnStart >= 0 && anchorTurnStart === candidateTurnStart;
}

function isSameTurnNotification(
  candidate: FeedEntry,
  entry: Extract<FeedEntry, { kind: "notification" }>,
  anchor: {
    turnId?: string | undefined;
    canonicalTurnId?: string | undefined;
    anchorKey?: string | undefined;
  },
): boolean {
  if (candidate.kind !== "notification") {
    return false;
  }
  if (candidate.key === entry.key) {
    return true;
  }
  if (candidate.title !== entry.title || candidate.body !== entry.body) {
    return false;
  }
  if (
    anchor.canonicalTurnId !== undefined &&
    candidate.canonicalTurnId === anchor.canonicalTurnId
  ) {
    return true;
  }
  if (
    anchor.anchorKey !== undefined &&
    (candidate.interruptAnchorKey === anchor.anchorKey ||
      candidate.key === `anchor:${anchor.anchorKey}:turn:canceled`)
  ) {
    return true;
  }
  if (anchor.anchorKey !== undefined && isOrphanInterruptNotice(candidate)) {
    return true;
  }
  if (anchor.turnId !== undefined && candidate.turnId === anchor.turnId) {
    return true;
  }
  if (anchor.turnId !== undefined && candidate.key === `${anchor.turnId}:turn:canceled`) {
    return true;
  }
  return false;
}

function findLastUserMessageIndexAtOrBefore(feed: FeedEntry[], index: number): number {
  for (let cursor = index; cursor >= 0; cursor--) {
    const entry = feed[cursor];
    if (entry?.kind === "timeline" && entry.item.kind === "user_message") {
      return cursor;
    }
  }
  return -1;
}

function isOrphanInterruptNotice(entry: Extract<FeedEntry, { kind: "notification" }>): boolean {
  return (
    isInterruptNotice(entry) &&
    entry.interruptAnchorKey === undefined &&
    entry.canonicalTurnId === undefined
  );
}

function hasOrphanInterruptNotice(feed: FeedEntry[]): boolean {
  return feed.some((entry) => entry.kind === "notification" && isOrphanInterruptNotice(entry));
}

function dedupeInterruptNotices(feed: FeedEntry[]): FeedEntry[] {
  const keepIndexByGroup = new Map<string, number>();
  const keep = new Set<number>();
  for (let index = 0; index < feed.length; index++) {
    const entry = feed[index];
    if (entry?.kind !== "notification" || !isInterruptNotice(entry)) {
      keep.add(index);
      continue;
    }
    const group = interruptNoticeGroupKey(feed, index, entry);
    const previous = keepIndexByGroup.get(group);
    if (previous !== undefined) {
      keep.delete(previous);
    }
    keepIndexByGroup.set(group, index);
    keep.add(index);
  }
  return feed.filter((_, index) => keep.has(index));
}

function interruptNoticeGroupKey(
  feed: FeedEntry[],
  index: number,
  entry: Extract<FeedEntry, { kind: "notification" }>,
): string {
  const anchorIndex = entry.interruptAnchorKey !== undefined
    ? feed.findIndex((candidate) => candidate.key === entry.interruptAnchorKey)
    : -1;
  const userIndex = findLastUserMessageIndexAtOrBefore(
    feed,
    anchorIndex >= 0 ? anchorIndex : index,
  );
  if (userIndex >= 0) {
    return `user:${feed[userIndex]!.key}`;
  }
  if (entry.canonicalTurnId !== undefined) {
    return `canonical:${entry.canonicalTurnId}`;
  }
  if (entry.turnId !== undefined) {
    return `turn:${entry.turnId}`;
  }
  return "orphan";
}

function findLastTurnAnchorIndex(
  feed: FeedEntry[],
  anchor: { turnId?: string | undefined; canonicalTurnId?: string | undefined },
): number {
  const anchorKey = findLastTurnAnchorKey(feed, anchor);
  if (anchorKey !== undefined) {
    return feed.findIndex((entry) => entry.key === anchorKey);
  }
  return -1;
}

function findLastTurnAnchorKey(
  feed: FeedEntry[],
  anchor: { turnId?: string | undefined; canonicalTurnId?: string | undefined },
): string | undefined {
  const acceptAnyTurn = anchor.turnId === undefined && anchor.canonicalTurnId === undefined;
  for (let index = feed.length - 1; index >= 0; index--) {
    const entry = feed[index];
    if (!entry || entry.kind === "notification" || entry.kind === "runtime_status") {
      continue;
    }
    if (acceptAnyTurn) {
      return entry.key;
    }
    if (
      anchor.canonicalTurnId !== undefined &&
      "canonicalTurnId" in entry &&
      entry.canonicalTurnId === anchor.canonicalTurnId
    ) {
      return entry.key;
    }
    if (anchor.turnId !== undefined && "turnId" in entry && entry.turnId === anchor.turnId) {
      return entry.key;
    }
  }
  return undefined;
}

export function applyEventToProjection(
  current: SessionProjection,
  event: RahEvent,
): SessionProjection {
  if (event.seq <= current.lastSeq) {
    return current;
  }

  const isProviderSessionRebind =
    event.type === "session.started" &&
    current.summary.session.providerSessionId !== undefined &&
    event.payload.session.providerSessionId !== undefined &&
    current.summary.session.providerSessionId !== event.payload.session.providerSessionId;

  if (isProviderSessionRebind) {
    return {
      summary: {
        ...current.summary,
        session: event.payload.session,
      },
      feed: [],
      events: [event],
      lastSeq: event.seq,
      history: initialHistorySyncState(),
    };
  }

  const permissionRequestedState: ManagedSession["runtimeState"] = "waiting_permission";
  const permissionResolvedState: ManagedSession["runtimeState"] = "running";
  const canMutateSummary = shouldApplySummaryMutation(current, event);

  const nextSummary =
    !canMutateSummary
      ? current.summary
      : event.type === "session.started"
      ? { ...current.summary, session: event.payload.session }
      : event.type === "turn.started"
        ? summaryWithRuntimeState(current, "running", event.ts)
        : event.type === "turn.completed" || event.type === "turn.canceled"
          ? summaryWithRuntimeState(current, "idle", event.ts)
          : event.type === "turn.failed"
            ? summaryWithTurnFailure(current, event.payload.error, event.ts)
            : event.type === "timeline.item.added" || event.type === "timeline.item.updated"
              ? summaryWithUpdatedAt(current, event.ts)
              : event.type === "session.state.changed"
                ? {
                    ...current.summary,
                    session: {
                      ...current.summary.session,
                      ...conversationStateFromRuntimeState(event.payload.state),
                      runtimeState: event.payload.state,
                      updatedAt: event.ts,
                    },
                  }
                : event.type === "session.native_tui.prompt_state.changed"
                  ? {
                      ...current.summary,
                      session: {
                        ...current.summary.session,
                        updatedAt: event.ts,
                        ...(current.summary.session.nativeTui
                          ? {
                              nativeTui: {
                                ...current.summary.session.nativeTui,
                                promptState: event.payload.promptState,
                                ...(event.payload.queuedInputCount !== undefined
                                  ? { queuedInputCount: event.payload.queuedInputCount }
                                  : {}),
                              },
                            }
                          : {}),
                      },
                    }
                  : event.type === "permission.requested"
                    ? {
                        ...current.summary,
                        session: {
                          ...current.summary.session,
                          ...conversationStateFromRuntimeState(permissionRequestedState),
                          runtimeState: permissionRequestedState,
                          updatedAt: event.ts,
                        },
                      }
                    : event.type === "permission.resolved"
                      ? {
                          ...current.summary,
                          session: {
                            ...current.summary.session,
                            ...conversationStateFromRuntimeState(permissionResolvedState),
                            runtimeState: permissionResolvedState,
                            updatedAt: event.ts,
                          },
                        }
                      : event.type === "control.claimed"
                        ? {
                            ...current.summary,
                            controlLease: {
                              sessionId: current.summary.session.id,
                              holderClientId: event.payload.clientId,
                              holderKind: event.payload.clientKind,
                              grantedAt: event.ts,
                            },
                          }
                        : event.type === "control.released"
                          ? {
                              ...current.summary,
                              controlLease: {
                                sessionId: current.summary.session.id,
                              },
                            }
                          : event.type === "usage.updated"
                            ? {
                                ...current.summary,
                                usage: event.payload.usage,
                              }
                            : current.summary;

  let nextFeed = current.feed;
  let nextPendingInterrupt = current.pendingInterrupt;
  const resolvedPermissionRequestIds = new Set(
    current.events.flatMap((candidate) =>
      candidate.type === "permission.resolved" ? [candidate.payload.resolution.requestId] : [],
    ),
  );
  switch (event.type) {
    case "timeline.item.added":
    case "timeline.item.updated":
      nextFeed = applyTimelineEvent(nextFeed, event);
      break;
    case "tool.call.started":
    case "tool.call.delta":
    case "tool.call.completed":
    case "tool.call.failed":
      nextFeed = applyToolCallEvent(nextFeed, event);
      break;
    case "message.part.added":
    case "message.part.updated":
    case "message.part.delta":
    case "message.part.removed":
      nextFeed = applyMessagePartEvent(nextFeed, event);
      break;
    case "observation.started":
    case "observation.updated":
    case "observation.completed":
    case "observation.failed":
      nextFeed = applyObservationEvent(nextFeed, event);
      break;
    case "permission.requested":
    case "permission.resolved":
      nextFeed = applyPermissionEvent(nextFeed, event, resolvedPermissionRequestIds);
      break;
    case "operation.started":
    case "operation.resolved":
    case "operation.requested":
      nextFeed = applyOperationEvent(nextFeed, event);
      break;
    case "runtime.status":
      nextFeed = applyRuntimeStatusEvent(nextFeed, event);
      break;
    case "turn.step.started":
    case "turn.step.completed":
    case "turn.step.interrupted":
      nextFeed = applyTurnStepEvent(nextFeed, event);
      break;
    case "turn.canceled":
      {
        const result = applyTurnCanceledEvent(
          clearPendingPermissionEntriesForTurn(nextFeed, event),
          event,
          nextPendingInterrupt,
        );
        nextFeed = result.feed;
        nextPendingInterrupt = result.pendingInterrupt;
      }
      break;
    case "turn.failed":
      nextFeed = clearPendingPermissionEntriesForTurn(nextFeed, event);
      break;
    case "turn.completed":
      nextFeed = clearPendingPermissionEntriesForTurn(nextFeed, event);
      break;
    case "notification.emitted":
      nextFeed = applyNotificationEvent(nextFeed, event);
      break;
    default:
      break;
  }

  const nextRuntimeStatus = nextRuntimeStatusForEvent(current, nextSummary, event);
  return {
    summary: nextSummary,
    feed: nextFeed,
    events: [...current.events.slice(-199), event],
    lastSeq: event.seq,
    ...(nextRuntimeStatus !== undefined ? { currentRuntimeStatus: nextRuntimeStatus } : {}),
    history: current.history,
    ...(nextPendingInterrupt !== undefined ? { pendingInterrupt: nextPendingInterrupt } : {}),
  };
}

export function sortFeed(feed: FeedEntry[]): FeedEntry[] {
  return [...feed].sort((a, b) => {
    const byTs = a.ts.localeCompare(b.ts);
    if (byTs !== 0) {
      return byTs;
    }
    return a.key.localeCompare(b.key);
  });
}

export function appendOptimisticUserMessage(
  current: SessionProjection,
  text: string,
  options?: { clientMessageId?: string; clientTurnId?: string },
): SessionProjection {
  const ts = new Date().toISOString();
  const key = options?.clientMessageId
    ? `optimistic:user:${options.clientMessageId}`
    : `optimistic:user:${ts}:${Math.random().toString(36).slice(2, 10)}`;
  const item: Extract<TimelineItem, { kind: "user_message" }> = {
    kind: "user_message",
    text,
    ...(options?.clientMessageId !== undefined ? { clientMessageId: options.clientMessageId } : {}),
    ...(options?.clientTurnId !== undefined ? { clientTurnId: options.clientTurnId } : {}),
  };
  return {
    ...current,
    feed: [
      ...current.feed,
      {
        key,
        kind: "timeline",
        item,
        ts,
      },
    ],
  };
}

export function removeOptimisticUserMessage(
  current: SessionProjection,
  text: string,
  clientMessageId?: string,
): SessionProjection {
  const feed = current.feed.filter(
    (entry) =>
      !(
        entry.kind === "timeline" &&
        entry.key.startsWith("optimistic:user:") &&
        entry.item.kind === "user_message" &&
        (clientMessageId !== undefined
          ? entry.item.clientMessageId === clientMessageId
          : entry.item.text === text)
      ),
  );
  if (feed.length === current.feed.length) {
    return current;
  }
  return {
    ...current,
    feed,
  };
}

export function providerLabel(provider: ManagedSession["provider"]): string {
  switch (provider) {
    case "codex":
      return "Codex";
    case "claude":
      return "Claude";
    case "gemini":
      return "Gemini";
    case "opencode":
      return "OpenCode";
    case "custom":
      return "Custom";
  }
}

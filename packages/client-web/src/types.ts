import type {
  AttentionItem,
  ListSessionsResponse,
  ManagedSession,
  MessagePartRef,
  PermissionRequest,
  PermissionResolution,
  RahEvent,
  RuntimeOperation,
  SessionSummary,
  TimelineItem,
  ToolCallArtifact,
  ToolCall,
  ToolCallDetail,
  WorkbenchObservation,
} from "@rah/runtime-protocol";

export type SessionsResponse = ListSessionsResponse;

export type FeedEntry =
  | {
      key: string;
      kind: "timeline";
      item: TimelineItem;
      ts: string;
      turnId?: string;
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
      kind: "attention";
      item: AttentionItem;
      ts: string;
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
    };

export interface SessionProjection {
  summary: SessionSummary;
  feed: FeedEntry[];
  events: RahEvent[];
  lastSeq: number;
  currentRuntimeStatus?: Extract<RahEvent, { type: "runtime.status" }>["payload"]["status"];
  history: HistorySyncState;
}

export interface HistorySyncState {
  phase: "idle" | "loading" | "ready" | "error";
  nextBeforeTs: string | null;
  generation: number;
  authoritativeApplied: boolean;
  lastError: string | null;
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
    case "permission.requested":
    case "permission.resolved":
    case "control.claimed":
    case "control.released":
    case "usage.updated":
    case "context.updated":
      return isIsoTsAtLeast(event.ts, current.summary.session.updatedAt);
    default:
      return true;
  }
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
  const messageId = readTimelineMessageId(event.payload.item);
  if (messageId) {
    const messageIndex = feed.findIndex(
      (candidate) =>
        candidate.kind === "timeline" &&
        candidate.item.kind === event.payload.item.kind &&
        readTimelineMessageId(candidate.item) === messageId,
    );
    if (messageIndex >= 0) {
      const next = [...feed];
      const current = next[messageIndex] as Extract<FeedEntry, { kind: "timeline" }>;
      const item =
        canMergeTimelineText(current.item, event.payload.item)
          ? {
              ...event.payload.item,
              text: mergeTimelineText(
                current.item as MergeableTimelineItem,
                event.payload.item as MergeableTimelineItem,
              ),
            }
          : event.payload.item;
      next[messageIndex] = createTimelineEntry(
        {
          key: current.key,
          kind: "timeline",
          item,
          ts: event.ts,
        },
        event.turnId ?? current.turnId,
      );
      return next;
    }
  }

  if (event.type === "timeline.item.added" && hasTimelineText(event.payload.item)) {
    const incomingItem = event.payload.item;
    const duplicateIndex = feed.findIndex(
      (candidate) =>
        candidate.kind === "timeline" &&
        candidate.item.kind === incomingItem.kind &&
        hasTimelineText(candidate.item) &&
        candidate.item.text === incomingItem.text &&
        isTimelineMetadataUpgrade(candidate, event),
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
        },
        event.turnId ?? duplicate.turnId,
      );
      return next;
    }
  }

  if (event.type === "timeline.item.added" && event.payload.item.kind === "user_message") {
    const incomingUserItem = event.payload.item;
    const duplicateIndex = feed.findIndex(
      (candidate) =>
        candidate.kind === "timeline" &&
        candidate.item.kind === "user_message" &&
        candidate.item.text === incomingUserItem.text &&
        (candidate.turnId === undefined || candidate.turnId === event.turnId),
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
        },
        event.turnId ?? duplicate.turnId,
      );
      return next;
    }
  }

  const latestEntry = feed.at(-1);
  if (
    event.type === "timeline.item.added" &&
    latestEntry?.kind === "timeline" &&
    latestEntry.turnId === event.turnId &&
    canMergeTimelineText(latestEntry.item, event.payload.item)
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
      },
      ts: event.ts,
    };
    return next;
  }

  const key = `${event.turnId ?? "session"}:${event.payload.item.kind}:${event.seq}`;
  const entry = createTimelineEntry(
    {
      key,
      kind: "timeline",
      item: event.payload.item,
      ts: event.ts,
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
  return [...feed, entry];
}

function hasTimelineText(
  item: TimelineItem,
): item is Extract<TimelineItem, { text: string }> {
  return (
    item.kind === "user_message" ||
    item.kind === "assistant_message" ||
    item.kind === "reasoning"
  );
}

function isTimelineMetadataUpgrade(
  candidate: Extract<FeedEntry, { kind: "timeline" }>,
  event: Extract<RahEvent, { type: "timeline.item.added" | "timeline.item.updated" }>,
): boolean {
  if (!hasTimelineText(candidate.item) || !hasTimelineText(event.payload.item)) {
    return false;
  }
  const candidateMessageId = readTimelineMessageId(candidate.item);
  const eventMessageId = readTimelineMessageId(event.payload.item);
  const hasUpgradedIdentity =
    (candidate.turnId === undefined && event.turnId !== undefined) ||
    (candidateMessageId === undefined && eventMessageId !== undefined);
  if (hasUpgradedIdentity) {
    return true;
  }
  return candidate.turnId !== undefined && candidate.turnId === event.turnId;
}

function readTimelineMessageId(item: TimelineItem): string | undefined {
  if (item.kind === "user_message" || item.kind === "assistant_message") {
    return item.messageId;
  }
  return undefined;
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
    const next = createToolCallEntry(
      {
      key: `tool:${event.payload.toolCall.id}`,
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
      ? event.payload.toolCall
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
): FeedEntry[] {
  if (event.type === "permission.requested") {
    return [
      ...feed,
      createPermissionEntry(
        {
          key: `perm:${event.payload.request.id}`,
          kind: "permission",
          request: event.payload.request,
          ts: event.ts,
        },
        event.turnId,
      ),
    ];
  }

  const key = `perm:${event.payload.resolution.requestId}`;
  const index = feed.findIndex(
    (candidate) => candidate.kind === "permission" && candidate.key === key,
  );
  if (index < 0) {
    return feed;
  }
  const current = feed[index];
  if (!current || current.kind !== "permission") {
    return feed;
  }
  const next = [...feed];
  next[index] = createPermissionEntry({
    key: current.key,
    kind: "permission",
    request: current.request,
    resolution: event.payload.resolution,
    ts: event.ts,
  }, current.turnId);
  return next;
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

function applyAttentionEvent(
  feed: FeedEntry[],
  event: Extract<RahEvent, { type: "attention.required" }>,
): FeedEntry[] {
  const key = `attention:${event.payload.item.id}`;
  const next = feed.filter(
    (candidate) => candidate.kind !== "attention" || candidate.key !== key,
  );
  next.push({
    key,
    kind: "attention",
    item: event.payload.item,
    ts: event.ts,
  });
  return next;
}

function applyAttentionClearedEvent(
  feed: FeedEntry[],
  event: Extract<RahEvent, { type: "attention.cleared" }>,
): FeedEntry[] {
  const key = `attention:${event.payload.id}`;
  return feed.filter((candidate) => candidate.kind !== "attention" || candidate.key !== key);
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
  if (event.payload.status !== "retrying" && event.payload.status !== "error") {
    return feed;
  }
  const key = `${event.turnId ?? "session"}:runtime:${event.payload.status}`;
  const entry = createRuntimeStatusEntry(
    {
      key,
      kind: "runtime_status",
      status: event.payload.status,
      ...(event.payload.detail !== undefined ? { detail: event.payload.detail } : {}),
      ...(event.payload.retryCount !== undefined ? { retryCount: event.payload.retryCount } : {}),
      ts: event.ts,
    },
    event.turnId,
  );
  const index = feed.findIndex(
    (candidate) => candidate.kind === "runtime_status" && candidate.key === key,
  );
  if (index < 0) {
    return [...feed, entry];
  }
  const next = [...feed];
  next[index] = entry;
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

export function applyEventToProjection(
  current: SessionProjection,
  event: RahEvent,
): SessionProjection {
  if (event.seq <= current.lastSeq) {
    return current;
  }

  const permissionRequestedState: ManagedSession["runtimeState"] = "waiting_permission";
  const permissionResolvedState: ManagedSession["runtimeState"] = "running";
  const canMutateSummary = shouldApplySummaryMutation(current, event);

  const nextSummary =
    !canMutateSummary
      ? current.summary
      : event.type === "session.started"
      ? { ...current.summary, session: event.payload.session }
      : event.type === "session.state.changed"
        ? {
            ...current.summary,
            session: {
              ...current.summary.session,
              runtimeState: event.payload.state,
              updatedAt: event.ts,
            },
          }
        : event.type === "permission.requested"
          ? {
              ...current.summary,
              session: {
                ...current.summary.session,
                runtimeState: permissionRequestedState,
                updatedAt: event.ts,
              },
            }
          : event.type === "permission.resolved"
            ? {
                ...current.summary,
                session: {
                  ...current.summary.session,
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
            : event.type === "usage.updated" || event.type === "context.updated"
              ? {
                  ...current.summary,
                  usage: event.payload.usage,
                }
              : current.summary;

  let nextFeed = current.feed;
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
      nextFeed = applyPermissionEvent(nextFeed, event);
      break;
    case "attention.required":
      nextFeed = applyAttentionEvent(nextFeed, event);
      break;
    case "attention.cleared":
      nextFeed = applyAttentionClearedEvent(nextFeed, event);
      break;
    case "operation.started":
    case "operation.resolved":
    case "operation.requested":
      nextFeed = applyOperationEvent(nextFeed, event);
      break;
    case "runtime.status":
      nextFeed = applyRuntimeStatusEvent(nextFeed, event);
      break;
    case "notification.emitted":
      nextFeed = applyNotificationEvent(nextFeed, event);
      break;
    default:
      break;
  }

  return {
    summary: nextSummary,
    feed: nextFeed,
    events: [...current.events.slice(-199), event],
    lastSeq: event.seq,
    ...(event.type === "runtime.status"
      ? { currentRuntimeStatus: event.payload.status }
      : event.type === "session.state.changed"
        ? event.payload.state === "running"
          ? current.currentRuntimeStatus !== undefined
            ? { currentRuntimeStatus: current.currentRuntimeStatus }
            : {}
          : {}
        : event.type === "session.failed" ||
            event.type === "turn.completed" ||
            event.type === "turn.failed" ||
            event.type === "turn.canceled"
          ? {}
        : current.currentRuntimeStatus !== undefined
          ? { currentRuntimeStatus: current.currentRuntimeStatus }
          : {}),
    history: current.history,
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
): SessionProjection {
  const ts = new Date().toISOString();
  return {
    ...current,
    feed: [
      ...current.feed,
      {
        key: `optimistic:user:${ts}:${Math.random().toString(36).slice(2, 10)}`,
        kind: "timeline",
        item: { kind: "user_message", text },
        ts,
      },
    ],
  };
}

export function providerLabel(provider: ManagedSession["provider"]): string {
  switch (provider) {
    case "codex":
      return "Codex";
    case "claude":
      return "Claude";
    case "kimi":
      return "Kimi";
    case "gemini":
      return "Gemini";
    case "opencode":
      return "OpenCode";
    case "custom":
      return "Custom";
  }
}

import type {
  ConversationItemProjection,
  ConversationItemRole,
  ConversationItemStatus,
  ConversationProjectionSource,
  ConversationTurnProjection,
  ConversationTurnStatus,
  EventSource,
  ProviderKind,
  RahEvent,
  TimelineIdentity,
  TimelineItem,
  TimelineTurnIdentity,
} from "@rah/runtime-protocol";
import { stableTimelineHash } from "./timeline-identity";

export interface MutableConversationTurn {
  projection: ConversationTurnProjection;
  items: Map<string, ConversationItemProjection>;
  itemOrder: Map<string, number>;
  firstSequence: number;
}

export function providerFromSource(source: EventSource): ProviderKind | undefined {
  return source.provider === "system" ? undefined : source.provider;
}

export function projectionSource(
  source: EventSource,
  identity?: TimelineIdentity | TimelineTurnIdentity,
): ConversationProjectionSource | undefined {
  const provider = providerFromSource(source);
  if (!provider) {
    return undefined;
  }
  return {
    provider,
    channel: source.channel,
    authority: source.authority,
    ...(identity ? { identityConfidence: identity.confidence } : {}),
  };
}

export function fallbackTurnId(args: {
  sessionId: string;
  provider: ProviderKind;
  providerTurnId?: string;
  eventId: string;
}): string {
  return stableTimelineHash([
    "rah.conversation.turn.v2",
    args.provider,
    args.sessionId,
    args.providerTurnId ?? `event:${args.eventId}`,
  ]);
}

export function fallbackItemId(args: {
  provider: ProviderKind;
  sessionId: string;
  turnId: string;
  kind: string;
  providerItemId?: string;
  eventId: string;
}): string {
  return stableTimelineHash([
    "rah.conversation.item.v2",
    args.provider,
    args.sessionId,
    args.turnId,
    args.kind,
    args.providerItemId ?? `event:${args.eventId}`,
  ]);
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

export function sourceStatusAuthority(source: EventSource): "native" | "derived" {
  return source.authority === "authoritative" ? "native" : "derived";
}

export function timelineRole(item: TimelineItem): ConversationItemRole {
  switch (item.kind) {
    case "user_message":
      return "user";
    case "assistant_message":
      return item.phase === "final_answer" ? "final" : "process";
    case "system":
      return "system";
    default:
      return "process";
  }
}

export function timelineStatus(item: TimelineItem): ConversationItemStatus {
  switch (item.kind) {
    case "error":
      return "failed";
    case "step":
      return item.status === "started"
        ? "running"
        : item.status === "interrupted"
          ? "interrupted"
          : "completed";
    case "compaction":
      return item.status === "started" ? "running" : "completed";
    default:
      return "completed";
  }
}

export function observationStatus(status: string): ConversationItemStatus {
  switch (status) {
    case "running":
      return "running";
    case "failed":
      return "failed";
    case "canceled":
      return "interrupted";
    default:
      return "completed";
  }
}

export function turnIdentity(event: RahEvent): TimelineTurnIdentity | TimelineIdentity | undefined {
  switch (event.type) {
    case "turn.started":
    case "turn.completed":
    case "turn.failed":
    case "turn.canceled":
      return event.payload.identity;
    case "timeline.item.added":
    case "timeline.item.updated":
      return event.payload.identity;
    default:
      return undefined;
  }
}

export function mergeTurn(
  target: MutableConversationTurn,
  source: MutableConversationTurn,
): MutableConversationTurn {
  for (const [itemId, item] of source.items) {
    if (!target.items.has(itemId)) {
      target.items.set(itemId, { ...item, turnId: target.projection.id });
      target.itemOrder.set(itemId, source.itemOrder.get(itemId) ?? source.firstSequence);
    }
  }
  const targetStartedAt = target.projection.startedAt;
  const sourceStartedAt = source.projection.startedAt;
  if (sourceStartedAt && (!targetStartedAt || sourceStartedAt < targetStartedAt)) {
    target.projection.startedAt = sourceStartedAt;
  }
  if (!target.projection.providerTurnId && source.projection.providerTurnId) {
    target.projection.providerTurnId = source.projection.providerTurnId;
  }
  if (target.projection.status === "in_progress" && source.projection.status !== "in_progress") {
    target.projection.status = source.projection.status;
    target.projection.statusAuthority = source.projection.statusAuthority;
    if (source.projection.completedAt) {
      target.projection.completedAt = source.projection.completedAt;
    }
    if (source.projection.durationMs !== undefined) {
      target.projection.durationMs = source.projection.durationMs;
    }
    if (source.projection.usage) {
      target.projection.usage = source.projection.usage;
    }
    if (source.projection.error) {
      target.projection.error = source.projection.error;
    }
  }
  target.projection.revision = Math.max(target.projection.revision, source.projection.revision);
  target.firstSequence = Math.min(target.firstSequence, source.firstSequence);
  return target;
}

export function orderedItems(turn: MutableConversationTurn): ConversationItemProjection[] {
  return [...turn.items.values()].sort((left, right) => {
    const orderDelta =
      (turn.itemOrder.get(left.id) ?? Number.MAX_SAFE_INTEGER) -
      (turn.itemOrder.get(right.id) ?? Number.MAX_SAFE_INTEGER);
    return orderDelta || left.id.localeCompare(right.id);
  });
}

export function chooseFinalAnswer(turn: MutableConversationTurn) {
  const items = orderedItems(turn);
  const explicit = [...items]
    .reverse()
    .find(
      (item) =>
        item.content.kind === "timeline" &&
        item.content.item.kind === "assistant_message" &&
        item.content.item.phase === "final_answer",
    );
  const candidate =
    explicit ??
    [...items]
      .reverse()
      .find(
        (item) =>
          item.content.kind === "timeline" &&
          item.content.item.kind === "assistant_message" &&
          item.content.item.phase !== "commentary",
      );
  if (!candidate) {
    return;
  }
  const previousFinalId = turn.projection.finalAnswerItemId;
  if (previousFinalId && previousFinalId !== candidate.id) {
    const previous = turn.items.get(previousFinalId);
    if (previous) {
      previous.role = "process";
    }
  }
  candidate.role = "final";
  turn.projection.finalAnswerItemId = candidate.id;
}

export function closeTurn(
  turn: MutableConversationTurn,
  status: ConversationTurnStatus,
  completedAt: string,
  authority: "native" | "derived",
) {
  turn.projection.status = status;
  turn.projection.statusAuthority = authority;
  turn.projection.completedAt = completedAt;
  const derivedDuration = durationBetween(turn.projection.startedAt, completedAt);
  if (turn.projection.durationMs === undefined && derivedDuration !== undefined) {
    turn.projection.durationMs = derivedDuration;
  }
  const itemStatus =
    status === "completed"
      ? "completed"
      : status === "interrupted"
        ? "interrupted"
        : "failed";
  for (const item of turn.items.values()) {
    if (item.status !== "pending" && item.status !== "running") {
      continue;
    }
    item.status = itemStatus;
    item.completedAt = completedAt;
    const itemDuration = durationBetween(item.startedAt, completedAt);
    if (item.durationMs === undefined && itemDuration !== undefined) {
      item.durationMs = itemDuration;
    }
  }
  if (status === "completed") {
    chooseFinalAnswer(turn);
  }
}

export function upsertItem(
  turn: MutableConversationTurn,
  item: ConversationItemProjection,
  sequence: number,
) {
  const existing = turn.items.get(item.id);
  const existingIsTerminal =
    existing?.status === "completed" ||
    existing?.status === "failed" ||
    existing?.status === "interrupted";
  const incomingIsOpen = item.status === "pending" || item.status === "running";
  if (existing && existingIsTerminal && incomingIsOpen) {
    existing.revision = Math.max(existing.revision, item.revision);
    turn.projection.revision = Math.max(turn.projection.revision, item.revision);
    return;
  }
  const merged: ConversationItemProjection = {
    ...existing,
    ...item,
  };
  const startedAt = existing?.startedAt ?? item.startedAt;
  if (startedAt !== undefined) {
    merged.startedAt = startedAt;
  }
  turn.items.set(item.id, merged);
  if (!turn.itemOrder.has(item.id)) {
    turn.itemOrder.set(item.id, sequence);
  }
  turn.projection.revision = Math.max(turn.projection.revision, item.revision);
}

import type {
  ConversationItemContent,
  ConversationItemProjection,
  ConversationProjection,
  ConversationTurnProjection,
  RahEvent,
} from "@rah/runtime-protocol";
import { summarizeConversationActivities } from "@rah/runtime-protocol";
import {
  chooseFinalAnswer,
  closeTurn,
  deriveCanonicalItemId,
  deriveCanonicalTurnId,
  mergeTurn,
  observationStatus,
  orderedItems,
  projectionSource,
  providerFromSource,
  sourceStatusAuthority,
  timelineRole,
  timelineStatus,
  turnIdentity,
  upsertItem,
  type MutableConversationTurn as MutableTurn,
} from "./conversation-projector-internal";
import type { ProjectConversationOptions } from "./conversation-projector";
import { projectConversationTurnResources } from "./conversation-resource-projector";

type TouchedItems = Set<string> | null;

/**
 * `null` means that turn lifecycle or identity changed and every item must be
 * compared. An empty set means metadata-only; a populated set names the only
 * items that can have changed.
 */
export interface IncrementalConversationProjectorChange {
  turns: ReadonlyMap<string, TouchedItems>;
  removedTurnIds: readonly string[];
}

class ChangeRecorder {
  readonly turns = new Map<string, TouchedItems>();
  readonly removedTurnIds = new Set<string>();

  touchMetadata(turnId: string): void {
    if (!this.turns.has(turnId)) {
      this.turns.set(turnId, new Set());
    }
  }

  touchItem(turnId: string, itemId: string): void {
    const touched = this.turns.get(turnId);
    if (touched === null) {
      return;
    }
    const items = touched ?? new Set<string>();
    items.add(itemId);
    this.turns.set(turnId, items);
  }

  touchAll(turnId: string): void {
    this.turns.set(turnId, null);
  }

  remove(turnId: string): void {
    this.removedTurnIds.add(turnId);
  }

  result(): IncrementalConversationProjectorChange {
    return {
      turns: this.turns,
      removedTurnIds: [...this.removedTurnIds],
    };
  }
}

/**
 * Events carried by the canonical event bus include both semantic control
 * state and high-volume data-plane traffic. Only these events can affect a
 * ConversationProjection. In particular, process output and message-part
 * deltas are deliberately excluded: they have their own bounded stores and
 * must never trigger conversation reconstruction.
 */
export function isConversationProjectionEvent(event: RahEvent): boolean {
  switch (event.type) {
    case "turn.started":
    case "turn.completed":
    case "turn.failed":
    case "turn.canceled":
    case "turn.file_changes.updated":
    case "timeline.item.added":
    case "timeline.item.updated":
    case "tool.call.started":
    case "tool.call.completed":
    case "tool.call.failed":
    case "observation.started":
    case "observation.updated":
    case "observation.completed":
    case "observation.failed":
    case "permission.requested":
    case "permission.resolved":
    case "operation.started":
    case "operation.requested":
    case "operation.resolved":
      return true;
    default:
      return false;
  }
}

function cloneProjectedItem(item: ConversationItemProjection): ConversationItemProjection {
  return { ...item };
}

function projectedTurn(turn: MutableTurn): ConversationTurnProjection {
  if (turn.projection.status === "completed") {
    chooseFinalAnswer(turn);
  }
  const items = orderedItems(turn);
  const resources = projectConversationTurnResources(items);
  const {
    items: _items,
    activities: _activities,
    outputs: _outputs,
    sources: _sources,
    failedItemCount: _failedItemCount,
    ...base
  } = turn.projection;
  return {
    ...base,
    items: items.map(cloneProjectedItem),
    activities: summarizeConversationActivities(items),
    ...(resources.outputs.length > 0 ? { outputs: resources.outputs } : {}),
    ...(resources.sources.length > 0 ? { sources: resources.sources } : {}),
    failedItemCount: items.filter((item) => item.status === "failed").length,
  };
}

/**
 * Stateful reducer for the provider-neutral conversation protocol.
 *
 * The historical projector feeds this reducer a sorted frozen event page.
 * The resident live store keeps one reducer per session and applies exactly
 * one semantic event at a time. This makes live work proportional to the turn
 * and item that changed instead of replaying the recent event window for every
 * provider notification.
 */
export class IncrementalConversationProjector {
  private readonly turns = new Map<string, MutableTurn>();
  private readonly providerTurnIds = new Map<string, string>();
  private lastClaudeTurnId: string | undefined;
  private revision = 0;
  private sourceEventCount = 0;

  constructor(readonly sessionId: string) {}

  apply(event: RahEvent): IncrementalConversationProjectorChange {
    const changes = new ChangeRecorder();
    if (event.sessionId !== this.sessionId) {
      return changes.result();
    }
    this.sourceEventCount += 1;
    this.revision = Math.max(this.revision, event.seq);
    if (!isConversationProjectionEvent(event)) {
      return changes.result();
    }

    const provider = providerFromSource(event.source);
    if (event.type === "turn.started" && provider === "claude") {
      const nextTurn = this.resolveTurn(event, changes);
      if (
        this.lastClaudeTurnId &&
        nextTurn &&
        this.lastClaudeTurnId !== nextTurn.projection.id
      ) {
        const previous = this.turns.get(this.lastClaudeTurnId);
        if (
          previous?.projection.status === "in_progress" &&
          [...previous.items.values()].some(
            (item) =>
              item.content.kind === "timeline" &&
              item.content.item.kind === "assistant_message",
          )
        ) {
          closeTurn(previous, "completed", event.ts, "derived");
          changes.touchAll(previous.projection.id);
        }
      }
      if (nextTurn) {
        this.lastClaudeTurnId = nextTurn.projection.id;
      }
    }

    const turn = this.resolveTurn(event, changes);
    const identity = turnIdentity(event);
    const source = projectionSource(event.source, identity);
    if (!turn || !source || !provider) {
      return changes.result();
    }

    switch (event.type) {
      case "turn.started": {
        if (turn.projection.status === "in_progress") {
          turn.projection.statusAuthority = sourceStatusAuthority(event.source);
          turn.projection.startedAt =
            event.payload.startedAt ?? turn.projection.startedAt ?? event.ts;
        }
        changes.touchMetadata(turn.projection.id);
        break;
      }
      case "turn.completed": {
        if (event.payload.usage !== undefined) {
          turn.projection.usage = event.payload.usage;
        }
        if (event.payload.durationMs !== undefined) {
          turn.projection.durationMs = event.payload.durationMs;
        }
        closeTurn(
          turn,
          "completed",
          event.payload.completedAt ?? event.ts,
          sourceStatusAuthority(event.source),
        );
        changes.touchAll(turn.projection.id);
        break;
      }
      case "turn.failed": {
        turn.projection.error = {
          message: event.payload.error,
          ...(event.payload.code ? { code: event.payload.code } : {}),
        };
        if (event.payload.durationMs !== undefined) {
          turn.projection.durationMs = event.payload.durationMs;
        }
        closeTurn(
          turn,
          "failed",
          event.payload.completedAt ?? event.ts,
          sourceStatusAuthority(event.source),
        );
        changes.touchAll(turn.projection.id);
        break;
      }
      case "turn.canceled": {
        turn.projection.error = { message: event.payload.reason };
        if (event.payload.durationMs !== undefined) {
          turn.projection.durationMs = event.payload.durationMs;
        }
        closeTurn(
          turn,
          "interrupted",
          event.payload.completedAt ?? event.ts,
          sourceStatusAuthority(event.source),
        );
        changes.touchAll(turn.projection.id);
        break;
      }
      case "turn.file_changes.updated": {
        turn.projection.fileChanges = event.payload.fileChanges;
        changes.touchMetadata(turn.projection.id);
        break;
      }
      case "timeline.item.added":
      case "timeline.item.updated": {
        const itemIdentity = event.payload.identity;
        const timeline = event.payload.item;
        const providerItemId =
          itemIdentity?.itemKey ??
          ("messageId" in timeline ? timeline.messageId : undefined);
        const itemId =
          itemIdentity?.canonicalItemId ??
          deriveCanonicalItemId({
            provider,
            sessionId: this.sessionId,
            turnId: turn.projection.id,
            kind: `timeline:${timeline.kind}`,
            ...(providerItemId ? { providerItemId } : {}),
            eventId: event.id,
          });
        const role = timelineRole(timeline);
        const existingTimeline = turn.items.get(itemId)?.content;
        const mergedTimeline =
          existingTimeline?.kind === "timeline" &&
          existingTimeline.item.kind === timeline.kind
            ? { ...existingTimeline.item, ...timeline }
            : timeline;
        if (role === "final" && turn.projection.finalAnswerItemId !== itemId) {
          const previousFinalItemId = turn.projection.finalAnswerItemId;
          const previous = previousFinalItemId
            ? turn.items.get(previousFinalItemId)
            : undefined;
          if (previous) {
            previous.role = "process";
            changes.touchItem(turn.projection.id, previous.id);
          }
          turn.projection.finalAnswerItemId = itemId;
        }
        upsertItem(
          turn,
          {
            id: itemId,
            turnId: turn.projection.id,
            ...(providerItemId ? { providerItemId } : {}),
            role,
            status: timelineStatus(timeline),
            startedAt: event.ts,
            completedAt: event.ts,
            content: { kind: "timeline", item: mergedTimeline },
            source: projectionSource(event.source, itemIdentity) ?? source,
            revision: event.seq,
          },
          event.seq,
        );
        changes.touchItem(turn.projection.id, itemId);
        break;
      }
      case "tool.call.started":
      case "tool.call.completed": {
        const toolCall = event.payload.toolCall;
        const itemId = deriveCanonicalItemId({
          provider,
          sessionId: this.sessionId,
          turnId: turn.projection.id,
          kind: "call",
          providerItemId: toolCall.id,
          eventId: event.id,
        });
        const existing = turn.items.get(itemId);
        if (existing?.content.kind === "observation") {
          break;
        }
        const completed = event.type === "tool.call.completed";
        upsertItem(
          turn,
          {
            id: itemId,
            turnId: turn.projection.id,
            providerItemId: toolCall.id,
            role: "process",
            status: completed ? "completed" : "running",
            startedAt: existing?.startedAt ?? event.ts,
            ...(completed ? { completedAt: event.ts } : {}),
            content: { kind: "tool", toolCall },
            source,
            ...(toolCall.detailAvailable !== undefined
              ? { detailAvailable: toolCall.detailAvailable }
              : {}),
            revision: event.seq,
          },
          event.seq,
        );
        changes.touchItem(turn.projection.id, itemId);
        break;
      }
      case "tool.call.failed": {
        const itemId = deriveCanonicalItemId({
          provider,
          sessionId: this.sessionId,
          turnId: turn.projection.id,
          kind: "call",
          providerItemId: event.payload.toolCallId,
          eventId: event.id,
        });
        const existing = turn.items.get(itemId);
        if (existing?.content.kind === "observation") {
          break;
        }
        const toolCall =
          existing?.content.kind === "tool"
            ? existing.content.toolCall
            : {
                id: event.payload.toolCallId,
                family: "other" as const,
                providerToolName: "unknown",
              };
        upsertItem(
          turn,
          {
            id: itemId,
            turnId: turn.projection.id,
            providerItemId: event.payload.toolCallId,
            role: "process",
            status: "failed",
            startedAt: existing?.startedAt ?? event.ts,
            completedAt: event.ts,
            content: { kind: "tool", toolCall, error: event.payload.error },
            source,
            revision: event.seq,
          },
          event.seq,
        );
        changes.touchItem(turn.projection.id, itemId);
        break;
      }
      case "observation.started":
      case "observation.updated":
      case "observation.completed":
      case "observation.failed": {
        const observation = event.payload.observation;
        const providerItemId =
          observation.subject?.providerCallId ?? observation.id;
        const itemId = deriveCanonicalItemId({
          provider,
          sessionId: this.sessionId,
          turnId: turn.projection.id,
          kind: "call",
          providerItemId,
          eventId: event.id,
        });
        const existing = turn.items.get(itemId);
        const status = observationStatus(observation.status);
        const content: ConversationItemContent = {
          kind: "observation",
          observation,
          ...(event.type === "observation.failed" && event.payload.error
            ? { error: event.payload.error }
            : {}),
        };
        upsertItem(
          turn,
          {
            id: itemId,
            turnId: turn.projection.id,
            providerItemId,
            role: "process",
            status,
            startedAt: existing?.startedAt ?? event.ts,
            ...(status === "completed" ||
            status === "failed" ||
            status === "interrupted"
              ? { completedAt: event.ts }
              : {}),
            ...(observation.durationMs !== undefined
              ? { durationMs: observation.durationMs }
              : {}),
            content,
            source,
            ...(observation.detailAvailable !== undefined
              ? { detailAvailable: observation.detailAvailable }
              : {}),
            revision: event.seq,
          },
          event.seq,
        );
        changes.touchItem(turn.projection.id, itemId);
        break;
      }
      case "permission.requested":
      case "permission.resolved": {
        const requestId =
          event.type === "permission.requested"
            ? event.payload.request.id
            : event.payload.resolution.requestId;
        const itemId = deriveCanonicalItemId({
          provider,
          sessionId: this.sessionId,
          turnId: turn.projection.id,
          kind: "permission",
          providerItemId: requestId,
          eventId: event.id,
        });
        const existing = turn.items.get(itemId);
        const existingContent =
          existing?.content.kind === "permission"
            ? existing.content
            : undefined;
        upsertItem(
          turn,
          {
            id: itemId,
            turnId: turn.projection.id,
            providerItemId: requestId,
            role: "process",
            status:
              event.type === "permission.requested" ? "pending" : "completed",
            startedAt: existing?.startedAt ?? event.ts,
            ...(event.type === "permission.resolved"
              ? { completedAt: event.ts }
              : {}),
            content: {
              kind: "permission",
              ...existingContent,
              ...(event.type === "permission.requested"
                ? { request: event.payload.request }
                : { resolution: event.payload.resolution }),
            },
            source,
            revision: event.seq,
          },
          event.seq,
        );
        changes.touchItem(turn.projection.id, itemId);
        break;
      }
      case "operation.started":
      case "operation.requested":
      case "operation.resolved": {
        const operation = event.payload.operation;
        const itemId = deriveCanonicalItemId({
          provider,
          sessionId: this.sessionId,
          turnId: turn.projection.id,
          kind: "operation",
          providerItemId: operation.id,
          eventId: event.id,
        });
        const completed = event.type === "operation.resolved";
        const existing = turn.items.get(itemId);
        upsertItem(
          turn,
          {
            id: itemId,
            turnId: turn.projection.id,
            providerItemId: operation.id,
            role: "process",
            status: completed
              ? "completed"
              : event.type === "operation.requested"
                ? "pending"
                : "running",
            startedAt: existing?.startedAt ?? event.ts,
            ...(completed ? { completedAt: event.ts } : {}),
            ...(operation.durationMs !== undefined
              ? { durationMs: operation.durationMs }
              : {}),
            content: { kind: "operation", operation },
            source,
            revision: event.seq,
          },
          event.seq,
        );
        changes.touchItem(turn.projection.id, itemId);
        break;
      }
    }

    return changes.result();
  }

  projection(
    options: ProjectConversationOptions = {},
    turnIds?: ReadonlySet<string>,
  ): ConversationProjection {
    if (options.assumeSettled) {
      this.settle(options.generatedAt);
    }
    const projectedTurns = [...this.turns.values()]
      .filter((turn) => !turnIds || turnIds.has(turn.projection.id))
      .sort((left, right) => left.firstSequence - right.firstSequence)
      .map(projectedTurn);
    return {
      sessionId: this.sessionId,
      turns: projectedTurns,
      revision: this.revision,
      generatedAt: options.generatedAt ?? new Date().toISOString(),
      sourceEventCount: this.sourceEventCount,
      ...(options.partial ? { partial: true } : {}),
    };
  }

  /**
   * Bound resident live state without removing active turns. Persisted history
   * uses a short-lived projector and therefore never calls this method.
   */
  pruneCompletedTurns(maxTurns: number): readonly string[] {
    if (this.turns.size <= maxTurns) {
      return [];
    }
    let removeCount = this.turns.size - Math.max(1, maxTurns);
    const removed: string[] = [];
    for (const [turnId, turn] of this.turns) {
      if (removeCount <= 0) {
        break;
      }
      if (turn.projection.status === "in_progress") {
        continue;
      }
      this.turns.delete(turnId);
      removed.push(turnId);
      removeCount -= 1;
    }
    if (removed.length > 0) {
      const removedIds = new Set(removed);
      for (const [key, turnId] of this.providerTurnIds) {
        if (removedIds.has(turnId)) {
          this.providerTurnIds.delete(key);
        }
      }
      if (this.lastClaudeTurnId && removedIds.has(this.lastClaudeTurnId)) {
        this.lastClaudeTurnId = undefined;
      }
    }
    return removed;
  }

  private resolveTurn(
    event: RahEvent,
    changes: ChangeRecorder,
  ): MutableTurn | undefined {
    const provider = providerFromSource(event.source);
    if (!provider || !event.turnId) {
      return undefined;
    }
    const identity = turnIdentity(event);
    const providerTurnKey = `${provider}\0${event.turnId}`;
    const mappedId = this.providerTurnIds.get(providerTurnKey);
    const canonicalId =
      identity?.canonicalTurnId ??
      mappedId ??
      deriveCanonicalTurnId({
        sessionId: this.sessionId,
        provider,
        providerTurnId: event.turnId,
        eventId: event.id,
      });

    if (identity?.canonicalTurnId && mappedId && mappedId !== canonicalId) {
      const provisional = this.turns.get(mappedId);
      const canonical = this.turns.get(canonicalId);
      if (provisional && canonical) {
        mergeTurn(canonical, provisional);
        this.turns.delete(mappedId);
        changes.remove(mappedId);
        changes.touchAll(canonicalId);
      } else if (provisional) {
        this.turns.delete(mappedId);
        provisional.projection.id = canonicalId;
        for (const item of provisional.items.values()) {
          item.turnId = canonicalId;
        }
        this.turns.set(canonicalId, provisional);
        changes.remove(mappedId);
        changes.touchAll(canonicalId);
      }
    }
    this.providerTurnIds.set(providerTurnKey, canonicalId);

    let turn = this.turns.get(canonicalId);
    if (!turn) {
      turn = {
        projection: {
          id: canonicalId,
          provider,
          ...(identity?.providerSessionId
            ? { providerSessionId: identity.providerSessionId }
            : {}),
          providerTurnId: event.turnId,
          status: "in_progress",
          statusAuthority: sourceStatusAuthority(event.source),
          startedAt: event.ts,
          items: [],
          activities: [],
          failedItemCount: 0,
          ...(identity ? { identityConfidence: identity.confidence } : {}),
          revision: event.seq,
        },
        items: new Map(),
        itemOrder: new Map(),
        firstSequence: event.seq,
      };
      this.turns.set(canonicalId, turn);
    } else {
      turn.projection.providerTurnId ??= event.turnId;
      if (!turn.projection.providerSessionId && identity?.providerSessionId) {
        turn.projection.providerSessionId = identity.providerSessionId;
      }
      if (!turn.projection.identityConfidence && identity?.confidence) {
        turn.projection.identityConfidence = identity.confidence;
      }
      turn.projection.revision = Math.max(turn.projection.revision, event.seq);
    }
    return turn;
  }

  private settle(generatedAt?: string): void {
    for (const turn of this.turns.values()) {
      if (turn.projection.status !== "in_progress") {
        continue;
      }
      const hasAssistant = [...turn.items.values()].some(
        (item) =>
          item.content.kind === "timeline" &&
          item.content.item.kind === "assistant_message",
      );
      const hasUser = [...turn.items.values()].some(
        (item) =>
          item.content.kind === "timeline" &&
          item.content.item.kind === "user_message",
      );
      if (!hasAssistant && !hasUser) {
        continue;
      }
      const lastTimestamp =
        [...turn.items.values()]
          .map((item) => item.completedAt ?? item.startedAt)
          .filter((value): value is string => Boolean(value))
          .sort()
          .at(-1) ??
        turn.projection.startedAt ??
        generatedAt ??
        new Date().toISOString();
      closeTurn(
        turn,
        hasAssistant ? "completed" : "interrupted",
        lastTimestamp,
        "derived",
      );
    }
  }
}

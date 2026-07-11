import type {
  ConversationItemContent,
  ConversationProjection,
  ProviderKind,
  RahEvent,
} from "@rah/runtime-protocol";
import {
  chooseFinalAnswer,
  closeTurn,
  fallbackItemId,
  fallbackTurnId,
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

export interface ProjectConversationOptions {
  /**
   * The source is known to be quiescent (for example, a stopped Claude JSONL
   * session). This permits the final derived turn to close without inventing a
   * live completion event.
   */
  assumeSettled?: boolean;
  partial?: boolean;
  generatedAt?: string;
}

export function projectConversation(
  sessionId: string,
  inputEvents: readonly RahEvent[],
  options: ProjectConversationOptions = {},
): ConversationProjection {
  const events = [...inputEvents]
    .filter((event) => event.sessionId === sessionId)
    .sort((left, right) => left.seq - right.seq || left.ts.localeCompare(right.ts));
  const turns = new Map<string, MutableTurn>();
  const providerTurnIds = new Map<string, string>();
  let lastClaudeTurnId: string | undefined;
  let revision = 0;

  const resolveTurn = (event: RahEvent): MutableTurn | undefined => {
    const provider = providerFromSource(event.source);
    if (!provider || !event.turnId) {
      return undefined;
    }
    const identity = turnIdentity(event);
    // Projection is scoped to one RAH session, so provider turn ids are already
    // unambiguous here. Do not include providerSessionId: early lifecycle events
    // may not carry it, while a later native item identity does.
    const providerTurnKey = `${provider}\0${event.turnId}`;
    const mappedId = providerTurnIds.get(providerTurnKey);
    const canonicalId =
      identity?.canonicalTurnId ??
      mappedId ??
      fallbackTurnId({
        sessionId,
        provider,
        providerTurnId: event.turnId,
        eventId: event.id,
      });

    if (identity?.canonicalTurnId && mappedId && mappedId !== canonicalId) {
      const provisional = turns.get(mappedId);
      const canonical = turns.get(canonicalId);
      if (provisional && canonical) {
        mergeTurn(canonical, provisional);
        turns.delete(mappedId);
      } else if (provisional) {
        turns.delete(mappedId);
        provisional.projection.id = canonicalId;
        for (const item of provisional.items.values()) {
          item.turnId = canonicalId;
        }
        turns.set(canonicalId, provisional);
      }
    }
    providerTurnIds.set(providerTurnKey, canonicalId);

    let turn = turns.get(canonicalId);
    if (!turn) {
      turn = {
        projection: {
          id: canonicalId,
          provider,
          ...(identity?.providerSessionId ? { providerSessionId: identity.providerSessionId } : {}),
          providerTurnId: event.turnId,
          status: "in_progress",
          statusAuthority: sourceStatusAuthority(event.source),
          startedAt: event.ts,
          items: [],
          failedItemCount: 0,
          ...(identity ? { identityConfidence: identity.confidence } : {}),
          revision: event.seq,
        },
        items: new Map(),
        itemOrder: new Map(),
        firstSequence: event.seq,
      };
      turns.set(canonicalId, turn);
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
  };

  for (const event of events) {
    revision = Math.max(revision, event.seq);
    const provider = providerFromSource(event.source);
    const identity = turnIdentity(event);
    const source = projectionSource(event.source, identity);

    if (event.type === "turn.started" && provider === "claude") {
      const nextTurn = resolveTurn(event);
      if (lastClaudeTurnId && nextTurn && lastClaudeTurnId !== nextTurn.projection.id) {
        const previous = turns.get(lastClaudeTurnId);
        if (
          previous?.projection.status === "in_progress" &&
          [...previous.items.values()].some(
            (item) =>
              item.content.kind === "timeline" &&
              item.content.item.kind === "assistant_message",
          )
        ) {
          closeTurn(previous, "completed", event.ts, "derived");
        }
      }
      if (nextTurn) {
        lastClaudeTurnId = nextTurn.projection.id;
      }
    }

    const turn = resolveTurn(event);
    if (!turn || !source || !provider) {
      continue;
    }

    switch (event.type) {
      case "turn.started": {
        if (turn.projection.status === "in_progress") {
          turn.projection.statusAuthority = sourceStatusAuthority(event.source);
          turn.projection.startedAt = event.payload.startedAt ?? turn.projection.startedAt ?? event.ts;
        }
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
          fallbackItemId({
            provider,
            sessionId,
            turnId: turn.projection.id,
            kind: `timeline:${timeline.kind}`,
            ...(providerItemId ? { providerItemId } : {}),
            eventId: event.id,
          });
        const role = timelineRole(timeline);
        if (role === "final" && turn.projection.finalAnswerItemId !== itemId) {
          const previous = turn.projection.finalAnswerItemId
            ? turn.items.get(turn.projection.finalAnswerItemId)
            : undefined;
          if (previous) {
            previous.role = "process";
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
            content: { kind: "timeline", item: timeline },
            source: projectionSource(event.source, itemIdentity) ?? source,
            revision: event.seq,
          },
          event.seq,
        );
        break;
      }
      case "tool.call.started":
      case "tool.call.completed": {
        const toolCall = event.payload.toolCall;
        const itemId = fallbackItemId({
          provider,
          sessionId,
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
        break;
      }
      case "tool.call.failed": {
        const itemId = fallbackItemId({
          provider,
          sessionId,
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
        break;
      }
      case "observation.started":
      case "observation.updated":
      case "observation.completed":
      case "observation.failed": {
        const observation = event.payload.observation;
        const providerItemId = observation.subject?.providerCallId ?? observation.id;
        const itemId = fallbackItemId({
          provider,
          sessionId,
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
            ...(status === "completed" || status === "failed" || status === "interrupted"
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
        break;
      }
      case "permission.requested":
      case "permission.resolved": {
        const requestId =
          event.type === "permission.requested"
            ? event.payload.request.id
            : event.payload.resolution.requestId;
        const itemId = fallbackItemId({
          provider,
          sessionId,
          turnId: turn.projection.id,
          kind: "permission",
          providerItemId: requestId,
          eventId: event.id,
        });
        const existing = turn.items.get(itemId);
        const existingContent =
          existing?.content.kind === "permission" ? existing.content : undefined;
        upsertItem(
          turn,
          {
            id: itemId,
            turnId: turn.projection.id,
            providerItemId: requestId,
            role: "process",
            status: event.type === "permission.requested" ? "pending" : "completed",
            startedAt: existing?.startedAt ?? event.ts,
            ...(event.type === "permission.resolved" ? { completedAt: event.ts } : {}),
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
        break;
      }
      case "operation.started":
      case "operation.requested":
      case "operation.resolved": {
        const operation = event.payload.operation;
        const itemId = fallbackItemId({
          provider,
          sessionId,
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
            ...(operation.durationMs !== undefined ? { durationMs: operation.durationMs } : {}),
            content: { kind: "operation", operation },
            source,
            revision: event.seq,
          },
          event.seq,
        );
        break;
      }
      default:
        break;
    }
  }

  if (options.assumeSettled) {
    for (const turn of turns.values()) {
      if (
        turn.projection.status !== "in_progress" ||
        ![...turn.items.values()].some(
          (item) =>
            item.content.kind === "timeline" &&
            item.content.item.kind === "assistant_message",
        )
      ) {
        continue;
      }
      const lastTimestamp =
        [...turn.items.values()]
          .map((item) => item.completedAt ?? item.startedAt)
          .filter((value): value is string => Boolean(value))
          .sort()
          .at(-1) ?? turn.projection.startedAt ?? options.generatedAt ?? new Date().toISOString();
      closeTurn(turn, "completed", lastTimestamp, "derived");
    }
  }

  const projectedTurns = [...turns.values()]
    .sort((left, right) => left.firstSequence - right.firstSequence)
    .map((turn) => {
      if (turn.projection.status === "completed") {
        chooseFinalAnswer(turn);
      }
      const items = orderedItems(turn);
      turn.projection.items = items;
      turn.projection.failedItemCount = items.filter((item) => item.status === "failed").length;
      return turn.projection;
    });

  return {
    sessionId,
    turns: projectedTurns,
    revision,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    sourceEventCount: events.length,
    ...(options.partial ? { partial: true } : {}),
  };
}

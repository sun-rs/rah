import type { RahEvent } from "@rah/runtime-protocol";

function isTimelineItem(
  event: RahEvent,
): event is Extract<RahEvent, { type: "timeline.item.added" | "timeline.item.updated" }> {
  return event.type === "timeline.item.added" || event.type === "timeline.item.updated";
}

function isUserTimeline(event: RahEvent): boolean {
  return isTimelineItem(event) && event.payload.item.kind === "user_message";
}

function carriesTurnContext(event: RahEvent): boolean {
  if (event.turnId) {
    switch (event.type) {
      case "turn.started":
      case "turn.completed":
      case "turn.failed":
      case "turn.canceled":
      case "turn.step.started":
      case "turn.step.completed":
      case "turn.step.interrupted":
      case "timeline.item.added":
      case "timeline.item.updated":
      case "tool.call.started":
      case "tool.call.delta":
      case "tool.call.completed":
      case "tool.call.failed":
      case "observation.started":
      case "observation.updated":
      case "observation.completed":
      case "observation.failed":
      case "permission.requested":
      case "permission.resolved":
      case "operation.started":
      case "operation.resolved":
      case "operation.requested":
        return true;
      default:
        return false;
    }
  }
  return false;
}

/**
 * Picks a more human-friendly "recent page" start inside an already translated
 * frozen event window. The goal is not to guarantee a perfect conversation
 * segment; it simply avoids obvious truncated endings such as "assistant only"
 * pages when the matching user turn is only a few events earlier.
 */
export function selectSemanticRecentWindow(
  events: readonly RahEvent[],
  limit: number,
): RahEvent[] {
  if (events.length <= limit) {
    return [...events];
  }

  const safeLimit = Math.max(1, limit);
  const naiveStart = Math.max(0, events.length - safeLimit);
  const rewindFloor = Math.max(0, events.length - Math.max(safeLimit * 6, 48));

  let start = naiveStart;

  const lastTurnEvent = [...events.keys()]
    .reverse()
    .map((index) => ({ index, event: events[index]! }))
    .find(({ event }) => carriesTurnContext(event));

  if (lastTurnEvent?.event.turnId) {
    const turnStart = events.findIndex(
      (event, index) => index >= rewindFloor && event.turnId === lastTurnEvent.event.turnId,
    );
    if (turnStart >= 0) {
      start = Math.min(start, turnStart);
    }
  }

  const pageHasUser = events.slice(start).some(isUserTimeline);
  if (!pageHasUser) {
    for (let index = events.length - 1; index >= rewindFloor; index -= 1) {
      if (isUserTimeline(events[index]!)) {
        start = Math.min(start, index);
        break;
      }
    }
  }

  return events.slice(start);
}

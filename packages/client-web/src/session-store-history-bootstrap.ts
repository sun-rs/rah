import type { RahEvent } from "@rah/runtime-protocol";
import type { SessionProjection } from "./types";

const MAX_PENDING_EVENTS_PER_SESSION = 200;
const MAX_DEFERRED_BOOTSTRAP_EVENTS_PER_SESSION = 500;

let pendingEventsBySession = new Map<string, RahEvent[]>();
let deferredBootstrapEventsBySession = new Map<string, RahEvent[]>();

export function queuePendingEvent(event: RahEvent) {
  const existing = pendingEventsBySession.get(event.sessionId) ?? [];
  const next = [...existing, event];
  if (next.length > MAX_PENDING_EVENTS_PER_SESSION) {
    next.splice(0, next.length - MAX_PENDING_EVENTS_PER_SESSION);
  }
  pendingEventsBySession.set(event.sessionId, next);
}

export function takePendingEventsForSessions(sessionIds: Set<string>): RahEvent[] {
  const replay: RahEvent[] = [];
  for (const sessionId of sessionIds) {
    const events = pendingEventsBySession.get(sessionId);
    if (!events || events.length === 0) {
      continue;
    }
    replay.push(...events);
    pendingEventsBySession.delete(sessionId);
  }
  return replay;
}

export function shouldDeferEventForHistoryBootstrap(
  projection: SessionProjection,
  event: RahEvent,
): boolean {
  if (projection.history.phase !== "loading" || projection.history.authoritativeApplied) {
    return false;
  }
  return (
    event.type === "timeline.item.added" ||
    event.type === "timeline.item.updated" ||
    event.type === "message.part.added" ||
    event.type === "message.part.updated" ||
    event.type === "message.part.delta" ||
    event.type === "message.part.removed" ||
    event.type === "tool.call.started" ||
    event.type === "tool.call.delta" ||
    event.type === "tool.call.completed" ||
    event.type === "tool.call.failed" ||
    event.type === "observation.started" ||
    event.type === "observation.updated" ||
    event.type === "observation.completed" ||
    event.type === "observation.failed" ||
    event.type === "permission.requested" ||
    event.type === "permission.resolved" ||
    event.type === "operation.started" ||
    event.type === "operation.resolved" ||
    event.type === "operation.requested" ||
    event.type === "runtime.status" ||
    event.type === "notification.emitted" ||
    event.type === "attention.required" ||
    event.type === "attention.cleared"
  );
}

export function queueDeferredBootstrapEvent(event: RahEvent) {
  const existing = deferredBootstrapEventsBySession.get(event.sessionId) ?? [];
  const next = [...existing, event];
  if (next.length > MAX_DEFERRED_BOOTSTRAP_EVENTS_PER_SESSION) {
    next.splice(0, next.length - MAX_DEFERRED_BOOTSTRAP_EVENTS_PER_SESSION);
  }
  deferredBootstrapEventsBySession.set(event.sessionId, next);
}

export function takeDeferredBootstrapEvents(sessionId: string): RahEvent[] {
  const events = deferredBootstrapEventsBySession.get(sessionId) ?? [];
  deferredBootstrapEventsBySession.delete(sessionId);
  return events;
}

export function clearHistoryBootstrapBuffersForSession(sessionId: string) {
  pendingEventsBySession.delete(sessionId);
  deferredBootstrapEventsBySession.delete(sessionId);
}

export function clearHistoryBootstrapBuffers() {
  pendingEventsBySession = new Map();
  deferredBootstrapEventsBySession = new Map();
}

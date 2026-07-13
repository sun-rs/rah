import type { RahEvent } from "@rah/runtime-protocol";

const MAX_PENDING_EVENTS_PER_SESSION = 200;

let pendingEventsBySession = new Map<string, RahEvent[]>();

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

export function clearPendingEventsForSession(sessionId: string) {
  pendingEventsBySession.delete(sessionId);
}

export function clearPendingEvents() {
  pendingEventsBySession = new Map();
}

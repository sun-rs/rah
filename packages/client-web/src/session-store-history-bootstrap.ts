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
  // Do not hold live/native-mirror events behind initial history bootstrap.
  // Native TUI sessions use the same persisted provider files for live mirror
  // and history paging, so deferring here can hide a completed TUI reply until
  // history loading finishes. prependHistoryPage already reconciles by
  // canonical/message identity when the page arrives.
  void event;
  return false;
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

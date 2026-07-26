import type { RahEvent } from "@rah/runtime-protocol";

const MAX_PENDING_EVENTS_PER_SESSION = 200;
const MAX_PENDING_EVENT_BYTES_PER_SESSION = 512 * 1024;

type PendingEventQueue = {
  events: RahEvent[];
  head: number;
  bytes: number;
};

let pendingEventsBySession = new Map<string, PendingEventQueue>();

export function queuePendingEvent(event: RahEvent) {
  const queue = pendingEventsBySession.get(event.sessionId) ?? {
    events: [],
    head: 0,
    bytes: 0,
  };
  queue.events.push(event);
  queue.bytes += pendingEventBytes(event);
  while (
    queue.head < queue.events.length &&
    (queue.events.length - queue.head > MAX_PENDING_EVENTS_PER_SESSION ||
      queue.bytes > MAX_PENDING_EVENT_BYTES_PER_SESSION)
  ) {
    const removed = queue.events[queue.head++];
    if (removed) {
      queue.bytes -= pendingEventBytes(removed);
    }
  }
  if (queue.head >= queue.events.length) {
    pendingEventsBySession.delete(event.sessionId);
    return;
  }
  if (queue.head >= 64 && queue.head * 2 >= queue.events.length) {
    queue.events = queue.events.slice(queue.head);
    queue.head = 0;
  }
  pendingEventsBySession.set(event.sessionId, queue);
}

export function takePendingEventsForSessions(sessionIds: Set<string>): RahEvent[] {
  const replay: RahEvent[] = [];
  for (const sessionId of sessionIds) {
    const queue = pendingEventsBySession.get(sessionId);
    if (!queue || queue.head >= queue.events.length) {
      continue;
    }
    replay.push(...queue.events.slice(queue.head));
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

function pendingEventBytes(event: RahEvent): number {
  return event.type === "process.output.appended"
    ? 256 + new TextEncoder().encode(event.payload.output.data).byteLength
    : 2_048;
}

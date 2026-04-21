import {
  formatRahConformanceReport,
  validateRahEvent,
  type EventEnvelope,
  type EventSource,
  type RahEvent,
  type RahEventPayloadMap,
  type RahEventType,
} from "@rah/runtime-protocol";

export interface EventSubscriptionFilter {
  sessionIds?: string[];
  eventTypes?: RahEventType[];
  replayFromSeq?: number;
}

type Subscriber = {
  filter: EventSubscriptionFilter;
  onEvent: (event: RahEvent) => void;
};

interface EventBusOptions {
  maxEvents?: number;
  onPersistEvent?: (event: RahEvent) => void;
}

/**
 * In-memory canonical event bus with bounded replay history for clients that
 * reconnect and need semantic state, separate from PTY replay.
 */
export class EventBus {
  private nextSeq = 1;
  private readonly events: RahEvent[] = [];
  private readonly subscribers = new Set<Subscriber>();
  private readonly maxEvents: number;
  private readonly onPersistEvent: ((event: RahEvent) => void) | undefined;

  constructor(options: EventBusOptions = {}) {
    this.maxEvents = options.maxEvents ?? 2_000;
    this.onPersistEvent = options.onPersistEvent;
  }

  publish<K extends RahEventType>(args: {
    sessionId: string;
    type: K;
    source: EventSource;
    payload: RahEventPayloadMap[K];
    ts?: string;
    turnId?: string;
    raw?: unknown;
  }): EventEnvelope<RahEventPayloadMap[K]> & { type: K } {
    const event: EventEnvelope<RahEventPayloadMap[K]> & { type: K } = {
      id: crypto.randomUUID(),
      seq: this.nextSeq++,
      ts: args.ts ?? new Date().toISOString(),
      sessionId: args.sessionId,
      type: args.type,
      source: args.source,
      payload: args.payload,
    };
    if (args.turnId !== undefined) {
      event.turnId = args.turnId;
    }
    if (args.raw !== undefined) {
      event.raw = args.raw;
    }

    const issues = validateRahEvent(event as RahEvent, {
      requireRawForHeuristic: true,
    });
    const errors = issues.filter((issue) => issue.severity === "error");
    if (errors.length > 0) {
      throw new Error(
        `Refusing to publish invalid RAH event.\n${formatRahConformanceReport({
          ok: false,
          errors,
          warnings: issues.filter((issue) => issue.severity === "warning"),
        })}`,
      );
    }

    this.events.push(event as RahEvent);
    if (this.events.length > this.maxEvents) {
      this.events.splice(0, this.events.length - this.maxEvents);
    }
    this.onPersistEvent?.(event as RahEvent);

    for (const subscriber of this.subscribers) {
      if (this.matchesFilter(event as RahEvent, subscriber.filter)) {
        subscriber.onEvent(event as RahEvent);
      }
    }

    return event;
  }

  list(filter: EventSubscriptionFilter = {}): RahEvent[] {
    return this.events.filter((event) => this.matchesFilter(event, filter));
  }

  oldestSeq(): number | null {
    return this.events[0]?.seq ?? null;
  }

  newestSeq(): number | null {
    return this.events.at(-1)?.seq ?? null;
  }

  hydrate(events: readonly RahEvent[]): void {
    this.events.splice(0, this.events.length, ...events);
    const highestSeq = events.reduce((max, event) => Math.max(max, event.seq), 0);
    this.nextSeq = highestSeq + 1;
  }

  subscribe(
    filter: EventSubscriptionFilter,
    onEvent: (event: RahEvent) => void,
  ): () => void {
    const subscriber: Subscriber = { filter, onEvent };
    this.subscribers.add(subscriber);
    return () => {
      this.subscribers.delete(subscriber);
    };
  }

  private matchesFilter(event: RahEvent, filter: EventSubscriptionFilter): boolean {
    if (filter.replayFromSeq !== undefined && event.seq < filter.replayFromSeq) {
      return false;
    }
    if (filter.sessionIds && !filter.sessionIds.includes(event.sessionId)) {
      return false;
    }
    if (filter.eventTypes && !filter.eventTypes.includes(event.type)) {
      return false;
    }
    return true;
  }
}

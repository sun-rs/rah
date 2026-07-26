import {
  formatRahConformanceReport,
  validateRahEvent,
  type EventEnvelope,
  type EventSource,
  type RahEvent,
  type RahEventPayloadMap,
  type RahEventType,
} from "@rah/runtime-protocol";
import { boundedJsonByteLength } from "./bounded-json-size";

export { boundedJsonByteLength } from "./bounded-json-size";

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
  maxRetainedBytes?: number;
  maxRawBytes?: number;
  onPersistEvent?: (event: RahEvent) => void;
  onSubscriberError?: (error: unknown, event: RahEvent) => void;
}

const DEFAULT_MAX_RAW_BYTES = 16 * 1024;
const RAW_DESCRIPTOR_KEY_LIMIT = 12;
const RAW_DESCRIPTOR_VALUE_CHARS = 160;

function compactDescriptorValue(value: unknown): string | number | boolean | null | undefined {
  if (
    value === null ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "string") {
    return value.length <= RAW_DESCRIPTOR_VALUE_CHARS
      ? value
      : `${value.slice(0, RAW_DESCRIPTOR_VALUE_CHARS - 1)}…`;
  }
  return undefined;
}

/**
 * Canonical events retain enough provider provenance for diagnostics and
 * heuristic conformance, never the provider's complete unbounded RPC object.
 */
export function compactEventRaw(
  raw: unknown,
  maxBytes = DEFAULT_MAX_RAW_BYTES,
): unknown {
  if (boundedJsonByteLength(raw, maxBytes) <= maxBytes) {
    return raw;
  }

  const descriptor: Record<string, unknown> = {
    __rahRaw: "compacted",
    kind: Array.isArray(raw) ? "array" : typeof raw,
    exceededBytes: maxBytes,
  };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return descriptor;
  }

  const keys: string[] = [];
  try {
    for (const key in raw as Record<string, unknown>) {
      if (!Object.prototype.hasOwnProperty.call(raw, key)) {
        continue;
      }
      keys.push(key.slice(0, RAW_DESCRIPTOR_VALUE_CHARS));
      if (keys.length >= RAW_DESCRIPTOR_KEY_LIMIT) {
        break;
      }
    }
    if (keys.length > 0) {
      descriptor.keys = keys;
    }
    for (const key of ["method", "type", "id", "event", "name"]) {
      const value = compactDescriptorValue((raw as Record<string, unknown>)[key]);
      if (value !== undefined) {
        descriptor[key] = value;
      }
    }
  } catch {
    descriptor.unreadable = true;
  }
  return descriptor;
}

function defaultSubscriberErrorHandler(error: unknown, event: RahEvent): void {
  console.error("[rah] event subscriber failed", {
    error,
    eventId: event.id,
    eventType: event.type,
    sessionId: event.sessionId,
  });
}

/**
 * In-memory canonical event bus with bounded replay history for clients that
 * reconnect and need semantic state, separate from PTY replay.
 */
export class EventBus {
  private nextSeq = 1;
  private readonly events: RahEvent[] = [];
  private readonly eventBytes: number[] = [];
  private retainedByteCount = 0;
  private readonly subscribers = new Set<Subscriber>();
  private readonly maxEvents: number;
  private readonly maxRetainedBytes: number;
  private readonly maxRawBytes: number;
  private readonly onPersistEvent: ((event: RahEvent) => void) | undefined;
  private readonly onSubscriberError: ((error: unknown, event: RahEvent) => void) | undefined;

  constructor(options: EventBusOptions = {}) {
    this.maxEvents = options.maxEvents ?? 2_000;
    this.maxRetainedBytes = options.maxRetainedBytes ?? 8 * 1024 * 1024;
    this.maxRawBytes = options.maxRawBytes ?? DEFAULT_MAX_RAW_BYTES;
    this.onPersistEvent = options.onPersistEvent;
    this.onSubscriberError = options.onSubscriberError ?? defaultSubscriberErrorHandler;
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
      event.raw = compactEventRaw(args.raw, this.maxRawBytes);
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

    const retained = event.type !== "process.output.appended";
    if (retained) {
      const bytes = eventByteLength(event as RahEvent, this.maxRetainedBytes);
      this.events.push(event as RahEvent);
      this.eventBytes.push(bytes);
      this.retainedByteCount += bytes;
      this.trimRetainedEvents();
      this.onPersistEvent?.(event as RahEvent);
    }

    for (const subscriber of this.subscribers) {
      if (this.matchesFilter(event as RahEvent, subscriber.filter)) {
        try {
          subscriber.onEvent(event as RahEvent);
        } catch (error) {
          this.onSubscriberError?.(error, event as RahEvent);
        }
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
    return this.nextSeq > 1 ? this.nextSeq - 1 : null;
  }

  retainedBytes(): number {
    return this.retainedByteCount;
  }

  hydrate(events: readonly RahEvent[]): void {
    this.events.splice(0, this.events.length);
    this.eventBytes.splice(0, this.eventBytes.length);
    this.retainedByteCount = 0;
    for (const event of events) {
      if (event.type === "process.output.appended") {
        continue;
      }
      const normalized =
        event.raw === undefined
          ? event
          : ({ ...event, raw: compactEventRaw(event.raw, this.maxRawBytes) } as RahEvent);
      const bytes = eventByteLength(normalized, this.maxRetainedBytes);
      this.events.push(normalized);
      this.eventBytes.push(bytes);
      this.retainedByteCount += bytes;
    }
    this.trimRetainedEvents();
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

  private trimRetainedEvents(): void {
    while (
      this.events.length > 0 &&
      (this.events.length > this.maxEvents ||
        this.retainedByteCount > this.maxRetainedBytes)
    ) {
      this.events.shift();
      this.retainedByteCount -= this.eventBytes.shift() ?? 0;
    }
    if (this.retainedByteCount < 0) {
      this.retainedByteCount = 0;
    }
  }
}

function eventByteLength(event: RahEvent, maxRetainedBytes: number): number {
  return boundedJsonByteLength(event, maxRetainedBytes);
}

import {
  composeConversationProjectionDeltas,
  type ConversationProjectionDelta,
  type RahEvent,
} from "@rah/runtime-protocol";
import { boundedJsonByteLength } from "./bounded-json-size";

const DEFAULT_MAX_COALESCED_OUTPUT_CHARS = 128 * 1024;
const DEFAULT_SIZE_BUDGET_BYTES = 2 * 1024 * 1024;

type RegularEntry = {
  kind: "regular";
  event: RahEvent;
  bytes: number;
};

type OutputEntry = {
  kind: "output";
  latest: Extract<RahEvent, { type: "process.output.appended" }>;
  chunks: string[];
  chunkHead: number;
  retainedChars: number;
  retainedBytes: number;
  baseBytes: number;
  bytes: number;
};

type TransportEntry = RegularEntry | OutputEntry;

export type LiveEventTransportFrame = {
  events: RahEvent[];
  conversationDeltas: ConversationProjectionDelta[];
};

export function isLatencyTolerantLiveEvent(event: RahEvent): boolean {
  return (
    event.type === "process.output.appended" ||
    event.type === "message.part.delta" ||
    event.type === "tool.call.delta"
  );
}

function outputKey(
  event: Extract<RahEvent, { type: "process.output.appended" }>,
): string {
  return [
    event.sessionId,
    event.turnId ?? "",
    event.payload.output.itemId,
    event.payload.output.stream,
  ].join("\u0000");
}

/**
 * Per-client live transport buffer.
 *
 * Semantic events retain strict queue order. Consecutive data-plane regions
 * may collapse process chunks by output stream, but a semantic boundary clears
 * the coalescing map so output can never move across lifecycle/completion
 * events. Strings are joined only when a frame is taken.
 */
export class LiveEventTransportBatch {
  private readonly entries: TransportEntry[] = [];
  private readonly deltas: ConversationProjectionDelta[] = [];
  private readonly outputEntries = new Map<string, OutputEntry>();
  private readonly maxCoalescedOutputChars: number;
  private readonly sizeBudgetBytes: number;
  private queuedBytes = 0;
  private urgentEvents = 0;

  constructor(
    options: {
      maxCoalescedOutputChars?: number;
      sizeBudgetBytes?: number;
    } = {},
  ) {
    this.maxCoalescedOutputChars = Math.max(
      1,
      options.maxCoalescedOutputChars ??
        DEFAULT_MAX_COALESCED_OUTPUT_CHARS,
    );
    this.sizeBudgetBytes = Math.max(
      1,
      options.sizeBudgetBytes ?? DEFAULT_SIZE_BUDGET_BYTES,
    );
  }

  get eventCount(): number {
    return this.entries.length;
  }

  get byteLength(): number {
    return this.queuedBytes;
  }

  get hasUrgentEvents(): boolean {
    return this.urgentEvents > 0;
  }

  append(
    event: RahEvent,
    conversationDelta?: ConversationProjectionDelta,
  ): void {
    if (
      event.type === "process.output.appended" &&
      conversationDelta === undefined
    ) {
      this.appendOutput(event);
    } else {
      const bytes = this.eventBytes(event, conversationDelta);
      this.entries.push({ kind: "regular", event, bytes });
      this.queuedBytes += bytes;
      if (!isLatencyTolerantLiveEvent(event)) {
        this.urgentEvents += 1;
        // Do not coalesce output that arrives after this semantic boundary
        // into an entry positioned before it.
        this.outputEntries.clear();
      }
    }
    if (conversationDelta) {
      this.deltas.push(conversationDelta);
    }
  }

  take(): LiveEventTransportFrame {
    const events = this.entries.map((entry) =>
      entry.kind === "regular" ? entry.event : this.materializeOutput(entry),
    );
    const conversationDeltas = composeConversationProjectionDeltas(
      this.deltas,
    );
    this.clear();
    return { events, conversationDeltas };
  }

  clear(): void {
    this.entries.length = 0;
    this.deltas.length = 0;
    this.outputEntries.clear();
    this.queuedBytes = 0;
    this.urgentEvents = 0;
  }

  private appendOutput(
    event: Extract<RahEvent, { type: "process.output.appended" }>,
  ): void {
    const key = outputKey(event);
    const data = event.payload.output.data;
    const dataBytes = Buffer.byteLength(data, "utf8");
    const existing = this.outputEntries.get(key);
    if (!existing) {
      const totalBytes = this.eventBytes(event);
      const entry: OutputEntry = {
        kind: "output",
        latest: event,
        chunks: [data],
        chunkHead: 0,
        retainedChars: data.length,
        retainedBytes: dataBytes,
        baseBytes: Math.max(0, totalBytes - dataBytes),
        bytes: totalBytes,
      };
      this.entries.push(entry);
      this.outputEntries.set(key, entry);
      this.queuedBytes += totalBytes;
      return;
    }

    const previousBytes = existing.bytes;
    existing.latest = event;
    existing.chunks.push(data);
    existing.retainedChars += data.length;
    existing.retainedBytes += dataBytes;
    while (
      existing.retainedChars > this.maxCoalescedOutputChars &&
      existing.chunkHead < existing.chunks.length - 1
    ) {
      const removed = existing.chunks[existing.chunkHead++]!;
      existing.retainedChars -= removed.length;
      existing.retainedBytes -= Buffer.byteLength(removed, "utf8");
    }
    if (
      existing.chunkHead >= 64 &&
      existing.chunkHead * 2 >= existing.chunks.length
    ) {
      existing.chunks.splice(0, existing.chunkHead);
      existing.chunkHead = 0;
    }
    existing.bytes = Math.min(
      this.sizeBudgetBytes + 1,
      existing.baseBytes + existing.retainedBytes,
    );
    this.queuedBytes += existing.bytes - previousBytes;
  }

  private materializeOutput(
    entry: OutputEntry,
  ): Extract<RahEvent, { type: "process.output.appended" }> {
    const data = entry.chunks.slice(entry.chunkHead).join("");
    return {
      ...entry.latest,
      payload: {
        output: {
          ...entry.latest.payload.output,
          offsetBytes: Math.max(
            0,
            entry.latest.payload.output.totalBytes -
              Buffer.byteLength(data, "utf8"),
          ),
          data,
        },
      },
    };
  }

  private eventBytes(
    event: RahEvent,
    conversationDelta?: ConversationProjectionDelta,
  ): number {
    return (
      boundedJsonByteLength(event, this.sizeBudgetBytes) +
      (conversationDelta
        ? boundedJsonByteLength(conversationDelta, this.sizeBudgetBytes)
        : 0)
    );
  }
}

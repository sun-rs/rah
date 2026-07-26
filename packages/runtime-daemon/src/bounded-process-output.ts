import type {
  ProcessOutputAppend,
  ProcessOutputSnapshot,
  ProcessOutputStream,
} from "@rah/runtime-protocol";

const DEFAULT_MAX_TAIL_BYTES = 256 * 1024;

type RetainedChunk = {
  data: string;
  bytes: number;
};

export type BoundedProcessOutputOptions = {
  itemId: string;
  stream?: ProcessOutputStream;
  maxTailBytes?: number;
};

function utf8Tail(value: string, maxBytes: number): RetainedChunk {
  if (maxBytes <= 0 || value.length === 0) {
    return { data: "", bytes: 0 };
  }
  const buffer = Buffer.from(value, "utf8");
  if (buffer.byteLength <= maxBytes) {
    return { data: value, bytes: buffer.byteLength };
  }
  let start = buffer.byteLength - maxBytes;
  while (start < buffer.byteLength && (buffer[start]! & 0xc0) === 0x80) {
    start += 1;
  }
  const data = buffer.subarray(start).toString("utf8");
  return { data, bytes: Buffer.byteLength(data, "utf8") };
}

/**
 * Append-only output accumulator with a byte-bounded in-memory tail.
 *
 * Appending never joins prior chunks. A materialized string is created only
 * for the bounded completion/detail snapshot, eliminating the previous O(n²)
 * cumulative-string path for long-running commands.
 */
export class BoundedProcessOutputAccumulator {
  readonly itemId: string;
  readonly stream: ProcessOutputStream;
  readonly maxTailBytes: number;

  private readonly chunks: RetainedChunk[] = [];
  private firstChunkIndex = 0;
  private sequence = 0;
  private totalBytes = 0;
  private retainedBytes = 0;

  constructor(options: BoundedProcessOutputOptions) {
    this.itemId = options.itemId;
    this.stream = options.stream ?? "combined";
    this.maxTailBytes = Math.max(
      0,
      Math.floor(options.maxTailBytes ?? DEFAULT_MAX_TAIL_BYTES),
    );
  }

  append(data: string): ProcessOutputAppend | undefined {
    if (data.length === 0) {
      return undefined;
    }
    const bytes = Buffer.byteLength(data, "utf8");
    if (bytes === 0) {
      return undefined;
    }
    const offsetBytes = this.totalBytes;
    this.totalBytes += bytes;
    this.sequence += 1;
    this.chunks.push({ data, bytes });
    this.retainedBytes += bytes;
    this.trimTail();

    return {
      itemId: this.itemId,
      stream: this.stream,
      sequence: this.sequence,
      offsetBytes,
      data,
      totalBytes: this.totalBytes,
    };
  }

  hasOutput(): boolean {
    return this.totalBytes > 0;
  }

  snapshot(detailAvailable?: boolean): ProcessOutputSnapshot {
    const tail = this.chunks
      .slice(this.firstChunkIndex)
      .map((chunk) => chunk.data)
      .join("");
    return {
      itemId: this.itemId,
      stream: this.stream,
      totalBytes: this.totalBytes,
      retainedBytes: this.retainedBytes,
      truncatedBeforeBytes: this.totalBytes - this.retainedBytes,
      tail,
      ...(detailAvailable !== undefined ? { detailAvailable } : {}),
    };
  }

  stats(): {
    sequence: number;
    totalBytes: number;
    retainedBytes: number;
    retainedChunks: number;
  } {
    return {
      sequence: this.sequence,
      totalBytes: this.totalBytes,
      retainedBytes: this.retainedBytes,
      retainedChunks: this.chunks.length - this.firstChunkIndex,
    };
  }

  private trimTail(): void {
    while (
      this.retainedBytes > this.maxTailBytes &&
      this.firstChunkIndex < this.chunks.length
    ) {
      const first = this.chunks[this.firstChunkIndex]!;
      const excess = this.retainedBytes - this.maxTailBytes;
      if (first.bytes <= excess) {
        this.retainedBytes -= first.bytes;
        this.firstChunkIndex += 1;
        continue;
      }
      const suffix = utf8Tail(first.data, first.bytes - excess);
      this.chunks[this.firstChunkIndex] = suffix;
      this.retainedBytes -= first.bytes - suffix.bytes;
    }

    if (
      this.firstChunkIndex >= 64 &&
      this.firstChunkIndex * 2 >= this.chunks.length
    ) {
      this.chunks.splice(0, this.firstChunkIndex);
      this.firstChunkIndex = 0;
    }
  }
}

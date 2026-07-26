import { performance } from "node:perf_hooks";

const DEFAULT_HIGH_WATER_BYTES = 256 * 1024;
const DEFAULT_LOW_WATER_BYTES = 64 * 1024;
const DEFAULT_MAX_BYTES_PER_SLICE = 64 * 1024;
const DEFAULT_MAX_SLICE_MS = 4;

export type BackpressuredByteIngressOptions = {
  consume: (chunk: Buffer<ArrayBufferLike>) => void;
  pauseSource: () => void;
  resumeSource: () => void;
  onIdle?: () => void;
  highWaterBytes?: number;
  lowWaterBytes?: number;
  maxBytesPerSlice?: number;
  maxSliceMs?: number;
};

/**
 * Lossless admission gate for byte streams whose consumer runs on the daemon
 * event loop.
 *
 * Merely bounding retained output does not protect responsiveness: a provider
 * can still keep the poll phase busy by continuously producing small chunks.
 * This queue pauses the source at a fixed high-water mark and consumes only a
 * small byte/time budget per setImmediate turn. The pause propagates through
 * the host pipe and PTY all the way to the provider, so overload is handled by
 * backpressure instead of unbounded memory or dropped terminal bytes.
 */
export class BackpressuredByteIngress {
  private readonly consume: BackpressuredByteIngressOptions["consume"];
  private readonly pauseSource: BackpressuredByteIngressOptions["pauseSource"];
  private readonly resumeSource: BackpressuredByteIngressOptions["resumeSource"];
  private readonly onIdle: BackpressuredByteIngressOptions["onIdle"];
  private readonly highWaterBytes: number;
  private readonly lowWaterBytes: number;
  private readonly maxBytesPerSlice: number;
  private readonly maxSliceMs: number;
  private queue: Buffer<ArrayBufferLike>[] = [];
  private queueHead = 0;
  private queuedBytes = 0;
  private scheduled = false;
  private sourcePaused = false;
  private disposed = false;

  constructor(options: BackpressuredByteIngressOptions) {
    this.consume = options.consume;
    this.pauseSource = options.pauseSource;
    this.resumeSource = options.resumeSource;
    this.onIdle = options.onIdle;
    this.highWaterBytes = positiveInteger(
      options.highWaterBytes,
      DEFAULT_HIGH_WATER_BYTES,
    );
    this.lowWaterBytes = Math.min(
      this.highWaterBytes,
      nonNegativeInteger(options.lowWaterBytes, DEFAULT_LOW_WATER_BYTES),
    );
    this.maxBytesPerSlice = positiveInteger(
      options.maxBytesPerSlice,
      DEFAULT_MAX_BYTES_PER_SLICE,
    );
    this.maxSliceMs = positiveNumber(options.maxSliceMs, DEFAULT_MAX_SLICE_MS);
  }

  enqueue(chunk: Buffer<ArrayBufferLike>): void {
    if (this.disposed || chunk.length === 0) {
      return;
    }
    // Node streams normally hand us modest chunks, but splitting an
    // unexpectedly large chunk keeps the per-turn guarantee true as well.
    for (let offset = 0; offset < chunk.length; offset += this.maxBytesPerSlice) {
      this.queue.push(
        chunk.subarray(offset, Math.min(chunk.length, offset + this.maxBytesPerSlice)),
      );
    }
    this.queuedBytes += chunk.length;
    if (!this.sourcePaused && this.queuedBytes >= this.highWaterBytes) {
      this.sourcePaused = true;
      this.pauseSource();
    }
    this.scheduleDrain();
  }

  isIdle(): boolean {
    return this.queuedBytes === 0 && !this.scheduled;
  }

  stats(): {
    queuedBytes: number;
    queuedChunks: number;
    sourcePaused: boolean;
    scheduled: boolean;
  } {
    return {
      queuedBytes: this.queuedBytes,
      queuedChunks: this.queue.length - this.queueHead,
      sourcePaused: this.sourcePaused,
      scheduled: this.scheduled,
    };
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.queue = [];
    this.queueHead = 0;
    this.queuedBytes = 0;
    if (this.sourcePaused) {
      this.sourcePaused = false;
      this.resumeSource();
    }
  }

  private scheduleDrain(): void {
    if (this.disposed || this.scheduled) {
      return;
    }
    this.scheduled = true;
    setImmediate(() => {
      this.drainSlice();
    });
  }

  private drainSlice(): void {
    if (this.disposed) {
      this.scheduled = false;
      return;
    }
    this.scheduled = false;
    const startedAt = performance.now();
    let consumedBytes = 0;
    const chunks: Buffer<ArrayBufferLike>[] = [];
    while (
      this.queueHead < this.queue.length &&
      consumedBytes < this.maxBytesPerSlice &&
      performance.now() - startedAt < this.maxSliceMs
    ) {
      const chunk = this.queue[this.queueHead++];
      if (!chunk) {
        continue;
      }
      this.queuedBytes -= chunk.length;
      consumedBytes += chunk.length;
      chunks.push(chunk);
    }
    if (chunks.length === 1) {
      this.consume(chunks[0]!);
    } else if (chunks.length > 1) {
      this.consume(Buffer.concat(chunks, consumedBytes));
    }
    if (this.disposed) {
      return;
    }

    if (this.queueHead > 0 && this.queueHead >= this.queue.length / 2) {
      this.queue = this.queue.slice(this.queueHead);
      this.queueHead = 0;
    }
    if (this.queuedBytes < 0) {
      this.queuedBytes = 0;
    }
    if (this.sourcePaused && this.queuedBytes <= this.lowWaterBytes) {
      this.sourcePaused = false;
      this.resumeSource();
    }
    if (this.queueHead < this.queue.length) {
      this.scheduleDrain();
      return;
    }
    this.queue = [];
    this.queueHead = 0;
    this.onIdle?.();
  }
}

function positiveInteger(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(1, Math.floor(value));
}

function nonNegativeInteger(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(0, Math.floor(value));
}

function positiveNumber(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(0.1, value);
}

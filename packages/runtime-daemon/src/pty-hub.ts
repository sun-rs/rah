import type { PtyServerMessage, PtySessionStats } from "@rah/runtime-protocol";
import { StringDecoder } from "node:string_decoder";

type PtySubscriber = (message: PtyServerMessage) => void;

export type PtyServerFrame = PtyServerMessage;

type ReplayEntry = {
  seq: number;
  data: string;
  bytes: number;
};

type PtyExitState = {
  seq: number;
  exitCode?: number;
  signal?: string;
};

type PtyState = {
  sessionId: string;
  replayEntries: ReplayEntry[];
  replayBytes: number;
  nextSeq: number;
  exitState?: PtyExitState;
  subscribers: Set<PtySubscriber>;
};

export interface PtySubscribeOptions {
  replay?: boolean;
  fromSeq?: number;
  tailBytes?: number;
}

export interface PtyHubOptions {
  maxReplayChunks?: number;
  maxReplayBytes?: number;
  maxOutputFrameBytes?: number;
  maxReplayFrameBytes?: number;
  maxAppendBytes?: number;
}

export interface PtyAppendOutputOptions {
  replaceReplay?: boolean;
}

const DEFAULT_MAX_REPLAY_CHUNKS = 2_000;
const DEFAULT_MAX_REPLAY_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_OUTPUT_FRAME_BYTES = 128 * 1024;
const DEFAULT_MAX_REPLAY_FRAME_BYTES = 512 * 1024;
const DEFAULT_MAX_APPEND_BYTES = 1024 * 1024;

/**
 * PTY transport stays separate from the semantic event bus. It only carries
 * display-oriented replay and output frames.
 */
export class PtyHub {
  private readonly maxReplayChunks: number;
  private readonly maxReplayBytes: number;
  private readonly maxOutputFrameBytes: number;
  private readonly maxReplayFrameBytes: number;
  private readonly maxAppendBytes: number;
  private readonly sessions = new Map<string, PtyState>();

  constructor(options?: PtyHubOptions) {
    this.maxReplayChunks = Math.max(1, options?.maxReplayChunks ?? DEFAULT_MAX_REPLAY_CHUNKS);
    this.maxReplayBytes = Math.max(1, options?.maxReplayBytes ?? DEFAULT_MAX_REPLAY_BYTES);
    this.maxOutputFrameBytes = Math.max(
      1,
      Math.min(
        this.maxReplayBytes,
        options?.maxOutputFrameBytes ?? DEFAULT_MAX_OUTPUT_FRAME_BYTES,
      ),
    );
    this.maxReplayFrameBytes = Math.max(
      this.maxOutputFrameBytes,
      Math.min(
        this.maxReplayBytes,
        options?.maxReplayFrameBytes ?? DEFAULT_MAX_REPLAY_FRAME_BYTES,
      ),
    );
    this.maxAppendBytes = Math.max(
      this.maxOutputFrameBytes,
      Math.min(this.maxReplayBytes, options?.maxAppendBytes ?? DEFAULT_MAX_APPEND_BYTES),
    );
  }

  ensureSession(sessionId: string): void {
    if (this.sessions.has(sessionId)) {
      return;
    }
    this.sessions.set(sessionId, {
      sessionId,
      replayEntries: [],
      replayBytes: 0,
      nextSeq: 0,
      subscribers: new Set(),
    });
  }

  resetSession(sessionId: string): void {
    const existing = this.sessions.get(sessionId);
    if (!existing) {
      this.ensureSession(sessionId);
      return;
    }
    existing.replayEntries = [];
    existing.replayBytes = 0;
    existing.nextSeq = 0;
    delete existing.exitState;
  }

  appendOutput(sessionId: string, data: string, options?: PtyAppendOutputOptions): void {
    const session = this.getOrCreate(sessionId);
    if (options?.replaceReplay === true) {
      session.replayEntries = [];
      session.replayBytes = 0;
    }
    const boundedData = utf8Tail(data, this.maxAppendBytes);
    const chunks = splitUtf8ByBytes(boundedData, this.maxOutputFrameBytes);
    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index]!;
      const seq = this.appendReplayEntry(session, chunk);
      const frame: PtyServerFrame = {
        type: "pty.output",
        sessionId,
        data: chunk,
        seq,
      };
      if (options?.replaceReplay === true && index === 0) {
        frame.replace = true;
      }
      for (const subscriber of session.subscribers) {
        subscriber(frame);
      }
    }
  }

  compactReplay(sessionId: string, data: string): void {
    const session = this.getOrCreate(sessionId);
    session.replayEntries = [];
    session.replayBytes = 0;
    const boundedData = utf8Tail(data, this.maxAppendBytes);
    for (const chunk of splitUtf8ByBytes(boundedData, this.maxOutputFrameBytes)) {
      this.appendReplayEntry(session, chunk);
    }
  }

  emitExit(sessionId: string, exitCode?: number, signal?: string): void {
    const session = this.getOrCreate(sessionId);
    if (!session.exitState) {
      session.exitState = {
        seq: session.nextSeq++,
        ...(exitCode !== undefined ? { exitCode } : {}),
        ...(signal !== undefined ? { signal } : {}),
      };
    }
    const frame = exitFrame(sessionId, session.exitState);
    for (const subscriber of session.subscribers) {
      subscriber(frame);
    }
  }

  subscribe(
    sessionId: string,
    onFrame: PtySubscriber,
    replayOrOptions: boolean | PtySubscribeOptions = true,
  ): () => void {
    const session = this.getOrCreate(sessionId);
    session.subscribers.add(onFrame);
    const options =
      typeof replayOrOptions === "boolean"
        ? { replay: replayOrOptions }
        : replayOrOptions;

    if (options.replay !== false) {
      this.replay(
        session,
        onFrame,
        sanitizeFromSeq(options.fromSeq),
        sanitizeTailBytes(options.tailBytes),
      );
    }

    return () => {
      session.subscribers.delete(onFrame);
    };
  }

  removeSession(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  stats(sessionId: string): PtySessionStats | null {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return null;
    }
    return statsForSession(session, {
      maxReplayChunks: this.maxReplayChunks,
      maxReplayBytes: this.maxReplayBytes,
    });
  }

  listStats(): PtySessionStats[] {
    return Array.from(this.sessions.values(), (session) =>
      statsForSession(session, {
        maxReplayChunks: this.maxReplayChunks,
        maxReplayBytes: this.maxReplayBytes,
      }),
    );
  }

  private trimReplay(session: PtyState): void {
    while (session.replayEntries.length > this.maxReplayChunks) {
      const removed = session.replayEntries.shift();
      if (removed) {
        session.replayBytes -= removed.bytes;
      }
    }
    while (session.replayBytes > this.maxReplayBytes && session.replayEntries.length > 1) {
      const removed = session.replayEntries.shift();
      if (removed) {
        session.replayBytes -= removed.bytes;
      }
    }
    if (session.replayBytes < 0) {
      session.replayBytes = 0;
    }
  }

  private appendReplayEntry(session: PtyState, data: string): number {
    const seq = session.nextSeq++;
    const bytes = replayByteLength(data);
    session.replayEntries.push({ seq, data, bytes });
    session.replayBytes += bytes;
    this.trimReplay(session);
    return seq;
  }

  private replay(
    session: PtyState,
    onFrame: PtySubscriber,
    fromSeq: number | undefined,
    tailBytes: number | undefined,
  ): void {
    const availableEntries =
      fromSeq === undefined
        ? session.replayEntries
        : session.replayEntries.filter((entry) => entry.seq >= fromSeq);
    const entries =
      fromSeq === undefined
        ? replayEntriesForTail(
            availableEntries,
            Math.min(tailBytes ?? this.maxReplayFrameBytes, this.maxReplayFrameBytes),
            this.maxReplayFrameBytes,
          )
        : replayEntriesByteLength(availableEntries) > this.maxReplayFrameBytes
          ? replayEntriesForTail(
              availableEntries,
              this.maxReplayFrameBytes,
              this.maxReplayFrameBytes,
            )
          : availableEntries;
    const firstAvailableSeq = session.replayEntries[0]?.seq;
    const selectedFirstSeq = entries[0]?.seq;
    const frame: PtyServerFrame = {
      type: "pty.replay",
      sessionId: session.sessionId,
      chunks: entries.map((entry) => entry.data),
      baseSeq: selectedFirstSeq ?? session.nextSeq,
      nextSeq: session.nextSeq,
      status: session.exitState ? "exited" : "open",
    };
    if (fromSeq !== undefined && selectedFirstSeq !== undefined && fromSeq < selectedFirstSeq) {
      frame.droppedBeforeSeq = selectedFirstSeq;
    } else if (
      fromSeq === undefined &&
      firstAvailableSeq !== undefined &&
      selectedFirstSeq !== undefined &&
      selectedFirstSeq > firstAvailableSeq
    ) {
      frame.droppedBeforeSeq = selectedFirstSeq;
    } else if (
      fromSeq === undefined &&
      firstAvailableSeq !== undefined &&
      firstAvailableSeq > 0
    ) {
      frame.droppedBeforeSeq = firstAvailableSeq;
    }
    if (session.exitState?.exitCode !== undefined) {
      frame.exitCode = session.exitState.exitCode;
    }
    if (session.exitState?.signal !== undefined) {
      frame.signal = session.exitState.signal;
    }
    onFrame(frame);

    if (session.exitState && (fromSeq === undefined || session.exitState.seq >= fromSeq)) {
      onFrame(exitFrame(session.sessionId, session.exitState));
    }
  }

  private getOrCreate(sessionId: string): PtyState {
    const existing = this.sessions.get(sessionId);
    if (existing) {
      return existing;
    }
    const created: PtyState = {
      sessionId,
      replayEntries: [],
      replayBytes: 0,
      nextSeq: 0,
      subscribers: new Set(),
    };
    this.sessions.set(sessionId, created);
    return created;
  }
}

function exitFrame(sessionId: string, exitState: PtyExitState): PtyServerFrame {
  const frame: PtyServerFrame = {
    type: "pty.exited",
    sessionId,
    seq: exitState.seq,
  };
  if (exitState.exitCode !== undefined) {
    frame.exitCode = exitState.exitCode;
  }
  if (exitState.signal !== undefined) {
    frame.signal = exitState.signal;
  }
  return frame;
}

function sanitizeFromSeq(fromSeq: number | undefined): number | undefined {
  if (fromSeq === undefined || !Number.isFinite(fromSeq)) {
    return undefined;
  }
  return Math.max(0, Math.floor(fromSeq));
}

function sanitizeTailBytes(tailBytes: number | undefined): number | undefined {
  if (tailBytes === undefined || !Number.isFinite(tailBytes)) {
    return undefined;
  }
  return Math.max(1, Math.floor(tailBytes));
}

function replayEntriesForTail(
  entries: ReplayEntry[],
  tailBytes: number | undefined,
  hardMaxBytes = Number.POSITIVE_INFINITY,
): ReplayEntry[] {
  if (tailBytes === undefined || entries.length === 0) {
    return entries;
  }
  const selected: ReplayEntry[] = [];
  let bytes = 0;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (!entry) {
      continue;
    }
    if (selected.length > 0 && bytes + entry.bytes > hardMaxBytes) {
      break;
    }
    selected.unshift(entry);
    bytes += entry.bytes;
    if (bytes >= tailBytes) {
      break;
    }
  }
  return selected;
}

function replayEntriesByteLength(entries: ReplayEntry[]): number {
  let bytes = 0;
  for (const entry of entries) {
    bytes += entry.bytes;
  }
  return bytes;
}

function utf8Tail(data: string, maxBytes: number): string {
  if (replayByteLength(data) <= maxBytes) {
    return data;
  }
  const buffer = Buffer.from(data, "utf8");
  let start = buffer.length - maxBytes;
  while (start < buffer.length && (buffer[start]! & 0xc0) === 0x80) {
    start += 1;
  }
  return buffer.subarray(start).toString("utf8");
}

function splitUtf8ByBytes(data: string, maxBytes: number): string[] {
  if (replayByteLength(data) <= maxBytes) {
    return [data];
  }
  const buffer = Buffer.from(data, "utf8");
  const decoder = new StringDecoder("utf8");
  const chunks: string[] = [];
  for (let offset = 0; offset < buffer.length; offset += maxBytes) {
    const decoded = decoder.write(buffer.subarray(offset, offset + maxBytes));
    if (decoded) {
      chunks.push(decoded);
    }
  }
  const trailing = decoder.end();
  if (trailing) {
    chunks.push(trailing);
  }
  return chunks.length > 0 ? chunks : [""];
}

function replayByteLength(data: string): number {
  return Buffer.byteLength(data, "utf8");
}

function statsForSession(
  session: PtyState,
  limits: { maxReplayChunks: number; maxReplayBytes: number },
): PtySessionStats {
  const firstReplaySeq = session.replayEntries[0]?.seq;
  return {
    sessionId: session.sessionId,
    replayChunks: session.replayEntries.length,
    replayBytes: session.replayBytes,
    maxReplayChunks: limits.maxReplayChunks,
    maxReplayBytes: limits.maxReplayBytes,
    nextSeq: session.nextSeq,
    ...(firstReplaySeq !== undefined ? { firstReplaySeq } : {}),
    ...(firstReplaySeq !== undefined && firstReplaySeq > 0
      ? { droppedBeforeSeq: firstReplaySeq }
      : {}),
    subscriberCount: session.subscribers.size,
    status: session.exitState ? "exited" : "open",
  };
}

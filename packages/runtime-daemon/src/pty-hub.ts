import type { PtyServerMessage, PtySessionStats } from "@rah/runtime-protocol";

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
}

export interface PtyHubOptions {
  maxReplayChunks?: number;
  maxReplayBytes?: number;
}

export interface PtyAppendOutputOptions {
  replaceReplay?: boolean;
}

const DEFAULT_MAX_REPLAY_CHUNKS = 2_000;
const DEFAULT_MAX_REPLAY_BYTES = 8 * 1024 * 1024;

/**
 * PTY transport stays separate from the semantic event bus. It only carries
 * display-oriented replay and output frames.
 */
export class PtyHub {
  private readonly maxReplayChunks: number;
  private readonly maxReplayBytes: number;
  private readonly sessions = new Map<string, PtyState>();

  constructor(options?: PtyHubOptions) {
    this.maxReplayChunks = Math.max(1, options?.maxReplayChunks ?? DEFAULT_MAX_REPLAY_CHUNKS);
    this.maxReplayBytes = Math.max(1, options?.maxReplayBytes ?? DEFAULT_MAX_REPLAY_BYTES);
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

  appendOutput(sessionId: string, data: string, options?: PtyAppendOutputOptions): void {
    const session = this.getOrCreate(sessionId);
    const seq = session.nextSeq++;
    const bytes = replayByteLength(data);
    if (options?.replaceReplay === true) {
      session.replayEntries = [{ seq, data, bytes }];
      session.replayBytes = bytes;
    } else {
      session.replayEntries.push({ seq, data, bytes });
      session.replayBytes += bytes;
    }
    this.trimReplay(session);

    const frame: PtyServerFrame = {
      type: "pty.output",
      sessionId,
      data,
      seq,
    };
    for (const subscriber of session.subscribers) {
      subscriber(frame);
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
      this.replay(session, onFrame, sanitizeFromSeq(options.fromSeq));
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

  private replay(
    session: PtyState,
    onFrame: PtySubscriber,
    fromSeq: number | undefined,
  ): void {
    const entries =
      fromSeq === undefined
        ? session.replayEntries
        : session.replayEntries.filter((entry) => entry.seq >= fromSeq);
    const firstAvailableSeq = session.replayEntries[0]?.seq;
    const frame: PtyServerFrame = {
      type: "pty.replay",
      sessionId: session.sessionId,
      chunks: entries.map((entry) => entry.data),
      baseSeq: entries[0]?.seq ?? session.nextSeq,
      nextSeq: session.nextSeq,
      status: session.exitState ? "exited" : "open",
    };
    if (
      fromSeq !== undefined &&
      firstAvailableSeq !== undefined &&
      fromSeq < firstAvailableSeq
    ) {
      frame.droppedBeforeSeq = firstAvailableSeq;
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

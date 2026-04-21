type PtySubscriber = (message: PtyServerFrame) => void;

export type PtyServerFrame =
  | {
      type: "pty.replay";
      sessionId: string;
      chunks: string[];
    }
  | {
      type: "pty.output";
      sessionId: string;
      data: string;
    }
  | {
      type: "pty.exited";
      sessionId: string;
      exitCode?: number;
      signal?: string;
    };

type PtyState = {
  sessionId: string;
  replayChunks: string[];
  subscribers: Set<PtySubscriber>;
};

/**
 * PTY transport stays separate from the semantic event bus. It only carries
 * display-oriented replay and output frames.
 */
export class PtyHub {
  private readonly sessions = new Map<string, PtyState>();

  ensureSession(sessionId: string): void {
    if (this.sessions.has(sessionId)) {
      return;
    }
    this.sessions.set(sessionId, {
      sessionId,
      replayChunks: [],
      subscribers: new Set(),
    });
  }

  appendOutput(sessionId: string, data: string): void {
    const session = this.getOrCreate(sessionId);
    session.replayChunks.push(data);
    if (session.replayChunks.length > 400) {
      session.replayChunks.splice(0, session.replayChunks.length - 400);
    }

    const frame: PtyServerFrame = {
      type: "pty.output",
      sessionId,
      data,
    };
    for (const subscriber of session.subscribers) {
      subscriber(frame);
    }
  }

  emitExit(sessionId: string, exitCode?: number, signal?: string): void {
    const session = this.getOrCreate(sessionId);
    const frame: PtyServerFrame = {
      type: "pty.exited",
      sessionId,
    };
    if (exitCode !== undefined) {
      frame.exitCode = exitCode;
    }
    if (signal !== undefined) {
      frame.signal = signal;
    }
    for (const subscriber of session.subscribers) {
      subscriber(frame);
    }
  }

  subscribe(sessionId: string, onFrame: PtySubscriber, replay = true): () => void {
    const session = this.getOrCreate(sessionId);
    session.subscribers.add(onFrame);

    if (replay) {
      onFrame({
        type: "pty.replay",
        sessionId,
        chunks: [...session.replayChunks],
      });
    }

    return () => {
      session.subscribers.delete(onFrame);
    };
  }

  removeSession(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  private getOrCreate(sessionId: string): PtyState {
    const existing = this.sessions.get(sessionId);
    if (existing) {
      return existing;
    }
    const created: PtyState = {
      sessionId,
      replayChunks: [],
      subscribers: new Set(),
    };
    this.sessions.set(sessionId, created);
    return created;
  }
}

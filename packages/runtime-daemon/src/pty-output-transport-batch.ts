import type { PtyServerMessage } from "@rah/runtime-protocol";

type PtyOutputFrame = Extract<PtyServerMessage, { type: "pty.output" }>;

/**
 * Per-client PTY output buffer.
 *
 * Output chunks stay as an append-only list and are materialized once when the
 * WebSocket frame is sent. This keeps a noisy terminal from repeatedly
 * copying an ever-growing string on the daemon event loop.
 */
export class PtyOutputTransportBatch {
  private latest: PtyOutputFrame | null = null;
  private readonly chunks: string[] = [];
  private chars = 0;

  get charLength(): number {
    return this.chars;
  }

  get empty(): boolean {
    return this.latest === null;
  }

  append(frame: PtyOutputFrame): void {
    this.latest = frame;
    this.chunks.push(frame.data);
    this.chars += frame.data.length;
  }

  take(): PtyOutputFrame | null {
    if (!this.latest) {
      return null;
    }
    const output: PtyOutputFrame = {
      ...this.latest,
      data: this.chunks.join(""),
    };
    this.clear();
    return output;
  }

  clear(): void {
    this.latest = null;
    this.chunks.length = 0;
    this.chars = 0;
  }
}

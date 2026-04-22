import type { RahEvent, SessionHistoryPageResponse } from "@rah/runtime-protocol";

type HistorySnapshot = {
  events: RahEvent[];
};

function encodeCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ offset }), "utf8").toString("base64url");
}

function decodeCursor(cursor: string): number {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as {
      offset?: unknown;
    };
    if (
      typeof parsed.offset !== "number" ||
      !Number.isInteger(parsed.offset) ||
      parsed.offset < 0
    ) {
      throw new Error("Invalid history cursor.");
    }
    return parsed.offset;
  } catch {
    throw new Error("Invalid history cursor.");
  }
}

function normalizeSnapshotEvents(events: readonly RahEvent[]): RahEvent[] {
  return [...events].sort((left, right) => left.ts.localeCompare(right.ts) || left.seq - right.seq);
}

export class HistorySnapshotStore {
  private readonly snapshots = new Map<string, HistorySnapshot>();

  getPage(args: {
    sessionId: string;
    limit?: number;
    cursor?: string;
    loadEvents: () => RahEvent[];
  }): SessionHistoryPageResponse {
    const snapshot = this.getOrCreate(args.sessionId, args.loadEvents);
    const limit = Math.max(1, args.limit ?? 1000);
    const endExclusive = args.cursor ? decodeCursor(args.cursor) : snapshot.events.length;
    const boundedEndExclusive = Math.max(0, Math.min(endExclusive, snapshot.events.length));
    const start = Math.max(0, boundedEndExclusive - limit);
    const events = snapshot.events.slice(start, boundedEndExclusive);
    const nextCursor = start > 0 ? encodeCursor(start) : undefined;
    return {
      sessionId: args.sessionId,
      events,
      ...(nextCursor ? { nextCursor } : {}),
      ...(events[0] ? { nextBeforeTs: events[0].ts } : {}),
    };
  }

  transfer(sourceSessionId: string, targetSessionId: string): void {
    const snapshot = this.snapshots.get(sourceSessionId);
    if (!snapshot || sourceSessionId === targetSessionId) {
      return;
    }
    this.snapshots.delete(sourceSessionId);
    this.snapshots.set(targetSessionId, snapshot);
  }

  clear(sessionId: string): void {
    this.snapshots.delete(sessionId);
  }

  private getOrCreate(sessionId: string, loadEvents: () => RahEvent[]): HistorySnapshot {
    const existing = this.snapshots.get(sessionId);
    if (existing) {
      return existing;
    }
    const created = {
      events: normalizeSnapshotEvents(loadEvents()),
    };
    this.snapshots.set(sessionId, created);
    return created;
  }
}

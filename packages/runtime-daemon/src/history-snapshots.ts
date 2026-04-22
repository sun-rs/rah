import type { RahEvent, SessionHistoryPageResponse } from "@rah/runtime-protocol";

export type FrozenHistoryBoundary = {
  kind: "frozen";
  sourceRevision: string;
};

export type FrozenHistoryPage = {
  boundary: FrozenHistoryBoundary;
  events: RahEvent[];
  nextCursor?: string;
  nextBeforeTs?: string;
};

/**
 * Provider-owned history pager for sessions whose transcript should remain
 * frozen while the user browses older history, even if the underlying source
 * file later grows due to resume/claim.
 *
 * Implementations are expected to:
 * - capture a stable source revision in `loadInitialPage`
 * - return cursors that stay valid for that frozen revision
 * - reject or avoid mixing newer file content into older-page reads
 */
export interface FrozenHistoryPageLoader {
  loadInitialPage(limit: number): FrozenHistoryPage;
  loadOlderPage(
    cursor: string,
    limit: number,
    boundary: FrozenHistoryBoundary,
  ): FrozenHistoryPage;
}

type MaterializedHistorySnapshot = {
  mode: "materialized";
  events: RahEvent[];
};

type CachedFrozenPage = {
  requestCursor: string | null;
  response: SessionHistoryPageResponse;
};

type FrozenPagedHistorySnapshot = {
  mode: "frozen_paged";
  boundary: FrozenHistoryBoundary;
  loader: FrozenHistoryPageLoader;
  pagesByRequestCursor: Map<string | null, CachedFrozenPage>;
};

type HistorySnapshot = MaterializedHistorySnapshot | FrozenPagedHistorySnapshot;

function encodeOffsetCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ offset }), "utf8").toString("base64url");
}

function decodeOffsetCursor(cursor: string): number {
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
    loadFrozenPage?: () => FrozenHistoryPageLoader | undefined;
  }): SessionHistoryPageResponse {
    const existing = this.snapshots.get(args.sessionId);
    if (existing?.mode === "frozen_paged") {
      return this.getFrozenPagedPage(existing, args.sessionId, args.limit, args.cursor, args.loadFrozenPage);
    }
    if (existing?.mode === "materialized") {
      return this.getMaterializedPage(existing, args.sessionId, args.limit, args.cursor);
    }

    const frozenLoader = args.loadFrozenPage?.();
    if (frozenLoader) {
      const limit = Math.max(1, args.limit ?? 1000);
      const initial = frozenLoader.loadInitialPage(limit);
      const created: FrozenPagedHistorySnapshot = {
        mode: "frozen_paged",
        boundary: initial.boundary,
        loader: frozenLoader,
        pagesByRequestCursor: new Map([
          [
            null,
            {
              requestCursor: null,
              response: {
                sessionId: args.sessionId,
                events: initial.events,
                ...(initial.nextCursor ? { nextCursor: initial.nextCursor } : {}),
                ...(initial.nextBeforeTs ? { nextBeforeTs: initial.nextBeforeTs } : {}),
              },
            },
          ],
        ]),
      };
      this.snapshots.set(args.sessionId, created);
      return created.pagesByRequestCursor.get(null)!.response;
    }

    const created: MaterializedHistorySnapshot = {
      mode: "materialized",
      events: normalizeSnapshotEvents(args.loadEvents()),
    };
    this.snapshots.set(args.sessionId, created);
    return this.getMaterializedPage(created, args.sessionId, args.limit, args.cursor);
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

  private getMaterializedPage(
    snapshot: MaterializedHistorySnapshot,
    sessionId: string,
    limitValue?: number,
    cursor?: string,
  ): SessionHistoryPageResponse {
    const limit = Math.max(1, limitValue ?? 1000);
    const endExclusive = cursor ? decodeOffsetCursor(cursor) : snapshot.events.length;
    const boundedEndExclusive = Math.max(0, Math.min(endExclusive, snapshot.events.length));
    const start = Math.max(0, boundedEndExclusive - limit);
    const events = snapshot.events.slice(start, boundedEndExclusive);
    const nextCursor = start > 0 ? encodeOffsetCursor(start) : undefined;
    return {
      sessionId,
      events,
      ...(nextCursor ? { nextCursor } : {}),
      ...(events[0] ? { nextBeforeTs: events[0].ts } : {}),
    };
  }

  private getFrozenPagedPage(
    snapshot: FrozenPagedHistorySnapshot,
    sessionId: string,
    limitValue: number | undefined,
    cursor: string | undefined,
    _loadFrozenPage: (() => FrozenHistoryPageLoader | undefined) | undefined,
  ): SessionHistoryPageResponse {
    const cached = snapshot.pagesByRequestCursor.get(cursor ?? null);
    if (cached) {
      return cached.response;
    }
    if (!cursor) {
      throw new Error("Missing initial history page for frozen snapshot.");
    }
    const limit = Math.max(1, limitValue ?? 1000);
    const older = snapshot.loader.loadOlderPage(cursor, limit, snapshot.boundary);
    if (older.boundary.sourceRevision !== snapshot.boundary.sourceRevision) {
      throw new Error("Frozen history source revision changed while paging older history.");
    }
    const response: SessionHistoryPageResponse = {
      sessionId,
      events: older.events,
      ...(older.nextCursor ? { nextCursor: older.nextCursor } : {}),
      ...(older.nextBeforeTs ? { nextBeforeTs: older.nextBeforeTs } : {}),
    };
    snapshot.pagesByRequestCursor.set(cursor, {
      requestCursor: cursor,
      response,
    });
    return response;
  }
}

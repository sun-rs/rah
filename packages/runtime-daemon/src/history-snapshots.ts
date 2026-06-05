import type { RahEvent, SessionHistoryPageResponse } from "@rah/runtime-protocol";
import { normalizeTranscriptEvents } from "./timeline-reconciler";

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
  limit: number;
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
  return normalizeTranscriptEvents([...events].sort((left, right) => left.seq - right.seq));
}

function stableFrozenEventIdentity(event: RahEvent): string | undefined {
  switch (event.type) {
    case "timeline.item.added":
    case "timeline.item.updated": {
      const identity = event.payload.identity;
      if (identity?.canonicalItemId) {
        return `${event.type}:timeline:${identity.canonicalItemId}`;
      }
      const item = event.payload.item;
      const messageId =
        "messageId" in item && typeof item.messageId === "string"
          ? item.messageId
          : undefined;
      if (messageId) {
        return `${event.type}:timeline-message:${item.kind}:${messageId}`;
      }
      return undefined;
    }
    case "tool.call.started":
    case "tool.call.completed":
      return `${event.type}:tool:${event.payload.toolCall.id}`;
    case "tool.call.delta":
    case "tool.call.failed":
      return `${event.type}:tool:${event.payload.toolCallId}`;
    case "observation.started":
    case "observation.updated":
    case "observation.completed":
    case "observation.failed":
      return `${event.type}:observation:${event.payload.observation.id}`;
    case "permission.requested":
      return `${event.type}:permission:${event.payload.request.id}`;
    case "permission.resolved":
      return `${event.type}:permission:${event.payload.resolution.requestId}`;
    case "operation.started":
    case "operation.resolved":
    case "operation.requested":
      return `${event.type}:operation:${event.payload.operation.id}`;
    case "message.part.added":
    case "message.part.updated":
    case "message.part.delta":
      return `${event.type}:message-part:${event.payload.part.messageId}:${event.payload.part.partId}`;
    case "message.part.removed":
      return `${event.type}:message-part:${event.payload.messageId}:${event.payload.partId}`;
    case "turn.completed":
    case "turn.failed":
    case "turn.canceled": {
      const identity = event.payload.identity?.canonicalTurnId ?? event.turnId;
      return identity ? `${event.type}:turn:${identity}` : undefined;
    }
    default:
      return undefined;
  }
}

function encodeStableIdPart(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function reanchorFrozenPageEvents(args: {
  sessionId: string;
  requestCursor: string | null;
  events: readonly RahEvent[];
}): RahEvent[] {
  const pageScope = args.requestCursor ?? "initial";
  return args.events.map((event, index) => {
    const stableIdentity = stableFrozenEventIdentity(event);
    const identity =
      stableIdentity
        ? `${stableIdentity}:ts:${event.ts}`
        : `page:${pageScope}:index:${index}:type:${event.type}:source:${event.id}`;
    return {
      ...event,
      id: `history:${args.sessionId}:${encodeStableIdPart(identity)}`,
      sessionId: args.sessionId,
    };
  });
}

function paginationTimestamp(nextCursor: string | undefined, events: readonly RahEvent[]): string | undefined {
  if (!nextCursor) {
    return undefined;
  }
  return events[0]?.ts;
}

function normalizeHistoryPageLimit(limitValue: number | undefined): number {
  return Math.max(1, limitValue ?? 1000);
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
      if (!args.cursor) {
        const requestedLimit = normalizeHistoryPageLimit(args.limit);
        const cachedInitial = existing.pagesByRequestCursor.get(null);
        const refreshed = this.createFrozenPagedSnapshot(
          args.sessionId,
          args.limit,
          args.loadFrozenPage,
        );
        if (
          refreshed &&
          (refreshed.boundary.sourceRevision !== existing.boundary.sourceRevision ||
            cachedInitial?.limit !== requestedLimit)
        ) {
          this.snapshots.set(args.sessionId, refreshed);
          return refreshed.pagesByRequestCursor.get(null)!.response;
        }
      }
      return this.getFrozenPagedPage(existing, args.sessionId, args.limit, args.cursor, args.loadFrozenPage);
    }
    if (existing?.mode === "materialized") {
      if (!args.cursor) {
        const upgraded = this.createFrozenPagedSnapshot(
          args.sessionId,
          args.limit,
          args.loadFrozenPage,
        );
        if (upgraded) {
          this.snapshots.set(args.sessionId, upgraded);
          return upgraded.pagesByRequestCursor.get(null)!.response;
        }
      }
      return this.getMaterializedPage(existing, args.sessionId, args.limit, args.cursor);
    }

    const created = this.createFrozenPagedSnapshot(
      args.sessionId,
      args.limit,
      args.loadFrozenPage,
    );
    if (created) {
      this.snapshots.set(args.sessionId, created);
      return created.pagesByRequestCursor.get(null)!.response;
    }

    const materialized: MaterializedHistorySnapshot = {
      mode: "materialized",
      events: normalizeSnapshotEvents(args.loadEvents()),
    };
    this.snapshots.set(args.sessionId, materialized);
    return this.getMaterializedPage(materialized, args.sessionId, args.limit, args.cursor);
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

  findCachedEvents(
    sessionId: string,
    predicate: (event: RahEvent) => boolean,
  ): RahEvent[] {
    const snapshot = this.snapshots.get(sessionId);
    if (!snapshot) {
      return [];
    }
    const matches = new Map<string, RahEvent>();
    const collect = (events: readonly RahEvent[]) => {
      for (const event of events) {
        if (predicate(event)) {
          matches.set(event.id, event);
        }
      }
    };
    if (snapshot.mode === "materialized") {
      collect(snapshot.events);
    } else {
      for (const cachedPage of snapshot.pagesByRequestCursor.values()) {
        collect(cachedPage.response.events);
      }
    }
    return [...matches.values()].sort((left, right) => left.ts.localeCompare(right.ts) || left.seq - right.seq);
  }

  private createFrozenPagedSnapshot(
    sessionId: string,
    limitValue: number | undefined,
    loadFrozenPage: (() => FrozenHistoryPageLoader | undefined) | undefined,
  ): FrozenPagedHistorySnapshot | null {
    const frozenLoader = loadFrozenPage?.();
    if (!frozenLoader) {
      return null;
    }
    const limit = normalizeHistoryPageLimit(limitValue);
    const initial = frozenLoader.loadInitialPage(limit);
    const initialEvents = normalizeTranscriptEvents(
      reanchorFrozenPageEvents({
        sessionId,
        requestCursor: null,
        events: initial.events,
      }),
    );
    const initialNextBeforeTs = paginationTimestamp(initial.nextCursor, initialEvents);
    return {
      mode: "frozen_paged",
      boundary: initial.boundary,
      loader: frozenLoader,
      pagesByRequestCursor: new Map([
        [
          null,
          {
            requestCursor: null,
            limit,
            response: {
              sessionId,
              events: initialEvents,
              ...(initial.nextCursor ? { nextCursor: initial.nextCursor } : {}),
              ...(initialNextBeforeTs ? { nextBeforeTs: initialNextBeforeTs } : {}),
            },
          },
        ],
      ]),
    };
  }

  private getMaterializedPage(
    snapshot: MaterializedHistorySnapshot,
    sessionId: string,
    limitValue?: number,
    cursor?: string,
  ): SessionHistoryPageResponse {
    const limit = normalizeHistoryPageLimit(limitValue);
    const endExclusive = cursor ? decodeOffsetCursor(cursor) : snapshot.events.length;
    const boundedEndExclusive = Math.max(0, Math.min(endExclusive, snapshot.events.length));
    const start = Math.max(0, boundedEndExclusive - limit);
    const events = snapshot.events.slice(start, boundedEndExclusive);
    const nextCursor = start > 0 ? encodeOffsetCursor(start) : undefined;
    const nextBeforeTs = paginationTimestamp(nextCursor, events);
    return {
      sessionId,
      events,
      ...(nextCursor ? { nextCursor } : {}),
      ...(nextBeforeTs ? { nextBeforeTs } : {}),
    };
  }

  private getFrozenPagedPage(
    snapshot: FrozenPagedHistorySnapshot,
    sessionId: string,
    limitValue: number | undefined,
    cursor: string | undefined,
    _loadFrozenPage: (() => FrozenHistoryPageLoader | undefined) | undefined,
  ): SessionHistoryPageResponse {
    const requestCursor = cursor ?? null;
    const limit = normalizeHistoryPageLimit(limitValue);
    const cached = snapshot.pagesByRequestCursor.get(requestCursor);
    if (cached && cached.limit === limit) {
      return cached.response;
    }
    const page =
      cursor !== undefined
        ? snapshot.loader.loadOlderPage(cursor, limit, snapshot.boundary)
        : snapshot.loader.loadInitialPage(limit);
    if (page.boundary.sourceRevision !== snapshot.boundary.sourceRevision) {
      throw new Error("Frozen history source revision changed while paging older history.");
    }
    const events = normalizeTranscriptEvents(
      reanchorFrozenPageEvents({
        sessionId,
        requestCursor,
        events: page.events,
      }),
    );
    const nextBeforeTs = paginationTimestamp(page.nextCursor, events);
    const response: SessionHistoryPageResponse = {
      sessionId,
      events,
      ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
      ...(nextBeforeTs ? { nextBeforeTs } : {}),
    };
    snapshot.pagesByRequestCursor.set(requestCursor, {
      requestCursor,
      limit,
      response,
    });
    return response;
  }
}

import type {
  ConversationOutputProjection,
  ConversationResourceIndexResponse,
  ConversationSourceProjection,
  ConversationTurnDetailResponse,
  ConversationTurnProjection,
  ConversationTurnsPageResponse,
} from "@rah/runtime-protocol";
import { approximateJsonByteLength } from "./bounded-json-size";

type ConversationResourceFields = Pick<
  ConversationResourceIndexResponse,
  "outputs" | "sources"
>;

type ResourceIndexLoadOptions = {
  sessionId: string;
  sourceRevision: string;
  refresh?: boolean;
  readTurns: (
    cursor: string | undefined,
  ) => Promise<ConversationTurnsPageResponse>;
  readTurnDetail: (
    turn: ConversationTurnProjection,
  ) => Promise<ConversationTurnDetailResponse | undefined>;
};

type CachedTurnResources = {
  fingerprint: string;
  resources: ConversationResourceFields;
  detailHydrated: boolean;
};

type CacheEntry = {
  sourceRevision?: string;
  response?: ConversationResourceIndexResponse;
  promise?: Promise<ConversationResourceIndexResponse>;
  promiseRevision?: string;
  turns: Map<string, CachedTurnResources>;
};

const DEFAULT_CACHE_LIMIT = 50;
const DETAIL_CONCURRENCY = 3;
const MAX_HISTORY_PAGES = 10_000;

function earliest(left: string | undefined, right: string | undefined): string | undefined {
  if (!left) return right;
  if (!right) return left;
  return left <= right ? left : right;
}

function latest(left: string | undefined, right: string | undefined): string | undefined {
  if (!left) return right;
  if (!right) return left;
  return left >= right ? left : right;
}

function mergeSourceItemIds(left: readonly string[], right: readonly string[]): string[] {
  return [...new Set([...left, ...right])];
}

function mergeOutputs(
  current: readonly ConversationOutputProjection[],
  incoming: readonly ConversationOutputProjection[],
): ConversationOutputProjection[] {
  const byId = new Map(current.map((resource) => [resource.id, resource]));
  for (const resource of incoming) {
    const existing = byId.get(resource.id);
    if (!existing) {
      byId.set(resource.id, resource);
      continue;
    }
    const firstSeenAt = earliest(existing.firstSeenAt, resource.firstSeenAt);
    const lastSeenAt = latest(existing.lastSeenAt, resource.lastSeenAt);
    byId.set(resource.id, {
      ...existing,
      ...resource,
      confidence:
        existing.confidence === "authoritative" || resource.confidence === "authoritative"
          ? "authoritative"
          : "inferred",
      sourceItemIds: mergeSourceItemIds(existing.sourceItemIds, resource.sourceItemIds),
      ...(firstSeenAt ? { firstSeenAt } : {}),
      ...(lastSeenAt ? { lastSeenAt } : {}),
    });
  }
  return [...byId.values()].sort((left, right) =>
    (left.firstSeenAt ?? "").localeCompare(right.firstSeenAt ?? "") ||
    left.label.localeCompare(right.label) ||
    left.id.localeCompare(right.id),
  );
}

function mergeSources(
  current: readonly ConversationSourceProjection[],
  incoming: readonly ConversationSourceProjection[],
): ConversationSourceProjection[] {
  const byId = new Map(current.map((resource) => [resource.id, resource]));
  for (const resource of incoming) {
    const existing = byId.get(resource.id);
    if (!existing) {
      byId.set(resource.id, resource);
      continue;
    }
    const firstSeenAt = earliest(existing.firstSeenAt, resource.firstSeenAt);
    const lastSeenAt = latest(existing.lastSeenAt, resource.lastSeenAt);
    byId.set(resource.id, {
      ...existing,
      ...resource,
      activities: [...new Set([...existing.activities, ...resource.activities])],
      confidence:
        existing.confidence === "authoritative" || resource.confidence === "authoritative"
          ? "authoritative"
          : "inferred",
      sourceItemIds: mergeSourceItemIds(existing.sourceItemIds, resource.sourceItemIds),
      ...(firstSeenAt ? { firstSeenAt } : {}),
      ...(lastSeenAt ? { lastSeenAt } : {}),
    });
  }
  return [...byId.values()].sort((left, right) =>
    (left.firstSeenAt ?? "").localeCompare(right.firstSeenAt ?? "") ||
    left.label.localeCompare(right.label) ||
    left.id.localeCompare(right.id),
  );
}

function turnKey(turn: ConversationTurnProjection): string {
  return turn.providerTurnId ?? turn.id;
}

function resourcesFromTurn(turn: ConversationTurnProjection): ConversationResourceFields {
  return {
    outputs: [...(turn.outputs ?? [])],
    sources: [...(turn.sources ?? [])],
  };
}

function turnFingerprint(turn: ConversationTurnProjection): string {
  // Summary turns are intentionally compact, so hashing their complete transport
  // shape is cheap and avoids coupling invalidation to provider-specific fields.
  return JSON.stringify(turn);
}

function mostRecentHydratableTurnKey(
  turns: readonly ConversationTurnProjection[],
): string | undefined {
  let selected: ConversationTurnProjection | undefined;
  let selectedAt = "";
  for (const turn of turns) {
    if (turn.itemsView === "full" || !turn.providerTurnId) continue;
    const candidateAt = turn.completedAt ?? turn.startedAt ?? "";
    if (!selected || candidateAt > selectedAt) {
      selected = turn;
      selectedAt = candidateAt;
    }
  }
  return selected ? turnKey(selected) : undefined;
}

function aggregateTurnResources(
  resourcesByTurn: ReadonlyMap<string, ConversationResourceFields>,
): ConversationResourceFields {
  let outputs: ConversationOutputProjection[] = [];
  let sources: ConversationSourceProjection[] = [];
  for (const resources of resourcesByTurn.values()) {
    outputs = mergeOutputs(outputs, resources.outputs);
    sources = mergeSources(sources, resources.sources);
  }
  return { outputs, sources };
}

async function hydrateChangedTurns(args: {
  turns: readonly ConversationTurnProjection[];
  indexedTurns: Map<string, CachedTurnResources>;
  readTurnDetail: ResourceIndexLoadOptions["readTurnDetail"];
}): Promise<number> {
  let unavailable = 0;
  let cursor = 0;
  const worker = async () => {
    while (cursor < args.turns.length) {
      const turn = args.turns[cursor++];
      if (!turn?.providerTurnId) continue;
      try {
        const detail = await args.readTurnDetail(turn);
        if (!detail) {
          unavailable += 1;
          continue;
        }
        args.indexedTurns.set(turnKey(turn), {
          fingerprint: turnFingerprint(turn),
          resources: resourcesFromTurn(detail.turn),
          detailHydrated: true,
        });
      } catch {
        // Retain any resource metadata that was available on the summary.
        unavailable += 1;
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(DETAIL_CONCURRENCY, args.turns.length) }, () => worker()),
  );
  return unavailable;
}

async function buildResourceIndex(args: {
  options: ResourceIndexLoadOptions;
  previousSourceRevision?: string;
  previousTurns: ReadonlyMap<string, CachedTurnResources>;
}): Promise<{
  response: ConversationResourceIndexResponse;
  turns: Map<string, CachedTurnResources>;
}> {
  const { options } = args;
  const observedTurns = new Map<string, ConversationTurnProjection>();
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  let unavailableDetailCount = 0;
  let pagingIncomplete = false;

  for (let pageIndex = 0; pageIndex < MAX_HISTORY_PAGES; pageIndex += 1) {
    const page = await options.readTurns(cursor);
    for (const turn of page.turns) {
      const key = turnKey(turn);
      const existing = observedTurns.get(key);
      if (!existing || (existing.itemsView !== "full" && turn.itemsView === "full")) {
        observedTurns.set(key, turn);
      }
    }
    if (!page.nextCursor) {
      cursor = undefined;
      break;
    }
    if (seenCursors.has(page.nextCursor)) {
      pagingIncomplete = true;
      cursor = undefined;
      break;
    }
    seenCursors.add(page.nextCursor);
    cursor = page.nextCursor;
    if (pageIndex === MAX_HISTORY_PAGES - 1) {
      pagingIncomplete = true;
    }
  }

  // If paging reached a stable end, starting from an empty map also removes
  // resources belonging to turns deleted by a rewrite/truncation. On an
  // incomplete scan, retain unseen prior turns rather than returning a
  // silently truncated index; the response is marked incomplete below.
  const indexedTurns = pagingIncomplete
    ? new Map(args.previousTurns)
    : new Map<string, CachedTurnResources>();
  const changedSource = args.previousSourceRevision !== options.sourceRevision;
  const observed = [...observedTurns.values()];
  const mostRecentKey = mostRecentHydratableTurnKey(observed);
  const turnsToHydrate: ConversationTurnProjection[] = [];

  for (const turn of observed) {
    const key = turnKey(turn);
    const fingerprint = turnFingerprint(turn);
    const summaryResources = resourcesFromTurn(turn);
    if (turn.itemsView === "full") {
      indexedTurns.set(key, {
        fingerprint,
        resources: summaryResources,
        detailHydrated: true,
      });
      continue;
    }

    const previous = args.previousTurns.get(key);
    const revalidateActiveTail =
      changedSource && (turn.status === "in_progress" || key === mostRecentKey);
    if (
      !options.refresh &&
      !revalidateActiveTail &&
      previous?.detailHydrated &&
      previous.fingerprint === fingerprint
    ) {
      indexedTurns.set(key, previous);
      continue;
    }

    indexedTurns.set(key, {
      fingerprint,
      resources: summaryResources,
      detailHydrated: false,
    });
    if (turn.providerTurnId) {
      turnsToHydrate.push(turn);
    }
  }

  unavailableDetailCount += await hydrateChangedTurns({
    turns: turnsToHydrate,
    indexedTurns,
    readTurnDetail: options.readTurnDetail,
  });

  const resourcesByTurn = new Map(
    [...indexedTurns].map(([key, value]) => [key, value.resources]),
  );
  const resources = aggregateTurnResources(resourcesByTurn);
  const warnings: string[] = [];
  if (unavailableDetailCount > 0) {
    warnings.push(
      `${unavailableDetailCount} historical turn detail${
        unavailableDetailCount === 1 ? " was" : "s were"
      } unavailable; summary resources were retained.`,
    );
  }
  if (pagingIncomplete) {
    warnings.push("Historical resource paging stopped before reaching a stable end cursor.");
  }
  const response: ConversationResourceIndexResponse = {
    sessionId: options.sessionId,
    sourceRevision: options.sourceRevision,
    outputs: resources.outputs,
    sources: resources.sources,
    complete: warnings.length === 0,
    generatedAt: new Date().toISOString(),
    ...(warnings.length > 0 ? { warning: warnings.join(" ") } : {}),
  };
  response.approximateBytes = approximateJsonByteLength(response);
  return { response, turns: indexedTurns };
}

export class ConversationResourceIndexStore {
  private readonly cache = new Map<string, CacheEntry>();

  constructor(private readonly cacheLimit = DEFAULT_CACHE_LIMIT) {}

  async load(options: ResourceIndexLoadOptions): Promise<ConversationResourceIndexResponse> {
    let entry = this.cache.get(options.sessionId);
    if (entry) {
      this.cache.delete(options.sessionId);
      this.cache.set(options.sessionId, entry);
      if (entry.promise) {
        if (entry.promiseRevision === options.sourceRevision) {
          return entry.promise;
        }
        try {
          await entry.promise;
        } catch {
          // The new revision still deserves its own attempt.
        }
        return this.load(options);
      }
      if (
        entry.response &&
        entry.sourceRevision === options.sourceRevision &&
        !options.refresh
      ) {
        return entry.response;
      }
    } else {
      entry = { turns: new Map() };
      this.cache.set(options.sessionId, entry);
      this.trim();
    }

    const activeEntry = entry;
    const previousSourceRevision = activeEntry.sourceRevision;
    const promise = buildResourceIndex({
      options,
      ...(previousSourceRevision ? { previousSourceRevision } : {}),
      previousTurns: activeEntry.turns,
    })
      .then((result) => {
        activeEntry.sourceRevision = options.sourceRevision;
        activeEntry.response = result.response;
        activeEntry.turns = result.turns;
        return result.response;
      })
      .finally(() => {
        if (activeEntry.promise === promise) {
          delete activeEntry.promise;
          delete activeEntry.promiseRevision;
        }
      });
    activeEntry.promise = promise;
    activeEntry.promiseRevision = options.sourceRevision;
    return promise;
  }

  invalidate(sessionId: string): void {
    this.cache.delete(sessionId);
  }

  clear(): void {
    this.cache.clear();
  }

  private trim(): void {
    while (this.cache.size > this.cacheLimit) {
      const oldestKey = this.cache.keys().next().value as string | undefined;
      if (!oldestKey) return;
      this.cache.delete(oldestKey);
    }
  }
}

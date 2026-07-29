import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  CONVERSATION_RESOURCE_INDEX_PROTOCOL_VERSION,
  type ConversationOutputProjection,
  type ConversationResourceIndexResponse,
  type ConversationSourceProjection,
  type ConversationTurnDetailResponse,
  type ConversationTurnProjection,
  type ConversationTurnsPageResponse,
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
  progressive?: boolean;
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

type PersistedResourceIndex = {
  version: typeof PERSISTED_INDEX_VERSION;
  sessionId: string;
  sourceRevision: string;
  response: ConversationResourceIndexResponse;
  turns: Array<[string, CachedTurnResources]>;
};

export type ConversationResourceIndexStoreOptions = {
  cacheLimit?: number;
  persistenceRoot?: string | false;
  maxDiskBytes?: number;
  maxDiskEntries?: number;
  maxPersistedEntryBytes?: number;
};

const DEFAULT_CACHE_LIMIT = 50;
const DEFAULT_MAX_DISK_BYTES = 256 * 1024 * 1024;
const DEFAULT_MAX_DISK_ENTRIES = 100;
const DEFAULT_MAX_PERSISTED_ENTRY_BYTES = 64 * 1024 * 1024;
const PERSISTED_INDEX_VERSION = 2;
const DETAIL_CONCURRENCY = 3;
const MAX_HISTORY_PAGES = 10_000;
const URL_PATTERN = /\bhttps?:\/\/[^\s<>"')\]]+/i;
const LOCAL_MARKDOWN_LINK_PATTERN = /\[[^\]]+\]\((?:\/|~\/|[A-Za-z]:[\\/])[^)]+\)/;
const CODEX_ATTACHMENT_PREAMBLE = "# Files mentioned by the user:";
const CODEX_IMAGE_REFERENCE = "<image ";

function resolvePersistenceRoot(): string {
  const runtimeHome =
    process.env.RAH_HOME ?? path.join(os.homedir(), ".rah", "runtime-daemon");
  return path.join(runtimeHome, "conversation-resource-index");
}

function cacheFileName(sessionId: string): string {
  return `${createHash("sha256").update(sessionId).digest("hex")}.json`;
}

function isConversationResourceFields(
  value: unknown,
): value is ConversationResourceFields {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Partial<ConversationResourceFields>;
  return Array.isArray(candidate.outputs) && Array.isArray(candidate.sources);
}

function isConversationResourceIndexResponse(
  value: unknown,
): value is ConversationResourceIndexResponse {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Partial<ConversationResourceIndexResponse>;
  return (
    candidate.protocolVersion ===
      CONVERSATION_RESOURCE_INDEX_PROTOCOL_VERSION &&
    typeof candidate.sessionId === "string" &&
    typeof candidate.sourceRevision === "string" &&
    Array.isArray(candidate.outputs) &&
    Array.isArray(candidate.sources) &&
    typeof candidate.complete === "boolean" &&
    typeof candidate.generatedAt === "string"
  );
}

function isCachedTurnResources(value: unknown): value is CachedTurnResources {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Partial<CachedTurnResources>;
  return (
    typeof candidate.fingerprint === "string" &&
    typeof candidate.detailHydrated === "boolean" &&
    isConversationResourceFields(candidate.resources)
  );
}

function parsePersistedResourceIndex(
  value: unknown,
  expectedSessionId: string,
): PersistedResourceIndex | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const candidate = value as Partial<PersistedResourceIndex>;
  if (
    candidate.version !== PERSISTED_INDEX_VERSION ||
    candidate.sessionId !== expectedSessionId ||
    typeof candidate.sourceRevision !== "string" ||
    !isConversationResourceIndexResponse(candidate.response) ||
    candidate.response.sessionId !== expectedSessionId ||
    candidate.response.sourceRevision !== candidate.sourceRevision ||
    candidate.response.stable !== true ||
    candidate.response.indexing === true ||
    !Array.isArray(candidate.turns)
  ) {
    return undefined;
  }
  const turns: Array<[string, CachedTurnResources]> = [];
  for (const entry of candidate.turns) {
    if (
      !Array.isArray(entry) ||
      entry.length !== 2 ||
      typeof entry[0] !== "string" ||
      !isCachedTurnResources(entry[1])
    ) {
      return undefined;
    }
    turns.push([entry[0], entry[1]]);
  }
  return {
    version: PERSISTED_INDEX_VERSION,
    sessionId: expectedSessionId,
    sourceRevision: candidate.sourceRevision,
    response: candidate.response,
    turns,
  };
}

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

/**
 * Detail hydration is the expensive part of indexing large provider histories.
 * The summary already retains enough provider-neutral signals to find turns
 * that are likely to reveal Sources or Outputs without guessing the resources
 * themselves. Prioritising those turns only changes scheduling; the full turn
 * projector remains the sole authority for what enters either index.
 */
function resourceHydrationPriority(turn: ConversationTurnProjection): number {
  let priority = 0;

  for (const activity of turn.activities) {
    if (activity.totalCount <= 0) continue;
    if (activity.kind === "web" || activity.kind === "search") {
      priority = Math.max(priority, 400);
    } else if (activity.kind === "file_change") {
      priority = Math.max(priority, 100);
    }
  }

  for (const item of turn.items) {
    if (item.content.kind !== "timeline") continue;
    const timeline = item.content.item;
    if (timeline.kind === "attachment") {
      priority = Math.max(priority, 500);
      continue;
    }
    if (timeline.kind === "user_message") {
      if (
        (timeline.imageCount ?? 0) > 0 ||
        (timeline.attachments?.length ?? 0) > 0 ||
        timeline.text.includes(CODEX_ATTACHMENT_PREAMBLE) ||
        timeline.text.includes(CODEX_IMAGE_REFERENCE)
      ) {
        priority = Math.max(priority, 500);
      } else if (URL_PATTERN.test(timeline.text)) {
        priority = Math.max(priority, 350);
      }
      continue;
    }
    if (
      timeline.kind === "assistant_message" &&
      timeline.phase === "final_answer"
    ) {
      if (URL_PATTERN.test(timeline.text)) {
        priority = Math.max(priority, 300);
      } else if (LOCAL_MARKDOWN_LINK_PATTERN.test(timeline.text)) {
        priority = Math.max(priority, 200);
      }
    }
  }

  return priority;
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

  const responseFromIndexedTurns = (options: {
    indexing: boolean;
    warnings?: readonly string[];
  }): ConversationResourceIndexResponse => {
    const resourcesByTurn = new Map(
      [...indexedTurns].map(([key, value]) => [key, value.resources]),
    );
    const resources = aggregateTurnResources(resourcesByTurn);
    const warnings = [...(options.warnings ?? [])];
    const response: ConversationResourceIndexResponse = {
      protocolVersion: CONVERSATION_RESOURCE_INDEX_PROTOCOL_VERSION,
      sessionId: args.options.sessionId,
      sourceRevision: args.options.sourceRevision,
      outputs: resources.outputs,
      sources: resources.sources,
      ...(!options.indexing ? { stable: true } : {}),
      ...(options.indexing ? { indexing: true } : {}),
      complete: !options.indexing && warnings.length === 0,
      generatedAt: new Date().toISOString(),
      ...(warnings.length > 0 ? { warning: warnings.join(" ") } : {}),
    };
    response.approximateBytes = approximateJsonByteLength(response);
    return response;
  };

  // Hydration ordering is an internal scheduling concern. The map below is a
  // working copy and is committed only after every selected turn settles.
  // Publishing individual completions made Inspector counts climb and older
  // resources jump into the middle of a visible list.
  turnsToHydrate.sort((left, right) => {
    const priorityDifference =
      resourceHydrationPriority(right) - resourceHydrationPriority(left);
    if (priorityDifference !== 0) return priorityDifference;
    return (right.completedAt ?? right.startedAt ?? "").localeCompare(
      left.completedAt ?? left.startedAt ?? "",
    );
  });
  unavailableDetailCount += await hydrateChangedTurns({
    turns: turnsToHydrate,
    indexedTurns,
    readTurnDetail: options.readTurnDetail,
  });

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
  const response = responseFromIndexedTurns({ indexing: false, warnings });
  return { response, turns: indexedTurns };
}

export class ConversationResourceIndexStore {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly restorePromises = new Map<
    string,
    Promise<CacheEntry | undefined>
  >();
  private readonly cacheLimit: number;
  private readonly persistenceRoot: string | false;
  private readonly maxDiskBytes: number;
  private readonly maxDiskEntries: number;
  private readonly maxPersistedEntryBytes: number;
  private prunePromise?: Promise<void>;

  constructor(
    options: number | ConversationResourceIndexStoreOptions = {},
  ) {
    const normalized =
      typeof options === "number" ? { cacheLimit: options } : options;
    this.cacheLimit = normalized.cacheLimit ?? DEFAULT_CACHE_LIMIT;
    this.persistenceRoot =
      normalized.persistenceRoot === undefined
        ? resolvePersistenceRoot()
        : normalized.persistenceRoot;
    this.maxDiskBytes =
      normalized.maxDiskBytes ?? DEFAULT_MAX_DISK_BYTES;
    this.maxDiskEntries =
      normalized.maxDiskEntries ?? DEFAULT_MAX_DISK_ENTRIES;
    this.maxPersistedEntryBytes =
      normalized.maxPersistedEntryBytes ??
      DEFAULT_MAX_PERSISTED_ENTRY_BYTES;
  }

  async load(options: ResourceIndexLoadOptions): Promise<ConversationResourceIndexResponse> {
    let entry = await this.getOrCreateEntry(options.sessionId);
    if (entry.response || entry.promise || entry.sourceRevision) {
      if (entry.promise) {
        // Provider history can continue changing while another surface (for
        // example Codex Desktop) owns the live turn. A progressive HTTP read
        // must never join the older batch as a completion barrier, even when
        // its observed revision has already advanced. Return the latest
        // coherent snapshot now; a later poll starts incremental catch-up
        // after this batch settles.
        if (options.progressive && entry.response) {
          return entry.response;
        }
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
    }

    const activeEntry = entry;
    const previousSourceRevision = activeEntry.sourceRevision;
    const previousStableResponse =
      activeEntry.response?.stable === true
        ? activeEntry.response
        : undefined;
    if (options.progressive) {
      activeEntry.response = previousStableResponse
        ? {
            ...previousStableResponse,
            stable: true,
            indexing: true,
          }
        : {
            protocolVersion: CONVERSATION_RESOURCE_INDEX_PROTOCOL_VERSION,
            sessionId: options.sessionId,
            sourceRevision: options.sourceRevision,
            outputs: [],
            sources: [],
            indexing: true,
            complete: false,
            generatedAt: new Date().toISOString(),
          };
      activeEntry.response.approximateBytes = approximateJsonByteLength(
        activeEntry.response,
      );
    }
    const promise = buildResourceIndex({
      options,
      ...(previousSourceRevision ? { previousSourceRevision } : {}),
      previousTurns: activeEntry.turns,
    })
      .then(async (result) => {
        await this.persistStableEntry(options.sessionId, {
          sourceRevision: options.sourceRevision,
          response: result.response,
          turns: result.turns,
        });
        activeEntry.sourceRevision = options.sourceRevision;
        activeEntry.response = result.response;
        activeEntry.turns = result.turns;
        return result.response;
      })
      .catch((error) => {
        if (!options.progressive) {
          throw error;
        }
        const failureWarning = `Historical resource indexing failed: ${
          error instanceof Error ? error.message : String(error)
        }`;
        const response: ConversationResourceIndexResponse =
          previousStableResponse
            ? {
                ...previousStableResponse,
                stable: true,
                warning: previousStableResponse.warning
                  ? `${previousStableResponse.warning} ${failureWarning}`
                  : failureWarning,
                generatedAt: new Date().toISOString(),
              }
            : {
                protocolVersion:
                  CONVERSATION_RESOURCE_INDEX_PROTOCOL_VERSION,
                sessionId: options.sessionId,
                sourceRevision: options.sourceRevision,
                outputs: [],
                sources: [],
                stable: true,
                complete: false,
                generatedAt: new Date().toISOString(),
                warning: failureWarning,
              };
        delete response.indexing;
        response.approximateBytes = approximateJsonByteLength(response);
        activeEntry.response = response;
        return response;
      })
      .finally(() => {
        if (activeEntry.promise === promise) {
          delete activeEntry.promise;
          delete activeEntry.promiseRevision;
        }
      });
    activeEntry.promise = promise;
    activeEntry.promiseRevision = options.sourceRevision;
    return options.progressive && activeEntry.response
      ? activeEntry.response
      : promise;
  }

  invalidate(sessionId: string): void {
    this.cache.delete(sessionId);
    this.restorePromises.delete(sessionId);
  }

  clear(): void {
    this.cache.clear();
    this.restorePromises.clear();
  }

  private async getOrCreateEntry(sessionId: string): Promise<CacheEntry> {
    const cached = this.cache.get(sessionId);
    if (cached) {
      this.touch(sessionId, cached);
      return cached;
    }

    let restorePromise = this.restorePromises.get(sessionId);
    if (!restorePromise) {
      restorePromise = this.restoreEntry(sessionId).finally(() => {
        if (this.restorePromises.get(sessionId) === restorePromise) {
          this.restorePromises.delete(sessionId);
        }
      });
      this.restorePromises.set(sessionId, restorePromise);
    }
    const restored = await restorePromise;
    const concurrentlyCreated = this.cache.get(sessionId);
    if (concurrentlyCreated) {
      this.touch(sessionId, concurrentlyCreated);
      return concurrentlyCreated;
    }
    const entry = restored ?? { turns: new Map<string, CachedTurnResources>() };
    this.cache.set(sessionId, entry);
    this.trim();
    return entry;
  }

  private touch(sessionId: string, entry: CacheEntry): void {
    this.cache.delete(sessionId);
    this.cache.set(sessionId, entry);
  }

  private cachePath(sessionId: string): string | undefined {
    if (this.persistenceRoot === false) return undefined;
    return path.join(this.persistenceRoot, cacheFileName(sessionId));
  }

  private async restoreEntry(sessionId: string): Promise<CacheEntry | undefined> {
    const cachePath = this.cachePath(sessionId);
    if (!cachePath) return undefined;
    try {
      const fileStats = await stat(cachePath);
      if (fileStats.size > this.maxPersistedEntryBytes) {
        return undefined;
      }
      const parsed = parsePersistedResourceIndex(
        JSON.parse(await readFile(cachePath, "utf8")),
        sessionId,
      );
      if (!parsed) return undefined;
      const response = {
        ...parsed.response,
        stable: true,
      };
      delete response.indexing;
      response.approximateBytes = approximateJsonByteLength(response);
      return {
        sourceRevision: parsed.sourceRevision,
        response,
        turns: new Map(parsed.turns),
      };
    } catch {
      // A missing, obsolete, or partially written cache is a cold-cache miss.
      return undefined;
    }
  }

  private async persistStableEntry(
    sessionId: string,
    entry: {
      sourceRevision: string;
      response: ConversationResourceIndexResponse;
      turns: ReadonlyMap<string, CachedTurnResources>;
    },
  ): Promise<void> {
    const cachePath = this.cachePath(sessionId);
    if (!cachePath) return;
    const envelope: PersistedResourceIndex = {
      version: PERSISTED_INDEX_VERSION,
      sessionId,
      sourceRevision: entry.sourceRevision,
      response: entry.response,
      turns: [...entry.turns],
    };
    let body = `${JSON.stringify(envelope)}\n`;
    if (Buffer.byteLength(body, "utf8") > this.maxPersistedEntryBytes) {
      // The coherent Inspector snapshot remains more valuable than the
      // per-turn acceleration data. Persist it even when an unusually large
      // history cannot fit inside the bounded incremental cache envelope.
      envelope.turns = [];
      body = `${JSON.stringify(envelope)}\n`;
    }
    if (Buffer.byteLength(body, "utf8") > this.maxPersistedEntryBytes) {
      return;
    }

    let temporaryPath: string | undefined;
    try {
      await mkdir(path.dirname(cachePath), { recursive: true, mode: 0o700 });
      temporaryPath = `${cachePath}.${process.pid}.${randomUUID()}.tmp`;
      await writeFile(temporaryPath, body, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      await rename(temporaryPath, cachePath);
      temporaryPath = undefined;
      this.schedulePruneDisk();
    } catch {
      if (temporaryPath) {
        await rm(temporaryPath, { force: true }).catch(() => {});
      }
      // Persistence is an acceleration layer. The completed in-memory index
      // remains authoritative when the cache directory is unavailable.
    }
  }

  private schedulePruneDisk(): void {
    if (this.persistenceRoot === false || this.prunePromise) return;
    this.prunePromise = this.pruneDisk().finally(() => {
      delete this.prunePromise;
    });
  }

  private async pruneDisk(): Promise<void> {
    if (this.persistenceRoot === false) return;
    try {
      const directoryEntries = await readdir(this.persistenceRoot, {
        withFileTypes: true,
      });
      const files = (
        await Promise.all(
          directoryEntries
            .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
            .map(async (entry) => {
              const filePath = path.join(this.persistenceRoot as string, entry.name);
              const fileStats = await stat(filePath);
              return {
                filePath,
                bytes: fileStats.size,
                mtimeMs: fileStats.mtimeMs,
              };
            }),
        )
      ).sort((left, right) => right.mtimeMs - left.mtimeMs);
      let retainedBytes = 0;
      await Promise.all(
        files.map(async (file, index) => {
          retainedBytes += file.bytes;
          if (
            index >= this.maxDiskEntries ||
            retainedBytes > this.maxDiskBytes
          ) {
            await rm(file.filePath, { force: true });
          }
        }),
      );
    } catch {
      // Retention failure must not affect the resource-index request.
    }
  }

  private trim(): void {
    while (this.cache.size > this.cacheLimit) {
      const oldestKey = this.cache.keys().next().value as string | undefined;
      if (!oldestKey) return;
      this.cache.delete(oldestKey);
    }
  }
}

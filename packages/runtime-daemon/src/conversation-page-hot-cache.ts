import type { ConversationTurnsPageResponse } from "@rah/runtime-protocol";
import { approximateJsonByteLength } from "./bounded-json-size";

const DEFAULT_MAX_ENTRY_BYTES = 1024 * 1024;
const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_ENTRIES = 128;
const DEFAULT_MAX_AGE_MS = 30 * 60 * 1000;

type ConversationPageHotCacheEntry = {
  bytes: number;
  cachedAt: number;
  liveRevision: number;
  response: ConversationTurnsPageResponse;
  sourceRevision: string;
};

export type ConversationPageHotCacheAddress = {
  sessionId: string;
  cursor?: string;
  limit: number;
};

export type ConversationPageHotCacheVersion = {
  sourceRevision: string;
  liveRevision: number;
};

export type ConversationPageHotCacheOptions = {
  maxEntryBytes?: number;
  maxBytes?: number;
  maxEntries?: number;
  maxAgeMs?: number;
  now?: () => number;
};

function addressKey(address: ConversationPageHotCacheAddress): string {
  return JSON.stringify([
    address.sessionId,
    address.cursor ?? null,
    address.limit,
  ]);
}

function hasTransientConversationState(
  response: ConversationTurnsPageResponse,
): boolean {
  return response.turns.some(
    (turn) =>
      turn.status === "in_progress" ||
      turn.items.some(
        (item) => item.status === "pending" || item.status === "running",
      ),
  );
}

/**
 * Bounded daemon-owned cache for already materialized conversation pages.
 *
 * Entries are reusable only when both the provider-owned source revision and
 * the resident live revision still match. This makes a cache hit an exact
 * baseline, not a stale browser preview that later deltas must guess how to
 * repair. Browser reloads keep this memory because they do not restart the
 * daemon; daemon restarts simply fall back to the provider-owned history.
 */
export class ConversationPageHotCache {
  private readonly entries = new Map<string, ConversationPageHotCacheEntry>();
  private readonly maxEntryBytes: number;
  private readonly maxBytes: number;
  private readonly maxEntries: number;
  private readonly maxAgeMs: number;
  private readonly now: () => number;
  private totalBytes = 0;

  constructor(options: ConversationPageHotCacheOptions = {}) {
    this.maxEntryBytes = Math.max(
      1,
      options.maxEntryBytes ?? DEFAULT_MAX_ENTRY_BYTES,
    );
    this.maxBytes = Math.max(1, options.maxBytes ?? DEFAULT_MAX_BYTES);
    this.maxEntries = Math.max(1, options.maxEntries ?? DEFAULT_MAX_ENTRIES);
    this.maxAgeMs = Math.max(1, options.maxAgeMs ?? DEFAULT_MAX_AGE_MS);
    this.now = options.now ?? Date.now;
  }

  get(
    address: ConversationPageHotCacheAddress,
    version: ConversationPageHotCacheVersion,
  ): ConversationTurnsPageResponse | undefined {
    const now = this.now();
    this.pruneExpired(now);
    const key = addressKey(address);
    const entry = this.entries.get(key);
    if (!entry) {
      return undefined;
    }
    if (
      entry.sourceRevision !== version.sourceRevision ||
      entry.liveRevision !== version.liveRevision
    ) {
      this.deleteEntry(key, entry);
      return undefined;
    }
    this.entries.delete(key);
    this.entries.set(key, { ...entry, cachedAt: now });
    return entry.response;
  }

  set(
    address: ConversationPageHotCacheAddress,
    version: ConversationPageHotCacheVersion,
    response: ConversationTurnsPageResponse,
  ): void {
    const bytes = response.approximateBytes ?? approximateJsonByteLength(response);
    const key = addressKey(address);
    const previous = this.entries.get(key);
    if (previous) {
      this.deleteEntry(key, previous);
    }
    if (
      hasTransientConversationState(response) ||
      bytes > this.maxEntryBytes ||
      bytes > this.maxBytes
    ) {
      return;
    }
    const now = this.now();
    this.entries.set(key, {
      bytes,
      cachedAt: now,
      liveRevision: version.liveRevision,
      response,
      sourceRevision: version.sourceRevision,
    });
    this.totalBytes += bytes;
    this.pruneExpired(now);
    this.pruneBudget();
  }

  clearSession(sessionId: string): void {
    for (const [key, entry] of this.entries) {
      const [entrySessionId] = JSON.parse(key) as [string, string | null, number];
      if (entrySessionId === sessionId) {
        this.deleteEntry(key, entry);
      }
    }
  }

  private pruneExpired(now: number): void {
    for (const [key, entry] of this.entries) {
      if (now - entry.cachedAt <= this.maxAgeMs) {
        continue;
      }
      this.deleteEntry(key, entry);
    }
  }

  private pruneBudget(): void {
    while (
      this.entries.size > this.maxEntries ||
      this.totalBytes > this.maxBytes
    ) {
      const oldest = this.entries.entries().next().value as
        | [string, ConversationPageHotCacheEntry]
        | undefined;
      if (!oldest) {
        return;
      }
      this.deleteEntry(oldest[0], oldest[1]);
    }
  }

  private deleteEntry(key: string, entry: ConversationPageHotCacheEntry): void {
    if (!this.entries.delete(key)) {
      return;
    }
    this.totalBytes = Math.max(0, this.totalBytes - entry.bytes);
  }
}

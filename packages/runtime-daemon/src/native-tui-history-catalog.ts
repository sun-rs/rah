import type { StoredSessionCatalogProvider } from "./stored-session-catalog-types";
import type { StoredSessionCatalogRecord } from "./stored-session-catalog-types";

export interface NativeTuiHistoryCatalog {
  list(provider: StoredSessionCatalogProvider): readonly StoredSessionCatalogRecord[];
  find(
    provider: StoredSessionCatalogProvider,
    providerSessionId: string,
  ): StoredSessionCatalogRecord | undefined;
  requestRefresh(provider: StoredSessionCatalogProvider): void;
}

export const EMPTY_NATIVE_TUI_HISTORY_CATALOG: NativeTuiHistoryCatalog = {
  list: () => [],
  find: () => undefined,
  requestRefresh: () => undefined,
};

type NativeTuiHistoryCatalogIndexOptions = {
  refresh: (
    provider: StoredSessionCatalogProvider,
  ) => void | Promise<void>;
  refreshCooldownMs?: number;
  now?: () => number;
};

/**
 * Read-only, in-memory history lookup for the live native-TUI path.
 *
 * Provider discovery is intentionally absent from this class. Cache misses
 * request the existing child-process catalog refresh and return immediately,
 * so terminal output, mirror ticks, and HTTP/WebSocket work never traverse a
 * provider's history directory on the daemon event loop.
 */
export class NativeTuiHistoryCatalogIndex implements NativeTuiHistoryCatalog {
  private readonly recordsByProvider = new Map<
    StoredSessionCatalogProvider,
    readonly StoredSessionCatalogRecord[]
  >();
  private readonly recordsByIdentity = new Map<string, StoredSessionCatalogRecord>();
  private readonly refreshInFlight = new Map<
    StoredSessionCatalogProvider,
    Promise<void>
  >();
  private readonly lastRefreshRequestAt = new Map<
    StoredSessionCatalogProvider,
    number
  >();
  private readonly refreshCooldownMs: number;
  private readonly now: () => number;

  constructor(private readonly options: NativeTuiHistoryCatalogIndexOptions) {
    this.refreshCooldownMs = Math.max(
      0,
      Math.floor(options.refreshCooldownMs ?? 2_000),
    );
    this.now = options.now ?? Date.now;
  }

  replace(records: readonly StoredSessionCatalogRecord[]): void {
    for (const provider of ["codex", "claude", "opencode"] as const) {
      this.replaceProvider(
        provider,
        records.filter((record) => record.ref.provider === provider),
      );
    }
  }

  replaceProvider(
    provider: StoredSessionCatalogProvider,
    records: readonly StoredSessionCatalogRecord[],
  ): void {
    const previous = this.recordsByProvider.get(provider) ?? [];
    for (const record of previous) {
      this.recordsByIdentity.delete(this.identityKey(provider, record.ref.providerSessionId));
    }
    const next = records.filter((record) => record.ref.provider === provider);
    this.recordsByProvider.set(provider, next);
    for (const record of next) {
      this.recordsByIdentity.set(
        this.identityKey(provider, record.ref.providerSessionId),
        record,
      );
    }
  }

  list(provider: StoredSessionCatalogProvider): readonly StoredSessionCatalogRecord[] {
    return this.recordsByProvider.get(provider) ?? [];
  }

  find(
    provider: StoredSessionCatalogProvider,
    providerSessionId: string,
  ): StoredSessionCatalogRecord | undefined {
    return this.recordsByIdentity.get(this.identityKey(provider, providerSessionId));
  }

  requestRefresh(provider: StoredSessionCatalogProvider): void {
    if (this.refreshInFlight.has(provider)) {
      return;
    }
    const now = this.now();
    const lastRequestedAt = this.lastRefreshRequestAt.get(provider);
    if (
      lastRequestedAt !== undefined &&
      now - lastRequestedAt < this.refreshCooldownMs
    ) {
      return;
    }
    this.lastRefreshRequestAt.set(provider, now);
    const refresh = Promise.resolve()
      .then(() => this.options.refresh(provider))
      .then(() => undefined, () => undefined)
      .finally(() => {
        if (this.refreshInFlight.get(provider) === refresh) {
          this.refreshInFlight.delete(provider);
        }
      });
    this.refreshInFlight.set(provider, refresh);
  }

  private identityKey(
    provider: StoredSessionCatalogProvider,
    providerSessionId: string,
  ): string {
    return `${provider}\0${providerSessionId}`;
  }
}

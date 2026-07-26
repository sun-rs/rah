import type { ProviderKind, StoredSessionRef } from "@rah/runtime-protocol";

export type StoredSessionCatalogProvider = Extract<
  ProviderKind,
  "codex" | "claude" | "opencode"
>;

/**
 * Provider history metadata plus the provider-owned storage location needed to
 * open the session without rescanning the full history catalog on the main
 * thread.
 */
export type StoredSessionCatalogRecord = {
  ref: StoredSessionRef;
  storagePath: string;
  archived?: boolean;
};

export type StoredSessionCatalogProviderResult = {
  provider: StoredSessionCatalogProvider;
  records?: StoredSessionCatalogRecord[];
  /**
   * Only a complete provider scan is authoritative for removals. Partial
   * scans may still contribute upserts, but must never shrink the persisted
   * RAH catalog.
   */
  complete?: boolean;
  error?: string;
};

/**
 * Newline-delimited transfer rows used between the low-priority discovery
 * process and the daemon. Each record is independently bounded and parsed so
 * a large provider catalog never becomes one giant IPC/JSON.parse operation.
 */
export type StoredSessionCatalogTransferRow =
  | {
      kind: "record";
      provider: StoredSessionCatalogProvider;
      record: StoredSessionCatalogRecord;
    }
  | {
      kind: "provider";
      provider: StoredSessionCatalogProvider;
      complete: boolean;
      error?: string;
    };

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
  error?: string;
};

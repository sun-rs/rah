import type { StoredSessionCatalogRecord } from "./stored-session-catalog-types";

function recordIdentity(record: StoredSessionCatalogRecord): string {
  return `${record.ref.provider}:${record.ref.providerSessionId}`;
}

/**
 * A complete scan is an authoritative provider snapshot and may remove rows.
 * An incomplete scan is an upsert-only observation: new metadata is useful,
 * but absence is not evidence that a provider session was deleted.
 */
export function reconcileStoredSessionCatalogRecords(args: {
  current: readonly StoredSessionCatalogRecord[];
  incoming: readonly StoredSessionCatalogRecord[];
  complete: boolean;
}): StoredSessionCatalogRecord[] {
  if (args.complete) {
    return [...args.incoming];
  }
  const byIdentity = new Map(
    args.current.map((record) => [recordIdentity(record), record] as const),
  );
  for (const record of args.incoming) {
    byIdentity.set(recordIdentity(record), record);
  }
  return [...byIdentity.values()];
}

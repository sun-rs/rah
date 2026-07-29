import type { StoredSessionCatalogRecord } from "./stored-session-catalog-types";

function recordIdentity(record: StoredSessionCatalogRecord): string {
  return `${record.ref.provider}:${record.ref.providerSessionId}`;
}

function recordTimestamp(record: StoredSessionCatalogRecord): number {
  for (const value of [
    record.ref.lastUsedAt,
    record.ref.updatedAt,
    record.ref.createdAt,
  ]) {
    if (!value) continue;
    const timestamp = Date.parse(value);
    if (Number.isFinite(timestamp)) {
      return timestamp;
    }
  }
  return Number.NEGATIVE_INFINITY;
}

function recordIsArchived(record: StoredSessionCatalogRecord): boolean {
  return (
    record.archived === true ||
    record.ref.providerState?.archived === true ||
    record.ref.libraryState?.placement === "archive"
  );
}

function preferDuplicateRecord(
  current: StoredSessionCatalogRecord,
  candidate: StoredSessionCatalogRecord,
): StoredSessionCatalogRecord {
  const currentArchived = recordIsArchived(current);
  const candidateArchived = recordIsArchived(candidate);
  if (currentArchived !== candidateArchived) {
    return candidateArchived ? current : candidate;
  }
  const currentTimestamp = recordTimestamp(current);
  const candidateTimestamp = recordTimestamp(candidate);
  if (currentTimestamp !== candidateTimestamp) {
    return candidateTimestamp > currentTimestamp ? candidate : current;
  }
  const pathOrder = candidate.storagePath.localeCompare(current.storagePath);
  if (pathOrder !== 0) {
    return pathOrder < 0 ? candidate : current;
  }
  // The same provider identity and storage path is an ordinary metadata
  // refresh. Prefer the later observation without moving the row.
  return candidate;
}

/**
 * Provider history scanners may briefly observe the same logical session in
 * active and archive locations, or transfer a repeated row around a rename.
 * Canonicalize every snapshot before it can reach the Sidebar/cache boundary.
 */
export function canonicalizeStoredSessionCatalogRecords(
  records: readonly StoredSessionCatalogRecord[],
): StoredSessionCatalogRecord[] {
  const canonical: StoredSessionCatalogRecord[] = [];
  const indexByIdentity = new Map<string, number>();
  for (const record of records) {
    if (record.ref.providerSessionId.trim().length === 0) {
      continue;
    }
    const identity = recordIdentity(record);
    const existingIndex = indexByIdentity.get(identity);
    if (existingIndex === undefined) {
      indexByIdentity.set(identity, canonical.length);
      canonical.push(record);
      continue;
    }
    const existing = canonical[existingIndex];
    if (existing) {
      canonical[existingIndex] = preferDuplicateRecord(existing, record);
    }
  }
  return canonical;
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
  const incoming = canonicalizeStoredSessionCatalogRecords(args.incoming);
  if (args.complete) {
    return incoming;
  }
  const reconciled = canonicalizeStoredSessionCatalogRecords(args.current);
  const indexByIdentity = new Map(
    reconciled.map((record, index) => [recordIdentity(record), index] as const),
  );
  for (const record of incoming) {
    const identity = recordIdentity(record);
    const existingIndex = indexByIdentity.get(identity);
    if (existingIndex === undefined) {
      indexByIdentity.set(identity, reconciled.length);
      reconciled.push(record);
      continue;
    }
    reconciled[existingIndex] = record;
  }
  return reconciled;
}

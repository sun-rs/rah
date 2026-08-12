export function openCodeHistoryMetaCacheKey(
  databasePath: string,
  sessionId: string,
): string {
  return `${databasePath}#${sessionId}`;
}

export function openCodeHistoryMetaRevision(row: {
  time_updated: number | null;
  time_created: number | null;
}): number {
  return row.time_updated ?? row.time_created ?? 0;
}

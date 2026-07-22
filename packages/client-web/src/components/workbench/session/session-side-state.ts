export type SessionSideLayout = "columns" | "stack";

export type SessionSideSizing = {
  mainShare: number;
  sideShares: Record<string, number>;
};

const SIDE_LAYOUT_STORAGE_KEY = "rah.session-side-layouts.v1";
const SIDE_SURFACE_STORAGE_KEY = "rah.session-side-surfaces.v1";
const SIDE_SIZING_STORAGE_KEY = "rah.session-side-sizing.v1";
const MAX_REMEMBERED_SIDE_PARENTS = 100;

type StorageReader = Pick<Storage, "getItem">;
type StorageWriter = Pick<Storage, "setItem">;

function parseRecord(storage: StorageReader | undefined, key: string): Record<string, unknown> {
  if (!storage) return {};
  try {
    const value = JSON.parse(storage.getItem(key) ?? "{}");
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function trimRecord<T>(record: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(record).slice(-MAX_REMEMBERED_SIDE_PARENTS));
}

export function readRememberedSessionSideLayouts(
  storage: StorageReader | undefined,
): Record<string, SessionSideLayout> {
  return Object.fromEntries(
    Object.entries(parseRecord(storage, SIDE_LAYOUT_STORAGE_KEY)).filter(
      (entry): entry is [string, SessionSideLayout] =>
        Boolean(entry[0]) && (entry[1] === "columns" || entry[1] === "stack"),
    ),
  );
}

export function rememberSessionSideLayouts(
  storage: StorageWriter | undefined,
  layouts: Record<string, SessionSideLayout>,
): void {
  if (!storage) return;
  try {
    storage.setItem(SIDE_LAYOUT_STORAGE_KEY, JSON.stringify(trimRecord(layouts)));
  } catch {
    // The current page keeps the in-memory layout when storage is unavailable.
  }
}

export function readRememberedSessionSideSurface(
  storage: StorageReader | undefined,
  parentSessionId: string,
): string {
  const value = parseRecord(storage, SIDE_SURFACE_STORAGE_KEY)[parentSessionId];
  return typeof value === "string" && value ? value : "main";
}

export function rememberSessionSideSurface(
  storage: (StorageReader & StorageWriter) | undefined,
  parentSessionId: string,
  surfaceId: string,
): void {
  if (!storage || !parentSessionId) return;
  try {
    const current = parseRecord(storage, SIDE_SURFACE_STORAGE_KEY);
    const next = trimRecord({
      ...current,
      [parentSessionId]: surfaceId || "main",
    });
    storage.setItem(SIDE_SURFACE_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // The current page keeps the in-memory selection when storage is unavailable.
  }
}

function normalizedShare(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : null;
}

export function readRememberedSessionSideSizing(
  storage: StorageReader | undefined,
  parentSessionId: string,
): SessionSideSizing | null {
  const value = parseRecord(storage, SIDE_SIZING_STORAGE_KEY)[parentSessionId];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const mainShare = normalizedShare(record.mainShare);
  const rawSideShares = record.sideShares;
  if (
    mainShare === null ||
    mainShare >= 1 ||
    !rawSideShares ||
    typeof rawSideShares !== "object" ||
    Array.isArray(rawSideShares)
  ) {
    return null;
  }
  const sideShares = Object.fromEntries(
    Object.entries(rawSideShares)
      .map(([sessionId, share]) => [sessionId, normalizedShare(share)] as const)
      .filter((entry): entry is [string, number] => Boolean(entry[0]) && entry[1] !== null),
  );
  return { mainShare, sideShares };
}

export function rememberSessionSideSizing(
  storage: (StorageReader & StorageWriter) | undefined,
  parentSessionId: string,
  sizing: SessionSideSizing,
): void {
  if (!storage || !parentSessionId) return;
  try {
    const current = parseRecord(storage, SIDE_SIZING_STORAGE_KEY);
    const next = trimRecord({
      ...current,
      [parentSessionId]: sizing,
    });
    storage.setItem(SIDE_SIZING_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // The current page keeps the in-memory sizing when storage is unavailable.
  }
}

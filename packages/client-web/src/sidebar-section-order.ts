export type SidebarDropPosition = "before" | "after";

export function sidebarPinnedOrderKey(
  workspaceDir: string,
  itemKey: string,
): string {
  return JSON.stringify([workspaceDir, itemKey]);
}

export function sidebarCouncilOrderKey(councilId: string): string {
  return `council:${councilId}`;
}

export function reconcileSidebarSectionOrder(
  preferredOrder: readonly string[],
  availableKeys: readonly string[],
): string[] {
  const available = new Set(availableKeys);
  const seen = new Set<string>();
  const ordered: string[] = [];

  for (const key of preferredOrder) {
    if (!available.has(key) || seen.has(key)) {
      continue;
    }
    seen.add(key);
    ordered.push(key);
  }

  for (const key of availableKeys) {
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    ordered.push(key);
  }

  return ordered;
}

export function moveSidebarSectionItem(
  currentOrder: readonly string[],
  sourceKey: string,
  targetKey: string,
  position: SidebarDropPosition,
): string[] {
  if (sourceKey === targetKey) {
    return [...currentOrder];
  }

  const next = [...currentOrder];
  const sourceIndex = next.indexOf(sourceKey);
  if (sourceIndex < 0 || !next.includes(targetKey)) {
    return next;
  }

  next.splice(sourceIndex, 1);
  const targetIndex = next.indexOf(targetKey);
  next.splice(targetIndex + (position === "after" ? 1 : 0), 0, sourceKey);
  return next;
}

export function readSidebarSectionOrder(storageKey: string): string[] {
  if (typeof window === "undefined") {
    return [];
  }
  try {
    const value = JSON.parse(window.localStorage.getItem(storageKey) ?? "[]");
    return Array.isArray(value)
      ? value.filter((entry): entry is string => typeof entry === "string")
      : [];
  } catch {
    return [];
  }
}

export function writeSidebarSectionOrder(
  storageKey: string,
  order: readonly string[],
): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(storageKey, JSON.stringify(order));
  } catch {
    // Browser privacy modes and constrained PWA storage can reject writes.
  }
}

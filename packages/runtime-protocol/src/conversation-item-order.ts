import type { ConversationItemProjection } from "./conversation";

function timestampRank(value: string | undefined): number {
  if (!value) {
    return Number.POSITIVE_INFINITY;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
}

function userItemPrecedes(
  candidate: ConversationItemProjection,
  current: ConversationItemProjection,
): boolean {
  const candidateTimestamp = timestampRank(candidate.startedAt);
  const currentTimestamp = timestampRank(current.startedAt);
  if (
    Number.isFinite(candidateTimestamp) &&
    Number.isFinite(currentTimestamp) &&
    candidateTimestamp !== currentTimestamp
  ) {
    return candidateTimestamp < currentTimestamp;
  }
  return candidate.revision < current.revision;
}

function initialUserItemIndex(items: readonly ConversationItemProjection[]): number {
  let candidate = -1;
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index]!;
    if (item.role !== "user") {
      continue;
    }
    if (candidate < 0) {
      candidate = index;
      continue;
    }
    const current = items[candidate]!;
    if (userItemPrecedes(item, current)) {
      candidate = index;
    }
  }
  return candidate;
}

/**
 * Returns the canonical presentation order inside one provider turn.
 *
 * Provider persistence is allowed to write startup work (for example context
 * compaction during Resume) before it echoes the input that activated the
 * turn. Arrival order therefore is not presentation order. The first external
 * user item owns the turn boundary, process evidence follows it, and terminal
 * answers close the turn. Later user items are Guides and retain their place
 * among process evidence.
 */
export function orderConversationTurnItems<T extends ConversationItemProjection>(
  items: T[],
): T[];
export function orderConversationTurnItems<T extends ConversationItemProjection>(
  items: readonly T[],
): readonly T[];
export function orderConversationTurnItems<T extends ConversationItemProjection>(
  items: readonly T[],
): readonly T[] {
  if (items.length < 2) {
    return items;
  }

  const initialUserIndex = initialUserItemIndex(items);
  const ordered: T[] = [];
  if (initialUserIndex >= 0) {
    ordered.push(items[initialUserIndex]!);
  }
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index]!;
    if (index !== initialUserIndex && item.role !== "final") {
      ordered.push(item);
    }
  }
  for (const item of items) {
    if (item.role === "final") {
      ordered.push(item);
    }
  }

  return ordered.every((item, index) => item === items[index]) ? items : ordered;
}

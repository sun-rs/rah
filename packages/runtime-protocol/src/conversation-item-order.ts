import type { ConversationItemProjection } from "./conversation";
import type { TimelineItem } from "./events";

function userMessageTimelineItem(
  item: ConversationItemProjection,
): Extract<TimelineItem, { kind: "user_message" }> | undefined {
  return item.content.kind === "timeline" &&
    item.content.item.kind === "user_message"
    ? item.content.item
    : undefined;
}

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
  const candidatePlacement = userMessageTimelineItem(candidate)?.inputPlacement;
  const currentPlacement = userMessageTimelineItem(current)?.inputPlacement;
  if (candidatePlacement === "turn_start" && currentPlacement !== "turn_start") {
    return true;
  }
  if (currentPlacement === "turn_start" && candidatePlacement !== "turn_start") {
    return false;
  }
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

  const anchoredGuides = ordered.filter(
    (item) => {
      const userMessage = userMessageTimelineItem(item);
      return Boolean(
        item.role === "user" &&
          userMessage?.inputPlacement === "turn_steer" &&
          userMessage.causalAfterItemId !== undefined &&
          ordered.some(
            (candidate) => candidate.id === userMessage.causalAfterItemId,
          ),
      );
    },
  );
  if (anchoredGuides.length > 0) {
    const anchoredIds = new Set(anchoredGuides.map((item) => item.id));
    const causallyOrdered = ordered.filter((item) => !anchoredIds.has(item.id));
    for (const guide of anchoredGuides) {
      const anchor = userMessageTimelineItem(guide)?.causalAfterItemId;
      const anchorIndex = anchor
        ? causallyOrdered.findIndex((candidate) => candidate.id === anchor)
        : -1;
      if (anchorIndex < 0) {
        const finalIndex = causallyOrdered.findIndex((item) => item.role === "final");
        causallyOrdered.splice(
          finalIndex >= 0 ? finalIndex : causallyOrdered.length,
          0,
          guide,
        );
        continue;
      }
      let insertionIndex = anchorIndex + 1;
      while (
        insertionIndex < causallyOrdered.length &&
        causallyOrdered[insertionIndex]?.role === "user" &&
        userMessageTimelineItem(causallyOrdered[insertionIndex]!)
          ?.causalAfterItemId === anchor
      ) {
        insertionIndex += 1;
      }
      causallyOrdered.splice(insertionIndex, 0, guide);
    }
    ordered.splice(0, ordered.length, ...causallyOrdered);
  }

  return ordered.every((item, index) => item === items[index]) ? items : ordered;
}

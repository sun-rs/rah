import type { CouncilMessagesPageResponse, CouncilSnapshot } from "@rah/runtime-protocol";

function mergeCouncilMessages(
  left: readonly CouncilSnapshot["messages"][number][],
  right: readonly CouncilSnapshot["messages"][number][],
): CouncilSnapshot["messages"] {
  const byId = new Map<number, CouncilSnapshot["messages"][number]>();
  for (const message of left) {
    byId.set(message.id, message);
  }
  for (const message of right) {
    byId.set(message.id, message);
  }
  return [...byId.values()].sort((a, b) => a.id - b.id);
}

function messageCount(council: CouncilSnapshot): number {
  return council.meta?.messageCount ?? council.messageWindow?.total ?? council.messages.length;
}

export function mergeCouncilSnapshot(
  current: CouncilSnapshot | undefined,
  incoming: CouncilSnapshot,
): CouncilSnapshot {
  if (!current || current.id !== incoming.id) {
    return incoming;
  }

  const incomingIsSummaryOnly = incoming.messages.length === 0 && current.messages.length > 0;
  const messages = incomingIsSummaryOnly
    ? current.messages
    : mergeCouncilMessages(current.messages, incoming.messages);
  const currentFirstId = current.messages[0]?.id;
  const incomingFirstId = incoming.messages[0]?.id;
  const preservesOlderWindow =
    incomingIsSummaryOnly ||
    (
      currentFirstId !== undefined &&
      incomingFirstId !== undefined &&
      currentFirstId < incomingFirstId
    );
  const total = incoming.messageWindow?.total ?? incoming.meta?.messageCount ?? messageCount(current);
  const hasMoreBefore = preservesOlderWindow
    ? Boolean(current.messageWindow?.hasMoreBefore)
    : Boolean(incoming.messageWindow?.hasMoreBefore);
  const nextBeforeMessageId = preservesOlderWindow
    ? current.messageWindow?.nextBeforeMessageId
    : incoming.messageWindow?.nextBeforeMessageId;

  return {
    ...incoming,
    messages,
    ...(incoming.meta ?? current.meta ? { meta: incoming.meta ?? current.meta } : {}),
    messageWindow: {
      total,
      loaded: messages.length,
      hasMoreBefore,
      ...(hasMoreBefore && nextBeforeMessageId !== undefined ? { nextBeforeMessageId } : {}),
    },
  };
}

export function mergeCouncilLists(
  current: readonly CouncilSnapshot[],
  incoming: readonly CouncilSnapshot[],
  options?: { preserveMissing?: boolean },
): CouncilSnapshot[] {
  const currentById = new Map(current.map((council) => [council.id, council]));
  const merged = incoming.map((council) => mergeCouncilSnapshot(currentById.get(council.id), council));
  if (!options?.preserveMissing) {
    return merged;
  }
  const incomingIds = new Set(incoming.map((council) => council.id));
  return [
    ...merged,
    ...current.filter((council) => !incomingIds.has(council.id)),
  ];
}

export function prependCouncilMessagesPage(
  council: CouncilSnapshot,
  page: CouncilMessagesPageResponse,
): CouncilSnapshot {
  const messages = mergeCouncilMessages(page.messages, council.messages);
  return {
    ...council,
    messages,
    meta: {
      ...council.meta,
      messageCount: page.total,
    },
    messageWindow: {
      total: page.total,
      loaded: messages.length,
      hasMoreBefore: page.hasMoreBefore,
      ...(page.nextBeforeMessageId !== undefined
        ? { nextBeforeMessageId: page.nextBeforeMessageId }
        : {}),
    },
  };
}

export function canLoadOlderCouncilMessages(council: CouncilSnapshot | null): boolean {
  return Boolean(
    council?.messageWindow?.hasMoreBefore &&
      council.messageWindow.nextBeforeMessageId !== undefined,
  );
}

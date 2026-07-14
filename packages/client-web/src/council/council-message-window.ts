import type {
  CouncilMessage,
  CouncilMessagesPageResponse,
  CouncilSnapshot,
  CouncilSummary,
} from "@rah/runtime-protocol";

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

function summaryIsOlder(current: CouncilSnapshot, incoming: CouncilSummary): boolean {
  const currentUpdatedAt = Date.parse(current.updatedAt);
  const incomingUpdatedAt = Date.parse(incoming.updatedAt);
  return Number.isFinite(currentUpdatedAt)
    && Number.isFinite(incomingUpdatedAt)
    && incomingUpdatedAt < currentUpdatedAt;
}

function isCouncilSnapshot(council: CouncilSummary | CouncilSnapshot): council is CouncilSnapshot {
  return "messages" in council && Array.isArray(council.messages);
}

export function councilSnapshotFromSummary(summary: CouncilSummary): CouncilSnapshot {
  const total = summary.meta?.messageCount ?? 0;
  return {
    ...summary,
    messages: [],
    messageWindow: {
      total,
      loaded: 0,
      hasMoreBefore: total > 0,
    },
  };
}

export function mergeCouncilSummary(
  current: CouncilSnapshot | undefined,
  incoming: CouncilSummary,
): CouncilSnapshot {
  if (isCouncilSnapshot(incoming)) {
    return mergeCouncilSnapshot(current, incoming);
  }
  if (!current || current.id !== incoming.id) {
    return councilSnapshotFromSummary(incoming);
  }

  const effectiveSummary = summaryIsOlder(current, incoming) ? current : incoming;
  const total = effectiveSummary.meta?.messageCount ?? messageCount(current);
  const loaded = current.messages.length;
  const hasMoreBefore = current.messageWindow?.hasMoreBefore ?? total > loaded;
  const nextBeforeMessageId = current.messageWindow?.nextBeforeMessageId;
  return {
    ...current,
    ...effectiveSummary,
    messages: current.messages,
    messageWindow: {
      total,
      loaded,
      hasMoreBefore,
      ...(hasMoreBefore && nextBeforeMessageId !== undefined ? { nextBeforeMessageId } : {}),
    },
  };
}

export function mergeCouncilSnapshot(
  current: CouncilSnapshot | undefined,
  incoming: CouncilSnapshot,
): CouncilSnapshot {
  if (!current || current.id !== incoming.id) {
    return incoming;
  }

  const messages = mergeCouncilMessages(current.messages, incoming.messages);
  const currentFirstId = current.messages[0]?.id;
  const incomingFirstId = incoming.messages[0]?.id;
  const preservesOlderWindow =
    currentFirstId !== undefined &&
    incomingFirstId !== undefined &&
    currentFirstId < incomingFirstId;
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
  incoming: readonly (CouncilSummary | CouncilSnapshot)[],
): CouncilSnapshot[] {
  const currentById = new Map(current.map((council) => [council.id, council]));
  const incomingIds = new Set(incoming.map((council) => council.id));
  const preservedActive = current.filter(
    (council) => council.status === "running" && !incomingIds.has(council.id),
  );
  return [
    ...incoming.map((council) => mergeCouncilSummary(currentById.get(council.id), council)),
    ...preservedActive,
  ];
}

export function mergeCouncilMessageEvent(
  current: CouncilSnapshot | undefined,
  summary: CouncilSummary,
  message: CouncilMessage,
): CouncilSnapshot {
  const base = mergeCouncilSummary(current, summary);
  const messages = mergeCouncilMessages(base.messages, [message]);
  const total = summary.meta?.messageCount ?? Math.max(messageCount(base), messages.length);
  const hasMoreBefore = base.messageWindow?.hasMoreBefore ?? total > messages.length;
  const nextBeforeMessageId = base.messageWindow?.nextBeforeMessageId
    ?? (hasMoreBefore ? messages[0]?.id : undefined);
  return {
    ...base,
    messages,
    messageWindow: {
      total,
      loaded: messages.length,
      hasMoreBefore,
      ...(hasMoreBefore && nextBeforeMessageId !== undefined ? { nextBeforeMessageId } : {}),
    },
  };
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

export function mergeLatestCouncilMessagesPage(
  council: CouncilSnapshot,
  page: CouncilMessagesPageResponse,
): CouncilSnapshot {
  const currentIds = new Set(council.messages.map((message) => message.id));
  const overlapsCurrentWindow = page.messages.some((message) => currentIds.has(message.id));
  const messages = overlapsCurrentWindow
    ? mergeCouncilMessages(council.messages, page.messages)
    : [...page.messages];
  const hasMoreBefore = messages.length < page.total;
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
      hasMoreBefore,
      ...(hasMoreBefore && messages[0] ? { nextBeforeMessageId: messages[0].id } : {}),
    },
  };
}

export function councilNeedsLatestMessages(
  council: CouncilSnapshot,
  pageLimit: number,
): boolean {
  const total = council.meta?.messageCount ?? council.messageWindow?.total ?? 0;
  if (total === 0) {
    return false;
  }
  const expectedWindowSize = Math.min(total, pageLimit);
  if (council.messages.length < expectedWindowSize) {
    return true;
  }
  const expectedLastMessageId = council.meta?.lastMessage?.id;
  return expectedLastMessageId !== undefined
    && council.messages.at(-1)?.id !== expectedLastMessageId;
}

export function canLoadOlderCouncilMessages(council: CouncilSnapshot | null): boolean {
  return Boolean(
    council?.messageWindow?.hasMoreBefore &&
      council.messageWindow.nextBeforeMessageId !== undefined,
  );
}

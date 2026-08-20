import type { ProviderKind } from "@rah/runtime-protocol";
import type { ConversationSyncState, SessionProjection } from "./types";

type ConversationIdentity = {
  provider: ProviderKind;
  providerSessionId: string;
};

type ConversationMemoryCacheOptions = {
  maxEntries?: number;
  maxEntryBytes?: number;
  maxTotalBytes?: number;
  ttlMs?: number;
  now?: () => number;
};

type ConversationMemoryCacheEntry = {
  conversation: ConversationSyncState;
  approximateBytes: number;
  storedAt: number;
  sourceConversation: ConversationSyncState;
};

export const DEFAULT_CONVERSATION_MEMORY_CACHE_LIMITS = {
  maxEntries: 16,
  maxEntryBytes: 8 * 1024 * 1024,
  maxTotalBytes: 32 * 1024 * 1024,
  ttlMs: 30 * 60 * 1000,
} as const;

function conversationIdentityKey(identity: ConversationIdentity): string {
  return `${identity.provider}:${identity.providerSessionId}`;
}

function estimatedConversationBytes(conversation: ConversationSyncState): number {
  if (
    conversation.approximateBytes !== null &&
    Number.isFinite(conversation.approximateBytes) &&
    conversation.approximateBytes > 0
  ) {
    return conversation.approximateBytes;
  }
  // Conversation pages contain bounded summaries rather than raw tool output.
  // Keep the fallback conservative without serializing the full projection on
  // every websocket update.
  return Math.max(1_024, conversation.turns.length * 64 * 1_024);
}

function boundedConversationSnapshot(
  conversation: ConversationSyncState,
  maxEntryBytes: number,
): { conversation: ConversationSyncState; approximateBytes: number } {
  const approximateBytes = estimatedConversationBytes(conversation);
  if (approximateBytes <= maxEntryBytes || conversation.turns.length <= 1) {
    return {
      conversation: {
        ...conversation,
        turns: [...conversation.turns],
        pendingDeltas: [],
      },
      approximateBytes: Math.min(approximateBytes, maxEntryBytes),
    };
  }

  const retainedTurnCount = Math.max(
    1,
    Math.floor(conversation.turns.length * (maxEntryBytes / approximateBytes)),
  );
  return {
    conversation: {
      ...conversation,
      turns: conversation.turns.slice(-retainedTurnCount),
      pendingDeltas: [],
      approximateBytes: maxEntryBytes,
    },
    approximateBytes: maxEntryBytes,
  };
}

export function createConversationMemoryCache(
  options: ConversationMemoryCacheOptions = {},
) {
  const maxEntries = options.maxEntries ?? DEFAULT_CONVERSATION_MEMORY_CACHE_LIMITS.maxEntries;
  const maxEntryBytes =
    options.maxEntryBytes ?? DEFAULT_CONVERSATION_MEMORY_CACHE_LIMITS.maxEntryBytes;
  const maxTotalBytes =
    options.maxTotalBytes ?? DEFAULT_CONVERSATION_MEMORY_CACHE_LIMITS.maxTotalBytes;
  const ttlMs = options.ttlMs ?? DEFAULT_CONVERSATION_MEMORY_CACHE_LIMITS.ttlMs;
  const now = options.now ?? Date.now;
  const entries = new Map<string, ConversationMemoryCacheEntry>();
  let totalBytes = 0;

  const remove = (key: string) => {
    const entry = entries.get(key);
    if (!entry) {
      return;
    }
    entries.delete(key);
    totalBytes -= entry.approximateBytes;
  };

  const prune = () => {
    const cutoff = now() - ttlMs;
    for (const [key, entry] of entries) {
      if (entry.storedAt < cutoff) {
        remove(key);
      }
    }
    while (entries.size > maxEntries || totalBytes > maxTotalBytes) {
      const oldestKey = entries.keys().next().value as string | undefined;
      if (!oldestKey) {
        break;
      }
      remove(oldestKey);
    }
  };

  const remember = (
    identity: ConversationIdentity,
    conversation: ConversationSyncState | undefined,
  ) => {
    if (
      !conversation ||
      conversation.phase !== "ready" ||
      conversation.turns.length === 0 ||
      conversation.detachedBaseline === true
    ) {
      return;
    }
    const key = conversationIdentityKey(identity);
    const existing = entries.get(key);
    if (existing?.sourceConversation === conversation) {
      return;
    }
    const snapshot = boundedConversationSnapshot(conversation, maxEntryBytes);
    remove(key);
    entries.set(key, {
      conversation: snapshot.conversation,
      approximateBytes: snapshot.approximateBytes,
      storedAt: now(),
      sourceConversation: conversation,
    });
    totalBytes += snapshot.approximateBytes;
    prune();
  };

  const rememberProjection = (projection: SessionProjection) => {
    const providerSessionId = projection.summary.session.providerSessionId;
    if (!providerSessionId) {
      return;
    }
    remember(
      {
        provider: projection.summary.session.provider,
        providerSessionId,
      },
      projection.conversation,
    );
  };

  return {
    rememberProjection,

    rememberProjections(projections: ReadonlyMap<string, SessionProjection>) {
      for (const projection of projections.values()) {
        rememberProjection(projection);
      }
    },

    restore(identity: ConversationIdentity): ConversationSyncState | undefined {
      prune();
      const key = conversationIdentityKey(identity);
      const entry = entries.get(key);
      if (!entry) {
        return undefined;
      }
      // Touch the entry for LRU eviction. The restored projection is readable
      // immediately, but its runtime revision/cursor belong to the old browser
      // projection. A tail refresh establishes the new canonical baseline.
      entries.delete(key);
      entries.set(key, { ...entry, storedAt: now() });
      return {
        ...entry.conversation,
        phase: "ready",
        turns: [...entry.conversation.turns],
        nextCursor: null,
        daemonRevision: null,
        pendingDeltas: [],
        needsRefresh: true,
        detachedBaseline: true,
        lastError: null,
      };
    },

    clear() {
      entries.clear();
      totalBytes = 0;
    },

    inspect() {
      prune();
      return { entries: entries.size, totalBytes };
    },
  };
}

export const sessionConversationMemoryCache = createConversationMemoryCache();

export function restoreConversationProjectionStateFromMemory(
  state: { projections: Map<string, SessionProjection> },
  sessionId: string,
): { projections: Map<string, SessionProjection> } {
  const projection = state.projections.get(sessionId);
  if (
    !projection ||
    (projection.conversation?.phase === "ready" && projection.conversation.turns.length > 0)
  ) {
    return state;
  }
  const providerSessionId = projection.summary.session.providerSessionId;
  if (!providerSessionId) {
    return state;
  }
  const conversation = sessionConversationMemoryCache.restore({
    provider: projection.summary.session.provider,
    providerSessionId,
  });
  if (!conversation) {
    return state;
  }
  const projections = new Map(state.projections);
  projections.set(sessionId, { ...projection, conversation });
  return { projections };
}

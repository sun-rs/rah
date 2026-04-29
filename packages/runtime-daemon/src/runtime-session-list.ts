import type {
  ListSessionsResponse,
  StoredSessionRef,
} from "@rah/runtime-protocol";
import type { ProviderAdapter } from "./provider-adapter";
import {
  toSessionSummary,
  type StoredSessionState,
} from "./session-store";
import { workspaceDirsFromState } from "./workbench-directory-utils";

const RECENT_SESSION_LIMIT = 15;

export type RememberedWorkbenchSessionState = {
  rememberedSessions: readonly StoredSessionRef[];
  rememberedRecentSessions: readonly StoredSessionRef[];
  rememberedWorkspaceDirs: readonly string[];
  rememberedHiddenWorkspaces: readonly string[];
  rememberedActiveWorkspaceDir?: string;
  rememberedHiddenSessionKeys: readonly string[];
  rememberedSessionTitleOverrides: Readonly<Record<string, string>>;
};

export function discoverStoredSessions(adapters: Iterable<ProviderAdapter>): StoredSessionRef[] {
  const discovered = new Map<string, StoredSessionRef>();
  for (const adapter of adapters) {
    const storedSessions =
      adapter.refreshStoredSessionsCatalog?.() ??
      adapter.listStoredSessions?.() ??
      [];
    for (const stored of storedSessions) {
      discovered.set(`${stored.provider}:${stored.providerSessionId}`, stored);
    }
  }
  return [...discovered.values()];
}

export function storedSessionRefKey(entry: StoredSessionRef): string {
  return JSON.stringify([
    entry.provider,
    entry.providerSessionId,
    entry.source ?? "provider_history",
    entry.cwd ?? "",
    entry.rootDir ?? "",
    entry.title ?? "",
    entry.preview ?? "",
    entry.createdAt ?? "",
    entry.updatedAt ?? "",
    entry.lastUsedAt ?? "",
  ]);
}

export function sameStoredSessionRefs(
  left: readonly StoredSessionRef[],
  right: readonly StoredSessionRef[],
): boolean {
  if (left.length !== right.length) {
    return false;
  }
  return left.every((entry, index) => storedSessionRefKey(entry) === storedSessionRefKey(right[index]!));
}

function sessionProviderKey(session: Pick<StoredSessionRef, "provider" | "providerSessionId">): string {
  return `${session.provider}:${session.providerSessionId}`;
}

function sessionRecentTimestamp(session: StoredSessionRef): string {
  return session.lastUsedAt ?? session.updatedAt ?? session.createdAt ?? "";
}

function newestTimestamp(...values: Array<string | undefined>): string | undefined {
  return values.filter((value): value is string => Boolean(value)).sort().at(-1);
}

function preferProviderHistoryMetadata(left: StoredSessionRef, right: StoredSessionRef): StoredSessionRef {
  if (left.source === "provider_history" && right.source !== "provider_history") {
    return left;
  }
  if (right.source === "provider_history" && left.source !== "provider_history") {
    return right;
  }
  return sessionRecentTimestamp(right) >= sessionRecentTimestamp(left) ? right : left;
}

function mergeStoredSessionRef(left: StoredSessionRef, right: StoredSessionRef): StoredSessionRef {
  const metadata = preferProviderHistoryMetadata(left, right);
  const fallback = metadata === left ? right : left;
  const lastUsedAt = newestTimestamp(
    left.lastUsedAt,
    right.lastUsedAt,
    left.updatedAt,
    right.updatedAt,
    left.createdAt,
    right.createdAt,
  );
  return {
    ...fallback,
    ...metadata,
    ...(lastUsedAt ? { lastUsedAt } : {}),
  };
}

function liveSessionRef(state: StoredSessionState): StoredSessionRef | null {
  const providerSessionId = state.session.providerSessionId;
  if (!providerSessionId) {
    return null;
  }
  return {
    provider: state.session.provider,
    providerSessionId,
    cwd: state.session.cwd,
    rootDir: state.session.rootDir,
    ...(state.session.title !== undefined ? { title: state.session.title } : {}),
    ...(state.session.preview !== undefined ? { preview: state.session.preview } : {}),
    createdAt: state.session.createdAt,
    updatedAt: state.session.updatedAt,
    lastUsedAt: state.session.updatedAt,
    source: "previous_live",
  };
}

function buildGlobalRecentSessions(args: {
  storedSessions: Iterable<StoredSessionRef>;
  rememberedRecentSessions: readonly StoredSessionRef[];
  visibleLiveStates: readonly StoredSessionState[];
  hiddenSessionKeys: ReadonlySet<string>;
  availableProviderSessionKeys: ReadonlySet<string>;
  applyTitleOverride: (session: StoredSessionRef) => StoredSessionRef;
}): StoredSessionRef[] {
  const recentByKey = new Map<string, StoredSessionRef>();
  const addCandidate = (session: StoredSessionRef) => {
    const key = sessionProviderKey(session);
    if (args.hiddenSessionKeys.has(key)) {
      return;
    }
    if (session.source === "previous_live" && !args.availableProviderSessionKeys.has(key)) {
      return;
    }
    const existing = recentByKey.get(key);
    recentByKey.set(key, existing ? mergeStoredSessionRef(existing, session) : session);
  };

  for (const session of args.storedSessions) {
    addCandidate(session);
  }
  for (const session of args.rememberedRecentSessions) {
    addCandidate(session);
  }
  for (const state of args.visibleLiveStates) {
    const session = liveSessionRef(state);
    if (session) {
      addCandidate(session);
    }
  }

  return [...recentByKey.values()]
    .sort((a, b) => sessionRecentTimestamp(b).localeCompare(sessionRecentTimestamp(a)))
    .slice(0, RECENT_SESSION_LIMIT)
    .map(args.applyTitleOverride);
}

export function buildSessionsResponse(args: {
  liveStates: readonly StoredSessionState[];
  discoveredStoredSessions: readonly StoredSessionRef[];
  remembered: RememberedWorkbenchSessionState;
  isClosingSession: (sessionId: string) => boolean;
}): ListSessionsResponse {
  const applyTitleOverride = (session: StoredSessionRef): StoredSessionRef => {
    const key = `${session.provider}:${session.providerSessionId}`;
    const title = args.remembered.rememberedSessionTitleOverrides[key];
    if (!title || title === session.title) {
      return session;
    }
    return {
      ...session,
      title,
    };
  };

  const visibleLiveStates = args.liveStates.filter(
    (state) => !args.isClosingSession(state.session.id),
  );
  const hiddenSessionKeys = new Set(args.remembered.rememberedHiddenSessionKeys);
  const availableProviderSessionKeys = new Set<string>();
  const discoveredByKey = new Map<string, StoredSessionRef>();
  for (const stored of args.discoveredStoredSessions) {
    const key = sessionProviderKey(stored);
    availableProviderSessionKeys.add(key);
    discoveredByKey.set(key, stored);
  }
  for (const state of visibleLiveStates) {
    if (!state.session.providerSessionId) {
      continue;
    }
    availableProviderSessionKeys.add(
      sessionProviderKey({
        provider: state.session.provider,
        providerSessionId: state.session.providerSessionId,
      }),
    );
  }
  const storedSessions = new Map<string, StoredSessionRef>();
  for (const remembered of args.remembered.rememberedSessions) {
    const key = sessionProviderKey(remembered);
    if (hiddenSessionKeys.has(key)) {
      continue;
    }
    if (
      remembered.source === "previous_live" &&
      !availableProviderSessionKeys.has(key)
    ) {
      continue;
    }
    storedSessions.set(key, remembered);
  }
  for (const stored of args.discoveredStoredSessions) {
    if (hiddenSessionKeys.has(sessionProviderKey(stored))) {
      continue;
    }
    storedSessions.set(sessionProviderKey(stored), stored);
  }
  return {
    sessions: visibleLiveStates.map((state) => {
      const providerSessionId = state.session.providerSessionId;
      if (!providerSessionId) {
        return toSessionSummary(state);
      }
      const discovered = discoveredByKey.get(sessionProviderKey({
        provider: state.session.provider,
        providerSessionId,
      }));
      if (!discovered) {
        const summary = toSessionSummary(state);
        const override = args.remembered.rememberedSessionTitleOverrides[
          sessionProviderKey({
            provider: summary.session.provider,
            providerSessionId,
          })
        ];
        if (!override || override === summary.session.title) {
          return summary;
        }
        return {
          ...summary,
          session: {
            ...summary.session,
            title: override,
          },
        };
      }
      const summary = toSessionSummary({
        ...state,
        session: {
          ...state.session,
          ...(discovered.title !== undefined ? { title: discovered.title } : {}),
          ...(discovered.preview !== undefined ? { preview: discovered.preview } : {}),
        },
      });
      const override = args.remembered.rememberedSessionTitleOverrides[
        sessionProviderKey({
          provider: summary.session.provider,
          providerSessionId,
        })
      ];
      if (!override || override === summary.session.title) {
        return summary;
      }
      return {
        ...summary,
        session: {
          ...summary.session,
          title: override,
        },
      };
    }),
    storedSessions: [...storedSessions.values()].map(applyTitleOverride),
    recentSessions: buildGlobalRecentSessions({
      storedSessions: storedSessions.values(),
      rememberedRecentSessions: args.remembered.rememberedRecentSessions,
      visibleLiveStates,
      hiddenSessionKeys,
      availableProviderSessionKeys,
      applyTitleOverride,
    }),
    workspaceDirs: workspaceDirsFromState(
      args.remembered.rememberedWorkspaceDirs,
      args.liveStates,
    ),
    hiddenWorkspaces: [...args.remembered.rememberedHiddenWorkspaces],
    ...(args.remembered.rememberedActiveWorkspaceDir
      ? { activeWorkspaceDir: args.remembered.rememberedActiveWorkspaceDir }
      : {}),
  };
}

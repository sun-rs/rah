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

export type RememberedWorkbenchSessionState = {
  rememberedSessions: readonly StoredSessionRef[];
  rememberedRecentSessions: readonly StoredSessionRef[];
  rememberedWorkspaceDirs: readonly string[];
  rememberedHiddenWorkspaces: readonly string[];
  rememberedActiveWorkspaceDir?: string;
  rememberedHiddenSessionKeys: readonly string[];
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

export function buildSessionsResponse(args: {
  liveStates: readonly StoredSessionState[];
  discoveredStoredSessions: readonly StoredSessionRef[];
  remembered: RememberedWorkbenchSessionState;
  isClosingSession: (sessionId: string) => boolean;
}): ListSessionsResponse {
  const visibleLiveStates = args.liveStates.filter(
    (state) => !args.isClosingSession(state.session.id),
  );
  const hiddenSessionKeys = new Set(args.remembered.rememberedHiddenSessionKeys);
  const availableProviderSessionKeys = new Set<string>();
  const discoveredByKey = new Map<string, StoredSessionRef>();
  for (const stored of args.discoveredStoredSessions) {
    const key = `${stored.provider}:${stored.providerSessionId}`;
    availableProviderSessionKeys.add(key);
    discoveredByKey.set(key, stored);
  }
  for (const state of visibleLiveStates) {
    if (!state.session.providerSessionId) {
      continue;
    }
    availableProviderSessionKeys.add(
      `${state.session.provider}:${state.session.providerSessionId}`,
    );
  }
  const storedSessions = new Map<string, StoredSessionRef>();
  for (const remembered of args.remembered.rememberedSessions) {
    const key = `${remembered.provider}:${remembered.providerSessionId}`;
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
    if (hiddenSessionKeys.has(`${stored.provider}:${stored.providerSessionId}`)) {
      continue;
    }
    storedSessions.set(`${stored.provider}:${stored.providerSessionId}`, stored);
  }
  for (const state of visibleLiveStates) {
    const providerSessionId = state.session.providerSessionId;
    if (!providerSessionId) {
      continue;
    }
    storedSessions.delete(`${state.session.provider}:${providerSessionId}`);
  }
  return {
    sessions: visibleLiveStates.map((state) => {
      const providerSessionId = state.session.providerSessionId;
      if (!providerSessionId) {
        return toSessionSummary(state);
      }
      const discovered = discoveredByKey.get(`${state.session.provider}:${providerSessionId}`);
      if (!discovered) {
        return toSessionSummary(state);
      }
      return toSessionSummary({
        ...state,
        session: {
          ...state.session,
          ...(discovered.title !== undefined ? { title: discovered.title } : {}),
          ...(discovered.preview !== undefined ? { preview: discovered.preview } : {}),
        },
      });
    }),
    storedSessions: [...storedSessions.values()],
    recentSessions: args.remembered.rememberedRecentSessions.filter((session) => {
      const key = `${session.provider}:${session.providerSessionId}`;
      if (hiddenSessionKeys.has(key)) {
        return false;
      }
      if (
        session.source === "previous_live" &&
        !availableProviderSessionKeys.has(key)
      ) {
        return false;
      }
      return true;
    }).map((session) => {
      const key = `${session.provider}:${session.providerSessionId}`;
      const discovered = discoveredByKey.get(key);
      if (!discovered) {
        return session;
      }
      const lastUsedAt = session.lastUsedAt ?? discovered.lastUsedAt ?? discovered.updatedAt;
      return {
        ...session,
        ...discovered,
        ...(lastUsedAt ? { lastUsedAt } : {}),
      };
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

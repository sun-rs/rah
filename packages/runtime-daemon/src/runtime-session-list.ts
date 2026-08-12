import type {
  ListSessionsResponse,
  StoredSessionRef,
  WorkbenchPinnedItemRef,
} from "@rah/runtime-protocol";
import type { ProviderStoredHistoryAdapter } from "./provider-adapter";
import {
  toSessionSummary,
  type StoredSessionState,
} from "./session-store";
import {
  applyCanonicalTitleToSessionSummary,
  applyCanonicalTitleToStoredSession,
} from "./session-title-resolver";
import { configuredWorkspaceDirs } from "./workbench-directory-utils";

const RECENT_SESSION_LIMIT = 15;
const INTERNAL_NATIVE_TUI_PROBE_WORKSPACE_SEGMENT =
  "/test-results/native-real-tui-workspaces/";

export type StoredSessionsResponseMode = "all" | "cached" | "recent";

export type RememberedWorkbenchSessionState = {
  rememberedSessions: readonly StoredSessionRef[];
  rememberedRecentSessions: readonly StoredSessionRef[];
  rememberedWorkspaceDirs: readonly string[];
  rememberedHiddenWorkspaces: readonly string[];
  rememberedActiveWorkspaceDir?: string;
  rememberedHiddenSessionKeys: readonly string[];
  rememberedSessionTitleOverrides: Readonly<Record<string, string>>;
  rememberedPinnedSidebarItems?: readonly WorkbenchPinnedItemRef[];
};

export function discoverStoredSessions(
  adapters: Iterable<ProviderStoredHistoryAdapter>,
): StoredSessionRef[] {
  const discovered = new Map<string, StoredSessionRef>();
  for (const adapter of adapters) {
    // This path only projects indexes that RuntimeEngine has already hydrated.
    // Provider discovery belongs to StoredSessionCatalog's low-priority child
    // process; a synchronous list request must never traverse provider storage.
    const storedSessions = adapter.listStoredSessions?.() ?? [];
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
    entry.historyMeta?.bytes ?? "",
    entry.historyMeta?.lines ?? "",
    entry.historyMeta?.messages ?? "",
    entry.providerState?.archived ?? "",
    entry.providerState?.archivedAt ?? "",
    entry.libraryState?.placement ?? "",
    entry.libraryState?.archivedAt ?? "",
    entry.libraryState?.backend ?? "",
    entry.removalDisposition ?? "",
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

export function sessionProviderKey(session: Pick<StoredSessionRef, "provider" | "providerSessionId">): string {
  return `${session.provider}:${session.providerSessionId}`;
}

function normalizedPathForInternalCheck(value: string | undefined): string {
  return value ? value.replace(/\\/g, "/").replace(/\/+$/, "") : "";
}

function isInternalNativeTuiProbeSession(session: Pick<StoredSessionRef, "cwd" | "rootDir">): boolean {
  const paths = [
    normalizedPathForInternalCheck(session.cwd),
    normalizedPathForInternalCheck(session.rootDir),
  ];
  return paths.some(
    (path) =>
      path.includes(INTERNAL_NATIVE_TUI_PROBE_WORKSPACE_SEGMENT) ||
      path.endsWith("/test-results/native-real-tui-workspaces"),
  );
}

function isInternalNativeTuiProbeWorkspace(directory: string): boolean {
  return isInternalNativeTuiProbeSession({ cwd: directory, rootDir: directory });
}

function sessionRecentTimestamp(session: StoredSessionRef): string {
  if (session.source === "previous_running") {
    return session.lastUsedAt ?? session.createdAt ?? session.updatedAt ?? "";
  }
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
    sessionRecentTimestamp(left),
    sessionRecentTimestamp(right),
  );
  return {
    ...fallback,
    ...metadata,
    ...(lastUsedAt ? { lastUsedAt } : {}),
  };
}

function runningSessionRef(state: StoredSessionState): StoredSessionRef | null {
  const providerSessionId = state.session.providerSessionId;
  if (!providerSessionId) {
    return null;
  }
  const activityAt = state.conversationActivityAt ?? state.session.createdAt;
  return {
    provider: state.session.provider,
    providerSessionId,
    cwd: state.session.cwd,
    rootDir: state.session.rootDir,
    ...(state.session.title !== undefined ? { title: state.session.title } : {}),
    ...(state.session.preview !== undefined ? { preview: state.session.preview } : {}),
    createdAt: state.session.createdAt,
    updatedAt: activityAt,
    lastUsedAt: activityAt,
    source: "previous_running",
  };
}

function buildGlobalRecentSessions(args: {
  discoveredStoredSessions: Iterable<StoredSessionRef>;
  rememberedRecentSessions: readonly StoredSessionRef[];
  visibleRunningStates: readonly StoredSessionState[];
  hiddenSessionKeys: ReadonlySet<string>;
  availableProviderSessionKeys: ReadonlySet<string>;
  applyTitleOverride: (session: StoredSessionRef) => StoredSessionRef;
}): StoredSessionRef[] {
  const recentByKey = new Map<string, StoredSessionRef>();
  const archivedSessionKeys = new Set<string>();
  const discoveredProviderStateByKey = new Map<
    string,
    StoredSessionRef["providerState"]
  >();
  const addCandidate = (session: StoredSessionRef) => {
    const key = sessionProviderKey(session);
    if (
      archivedSessionKeys.has(key) ||
      session.libraryState?.placement === "archive" ||
      session.providerState?.archived === true
    ) {
      return;
    }
    if (args.hiddenSessionKeys.has(key)) {
      return;
    }
    // Remembered rows are presentation cache, never provider identity
    // authority. A complete provider catalog may remove a task (or newly
    // classify a rollout as non-task), so every remembered candidate must
    // still be backed by either the current catalog or a real live runtime.
    if (!args.availableProviderSessionKeys.has(key)) {
      return;
    }
    const existing = recentByKey.get(key);
    recentByKey.set(key, existing ? mergeStoredSessionRef(existing, session) : session);
  };

  for (const session of args.discoveredStoredSessions) {
    const key = sessionProviderKey(session);
    discoveredProviderStateByKey.set(key, session.providerState);
    if (
      session.libraryState?.placement === "archive" ||
      session.providerState?.archived === true
    ) {
      archivedSessionKeys.add(key);
    }
    addCandidate(session);
  }
  for (const session of args.rememberedRecentSessions) {
    addCandidate(session);
  }
  for (const state of args.visibleRunningStates) {
    const session = runningSessionRef(state);
    if (session) {
      addCandidate(session);
    }
  }

  return [...recentByKey.values()]
    .map((session) => {
      const key = sessionProviderKey(session);
      if (!discoveredProviderStateByKey.has(key)) {
        return session;
      }
      const providerState = discoveredProviderStateByKey.get(key);
      if (providerState) {
        return {
          ...session,
          providerState,
        };
      }
      const { providerState: _staleProviderState, ...withoutProviderState } = session;
      void _staleProviderState;
      return withoutProviderState;
    })
    .sort((a, b) => sessionRecentTimestamp(b).localeCompare(sessionRecentTimestamp(a)))
    .slice(0, RECENT_SESSION_LIMIT)
    .map(args.applyTitleOverride);
}

export function buildSessionsResponse(args: {
  liveStates: readonly StoredSessionState[];
  discoveredStoredSessions: readonly StoredSessionRef[];
  remembered: RememberedWorkbenchSessionState;
  isClosingSession: (sessionId: string) => boolean;
  storedSessionsMode?: StoredSessionsResponseMode;
  excludedProviderSessionKeys?: ReadonlySet<string>;
}): ListSessionsResponse {
  const discoveredProviderSessionKeys = new Set(
    args.discoveredStoredSessions.map(sessionProviderKey),
  );
  const userFacingLiveStates = args.liveStates.filter(
    (state) =>
      !isInternalNativeTuiProbeSession(state.session) &&
      state.session.origin?.kind !== "council" &&
      !(
        state.session.runtime?.kind === "stored_history" &&
        state.session.providerSessionId &&
        !discoveredProviderSessionKeys.has(
          sessionProviderKey({
            provider: state.session.provider,
            providerSessionId: state.session.providerSessionId,
          }),
        )
      ) &&
      (!state.session.providerSessionId ||
        !args.excludedProviderSessionKeys?.has(sessionProviderKey({
          provider: state.session.provider,
          providerSessionId: state.session.providerSessionId,
        }))),
  );
  const visibleRunningStates = userFacingLiveStates.filter(
    (state) => !args.isClosingSession(state.session.id),
  );
  const rememberedSessions = args.remembered.rememberedSessions.filter(
    (session) =>
      !isInternalNativeTuiProbeSession(session) &&
      !args.excludedProviderSessionKeys?.has(sessionProviderKey(session)),
  );
  const rememberedRecentSessions = args.remembered.rememberedRecentSessions.filter(
    (session) =>
      !isInternalNativeTuiProbeSession(session) &&
      !args.excludedProviderSessionKeys?.has(sessionProviderKey(session)),
  );
  const discoveredStoredSessions = args.discoveredStoredSessions.filter(
    (session) =>
      !isInternalNativeTuiProbeSession(session) &&
      !args.excludedProviderSessionKeys?.has(sessionProviderKey(session)),
  );
  const titleContext = {
    titleOverrides: args.remembered.rememberedSessionTitleOverrides,
    discoveredStoredSessions,
  };
  const applyCanonicalTitle = (session: StoredSessionRef): StoredSessionRef =>
    applyCanonicalTitleToStoredSession(session, titleContext);
  const rememberedWorkspaceDirs = args.remembered.rememberedWorkspaceDirs.filter(
    (workspace) => !isInternalNativeTuiProbeWorkspace(workspace),
  );
  const rememberedHiddenWorkspaces = args.remembered.rememberedHiddenWorkspaces.filter(
    (workspace) => !isInternalNativeTuiProbeWorkspace(workspace),
  );
  const rememberedActiveWorkspaceDir =
    args.remembered.rememberedActiveWorkspaceDir &&
    !isInternalNativeTuiProbeWorkspace(args.remembered.rememberedActiveWorkspaceDir)
      ? args.remembered.rememberedActiveWorkspaceDir
      : undefined;
  const hiddenSessionKeys = new Set(args.remembered.rememberedHiddenSessionKeys);
  const availableProviderSessionKeys = new Set<string>();
  const discoveredByKey = new Map<string, StoredSessionRef>();
  for (const stored of discoveredStoredSessions) {
    const key = sessionProviderKey(stored);
    availableProviderSessionKeys.add(key);
    discoveredByKey.set(key, stored);
  }
  for (const state of visibleRunningStates) {
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
  for (const remembered of rememberedSessions) {
    const key = sessionProviderKey(remembered);
    if (hiddenSessionKeys.has(key)) {
      continue;
    }
    if (!availableProviderSessionKeys.has(key)) {
      continue;
    }
    storedSessions.set(key, remembered);
  }
  for (const stored of discoveredStoredSessions) {
    if (hiddenSessionKeys.has(sessionProviderKey(stored))) {
      continue;
    }
    storedSessions.set(sessionProviderKey(stored), stored);
  }
  const allStoredSessions = [...storedSessions.values()].map(applyCanonicalTitle);
  const recentSessions = buildGlobalRecentSessions({
    discoveredStoredSessions,
    rememberedRecentSessions,
    visibleRunningStates,
    hiddenSessionKeys,
    availableProviderSessionKeys,
    applyTitleOverride: applyCanonicalTitle,
  });
  const responseStoredSessions =
    args.storedSessionsMode === "all" || args.storedSessionsMode === "cached"
      ? allStoredSessions
      : recentSessions;

  return {
    sessions: visibleRunningStates.map((state) => {
      const providerSessionId = state.session.providerSessionId;
      if (!providerSessionId) {
        return toSessionSummary(state);
      }
      const discovered = discoveredByKey.get(sessionProviderKey({
        provider: state.session.provider,
        providerSessionId,
      }));
      if (!discovered) {
        return applyCanonicalTitleToSessionSummary(toSessionSummary(state), titleContext);
      }
      const summary = toSessionSummary({
        ...state,
        session: {
          ...state.session,
          ...(discovered.title !== undefined ? { title: discovered.title } : {}),
          ...(discovered.preview !== undefined ? { preview: discovered.preview } : {}),
        },
      });
      return applyCanonicalTitleToSessionSummary(summary, titleContext);
    }),
    storedSessions: responseStoredSessions,
    recentSessions,
    // Sidebar workspaces are an explicit user selection. A provider process
    // may run in another directory, but that must not silently register the
    // directory or project its history into the sidebar.
    workspaceDirs: configuredWorkspaceDirs(rememberedWorkspaceDirs),
    hiddenWorkspaces: rememberedHiddenWorkspaces,
    ...(rememberedActiveWorkspaceDir
      ? { activeWorkspaceDir: rememberedActiveWorkspaceDir }
      : {}),
    pinnedSidebarItems: (args.remembered.rememberedPinnedSidebarItems ?? []).map((item) => ({ ...item })),
  };
}

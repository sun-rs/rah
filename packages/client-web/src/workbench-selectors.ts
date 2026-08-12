import type { SessionSummary, StoredSessionRef } from "@rah/runtime-protocol";
import { isReadOnlyReplay } from "./session-capabilities";
import {
  deriveWorkspaceInfos,
  deriveWorkspaceSections,
  findOwningWorkspace,
  groupRunningSessionsByDirectory,
  isPathOwnedByHiddenWorkspace,
  sortWorkspaceInfos,
  type SessionDirectoryGroup,
  type WorkspaceInfo,
  type WorkspaceSection,
  type WorkspaceSortMode,
} from "./session-browser";
import { deriveSessionConversationActivityAt } from "./session-conversation-activity";
import type { SessionProjection } from "./types";
import type { PendingSessionTransition } from "./session-transition-contract";
import { visibleStoredSessionRefs } from "./session-history-grouping";
import { isHiddenWorkspace } from "./session-store-workspace";

export interface PrimaryPaneState {
  kind: "active" | "opening" | "empty";
  openingSession: PendingSessionTransition | null;
}

export interface WorkbenchSessionCollections {
  /** Primary sessions shown in Chats and the workspace sidebar. */
  sessionEntries: SessionProjection[];
  /** Ephemeral Side children stay addressable without entering primary navigation. */
  sideSessionEntries: SessionProjection[];
  runningSessionEntries: SessionProjection[];
  controlledRunningSessionEntries: SessionProjection[];
  runningSessionSummaries: SessionSummary[];
  controlledRunningSessionSummaries: SessionSummary[];
  daemonRunningSessionByProviderSessionId: Map<string, SessionSummary>;
  controlledRunningSessionByProviderSessionId: Map<string, SessionSummary>;
  runningSessionActivityAtById: ReadonlyMap<string, string>;
  runningGroups: SessionDirectoryGroup<SessionSummary>[];
  workspaceInfos: WorkspaceInfo[];
  sortedWorkspaceInfos: WorkspaceInfo[];
  workspaceSections: WorkspaceSection[];
  /** Stored sessions whose most-specific registered workspace remains visible. */
  sidebarStoredSessions: StoredSessionRef[];
}

function sortSessionEntries(projections: Map<string, SessionProjection>): SessionProjection[] {
  return [...projections.values()].sort((left, right) =>
    right.summary.session.updatedAt.localeCompare(left.summary.session.updatedAt),
  );
}

function storedSessionActivityAt(ref: StoredSessionRef | undefined): string | undefined {
  // `lastUsedAt` is navigation activity. Using it here makes a row jump merely
  // because it was opened, even when the conversation itself did not change.
  return ref?.updatedAt ?? ref?.createdAt ?? ref?.lastUsedAt;
}

function runningStoredSessionKey(session: SessionSummary["session"]): string | null {
  if (!session.providerSessionId) {
    return null;
  }
  return `${session.provider}:${session.providerSessionId}`;
}

function storedSessionKey(ref: StoredSessionRef): string {
  return `${ref.provider}:${ref.providerSessionId}`;
}

export function isSessionAttachedToClient(summary: SessionSummary, clientId: string): boolean {
  return summary.attachedClients.some((client) => client.id === clientId);
}

export function projectionHasLatestTurnError(projection: SessionProjection): boolean {
  let latestAt = "";
  let failed = false;
  for (const turn of projection.conversation?.turns ?? []) {
    const at = turn.completedAt ?? turn.startedAt ?? "";
    if (at >= latestAt) {
      latestAt = at;
      failed = turn.status === "failed";
    }
  }
  for (const event of projection.events) {
    if (
      event.type !== "turn.started" &&
      event.type !== "turn.completed" &&
      event.type !== "turn.failed" &&
      event.type !== "turn.canceled"
    ) {
      continue;
    }
    if (event.ts >= latestAt) {
      latestAt = event.ts;
      failed = event.type === "turn.failed";
    }
  }
  return failed;
}

function isControlledByClient(summary: SessionSummary, clientId: string): boolean {
  return (
    summary.controlLease.holderClientId === clientId &&
    isSessionAttachedToClient(summary, clientId)
  );
}

function isEndedNativeTuiSession(summary: SessionSummary): boolean {
  return (
    summary.session.liveBackend === "native_tui" &&
    summary.session.status === "stopped"
  );
}

export function derivePrimaryPaneState(args: {
  selectedSummary: SessionSummary | null;
  pendingSessionTransition: PendingSessionTransition | null;
}): PrimaryPaneState {
  if (args.selectedSummary) {
    return { kind: "active", openingSession: null };
  }
  const openingSession = args.pendingSessionTransition;
  if (openingSession) {
    return {
      kind: "opening",
      openingSession,
    };
  }
  return {
    kind: "empty",
    openingSession: null,
  };
}

export function deriveWorkbenchSessionCollections(args: {
  projections: Map<string, SessionProjection>;
  clientId: string;
  workspaceDirs: string[];
  storedSessions: StoredSessionRef[];
  workspaceDir: string;
  workspaceSortMode: WorkspaceSortMode;
  hiddenWorkspaceDirs?: ReadonlySet<string>;
}): WorkbenchSessionCollections {
  const allSessionEntries = sortSessionEntries(args.projections);
  const sideSessionEntries = allSessionEntries.filter(
    (entry) => entry.summary.session.relationship?.kind === "side",
  );
  const sessionEntries = allSessionEntries.filter(
    (entry) =>
      entry.summary.session.relationship?.kind !== "side" &&
      entry.summary.session.origin?.kind !== "council",
  );
  const storedSessionByKey = new Map(
    args.storedSessions.map((ref) => [storedSessionKey(ref), ref] as const),
  );
  const sessionActivityAtById = new Map(
    sessionEntries.map((entry) => {
      const key = runningStoredSessionKey(entry.summary.session);
      const storedActivityAt = key ? storedSessionActivityAt(storedSessionByKey.get(key)) : undefined;
      return [
        entry.summary.session.id,
        deriveSessionConversationActivityAt(entry, { fallbackActivityAt: storedActivityAt }),
      ] as const;
    }),
  );
  const runningSessionEntries = sessionEntries.filter(
    (entry) => !isReadOnlyReplay(entry.summary) && !isEndedNativeTuiSession(entry.summary),
  );
  const runningSessionActivityAtById = new Map(
    runningSessionEntries.map((entry) => [
      entry.summary.session.id,
      sessionActivityAtById.get(entry.summary.session.id) ?? entry.summary.session.updatedAt,
    ] as const),
  );
  const controlledRunningSessionEntries = runningSessionEntries.filter((entry) =>
    isControlledByClient(entry.summary, args.clientId),
  );
  const runningSessionSummaries = runningSessionEntries.map((entry) => entry.summary);
  const controlledRunningSessionSummaries = controlledRunningSessionEntries.map((entry) => entry.summary);
  const daemonRunningSessionByProviderSessionId = new Map(
    runningSessionEntries
      .filter((entry) => entry.summary.session.providerSessionId)
      .map((entry) => [entry.summary.session.providerSessionId!, entry.summary] as const),
  );
  const controlledRunningSessionByProviderSessionId = new Map(
    controlledRunningSessionEntries
      .filter((entry) => entry.summary.session.providerSessionId)
      .map((entry) => [entry.summary.session.providerSessionId!, entry.summary] as const),
  );
  const runningGroups = groupRunningSessionsByDirectory(
    runningSessionSummaries,
    args.workspaceDir,
    { sessionActivityAtById },
  );
  const hiddenWorkspaceDirs = args.hiddenWorkspaceDirs ?? new Set<string>();
  const sidebarWorkspaceDirs = args.workspaceDirs.filter(
    (directory) => !isHiddenWorkspace(hiddenWorkspaceDirs, directory),
  );
  const sidebarRunningSessionSummaries = runningSessionSummaries.filter(
    (summary) =>
      !isPathOwnedByHiddenWorkspace(
        sidebarWorkspaceDirs,
        hiddenWorkspaceDirs,
        summary.session.rootDir || summary.session.cwd,
      ),
  );
  const sidebarStoredSessions = visibleStoredSessionRefs(args.storedSessions).filter(
    (session) => {
      const sessionPath = session.rootDir || session.cwd;
      return (
        findOwningWorkspace(sidebarWorkspaceDirs, sessionPath) !== null &&
        !isPathOwnedByHiddenWorkspace(
          sidebarWorkspaceDirs,
          hiddenWorkspaceDirs,
          sessionPath,
        )
      );
    },
  );
  const workspaceInfos = deriveWorkspaceInfos(
    sidebarWorkspaceDirs,
    sidebarRunningSessionSummaries,
    sidebarStoredSessions,
    sidebarRunningSessionSummaries,
    { sessionActivityAtById, includeStoredSessionActivity: true },
  );
  const sortedWorkspaceInfos = sortWorkspaceInfos(workspaceInfos, args.workspaceSortMode);
  const workspaceSections = deriveWorkspaceSections(
    sortedWorkspaceInfos,
    sidebarRunningSessionSummaries,
    { sessionActivityAtById },
  );

  return {
    sessionEntries,
    sideSessionEntries,
    runningSessionEntries,
    controlledRunningSessionEntries,
    runningSessionSummaries,
    controlledRunningSessionSummaries,
    daemonRunningSessionByProviderSessionId,
    controlledRunningSessionByProviderSessionId,
    runningSessionActivityAtById,
    runningGroups,
    workspaceInfos,
    sortedWorkspaceInfos,
    workspaceSections,
    sidebarStoredSessions,
  };
}

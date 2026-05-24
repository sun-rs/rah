import type { SessionSummary, StoredSessionRef } from "@rah/runtime-protocol";
import { isReadOnlyReplay } from "./session-capabilities";
import {
  deriveWorkspaceInfos,
  deriveWorkspaceSections,
  groupRunningSessionsByDirectory,
  sortWorkspaceInfos,
  type SessionDirectoryGroup,
  type WorkspaceInfo,
  type WorkspaceSection,
  type WorkspaceSortMode,
} from "./session-browser";
import { deriveSessionConversationActivityAt } from "./session-conversation-activity";
import type { SessionProjection } from "./types";
import type { PendingSessionTransition } from "./session-transition-contract";

export interface PrimaryPaneState {
  kind: "active" | "opening" | "empty";
  openingSession: PendingSessionTransition | null;
}

export interface WorkbenchSessionCollections {
  sessionEntries: SessionProjection[];
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
}

function sortSessionEntries(projections: Map<string, SessionProjection>): SessionProjection[] {
  return [...projections.values()].sort((left, right) =>
    right.summary.session.updatedAt.localeCompare(left.summary.session.updatedAt),
  );
}

export function isSessionAttachedToClient(summary: SessionSummary, clientId: string): boolean {
  return summary.attachedClients.some((client) => client.id === clientId);
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
    (summary.session.status === "stopped" || summary.session.runtimeState === "stopped")
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
}): WorkbenchSessionCollections {
  const sessionEntries = sortSessionEntries(args.projections);
  const sessionActivityAtById = new Map(
    sessionEntries.map((entry) => [
      entry.summary.session.id,
      deriveSessionConversationActivityAt(entry),
    ] as const),
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
  const workspaceInfos = deriveWorkspaceInfos(
    args.workspaceDirs,
    runningSessionSummaries,
    args.storedSessions,
    runningSessionSummaries,
    { sessionActivityAtById, includeStoredSessionActivity: false },
  );
  const sortedWorkspaceInfos = sortWorkspaceInfos(workspaceInfos, args.workspaceSortMode);
  const workspaceSections = deriveWorkspaceSections(
    sortedWorkspaceInfos,
    runningSessionSummaries,
    { sessionActivityAtById },
  );

  return {
    sessionEntries,
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
  };
}

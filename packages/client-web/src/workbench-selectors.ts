import type { SessionSummary, StoredSessionRef } from "@rah/runtime-protocol";
import { isReadOnlyReplay } from "./session-capabilities";
import {
  deriveWorkspaceInfos,
  deriveWorkspaceSections,
  groupLiveSessionsByDirectory,
  sortWorkspaceInfos,
  type SessionDirectoryGroup,
  type WorkspaceInfo,
  type WorkspaceSection,
  type WorkspaceSortMode,
} from "./session-browser";
import type { SessionProjection } from "./types";
import type { PendingSessionTransition } from "./session-transition-contract";

export interface PrimaryPaneState {
  kind: "active" | "opening" | "empty";
  openingSession: PendingSessionTransition | null;
}

export interface WorkbenchSessionCollections {
  sessionEntries: SessionProjection[];
  liveSessionEntries: SessionProjection[];
  controlledLiveSessionEntries: SessionProjection[];
  liveSessionSummaries: SessionSummary[];
  controlledLiveSessionSummaries: SessionSummary[];
  daemonLiveSessionByProviderSessionId: Map<string, SessionSummary>;
  controlledLiveSessionByProviderSessionId: Map<string, SessionSummary>;
  liveGroups: SessionDirectoryGroup<SessionSummary>[];
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
  const liveSessionEntries = sessionEntries.filter((entry) => !isReadOnlyReplay(entry.summary));
  const controlledLiveSessionEntries = liveSessionEntries.filter((entry) =>
    isControlledByClient(entry.summary, args.clientId),
  );
  const liveSessionSummaries = liveSessionEntries.map((entry) => entry.summary);
  const controlledLiveSessionSummaries = controlledLiveSessionEntries.map((entry) => entry.summary);
  const daemonLiveSessionByProviderSessionId = new Map(
    liveSessionEntries
      .filter((entry) => entry.summary.session.providerSessionId)
      .map((entry) => [entry.summary.session.providerSessionId!, entry.summary] as const),
  );
  const controlledLiveSessionByProviderSessionId = new Map(
    controlledLiveSessionEntries
      .filter((entry) => entry.summary.session.providerSessionId)
      .map((entry) => [entry.summary.session.providerSessionId!, entry.summary] as const),
  );
  const liveGroups = groupLiveSessionsByDirectory(
    liveSessionSummaries,
    args.workspaceDir,
  );
  const workspaceInfos = deriveWorkspaceInfos(
    args.workspaceDirs,
    liveSessionSummaries,
    args.storedSessions,
    liveSessionSummaries,
  );
  const sortedWorkspaceInfos = sortWorkspaceInfos(workspaceInfos, args.workspaceSortMode);
  const workspaceSections = deriveWorkspaceSections(
    sortedWorkspaceInfos,
    liveSessionSummaries,
  );

  return {
    sessionEntries,
    liveSessionEntries,
    controlledLiveSessionEntries,
    liveSessionSummaries,
    controlledLiveSessionSummaries,
    daemonLiveSessionByProviderSessionId,
    controlledLiveSessionByProviderSessionId,
    liveGroups,
    workspaceInfos,
    sortedWorkspaceInfos,
    workspaceSections,
  };
}

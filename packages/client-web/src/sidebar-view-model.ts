import type { CouncilSnapshot, SessionSummary, StoredSessionRef } from "@rah/runtime-protocol";
import { findOwningWorkspace, formatCompactRelativeTime, type WorkspaceSection } from "./session-browser";
import { providerLabel } from "./types";
import { councilActivityAt } from "./council/council-activity";
import { isStoredSessionArchived } from "./session-history-grouping";

export type SidebarActivityStatus = "stopped" | "running" | "working" | "unread" | "error";
export type SidebarSessionStatus = SidebarActivityStatus;
export type SidebarCouncilStatus = SidebarActivityStatus;

export interface SidebarSessionViewModel {
  kind: "session";
  id: string;
  stableKey: string;
  pinItemKey: string;
  pinItemKeys: string[];
  running: boolean;
  archivable: boolean;
  runtimeSessionId?: string;
  storedRef?: StoredSessionRef;
  provider: SessionSummary["session"]["provider"];
  originKind?: "council";
  title: string;
  status: SidebarSessionStatus;
  statusLabel: string;
  updatedAtLabel: string;
  workspaceDir: string;
  workspaceLabel: string;
  selected: boolean;
  pinned: boolean;
}

export interface SidebarCouncilViewModel {
  kind: "council";
  id: string;
  stableKey: string;
  title: string;
  activityAt: string;
  workspaceDir: string;
  workspaceLabel: string;
  status: SidebarCouncilStatus;
  statusLabel: string;
  updatedAtLabel: string;
  selected: boolean;
  messageCount: number;
}

export type SidebarPinnedItemRef = {
  workspaceDir: string;
  itemKey: string;
};

export type SidebarPinnedItemViewModel = {
  workspaceDir: string;
  item: SidebarSessionViewModel;
};

export interface SidebarWorkspaceViewModel {
  directory: string;
  displayName: string;
  hasBlockingRunningSessions: boolean;
  selected: boolean;
  sessions: SidebarSessionViewModel[];
  items: SidebarSessionViewModel[];
}

function deriveSidebarSessionStatus(args: {
  summary: SessionSummary;
  runtimeStatus: "thinking" | "streaming" | "stopping" | "retrying" | undefined;
  unread: boolean;
  errored: boolean;
}): SidebarSessionStatus {
  if (
    args.errored ||
    args.summary.session.phase === "failed" ||
    args.summary.session.runtimeState === "failed" ||
    args.summary.session.runtimeDiagnostics?.attachState === "failed"
  ) {
    return "error";
  }
  if (args.summary.session.origin?.kind !== "council" && (
    args.runtimeStatus !== undefined ||
    ["starting", "working", "waiting_permission", "stopping"].includes(
      args.summary.session.phase,
    )
  )) {
    return "working";
  }
  if (args.unread) {
    return "unread";
  }
  return args.summary.session.status === "running" ? "running" : "stopped";
}

function sidebarStatusLabel(status: SidebarSessionStatus): string {
  switch (status) {
    case "stopped":
      return "";
    case "working":
      return "working";
    case "unread":
      return "unread";
    case "error":
      return "error";
    case "running":
      return "running";
  }
}

function isRunningCouncil(council: CouncilSnapshot): boolean {
  return council.status === "running";
}

function deriveCouncilStatus(
  council: CouncilSnapshot,
  unread: boolean,
): SidebarCouncilStatus {
  if (
    council.phase === "failed" ||
    Boolean(council.error?.trim()) ||
    council.agents.some((agent) => agent.status === "failed")
  ) {
    return "error";
  }
  if (["starting", "working", "waiting_permission", "stopping"].includes(council.phase)) {
    return "working";
  }
  if (unread) {
    return "unread";
  }
  return council.status === "running" ? "running" : "stopped";
}

function councilStatusLabel(status: SidebarCouncilStatus): string {
  switch (status) {
    case "working":
      return "working";
    case "unread":
      return "unread";
    case "error":
      return "error";
    case "running":
      return "running";
    case "stopped":
      return "";
  }
}

export function deriveSidebarCouncilViewModels(args: {
  councils: readonly CouncilSnapshot[];
  workspaceSections: readonly WorkspaceSection[];
  selectedCouncilId?: string | null;
  unreadCouncilIds?: ReadonlySet<string> | undefined;
}): SidebarCouncilViewModel[] {
  const workspaceLabelByDir = new Map(
    args.workspaceSections.map((section) => [
      section.workspace.directory,
      section.workspace.displayName,
    ] as const),
  );

  return args.councils
    .filter(isRunningCouncil)
    .sort((left, right) => councilActivityAt(right).localeCompare(councilActivityAt(left)))
    .map((council) => {
      const status = deriveCouncilStatus(
        council,
        args.unreadCouncilIds?.has(council.id) ?? false,
      );
      const activityAt = councilActivityAt(council);
      return {
        kind: "council" as const,
        id: council.id,
        stableKey: `council:${council.id}`,
        title: council.title,
        activityAt,
        workspaceDir: council.workspace,
        workspaceLabel: workspaceLabelByDir.get(council.workspace) ?? council.workspace,
        status,
        statusLabel: councilStatusLabel(status),
        updatedAtLabel: formatCompactRelativeTime(activityAt) ?? "",
        selected: council.id === args.selectedCouncilId,
        messageCount:
          council.meta?.messageCount ??
          council.messageWindow?.total ??
          council.messages.length,
      };
    });
}

function sessionSidebarSortActivityAt(
  session: SessionSummary,
  activityAtById: ReadonlyMap<string, string> | undefined,
): string {
  return activityAtById?.get(session.session.id) ?? session.session.updatedAt;
}

function sessionSidebarDisplayActivityAt(
  session: SessionSummary,
  activityAtById: ReadonlyMap<string, string> | undefined,
): string {
  const activityAt = activityAtById?.get(session.session.id);
  if (!activityAt) {
    return session.session.updatedAt;
  }
  return activityAt.localeCompare(session.session.updatedAt) >= 0
    ? activityAt
    : session.session.updatedAt;
}

export function sidebarSessionItemKey(sessionId: string): string {
  return `session:${sessionId}`;
}

export function sidebarProviderSessionItemKey(
  provider: StoredSessionRef["provider"],
  providerSessionId: string,
): string {
  return `session:${provider}:${providerSessionId}`;
}

function sidebarWorkspacePinnedKeys(
  refs: readonly SidebarPinnedItemRef[],
  workspaceDir: string,
): ReadonlySet<string> {
  return new Set(
    refs
      .filter((ref) => ref.workspaceDir === workspaceDir)
      .map((ref) => ref.itemKey),
  );
}

export function deriveSidebarWorkspaceViewModels(args: {
  workspaceSections: WorkspaceSection[];
  storedSessions?: readonly StoredSessionRef[];
  selectedWorkspaceDir: string;
  selectedSessionId: string | null;
  selectedStoredSessionKey?: string | null;
  unreadSessionIds: ReadonlySet<string>;
  runtimeStatusBySessionId: ReadonlyMap<
    string,
    "thinking" | "streaming" | "stopping" | "retrying" | undefined
  >;
  erroredSessionIds?: ReadonlySet<string> | undefined;
  pinnedItems: readonly SidebarPinnedItemRef[];
  runningSessionActivityAtById?: ReadonlyMap<string, string> | undefined;
  selectedCouncilId?: string | null;
}): SidebarWorkspaceViewModel[] {
  const hasSelectedConversation =
    args.selectedSessionId !== null ||
    (args.selectedStoredSessionKey ?? null) !== null ||
    (args.selectedCouncilId ?? null) !== null;
  const workspaceDirs = args.workspaceSections.map((section) => section.workspace.directory);
  const storedSessionsByWorkspace = new Map<string, StoredSessionRef[]>(
    workspaceDirs.map((directory) => [directory, []]),
  );
  for (const session of args.storedSessions ?? []) {
    if (isStoredSessionArchived(session)) {
      continue;
    }
    const owner = findOwningWorkspace(workspaceDirs, session.rootDir || session.cwd);
    if (owner) {
      storedSessionsByWorkspace.get(owner)?.push(session);
    }
  }
  return args.workspaceSections.map((section) => {
    const pinnedItemKeys = sidebarWorkspacePinnedKeys(
      args.pinnedItems,
      section.workspace.directory,
    );
    const sortedSessions = [...section.sessions].sort((left, right) =>
      sessionSidebarSortActivityAt(right, args.runningSessionActivityAtById).localeCompare(
        sessionSidebarSortActivityAt(left, args.runningSessionActivityAtById),
      ),
    );

    const runningIdentityKeys = new Set(
      sortedSessions.flatMap((session) =>
        session.session.providerSessionId
          ? [`${session.session.provider}:${session.session.providerSessionId}`]
          : [],
      ),
    );
    const runningSessions: SidebarSessionViewModel[] = sortedSessions.map((session) => {
      const status = deriveSidebarSessionStatus({
        summary: session,
        runtimeStatus: args.runtimeStatusBySessionId.get(session.session.id),
        unread: args.unreadSessionIds.has(session.session.id),
        errored: args.erroredSessionIds?.has(session.session.id) ?? false,
      });
      const legacyPinItemKey = sidebarSessionItemKey(session.session.id);
      const canonicalPinItemKey = session.session.providerSessionId
        ? sidebarProviderSessionItemKey(
            session.session.provider,
            session.session.providerSessionId,
          )
        : legacyPinItemKey;
      const pinItemKeys = canonicalPinItemKey === legacyPinItemKey
        ? [canonicalPinItemKey]
        : [canonicalPinItemKey, legacyPinItemKey];
      const matchedPinItemKey = pinItemKeys.find((key) => pinnedItemKeys.has(key));

      return {
        kind: "session" as const,
        id: session.session.id,
        stableKey: canonicalPinItemKey,
        pinItemKey: matchedPinItemKey ?? canonicalPinItemKey,
        pinItemKeys,
        running: true,
        archivable: Boolean(session.session.providerSessionId),
        runtimeSessionId: session.session.id,
        provider: session.session.provider,
        ...(session.session.origin ? { originKind: session.session.origin.kind } : {}),
        title: session.session.title ?? providerLabel(session.session.provider),
        status,
        statusLabel: sidebarStatusLabel(status),
        updatedAtLabel:
          formatCompactRelativeTime(
            sessionSidebarDisplayActivityAt(session, args.runningSessionActivityAtById),
          ) ?? "",
        workspaceDir: section.workspace.directory,
        workspaceLabel: section.workspace.displayName,
        selected: session.session.id === args.selectedSessionId,
        pinned: matchedPinItemKey !== undefined,
      };
    });
    const stoppedSessions: SidebarSessionViewModel[] = (storedSessionsByWorkspace.get(section.workspace.directory) ?? [])
      .filter(
        (session) =>
          !runningIdentityKeys.has(`${session.provider}:${session.providerSessionId}`),
      )
      .map((session) => {
        const pinItemKey = sidebarProviderSessionItemKey(
          session.provider,
          session.providerSessionId,
        );
        return {
          kind: "session" as const,
          id: `stored:${session.provider}:${session.providerSessionId}`,
          stableKey: pinItemKey,
          pinItemKey,
          pinItemKeys: [pinItemKey],
          running: false,
          archivable: true,
          storedRef: session,
          provider: session.provider,
          title: session.title ?? session.preview ?? providerLabel(session.provider),
          status: "stopped" as const,
          statusLabel: "",
          updatedAtLabel:
            formatCompactRelativeTime(
              session.updatedAt ?? session.createdAt ?? session.lastUsedAt,
            ) ?? "",
          workspaceDir: section.workspace.directory,
          workspaceLabel: section.workspace.displayName,
          selected:
            args.selectedStoredSessionKey ===
            `${session.provider}:${session.providerSessionId}`,
          pinned: pinnedItemKeys.has(pinItemKey),
        };
      });
    const sessions = [...runningSessions, ...stoppedSessions].sort((left, right) => {
      const leftSession = left.running
        ? sortedSessions.find((entry) => entry.session.id === left.runtimeSessionId)
        : undefined;
      const rightSession = right.running
        ? sortedSessions.find((entry) => entry.session.id === right.runtimeSessionId)
        : undefined;
      const leftAt = leftSession
        ? sessionSidebarSortActivityAt(leftSession, args.runningSessionActivityAtById)
        : left.storedRef?.updatedAt ?? left.storedRef?.createdAt ?? left.storedRef?.lastUsedAt ?? "";
      const rightAt = rightSession
        ? sessionSidebarSortActivityAt(rightSession, args.runningSessionActivityAtById)
        : right.storedRef?.updatedAt ?? right.storedRef?.createdAt ?? right.storedRef?.lastUsedAt ?? "";
      const activityOrder = rightAt.localeCompare(leftAt);
      if (activityOrder !== 0) {
        return activityOrder;
      }
      if (left.running !== right.running) {
        return left.running ? -1 : 1;
      }
      const providerOrder = { codex: 0, claude: 1, opencode: 2, custom: 3 } as const;
      return (
        providerOrder[left.provider] - providerOrder[right.provider] ||
        left.stableKey.localeCompare(right.stableKey)
      );
    });
    return {
      directory: section.workspace.directory,
      displayName: section.workspace.displayName,
      hasBlockingRunningSessions: section.workspace.hasBlockingRunningSessions,
      selected:
        !hasSelectedConversation &&
        section.workspace.directory === args.selectedWorkspaceDir,
      sessions,
      items: sessions,
    };
  });
}

function sidebarWorkspaceItemKeys(item: SidebarSessionViewModel): readonly string[] {
  return item.pinItemKeys;
}

export function partitionSidebarPinnedItems(
  workspaces: readonly SidebarWorkspaceViewModel[],
  refs: readonly SidebarPinnedItemRef[],
): {
  pinnedItems: SidebarPinnedItemViewModel[];
  workspaces: SidebarWorkspaceViewModel[];
} {
  const workspaceByDir = new Map(
    workspaces.map((workspace) => [workspace.directory, workspace] as const),
  );
  const pinnedKeys = new Set<string>();
  const pinnedItemIdentities = new Set<string>();
  const pinnedItems: SidebarPinnedItemViewModel[] = [];
  for (const ref of refs) {
    const key = `${ref.workspaceDir}\u0000${ref.itemKey}`;
    if (pinnedKeys.has(key)) {
      continue;
    }
    const workspace = workspaceByDir.get(ref.workspaceDir);
    const item = workspace?.items.find(
      (candidate) => sidebarWorkspaceItemKeys(candidate).includes(ref.itemKey),
    );
    if (!item) {
      continue;
    }
    pinnedKeys.add(key);
    const itemIdentity = `${ref.workspaceDir}\u0000${item.kind}\u0000${item.id}`;
    if (!pinnedItemIdentities.has(itemIdentity)) {
      pinnedItemIdentities.add(itemIdentity);
      pinnedItems.push({ workspaceDir: ref.workspaceDir, item });
    }
  }

  const unpinnedWorkspaces = workspaces.map((workspace) => {
    const isPinned = (item: SidebarSessionViewModel) =>
      sidebarWorkspaceItemKeys(item).some((itemKey) =>
        pinnedKeys.has(`${workspace.directory}\u0000${itemKey}`)
      );
    const sessions = workspace.sessions.filter((item) => !isPinned(item));
    return {
      ...workspace,
      sessions,
      items: sessions,
    };
  });

  return {
    pinnedItems,
    workspaces: unpinnedWorkspaces,
  };
}

import type { CouncilSnapshot, SessionSummary } from "@rah/runtime-protocol";
import { findOwningWorkspace, formatCompactRelativeTime, type WorkspaceSection } from "./session-browser";
import { providerLabel } from "./types";
import { councilActivityAt } from "./council/council-activity";

export type SidebarSessionStatus = "ready" | "working" | "waiting_permission" | "unread";
export type SidebarCouncilStatus = "starting" | "ready" | "working" | "waiting_permission";

export interface SidebarSessionViewModel {
  kind: "session";
  id: string;
  provider: SessionSummary["session"]["provider"];
  originKind?: "council";
  title: string;
  status: SidebarSessionStatus;
  statusLabel: string;
  updatedAtLabel: string;
  selected: boolean;
  pinned: boolean;
}

export interface SidebarCouncilViewModel {
  kind: "council";
  id: string;
  title: string;
  status: SidebarCouncilStatus;
  statusLabel: string;
  updatedAtLabel: string;
  selected: boolean;
  pinned: boolean;
  messageCount: number;
}

export type SidebarWorkspaceItemViewModel =
  | SidebarSessionViewModel
  | SidebarCouncilViewModel;

export interface SidebarWorkspaceViewModel {
  directory: string;
  displayName: string;
  hasBlockingRunningSessions: boolean;
  selected: boolean;
  sessions: SidebarSessionViewModel[];
  councils: SidebarCouncilViewModel[];
  items: SidebarWorkspaceItemViewModel[];
}

function deriveSidebarSessionStatus(args: {
  summary: SessionSummary;
  runtimeStatus: "thinking" | "streaming" | "stopping" | "retrying" | undefined;
  unread: boolean;
}): SidebarSessionStatus {
  if (args.summary.session.phase === "waiting_permission") {
    return "waiting_permission";
  }
  if (args.summary.session.origin?.kind !== "council" && (
    args.runtimeStatus !== undefined ||
    args.summary.session.phase === "working"
  )) {
    return "working";
  }
  if (args.unread) {
    return "unread";
  }
  return "ready";
}

function sidebarStatusLabel(status: SidebarSessionStatus): string {
  switch (status) {
    case "waiting_permission":
      return "approval";
    case "working":
      return "working";
    case "unread":
      return "unread";
    case "ready":
      return "ready";
  }
}

function isRunningCouncil(council: CouncilSnapshot): boolean {
  return council.status === "running";
}

function deriveCouncilStatus(council: CouncilSnapshot): SidebarCouncilStatus {
  if (
    council.phase === "starting" ||
    council.phase === "working" ||
    council.phase === "waiting_permission"
  ) {
    return council.phase;
  }
  return "ready";
}

function councilStatusLabel(status: SidebarCouncilStatus): string {
  switch (status) {
    case "waiting_permission":
      return "approval";
    case "starting":
      return "starting";
    case "working":
      return "working";
    case "ready":
      return "ready";
  }
}

function sessionSidebarActivityAt(
  session: SessionSummary,
  activityAtById: ReadonlyMap<string, string> | undefined,
): string {
  return activityAtById?.get(session.session.id) ?? session.session.updatedAt;
}

function sessionItemKey(sessionId: string): string {
  return `session:${sessionId}`;
}

function councilItemKey(councilId: string): string {
  return `council:${councilId}`;
}

function isPinnedSession(pinnedItemKey: string, sessionId: string): boolean {
  return pinnedItemKey === sessionId || pinnedItemKey === sessionItemKey(sessionId);
}

export function deriveSidebarWorkspaceViewModels(args: {
  workspaceSections: WorkspaceSection[];
  selectedWorkspaceDir: string;
  selectedSessionId: string | null;
  unreadSessionIds: ReadonlySet<string>;
  runtimeStatusBySessionId: ReadonlyMap<
    string,
    "thinking" | "streaming" | "stopping" | "retrying" | undefined
  >;
  pinnedSessionIdByWorkspace: Readonly<Record<string, string>>;
  runningSessionActivityAtById?: ReadonlyMap<string, string> | undefined;
  councils?: readonly CouncilSnapshot[];
  selectedCouncilId?: string | null;
}): SidebarWorkspaceViewModel[] {
  const workspaceDirs = args.workspaceSections.map((section) => section.workspace.directory);
  const councilOwnerById = new Map<string, string | null>();
  for (const council of args.councils ?? []) {
    councilOwnerById.set(council.id, findOwningWorkspace(workspaceDirs, council.workspace));
  }

  return args.workspaceSections.map((section) => {
    const pinnedItemKey = args.pinnedSessionIdByWorkspace[section.workspace.directory];
    const sortedSessions = [...section.sessions].sort((left, right) =>
      sessionSidebarActivityAt(right, args.runningSessionActivityAtById).localeCompare(
        sessionSidebarActivityAt(left, args.runningSessionActivityAtById),
      ),
    );
    const orderedSessions =
      pinnedItemKey && sortedSessions.some((session) => isPinnedSession(pinnedItemKey, session.session.id))
        ? [
            ...sortedSessions.filter((session) => isPinnedSession(pinnedItemKey, session.session.id)),
            ...sortedSessions.filter((session) => !isPinnedSession(pinnedItemKey, session.session.id)),
          ]
        : sortedSessions;

    const sessions = orderedSessions.map((session) => {
      const status = deriveSidebarSessionStatus({
        summary: session,
        runtimeStatus: args.runtimeStatusBySessionId.get(session.session.id),
        unread: args.unreadSessionIds.has(session.session.id),
      });

      return {
        kind: "session" as const,
        id: session.session.id,
        provider: session.session.provider,
        ...(session.session.origin ? { originKind: session.session.origin.kind } : {}),
        title: session.session.title ?? providerLabel(session.session.provider),
        status,
        statusLabel: sidebarStatusLabel(status),
        updatedAtLabel:
          formatCompactRelativeTime(
            sessionSidebarActivityAt(session, args.runningSessionActivityAtById),
          ) ?? "",
        selected: session.session.id === args.selectedSessionId,
        pinned: pinnedItemKey !== undefined && isPinnedSession(pinnedItemKey, session.session.id),
      };
    });
    const councils = (args.councils ?? [])
      .filter(
        (council) =>
          isRunningCouncil(council) &&
          councilOwnerById.get(council.id) === section.workspace.directory,
      )
      .sort((left, right) => councilActivityAt(right).localeCompare(councilActivityAt(left)))
      .map((council) => {
        const status = deriveCouncilStatus(council);
        const activityAt = councilActivityAt(council);
        return {
          kind: "council" as const,
          id: council.id,
          title: council.title,
          status,
          statusLabel: councilStatusLabel(status),
          updatedAtLabel: formatCompactRelativeTime(activityAt) ?? "",
          selected: council.id === args.selectedCouncilId,
          pinned: pinnedItemKey === councilItemKey(council.id),
          messageCount: council.meta?.messageCount ?? council.messageWindow?.total ?? council.messages.length,
        };
      });
    const items = [...sessions, ...councils].sort((left, right) => {
      if (left.pinned !== right.pinned) {
        return left.pinned ? -1 : 1;
      }
      return 0;
    });

    return {
      directory: section.workspace.directory,
      displayName: section.workspace.displayName,
      hasBlockingRunningSessions: section.workspace.hasBlockingRunningSessions,
      selected: section.workspace.directory === args.selectedWorkspaceDir,
      sessions,
      councils,
      items,
    };
  });
}

import type { CouncilRoomSnapshot, SessionSummary } from "@rah/runtime-protocol";
import { conversationPhaseLabel } from "@rah/runtime-protocol";
import { formatRelativeTime, matchesWorkspace, type WorkspaceSection } from "./session-browser";
import { providerLabel } from "./types";

export type SidebarSessionStatus = "ready" | "working" | "waiting_permission" | "unread";
export type SidebarCouncilRoomStatus = "starting" | "ready" | "working" | "waiting_permission";

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

export interface SidebarCouncilRoomViewModel {
  kind: "council_room";
  id: string;
  title: string;
  status: SidebarCouncilRoomStatus;
  statusLabel: string;
  updatedAtLabel: string;
  selected: boolean;
  agentCount: number;
  messageCount: number;
}

export type SidebarWorkspaceItemViewModel =
  | SidebarSessionViewModel
  | SidebarCouncilRoomViewModel;

export interface SidebarWorkspaceViewModel {
  directory: string;
  displayName: string;
  hasBlockingRunningSessions: boolean;
  selected: boolean;
  sessions: SidebarSessionViewModel[];
  councilRooms: SidebarCouncilRoomViewModel[];
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
  if (args.runtimeStatus !== undefined || args.summary.session.phase === "working") {
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
      return "waiting permission";
    case "working":
      return "working";
    case "unread":
      return "unread";
    case "ready":
      return "ready";
  }
}

function isRunningCouncilRoom(room: CouncilRoomSnapshot): boolean {
  return room.room.status === "running";
}

function deriveCouncilRoomStatus(room: CouncilRoomSnapshot): SidebarCouncilRoomStatus {
  if (
    room.room.phase === "starting" ||
    room.room.phase === "working" ||
    room.room.phase === "waiting_permission"
  ) {
    return room.room.phase;
  }
  return "ready";
}

function councilRoomStatusLabel(status: SidebarCouncilRoomStatus): string {
  return conversationPhaseLabel(status);
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
  councilRooms?: readonly CouncilRoomSnapshot[];
  selectedCouncilRoomId?: string | null;
}): SidebarWorkspaceViewModel[] {
  return args.workspaceSections.map((section) => {
    const pinnedSessionId = args.pinnedSessionIdByWorkspace[section.workspace.directory];
    const orderedSessions =
      pinnedSessionId && section.sessions.some((session) => session.session.id === pinnedSessionId)
        ? [
            ...section.sessions.filter((session) => session.session.id === pinnedSessionId),
            ...section.sessions.filter((session) => session.session.id !== pinnedSessionId),
          ]
        : section.sessions;

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
        updatedAtLabel: formatRelativeTime(session.session.updatedAt) ?? "",
        selected: session.session.id === args.selectedSessionId,
        pinned: pinnedSessionId === session.session.id,
      };
    });
    const councilRooms = (args.councilRooms ?? [])
      .filter((room) => isRunningCouncilRoom(room) && matchesWorkspace(room.room.workspace, section.workspace.directory))
      .sort((left, right) => right.room.updatedAt.localeCompare(left.room.updatedAt))
      .map((room) => {
        const status = deriveCouncilRoomStatus(room);
        return {
          kind: "council_room" as const,
          id: room.room.id,
          title: room.room.title,
          status,
          statusLabel: councilRoomStatusLabel(status),
          updatedAtLabel: formatRelativeTime(room.room.updatedAt) ?? "",
          selected: room.room.id === args.selectedCouncilRoomId,
          agentCount: room.agents.length,
          messageCount: room.messages.length,
        };
      });
    const items = [...sessions, ...councilRooms].sort((left, right) => {
      if (left.selected !== right.selected) {
        return left.selected ? -1 : 1;
      }
      return 0;
    });

    return {
      directory: section.workspace.directory,
      displayName: section.workspace.displayName,
      hasBlockingRunningSessions: section.workspace.hasBlockingRunningSessions,
      selected: section.workspace.directory === args.selectedWorkspaceDir,
      sessions,
      councilRooms,
      items,
    };
  });
}

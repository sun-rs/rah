import type { SessionSummary } from "@rah/runtime-protocol";
import { formatRelativeTime, type WorkspaceSection } from "./session-browser";
import { providerLabel } from "./types";

export type SidebarSessionStatus = "ready" | "thinking" | "approval" | "unread";

export interface SidebarSessionViewModel {
  id: string;
  provider: SessionSummary["session"]["provider"];
  title: string;
  status: SidebarSessionStatus;
  statusLabel: string;
  updatedAtLabel: string;
  selected: boolean;
  pinned: boolean;
}

export interface SidebarWorkspaceViewModel {
  directory: string;
  displayName: string;
  hasBlockingLiveSessions: boolean;
  selected: boolean;
  sessions: SidebarSessionViewModel[];
}

function deriveSidebarSessionStatus(args: {
  summary: SessionSummary;
  runtimeStatus: "thinking" | "streaming" | "retrying" | undefined;
  unread: boolean;
}): SidebarSessionStatus {
  if (args.summary.session.runtimeState === "waiting_permission") {
    return "approval";
  }
  if (args.runtimeStatus !== undefined || args.summary.session.runtimeState === "running") {
    return "thinking";
  }
  if (args.unread) {
    return "unread";
  }
  return "ready";
}

function sidebarStatusLabel(status: SidebarSessionStatus): string {
  switch (status) {
    case "approval":
      return "approval";
    case "thinking":
      return "thinking";
    case "unread":
      return "unread";
    case "ready":
      return "ready";
  }
}

export function deriveSidebarWorkspaceViewModels(args: {
  workspaceSections: WorkspaceSection[];
  selectedWorkspaceDir: string;
  selectedSessionId: string | null;
  unreadSessionIds: ReadonlySet<string>;
  runtimeStatusBySessionId: ReadonlyMap<string, "thinking" | "streaming" | "retrying" | undefined>;
  pinnedSessionIdByWorkspace: Readonly<Record<string, string>>;
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

    return {
      directory: section.workspace.directory,
      displayName: section.workspace.displayName,
      hasBlockingLiveSessions: section.workspace.hasBlockingLiveSessions,
      selected: section.workspace.directory === args.selectedWorkspaceDir,
      sessions: orderedSessions.map((session) => {
        const status = deriveSidebarSessionStatus({
          summary: session,
          runtimeStatus: args.runtimeStatusBySessionId.get(session.session.id),
          unread: args.unreadSessionIds.has(session.session.id),
        });

        return {
          id: session.session.id,
          provider: session.session.provider,
          title: session.session.title ?? providerLabel(session.session.provider),
          status,
          statusLabel: sidebarStatusLabel(status),
          updatedAtLabel: formatRelativeTime(session.session.updatedAt) ?? "",
          selected: session.session.id === args.selectedSessionId,
          pinned: pinnedSessionId === session.session.id,
        };
      }),
    };
  });
}

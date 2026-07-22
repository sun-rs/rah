import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";

import type { MuxSessionState } from "./mux-runtime";

export const RAH_TMUX_OWNER_SCOPE_OPTION = "@rah_owner_scope";
export const RAH_TMUX_OWNER_PID_OPTION = "@rah_owner_pid";

export function resolveRahTmuxOwnerScope(rahHome?: string): string {
  const root = path.resolve(rahHome ?? path.join(os.homedir(), ".rah"));
  return createHash("sha256").update(root).digest("hex").slice(0, 20);
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function selectRahTmuxCleanupTargets(
  sessions: readonly MuxSessionState[],
  options: {
    ownerScope: string;
    managedSessionNames?: ReadonlySet<string>;
    currentPid?: number;
    includeCurrentDaemon?: boolean;
    isOwnerAlive?: (pid: number) => boolean;
  },
): MuxSessionState[] {
  const currentPid = options.currentPid ?? process.pid;
  const managedSessionNames = options.managedSessionNames ?? new Set<string>();
  const ownerAlive = options.isOwnerAlive ?? isProcessAlive;
  return sessions.filter((session) => {
    if (
      !session.sessionName.startsWith("rah-") ||
      session.ownerScope !== options.ownerScope ||
      managedSessionNames.has(session.sessionName)
    ) {
      return false;
    }
    if (session.ownerPid === currentPid) {
      return options.includeCurrentDaemon === true;
    }
    if (session.ownerPid && ownerAlive(session.ownerPid)) {
      return false;
    }
    return true;
  });
}

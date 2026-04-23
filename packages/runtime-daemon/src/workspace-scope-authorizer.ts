import type { SessionStore } from "./session-store";
import type { WorkbenchStateStore } from "./workbench-state";
import {
  normalizeDirectory,
  sessionBelongsToWorkspace,
} from "./workbench-directory-utils";

export class WorkspaceScopeAuthorizer {
  constructor(
    private readonly workbenchState: WorkbenchStateStore,
    private readonly sessionStore: SessionStore,
  ) {}

  resolveAuthorizedWorkspaceDirectory(rawDir: string): string {
    const directory = normalizeDirectory(rawDir);
    if (!directory) {
      throw new Error("Workspace directory is required.");
    }
    const snapshot = this.workbenchState.snapshot();
    const knownWorkspaces = new Set(
      [
        ...snapshot.workspaces,
        ...snapshot.hiddenWorkspaces,
        ...(snapshot.activeWorkspaceDir ? [snapshot.activeWorkspaceDir] : []),
      ]
        .map((value) => normalizeDirectory(value))
        .filter((value): value is string => Boolean(value)),
    );
    if (!knownWorkspaces.has(directory)) {
      throw new Error("Workspace directory is not registered.");
    }
    return directory;
  }

  resolveAuthorizedSessionScopeRoot(
    sessionId: string,
    rawScopeRoot?: string,
  ): string | undefined {
    if (!rawScopeRoot) {
      return undefined;
    }
    const scopeRoot = this.resolveAuthorizedWorkspaceDirectory(rawScopeRoot);
    const session = this.sessionStore.getSession(sessionId)?.session;
    if (!session) {
      throw new Error(`Unknown session ${sessionId}`);
    }
    const sessionRoot = session.rootDir || session.cwd;
    if (!sessionBelongsToWorkspace(sessionRoot, scopeRoot)) {
      throw new Error("Requested workspace scope is outside the session workspace boundary.");
    }
    return scopeRoot;
  }
}

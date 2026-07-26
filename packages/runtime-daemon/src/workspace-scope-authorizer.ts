import type { SessionStore } from "./session-store";
import type { WorkbenchStateStore } from "./workbench-state";
import {
  canonicalDirectoryKey,
  canonicalDirectoryKeyAsync,
  normalizeDirectory,
  primeCanonicalDirectoryKeys,
  sessionBelongsToWorkspace,
} from "./workbench-directory-utils";

export class WorkspaceScopeAuthorizer {
  constructor(
    private readonly workbenchState: WorkbenchStateStore,
    private readonly sessionStore: SessionStore,
  ) {}

  async resolveAuthorizedWorkspaceDirectory(rawDir: string): Promise<string> {
    const directory = normalizeDirectory(rawDir);
    if (!directory) {
      throw new Error("Workspace directory is required.");
    }
    const snapshot = this.workbenchState.snapshot();
    const knownWorkspaces = [
      ...snapshot.workspaces,
      ...snapshot.hiddenWorkspaces,
      ...(snapshot.activeWorkspaceDir ? [snapshot.activeWorkspaceDir] : []),
    ]
      .map((value) => normalizeDirectory(value))
      .filter((value): value is string => Boolean(value));
    await primeCanonicalDirectoryKeys([...knownWorkspaces, directory]);
    const requestedKey = await canonicalDirectoryKeyAsync(directory);
    const registeredDirectory = knownWorkspaces.find(
      (workspace) => canonicalDirectoryKey(workspace) === requestedKey,
    );
    if (!registeredDirectory) {
      throw new Error("Workspace directory is not registered.");
    }
    return registeredDirectory;
  }

  async resolveAuthorizedSessionScopeRoot(
    sessionId: string,
    rawScopeRoot?: string,
  ): Promise<string | undefined> {
    if (!rawScopeRoot) {
      return undefined;
    }
    const scopeRoot = await this.resolveAuthorizedWorkspaceDirectory(rawScopeRoot);
    const session = this.sessionStore.getSession(sessionId)?.session;
    if (!session) {
      throw new Error(`Unknown session ${sessionId}`);
    }
    const sessionRoot = session.rootDir || session.cwd;
    await primeCanonicalDirectoryKeys([sessionRoot, scopeRoot]);
    if (!sessionBelongsToWorkspace(sessionRoot, scopeRoot)) {
      throw new Error("Requested workspace scope is outside the session workspace boundary.");
    }
    return scopeRoot;
  }
}

import type {
  GitFileActionRequest,
  GitHunkActionRequest,
  SessionFileSearchResponse,
} from "@rah/runtime-protocol";
import type {
  ProviderCapabilityView,
  ProviderWorkspaceInspectionAdapter,
} from "./provider-adapter";
import type { StoredSessionState } from "./session-store";
import type { WorkspaceScopeAuthorizer } from "./workspace-scope-authorizer";
import {
  applyWorkspaceGitFileActionAsync,
  applyWorkspaceGitHunkActionAsync,
  getWorkspaceGitDiffAsync,
  getWorkspaceGitStatusAsync,
  getWorkspaceSnapshot,
  readHostFileDataAsync,
  readWorkspaceFileFromDirectoryAsync,
  searchWorkspaceFilesInDirectoryAsync,
} from "./workspace-utils";

type RuntimeWorkspaceOperationsOptions = {
  scopeAuthorizer: WorkspaceScopeAuthorizer;
  requireManagedSession: (sessionId: string) => StoredSessionState;
  shouldUseStructuredInspection: (sessionId: string) => boolean;
  requireStructuredInspectionAdapter: (
    sessionId: string,
  ) => ProviderCapabilityView<ProviderWorkspaceInspectionAdapter>;
};

export class RuntimeWorkspaceOperations {
  constructor(private readonly options: RuntimeWorkspaceOperationsOptions) {}

  async getWorkspaceSnapshot(sessionId: string, options?: { scopeRoot?: string }) {
    if (this.options.shouldUseStructuredInspection(sessionId)) {
      const scopeRoot = await this.options.scopeAuthorizer.resolveAuthorizedSessionScopeRoot(
        sessionId,
        options?.scopeRoot,
      );
      return await this.options.requireStructuredInspectionAdapter(sessionId).getWorkspaceSnapshot(
        sessionId,
        {
          ...(scopeRoot ? { scopeRoot } : {}),
        },
      );
    }
    const session = this.options.requireManagedSession(sessionId).session;
    const scopeRoot = await this.options.scopeAuthorizer.resolveAuthorizedSessionScopeRoot(
      sessionId,
      options?.scopeRoot,
    );
    const snapshot = await getWorkspaceSnapshot(scopeRoot ?? session.cwd);
    return {
      sessionId,
      cwd: snapshot.cwd,
      nodes: snapshot.nodes,
    };
  }

  async getGitStatus(
    sessionId: string,
    options?: { scopeRoot?: string; baseBranch?: string },
  ) {
    if (this.options.shouldUseStructuredInspection(sessionId)) {
      const scopeRoot = await this.options.scopeAuthorizer.resolveAuthorizedSessionScopeRoot(
        sessionId,
        options?.scopeRoot,
      );
      return await this.options.requireStructuredInspectionAdapter(sessionId).getGitStatus(
        sessionId,
        {
          ...(scopeRoot ? { scopeRoot } : {}),
          ...(options?.baseBranch ? { baseBranch: options.baseBranch } : {}),
        },
      );
    }
    const session = this.options.requireManagedSession(sessionId).session;
    const scopeRoot = await this.options.scopeAuthorizer.resolveAuthorizedSessionScopeRoot(
      sessionId,
      options?.scopeRoot,
    );
    const status = await getWorkspaceGitStatusAsync(session.cwd, {
      ...(scopeRoot ? { scopeRoot } : {}),
      ...(options?.baseBranch ? { baseBranch: options.baseBranch } : {}),
    });
    return {
      sessionId,
      ...(status.branch !== undefined ? { branch: status.branch } : {}),
      ...(status.baseBranch !== undefined ? { baseBranch: status.baseBranch } : {}),
      ...(status.comparisonMode !== undefined
        ? { comparisonMode: status.comparisonMode }
        : {}),
      ...(status.comparisonBase !== undefined
        ? { comparisonBase: status.comparisonBase }
        : {}),
      branchOptions: status.branchOptions ?? [],
      branchFiles: status.branchFiles ?? [],
      changedFiles: status.changedFiles,
      ...(status.stagedFiles ? { stagedFiles: status.stagedFiles } : {}),
      ...(status.unstagedFiles ? { unstagedFiles: status.unstagedFiles } : {}),
      ...(status.totalBranch !== undefined ? { totalBranch: status.totalBranch } : {}),
      ...(status.totalStaged !== undefined ? { totalStaged: status.totalStaged } : {}),
      ...(status.totalUnstaged !== undefined ? { totalUnstaged: status.totalUnstaged } : {}),
    };
  }

  async getGitDiff(
    sessionId: string,
    path: string,
    options?: {
      staged?: boolean;
      ignoreWhitespace?: boolean;
      scopeRoot?: string;
      baseBranch?: string;
    },
  ) {
    if (this.options.shouldUseStructuredInspection(sessionId)) {
      const scopeRoot = await this.options.scopeAuthorizer.resolveAuthorizedSessionScopeRoot(
        sessionId,
        options?.scopeRoot,
      );
      return await this.options.requireStructuredInspectionAdapter(sessionId).getGitDiff(
        sessionId,
        path,
        {
          ...(options?.staged !== undefined ? { staged: options.staged } : {}),
          ...(options?.ignoreWhitespace !== undefined
            ? { ignoreWhitespace: options.ignoreWhitespace }
            : {}),
          ...(scopeRoot ? { scopeRoot } : {}),
          ...(options?.baseBranch ? { baseBranch: options.baseBranch } : {}),
        },
      );
    }
    const session = this.options.requireManagedSession(sessionId).session;
    const scopeRoot = await this.options.scopeAuthorizer.resolveAuthorizedSessionScopeRoot(
      sessionId,
      options?.scopeRoot,
    );
    return {
      sessionId,
      path,
      diff: await getWorkspaceGitDiffAsync(session.cwd, path, {
        ...(options?.staged !== undefined ? { staged: options.staged } : {}),
        ...(options?.ignoreWhitespace !== undefined
          ? { ignoreWhitespace: options.ignoreWhitespace }
          : {}),
        ...(scopeRoot ? { scopeRoot } : {}),
        ...(options?.baseBranch ? { baseBranch: options.baseBranch } : {}),
      }),
    };
  }

  async getWorkspaceGitStatus(dir: string, options?: { baseBranch?: string }) {
    const workspaceDir = await this.options.scopeAuthorizer.resolveAuthorizedWorkspaceDirectory(dir);
    return await getWorkspaceGitStatusAsync(workspaceDir, {
      scopeRoot: workspaceDir,
      ...(options?.baseBranch ? { baseBranch: options.baseBranch } : {}),
    });
  }

  async getWorkspaceGitDiff(
    dir: string,
    path: string,
    options?: { staged?: boolean; ignoreWhitespace?: boolean; baseBranch?: string },
  ) {
    const workspaceDir = await this.options.scopeAuthorizer.resolveAuthorizedWorkspaceDirectory(dir);
    return {
      sessionId: "",
      path,
      diff: await getWorkspaceGitDiffAsync(workspaceDir, path, {
        ...options,
        scopeRoot: workspaceDir,
      }),
    };
  }

  async applyGitFileAction(sessionId: string, request: GitFileActionRequest) {
    if (!this.options.shouldUseStructuredInspection(sessionId)) {
      const session = this.options.requireManagedSession(sessionId).session;
      return {
        ...(await applyWorkspaceGitFileActionAsync(session.cwd, request, {
          scopeRoot: session.rootDir ?? session.cwd,
        })),
        sessionId,
      };
    }
    const adapter = this.options.requireStructuredInspectionAdapter(sessionId);
    if (!adapter.applyGitFileAction) {
      throw new Error(`Provider ${adapter.id} does not support git file actions.`);
    }
    return await adapter.applyGitFileAction(sessionId, request);
  }

  async applyGitHunkAction(sessionId: string, request: GitHunkActionRequest) {
    if (!this.options.shouldUseStructuredInspection(sessionId)) {
      const session = this.options.requireManagedSession(sessionId).session;
      return {
        ...(await applyWorkspaceGitHunkActionAsync(session.cwd, request, {
          scopeRoot: session.rootDir ?? session.cwd,
        })),
        sessionId,
      };
    }
    const adapter = this.options.requireStructuredInspectionAdapter(sessionId);
    if (!adapter.applyGitHunkAction) {
      throw new Error(`Provider ${adapter.id} does not support git hunk actions.`);
    }
    return await adapter.applyGitHunkAction(sessionId, request);
  }

  async readSessionFile(
    sessionId: string,
    path: string,
    options?: { scopeRoot?: string; imagePreviewMode?: "bounded" | "full" },
  ) {
    if (this.options.shouldUseStructuredInspection(sessionId)) {
      const scopeRoot = await this.options.scopeAuthorizer.resolveAuthorizedSessionScopeRoot(
        sessionId,
        options?.scopeRoot,
      );
      return await this.options.requireStructuredInspectionAdapter(sessionId).readSessionFile(
        sessionId,
        path,
        {
          ...(scopeRoot ? { scopeRoot } : {}),
          ...(options?.imagePreviewMode
            ? { imagePreviewMode: options.imagePreviewMode }
            : {}),
        },
      );
    }
    const session = this.options.requireManagedSession(sessionId).session;
    const scopeRoot = await this.options.scopeAuthorizer.resolveAuthorizedSessionScopeRoot(
      sessionId,
      options?.scopeRoot,
    );
    return {
      ...(await readWorkspaceFileFromDirectoryAsync(session.cwd, path, {
        ...(scopeRoot ? { scopeRoot } : {}),
        ...(options?.imagePreviewMode
          ? { imagePreviewMode: options.imagePreviewMode }
          : {}),
      })),
      sessionId,
    };
  }

  async readWorkspaceFile(
    dir: string,
    path: string,
    options?: { imagePreviewMode?: "bounded" | "full" },
  ) {
    const workspaceDir = await this.options.scopeAuthorizer.resolveAuthorizedWorkspaceDirectory(dir);
    return await readWorkspaceFileFromDirectoryAsync(workspaceDir, path, {
      scopeRoot: workspaceDir,
      ...(options?.imagePreviewMode ? { imagePreviewMode: options.imagePreviewMode } : {}),
    });
  }

  async readHostFile(path: string, options?: { imagePreviewMode?: "bounded" | "full" }) {
    return {
      sessionId: "",
      ...(await readHostFileDataAsync(path, options)),
    };
  }

  async searchSessionFiles(
    sessionId: string,
    query: string,
    limit = 100,
    options?: { scopeRoot?: string },
  ): Promise<SessionFileSearchResponse> {
    const session = this.options.requireManagedSession(sessionId).session;
    const scopeRoot = await this.options.scopeAuthorizer.resolveAuthorizedSessionScopeRoot(
      sessionId,
      options?.scopeRoot,
    );
    return {
      sessionId,
      query,
      files: await searchWorkspaceFilesInDirectoryAsync(scopeRoot ?? session.cwd, query, limit),
    };
  }

  async searchWorkspaceFiles(
    dir: string,
    query: string,
    limit = 100,
  ): Promise<SessionFileSearchResponse> {
    const workspaceDir = await this.options.scopeAuthorizer.resolveAuthorizedWorkspaceDirectory(dir);
    return {
      sessionId: "",
      query,
      files: await searchWorkspaceFilesInDirectoryAsync(workspaceDir, query, limit),
    };
  }
}

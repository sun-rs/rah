import type {
  ConversationFileChangeProjection,
  GitChangedFile,
} from "@rah/runtime-protocol";

export type ReviewScope =
  | {
      kind: "turn";
      sessionId: string;
      turnId: string;
      workspaceRoot: string;
      files: readonly ConversationFileChangeProjection[];
      totalAdditions: number;
      totalDeletions: number;
      truncated: boolean;
    }
  | {
      kind: "workspace";
      sessionId: string | null;
      workspaceRoot: string;
      files: readonly GitChangedFile[];
    };

export type ReviewFile = {
  key: string;
  path: string;
  additions: number;
  deletions: number;
  staged: boolean | null;
  binary: boolean;
};

export type ReviewDiffRequest =
  | {
      kind: "turn";
      sessionId: string;
      turnId: string;
      path: string;
    }
  | {
      kind: "session-workspace";
      sessionId: string;
      path: string;
      staged: boolean;
      ignoreWhitespace: boolean;
      scopeRoot?: string;
    }
  | {
      kind: "workspace";
      workspaceRoot: string;
      path: string;
      staged: boolean;
      ignoreWhitespace: boolean;
    };

export function normalizeReviewFiles(scope: ReviewScope): ReviewFile[] {
  if (scope.kind === "turn") {
    return scope.files.map((file) => ({
      key: `turn:${file.path}`,
      path: file.path,
      additions: file.additions,
      deletions: file.deletions,
      staged: null,
      binary: false,
    }));
  }
  return scope.files.map((file) => ({
    key: `workspace:${file.staged ? "staged" : "unstaged"}:${file.path}`,
    path: file.path,
    additions: file.added,
    deletions: file.removed,
    staged: file.staged,
    binary: file.binary === true,
  }));
}

export function buildReviewDiffRequest(
  scope: ReviewScope,
  file: ReviewFile,
  hideWhitespace: boolean,
): ReviewDiffRequest {
  if (scope.kind === "turn") {
    return {
      kind: "turn",
      sessionId: scope.sessionId,
      turnId: scope.turnId,
      path: file.path,
    };
  }
  if (scope.sessionId) {
    return {
      kind: "session-workspace",
      sessionId: scope.sessionId,
      path: file.path,
      staged: file.staged === true,
      ignoreWhitespace: hideWhitespace,
      ...(scope.workspaceRoot ? { scopeRoot: scope.workspaceRoot } : {}),
    };
  }
  return {
    kind: "workspace",
    workspaceRoot: scope.workspaceRoot,
    path: file.path,
    staged: file.staged === true,
    ignoreWhitespace: hideWhitespace,
  };
}

export function reviewScopeIdentity(scope: ReviewScope): string {
  return scope.kind === "turn"
    ? `turn:${scope.sessionId}:${scope.turnId}`
    : `workspace:${scope.sessionId ?? ""}:${scope.workspaceRoot}`;
}

export function reviewScopeContentIdentity(scope: ReviewScope): string {
  if (scope.kind === "turn") {
    return JSON.stringify({
      kind: scope.kind,
      sessionId: scope.sessionId,
      turnId: scope.turnId,
      workspaceRoot: scope.workspaceRoot,
      totalAdditions: scope.totalAdditions,
      totalDeletions: scope.totalDeletions,
      truncated: scope.truncated,
      files: scope.files.map((file) => [
        file.path,
        file.additions,
        file.deletions,
      ]),
    });
  }
  return JSON.stringify({
    kind: scope.kind,
    sessionId: scope.sessionId,
    workspaceRoot: scope.workspaceRoot,
    files: scope.files.map((file) => [
      file.path,
      file.status,
      file.staged,
      file.added,
      file.removed,
      file.binary === true,
    ]),
  });
}

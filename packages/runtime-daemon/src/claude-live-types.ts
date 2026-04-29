import {
  query as claudeQuery,
  type Options as ClaudeOptions,
  type PermissionMode,
  type PermissionResult,
  type Query as ClaudeQuery,
} from "@anthropic-ai/claude-agent-sdk";
import type { ModelContextWindowResolution } from "./model-context-window";

export type PendingClaudePermission = {
  sessionId: string;
  requestId: string;
  allowResult: PermissionResult;
  allowForSessionResult?: PermissionResult;
  resolve: (value: PermissionResult) => void;
  reject: (error: Error) => void;
};

export type LiveClaudeTurn = {
  query: ClaudeQuery;
  turnId: string;
  completed: boolean;
};

export type LiveClaudeSession = {
  sessionId: string;
  cwd: string;
  model?: string;
  contextWindow?: ModelContextWindowResolution;
  effort?: ClaudeOptions["effort"];
  permissionMode: PermissionMode;
  providerSessionId?: string;
  activeTurn: LiveClaudeTurn | null;
  pendingPermissions: Map<string, PendingClaudePermission>;
  queryFactory: typeof claudeQuery;
};

export type ClaudeQueryFactory = typeof claudeQuery;

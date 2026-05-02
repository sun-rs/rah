import {
  query as claudeQuery,
  type Options as ClaudeOptions,
  type PermissionMode,
  type PermissionResult,
  type Query as ClaudeQuery,
} from "@anthropic-ai/claude-agent-sdk";
import type { SessionInputRequest } from "@rah/runtime-protocol";
import type { ModelContextWindowResolution } from "./model-context-window";

export type PendingClaudeQuestion = {
  kind: "question";
  sessionId: string;
  requestId: string;
  toolUseId: string;
  query: ClaudeQuery;
  questions: Array<{ id: string; question: string }>;
};

export type PendingClaudeToolPermission = {
  kind: "tool";
  sessionId: string;
  requestId: string;
  allowResult: PermissionResult;
  allowForSessionResult?: PermissionResult;
  resolve: (value: PermissionResult) => void;
  reject: (error: Error) => void;
};

export type PendingClaudePermission = PendingClaudeToolPermission | PendingClaudeQuestion;

export type LiveClaudeTurn = {
  query: ClaudeQuery;
  turnId: string;
  completed: boolean;
  aborted: boolean;
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
  turnStartPending: boolean;
  pendingInterrupt: boolean;
  queuedInputs: SessionInputRequest[];
  pendingPermissions: Map<string, PendingClaudePermission>;
  queryFactory: typeof claudeQuery;
};

export type ClaudeQueryFactory = typeof claudeQuery;

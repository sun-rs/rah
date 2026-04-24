import type { CodexAppServerTranslationState } from "./codex-app-server-activity";
import type { CodexJsonRpcClient } from "./codex-live-rpc";

export type JsonRpcRequest = {
  id: number | string;
  method: string;
  params?: unknown;
};

export type JsonRpcNotification = {
  method: string;
  params?: unknown;
};

export type LiveQuestionRequest = {
  permissionRequestId: string;
};

export type PendingApproval = {
  kind: "command" | "file" | "question" | "permissions" | "mcp_elicitation";
  resolve: (value: unknown) => void;
  requestId: string;
  itemId: string;
  approvalProtocol?: "v2" | "legacy";
  questions?: unknown;
  requestedPermissions?: unknown;
};

export type LiveCodexSession = {
  sessionId: string;
  threadId: string;
  cwd: string;
  client: CodexJsonRpcClient;
  translationState: CodexAppServerTranslationState;
  currentTurnId: string | null;
  pendingQuestions: Map<string, LiveQuestionRequest>;
  pendingApprovals: Map<string, PendingApproval>;
};

export const JSON_RPC_TIMEOUT_MS = 30_000;
export const TURN_START_TIMEOUT_MS = 90_000;
export const SESSION_SOURCE = {
  provider: "system" as const,
  channel: "system" as const,
  authority: "authoritative" as const,
};

import type { KimiJsonRpcClient } from "./kimi-live-rpc";

export type JsonRpcEvent = {
  jsonrpc: "2.0";
  method: "event";
  params: {
    type: string;
    payload: Record<string, unknown>;
  };
};

export type JsonRpcRequest = {
  jsonrpc: "2.0";
  method: "request";
  id: string;
  params: {
    type: string;
    payload: Record<string, unknown>;
  };
};

export type PendingInteractiveRequest =
  | {
      kind: "approval";
    }
  | {
      kind: "question";
      questions: Array<{ id: string; question: string }>;
    };

export type KimiToolFamily =
  | "file_read"
  | "file_write"
  | "file_edit"
  | "shell"
  | "search"
  | "web_fetch"
  | "web_search"
  | "todo"
  | "subagent"
  | "mcp"
  | "other";

export type KimiToolCallState = {
  id: string;
  name: string;
  family: KimiToolFamily;
  title: string;
  argsText: string;
};

export type LiveKimiTurn = {
  promptRequestId: string;
  turnId: string;
  aborted: boolean;
  completed: boolean;
  latestToolCallId: string | null;
  toolCalls: Map<string, KimiToolCallState>;
};

export type LiveKimiSession = {
  sessionId: string;
  providerSessionId: string;
  cwd: string;
  model?: string;
  reasoningId?: string | null;
  approvalMode: string;
  planMode: boolean;
  client: KimiJsonRpcClient;
  activeTurn: LiveKimiTurn | null;
  pendingRequests: Map<string, PendingInteractiveRequest>;
};

export const JSON_RPC_TIMEOUT_MS = 30_000;
export const PROMPT_TIMEOUT_MS = 180_000;
export const SESSION_SOURCE = {
  provider: "system" as const,
  channel: "system" as const,
  authority: "authoritative" as const,
};

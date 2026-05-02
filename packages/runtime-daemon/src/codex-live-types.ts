import type { CodexAppServerTranslationState } from "./codex-app-server-activity";
import type { CodexJsonRpcClient } from "./codex-live-rpc";
import type { ProviderModelCatalog, SessionInputRequest } from "@rah/runtime-protocol";

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
  approvalPolicy: string;
  sandboxMode: string;
  modelId: string | null;
  reasoningId: string | null;
  modelCatalog: ProviderModelCatalog | null;
  activeModeId: string;
  lastNonPlanModeId: string;
  planCollaborationMode:
    | {
        mode: "plan";
        settings: {
          model: string | null;
          reasoning_effort: string | null;
          developer_instructions: string | null;
        };
      }
    | null;
  client: CodexJsonRpcClient;
  translationState: CodexAppServerTranslationState;
  currentTurnId: string | null;
  finishedTurnIds: Set<string>;
  turnStartInFlight: boolean;
  interruptWhenTurnStarts: boolean;
  queuedInputs: SessionInputRequest[];
  drainQueuedInput?: () => void;
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

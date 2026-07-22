import type { CodexAppServerTranslationState } from "./codex-app-server-activity";
import type { CodexAppServerRpcClient } from "./codex-live-rpc";
import type { ProviderModelCatalog, SessionInputQueuePolicy } from "@rah/runtime-protocol";
import type { RuntimeQueuedInput } from "./session-input-queue";

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
  approvalResponseShape?: "action" | "approval";
  questions?: unknown;
  requestedPermissions?: unknown;
};

export type LiveCodexSession = {
  sessionId: string;
  threadId: string;
  /** Ephemeral provider thread that must be unsubscribed when its Side task closes. */
  ephemeral?: boolean;
  /** Provider has authoritatively unloaded this ephemeral Side thread. */
  ephemeralExpired?: boolean;
  /** Suppresses provider-close notifications caused by an explicit disposal. */
  disposalInFlight?: boolean;
  cwd: string;
  approvalPolicy: string;
  sandboxMode: string;
  approvalsReviewer: "user" | "auto_review";
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
  client: CodexAppServerRpcClient;
  translationState: CodexAppServerTranslationState;
  currentTurnId: string | null;
  finishedTurnIds: Set<string>;
  interruptingTurnIds: Set<string>;
  interruptFallbackTimer?: ReturnType<typeof setTimeout>;
  interruptFallbackTurnId?: string;
  turnStartInFlight: boolean;
  interruptWhenTurnStarts: boolean;
  queuedInputs: RuntimeQueuedInput[];
  inputQueuePolicy?: SessionInputQueuePolicy;
  /** The single queued input currently crossing the turn/start acceptance boundary. */
  queuedInputSubmission?: {
    clientMessageId: string;
    accepted: boolean;
    rpcUncertain: boolean;
  };
  queuedInputDrainPaused?: boolean;
  uncertainQueuedInputClientMessageId?: string;
  drainQueuedInput?: () => void;
  flushNotifications?: () => Promise<void>;
  externalThreadMirrorSubscribeInFlight: boolean;
  externalThreadMirrorSubscribed: boolean;
  pendingQuestions: Map<string, LiveQuestionRequest>;
  pendingApprovals: Map<string, PendingApproval>;
};

export const JSON_RPC_TIMEOUT_MS = 30_000;
export const TURN_START_TIMEOUT_MS = 90_000;
export const THREAD_FORK_TIMEOUT_MS = 60_000;
export const SESSION_SOURCE = {
  provider: "system" as const,
  channel: "system" as const,
  authority: "authoritative" as const,
};

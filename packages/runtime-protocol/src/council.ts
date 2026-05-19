import type { ConversationPhase, ConversationStatus } from "./conversation-state";
import type {
  ProviderKind,
  SessionConfigValue,
} from "./session";

export type CouncilAgentProvider = Extract<ProviderKind, "codex" | "claude" | "gemini" | "opencode">;

export type CouncilStatus = ConversationStatus;
export type CouncilPhase = ConversationPhase;

export type CouncilAgentStatus =
  | "starting"
  | "waiting"
  | "thinking"
  | "idle"
  | "blocked"
  | "failed"
  | "stopped";

export type CouncilMessageRole = "user" | "agent" | "system";

export type CouncilMessagePart =
  | { kind: "text"; text: string }
  | { kind: "data"; data: unknown };

export interface CouncilAgentConfig {
  id?: string;
  provider: CouncilAgentProvider;
  label: string;
  role?: string;
  modelId?: string;
  reasoningId?: string | null;
  optionValues?: Record<string, SessionConfigValue>;
  modeId?: string;
}

export interface CouncilAgent extends CouncilAgentConfig {
  id: string;
  councilId: string;
  status: CouncilAgentStatus;
  terminalId?: string;
  nativeSessionId?: string;
  lastStatusDetail?: string;
  updatedAt: string;
}

export interface Council {
  id: string;
  title: string;
  workspace: string;
  status: CouncilStatus;
  phase: CouncilPhase;
  muxSessionName?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CouncilMessage {
  id: number;
  councilId: string;
  actorId: string;
  clientId?: string;
  role: CouncilMessageRole;
  parts: CouncilMessagePart[];
  replyTo?: number;
  createdAt: string;
}

export interface CouncilSnapshot extends Council {
  agents: CouncilAgent[];
  messages: CouncilMessage[];
  storage?: {
    storePath: string;
    messageLogPath: string;
  };
}

export interface CreateCouncilRequest {
  title?: string;
  workspace: string;
  agents: CouncilAgentConfig[];
}

export interface CreateCouncilResponse {
  council: CouncilSnapshot;
}

export interface RenameCouncilRequest {
  title: string;
}

export interface RenameCouncilResponse {
  council: CouncilSnapshot;
}

export interface AddCouncilAgentRequest {
  agent: CouncilAgentConfig;
}

export interface AddCouncilAgentResponse {
  council: CouncilSnapshot;
  agent: CouncilAgent;
}

export interface ListCouncilsResponse {
  councils: CouncilSnapshot[];
}

export interface CouncilPostMessageRequest {
  actorId?: string;
  role?: CouncilMessageRole;
  text: string;
  replyTo?: number;
}

export interface CouncilPostMessageResponse {
  message: CouncilMessage;
  council: CouncilSnapshot;
}

export interface CouncilAgentTuiResponse {
  councilId: string;
  agentId: string;
  muxSessionName?: string;
  paneId?: string;
  terminalId?: string;
  screen?: string;
}

export interface CouncilReinjectAgentsResponse {
  council: CouncilSnapshot;
  injectedAgentIds: string[];
  skippedAgentIds: string[];
}

export interface CouncilRemoveAgentResponse {
  council: CouncilSnapshot;
}

export interface CouncilStopAgentResponse {
  council: CouncilSnapshot;
}

export type CouncilMcpToolName =
  | "channel_join"
  | "channel_post"
  | "channel_wait_new"
  | "channel_history"
  | "channel_state"
  | "channel_peek_inbox"
  | "channel_set_status"
  | "channel_claim_file"
  | "channel_release_file"
  | "channel_list_claims"
  | "channel_send_control"
  | "channel_peek_control";

export interface CouncilMcpRequest {
  councilId: string;
  actorId: string;
  clientId?: string;
  tool: CouncilMcpToolName;
  arguments?: Record<string, unknown>;
}

export interface CouncilMcpResponse {
  ok: true;
  result: unknown;
}

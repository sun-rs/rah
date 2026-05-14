import type {
  ProviderKind,
  SessionConfigValue,
} from "./session";

export type CouncilAgentProvider = Extract<ProviderKind, "codex" | "claude" | "opencode">;

export type CouncilRoomStatus =
  | "starting"
  | "running"
  | "idle"
  | "stopped"
  | "failed";

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
  roomId: string;
  status: CouncilAgentStatus;
  zellijPaneId?: string;
  nativeSessionId?: string;
  lastStatusDetail?: string;
  updatedAt: string;
}

export interface CouncilRoom {
  id: string;
  title: string;
  workspace: string;
  status: CouncilRoomStatus;
  zellijSessionName?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CouncilMessage {
  id: number;
  roomId: string;
  actorId: string;
  clientId?: string;
  role: CouncilMessageRole;
  parts: CouncilMessagePart[];
  replyTo?: number;
  createdAt: string;
}

export interface CouncilRoomSnapshot {
  room: CouncilRoom;
  agents: CouncilAgent[];
  messages: CouncilMessage[];
}

export interface CreateCouncilRoomRequest {
  title?: string;
  workspace: string;
  agents: CouncilAgentConfig[];
}

export interface CreateCouncilRoomResponse {
  room: CouncilRoomSnapshot;
}

export interface AddCouncilAgentRequest {
  agent: CouncilAgentConfig;
}

export interface AddCouncilAgentResponse {
  room: CouncilRoomSnapshot;
  agent: CouncilAgent;
}

export interface ListCouncilRoomsResponse {
  rooms: CouncilRoomSnapshot[];
}

export interface CouncilPostMessageRequest {
  actorId?: string;
  role?: CouncilMessageRole;
  text: string;
  replyTo?: number;
}

export interface CouncilPostMessageResponse {
  message: CouncilMessage;
  room: CouncilRoomSnapshot;
}

export interface CouncilAgentTuiResponse {
  roomId: string;
  agentId: string;
  zellijSessionName?: string;
  paneId?: string;
  terminalId?: string;
  screen?: string;
}

export interface CouncilReinjectAgentsResponse {
  room: CouncilRoomSnapshot;
  injectedAgentIds: string[];
  skippedAgentIds: string[];
}

export interface CouncilRemoveAgentResponse {
  room: CouncilRoomSnapshot;
}

export interface CouncilStopAgentResponse {
  room: CouncilRoomSnapshot;
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
  roomId: string;
  actorId: string;
  clientId?: string;
  tool: CouncilMcpToolName;
  arguments?: Record<string, unknown>;
}

export interface CouncilMcpResponse {
  ok: true;
  result: unknown;
}

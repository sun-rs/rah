import type {
  ContextUsage,
  EventAuthority,
  EventChannel,
  JsonObject,
  MessagePartRef,
  PermissionRequest,
  PermissionResolution,
  RuntimeOperation,
  TimelineIdentityConfidence,
  TimelineItem,
  ToolCall,
  WorkbenchObservation,
} from "./events";
import type { ProviderKind } from "./session";

export type ConversationTurnStatus =
  | "in_progress"
  | "completed"
  | "interrupted"
  | "failed";

export type ConversationItemStatus =
  | "pending"
  | "running"
  | "completed"
  | "interrupted"
  | "failed";

export type ConversationItemRole = "user" | "process" | "final" | "system";

export interface ConversationProjectionSource {
  provider: ProviderKind;
  channel: EventChannel;
  authority: EventAuthority;
  identityConfidence?: TimelineIdentityConfidence;
}

export type ConversationItemContent =
  | { kind: "timeline"; item: TimelineItem }
  | { kind: "observation"; observation: WorkbenchObservation; error?: string }
  | { kind: "tool"; toolCall: ToolCall; error?: string }
  | {
      kind: "permission";
      request?: PermissionRequest;
      resolution?: PermissionResolution;
    }
  | { kind: "operation"; operation: RuntimeOperation }
  | { kind: "message_part"; part: MessagePartRef };

export interface ConversationItemProjection {
  id: string;
  turnId: string;
  providerItemId?: string;
  role: ConversationItemRole;
  status: ConversationItemStatus;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  content: ConversationItemContent;
  source: ConversationProjectionSource;
  detailAvailable?: boolean;
  revision: number;
}

export interface ConversationError {
  message: string;
  code?: string;
  detail?: JsonObject;
}

export interface ConversationTurnProjection {
  id: string;
  provider: ProviderKind;
  providerSessionId?: string;
  providerTurnId?: string;
  status: ConversationTurnStatus;
  statusAuthority: "native" | "derived";
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  items: ConversationItemProjection[];
  finalAnswerItemId?: string;
  failedItemCount: number;
  /** Whether this turn contains only a lightweight item summary or hydrated items. */
  itemsView?: "summary" | "full";
  usage?: ContextUsage;
  error?: ConversationError;
  identityConfidence?: TimelineIdentityConfidence;
  revision: number;
}

export interface ConversationProjection {
  sessionId: string;
  turns: ConversationTurnProjection[];
  revision: number;
  generatedAt: string;
  sourceEventCount: number;
  partial?: boolean;
}

export interface ConversationTurnsPageResponse extends ConversationProjection {
  nextCursor?: string;
  approximateBytes?: number;
  /** Monotonic revision for live deltas; history cache expansion does not advance it. */
  liveRevision?: number;
}

export type ConversationTurnStateProjection = Omit<ConversationTurnProjection, "items">;

export interface ConversationTurnDelta {
  turn: ConversationTurnStateProjection;
  upsertItems: ConversationItemProjection[];
  removeItemIds?: string[];
}

export interface ConversationProjectionDelta {
  sessionId: string;
  baseRevision: number;
  revision: number;
  sourceSeq?: number;
  upsertTurns: ConversationTurnDelta[];
  removeTurnIds?: string[];
}

export interface ConversationItemDetailResponse {
  sessionId: string;
  turnId: string;
  itemId: string;
  item: ConversationItemProjection;
  approximateBytes?: number;
}

export interface ConversationTurnDetailResponse {
  sessionId: string;
  turnId: string;
  turn: ConversationTurnProjection;
  approximateBytes?: number;
}

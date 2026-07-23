import type {
  ContextUsage,
  ConversationActivityKind,
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

export interface ConversationActivitySummary {
  kind: ConversationActivityKind;
  totalCount: number;
  runningCount: number;
  interruptedCount: number;
  /** A provider/tool transport failure, not an ordinary non-zero command result. */
  failureCount: number;
  /** A completed operation whose result needs review, such as a failing test command. */
  issueCount: number;
}

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

export type ConversationResourceKind =
  | "file"
  | "image"
  | "url"
  | "commit"
  | "pull_request"
  | "review";

export type ConversationResourceConfidence = "authoritative" | "inferred";

export interface ConversationResourceProjectionBase {
  /** Stable across history hydration and live replacement for the same locator. */
  id: string;
  kind: ConversationResourceKind;
  label: string;
  path?: string;
  url?: string;
  mimeType?: string;
  confidence: ConversationResourceConfidence;
  sourceItemIds: string[];
  firstSeenAt?: string;
  lastSeenAt?: string;
}

export type ConversationOutputActivity = "written" | "updated" | "generated";

export interface ConversationOutputProjection extends ConversationResourceProjectionBase {
  activity: ConversationOutputActivity;
}

export type ConversationSourceActivity = "provided" | "read" | "searched" | "fetched";

export interface ConversationSourceProjection extends ConversationResourceProjectionBase {
  activities: ConversationSourceActivity[];
}

export interface ConversationFileChangeProjection {
  path: string;
  additions: number;
  deletions: number;
}

export interface ConversationTurnFileChangesProjection {
  files: ConversationFileChangeProjection[];
  totalAdditions: number;
  totalDeletions: number;
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
  /** Provider-neutral semantic summary of this turn's process activity. */
  activities: ConversationActivitySummary[];
  /** Provider-neutral resources produced by this turn. */
  outputs?: ConversationOutputProjection[];
  /** Provider-neutral resources consulted or supplied to this turn. */
  sources?: ConversationSourceProjection[];
  /** Authoritative file changes attributed to this completed provider turn. */
  fileChanges?: ConversationTurnFileChangesProjection;
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

/**
 * Provider-neutral, detached resource index for Inspector. The daemon owns
 * history hydration so clients do not need one detail request per turn.
 */
export interface ConversationResourceIndexResponse {
  sessionId: string;
  sourceRevision: string;
  outputs: ConversationOutputProjection[];
  sources: ConversationSourceProjection[];
  complete: boolean;
  generatedAt: string;
  warning?: string;
  approximateBytes?: number;
}

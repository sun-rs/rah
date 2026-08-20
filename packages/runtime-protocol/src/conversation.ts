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
  /** Authoritative file changes attributed to this provider turn so far. */
  fileChanges?: ConversationTurnFileChangesProjection;
  finalAnswerItemId?: string;
  failedItemCount: number;
  /** Whether this turn contains only a lightweight item summary or hydrated items. */
  itemsView?: "summary" | "full";
  /**
   * Whether a lightweight history summary has renderable process detail that
   * can be hydrated on demand. `false` is authoritative: transient reasoning
   * alone must not expose an empty Worked disclosure.
   */
  processDetailsAvailable?: boolean;
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
  /**
   * Exact provider-owned source revision represented by this page.
   * Read-only clients use it as their freshness baseline so the first
   * lightweight revision probe does not cancel and duplicate the initial
   * history request.
   */
  sourceRevision?: string;
  /** Monotonic revision for live deltas; history cache expansion does not advance it. */
  liveRevision?: number;
}

/**
 * Lightweight freshness token for a provider-owned conversation source.
 * Clients use it to follow read-only replays without repeatedly downloading
 * the latest turn page while the underlying history is unchanged.
 */
export interface ConversationSourceRevisionResponse {
  sessionId: string;
  sourceRevision: string | null;
}

/**
 * Safe, daemon-resolved source for a provider-owned conversation visual.
 * Clients never construct this host path from the opaque artifact id.
 */
export interface ConversationVisualArtifactSourceResponse {
  sessionId: string;
  artifactId: string;
  path: string | null;
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

function composeConversationTurnDelta(
  current: ConversationTurnDelta,
  next: ConversationTurnDelta,
): ConversationTurnDelta {
  const upsertItems = new Map(
    current.upsertItems.map((item) => [item.id, item] as const),
  );
  const removeItemIds = new Set(current.removeItemIds ?? []);
  for (const itemId of next.removeItemIds ?? []) {
    upsertItems.delete(itemId);
    removeItemIds.add(itemId);
  }
  for (const item of next.upsertItems) {
    removeItemIds.delete(item.id);
    upsertItems.set(item.id, item);
  }
  return {
    turn: next.turn,
    upsertItems: [...upsertItems.values()],
    ...(removeItemIds.size > 0
      ? { removeItemIds: [...removeItemIds] }
      : {}),
  };
}

function composeContiguousConversationDelta(
  current: ConversationProjectionDelta,
  next: ConversationProjectionDelta,
): ConversationProjectionDelta {
  const upsertTurns = new Map(
    current.upsertTurns.map((turn) => [turn.turn.id, turn] as const),
  );
  const removeTurnIds = new Set(current.removeTurnIds ?? []);
  for (const turnId of next.removeTurnIds ?? []) {
    upsertTurns.delete(turnId);
    removeTurnIds.add(turnId);
  }
  for (const turn of next.upsertTurns) {
    removeTurnIds.delete(turn.turn.id);
    const existing = upsertTurns.get(turn.turn.id);
    upsertTurns.set(
      turn.turn.id,
      existing ? composeConversationTurnDelta(existing, turn) : turn,
    );
  }
  return {
    sessionId: current.sessionId,
    baseRevision: current.baseRevision,
    revision: next.revision,
    ...(next.sourceSeq !== undefined
      ? { sourceSeq: next.sourceSeq }
      : current.sourceSeq !== undefined
        ? { sourceSeq: current.sourceSeq }
        : {}),
    upsertTurns: [...upsertTurns.values()],
    ...(removeTurnIds.size > 0
      ? { removeTurnIds: [...removeTurnIds] }
      : {}),
  };
}

/**
 * Deduplicate and collapse contiguous revisions without losing item/turn
 * removals. This is the transport-level compaction primitive shared by the
 * daemon replay path and the browser's defensive ingress buffer.
 */
export function composeConversationProjectionDeltas(
  deltas: readonly ConversationProjectionDelta[],
): ConversationProjectionDelta[] {
  const bySession = new Map<string, Map<number, ConversationProjectionDelta>>();
  for (const delta of deltas) {
    let revisions = bySession.get(delta.sessionId);
    if (!revisions) {
      revisions = new Map();
      bySession.set(delta.sessionId, revisions);
    }
    revisions.set(delta.revision, delta);
  }

  const result: ConversationProjectionDelta[] = [];
  for (const revisions of bySession.values()) {
    const ordered = [...revisions.values()].sort(
      (left, right) => left.revision - right.revision,
    );
    let composed: ConversationProjectionDelta | undefined;
    for (const delta of ordered) {
      if (!composed) {
        composed = delta;
        continue;
      }
      if (delta.baseRevision === composed.revision) {
        composed = composeContiguousConversationDelta(composed, delta);
        continue;
      }
      result.push(composed);
      composed = delta;
    }
    if (composed) {
      result.push(composed);
    }
  }
  return result.sort((left, right) => {
    const leftSeq = left.sourceSeq ?? Number.MAX_SAFE_INTEGER;
    const rightSeq = right.sourceSeq ?? Number.MAX_SAFE_INTEGER;
    if (leftSeq !== rightSeq) {
      return leftSeq - rightSeq;
    }
    if (left.sessionId !== right.sessionId) {
      return left.sessionId.localeCompare(right.sessionId);
    }
    return left.revision - right.revision;
  });
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
 * Bumped whenever the resource-index wire contract changes in a way that
 * affects snapshot publication semantics. Clients must reject an absent or
 * different version instead of treating a legacy progressive response as a
 * committed snapshot.
 */
export const CONVERSATION_RESOURCE_INDEX_PROTOCOL_VERSION = 1;

/**
 * Provider-neutral, detached resource index for Inspector. The daemon owns
 * history hydration and versioned persistence so clients do not need one
 * detail request per turn. Responses expose only committed snapshots: a
 * replacement revision is built privately and atomically replaces the prior
 * stable snapshot after paging and detail hydration have both settled.
 */
export interface ConversationResourceIndexResponse {
  protocolVersion: typeof CONVERSATION_RESOURCE_INDEX_PROTOCOL_VERSION;
  sessionId: string;
  sourceRevision: string;
  outputs: ConversationOutputProjection[];
  sources: ConversationSourceProjection[];
  /**
   * True when Outputs/Sources are one coherent snapshot for `sourceRevision`.
   * While a newer provider revision is being indexed, the daemon may return
   * the last stable snapshot together with `indexing: true`; clients should
   * keep rendering that snapshot until the replacement is committed.
   */
  stable?: boolean;
  /**
   * True while the daemon is hydrating provider history in the background.
   * Clients should re-read until this becomes false/absent, but must not expose
   * an unstable working index as a progressively changing resource list.
   */
  indexing?: boolean;
  complete: boolean;
  generatedAt: string;
  warning?: string;
  approximateBytes?: number;
}

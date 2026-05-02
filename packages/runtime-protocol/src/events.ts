import type { ClientKind, ManagedSession, ProviderKind } from "./session";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export interface JsonObject {
  [key: string]: JsonValue;
}

export type EventChannel =
  | "structured_live"
  | "structured_persisted"
  | "pty"
  | "system";

export type EventAuthority = "authoritative" | "derived" | "heuristic";

export interface EventSource {
  provider: ProviderKind | "system";
  channel: EventChannel;
  authority: EventAuthority;
}

export interface EventEnvelope<T = unknown> {
  id: string;
  seq: number;
  ts: string;
  sessionId: string;
  turnId?: string;
  type: RahEventType;
  source: EventSource;
  payload: T;
  raw?: unknown;
}

export type TimelineIdentityOrigin = "live" | "history";
export type TimelineIdentityConfidence =
  | "native"
  | "derived"
  | "provisional"
  | "heuristic";

export interface TimelineSourceCursor {
  filePath?: string;
  line?: number;
  byteOffset?: number;
  providerMessageId?: string;
  providerEventId?: string;
  dbRowId?: string;
  turnIndex?: number;
  itemIndex?: number;
  partIndex?: number;
}

export interface TimelineIdentity {
  canonicalItemId: string;
  canonicalTurnId: string;
  provider: ProviderKind;
  providerSessionId?: string;
  turnKey: string;
  itemKind: string;
  itemKey: string;
  origin: TimelineIdentityOrigin;
  sourceCursor?: TimelineSourceCursor;
  contentHash?: string;
  confidence: TimelineIdentityConfidence;
}

export type TimelineItem =
  | { kind: "user_message"; text: string; messageId?: string }
  | { kind: "assistant_message"; text: string; messageId?: string }
  | { kind: "reasoning"; text: string; section?: string }
  | { kind: "plan"; text: string }
  | { kind: "step"; title: string; status: "started" | "completed" | "interrupted"; text?: string }
  | { kind: "todo"; items: Array<{ text: string; completed: boolean }> }
  | { kind: "system"; text: string }
  | { kind: "error"; text: string }
  | { kind: "retry"; attempt: number; error?: string }
  | { kind: "side_question"; question: string; response?: string; error?: string }
  | { kind: "attachment"; label: string; mime?: string; path?: string; url?: string }
  | { kind: "compaction"; status: "started" | "completed"; trigger?: "auto" | "manual" };

export type ToolCallArtifact =
  | { kind: "text"; label: string; text: string }
  | { kind: "command"; command: string; cwd?: string }
  | { kind: "diff"; format: "unified"; text: string }
  | { kind: "file_refs"; files: string[] }
  | { kind: "json"; label: string; value: unknown }
  | { kind: "urls"; urls: string[] }
  | { kind: "image"; url?: string; path?: string; alt?: string }
  | { kind: "table"; label: string; rows: JsonObject[] };

export interface ToolCallDetail {
  artifacts: ToolCallArtifact[];
}

export type ToolFamily =
  | "shell"
  | "test"
  | "build"
  | "lint"
  | "file_read"
  | "file_write"
  | "file_edit"
  | "patch"
  | "search"
  | "fetch"
  | "web_search"
  | "web_fetch"
  | "mcp"
  | "subagent"
  | "git"
  | "worktree"
  | "plan"
  | "todo"
  | "memory"
  | "browser"
  | "notebook"
  | "voice"
  | "automation"
  | "external"
  | "governance"
  | "elicitation"
  | "media"
  | "preview"
  | "other";

export interface ToolCall {
  id: string;
  family: ToolFamily;
  providerToolName: string;
  title?: string;
  summary?: string;
  input?: Record<string, unknown>;
  result?: Record<string, unknown>;
  detail?: ToolCallDetail;
}

export interface PermissionAction {
  id: string;
  label: string;
  behavior: "allow" | "deny";
  variant?: "primary" | "secondary" | "danger";
}

export interface PermissionRequest {
  id: string;
  kind: "tool" | "plan" | "question" | "mode" | "other";
  title: string;
  description?: string;
  detail?: ToolCallDetail;
  actions?: PermissionAction[];
  input?: JsonObject;
}

export interface PermissionResolution {
  requestId: string;
  behavior: "allow" | "deny";
  message?: string;
  selectedActionId?: string;
  decision?: string;
  answers?: JsonObject;
}

export type ContextUsageBasis = "context_window" | "turn";

export type ContextUsagePrecision = "exact" | "estimated";

export interface ContextUsage {
  /**
   * Token count represented by this payload. When `basis` is `context_window`,
   * this is the current context-window occupancy and can be displayed as
   * used-context tokens. When `basis` is `turn`, this is provider-reported
   * turn usage and must not be treated as remaining-context occupancy.
  */
  usedTokens?: number;
  contextWindow?: number;
  percentUsed?: number;
  percentRemaining?: number;
  basis?: ContextUsageBasis;
  precision?: ContextUsagePrecision;
  source?: string;
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  reasoningOutputTokens?: number;
  totalCostUsd?: number;
}

export type ObservationStatus = "running" | "completed" | "failed" | "canceled";

export type ObservationKind =
  | "file.read"
  | "file.list"
  | "file.search"
  | "file.write"
  | "file.edit"
  | "patch.apply"
  | "command.run"
  | "test.run"
  | "build.run"
  | "lint.run"
  | "git.status"
  | "git.diff"
  | "git.apply"
  | "web.search"
  | "web.fetch"
  | "mcp.call"
  | "subagent.lifecycle"
  | "workspace.scan"
  | "worktree.setup"
  | "plan.update"
  | "todo.update"
  | "permission.change"
  | "governance.update"
  | "automation.run"
  | "turn.input"
  | "question.side"
  | "content.part"
  | "media.read"
  | "runtime.retry"
  | "runtime.invalid_stream"
  | "session.discovery"
  | "terminal.interaction"
  | "unknown";

export interface ObservationSubject {
  cwd?: string;
  command?: string;
  files?: string[];
  urls?: string[];
  query?: string;
  providerToolName?: string;
  providerCallId?: string;
}

export interface WorkbenchObservation {
  id: string;
  kind: ObservationKind;
  status: ObservationStatus;
  title: string;
  summary?: string;
  subject?: ObservationSubject;
  exitCode?: number;
  durationMs?: number;
  metrics?: JsonObject;
  detail?: ToolCallDetail;
}

export type MessagePartKind =
  | "text"
  | "reasoning"
  | "tool"
  | "file"
  | "agent"
  | "compaction"
  | "subtask"
  | "retry"
  | "step"
  | "patch"
  | "snapshot"
  | "media"
  | "unknown";

export interface MessagePartRef {
  messageId: string;
  partId: string;
  kind: MessagePartKind;
  text?: string;
  delta?: string;
  metadata?: JsonObject;
}

export interface RuntimeOperation {
  id: string;
  kind: "automation" | "governance" | "external_tool" | "provider_internal";
  name: string;
  target: string;
  action?: "allow" | "block";
  reason?: string;
  durationMs?: number;
  input?: JsonObject;
}

export interface AttentionItem {
  id: string;
  sessionId: string;
  level: "info" | "warning" | "critical";
  reason:
    | "permission_needed"
    | "turn_finished"
    | "turn_failed"
    | "session_stalled"
    | "background_exit"
    | "review_ready";
  title: string;
  body: string;
  dedupeKey: string;
  createdAt: string;
}

export type RahEventPayloadMap = {
  "session.discovery": { version: number };
  "session.created": { session: ManagedSession };
  "session.started": { session: ManagedSession };
  "session.attached": { clientId: string; clientKind: ClientKind };
  "session.detached": { clientId: string };
  "session.closed": { clientId?: string };
  "session.state.changed": { state: ManagedSession["runtimeState"] };
  "session.exited": { exitCode?: number; signal?: string };
  "session.failed": { error: string };

  "control.claimed": { clientId: string; clientKind: ClientKind };
  "control.released": { clientId?: string };

  "turn.started": Record<string, never>;
  "turn.completed": { usage?: ContextUsage };
  "turn.failed": { error: string; code?: string };
  "turn.canceled": { reason: string };
  "turn.step.started": { index?: number; title?: string };
  "turn.step.completed": { index?: number; reason?: string };
  "turn.step.interrupted": { index?: number; reason?: string };
  "turn.input.appended": { text?: string; parts?: JsonValue[] };

  "timeline.item.added": { item: TimelineItem; identity?: TimelineIdentity };
  "timeline.item.updated": { item: TimelineItem; identity?: TimelineIdentity };

  "message.part.added": { part: MessagePartRef };
  "message.part.updated": { part: MessagePartRef };
  "message.part.delta": { part: MessagePartRef };
  "message.part.removed": { messageId: string; partId: string };

  "tool.call.started": { toolCall: ToolCall };
  "tool.call.delta": { toolCallId: string; detail: ToolCallDetail };
  "tool.call.completed": { toolCall: ToolCall };
  "tool.call.failed": { toolCallId: string; error: string; detail?: ToolCallDetail };

  "observation.started": { observation: WorkbenchObservation };
  "observation.updated": { observation: WorkbenchObservation };
  "observation.completed": { observation: WorkbenchObservation };
  "observation.failed": { observation: WorkbenchObservation; error?: string };

  "permission.requested": { request: PermissionRequest };
  "permission.resolved": { resolution: PermissionResolution };

  "operation.started": { operation: RuntimeOperation };
  "operation.resolved": { operation: RuntimeOperation };
  "operation.requested": { operation: RuntimeOperation };

  "governance.updated": { policy: JsonObject };

  "usage.updated": { usage: ContextUsage };
  "runtime.status": {
    status:
      | "connecting"
      | "connected"
      | "authenticated"
      | "session_active"
      | "thinking"
      | "streaming"
      | "retrying"
      | "finished"
      | "error";
    detail?: string;
    retryCount?: number;
  };

  "terminal.output": { data: string };
  "terminal.exited": { exitCode?: number; signal?: string };

  "attention.required": { item: AttentionItem };
  "attention.cleared": { id: string };

  "notification.emitted": {
    level: "info" | "warning" | "critical";
    title: string;
    body: string;
    url?: string;
  };

  "host.updated": { hostId: string; metadata?: JsonObject };
  "transport.changed": { status: string; subscriptionId?: string };
  "heartbeat": { timestamp?: number };
};

export type RahEventType = keyof RahEventPayloadMap;

export type RahEvent = {
  [K in RahEventType]: EventEnvelope<RahEventPayloadMap[K]> & { type: K };
}[RahEventType];

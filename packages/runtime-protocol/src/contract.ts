import type {
  AttentionItem,
  EventAuthority,
  EventChannel,
  EventEnvelope,
  EventSource,
  JsonObject,
  MessagePartKind,
  MessagePartRef,
  ObservationKind,
  ObservationStatus,
  PermissionAction,
  PermissionRequest,
  PermissionResolution,
  RahEvent,
  RahEventPayloadMap,
  RahEventType,
  RuntimeOperation,
  TimelineItem,
  ToolCall,
  ToolCallArtifact,
  ToolCallDetail,
  ToolFamily,
  WorkbenchObservation,
} from "./events";
import type {
  ClientKind,
  ProviderKind,
  SessionLaunchSource,
  SessionRuntimeState,
} from "./session";

export const RAH_EVENT_PROTOCOL_VERSION = 1;

export type RahEventFamily =
  | "session"
  | "control"
  | "turn"
  | "timeline"
  | "message_part"
  | "tool_call"
  | "observation"
  | "permission"
  | "operation"
  | "governance"
  | "usage"
  | "runtime"
  | "terminal"
  | "attention"
  | "notification"
  | "host"
  | "transport"
  | "heartbeat";

export type RahEventTier = "core_workbench" | "infrastructure";

export const RAH_EVENT_TYPE_FAMILY = {
  "session.discovery": "session",
  "session.created": "session",
  "session.started": "session",
  "session.attached": "session",
  "session.detached": "session",
  "session.closed": "session",
  "session.state.changed": "session",
  "session.exited": "session",
  "session.failed": "session",
  "control.claimed": "control",
  "control.released": "control",
  "turn.started": "turn",
  "turn.completed": "turn",
  "turn.failed": "turn",
  "turn.canceled": "turn",
  "turn.step.started": "turn",
  "turn.step.completed": "turn",
  "turn.step.interrupted": "turn",
  "turn.input.appended": "turn",
  "timeline.item.added": "timeline",
  "timeline.item.updated": "timeline",
  "message.part.added": "message_part",
  "message.part.updated": "message_part",
  "message.part.delta": "message_part",
  "message.part.removed": "message_part",
  "tool.call.started": "tool_call",
  "tool.call.delta": "tool_call",
  "tool.call.completed": "tool_call",
  "tool.call.failed": "tool_call",
  "observation.started": "observation",
  "observation.updated": "observation",
  "observation.completed": "observation",
  "observation.failed": "observation",
  "permission.requested": "permission",
  "permission.resolved": "permission",
  "operation.started": "operation",
  "operation.resolved": "operation",
  "operation.requested": "operation",
  "governance.updated": "governance",
  "usage.updated": "usage",
  "context.updated": "usage",
  "runtime.status": "runtime",
  "terminal.output": "terminal",
  "terminal.exited": "terminal",
  "attention.required": "attention",
  "attention.cleared": "attention",
  "notification.emitted": "notification",
  "host.updated": "host",
  "transport.changed": "transport",
  heartbeat: "heartbeat",
} as const satisfies Record<RahEventType, RahEventFamily>;

export const RAH_EVENT_TYPES = Object.keys(RAH_EVENT_TYPE_FAMILY) as RahEventType[];

export const RAH_CORE_WORKBENCH_FAMILIES = [
  "session",
  "control",
  "turn",
  "timeline",
  "message_part",
  "tool_call",
  "observation",
  "permission",
  "usage",
  "attention",
  "terminal",
] as const satisfies readonly RahEventFamily[];

const RAH_CORE_WORKBENCH_FAMILY_SET = new Set<RahEventFamily>(RAH_CORE_WORKBENCH_FAMILIES);

export function rahEventTier(type: RahEventType): RahEventTier {
  return RAH_CORE_WORKBENCH_FAMILY_SET.has(RAH_EVENT_TYPE_FAMILY[type])
    ? "core_workbench"
    : "infrastructure";
}

export function isCoreWorkbenchEvent(event: RahEvent): boolean {
  return rahEventTier(event.type) === "core_workbench";
}

const PROVIDERS = new Set<ProviderKind | "system">([
  "codex",
  "claude",
  "kimi",
  "gemini",
  "opencode",
  "custom",
  "system",
]);

const EVENT_CHANNELS = new Set<EventChannel>([
  "structured_live",
  "structured_persisted",
  "pty",
  "system",
]);

const EVENT_AUTHORITIES = new Set<EventAuthority>([
  "authoritative",
  "derived",
  "heuristic",
]);

const CLIENT_KINDS = new Set<ClientKind>(["terminal", "web", "ios", "ipad", "api"]);

const SESSION_RUNTIME_STATES = new Set<SessionRuntimeState>([
  "starting",
  "running",
  "idle",
  "waiting_input",
  "waiting_permission",
  "stopped",
  "failed",
]);

const SESSION_LAUNCH_SOURCES = new Set<SessionLaunchSource>(["web", "terminal"]);

const TOOL_FAMILIES = new Set<ToolFamily>([
  "shell",
  "test",
  "build",
  "lint",
  "file_read",
  "file_write",
  "file_edit",
  "patch",
  "search",
  "fetch",
  "web_search",
  "web_fetch",
  "mcp",
  "subagent",
  "git",
  "worktree",
  "plan",
  "todo",
  "memory",
  "browser",
  "notebook",
  "voice",
  "automation",
  "external",
  "governance",
  "elicitation",
  "media",
  "preview",
  "other",
]);

const OBSERVATION_KINDS = new Set<ObservationKind>([
  "file.read",
  "file.list",
  "file.search",
  "file.write",
  "file.edit",
  "patch.apply",
  "command.run",
  "test.run",
  "build.run",
  "lint.run",
  "git.status",
  "git.diff",
  "git.apply",
  "web.search",
  "web.fetch",
  "mcp.call",
  "subagent.lifecycle",
  "workspace.scan",
  "worktree.setup",
  "plan.update",
  "todo.update",
  "permission.change",
  "governance.update",
  "automation.run",
  "turn.input",
  "question.side",
  "content.part",
  "media.read",
  "runtime.retry",
  "runtime.invalid_stream",
  "session.discovery",
  "terminal.interaction",
  "unknown",
]);

const OBSERVATION_STATUSES = new Set<ObservationStatus>([
  "running",
  "completed",
  "failed",
  "canceled",
]);

const MESSAGE_PART_KINDS = new Set<MessagePartKind>([
  "text",
  "reasoning",
  "tool",
  "file",
  "agent",
  "compaction",
  "subtask",
  "retry",
  "step",
  "patch",
  "snapshot",
  "media",
  "unknown",
]);

const RUNTIME_STATUSES = new Set([
  "connecting",
  "connected",
  "authenticated",
  "session_active",
  "thinking",
  "streaming",
  "retrying",
  "finished",
  "error",
]);

export interface RahEventConformanceOptions {
  /**
   * Require each sequence to be sorted by strict ascending event sequence.
   */
  strictSequence?: boolean;
  /**
   * Require transcript/tool/observation/permission events to carry a turn id.
   * Persisted provider histories may not have this, so adapters can validate
   * replay and live streams under different policies.
   */
  requireTurnScopedWork?: boolean;
  /**
   * Require heuristic events to retain raw provider evidence for debugging.
   */
  requireRawForHeuristic?: boolean;
}

export interface RahConformanceIssue {
  severity: "error" | "warning";
  code: string;
  message: string;
  eventId?: string;
  eventSeq?: number;
  eventType?: string;
  path?: string;
}

export interface RahConformanceReport {
  ok: boolean;
  errors: RahConformanceIssue[];
  warnings: RahConformanceIssue[];
}

type IssueSink = {
  event?: EventEnvelope;
  issues: RahConformanceIssue[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

function isJsonObject(value: unknown): value is JsonObject {
  return isRecord(value);
}

function isOptionalNumber(value: unknown): value is number | undefined {
  return value === undefined || typeof value === "number";
}

function isOptionalInteger(value: unknown): value is number | undefined {
  return value === undefined || Number.isInteger(value);
}

function addIssue(
  sink: IssueSink,
  severity: RahConformanceIssue["severity"],
  code: string,
  message: string,
  path?: string,
) {
  sink.issues.push({
    severity,
    code,
    message,
    ...(sink.event?.id !== undefined ? { eventId: sink.event.id } : {}),
    ...(sink.event?.seq !== undefined ? { eventSeq: sink.event.seq } : {}),
    ...(sink.event?.type !== undefined ? { eventType: sink.event.type } : {}),
    ...(path !== undefined ? { path } : {}),
  });
}

function validateEventSource(source: unknown, sink: IssueSink, path: string) {
  if (!isRecord(source)) {
    addIssue(sink, "error", "source.invalid", "event source must be an object", path);
    return;
  }
  if (!PROVIDERS.has(source.provider as ProviderKind | "system")) {
    addIssue(sink, "error", "source.provider.invalid", "event source provider is not canonical", `${path}.provider`);
  }
  if (!EVENT_CHANNELS.has(source.channel as EventChannel)) {
    addIssue(sink, "error", "source.channel.invalid", "event source channel is not canonical", `${path}.channel`);
  }
  if (!EVENT_AUTHORITIES.has(source.authority as EventAuthority)) {
    addIssue(sink, "error", "source.authority.invalid", "event source authority is not canonical", `${path}.authority`);
  }
}

function validateArtifact(artifact: ToolCallArtifact, sink: IssueSink, path: string) {
  if (!isRecord(artifact) || !isNonEmptyString(artifact.kind)) {
    addIssue(sink, "error", "artifact.invalid", "artifact must have a kind", path);
    return;
  }

  switch (artifact.kind) {
    case "text":
      if (!isNonEmptyString(artifact.label)) {
        addIssue(sink, "error", "artifact.text.label.invalid", "text artifact label must be non-empty", `${path}.label`);
      }
      if (typeof artifact.text !== "string") {
        addIssue(sink, "error", "artifact.text.invalid", "text artifact text must be a string", `${path}.text`);
      }
      break;
    case "command":
      if (!isNonEmptyString(artifact.command)) {
        addIssue(sink, "error", "artifact.command.invalid", "command artifact command must be non-empty", `${path}.command`);
      }
      if (!isOptionalString(artifact.cwd)) {
        addIssue(sink, "error", "artifact.command.cwd.invalid", "command artifact cwd must be a string", `${path}.cwd`);
      }
      break;
    case "diff":
      if (artifact.format !== "unified") {
        addIssue(sink, "error", "artifact.diff.format.invalid", "diff artifact format must be unified", `${path}.format`);
      }
      if (typeof artifact.text !== "string") {
        addIssue(sink, "error", "artifact.diff.text.invalid", "diff artifact text must be a string", `${path}.text`);
      }
      break;
    case "file_refs":
      if (!Array.isArray(artifact.files) || !artifact.files.every(isNonEmptyString)) {
        addIssue(sink, "error", "artifact.file_refs.invalid", "file_refs artifact files must be non-empty strings", `${path}.files`);
      }
      break;
    case "json":
      if (!isNonEmptyString(artifact.label)) {
        addIssue(sink, "error", "artifact.json.label.invalid", "json artifact label must be non-empty", `${path}.label`);
      }
      break;
    case "urls":
      if (!Array.isArray(artifact.urls) || !artifact.urls.every(isNonEmptyString)) {
        addIssue(sink, "error", "artifact.urls.invalid", "urls artifact urls must be non-empty strings", `${path}.urls`);
      }
      break;
    case "image":
      if (!isOptionalString(artifact.url) || !isOptionalString(artifact.path) || !isOptionalString(artifact.alt)) {
        addIssue(sink, "error", "artifact.image.invalid", "image artifact fields must be strings", path);
      }
      break;
    case "table":
      if (!isNonEmptyString(artifact.label)) {
        addIssue(sink, "error", "artifact.table.label.invalid", "table artifact label must be non-empty", `${path}.label`);
      }
      if (!Array.isArray(artifact.rows) || !artifact.rows.every(isJsonObject)) {
        addIssue(sink, "error", "artifact.table.rows.invalid", "table artifact rows must be objects", `${path}.rows`);
      }
      break;
    default:
      addIssue(sink, "error", "artifact.kind.invalid", "artifact kind is not canonical", `${path}.kind`);
  }
}

function validateToolDetail(detail: ToolCallDetail | undefined, sink: IssueSink, path: string) {
  if (detail === undefined) {
    return;
  }
  if (!isRecord(detail) || !Array.isArray(detail.artifacts)) {
    addIssue(sink, "error", "tool.detail.invalid", "tool detail must contain artifacts", path);
    return;
  }
  detail.artifacts.forEach((artifact, index) => {
    validateArtifact(artifact, sink, `${path}.artifacts[${index}]`);
  });
}

function validateToolCall(toolCall: ToolCall, sink: IssueSink, path: string) {
  if (!isRecord(toolCall)) {
    addIssue(sink, "error", "tool.invalid", "tool call must be an object", path);
    return;
  }
  if (!isNonEmptyString(toolCall.id)) {
    addIssue(sink, "error", "tool.id.invalid", "tool call id must be non-empty", `${path}.id`);
  }
  if (!TOOL_FAMILIES.has(toolCall.family)) {
    addIssue(sink, "error", "tool.family.invalid", "tool call family is not canonical", `${path}.family`);
  }
  if (!isNonEmptyString(toolCall.providerToolName)) {
    addIssue(sink, "error", "tool.provider_name.invalid", "tool call providerToolName must preserve provider evidence", `${path}.providerToolName`);
  }
  if (toolCall.input !== undefined && !isRecord(toolCall.input)) {
    addIssue(sink, "error", "tool.input.invalid", "tool call input must be an object", `${path}.input`);
  }
  if (toolCall.result !== undefined && !isRecord(toolCall.result)) {
    addIssue(sink, "error", "tool.result.invalid", "tool call result must be an object", `${path}.result`);
  }
  validateToolDetail(toolCall.detail, sink, `${path}.detail`);
}

function validateContextUsage(usage: unknown, sink: IssueSink, path: string) {
  if (!isRecord(usage)) {
    addIssue(sink, "error", "usage.invalid", "usage payload must be an object", path);
    return;
  }
  const numericFields = [
    "usedTokens",
    "contextWindow",
    "percentRemaining",
    "inputTokens",
    "cachedInputTokens",
    "outputTokens",
    "reasoningOutputTokens",
    "totalCostUsd",
  ] as const;
  for (const field of numericFields) {
    if (!isOptionalNumber(usage[field])) {
      addIssue(
        sink,
        "error",
        "usage.field.invalid",
        `usage field ${field} must be numeric when present`,
        `${path}.${field}`,
      );
    }
  }
}

function validateSessionCapabilities(capabilities: unknown, sink: IssueSink, path: string) {
  if (!isRecord(capabilities)) {
    addIssue(
      sink,
      "error",
      "session.capabilities.invalid",
      "session capabilities must be an object",
      path,
    );
    return;
  }
  const capabilityFields = [
    "liveAttach",
    "structuredTimeline",
    "livePermissions",
    "contextUsage",
    "resumeByProvider",
    "listProviderSessions",
    "steerInput",
    "queuedInput",
    "modelSwitch",
    "planMode",
    "subagents",
  ] as const;
  for (const field of capabilityFields) {
    if (typeof capabilities[field] !== "boolean") {
      addIssue(
        sink,
        "error",
        "session.capabilities.field.invalid",
        `session capability ${field} must be boolean`,
        `${path}.${field}`,
      );
    }
  }
}

function validateManagedSession(session: unknown, sink: IssueSink, path: string) {
  if (!isRecord(session)) {
    addIssue(sink, "error", "session.payload.invalid", "session payload must be an object", path);
    return;
  }
  if (!isNonEmptyString(session.id)) {
    addIssue(sink, "error", "session.id.invalid", "session id must be non-empty", `${path}.id`);
  }
  if (!PROVIDERS.has(session.provider as ProviderKind | "system") || session.provider === "system") {
    addIssue(
      sink,
      "error",
      "session.provider.invalid",
      "session provider must be a managed provider",
      `${path}.provider`,
    );
  }
  if (!SESSION_LAUNCH_SOURCES.has(session.launchSource as SessionLaunchSource)) {
    addIssue(
      sink,
      "error",
      "session.launch_source.invalid",
      "session launchSource is not canonical",
      `${path}.launchSource`,
    );
  }
  if (!isNonEmptyString(session.cwd) || !isNonEmptyString(session.rootDir)) {
    addIssue(
      sink,
      "error",
      "session.path.invalid",
      "session cwd and rootDir must be non-empty",
      path,
    );
  }
  if (!SESSION_RUNTIME_STATES.has(session.runtimeState as SessionRuntimeState)) {
    addIssue(
      sink,
      "error",
      "session.runtime_state.invalid",
      "session runtimeState is not canonical",
      `${path}.runtimeState`,
    );
  }
  if (!isNonEmptyString(session.ptyId)) {
    addIssue(
      sink,
      "error",
      "session.pty_id.invalid",
      "session ptyId must be non-empty",
      `${path}.ptyId`,
    );
  }
  if (!isOptionalInteger(session.pid)) {
    addIssue(sink, "error", "session.pid.invalid", "session pid must be an integer", `${path}.pid`);
  }
  if (session.providerSessionId !== undefined && !isNonEmptyString(session.providerSessionId)) {
    addIssue(
      sink,
      "error",
      "session.provider_session_id.invalid",
      "providerSessionId must be non-empty",
      `${path}.providerSessionId`,
    );
  }
  if (session.title !== undefined && !isOptionalString(session.title)) {
    addIssue(sink, "error", "session.title.invalid", "session title must be a string", `${path}.title`);
  }
  if (session.preview !== undefined && !isOptionalString(session.preview)) {
    addIssue(
      sink,
      "error",
      "session.preview.invalid",
      "session preview must be a string",
      `${path}.preview`,
    );
  }
  if (!isNonEmptyString(session.createdAt) || Number.isNaN(Date.parse(session.createdAt))) {
    addIssue(
      sink,
      "error",
      "session.created_at.invalid",
      "session createdAt must be a valid timestamp",
      `${path}.createdAt`,
    );
  }
  if (!isNonEmptyString(session.updatedAt) || Number.isNaN(Date.parse(session.updatedAt))) {
    addIssue(
      sink,
      "error",
      "session.updated_at.invalid",
      "session updatedAt must be a valid timestamp",
      `${path}.updatedAt`,
    );
  }
  validateSessionCapabilities(session.capabilities, sink, `${path}.capabilities`);
}

function validateTimelineItem(item: TimelineItem, sink: IssueSink, path: string) {
  if (!isRecord(item) || !isNonEmptyString(item.kind)) {
    addIssue(sink, "error", "timeline.invalid", "timeline item must have a kind", path);
    return;
  }

  switch (item.kind) {
    case "user_message":
    case "assistant_message":
    case "reasoning":
    case "plan":
    case "system":
    case "error":
      if (typeof item.text !== "string") {
        addIssue(sink, "error", "timeline.text.invalid", "timeline text must be a string", `${path}.text`);
      }
      break;
    case "step":
      if (!isNonEmptyString(item.title)) {
        addIssue(sink, "error", "timeline.step.title.invalid", "step title must be non-empty", `${path}.title`);
      }
      if (!["started", "completed", "interrupted"].includes(item.status)) {
        addIssue(sink, "error", "timeline.step.status.invalid", "step status is not canonical", `${path}.status`);
      }
      break;
    case "todo":
      if (!Array.isArray(item.items)) {
        addIssue(sink, "error", "timeline.todo.invalid", "todo items must be an array", `${path}.items`);
      }
      break;
    case "retry":
      if (!Number.isInteger(item.attempt) || item.attempt < 1) {
        addIssue(sink, "error", "timeline.retry.invalid", "retry attempt must be a positive integer", `${path}.attempt`);
      }
      break;
    case "side_question":
      if (!isNonEmptyString(item.question)) {
        addIssue(sink, "error", "timeline.question.invalid", "side question must be non-empty", `${path}.question`);
      }
      break;
    case "attachment":
      if (!isNonEmptyString(item.label)) {
        addIssue(sink, "error", "timeline.attachment.invalid", "attachment label must be non-empty", `${path}.label`);
      }
      break;
    case "compaction":
      if (!["started", "completed"].includes(item.status)) {
        addIssue(sink, "error", "timeline.compaction.invalid", "compaction status is not canonical", `${path}.status`);
      }
      break;
    default:
      addIssue(sink, "error", "timeline.kind.invalid", "timeline kind is not canonical", `${path}.kind`);
  }
}

function validateMessagePart(part: MessagePartRef, sink: IssueSink, path: string) {
  if (!isRecord(part)) {
    addIssue(sink, "error", "message_part.invalid", "message part must be an object", path);
    return;
  }
  if (!isNonEmptyString(part.messageId)) {
    addIssue(sink, "error", "message_part.message_id.invalid", "messageId must be non-empty", `${path}.messageId`);
  }
  if (!isNonEmptyString(part.partId)) {
    addIssue(sink, "error", "message_part.part_id.invalid", "partId must be non-empty", `${path}.partId`);
  }
  if (!MESSAGE_PART_KINDS.has(part.kind)) {
    addIssue(sink, "error", "message_part.kind.invalid", "message part kind is not canonical", `${path}.kind`);
  }
  if (part.metadata !== undefined && !isJsonObject(part.metadata)) {
    addIssue(sink, "error", "message_part.metadata.invalid", "message part metadata must be an object", `${path}.metadata`);
  }
}

function validateObservation(
  observation: WorkbenchObservation,
  expectedStatus: ObservationStatus | undefined,
  sink: IssueSink,
  path: string,
) {
  if (!isRecord(observation)) {
    addIssue(sink, "error", "observation.invalid", "observation must be an object", path);
    return;
  }
  if (!isNonEmptyString(observation.id)) {
    addIssue(sink, "error", "observation.id.invalid", "observation id must be non-empty", `${path}.id`);
  }
  if (!OBSERVATION_KINDS.has(observation.kind)) {
    addIssue(sink, "error", "observation.kind.invalid", "observation kind is not canonical", `${path}.kind`);
  }
  if (!OBSERVATION_STATUSES.has(observation.status)) {
    addIssue(sink, "error", "observation.status.invalid", "observation status is not canonical", `${path}.status`);
  }
  if (expectedStatus !== undefined && observation.status !== expectedStatus) {
    addIssue(
      sink,
      "error",
      "observation.status.mismatch",
      `observation status must be ${expectedStatus} for this event type`,
      `${path}.status`,
    );
  }
  if (!isNonEmptyString(observation.title)) {
    addIssue(sink, "error", "observation.title.invalid", "observation title must be non-empty", `${path}.title`);
  }
  if (observation.metrics !== undefined && !isJsonObject(observation.metrics)) {
    addIssue(sink, "error", "observation.metrics.invalid", "observation metrics must be an object", `${path}.metrics`);
  }
  validateToolDetail(observation.detail, sink, `${path}.detail`);
}

function validatePermissionAction(action: PermissionAction, sink: IssueSink, path: string) {
  if (!isRecord(action)) {
    addIssue(sink, "error", "permission.action.invalid", "permission action must be an object", path);
    return;
  }
  if (!isNonEmptyString(action.id)) {
    addIssue(sink, "error", "permission.action.id.invalid", "permission action id must be non-empty", `${path}.id`);
  }
  if (!isNonEmptyString(action.label)) {
    addIssue(sink, "error", "permission.action.label.invalid", "permission action label must be non-empty", `${path}.label`);
  }
  if (!["allow", "deny"].includes(action.behavior)) {
    addIssue(sink, "error", "permission.action.behavior.invalid", "permission action behavior must be allow or deny", `${path}.behavior`);
  }
}

function validatePermissionRequest(request: PermissionRequest, sink: IssueSink, path: string) {
  if (!isRecord(request)) {
    addIssue(sink, "error", "permission.request.invalid", "permission request must be an object", path);
    return;
  }
  if (!isNonEmptyString(request.id)) {
    addIssue(sink, "error", "permission.request.id.invalid", "permission request id must be non-empty", `${path}.id`);
  }
  if (!["tool", "plan", "question", "mode", "other"].includes(request.kind)) {
    addIssue(sink, "error", "permission.request.kind.invalid", "permission request kind is not canonical", `${path}.kind`);
  }
  if (!isNonEmptyString(request.title)) {
    addIssue(sink, "error", "permission.request.title.invalid", "permission request title must be non-empty", `${path}.title`);
  }
  if (request.input !== undefined && !isJsonObject(request.input)) {
    addIssue(sink, "error", "permission.request.input.invalid", "permission request input must be an object", `${path}.input`);
  }
  validateToolDetail(request.detail, sink, `${path}.detail`);
  request.actions?.forEach((action, index) => {
    validatePermissionAction(action, sink, `${path}.actions[${index}]`);
  });
}

function validatePermissionResolution(
  resolution: PermissionResolution,
  sink: IssueSink,
  path: string,
) {
  if (!isRecord(resolution)) {
    addIssue(sink, "error", "permission.resolution.invalid", "permission resolution must be an object", path);
    return;
  }
  if (!isNonEmptyString(resolution.requestId)) {
    addIssue(sink, "error", "permission.resolution.request_id.invalid", "permission resolution requestId must be non-empty", `${path}.requestId`);
  }
  if (!["allow", "deny"].includes(resolution.behavior)) {
    addIssue(sink, "error", "permission.resolution.behavior.invalid", "permission resolution behavior must be allow or deny", `${path}.behavior`);
  }
  if (resolution.selectedActionId !== undefined && !isNonEmptyString(resolution.selectedActionId)) {
    addIssue(sink, "error", "permission.resolution.selected_action_id.invalid", "permission resolution selectedActionId must be non-empty", `${path}.selectedActionId`);
  }
  if (resolution.decision !== undefined && !isNonEmptyString(resolution.decision)) {
    addIssue(sink, "error", "permission.resolution.decision.invalid", "permission resolution decision must be non-empty", `${path}.decision`);
  }
  if (resolution.answers !== undefined && !isJsonObject(resolution.answers)) {
    addIssue(sink, "error", "permission.resolution.answers.invalid", "permission resolution answers must be an object", `${path}.answers`);
  }
}

function validateRuntimeOperation(operation: RuntimeOperation, sink: IssueSink, path: string) {
  if (!isRecord(operation)) {
    addIssue(sink, "error", "operation.invalid", "runtime operation must be an object", path);
    return;
  }
  if (!isNonEmptyString(operation.id)) {
    addIssue(sink, "error", "operation.id.invalid", "runtime operation id must be non-empty", `${path}.id`);
  }
  if (!["automation", "governance", "external_tool", "provider_internal"].includes(operation.kind)) {
    addIssue(sink, "error", "operation.kind.invalid", "runtime operation kind is not canonical", `${path}.kind`);
  }
  if (!isNonEmptyString(operation.name)) {
    addIssue(sink, "error", "operation.name.invalid", "runtime operation name must be non-empty", `${path}.name`);
  }
  if (!isNonEmptyString(operation.target)) {
    addIssue(sink, "error", "operation.target.invalid", "runtime operation target must be non-empty", `${path}.target`);
  }
}

function validateAttentionItem(item: AttentionItem, sink: IssueSink, path: string) {
  if (!isRecord(item)) {
    addIssue(sink, "error", "attention.invalid", "attention item must be an object", path);
    return;
  }
  if (!isNonEmptyString(item.id) || !isNonEmptyString(item.sessionId)) {
    addIssue(sink, "error", "attention.id.invalid", "attention item id and sessionId must be non-empty", path);
  }
  if (!["info", "warning", "critical"].includes(item.level)) {
    addIssue(sink, "error", "attention.level.invalid", "attention level is not canonical", `${path}.level`);
  }
  if (
    ![
      "permission_needed",
      "turn_finished",
      "turn_failed",
      "session_stalled",
      "background_exit",
      "review_ready",
    ].includes(item.reason)
  ) {
    addIssue(sink, "error", "attention.reason.invalid", "attention reason is not canonical", `${path}.reason`);
  }
  if (!isNonEmptyString(item.title) || !isNonEmptyString(item.body) || !isNonEmptyString(item.dedupeKey)) {
    addIssue(sink, "error", "attention.content.invalid", "attention title/body/dedupeKey must be non-empty", path);
  }
  if (!isNonEmptyString(item.createdAt) || Number.isNaN(Date.parse(item.createdAt))) {
    addIssue(sink, "error", "attention.created_at.invalid", "attention createdAt must be a valid timestamp", `${path}.createdAt`);
  }
}

function validatePayload(event: RahEvent, sink: IssueSink) {
  const payload = event.payload as Record<string, unknown>;
  if (!isRecord(payload)) {
    addIssue(sink, "error", "payload.invalid", "event payload must be an object", "payload");
    return;
  }

  switch (event.type) {
    case "turn.started":
    case "turn.completed":
    case "turn.failed":
    case "turn.canceled":
    case "turn.step.started":
    case "turn.step.completed":
    case "turn.step.interrupted":
    case "turn.input.appended":
      if (!isNonEmptyString(event.turnId)) {
        addIssue(sink, "error", "turn.id.missing", "turn events must carry turnId", "turnId");
      }
      break;
    case "timeline.item.added":
    case "timeline.item.updated":
      validateTimelineItem(payload.item as TimelineItem, sink, "payload.item");
      break;
    case "message.part.added":
    case "message.part.updated":
    case "message.part.delta":
      validateMessagePart(payload.part as MessagePartRef, sink, "payload.part");
      break;
    case "message.part.removed":
      if (!isNonEmptyString(payload.messageId) || !isNonEmptyString(payload.partId)) {
        addIssue(sink, "error", "message_part.remove.invalid", "message part removal needs messageId and partId", "payload");
      }
      break;
    case "tool.call.started":
    case "tool.call.completed":
      validateToolCall(payload.toolCall as ToolCall, sink, "payload.toolCall");
      break;
    case "tool.call.delta":
      if (!isNonEmptyString(payload.toolCallId)) {
        addIssue(sink, "error", "tool.delta.id.invalid", "tool call delta needs toolCallId", "payload.toolCallId");
      }
      validateToolDetail(payload.detail as ToolCallDetail, sink, "payload.detail");
      break;
    case "tool.call.failed":
      if (!isNonEmptyString(payload.toolCallId)) {
        addIssue(sink, "error", "tool.failed.id.invalid", "tool failure needs toolCallId", "payload.toolCallId");
      }
      if (!isNonEmptyString(payload.error)) {
        addIssue(sink, "error", "tool.failed.error.invalid", "tool failure error must be non-empty", "payload.error");
      }
      validateToolDetail(payload.detail as ToolCallDetail | undefined, sink, "payload.detail");
      break;
    case "observation.started":
      validateObservation(payload.observation as WorkbenchObservation, "running", sink, "payload.observation");
      break;
    case "observation.updated":
      validateObservation(payload.observation as WorkbenchObservation, undefined, sink, "payload.observation");
      break;
    case "observation.completed":
      validateObservation(payload.observation as WorkbenchObservation, "completed", sink, "payload.observation");
      break;
    case "observation.failed":
      validateObservation(payload.observation as WorkbenchObservation, "failed", sink, "payload.observation");
      break;
    case "permission.requested":
      validatePermissionRequest(payload.request as PermissionRequest, sink, "payload.request");
      break;
    case "permission.resolved":
      validatePermissionResolution(payload.resolution as PermissionResolution, sink, "payload.resolution");
      break;
    case "operation.started":
    case "operation.resolved":
    case "operation.requested":
      validateRuntimeOperation(payload.operation as RuntimeOperation, sink, "payload.operation");
      break;
    case "governance.updated":
      if (!isJsonObject(payload.policy)) {
        addIssue(sink, "error", "governance.policy.invalid", "governance policy must be an object", "payload.policy");
      }
      break;
    case "usage.updated":
    case "context.updated":
      validateContextUsage(payload.usage, sink, "payload.usage");
      break;
    case "runtime.status":
      if (!RUNTIME_STATUSES.has(payload.status as string)) {
        addIssue(sink, "error", "runtime.status.invalid", "runtime status is not canonical", "payload.status");
      }
      if (!isOptionalString(payload.detail)) {
        addIssue(sink, "error", "runtime.detail.invalid", "runtime detail must be a string", "payload.detail");
      }
      if (
        !isOptionalInteger(payload.retryCount) ||
        (typeof payload.retryCount === "number" && payload.retryCount < 0)
      ) {
        addIssue(
          sink,
          "error",
          "runtime.retry_count.invalid",
          "runtime retryCount must be a non-negative integer",
          "payload.retryCount",
        );
      }
      break;
    case "terminal.output":
      if (typeof payload.data !== "string") {
        addIssue(sink, "error", "terminal.output.invalid", "terminal output data must be a string", "payload.data");
      }
      break;
    case "terminal.exited":
      break;
    case "attention.required":
      validateAttentionItem(payload.item as AttentionItem, sink, "payload.item");
      break;
    case "attention.cleared":
      if (!isNonEmptyString(payload.id)) {
        addIssue(sink, "error", "attention.clear.invalid", "attention clear id must be non-empty", "payload.id");
      }
      break;
    case "notification.emitted":
      if (!["info", "warning", "critical"].includes(payload.level as string)) {
        addIssue(sink, "error", "notification.level.invalid", "notification level is not canonical", "payload.level");
      }
      if (!isNonEmptyString(payload.title) || typeof payload.body !== "string") {
        addIssue(sink, "error", "notification.content.invalid", "notification title/body are required", "payload");
      }
      if (!isOptionalString(payload.url)) {
        addIssue(sink, "error", "notification.url.invalid", "notification url must be a string", "payload.url");
      }
      break;
    case "host.updated":
      if (!isNonEmptyString(payload.hostId)) {
        addIssue(sink, "error", "host.id.invalid", "host id must be non-empty", "payload.hostId");
      }
      break;
    case "transport.changed":
      if (!isNonEmptyString(payload.status)) {
        addIssue(sink, "error", "transport.status.invalid", "transport status must be non-empty", "payload.status");
      }
      break;
    case "heartbeat":
      if (!isOptionalInteger(payload.timestamp)) {
        addIssue(sink, "error", "heartbeat.timestamp.invalid", "heartbeat timestamp must be an integer", "payload.timestamp");
      }
      break;
    case "session.created":
    case "session.started":
      validateManagedSession(payload.session, sink, "payload.session");
      break;
    case "session.discovery":
      if (!isOptionalInteger(payload.version)) {
        addIssue(sink, "error", "session.discovery.version.invalid", "session discovery version must be an integer", "payload.version");
      }
      break;
    case "session.attached":
      if (!isNonEmptyString(payload.clientId)) {
        addIssue(sink, "error", "session.attached.client_id.invalid", "attached clientId must be non-empty", "payload.clientId");
      }
      if (!CLIENT_KINDS.has(payload.clientKind as ClientKind)) {
        addIssue(sink, "error", "session.attached.client_kind.invalid", "attached clientKind is not canonical", "payload.clientKind");
      }
      break;
    case "session.detached":
      if (payload.clientId !== undefined && !isNonEmptyString(payload.clientId)) {
        addIssue(sink, "error", "session.detached.client_id.invalid", "detached clientId must be non-empty", "payload.clientId");
      }
      break;
    case "session.closed":
      if (payload.clientId !== undefined && !isNonEmptyString(payload.clientId)) {
        addIssue(sink, "error", "session.closed.client_id.invalid", "closed clientId must be non-empty", "payload.clientId");
      }
      break;
    case "session.state.changed":
      if (!SESSION_RUNTIME_STATES.has(payload.state as SessionRuntimeState)) {
        addIssue(sink, "error", "session.state.invalid", "session state is not canonical", "payload.state");
      }
      break;
    case "session.exited":
      if (!isOptionalInteger(payload.exitCode)) {
        addIssue(sink, "error", "session.exit_code.invalid", "session exitCode must be an integer", "payload.exitCode");
      }
      if (!isOptionalString(payload.signal)) {
        addIssue(sink, "error", "session.signal.invalid", "session signal must be a string", "payload.signal");
      }
      break;
    case "session.failed":
      if (!isNonEmptyString(payload.error)) {
        addIssue(sink, "error", "session.failed.error.invalid", "session failure error must be non-empty", "payload.error");
      }
      break;
    case "control.claimed":
      if (!isNonEmptyString(payload.clientId)) {
        addIssue(sink, "error", "control.claimed.client_id.invalid", "control claimed clientId must be non-empty", "payload.clientId");
      }
      if (!CLIENT_KINDS.has(payload.clientKind as ClientKind)) {
        addIssue(sink, "error", "control.claimed.client_kind.invalid", "control claimed clientKind is not canonical", "payload.clientKind");
      }
      break;
    case "control.released":
      if (payload.clientId !== undefined && !isNonEmptyString(payload.clientId)) {
        addIssue(sink, "error", "control.released.client_id.invalid", "control released clientId must be non-empty", "payload.clientId");
      }
      break;
  }
}

export function validateRahEvent(
  event: RahEvent,
  options: RahEventConformanceOptions = {},
): RahConformanceIssue[] {
  const issues: RahConformanceIssue[] = [];
  const sink: IssueSink = { event, issues };

  if (!isRecord(event)) {
    addIssue({ issues }, "error", "event.invalid", "event must be an object");
    return issues;
  }
  if (!isNonEmptyString(event.id)) {
    addIssue(sink, "error", "event.id.invalid", "event id must be non-empty", "id");
  }
  if (!Number.isInteger(event.seq) || event.seq < 1) {
    addIssue(sink, "error", "event.seq.invalid", "event seq must be a positive integer", "seq");
  }
  if (!isNonEmptyString(event.ts) || Number.isNaN(Date.parse(event.ts))) {
    addIssue(sink, "error", "event.ts.invalid", "event ts must be an ISO-compatible timestamp", "ts");
  }
  if (!isNonEmptyString(event.sessionId)) {
    addIssue(sink, "error", "event.session.invalid", "event sessionId must be non-empty", "sessionId");
  }
  if (!(event.type in RAH_EVENT_TYPE_FAMILY)) {
    addIssue(sink, "error", "event.type.invalid", "event type is not canonical", "type");
  }
  validateEventSource(event.source as EventSource, sink, "source");
  if (options.requireRawForHeuristic && event.source?.authority === "heuristic" && event.raw === undefined) {
    addIssue(sink, "warning", "raw.missing", "heuristic events should retain raw provider evidence", "raw");
  }
  if (event.source?.channel === "pty" && !event.type.startsWith("terminal.")) {
    addIssue(sink, "warning", "pty.semantic_event", "pty channel should only carry terminal infrastructure events", "source.channel");
  }
  validatePayload(event, sink);

  if (
    (event.type === "observation.started" ||
      event.type === "observation.updated" ||
      event.type === "observation.completed" ||
      event.type === "observation.failed") &&
    isRecord(event.payload.observation) &&
    event.payload.observation.kind === "runtime.invalid_stream"
  ) {
    if (event.source?.authority !== "heuristic") {
      addIssue(
        sink,
        "error",
        "invalid_stream.authority.invalid",
        "runtime.invalid_stream observations must be heuristic",
        "source.authority",
      );
    }
    if (event.raw === undefined) {
      addIssue(
        sink,
        "error",
        "invalid_stream.raw.missing",
        "runtime.invalid_stream observations must retain raw provider evidence",
        "raw",
      );
    }
  }

  if (
    options.requireTurnScopedWork &&
    [
      "timeline.item.added",
      "timeline.item.updated",
      "message.part.added",
      "message.part.updated",
      "message.part.delta",
      "message.part.removed",
      "tool.call.started",
      "tool.call.delta",
      "tool.call.completed",
      "tool.call.failed",
      "observation.started",
      "observation.updated",
      "observation.completed",
      "observation.failed",
      "permission.requested",
      "permission.resolved",
    ].includes(event.type) &&
    !isNonEmptyString(event.turnId)
  ) {
    addIssue(sink, "warning", "turn.scope.missing", "live workbench events should carry turnId", "turnId");
  }

  return issues;
}

export function validateRahEventSequence(
  events: readonly RahEvent[],
  options: RahEventConformanceOptions = {},
): RahConformanceReport {
  const allIssues: RahConformanceIssue[] = [];
  const strictSequence = options.strictSequence ?? true;
  let previousSeq = 0;
  const openTools = new Set<string>();
  const openObservations = new Set<string>();
  const openPermissions = new Set<string>();
  const openTurns = new Set<string>();
  const toolTurnById = new Map<string, string | undefined>();
  const observationTurnById = new Map<string, string | undefined>();
  const permissionTurnById = new Map<string, string | undefined>();

  for (const event of events) {
    allIssues.push(...validateRahEvent(event, options));
    const sink: IssueSink = { event, issues: allIssues };

    if (strictSequence && Number.isInteger(event.seq) && event.seq <= previousSeq) {
      addIssue(sink, "error", "sequence.not_increasing", "event seq must strictly increase in a canonical stream", "seq");
    }
    if (Number.isInteger(event.seq)) {
      previousSeq = event.seq;
    }

    if (
      options.requireTurnScopedWork &&
      isNonEmptyString(event.turnId) &&
      [
        "timeline.item.added",
        "timeline.item.updated",
        "message.part.added",
        "message.part.updated",
        "message.part.delta",
        "message.part.removed",
        "tool.call.started",
        "tool.call.delta",
        "tool.call.completed",
        "tool.call.failed",
        "observation.started",
        "observation.updated",
        "observation.completed",
        "observation.failed",
        "permission.requested",
        "permission.resolved",
      ].includes(event.type) &&
      !openTurns.has(event.turnId)
    ) {
      addIssue(
        sink,
        "warning",
        "turn.scope.orphan",
        "workbench event references a turn that is not currently open",
        "turnId",
      );
    }

    if (event.type === "turn.started" && event.turnId) {
      if (openTurns.has(event.turnId)) {
        addIssue(sink, "error", "turn.duplicate", "turn already started", "turnId");
      }
      openTurns.add(event.turnId);
    }
    if (
      (event.type === "turn.completed" ||
        event.type === "turn.failed" ||
        event.type === "turn.canceled") &&
      event.turnId
    ) {
      if (!openTurns.has(event.turnId)) {
        addIssue(sink, "warning", "turn.orphan_terminal", "turn terminal event has no observed start", "turnId");
      }
      openTurns.delete(event.turnId);
    }

    if (event.type === "tool.call.started") {
      const id = event.payload.toolCall.id;
      if (openTools.has(id)) {
        addIssue(sink, "error", "tool.duplicate", "tool call already started", "payload.toolCall.id");
      }
      openTools.add(id);
      toolTurnById.set(id, event.turnId);
    }
    if (event.type === "tool.call.completed" || event.type === "tool.call.failed") {
      const id =
        event.type === "tool.call.completed"
          ? event.payload.toolCall.id
          : event.payload.toolCallId;
      if (!openTools.has(id)) {
        addIssue(sink, "warning", "tool.orphan_terminal", "tool terminal event has no observed start", "payload");
      }
      const startedTurnId = toolTurnById.get(id);
      if (
        isNonEmptyString(startedTurnId) &&
        isNonEmptyString(event.turnId) &&
        startedTurnId !== event.turnId
      ) {
        addIssue(
          sink,
          "error",
          "tool.turn_id.mismatch",
          "tool terminal event turnId must match the observed start turnId",
          "turnId",
        );
      }
      openTools.delete(id);
      toolTurnById.delete(id);
    }

    if (event.type === "observation.started") {
      const id = event.payload.observation.id;
      if (openObservations.has(id)) {
        addIssue(sink, "error", "observation.duplicate", "observation already started", "payload.observation.id");
      }
      openObservations.add(id);
      observationTurnById.set(id, event.turnId);
    }
    if (event.type === "observation.completed" || event.type === "observation.failed") {
      const id = event.payload.observation.id;
      if (!openObservations.has(id)) {
        addIssue(sink, "warning", "observation.orphan_terminal", "observation terminal event has no observed start", "payload.observation.id");
      }
      const startedTurnId = observationTurnById.get(id);
      if (
        isNonEmptyString(startedTurnId) &&
        isNonEmptyString(event.turnId) &&
        startedTurnId !== event.turnId
      ) {
        addIssue(
          sink,
          "error",
          "observation.turn_id.mismatch",
          "observation terminal event turnId must match the observed start turnId",
          "turnId",
        );
      }
      openObservations.delete(id);
      observationTurnById.delete(id);
    }

    if (event.type === "permission.requested") {
      const id = event.payload.request.id;
      if (openPermissions.has(id)) {
        addIssue(sink, "error", "permission.duplicate", "permission request already exists", "payload.request.id");
      }
      openPermissions.add(id);
      permissionTurnById.set(id, event.turnId);
    }
    if (event.type === "permission.resolved") {
      const id = event.payload.resolution.requestId;
      if (!openPermissions.has(id)) {
        addIssue(sink, "warning", "permission.orphan_resolution", "permission resolution has no observed request", "payload.resolution.requestId");
      }
      const startedTurnId = permissionTurnById.get(id);
      if (
        isNonEmptyString(startedTurnId) &&
        isNonEmptyString(event.turnId) &&
        startedTurnId !== event.turnId
      ) {
        addIssue(
          sink,
          "error",
          "permission.turn_id.mismatch",
          "permission resolution turnId must match the observed request turnId",
          "turnId",
        );
      }
      openPermissions.delete(id);
      permissionTurnById.delete(id);
    }
  }

  const errors = allIssues.filter((issue) => issue.severity === "error");
  const warnings = allIssues.filter((issue) => issue.severity === "warning");
  return {
    ok: errors.length === 0,
    errors,
    warnings,
  };
}

export function formatRahConformanceReport(report: RahConformanceReport): string {
  return [...report.errors, ...report.warnings]
    .map((issue) => {
      const location = [
        issue.eventSeq !== undefined ? `seq ${issue.eventSeq}` : undefined,
        issue.eventType,
        issue.path,
      ].filter(Boolean).join(" ");
      return `${issue.severity.toUpperCase()} ${issue.code}${location ? ` (${location})` : ""}: ${issue.message}`;
    })
    .join("\n");
}

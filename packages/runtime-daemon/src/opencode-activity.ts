import { randomUUID } from "node:crypto";
import type {
  ContextUsage,
  JsonObject,
  PermissionAction,
  ProviderKind,
  ToolCall,
  ToolFamily,
} from "@rah/runtime-protocol";
import type { ProviderActivity } from "./provider-activity";
import type {
  OpenCodeEvent,
  OpenCodeMessageInfo,
  OpenCodeMessageWithParts,
  OpenCodePart,
} from "./opencode-api";

type OpenCodeMessageRole = "user" | "assistant";

interface OpenCodeActivityStateOptions {
  /**
   * Terminal-owned sessions need provider user messages to open turns. Web-owned
   * sessions already open turns before calling OpenCode, so late user events must
   * not resurrect a completed turn.
   */
  userMessagesStartTurns?: boolean;
  emitUserMessages?: boolean;
}

export interface OpenCodeActivityState {
  readonly provider: Extract<ProviderKind, "opencode">;
  readonly providerSessionId: string;
  readonly userMessagesStartTurns: boolean;
  readonly emitUserMessages: boolean;
  currentTurnId?: string;
  readonly turnByMessageId: Map<string, string>;
  readonly roleByMessageId: Map<string, OpenCodeMessageRole>;
  readonly partTypeByPartId: Map<string, string>;
  readonly startedToolCallIds: Set<string>;
  readonly completedToolCallIds: Set<string>;
  readonly pendingPermissions: Map<string, string | undefined>;
}

export function createOpenCodeActivityState(
  providerSessionId: string,
  options: OpenCodeActivityStateOptions = {},
): OpenCodeActivityState {
  return {
    provider: "opencode",
    providerSessionId,
    userMessagesStartTurns: options.userMessagesStartTurns ?? true,
    emitUserMessages: options.emitUserMessages ?? true,
    turnByMessageId: new Map(),
    roleByMessageId: new Map(),
    partTypeByPartId: new Map(),
    startedToolCallIds: new Set(),
    completedToolCallIds: new Set(),
    pendingPermissions: new Map(),
  };
}

export function startOpenCodeTurn(
  state: OpenCodeActivityState,
  turnId = randomUUID(),
): ProviderActivity[] {
  state.currentTurnId = turnId;
  return [{ type: "turn_started", turnId }, { type: "runtime_status", status: "thinking", turnId }];
}

export function completeOpenCodeTurn(state: OpenCodeActivityState): ProviderActivity[] {
  const turnId = state.currentTurnId;
  if (!turnId) {
    return [];
  }
  delete state.currentTurnId;
  return [{ type: "runtime_status", status: "finished", turnId }, { type: "turn_completed", turnId }];
}

export function translateOpenCodeHistory(messages: readonly OpenCodeMessageWithParts[]): ProviderActivity[] {
  const state = createOpenCodeActivityState(messages[0]?.info.sessionID ?? "history");
  const activities: ProviderActivity[] = [];
  for (const message of messages) {
    activities.push(...translateOpenCodeMessage(state, message));
  }
  if (state.currentTurnId) {
    activities.push(...completeOpenCodeTurn(state));
  }
  return activities;
}

export function translateOpenCodeMessage(
  state: OpenCodeActivityState,
  message: OpenCodeMessageWithParts,
): ProviderActivity[] {
  const activities: ProviderActivity[] = [];
  activities.push(...rememberMessageInfo(state, message.info));
  for (const part of message.parts) {
    activities.push(...translateOpenCodePart(state, part));
  }
  if (isTerminalAssistantMessage(message.info)) {
    activities.push(...completeOpenCodeTurn(state));
  }
  return activities;
}

export function translateOpenCodeEvent(
  state: OpenCodeActivityState,
  event: OpenCodeEvent,
): ProviderActivity[] {
  switch (event.type) {
    case "server.connected":
    case "server.heartbeat":
      return [];
    case "session.status":
      return translateStatus(state, event.properties);
    case "session.error":
      return translateError(state, event.properties);
    case "message.updated":
      return translateMessageUpdated(state, event.properties);
    case "message.part.updated":
      return translatePartUpdated(state, event.properties);
    case "message.part.delta":
      return translatePartDelta(state, event.properties);
    case "message.part.removed":
      return translatePartRemoved(state, event.properties);
    case "permission.asked":
      return translatePermissionAsked(state, event.properties);
    case "permission.replied":
      return translatePermissionReplied(state, event.properties);
    default:
      return [];
  }
}

function translateStatus(
  state: OpenCodeActivityState,
  properties: Record<string, unknown> | undefined,
): ProviderActivity[] {
  if (properties?.sessionID !== state.providerSessionId) {
    return [];
  }
  const status = readRecord(properties.status);
  const type = typeof status?.type === "string" ? status.type : undefined;
  if (type === "busy") {
    if (state.currentTurnId) {
      return [{ type: "runtime_status", status: "thinking", turnId: state.currentTurnId }];
    }
    return startOpenCodeTurn(state);
  }
  if (type === "idle") {
    return completeOpenCodeTurn(state);
  }
  if (type === "retry") {
    return [
      {
        type: "runtime_status",
        status: "retrying",
        ...(typeof status?.attempt === "number" ? { retryCount: status.attempt } : {}),
        ...(typeof status?.message === "string" ? { detail: status.message } : {}),
        ...(state.currentTurnId ? { turnId: state.currentTurnId } : {}),
      },
      {
        type: "timeline_item",
        item: {
          kind: "retry",
          attempt: typeof status?.attempt === "number" ? status.attempt : 1,
          ...(typeof status?.message === "string" ? { error: status.message } : {}),
        },
        ...(state.currentTurnId ? { turnId: state.currentTurnId } : {}),
      },
    ];
  }
  return [];
}

function translateError(
  state: OpenCodeActivityState,
  properties: Record<string, unknown> | undefined,
): ProviderActivity[] {
  if (properties?.sessionID !== state.providerSessionId) {
    return [];
  }
  const error = readRecord(properties.error);
  const message =
    typeof error?.message === "string"
      ? error.message
      : typeof properties.error === "string"
        ? properties.error
        : "OpenCode session error";
  const turnId = state.currentTurnId ?? randomUUID();
  delete state.currentTurnId;
  return [{ type: "turn_failed", turnId, error: message }];
}

function translateMessageUpdated(
  state: OpenCodeActivityState,
  properties: Record<string, unknown> | undefined,
): ProviderActivity[] {
  const info = readRecord(properties?.info) as OpenCodeMessageInfo | undefined;
  if (!info || info.sessionID !== state.providerSessionId) {
    return [];
  }
  const activities = rememberMessageInfo(state, info);
  if (isTerminalAssistantMessage(info)) {
    activities.push(...completeOpenCodeTurn(state));
  }
  return activities;
}

function rememberMessageInfo(
  state: OpenCodeActivityState,
  info: OpenCodeMessageInfo,
): ProviderActivity[] {
  if (info.sessionID !== state.providerSessionId) {
    return [];
  }
  state.roleByMessageId.set(info.id, info.role);
  if (info.role === "user") {
    const existingTurnId = state.currentTurnId;
    if (!existingTurnId && !state.userMessagesStartTurns) {
      return [];
    }
    const turnId = existingTurnId ?? `opencode:${info.id}`;
    const started = existingTurnId ? [] : [{ type: "turn_started" as const, turnId }];
    state.currentTurnId = turnId;
    state.turnByMessageId.set(info.id, turnId);
    return started;
  }
  const parentTurnId = info.parentID ? state.turnByMessageId.get(info.parentID) : undefined;
  const turnId = parentTurnId ?? state.currentTurnId ?? `opencode:${info.id}`;
  state.currentTurnId = turnId;
  state.turnByMessageId.set(info.id, turnId);
  return [];
}

export function isTerminalAssistantMessage(info: OpenCodeMessageInfo): boolean {
  return (
    info.role === "assistant" &&
    info.finish !== "tool-calls" &&
    (info.time?.completed !== undefined || info.finish !== undefined)
  );
}

function translatePartUpdated(
  state: OpenCodeActivityState,
  properties: Record<string, unknown> | undefined,
): ProviderActivity[] {
  const part = readRecord(properties?.part) as OpenCodePart | undefined;
  if (!part || part.sessionID !== state.providerSessionId) {
    return [];
  }
  return translateOpenCodePart(state, part);
}

function translateOpenCodePart(
  state: OpenCodeActivityState,
  part: OpenCodePart,
): ProviderActivity[] {
  rememberPartInfo(state, part);
  const role = state.roleByMessageId.get(part.messageID);
  const turnId = state.turnByMessageId.get(part.messageID) ?? state.currentTurnId;
  switch (part.type) {
    case "text": {
      const text = readStringProperty(part, "text");
      if (!text || readBooleanProperty(part, "synthetic") || readBooleanProperty(part, "ignored")) {
        return [];
      }
      if (role === "user") {
        if (!state.emitUserMessages) {
          return [];
        }
        return [
          {
            type: "timeline_item",
            item: { kind: "user_message", text, messageId: part.messageID },
            ...(turnId ? { turnId } : {}),
          },
        ];
      }
      return [
        {
          type: "timeline_item",
          item: { kind: "assistant_message", text, messageId: part.messageID },
          ...(turnId ? { turnId } : {}),
        },
      ];
    }
    case "reasoning": {
      const text = readStringProperty(part, "text");
      return text
        ? [
            {
              type: "timeline_item",
              item: { kind: "reasoning", text },
              ...(turnId ? { turnId } : {}),
            },
          ]
        : [];
    }
    case "tool":
      return translateToolPart(state, part, turnId);
    case "file":
      return [
        {
          type: "message_part_added",
          part: {
            messageId: part.messageID,
            partId: part.id,
            kind: "file",
            metadata: jsonObject({
              ...(readStringProperty(part, "filename") ? { filename: readStringProperty(part, "filename") } : {}),
              ...(readStringProperty(part, "mime") ? { mime: readStringProperty(part, "mime") } : {}),
              ...(readStringProperty(part, "url") ? { url: readStringProperty(part, "url") } : {}),
            }),
          },
          ...(turnId ? { turnId } : {}),
        },
      ];
    case "step-start":
      return [
        {
          type: "turn_step_started",
          turnId: turnId ?? state.currentTurnId ?? randomUUID(),
        },
      ];
    case "step-finish": {
      const stepTurnId = turnId ?? state.currentTurnId ?? randomUUID();
      const activities: ProviderActivity[] = [
        {
          type: "turn_step_completed",
          turnId: stepTurnId,
        },
      ];
      const reason = readStringProperty(part, "reason");
      if (role !== "user" && reason !== "tool-calls") {
        activities.push(...completeOpenCodeTurn(state));
      }
      return activities;
    }
    default:
      return [];
  }
}

function translatePartDelta(
  state: OpenCodeActivityState,
  properties: Record<string, unknown> | undefined,
): ProviderActivity[] {
  if (properties?.sessionID !== state.providerSessionId) {
    return [];
  }
  const messageID = typeof properties.messageID === "string" ? properties.messageID : undefined;
  const partID = typeof properties.partID === "string" ? properties.partID : undefined;
  const field = typeof properties.field === "string" ? properties.field : undefined;
  const delta = typeof properties.delta === "string" ? properties.delta : undefined;
  if (!messageID || !partID || field !== "text" || !delta) {
    return [];
  }
  const role = state.roleByMessageId.get(messageID);
  const turnId = state.turnByMessageId.get(messageID) ?? state.currentTurnId;
  if (role === "user") {
    return [];
  }
  const partType = state.partTypeByPartId.get(partID);
  if (partType === "reasoning") {
    return [
      {
        type: "timeline_item",
        item: { kind: "reasoning", text: delta },
        ...(turnId ? { turnId } : {}),
      },
    ];
  }
  if (partType !== "text") {
    return [];
  }
  return [
    {
      type: "timeline_item",
      item: { kind: "assistant_message", text: delta, messageId: messageID },
      ...(turnId ? { turnId } : {}),
    },
  ];
}

function translatePartRemoved(
  state: OpenCodeActivityState,
  properties: Record<string, unknown> | undefined,
): ProviderActivity[] {
  if (properties?.sessionID !== state.providerSessionId) {
    return [];
  }
  const messageID = typeof properties.messageID === "string" ? properties.messageID : undefined;
  const partID = typeof properties.partID === "string" ? properties.partID : undefined;
  if (!messageID || !partID) {
    return [];
  }
  return [
    {
      type: "message_part_removed",
      messageId: messageID,
      partId: partID,
      ...(state.turnByMessageId.get(messageID) ? { turnId: state.turnByMessageId.get(messageID)! } : {}),
    },
  ];
}

function translatePermissionAsked(
  state: OpenCodeActivityState,
  properties: Record<string, unknown> | undefined,
): ProviderActivity[] {
  if (properties?.sessionID !== state.providerSessionId) {
    return [];
  }
  const id = typeof properties.id === "string" ? properties.id : undefined;
  if (!id) {
    return [];
  }
  const permission = typeof properties.permission === "string" ? properties.permission : "permission";
  const patterns = Array.isArray(properties.patterns)
    ? properties.patterns.filter((item): item is string => typeof item === "string")
    : [];
  const input = jsonObject(readRecord(properties.metadata) ?? {});
  state.pendingPermissions.set(id, state.currentTurnId);
  const actions: PermissionAction[] = [
    { id: "once", label: "Allow once", behavior: "allow", variant: "primary" },
    { id: "always", label: "Always allow", behavior: "allow" },
    { id: "reject", label: "Reject", behavior: "deny", variant: "danger" },
  ];
  const request = {
    id,
    kind: "tool" as const,
    title: permission,
    input,
    actions,
    ...(patterns.length > 0 ? { description: patterns.join(", ") } : {}),
  };
  return [
    {
      type: "permission_requested",
      request,
      ...(state.currentTurnId ? { turnId: state.currentTurnId } : {}),
    },
  ];
}

function translatePermissionReplied(
  state: OpenCodeActivityState,
  properties: Record<string, unknown> | undefined,
): ProviderActivity[] {
  if (properties?.sessionID !== state.providerSessionId) {
    return [];
  }
  const requestId = typeof properties.requestID === "string" ? properties.requestID : undefined;
  if (!requestId) {
    return [];
  }
  const reply = typeof properties.reply === "string" ? properties.reply : "reject";
  const turnId = state.pendingPermissions.get(requestId) ?? state.currentTurnId;
  state.pendingPermissions.delete(requestId);
  return [
    {
      type: "permission_resolved",
      resolution: {
        requestId,
        behavior: reply === "reject" ? "deny" : "allow",
        selectedActionId: reply,
        decision: reply,
      },
      ...(turnId ? { turnId } : {}),
    },
  ];
}

function translateToolPart(
  activityState: OpenCodeActivityState,
  part: OpenCodePart,
  turnId: string | undefined,
): ProviderActivity[] {
  const callId = readStringProperty(part, "callID");
  const tool = readStringProperty(part, "tool");
  const state = readRecord(readProperty(part, "state"));
  const status = typeof state?.status === "string" ? state.status : undefined;
  if (!callId || !tool || !state || !status) {
    return [];
  }
  const input = readRecord(state.input);
  const toolCall: ToolCall = {
    id: callId,
    family: classifyOpenCodeToolFamily(tool),
    providerToolName: tool,
    title: toolTitle(tool, state),
    ...(input ? { input } : {}),
  };
  if (status === "pending") {
    return [];
  }
  if (status === "running") {
    if (activityState.completedToolCallIds.has(callId)) {
      return [];
    }
    const detail = toolDetailFromState(state);
    if (activityState.startedToolCallIds.has(callId)) {
      return detail
        ? [{ type: "tool_call_delta", toolCallId: callId, detail, ...(turnId ? { turnId } : {}) }]
        : [];
    }
    activityState.startedToolCallIds.add(callId);
    return [
      {
        type: "tool_call_started",
        toolCall,
        ...(turnId ? { turnId } : {}),
      },
    ];
  }
  if (status === "completed") {
    if (activityState.completedToolCallIds.has(callId)) {
      return [];
    }
    activityState.startedToolCallIds.delete(callId);
    activityState.completedToolCallIds.add(callId);
    const output = typeof state.output === "string" ? state.output : undefined;
    const metadata = readRecord(state.metadata);
    return [
      {
        type: "tool_call_completed",
        toolCall: {
          ...toolCall,
          result: jsonObject({
            ...(output ? { output } : {}),
            ...(metadata ? { metadata } : {}),
          }),
          detail: {
            artifacts: output
              ? [{ kind: "text", label: toolCall.title ?? tool, text: output }]
              : [],
          },
        },
        ...(turnId ? { turnId } : {}),
      },
    ];
  }
  return [
    {
      type: "tool_call_failed",
      toolCallId: callId,
      error: typeof state.error === "string" ? state.error : "OpenCode tool failed",
      ...(turnId ? { turnId } : {}),
    },
  ];
}

function toolTitle(tool: string, state: Record<string, unknown>): string {
  if (typeof state.title === "string" && state.title) {
    return state.title;
  }
  return tool;
}

function rememberPartInfo(state: OpenCodeActivityState, part: OpenCodePart): void {
  state.partTypeByPartId.set(part.id, part.type);
}

function toolDetailFromState(state: Record<string, unknown>) {
  const output = readToolOutput(state);
  return output
    ? {
        artifacts: [{ kind: "text" as const, label: "Output", text: output }],
      }
    : undefined;
}

function readToolOutput(state: Record<string, unknown>): string | undefined {
  if (typeof state.output === "string" && state.output) {
    return state.output;
  }
  const metadata = readRecord(state.metadata);
  return typeof metadata?.output === "string" && metadata.output ? metadata.output : undefined;
}

function classifyOpenCodeToolFamily(name: string): ToolFamily {
  const normalized = name.toLowerCase();
  if (normalized.includes("bash") || normalized.includes("shell")) return "shell";
  if (normalized.includes("edit")) return "file_edit";
  if (normalized.includes("write")) return "file_write";
  if (normalized.includes("read")) return "file_read";
  if (normalized.includes("grep") || normalized.includes("glob") || normalized.includes("search")) return "search";
  if (normalized.includes("fetch")) return "web_fetch";
  if (normalized.includes("todo")) return "todo";
  if (normalized.includes("task")) return "subagent";
  return "other";
}

export function openCodeUsageFromMessage(info: OpenCodeMessageInfo): ContextUsage | undefined {
  const tokens = info.tokens;
  if (!tokens && typeof info.cost !== "number") {
    return undefined;
  }
  return {
    ...(tokens?.input !== undefined ? { inputTokens: tokens.input } : {}),
    ...(tokens?.output !== undefined ? { outputTokens: tokens.output } : {}),
    ...(tokens?.reasoning !== undefined ? { reasoningOutputTokens: tokens.reasoning } : {}),
    ...(tokens?.cache?.read !== undefined ? { cachedInputTokens: tokens.cache.read } : {}),
    ...(typeof info.cost === "number" ? { totalCostUsd: info.cost } : {}),
  };
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

function readProperty(value: object, key: string): unknown {
  return (value as Record<string, unknown>)[key];
}

function readStringProperty(value: object, key: string): string | undefined {
  const property = readProperty(value, key);
  return typeof property === "string" ? property : undefined;
}

function readBooleanProperty(value: object, key: string): boolean {
  return readProperty(value, key) === true;
}

function jsonObject(value: Record<string, unknown>): JsonObject {
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, JsonObject[string]] => isJsonValue(entry[1])),
  );
}

function isJsonValue(value: unknown): value is JsonObject[string] {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return true;
  }
  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }
  if (value && typeof value === "object") {
    return Object.values(value).every(isJsonValue);
  }
  return false;
}

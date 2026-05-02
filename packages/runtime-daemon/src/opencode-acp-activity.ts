import type { ContextUsage, JsonObject, TimelineIdentity, ToolCall, ToolFamily } from "@rah/runtime-protocol";
import type { ProviderActivity } from "./provider-activity";
import type { OpenCodeAcpSessionUpdate } from "./opencode-acp-client";
import { createOpenCodeTimelineIdentity } from "./opencode-timeline-identity";

export interface OpenCodeAcpActivityState {
  readonly providerSessionId: string;
  currentTurnId?: string;
  readonly startedToolCallIds: Set<string>;
  readonly completedToolCallIds: Set<string>;
}

export function createOpenCodeAcpActivityState(providerSessionId: string): OpenCodeAcpActivityState {
  return {
    providerSessionId,
    startedToolCallIds: new Set(),
    completedToolCallIds: new Set(),
  };
}

export function translateOpenCodeAcpSessionUpdate(
  state: OpenCodeAcpActivityState,
  params: OpenCodeAcpSessionUpdate,
): ProviderActivity[] {
  if (params.sessionId !== state.providerSessionId) {
    return [];
  }
  const update = params.update;
  switch (update.sessionUpdate) {
    case "agent_message_chunk":
      return translateAgentMessageChunk(state, update);
    case "agent_thought_chunk":
      return [];
    case "tool_call":
    case "tool_call_update":
      return translateToolCallUpdate(state, update);
    case "usage_update":
      return translateUsageUpdate(state, update);
    case "available_commands_update":
      return [];
    default:
      return [];
  }
}

function translateAgentMessageChunk(
  state: OpenCodeAcpActivityState,
  update: Record<string, unknown>,
): ProviderActivity[] {
  const content = asRecord(update.content);
  const text = typeof content?.text === "string" ? content.text : undefined;
  if (!text) {
    return [];
  }
  const messageId = typeof update.messageId === "string" ? update.messageId : undefined;
  return [
    {
      type: "timeline_item",
      item: {
        kind: "assistant_message",
        text,
        ...(messageId ? { messageId } : {}),
      },
      ...timelineIdentityProps(
        messageId
          ? createOpenCodeTimelineIdentity({
              providerSessionId: state.providerSessionId,
              messageId,
              itemKind: "assistant_message",
              origin: "live",
              confidence: "derived",
            })
          : undefined,
      ),
      ...(state.currentTurnId ? { turnId: state.currentTurnId } : {}),
    },
  ];
}

function timelineIdentityProps(identity: TimelineIdentity | undefined): { identity?: TimelineIdentity } {
  return identity !== undefined ? { identity } : {};
}

function translateToolCallUpdate(
  state: OpenCodeAcpActivityState,
  update: Record<string, unknown>,
): ProviderActivity[] {
  const toolCallId = typeof update.toolCallId === "string" ? update.toolCallId : undefined;
  if (!toolCallId) {
    return [];
  }
  const status = typeof update.status === "string" ? update.status : undefined;
  const toolCall = buildToolCall(toolCallId, update);
  const turnId = state.currentTurnId;
  if (!status || status === "pending") {
    return [];
  }
  if (status === "in_progress") {
    if (state.completedToolCallIds.has(toolCallId)) {
      return [];
    }
    if (state.startedToolCallIds.has(toolCallId)) {
      const detail = detailFromUpdate(update, toolCall.title ?? toolCall.providerToolName);
      return detail
        ? [{ type: "tool_call_delta", toolCallId, detail, ...(turnId ? { turnId } : {}) }]
        : [];
    }
    state.startedToolCallIds.add(toolCallId);
    return [{ type: "tool_call_started", toolCall, ...(turnId ? { turnId } : {}) }];
  }
  if (status === "completed") {
    if (state.completedToolCallIds.has(toolCallId)) {
      return [];
    }
    state.startedToolCallIds.delete(toolCallId);
    state.completedToolCallIds.add(toolCallId);
    return [
      {
        type: "tool_call_completed",
        toolCall: {
          ...toolCall,
          ...resultFromUpdate(update, toolCall.title ?? toolCall.providerToolName),
        },
        ...(turnId ? { turnId } : {}),
      },
    ];
  }
  return [
    {
      type: "tool_call_failed",
      toolCallId,
      error: typeof update.error === "string" ? update.error : "OpenCode tool failed",
      ...(turnId ? { turnId } : {}),
    },
  ];
}

function translateUsageUpdate(
  state: OpenCodeAcpActivityState,
  update: Record<string, unknown>,
): ProviderActivity[] {
  const used = typeof update.used === "number" ? update.used : undefined;
  const size = typeof update.size === "number" ? update.size : undefined;
  if (used === undefined || size === undefined) {
    return [];
  }
  const usage: ContextUsage = {
    usedTokens: used,
    contextWindow: size,
    percentRemaining: size > 0 ? Math.max(0, Math.min(100, ((size - used) / size) * 100)) : 100,
    basis: "context_window",
    precision: "exact",
    source: "opencode.acp.usage_update",
  };
  return [{ type: "usage", usage, ...(state.currentTurnId ? { turnId: state.currentTurnId } : {}) }];
}

function buildToolCall(id: string, update: Record<string, unknown>): ToolCall {
  const title = typeof update.title === "string" && update.title ? update.title : "tool";
  const rawInput = asRecord(update.rawInput);
  return {
    id,
    family: familyForKind(typeof update.kind === "string" ? update.kind : title),
    providerToolName: title,
    title,
    ...(rawInput ? { input: rawInput } : {}),
  };
}

function familyForKind(kind: string): ToolFamily {
  const normalized = kind.toLowerCase();
  if (normalized.includes("execute") || normalized.includes("bash") || normalized.includes("shell")) {
    return "shell";
  }
  if (normalized.includes("read")) {
    return "file_read";
  }
  if (normalized.includes("edit")) {
    return "file_edit";
  }
  if (normalized.includes("write")) {
    return "file_write";
  }
  return "other";
}

function resultFromUpdate(
  update: Record<string, unknown>,
  label: string,
): Pick<ToolCall, "result" | "detail"> {
  const rawOutput = asRecord(update.rawOutput);
  const output =
    typeof rawOutput?.output === "string"
      ? rawOutput.output
      : firstTextContent(update.content);
  const metadata = asRecord(rawOutput?.metadata);
  return {
    result: jsonObject({
      ...(output ? { output } : {}),
      ...(metadata ? { metadata } : {}),
    }),
    detail: {
      artifacts: output ? [{ kind: "text", label, text: output }] : [],
    },
  };
}

function detailFromUpdate(update: Record<string, unknown>, label: string): ToolCall["detail"] | undefined {
  const output = firstTextContent(update.content);
  return output
    ? {
        artifacts: [{ kind: "text", label, text: output }],
      }
    : undefined;
}

function firstTextContent(value: unknown): string | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  for (const item of value) {
    const record = asRecord(item);
    const content = asRecord(record?.content);
    if (typeof content?.text === "string" && content.text) {
      return content.text;
    }
  }
  return undefined;
}

function jsonObject(value: Record<string, unknown>): JsonObject {
  return JSON.parse(JSON.stringify(value)) as JsonObject;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

import type { ProviderKind } from "@rah/runtime-protocol";
import type { ProviderActivity } from "../provider-activity";

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

export type NormalizedCouncilMcpToolCall = {
  provider: ProviderKind;
  callId: string;
  toolName: CouncilMcpToolName;
  status: "started" | "completed" | "failed";
  providerSessionId?: string;
  args?: Record<string, unknown>;
  output?: unknown;
};

export type CouncilMcpProjection =
  | { visibility: "hidden"; reason: "control" | "polling" | "state" | "empty" | "failed" }
  | { visibility: "chat"; activity: ProviderActivity };

const COUNCIL_MCP_PREFIX = "mcp__rah_council__";
const GEMINI_COUNCIL_MCP_PREFIX = "mcp_rah_council_";
const OPENCODE_COUNCIL_MCP_PREFIX = "rah_council_";

const COUNCIL_MCP_TOOL_NAMES = new Set<CouncilMcpToolName>([
  "channel_join",
  "channel_post",
  "channel_wait_new",
  "channel_history",
  "channel_state",
  "channel_peek_inbox",
  "channel_set_status",
  "channel_claim_file",
  "channel_release_file",
  "channel_list_claims",
  "channel_send_control",
  "channel_peek_control",
]);

const POLLING_TOOL_NAMES = new Set<CouncilMcpToolName>([
  "channel_wait_new",
  "channel_peek_control",
]);

const STATE_TOOL_NAMES = new Set<CouncilMcpToolName>([
  "channel_set_status",
  "channel_claim_file",
  "channel_release_file",
  "channel_list_claims",
]);

function isCouncilMcpToolName(value: string): value is CouncilMcpToolName {
  return COUNCIL_MCP_TOOL_NAMES.has(value as CouncilMcpToolName);
}

export function normalizeCouncilMcpToolName(name: string): CouncilMcpToolName | null {
  if (isCouncilMcpToolName(name)) {
    return name;
  }
  if (!name.startsWith(COUNCIL_MCP_PREFIX)) {
    if (name.startsWith(GEMINI_COUNCIL_MCP_PREFIX)) {
      const unprefixed = name.slice(GEMINI_COUNCIL_MCP_PREFIX.length);
      return isCouncilMcpToolName(unprefixed) ? unprefixed : null;
    }
    if (!name.startsWith(OPENCODE_COUNCIL_MCP_PREFIX)) {
      return null;
    }
    const unprefixed = name.slice(OPENCODE_COUNCIL_MCP_PREFIX.length);
    return isCouncilMcpToolName(unprefixed) ? unprefixed : null;
  }
  const unprefixed = name.slice(COUNCIL_MCP_PREFIX.length);
  return isCouncilMcpToolName(unprefixed) ? unprefixed : null;
}

export function normalizeCouncilMcpToolCall(args: {
  provider: ProviderKind;
  callId: string;
  toolName: string;
  status: NormalizedCouncilMcpToolCall["status"];
  providerSessionId?: string;
  callArgs?: Record<string, unknown> | null;
  output?: unknown;
}): NormalizedCouncilMcpToolCall | null {
  const toolName = normalizeCouncilMcpToolName(args.toolName);
  if (!toolName) {
    return null;
  }
  const normalized: NormalizedCouncilMcpToolCall = {
    provider: args.provider,
    callId: args.callId,
    toolName,
    status: args.status,
  };
  if (args.providerSessionId !== undefined) {
    normalized.providerSessionId = args.providerSessionId;
  }
  if (args.callArgs !== null && args.callArgs !== undefined) {
    normalized.args = args.callArgs;
  }
  if (args.output !== undefined) {
    normalized.output = args.output;
  }
  return normalized;
}

function parseJsonObject(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "string") {
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  }
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function callOutputSucceeded(output: unknown): boolean {
  const parsed = parseJsonObject(output);
  if (!parsed) {
    return true;
  }
  if (parsed.ok === false) {
    return false;
  }
  if (parsed.error !== undefined) {
    return false;
  }
  return true;
}

function hiddenReason(toolName: CouncilMcpToolName): CouncilMcpProjection {
  if (POLLING_TOOL_NAMES.has(toolName)) {
    return { visibility: "hidden", reason: "polling" };
  }
  if (STATE_TOOL_NAMES.has(toolName)) {
    return { visibility: "hidden", reason: "state" };
  }
  return { visibility: "hidden", reason: "control" };
}

export function projectCouncilMcpToolCall(call: NormalizedCouncilMcpToolCall): CouncilMcpProjection {
  if (call.status === "failed") {
    return { visibility: "hidden", reason: "failed" };
  }
  if (call.toolName !== "channel_post") {
    return hiddenReason(call.toolName);
  }
  if (call.status !== "completed") {
    return { visibility: "hidden", reason: "control" };
  }
  if (!callOutputSucceeded(call.output)) {
    return { visibility: "hidden", reason: "failed" };
  }
  const rawText =
    typeof call.args?.content === "string"
      ? call.args.content
      : typeof call.args?.text === "string"
        ? call.args.text
        : "";
  const text = rawText.trim();
  if (!text) {
    return { visibility: "hidden", reason: "empty" };
  }
  return {
    visibility: "chat",
    activity: {
      type: "timeline_item",
      item: {
        kind: "assistant_message",
        text,
      },
    },
  };
}

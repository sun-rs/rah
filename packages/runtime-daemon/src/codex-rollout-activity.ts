import type {
  EventAuthority,
  EventChannel,
  TimelineIdentity,
  TimelineRuntimeModel,
  TimelineTurnIdentity,
  ToolCall,
  ToolCallArtifact,
  WorkbenchObservation,
} from "@rah/runtime-protocol";
import { classifyCodexCommand } from "./codex-command-classifier";
import {
  createCodexTimelineIdentity,
  createCodexTimelineTurnIdentity,
} from "./codex-timeline-identity";
import {
  normalizeCouncilMcpToolCall,
  projectCouncilMcpToolCall,
  type NormalizedCouncilMcpToolCall,
} from "./council/council-mcp-projection";
import type { ProviderActivity } from "./provider-activity";
import { codexRuntimeModelFromTurnContext } from "./timeline-runtime-model";

export interface CodexTranslatedActivity {
  activity: ProviderActivity;
  ts?: string;
  channel?: EventChannel;
  authority?: EventAuthority;
  raw?: unknown;
}

type PendingToolCall = {
  toolCall: ToolCall;
  observation?: WorkbenchObservation;
  hidden?: boolean;
  councilMcpToolCall?: NormalizedCouncilMcpToolCall;
  terminalInteraction?: PendingTerminalInteraction;
};

const CODEX_INTERRUPTED_PENDING_TOOL_ERROR =
  "Conversation interrupted before this tool completed.";

interface PendingTerminalInteraction {
  sessionId: number;
  chars: string;
}

interface CodexTerminalSessionToolState {
  sessionId: number;
  toolCallId: string;
  toolCall: ToolCall;
  observation?: WorkbenchObservation;
  started: boolean;
}

export interface CodexRolloutTranslationState {
  pendingToolCalls: Map<string, PendingToolCall>;
  terminalSessions: Map<number, CodexTerminalSessionToolState>;
  lastTimelineTextSignature: string | null;
  lastGoalEventSignatureByThread: Map<string, string>;
  providerSessionId?: string | undefined;
  currentTurnId?: string | undefined;
  currentRuntimeModel?: TimelineRuntimeModel | undefined;
  nextTimelineItemIndex: number;
}

export function createCodexRolloutTranslationState(
  options: { providerSessionId?: string | undefined } = {},
): CodexRolloutTranslationState {
  const state: CodexRolloutTranslationState = {
    pendingToolCalls: new Map(),
    terminalSessions: new Map(),
    lastTimelineTextSignature: null,
    lastGoalEventSignatureByThread: new Map(),
    nextTimelineItemIndex: 0,
  };
  if (options.providerSessionId !== undefined) {
    state.providerSessionId = options.providerSessionId;
  }
  return state;
}

function attachRuntimeModelToTimelineActivity(
  activity: ProviderActivity,
  runtimeModel: TimelineRuntimeModel | undefined,
): ProviderActivity {
  if (!runtimeModel || (activity.type !== "timeline_item" && activity.type !== "timeline_item_updated")) {
    return activity;
  }
  if (
    activity.item.kind !== "assistant_message" &&
    activity.item.kind !== "reasoning" &&
    activity.item.kind !== "step"
  ) {
    return activity;
  }
  if (activity.item.runtimeModel !== undefined) {
    return activity;
  }
  return {
    ...activity,
    item: {
      ...activity.item,
      runtimeModel,
    },
  };
}

let invalidRolloutSequence = 0;
const IGNORED_PERSISTED_EVENT_MSG_TYPES = new Set([
  "task_started",
  "task_complete",
  "context_compacted",
  "token_count",
  "user_message",
  "exec_command_begin",
  "exec_command_output_delta",
  "exec_command_end",
  "mcp_tool_call_begin",
  "mcp_tool_call_end",
  "patch_apply_begin",
  "patch_apply_end",
]);

function parseJsonObject(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "string") {
    return null;
  }
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return null;
  }
  return null;
}

function textFromContentItems(
  content: unknown,
  itemType: "input_text" | "output_text",
): string | null {
  if (!Array.isArray(content)) {
    return null;
  }
  const parts = content
    .filter((item) => item && typeof item === "object" && !Array.isArray(item))
    .map((item) => item as Record<string, unknown>)
    .filter((item) => item.type === itemType && typeof item.text === "string")
    .map((item) => item.text as string);
  if (parts.length === 0) {
    return null;
  }
  return parts.join("");
}

function extractSummaryText(summary: unknown): string | null {
  if (!Array.isArray(summary)) {
    return null;
  }
  const text = summary
    .filter((item) => item && typeof item === "object" && !Array.isArray(item))
    .map((item) => item as Record<string, unknown>)
    .filter((item) => item.type === "summary_text" && typeof item.text === "string")
    .map((item) => item.text as string)
    .join("\n")
    .trim();
  return text || null;
}

function extractAgentMessageText(message: unknown): string | null {
  if (typeof message === "string") {
    const trimmed = message.trim();
    return trimmed || null;
  }
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return null;
  }
  const record = message as Record<string, unknown>;
  const text =
    (typeof record.message === "string" ? record.message : null) ??
    (typeof record.text === "string" ? record.text : null);
  if (!text) {
    return null;
  }
  const trimmed = text.trim();
  return trimmed || null;
}

function extractCodexGoalObjective(text: string): string | null {
  if (!text.includes("Continue working toward the active thread goal.")) {
    return null;
  }
  const match = /<(?:untrusted_)?objective>\s*([\s\S]*?)\s*<\/(?:untrusted_)?objective>/i.exec(text);
  const objective = match?.[1]?.trim();
  return objective || null;
}

function translateCodexGoalContextNotification(
  record: Record<string, unknown>,
  state: CodexRolloutTranslationState,
  objective: string,
): CodexTranslatedActivity[] {
  const threadId = state.providerSessionId ?? "unscoped";
  const signature = ["active", objective, ""].join("\u0000");
  const lastSignature = state.lastGoalEventSignatureByThread.get(threadId);
  if (lastSignature === signature || lastSignature?.startsWith(`active\u0000${objective}\u0000`)) {
    return [];
  }
  state.lastGoalEventSignatureByThread.set(threadId, signature);
  return [
    persistedActivity(
      record,
      {
        type: "notification",
        level: "info",
        title: "Goal active",
        body: `Objective: ${truncateNotificationText(objective)}`,
      },
      "authoritative",
    ),
  ];
}

function stringField(record: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
}

function numberField(record: Record<string, unknown>, ...keys: string[]): number | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }
  return null;
}

function truncateNotificationText(text: string, maxLength = 480): string {
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength - 3).trimEnd()}...`;
}

function normalizeCodexGoalStatus(status: string): string {
  switch (status) {
    case "usage_limited":
      return "usageLimited";
    case "budget_limited":
      return "budgetLimited";
    default:
      return status;
  }
}

function codexGoalStatusLabel(status: string): string {
  switch (status) {
    case "active":
      return "active";
    case "paused":
      return "paused";
    case "blocked":
      return "blocked";
    case "usageLimited":
      return "usage limited";
    case "budgetLimited":
      return "budget limited";
    case "complete":
      return "complete";
    default:
      return status
        .replace(/_/g, " ")
        .replace(/([a-z])([A-Z])/g, "$1 $2")
        .toLowerCase();
  }
}

function codexGoalNotificationLevel(status: string): "info" | "warning" {
  return status === "blocked" || status === "usageLimited" || status === "budgetLimited"
    ? "warning"
    : "info";
}

function codexGoalDuration(seconds: number | null): string | null {
  if (seconds === null || seconds <= 0) {
    return null;
  }
  const rounded = Math.round(seconds);
  if (rounded < 60) {
    return `${rounded}s`;
  }
  const minutes = Math.floor(rounded / 60);
  const remainder = rounded % 60;
  return remainder > 0 ? `${minutes}m ${remainder}s` : `${minutes}m`;
}

function translateCodexGoalUpdatedEvent(
  record: Record<string, unknown>,
  payload: Record<string, unknown>,
  state: CodexRolloutTranslationState,
): CodexTranslatedActivity[] {
  if (!payload.goal || typeof payload.goal !== "object" || Array.isArray(payload.goal)) {
    return invalidRolloutActivity(record, "thread_goal_updated did not include goal");
  }
  const goal = payload.goal as Record<string, unknown>;
  const objective = stringField(goal, "objective") ?? "";
  const rawStatus = stringField(goal, "status");
  if (!rawStatus) {
    return invalidRolloutActivity(record, "thread_goal_updated goal did not include status");
  }
  const status = normalizeCodexGoalStatus(rawStatus);
  const threadId =
    stringField(goal, "threadId", "thread_id") ??
    stringField(payload, "threadId", "thread_id") ??
    state.providerSessionId ??
    "unscoped";
  const tokenBudget = numberField(goal, "tokenBudget", "token_budget");
  const signature = [status, objective, tokenBudget ?? ""].join("\u0000");
  if (state.lastGoalEventSignatureByThread.get(threadId) === signature) {
    return [];
  }
  state.lastGoalEventSignatureByThread.set(threadId, signature);

  const bodyParts: string[] = [];
  if (objective) {
    bodyParts.push(`Objective: ${truncateNotificationText(objective)}`);
  }
  if (tokenBudget !== null) {
    bodyParts.push(`Token budget: ${tokenBudget}`);
  }
  const tokensUsed = numberField(goal, "tokensUsed", "tokens_used");
  const elapsed = codexGoalDuration(numberField(goal, "timeUsedSeconds", "time_used_seconds"));
  if (status !== "active" && (tokensUsed !== null || elapsed !== null)) {
    const usageParts = [
      ...(tokensUsed !== null ? [`${tokensUsed} tokens`] : []),
      ...(elapsed !== null ? [elapsed] : []),
    ];
    bodyParts.push(`Usage: ${usageParts.join(", ")}`);
  }

  const turnId = stringField(payload, "turnId", "turn_id");
  return [
    persistedActivity(
      record,
      {
        type: "notification",
        level: codexGoalNotificationLevel(status),
        title: `Goal ${codexGoalStatusLabel(status)}`,
        body: bodyParts.join("\n") || `Status: ${codexGoalStatusLabel(status)}`,
        ...(turnId !== null ? { turnId } : {}),
      },
      "authoritative",
    ),
  ];
}

function translateCodexGoalClearedEvent(
  record: Record<string, unknown>,
  payload: Record<string, unknown>,
  state: CodexRolloutTranslationState,
): CodexTranslatedActivity[] {
  const threadId =
    stringField(payload, "threadId", "thread_id") ??
    state.providerSessionId ??
    "unscoped";
  const signature = "cleared";
  if (state.lastGoalEventSignatureByThread.get(threadId) === signature) {
    return [];
  }
  state.lastGoalEventSignatureByThread.set(threadId, signature);
  return [
    persistedActivity(
      record,
      {
        type: "notification",
        level: "info",
        title: "Goal cleared",
        body: "The active goal was cleared.",
      },
      "authoritative",
    ),
  ];
}

function isCodexBootstrapUserMessage(text: string): boolean {
  return (
    text.includes("<environment_context>") ||
    text.includes("# AGENTS.md instructions") ||
    text.includes("<INSTRUCTIONS>") ||
    text.includes("<permissions instructions>") ||
    text.includes("<skills_instructions>") ||
    text.includes("<shell>") ||
    text.includes("<current_date>") ||
    text.includes("<timezone>") ||
    text.includes("<cwd>") ||
    text.includes("<approval_policy>")
  );
}

function stripCodexContextualFragments(text: string): string {
  return text
    .replace(/<turn_aborted>[\s\S]*?<\/turn_aborted>/gi, "")
    .replace(/<user_shell_command>[\s\S]*?<\/user_shell_command>/gi, "")
    .replace(/<subagent_notification>[\s\S]*?<\/subagent_notification>/gi, "")
    .trim();
}

function shouldSkipDuplicateTimelineText(
  state: CodexRolloutTranslationState,
  record: Record<string, unknown>,
  kind: "user_message" | "assistant_message" | "reasoning",
  text: string,
): boolean {
  const turnKey = state.currentTurnId ?? "unscoped";
  const signature = `${turnKey}:${kind}:${text}`;
  if (state.lastTimelineTextSignature === signature) {
    return true;
  }
  state.lastTimelineTextSignature = signature;
  return false;
}

function timelineIdentityProps(identity: TimelineIdentity | undefined): { identity?: TimelineIdentity } {
  return identity !== undefined ? { identity } : {};
}

function turnIdentityProps(identity: TimelineTurnIdentity | undefined): { identity?: TimelineTurnIdentity } {
  return identity !== undefined ? { identity } : {};
}

function payloadRecord(record: Record<string, unknown>): Record<string, unknown> | null {
  return record.payload && typeof record.payload === "object" && !Array.isArray(record.payload)
    ? (record.payload as Record<string, unknown>)
    : null;
}

function syncRolloutStateFromRecord(
  state: CodexRolloutTranslationState,
  record: Record<string, unknown>,
) {
  const payload = payloadRecord(record);
  if (!payload) {
    return;
  }
  if (record.type === "session_meta" && typeof payload.id === "string") {
    state.providerSessionId = state.providerSessionId ?? payload.id;
    return;
  }
  if (record.type !== "event_msg" && record.type !== "turn_context") {
    return;
  }
  const turnId = typeof payload.turn_id === "string" ? payload.turn_id : undefined;
  if (!turnId) {
    return;
  }
  if (record.type === "turn_context") {
    if (state.currentTurnId !== turnId) {
      state.currentTurnId = turnId;
      state.nextTimelineItemIndex = 0;
    }
    state.currentRuntimeModel = codexRuntimeModelFromTurnContext(payload);
    return;
  }
  if (payload.type === "task_started") {
    if (state.currentTurnId !== turnId) {
      state.currentTurnId = turnId;
      state.nextTimelineItemIndex = 0;
    }
    return;
  }
  if (payload.type === "task_complete" || payload.type === "turn_aborted") {
    if (state.currentTurnId === turnId) {
      state.currentTurnId = undefined;
      state.currentRuntimeModel = undefined;
      state.nextTimelineItemIndex = 0;
    }
  }
}

function createHistoryTimelineIdentity(
  state: CodexRolloutTranslationState,
  params: {
    itemKind: "user_message" | "assistant_message" | "reasoning" | "system";
    providerEventId?: string;
    providerMessageId?: string;
  },
): TimelineIdentity | undefined {
  if (!state.currentTurnId) {
    return undefined;
  }
  const itemIndex = state.nextTimelineItemIndex;
  state.nextTimelineItemIndex += 1;
  return createCodexTimelineIdentity({
    providerSessionId: state.providerSessionId,
    turnId: state.currentTurnId,
    itemKind: params.itemKind,
    itemIndex,
    origin: "history",
    confidence: "derived",
    ...(params.providerEventId !== undefined ? { providerEventId: params.providerEventId } : {}),
    ...(params.providerMessageId !== undefined ? { providerMessageId: params.providerMessageId } : {}),
  });
}

function extractPatchFileRefs(patch: string): string[] {
  const refs = new Set<string>();
  for (const line of patch.split(/\r?\n/)) {
    const match =
      /^\*\*\* (?:Update|Add|Delete) File:\s+(.+)$/.exec(line) ??
      /^\*\*\* Move to:\s+(.+)$/.exec(line);
    if (match?.[1]) {
      refs.add(match[1].trim());
    }
  }
  return [...refs];
}

function mapCustomToolCall(
  name: string,
  callId: string,
  input: unknown,
): ToolCall {
  if (name === "apply_patch" && typeof input === "string") {
    const fileRefs = extractPatchFileRefs(input);
    const artifacts: ToolCallArtifact[] = [
      {
        kind: "text",
        label: "patch",
        text: input,
      },
    ];
    if (fileRefs.length > 0) {
      artifacts.push({
        kind: "file_refs",
        files: fileRefs,
      });
    }
    return {
      id: callId,
      family: "patch",
      providerToolName: name,
      title: "Apply patch",
      input: { patch: input },
      detail: { artifacts },
    };
  }

  return {
    id: callId,
    family: "other",
    providerToolName: name,
    title: name,
    ...(input !== undefined ? { input: { value: input } } : {}),
  };
}

function mapGenericToolCall(
  name: string,
  callId: string,
  input: unknown,
): ToolCall {
  return {
    id: callId,
    family: "other",
    providerToolName: name,
    title: name,
    ...(input !== undefined ? { input: { value: input } } : {}),
  };
}

function shellCommandFromArgs(
  name: string,
  args: Record<string, unknown>,
): { command: string; cwd?: string } | null {
  if (name === "exec_command" && typeof args.cmd === "string") {
    const command = args.cmd.trim();
    if (!command) {
      return null;
    }
    return {
      command,
      ...(typeof args.workdir === "string" ? { cwd: args.workdir } : {}),
    };
  }

  if (name === "shell_command" && typeof args.command === "string") {
    const command = args.command.trim();
    if (!command) {
      return null;
    }
    return {
      command,
      ...(typeof args.workdir === "string" ? { cwd: args.workdir } : {}),
    };
  }

  if (name === "shell" && Array.isArray(args.command)) {
    const parts = args.command.filter((part): part is string => typeof part === "string");
    const command =
      parts.length >= 3 && parts[1] === "-lc" ? parts[2]!.trim() : parts.join(" ").trim();
    if (!command) {
      return null;
    }
    return {
      command,
      ...(typeof args.workdir === "string" ? { cwd: args.workdir } : {}),
    };
  }

  return null;
}

function terminalInteractionFromArgs(
  name: string,
  args: Record<string, unknown>,
): { sessionId: number; chars: string } | null {
  if (name !== "write_stdin") {
    return null;
  }
  const rawSessionId = args.session_id;
  const sessionId =
    typeof rawSessionId === "number" && Number.isInteger(rawSessionId)
      ? rawSessionId
      : typeof rawSessionId === "string" && /^\d+$/.test(rawSessionId)
        ? Number.parseInt(rawSessionId, 10)
        : undefined;
  if (sessionId === undefined) {
    return null;
  }
  const chars = typeof args.chars === "string" ? args.chars : "";
  return { sessionId, chars };
}

function fallbackTerminalSessionToolCallId(sessionId: number): string {
  return `terminal-session-${sessionId}`;
}

function makeTerminalSessionToolCall(sessionId: number): ToolCall {
  return {
    id: fallbackTerminalSessionToolCallId(sessionId),
    family: "shell",
    providerToolName: "write_stdin",
    title: "Terminal session",
    result: { sessionId },
  };
}

function mergeTextArtifact(
  current: Extract<ToolCallArtifact, { kind: "text" }>,
  incoming: Extract<ToolCallArtifact, { kind: "text" }>,
): Extract<ToolCallArtifact, { kind: "text" }> {
  if (incoming.text.startsWith(current.text)) {
    return incoming;
  }
  if (current.text.endsWith(incoming.text)) {
    return current;
  }
  return {
    ...current,
    text: `${current.text}${incoming.text}`,
  };
}

function appendToolTextArtifact(toolCall: ToolCall, label: string, text: string): ToolCall {
  if (!text) {
    return toolCall;
  }
  const artifacts = [...(toolCall.detail?.artifacts ?? [])];
  const incoming: Extract<ToolCallArtifact, { kind: "text" }> = { kind: "text", label, text };
  const existingIndex = artifacts.findIndex(
    (artifact) => artifact.kind === "text" && artifact.label === label,
  );
  if (existingIndex < 0) {
    artifacts.push(incoming);
  } else {
    const existing = artifacts[existingIndex];
    if (existing?.kind === "text") {
      artifacts[existingIndex] = mergeTextArtifact(existing, incoming);
    }
  }
  return {
    ...toolCall,
    detail: { artifacts },
  };
}

function runningTerminalToolCall(toolCall: ToolCall, sessionId: number): ToolCall {
  return {
    ...toolCall,
    result: {
      ...(toolCall.result ?? {}),
      sessionId,
    },
    summary: `Process running with session ID ${sessionId}.`,
  };
}

function makeCommandObservation(
  callId: string,
  command: string,
  cwd?: string,
): WorkbenchObservation {
  const classified = classifyCodexCommand(command);
  return {
    id: `obs-${callId}`,
    kind: classified.kind,
    status: "running",
    title: classified.title,
    subject: {
      command,
      providerCallId: callId,
      ...(cwd !== undefined ? { cwd } : {}),
      ...(classified.files !== undefined ? { files: classified.files } : {}),
      ...(classified.query !== undefined ? { query: classified.query } : {}),
    },
    detail: {
      artifacts: [
        {
          kind: "command",
          command,
          ...(cwd !== undefined ? { cwd } : {}),
        },
      ],
    },
  };
}

function makePatchObservation(callId: string, toolCall: ToolCall): WorkbenchObservation {
  const fileRefs = toolCall.detail?.artifacts.flatMap((artifact) =>
    artifact.kind === "file_refs" ? artifact.files : [],
  ) ?? [];
  return {
    id: `obs-${callId}`,
    kind: "patch.apply",
    status: "running",
    title: "Apply patch",
    subject: {
      providerToolName: toolCall.providerToolName,
      providerCallId: callId,
      ...(fileRefs.length > 0 ? { files: fileRefs } : {}),
    },
    ...(toolCall.detail !== undefined ? { detail: toolCall.detail } : {}),
  };
}

function completeObservation(
  observation: WorkbenchObservation,
  params: {
    status: "completed" | "failed";
    output?: string;
    exitCode?: number;
  },
): WorkbenchObservation {
  const artifacts = [...(observation.detail?.artifacts ?? [])];
  if (params.output) {
    artifacts.push({ kind: "text", label: "output", text: params.output });
  }
  return {
    ...observation,
    status: params.status,
    ...(params.exitCode !== undefined ? { exitCode: params.exitCode } : {}),
    ...(params.exitCode !== undefined
      ? { summary: `Process exited with code ${params.exitCode}.` }
      : {}),
    detail: { artifacts },
  };
}

function runningTerminalObservation(
  observation: WorkbenchObservation,
  sessionId: number,
  output?: string,
): WorkbenchObservation {
  const artifacts = [...(observation.detail?.artifacts ?? [])];
  if (output) {
    artifacts.push({ kind: "text", label: "output", text: output });
  }
  return {
    ...observation,
    status: "running",
    summary: `Process running with session ID ${sessionId}.`,
    detail: { artifacts },
  };
}

function parseFunctionCallOutput(output: string): {
  exitCode?: number;
  runningSessionId?: number;
  textOutput?: string;
} {
  const exitMatch =
    /Process exited with code (\d+)/.exec(output) ?? /Exit code:\s*(\d+)/.exec(output);
  const runningSessionMatch = /Process running with session ID (\d+)/.exec(output);
  const outputMatch = /\nOutput:\n([\s\S]*)$/.exec(output);
  const textOutput = outputMatch?.[1]?.trimEnd();

  return {
    ...(exitMatch ? { exitCode: Number.parseInt(exitMatch[1]!, 10) } : {}),
    ...(runningSessionMatch
      ? { runningSessionId: Number.parseInt(runningSessionMatch[1]!, 10) }
      : {}),
    ...(textOutput ? { textOutput } : {}),
  };
}

function parseCustomToolCallOutput(output: unknown): {
  successText?: string;
  exitCode?: number;
  failedText?: string;
  fileRefs?: string[];
} {
  if (typeof output === "string") {
    try {
      const parsed = JSON.parse(output) as Record<string, unknown>;
      return {
        ...(typeof parsed.output === "string" ? { successText: parsed.output } : {}),
        ...(parsed.metadata &&
        typeof parsed.metadata === "object" &&
        !Array.isArray(parsed.metadata) &&
        typeof (parsed.metadata as Record<string, unknown>).exit_code === "number"
          ? { exitCode: (parsed.metadata as Record<string, unknown>).exit_code as number }
          : {}),
        ...(typeof parsed.output === "string"
          ? { fileRefs: extractUpdatedFiles(parsed.output) }
          : {}),
      };
    } catch {
      const trimmed = output.trim();
      const processOutput = parseFunctionCallOutput(trimmed);
      if (processOutput.exitCode !== undefined) {
        const text = processOutput.textOutput ?? trimmed;
        return processOutput.exitCode === 0
          ? {
              successText: text,
              exitCode: processOutput.exitCode,
              fileRefs: extractUpdatedFiles(text),
            }
          : {
              failedText: text || trimmed,
              exitCode: processOutput.exitCode,
            };
      }
      if (/^Success\./.test(trimmed)) {
        return {
          successText: trimmed,
          fileRefs: extractUpdatedFiles(trimmed),
        };
      }
      return {
        ...(trimmed ? { failedText: trimmed } : {}),
      };
    }
  }
  return {};
}

function extractUpdatedFiles(text: string): string[] {
  const marker = "Updated the following files:";
  const index = text.indexOf(marker);
  if (index < 0) {
    return [];
  }
  return text
    .slice(index + marker.length)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(/^[A-Z]\s+/, "").trim())
    .filter(Boolean);
}

function persistedActivity(
  line: Record<string, unknown>,
  activity: ProviderActivity,
  authority: EventAuthority,
): CodexTranslatedActivity {
  const translated: CodexTranslatedActivity = {
    activity,
    channel: "structured_persisted",
    authority,
    raw: line,
  };
  if (typeof line.timestamp === "string") {
    translated.ts = line.timestamp;
  }
  return translated;
}

function makeInvalidRolloutObservation(
  line: Record<string, unknown>,
  reason: string,
): WorkbenchObservation {
  invalidRolloutSequence += 1;
  const payload =
    line.payload && typeof line.payload === "object" && !Array.isArray(line.payload)
      ? (line.payload as Record<string, unknown>)
      : {};
  const providerToolName =
    typeof payload.type === "string" ? payload.type : typeof line.type === "string" ? line.type : "unknown";
  return {
    id: `obs-invalid-rollout-${invalidRolloutSequence}`,
    kind: "runtime.invalid_stream",
    status: "completed",
    title: "Unhandled persisted provider event",
    summary: `${providerToolName}: ${reason}`,
    subject: {
      providerToolName,
    },
    detail: {
      artifacts: [{ kind: "json", label: "raw", value: line }],
    },
  };
}

function invalidRolloutActivity(
  line: Record<string, unknown>,
  reason: string,
): CodexTranslatedActivity[] {
  return [
    persistedActivity(
      line,
      {
        type: "observation_completed",
        observation: makeInvalidRolloutObservation(line, reason),
      },
      "heuristic",
    ),
  ];
}

function interruptedPendingToolActivities(
  state: CodexRolloutTranslationState,
  line: Record<string, unknown>,
  options: { includeTimelineStatus: boolean; includeTerminalSessions?: boolean },
): CodexTranslatedActivity[] {
  if (state.pendingToolCalls.size === 0 && state.terminalSessions.size === 0) {
    return [];
  }

  const result: CodexTranslatedActivity[] = [];
  const failedToolCallIds = new Set<string>();
  for (const [callId, pending] of state.pendingToolCalls) {
    if (pending.hidden) {
      continue;
    }
    if (pending.observation) {
      result.push(
        persistedActivity(
          line,
          {
            type: "observation_failed",
            observation: {
              ...pending.observation,
              status: "failed",
              summary: CODEX_INTERRUPTED_PENDING_TOOL_ERROR,
            },
            error: CODEX_INTERRUPTED_PENDING_TOOL_ERROR,
          },
          "derived",
        ),
      );
      failedToolCallIds.add(callId);
    }
    result.push(
      persistedActivity(
        line,
        {
          type: "tool_call_failed",
          toolCallId: callId,
          error: CODEX_INTERRUPTED_PENDING_TOOL_ERROR,
        },
        "derived",
      ),
    );
    failedToolCallIds.add(callId);
  }
  state.pendingToolCalls.clear();

  if (options.includeTerminalSessions !== false) {
    for (const terminalSession of state.terminalSessions.values()) {
      if (failedToolCallIds.has(terminalSession.toolCallId)) {
        continue;
      }
      if (terminalSession.observation) {
        result.push(
          persistedActivity(
            line,
            {
              type: "observation_failed",
              observation: {
                ...terminalSession.observation,
                status: "failed",
                summary: CODEX_INTERRUPTED_PENDING_TOOL_ERROR,
              },
              error: CODEX_INTERRUPTED_PENDING_TOOL_ERROR,
            },
            "derived",
          ),
        );
      }
      result.push(
        persistedActivity(
          line,
          {
            type: "tool_call_failed",
            toolCallId: terminalSession.toolCallId,
            error: CODEX_INTERRUPTED_PENDING_TOOL_ERROR,
          },
          "derived",
        ),
      );
      failedToolCallIds.add(terminalSession.toolCallId);
    }
  }
  state.terminalSessions.clear();

  if (options.includeTimelineStatus && result.length > 0) {
    result.push(
      persistedActivity(
        line,
        {
          type: "timeline_item",
          item: {
            kind: "system",
            text: CODEX_INTERRUPTED_PENDING_TOOL_ERROR,
          },
        },
        "derived",
      ),
    );
  }

  return result;
}

export function finalizeCodexRolloutTranslationState(
  state: CodexRolloutTranslationState,
  options: { timestamp?: string } = {},
): CodexTranslatedActivity[] {
  return interruptedPendingToolActivities(
    state,
    {
      ...(options.timestamp ? { timestamp: options.timestamp } : {}),
      type: "event_msg",
      payload: {
        type: "turn_aborted",
        reason: "history_eof",
      },
    },
    { includeTimelineStatus: true, includeTerminalSessions: false },
  );
}

export function translateCodexRolloutLine(
  line: unknown,
  state: CodexRolloutTranslationState,
): CodexTranslatedActivity[] {
  if (!line || typeof line !== "object" || Array.isArray(line)) {
    return [];
  }

  const record = line as Record<string, unknown>;
  const turnIdBeforeSync = state.currentTurnId;
  syncRolloutStateFromRecord(state, record);
  if (record.type === "event_msg") {
    const payload = payloadRecord(record);
    if (!payload) {
      return [];
    }
    if (payload.type === "thread_goal_updated") {
      return translateCodexGoalUpdatedEvent(record, payload, state);
    }
    if (payload.type === "thread_goal_cleared") {
      return translateCodexGoalClearedEvent(record, payload, state);
    }
    if (payload.type === "agent_reasoning" && typeof payload.text === "string") {
      if (shouldSkipDuplicateTimelineText(state, record, "reasoning", payload.text)) {
        return [];
      }
      const identity = createHistoryTimelineIdentity(state, {
        itemKind: "reasoning",
      });
      return [
        persistedActivity(
          record,
          {
            type: "timeline_item",
            item: { kind: "reasoning", text: payload.text },
            ...timelineIdentityProps(identity),
          },
          "authoritative",
        ),
      ];
    }
    if (payload.type === "agent_message") {
      const text = extractAgentMessageText(payload.message);
      if (!text) {
        if (typeof payload.message === "string" && payload.message.trim() === "") {
          return [];
        }
        return invalidRolloutActivity(record, "agent_message did not contain text");
      }
      if (shouldSkipDuplicateTimelineText(state, record, "assistant_message", text)) {
        return [];
      }
      const identity = createHistoryTimelineIdentity(state, {
        itemKind: "assistant_message",
      });
      return [
        persistedActivity(
          record,
          {
            type: "timeline_item",
            item: {
              kind: "assistant_message",
              text,
              ...(state.currentRuntimeModel ? { runtimeModel: state.currentRuntimeModel } : {}),
            },
            ...timelineIdentityProps(identity),
          },
          "authoritative",
        ),
      ];
    }
    if (payload.type === "turn_aborted") {
      const turnId =
        typeof payload.turn_id === "string" ? payload.turn_id : turnIdBeforeSync;
      const reason = typeof payload.reason === "string" ? payload.reason : "interrupted";
      const identity =
        turnId !== undefined && state.providerSessionId !== undefined
          ? createCodexTimelineTurnIdentity({
              providerSessionId: state.providerSessionId,
              turnId,
              origin: "history",
              confidence: "derived",
            })
          : undefined;
      return [
        ...(turnId !== undefined
          ? [
              persistedActivity(
                record,
                {
                  type: "turn_canceled" as const,
                  turnId,
                  reason,
                  ...turnIdentityProps(identity),
                },
                "authoritative" as const,
              ),
            ]
          : []),
        ...interruptedPendingToolActivities(
          state,
          record,
          { includeTimelineStatus: true },
        ),
      ];
    }
    if (typeof payload.type === "string" && IGNORED_PERSISTED_EVENT_MSG_TYPES.has(payload.type)) {
      return [];
    }
    return invalidRolloutActivity(record, "event_msg payload type is not mapped");
  }

  if (record.type !== "response_item") {
    return [];
  }

  const payload = payloadRecord(record);
  if (!payload || typeof payload.type !== "string") {
    return invalidRolloutActivity(record, "response_item payload type was missing");
  }

  if (payload.type === "reasoning") {
    const text =
      extractSummaryText(payload.summary) ??
      (typeof payload.text === "string" ? payload.text.trim() : null);
    if (!text) {
      if (typeof payload.encrypted_content === "string") {
        return [];
      }
      return invalidRolloutActivity(record, "reasoning item did not contain text");
    }
    const messageId = typeof payload.id === "string" ? payload.id : null;
    const identity = createHistoryTimelineIdentity(state, {
      itemKind: "reasoning",
      ...(messageId !== null ? { providerEventId: messageId } : {}),
    });
    return [
      ...(messageId
        ? [
            persistedActivity(
              record,
              {
                type: "message_part_added",
                part: {
                  messageId,
                  partId: messageId,
                  kind: "reasoning",
                  text,
                },
              },
              "authoritative",
            ),
          ]
        : []),
      persistedActivity(
        record,
        {
          type: "timeline_item",
          item: { kind: "reasoning", text },
          ...timelineIdentityProps(identity),
        },
        "authoritative",
      ),
    ];
  }

  if (payload.type === "message" && typeof payload.role === "string") {
    if (payload.role === "developer") {
      const rawText = textFromContentItems(payload.content, "input_text");
      const goalObjective = rawText ? extractCodexGoalObjective(rawText) : null;
      if (goalObjective) {
        return translateCodexGoalContextNotification(record, state, goalObjective);
      }
      return [];
    }
    if (payload.role === "user") {
      const rawText = textFromContentItems(payload.content, "input_text");
      if (rawText === null) {
        return [];
      }
      const goalObjective = extractCodexGoalObjective(rawText);
      if (goalObjective) {
        return translateCodexGoalContextNotification(record, state, goalObjective);
      }
      if (isCodexBootstrapUserMessage(rawText)) {
        return [];
      }
      const text = stripCodexContextualFragments(rawText);
      if (!text) {
        return [];
      }
      if (shouldSkipDuplicateTimelineText(state, record, "user_message", text)) {
        return [];
      }
      const messageId = typeof payload.id === "string" ? payload.id : null;
      const identity = createHistoryTimelineIdentity(state, {
        itemKind: "user_message",
        ...(messageId !== null ? { providerMessageId: messageId } : {}),
      });
      return [
        ...(messageId
          ? [
              persistedActivity(
                record,
                {
                  type: "message_part_added",
                  part: {
                    messageId,
                    partId: messageId,
                    kind: "text",
                    text,
                  },
                },
                "authoritative",
              ),
            ]
          : []),
        persistedActivity(
          record,
          {
            type: "timeline_item",
            item: { kind: "user_message", text },
            ...timelineIdentityProps(identity),
          },
          "authoritative",
        ),
      ];
    }
    if (payload.role === "assistant") {
      const rawText = textFromContentItems(payload.content, "output_text");
      const text = stripCodexContextualFragments(
        rawText ?? "",
      );
      if (!text) {
        if (rawText !== null) {
          return [];
        }
        return invalidRolloutActivity(record, "assistant message did not contain output_text");
      }
      if (shouldSkipDuplicateTimelineText(state, record, "assistant_message", text)) {
        return [];
      }
      const messageId = typeof payload.id === "string" ? payload.id : null;
      const identity = createHistoryTimelineIdentity(state, {
        itemKind: "assistant_message",
        ...(messageId !== null ? { providerMessageId: messageId } : {}),
      });
      return [
        ...(messageId
          ? [
              persistedActivity(
                record,
                {
                  type: "message_part_added",
                  part: {
                    messageId,
                    partId: messageId,
                    kind: "text",
                    text,
                  },
                },
                "authoritative",
              ),
            ]
          : []),
        persistedActivity(
          record,
          {
            type: "timeline_item",
            item: {
              kind: "assistant_message",
              text,
              ...(state.currentRuntimeModel ? { runtimeModel: state.currentRuntimeModel } : {}),
            },
            ...timelineIdentityProps(identity),
          },
          "authoritative",
        ),
      ];
    }
    return invalidRolloutActivity(record, `message role ${payload.role} is not mapped`);
  }

  if (payload.type === "function_call" && typeof payload.name === "string") {
    const callId = typeof payload.call_id === "string" ? payload.call_id : null;
    if (!callId) {
      return invalidRolloutActivity(record, "function_call did not include call_id");
    }
    const args = parseJsonObject(payload.arguments);
    const councilMcpToolCall = normalizeCouncilMcpToolCall({
      provider: "codex",
      callId,
      toolName: payload.name,
      status: "started",
      ...(state.providerSessionId !== undefined ? { providerSessionId: state.providerSessionId } : {}),
      ...(args !== null ? { callArgs: args } : {}),
    });
    if (councilMcpToolCall) {
      state.pendingToolCalls.set(callId, {
        toolCall: mapGenericToolCall(payload.name, callId, args ?? payload.arguments),
        hidden: true,
        councilMcpToolCall,
      });
      return [];
    }
    const terminalInteraction = args ? terminalInteractionFromArgs(payload.name, args) : null;
    if (terminalInteraction) {
      let terminalSession = state.terminalSessions.get(terminalInteraction.sessionId);
      if (!terminalSession) {
        const toolCall = makeTerminalSessionToolCall(terminalInteraction.sessionId);
        terminalSession = {
          sessionId: terminalInteraction.sessionId,
          toolCallId: toolCall.id,
          toolCall,
          started: false,
        };
        state.terminalSessions.set(terminalInteraction.sessionId, terminalSession);
      }
      state.pendingToolCalls.set(callId, {
        toolCall: mapGenericToolCall(
          payload.name,
          terminalSession.toolCallId,
          args ?? payload.arguments,
        ),
        hidden: true,
        terminalInteraction,
      });
      if (!terminalInteraction.chars) {
        return [];
      }
      terminalSession.toolCall = appendToolTextArtifact(
        terminalSession.toolCall,
        "stdin",
        terminalInteraction.chars,
      );
      if (!terminalSession.started) {
        terminalSession.started = true;
        return [
          persistedActivity(
            record,
            {
              type: "tool_call_started",
              toolCall: terminalSession.toolCall,
            },
            "derived",
          ),
        ];
      }
      return [
        persistedActivity(
          record,
          {
            type: "tool_call_delta",
            toolCallId: terminalSession.toolCallId,
            detail: {
              artifacts: [{ kind: "text", label: "stdin", text: terminalInteraction.chars }],
            },
          },
          "derived",
        ),
      ];
    }
    const shell = args ? shellCommandFromArgs(payload.name, args) : null;
    if (!shell) {
      const toolCall = mapGenericToolCall(payload.name, callId, args ?? payload.arguments);
      state.pendingToolCalls.set(callId, { toolCall });
      return [
        persistedActivity(
          record,
          {
            type: "tool_call_started",
            toolCall,
          },
          "derived",
        ),
      ];
    }

    const artifacts: ToolCallArtifact[] = [
      {
        kind: "command",
        command: shell.command,
        ...(shell.cwd !== undefined ? { cwd: shell.cwd } : {}),
      },
    ];
    const classified = classifyCodexCommand(shell.command);
    const toolCall: ToolCall = {
      id: callId,
      family: classified.family,
      providerToolName: payload.name,
      title: classified.title,
      input: { command: shell.command },
      detail: { artifacts },
    };
    const observation = makeCommandObservation(callId, shell.command, shell.cwd);
    state.pendingToolCalls.set(callId, { toolCall, observation });

    return [
      persistedActivity(
        record,
        {
          type: "observation_started",
          observation,
        },
        "derived",
      ),
      persistedActivity(
        record,
        {
          type: "tool_call_started",
          toolCall,
        },
        "derived",
      ),
    ];
  }

  if (payload.type === "custom_tool_call" && typeof payload.name === "string") {
    const callId = typeof payload.call_id === "string" ? payload.call_id : null;
    if (!callId) {
      return invalidRolloutActivity(record, "custom_tool_call did not include call_id");
    }
    const toolCall = mapCustomToolCall(
      payload.name,
      callId,
      payload.input,
    );
    const observation = toolCall.family === "patch" ? makePatchObservation(callId, toolCall) : undefined;
    state.pendingToolCalls.set(callId, observation ? { toolCall, observation } : { toolCall });
    return [
      ...(observation
        ? [
            persistedActivity(
              record,
              {
                type: "observation_started",
                observation,
              },
              "derived",
            ),
          ]
        : []),
      persistedActivity(
        record,
        {
          type: "tool_call_started",
          toolCall,
        },
        "derived",
      ),
    ];
  }

  if (payload.type === "function_call_output" && typeof payload.call_id === "string") {
    const pending = state.pendingToolCalls.get(payload.call_id);
    if (!pending || typeof payload.output !== "string") {
      return invalidRolloutActivity(record, "function_call_output had no pending call or string output");
    }
    if (pending.terminalInteraction) {
      state.pendingToolCalls.delete(payload.call_id);
      let terminalSession = state.terminalSessions.get(pending.terminalInteraction.sessionId);
      if (!terminalSession) {
        return [];
      }
      const parsedOutput = parseFunctionCallOutput(payload.output);
      const prefixActivities: CodexTranslatedActivity[] = [];
      if (!terminalSession.started) {
        terminalSession.started = true;
        prefixActivities.push(
          persistedActivity(
            record,
            {
              type: "tool_call_started",
              toolCall: terminalSession.toolCall,
            },
            "derived",
          ),
        );
      }
      const outputText = parsedOutput.textOutput;
      if (outputText) {
        terminalSession.toolCall = appendToolTextArtifact(
          terminalSession.toolCall,
          "stdout",
          outputText,
        );
      }
      if (parsedOutput.runningSessionId !== undefined && parsedOutput.exitCode === undefined) {
        terminalSession = {
          ...terminalSession,
          sessionId: parsedOutput.runningSessionId,
          toolCall: runningTerminalToolCall(
            terminalSession.toolCall,
            parsedOutput.runningSessionId,
          ),
        };
        state.terminalSessions.set(parsedOutput.runningSessionId, terminalSession);
        if (parsedOutput.runningSessionId !== pending.terminalInteraction.sessionId) {
          state.terminalSessions.delete(pending.terminalInteraction.sessionId);
        }
      }
      if (parsedOutput.exitCode !== undefined) {
        const completedToolCall: ToolCall = {
          ...terminalSession.toolCall,
          result: {
            ...(terminalSession.toolCall.result ?? {}),
            sessionId: terminalSession.sessionId,
            exitCode: parsedOutput.exitCode,
          },
          summary: `Process exited with code ${parsedOutput.exitCode}.`,
        };
        state.terminalSessions.delete(pending.terminalInteraction.sessionId);
        state.terminalSessions.delete(terminalSession.sessionId);
        if (parsedOutput.runningSessionId !== undefined) {
          state.terminalSessions.delete(parsedOutput.runningSessionId);
        }
        const completedObservation = terminalSession.observation
          ? completeObservation(terminalSession.observation, {
              status: parsedOutput.exitCode !== 0 ? "failed" : "completed",
              ...(outputText !== undefined ? { output: outputText } : {}),
              exitCode: parsedOutput.exitCode,
            })
          : null;
        return [
          ...prefixActivities,
          ...(completedObservation
            ? [
                persistedActivity(
                  record,
                  completedObservation.status === "failed"
                    ? {
                        type: "observation_failed",
                        observation: completedObservation,
                        ...(outputText !== undefined ? { error: outputText } : {}),
                      }
                    : {
                        type: "observation_completed",
                        observation: completedObservation,
                      },
                  "derived",
                ),
              ]
            : []),
          persistedActivity(
            record,
            {
              type: "tool_call_completed",
              toolCall: completedToolCall,
            },
            "derived",
          ),
        ];
      }
      if (!outputText) {
        return prefixActivities;
      }
      return [
        ...prefixActivities,
        persistedActivity(
          record,
          {
            type: "tool_call_delta",
            toolCallId: terminalSession.toolCallId,
            detail: {
              artifacts: [{ kind: "text", label: "stdout", text: outputText }],
            },
          },
          "derived",
        ),
      ];
    }
    if (pending.hidden) {
      state.pendingToolCalls.delete(payload.call_id);
      if (!pending.councilMcpToolCall) {
        return [];
      }
      const projection = projectCouncilMcpToolCall({
        ...pending.councilMcpToolCall,
        status: "completed",
        output: payload.output,
      });
      if (projection.visibility === "hidden") {
        return [];
      }
      const projectedItemKind =
        projection.activity.type === "timeline_item" &&
        (projection.activity.item.kind === "user_message" ||
          projection.activity.item.kind === "assistant_message")
          ? projection.activity.item.kind
          : "assistant_message";
      const identity = createHistoryTimelineIdentity(state, {
        itemKind: projectedItemKind,
        providerEventId: pending.councilMcpToolCall.callId,
      });
      const projectedActivity = attachRuntimeModelToTimelineActivity(
        projection.activity,
        state.currentRuntimeModel,
      );
      return [
        persistedActivity(
          record,
          {
            ...projectedActivity,
            ...timelineIdentityProps(identity),
          },
          "authoritative",
        ),
      ];
    }

    const parsedOutput = parseFunctionCallOutput(payload.output);
    const isContinuingTerminalSession =
      parsedOutput.runningSessionId !== undefined && parsedOutput.exitCode === undefined;
    const artifacts = [...(pending.toolCall.detail?.artifacts ?? [])];
    const outputText =
      parsedOutput.textOutput ??
      (isContinuingTerminalSession ? undefined : payload.output.trimEnd());
    if (outputText) {
      artifacts.push({
        kind: "text",
        label: "stdout",
        text: outputText,
      });
    }

    if (isContinuingTerminalSession) {
      const runningSessionId = parsedOutput.runningSessionId!;
      const runningToolCall = runningTerminalToolCall(
        {
          ...pending.toolCall,
          ...(artifacts.length > 0 ? { detail: { artifacts } } : {}),
        },
        runningSessionId,
      );
      state.terminalSessions.set(runningSessionId, {
        sessionId: runningSessionId,
        toolCallId: runningToolCall.id,
        toolCall: runningToolCall,
        started: true,
        ...(pending.observation ? { observation: pending.observation } : {}),
      });
      state.pendingToolCalls.delete(payload.call_id);
      return [
        ...(pending.observation
          ? [
              persistedActivity(
                record,
                {
                  type: "observation_updated",
                  observation: runningTerminalObservation(
                    pending.observation,
                    runningSessionId,
                    outputText,
                  ),
                },
                "derived",
              ),
            ]
          : []),
        persistedActivity(
          record,
          {
            type: "tool_call_started",
            toolCall: runningToolCall,
          },
          "derived",
        ),
      ];
    }

    const result: Record<string, unknown> = {};
    if (parsedOutput.exitCode !== undefined) {
      result.exitCode = parsedOutput.exitCode;
    }
    if (parsedOutput.runningSessionId !== undefined) {
      result.sessionId = parsedOutput.runningSessionId;
    }

    const completedToolCall: ToolCall = {
      ...pending.toolCall,
      ...(Object.keys(result).length > 0 ? { result } : {}),
      ...(artifacts.length > 0 ? { detail: { artifacts } } : {}),
      ...(parsedOutput.exitCode !== undefined
        ? { summary: `Process exited with code ${parsedOutput.exitCode}.` }
        : parsedOutput.runningSessionId !== undefined
          ? { summary: `Process running with session ID ${parsedOutput.runningSessionId}.` }
          : {}),
    };

    state.pendingToolCalls.delete(payload.call_id);
    const completedObservation = pending.observation
      ? completeObservation(pending.observation, {
          status:
            parsedOutput.exitCode !== undefined && parsedOutput.exitCode !== 0
              ? "failed"
              : "completed",
          ...(outputText !== undefined ? { output: outputText } : {}),
          ...(parsedOutput.exitCode !== undefined ? { exitCode: parsedOutput.exitCode } : {}),
        })
      : null;
    return [
      ...(completedObservation
        ? [
            persistedActivity(
              record,
              completedObservation.status === "failed"
                ? {
                    type: "observation_failed",
                    observation: completedObservation,
                    ...(outputText !== undefined
                      ? { error: outputText }
                      : {}),
                  }
                : {
                    type: "observation_completed",
                    observation: completedObservation,
                  },
              "derived",
            ),
          ]
        : []),
      persistedActivity(
        record,
        {
          type: "tool_call_completed",
          toolCall: completedToolCall,
        },
        "derived",
      ),
    ];
  }

  if (payload.type === "custom_tool_call_output" && typeof payload.call_id === "string") {
    const pending = state.pendingToolCalls.get(payload.call_id);
    if (!pending) {
      return invalidRolloutActivity(record, "custom_tool_call_output had no pending call");
    }
    const parsedOutput = parseCustomToolCallOutput(payload.output);
    const artifacts = [...(pending.toolCall.detail?.artifacts ?? [])];
    if (parsedOutput.successText) {
      artifacts.push({
        kind: "text",
        label: "stdout",
        text: parsedOutput.successText,
      });
    }
    if (parsedOutput.fileRefs && parsedOutput.fileRefs.length > 0) {
      artifacts.push({
        kind: "file_refs",
        files: parsedOutput.fileRefs,
      });
    }
    state.pendingToolCalls.delete(payload.call_id);

    if (parsedOutput.failedText) {
      return [
        ...(pending.observation
          ? [
              persistedActivity(
                record,
                {
                  type: "observation_failed",
                  observation: {
                    ...pending.observation,
                    status: "failed",
                    summary: "Patch apply failed.",
                    ...(parsedOutput.exitCode !== undefined
                      ? { exitCode: parsedOutput.exitCode }
                      : {}),
                    detail: {
                      artifacts: [
                        ...(pending.observation.detail?.artifacts ?? []),
                        { kind: "text", label: "stderr", text: parsedOutput.failedText },
                      ],
                    },
                  },
                  error: parsedOutput.failedText,
                },
                "derived",
              ),
            ]
          : []),
        persistedActivity(
          record,
          {
            type: "tool_call_failed",
            toolCallId: payload.call_id,
            error: parsedOutput.failedText,
          },
          "derived",
        ),
      ];
    }

    const result: Record<string, unknown> = {};
    if (parsedOutput.exitCode !== undefined) {
      result.exitCode = parsedOutput.exitCode;
    }
    return [
      ...(pending.observation
        ? [
            persistedActivity(
              record,
              {
                type: "observation_completed",
                observation: {
                  ...pending.observation,
                  status: "completed",
                  ...(parsedOutput.successText
                    ? { summary: parsedOutput.successText.split(/\r?\n/)[0] }
                    : {}),
                  ...(parsedOutput.exitCode !== undefined
                    ? { exitCode: parsedOutput.exitCode }
                    : {}),
                  detail: {
                    artifacts,
                  },
                },
              },
              "derived",
            ),
          ]
        : []),
      persistedActivity(
        record,
        {
          type: "tool_call_completed",
          toolCall: {
            ...pending.toolCall,
            ...(Object.keys(result).length > 0 ? { result } : {}),
            ...(artifacts.length > 0 ? { detail: { artifacts } } : {}),
            ...(parsedOutput.successText ? { summary: parsedOutput.successText.split(/\r?\n/)[0] } : {}),
          },
        },
        "derived",
      ),
    ];
  }

  return invalidRolloutActivity(record, "response_item payload type is not mapped");
}

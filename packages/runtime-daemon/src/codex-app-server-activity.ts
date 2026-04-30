import type {
  EventAuthority,
  EventChannel,
  ContextUsage,
  PermissionRequest,
  PermissionResolution,
  RuntimeOperation,
  ToolCall,
  ToolCallArtifact,
  WorkbenchObservation,
} from "@rah/runtime-protocol";
import { classifyCodexCommand } from "./codex-command-classifier";
import { normalizeContextUsage } from "./context-usage";
import type { ProviderActivity } from "./provider-activity";

export interface CodexLiveTranslatedActivity {
  activity: ProviderActivity;
  ts?: string;
  channel?: EventChannel;
  authority?: EventAuthority;
  raw?: unknown;
}

type PendingLiveToolCall = {
  toolCall: ToolCall;
};

export interface CodexAppServerTranslationState {
  pendingToolCalls: Map<string, PendingLiveToolCall>;
  agentMessageByItemId: Map<string, string[]>;
  reasoningByItemId: Map<string, string[]>;
  emittedUserMessageItemIds: Set<string>;
  emittedAgentMessageDeltaItemIds: Set<string>;
  emittedReasoningDeltaItemIds: Set<string>;
  completedAgentMessageItemIds: Set<string>;
  completedReasoningItemIds: Set<string>;
  reasoningSectionBreakKeys: Set<string>;
  lastAgentMessageDeltaByItemId: Map<string, string>;
  lastReasoningDeltaByItemId: Map<string, string>;
  lastCommandOutputDeltaByCallId: Map<string, string>;
  lastPatchOutputDeltaByCallId: Map<string, string>;
  commandOutputByCallId: Map<string, string[]>;
  patchOutputByCallId: Map<string, string[]>;
  commandObservationByCallId: Map<string, WorkbenchObservation>;
  patchObservationByCallId: Map<string, WorkbenchObservation>;
}

export function createCodexAppServerTranslationState(): CodexAppServerTranslationState {
  return {
    pendingToolCalls: new Map(),
    agentMessageByItemId: new Map(),
    reasoningByItemId: new Map(),
    emittedUserMessageItemIds: new Set(),
    emittedAgentMessageDeltaItemIds: new Set(),
    emittedReasoningDeltaItemIds: new Set(),
    completedAgentMessageItemIds: new Set(),
    completedReasoningItemIds: new Set(),
    reasoningSectionBreakKeys: new Set(),
    lastAgentMessageDeltaByItemId: new Map(),
    lastReasoningDeltaByItemId: new Map(),
    lastCommandOutputDeltaByCallId: new Map(),
    lastPatchOutputDeltaByCallId: new Map(),
    commandOutputByCallId: new Map(),
    patchOutputByCallId: new Map(),
    commandObservationByCallId: new Map(),
    patchObservationByCallId: new Map(),
  };
}

type JsonRpcNotification = {
  method: string;
  params?: unknown;
};

export const CODEX_APP_SERVER_NOTIFICATION_METHODS = [
  "error",
  "thread/started",
  "thread/status/changed",
  "thread/archived",
  "thread/unarchived",
  "thread/closed",
  "skills/changed",
  "thread/name/updated",
  "thread/tokenUsage/updated",
  "turn/started",
  "hook/started",
  "turn/completed",
  "hook/completed",
  "turn/diff/updated",
  "turn/plan/updated",
  "item/started",
  "item/autoApprovalReview/started",
  "item/autoApprovalReview/completed",
  "item/completed",
  "rawResponseItem/completed",
  "item/agentMessage/delta",
  "item/plan/delta",
  "command/exec/outputDelta",
  "item/commandExecution/outputDelta",
  "item/commandExecution/terminalInteraction",
  "item/fileChange/outputDelta",
  "serverRequest/resolved",
  "item/mcpToolCall/progress",
  "mcpServer/oauthLogin/completed",
  "mcpServer/startupStatus/updated",
  "account/updated",
  "account/rateLimits/updated",
  "account/login/completed",
  "app/list/updated",
  "fs/changed",
  "item/reasoning/summaryTextDelta",
  "item/reasoning/summaryPartAdded",
  "item/reasoning/textDelta",
  "thread/compacted",
  "model/rerouted",
  "deprecationNotice",
  "configWarning",
  "fuzzyFileSearch/sessionUpdated",
  "fuzzyFileSearch/sessionCompleted",
  "thread/realtime/started",
  "thread/realtime/itemAdded",
  "thread/realtime/transcript/delta",
  "thread/realtime/transcript/done",
  "thread/realtime/outputAudio/delta",
  "thread/realtime/sdp",
  "thread/realtime/error",
  "thread/realtime/closed",
  "windows/worldWritableWarning",
  "windowsSandbox/setupCompleted",
] as const;

export const CODEX_APP_SERVER_IGNORED_NOTIFICATION_METHODS = [
  "thread/archived",
  "thread/unarchived",
  "skills/changed",
  "thread/name/updated",
  "rawResponseItem/completed",
  "command/exec/outputDelta",
  "item/commandExecution/terminalInteraction",
  "serverRequest/resolved",
  "mcpServer/oauthLogin/completed",
  "mcpServer/startupStatus/updated",
  "account/updated",
  "account/rateLimits/updated",
  "account/login/completed",
  "app/list/updated",
  "fs/changed",
  "model/rerouted",
  "deprecationNotice",
  "configWarning",
  "fuzzyFileSearch/sessionUpdated",
  "fuzzyFileSearch/sessionCompleted",
  "thread/realtime/started",
  "thread/realtime/itemAdded",
  "thread/realtime/transcript/delta",
  "thread/realtime/transcript/done",
  "thread/realtime/outputAudio/delta",
  "thread/realtime/sdp",
  "thread/realtime/error",
  "thread/realtime/closed",
  "windows/worldWritableWarning",
  "windowsSandbox/setupCompleted",
] as const satisfies readonly (typeof CODEX_APP_SERVER_NOTIFICATION_METHODS)[number][];

const CODEX_APP_SERVER_IGNORED_NOTIFICATION_METHOD_SET = new Set<string>(
  CODEX_APP_SERVER_IGNORED_NOTIFICATION_METHODS,
);

export const CODEX_APP_SERVER_REQUEST_METHODS = [
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/tool/requestUserInput",
  "mcpServer/elicitation/request",
  "item/permissions/requestApproval",
  "item/tool/call",
  "account/chatgptAuthTokens/refresh",
  "applyPatchApproval",
  "execCommandApproval",
] as const;

let invalidStreamSequence = 0;

function translated(
  raw: unknown,
  activity: ProviderActivity,
  options?: {
    ts?: string;
    channel?: EventChannel;
    authority?: EventAuthority;
  },
): CodexLiveTranslatedActivity {
  const result: CodexLiveTranslatedActivity = {
    activity,
    raw,
  };
  if (options?.ts !== undefined) {
    result.ts = options.ts;
  }
  if (options?.channel !== undefined) {
    result.channel = options.channel;
  }
  if (options?.authority !== undefined) {
    result.authority = options.authority;
  }
  return result;
}

function parseTextDelta(notification: JsonRpcNotification): {
  itemId: string;
  delta: string;
} | null {
  if (!notification.params || typeof notification.params !== "object" || Array.isArray(notification.params)) {
    return null;
  }
  const params = notification.params as Record<string, unknown>;
  if (typeof params.itemId !== "string" || typeof params.delta !== "string") {
    return null;
  }
  return {
    itemId: params.itemId,
    delta: params.delta,
  };
}

function paramsRecord(notification: JsonRpcNotification): Record<string, unknown> | null {
  if (!notification.params || typeof notification.params !== "object" || Array.isArray(notification.params)) {
    return null;
  }
  return notification.params as Record<string, unknown>;
}

function recordField(record: Record<string, unknown>, key: string): Record<string, unknown> | null {
  const value = record[key];
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" ? value : null;
}

function optionalStringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function numberField(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" ? value : undefined;
}

function stringArrayField(record: Record<string, unknown>, key: string): string[] {
  const value = record[key];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function turnIdFromParams(params: Record<string, unknown>): string | undefined {
  return optionalStringField(params, "turnId") ?? optionalStringField(params, "turn_id");
}

function isCodexInternalEnvironmentMessage(text: string): boolean {
  return (
    text.includes("<environment_context>") &&
    (text.includes("<shell>") ||
      text.includes("<current_date>") ||
      text.includes("<timezone>") ||
      text.includes("<cwd>") ||
      text.includes("<approval_policy>"))
  );
}

function stripCodexContextualFragments(
  text: string,
  options: { trim?: boolean } = {},
): string {
  const stripped = text
    .replace(/<turn_aborted>[\s\S]*?<\/turn_aborted>/gi, "")
    .replace(/<user_shell_command>[\s\S]*?<\/user_shell_command>/gi, "")
    .replace(/<subagent_notification>[\s\S]*?<\/subagent_notification>/gi, "");
  return options.trim === false ? stripped : stripped.trim();
}

function itemIdFromParams(params: Record<string, unknown>): string | null {
  return stringField(params, "itemId") ?? stringField(params, "item_id");
}

function parsePlanUpdate(notification: JsonRpcNotification): string | null {
  if (!notification.params || typeof notification.params !== "object" || Array.isArray(notification.params)) {
    return null;
  }
  const params = notification.params as Record<string, unknown>;
  if (!Array.isArray(params.plan)) {
    return null;
  }
  const lines = params.plan
    .filter((entry) => entry && typeof entry === "object" && !Array.isArray(entry))
    .map((entry) => entry as Record<string, unknown>)
    .map((entry) => (typeof entry.step === "string" ? entry.step.trim() : ""))
    .filter(Boolean)
    .map((step) => (/^(#{1,6}\s|[-*+]\s|\d+\.\s)/.test(step) ? step : `- ${step}`));
  if (lines.length === 0) {
    return null;
  }
  return lines.join("\n");
}

function parseUsage(notification: JsonRpcNotification) {
  if (!notification.params || typeof notification.params !== "object" || Array.isArray(notification.params)) {
    return null;
  }
  const params = notification.params as Record<string, unknown>;
  const tokenUsage =
    params.tokenUsage && typeof params.tokenUsage === "object" && !Array.isArray(params.tokenUsage)
      ? (params.tokenUsage as Record<string, unknown>)
      : null;
  if (!tokenUsage) {
    return null;
  }

  const last =
    tokenUsage.last && typeof tokenUsage.last === "object" && !Array.isArray(tokenUsage.last)
      ? (tokenUsage.last as Record<string, unknown>)
      : null;
  const usage: ContextUsage = {};
  let hasUsage = false;
  if (typeof last?.total_tokens === "number") {
    usage.usedTokens = last.total_tokens;
    hasUsage = true;
  } else if (typeof last?.totalTokens === "number") {
    usage.usedTokens = last.totalTokens;
    hasUsage = true;
  }
  if (typeof tokenUsage.model_context_window === "number") {
    usage.contextWindow = tokenUsage.model_context_window;
    hasUsage = true;
  } else if (typeof tokenUsage.modelContextWindow === "number") {
    usage.contextWindow = tokenUsage.modelContextWindow;
    hasUsage = true;
  }
  if (!hasUsage) {
    return null;
  }
  usage.source = "codex.app_server.token_usage";
  return normalizeContextUsage(usage);
}

function parseExecCommandStart(notification: JsonRpcNotification): {
  callId: string;
  command: string;
  cwd?: string;
} | null {
  if (!notification.params || typeof notification.params !== "object" || Array.isArray(notification.params)) {
    return null;
  }
  const params = notification.params as Record<string, unknown>;
  const msg =
    params.msg && typeof params.msg === "object" && !Array.isArray(params.msg)
      ? (params.msg as Record<string, unknown>)
      : null;
  if (!msg || typeof msg.call_id !== "string") {
    return null;
  }
  const commandValue = msg.command;
  let command: string | null = null;
  if (typeof commandValue === "string") {
    command = commandValue;
  } else if (Array.isArray(commandValue)) {
    command = commandValue.filter((part): part is string => typeof part === "string").join(" ");
  }
  if (!command || !command.trim()) {
    return null;
  }
  return {
    callId: msg.call_id,
    command: command.trim(),
    ...(typeof msg.cwd === "string" ? { cwd: msg.cwd } : {}),
  };
}

function parseExecCommandEnd(notification: JsonRpcNotification): {
  callId: string;
  exitCode?: number;
  output?: string;
  stderr?: string;
} | null {
  if (!notification.params || typeof notification.params !== "object" || Array.isArray(notification.params)) {
    return null;
  }
  const params = notification.params as Record<string, unknown>;
  const msg =
    params.msg && typeof params.msg === "object" && !Array.isArray(params.msg)
      ? (params.msg as Record<string, unknown>)
      : null;
  if (!msg || typeof msg.call_id !== "string") {
    return null;
  }
  return {
    callId: msg.call_id,
    ...(typeof msg.exit_code === "number" ? { exitCode: msg.exit_code } : {}),
    ...(typeof msg.exitCode === "number" ? { exitCode: msg.exitCode } : {}),
    ...(typeof msg.aggregated_output === "string"
      ? { output: msg.aggregated_output }
      : typeof msg.aggregatedOutput === "string"
        ? { output: msg.aggregatedOutput }
        : typeof msg.stdout === "string"
          ? { output: msg.stdout }
          : {}),
    ...(typeof msg.stderr === "string" ? { stderr: msg.stderr } : {}),
  };
}

function appendDelta(store: Map<string, string[]>, key: string, chunk: string) {
  const existing = store.get(key) ?? [];
  existing.push(chunk);
  store.set(key, existing);
}

function appendDeltaIfNew(
  store: Map<string, string[]>,
  lastDeltaByKey: Map<string, string>,
  key: string,
  chunk: string,
): boolean {
  if (lastDeltaByKey.get(key) === chunk) {
    return false;
  }
  lastDeltaByKey.set(key, chunk);
  appendDelta(store, key, chunk);
  return true;
}

function consumeDelta(store: Map<string, string[]>, key: string): string | undefined {
  const existing = store.get(key);
  if (!existing || existing.length === 0) {
    return undefined;
  }
  store.delete(key);
  return existing.join("");
}

function parseDeltaChunk(notification: JsonRpcNotification): { callId: string; chunk: string } | null {
  if (!notification.params || typeof notification.params !== "object" || Array.isArray(notification.params)) {
    return null;
  }
  const params = notification.params as Record<string, unknown>;
  const msg =
    params.msg && typeof params.msg === "object" && !Array.isArray(params.msg)
      ? (params.msg as Record<string, unknown>)
      : null;
  if (!msg || typeof msg.call_id !== "string") {
    return null;
  }
  const chunk =
    (typeof msg.chunk === "string" ? msg.chunk : null) ??
    (typeof msg.delta === "string" ? msg.delta : null);
  if (!chunk) {
    return null;
  }
  return { callId: msg.call_id, chunk };
}

function parsePatchStart(notification: JsonRpcNotification): { callId: string } | null {
  if (!notification.params || typeof notification.params !== "object" || Array.isArray(notification.params)) {
    return null;
  }
  const params = notification.params as Record<string, unknown>;
  const msg =
    params.msg && typeof params.msg === "object" && !Array.isArray(params.msg)
      ? (params.msg as Record<string, unknown>)
      : null;
  if (!msg || typeof msg.call_id !== "string") {
    return null;
  }
  return { callId: msg.call_id };
}

function parsePatchEnd(notification: JsonRpcNotification): {
  callId: string;
  success?: boolean;
  stdout?: string;
  stderr?: string;
} | null {
  if (!notification.params || typeof notification.params !== "object" || Array.isArray(notification.params)) {
    return null;
  }
  const params = notification.params as Record<string, unknown>;
  const msg =
    params.msg && typeof params.msg === "object" && !Array.isArray(params.msg)
      ? (params.msg as Record<string, unknown>)
      : null;
  if (!msg || typeof msg.call_id !== "string") {
    return null;
  }
  return {
    callId: msg.call_id,
    ...(typeof msg.success === "boolean" ? { success: msg.success } : {}),
    ...(typeof msg.stdout === "string" ? { stdout: msg.stdout } : {}),
    ...(typeof msg.stderr === "string" ? { stderr: msg.stderr } : {}),
  };
}

function makeCommandToolCall(
  callId: string,
  command: string,
  cwd?: string,
  output?: string,
  exitCode?: number,
): ToolCall {
  const classified = classifyCodexCommand(command);
  const artifacts: ToolCallArtifact[] = [
    {
      kind: "command",
      command,
      ...(cwd !== undefined ? { cwd } : {}),
    },
  ];
  if (output) {
    artifacts.push({ kind: "text", label: "stdout", text: output });
  }
  return {
    id: callId,
    family: classified.family,
    providerToolName: "exec_command",
    title: classified.title,
    input: { command },
    ...(exitCode !== undefined ? { result: { exitCode } } : {}),
    ...(artifacts.length > 0 ? { detail: { artifacts } } : {}),
    ...(exitCode !== undefined ? { summary: `Process exited with code ${exitCode}.` } : {}),
  };
}

function makeCommandObservation(callId: string, command: string, cwd?: string): WorkbenchObservation {
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

function completeObservation(
  observation: WorkbenchObservation,
  params: { output?: string; exitCode?: number },
): WorkbenchObservation {
  const artifacts = [...(observation.detail?.artifacts ?? [])];
  if (params.output) {
    artifacts.push({ kind: "text", label: "output", text: params.output });
  }
  return {
    ...observation,
    status: params.exitCode !== undefined && params.exitCode !== 0 ? "failed" : "completed",
    ...(params.exitCode !== undefined ? { exitCode: params.exitCode } : {}),
    ...(params.exitCode !== undefined
      ? { summary: `Process exited with code ${params.exitCode}.` }
      : {}),
    detail: { artifacts },
  };
}

function updateObservationOutput(
  observation: WorkbenchObservation,
  output: string,
): WorkbenchObservation {
  return {
    ...observation,
    detail: {
      artifacts: [
        ...(observation.detail?.artifacts ?? []),
        { kind: "text", label: "output", text: output },
      ],
    },
  };
}

function makePatchToolCall(callId: string, output?: string, exitCode?: number): ToolCall {
  const artifacts: ToolCallArtifact[] = [];
  if (output) {
    artifacts.push({ kind: "text", label: "stdout", text: output });
  }
  return {
    id: callId,
    family: "patch",
    providerToolName: "apply_patch",
    title: "Apply patch",
    ...(exitCode !== undefined ? { result: { exitCode } } : {}),
    ...(artifacts.length > 0 ? { detail: { artifacts } } : {}),
    ...(output ? { summary: output.split(/\r?\n/)[0] } : {}),
  };
}

function makePatchObservation(callId: string): WorkbenchObservation {
  return {
    id: `obs-${callId}`,
    kind: "patch.apply",
    status: "running",
    title: "Apply patch",
    subject: {
      providerToolName: "apply_patch",
      providerCallId: callId,
    },
  };
}

function completePatchObservation(
  observation: WorkbenchObservation,
  params: { success: boolean; output?: string; error?: string },
): WorkbenchObservation {
  const artifacts = [...(observation.detail?.artifacts ?? [])];
  if (params.output) {
    artifacts.push({ kind: "text", label: "output", text: params.output });
  }
  if (params.error) {
    artifacts.push({ kind: "text", label: "stderr", text: params.error });
  }
  return {
    ...observation,
    status: params.success ? "completed" : "failed",
    summary: params.success ? "Patch applied." : "Patch apply failed.",
    detail: { artifacts },
  };
}

function makeInvalidStreamObservation(
  notification: JsonRpcNotification,
  reason: string,
): WorkbenchObservation {
  invalidStreamSequence += 1;
  return {
    id: `obs-invalid-stream-${invalidStreamSequence}`,
    kind: "runtime.invalid_stream",
    status: "completed",
    title: "Unhandled provider event",
    summary: `${notification.method}: ${reason}`,
    subject: {
      providerToolName: notification.method,
    },
    detail: {
      artifacts: [{ kind: "json", label: "raw", value: notification }],
    },
  };
}

function invalidStreamActivities(
  notification: JsonRpcNotification,
  reason: string,
): CodexLiveTranslatedActivity[] {
  return [
    translated(
      notification,
      {
        type: "observation_completed",
        observation: makeInvalidStreamObservation(notification, reason),
      },
      { channel: "structured_live", authority: "heuristic" },
    ),
  ];
}

function parseRetryCount(message: string): number | undefined {
  const match = /(?:reconnecting|retrying)[^\d]*(\d+)\s*\/\s*\d+/i.exec(message);
  if (!match?.[1]) {
    return undefined;
  }
  const count = Number.parseInt(match[1], 10);
  return Number.isFinite(count) ? count : undefined;
}

function runtimeStatusFromThreadStatus(status: unknown): ProviderActivity | null {
  if (!status || typeof status !== "object" || Array.isArray(status)) {
    return null;
  }
  const record = status as Record<string, unknown>;
  if (record.type === "notLoaded") {
    return { type: "session_state", state: "starting" };
  }
  if (record.type === "idle") {
    return { type: "session_state", state: "idle" };
  }
  if (record.type === "systemError") {
    return { type: "session_state", state: "failed" };
  }
  if (record.type === "active") {
    const flags = stringArrayField(record, "activeFlags");
    if (flags.includes("waitingOnApproval")) {
      return { type: "session_state", state: "waiting_permission" };
    }
    if (flags.includes("waitingOnUserInput")) {
      return { type: "session_state", state: "waiting_input" };
    }
    return { type: "session_state", state: "running" };
  }
  return null;
}

function makeOperationFromRun(run: Record<string, unknown>, kind: "started" | "resolved"): ProviderActivity {
  const id = stringField(run, "id") ?? `hook-${kind}-${Date.now().toString(36)}`;
  const eventName = stringField(run, "eventName") ?? "hook";
  const status = stringField(run, "status");
  const durationMs = numberField(run, "durationMs");
  const statusMessage = stringField(run, "statusMessage");
  const operation: RuntimeOperation = {
    id,
    kind: "automation",
    name: eventName,
    target: stringField(run, "handlerType") ?? stringField(run, "sourcePath") ?? "provider hook",
    ...(status === "blocked" ? { action: "block" } : status === "completed" ? { action: "allow" } : {}),
    ...(statusMessage ? { reason: statusMessage } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    input: run as never,
  };
  return kind === "started"
    ? { type: "operation_started", operation }
    : { type: "operation_resolved", operation };
}

function makeGuardianReviewOperation(
  params: Record<string, unknown>,
  kind: "started" | "resolved",
): ProviderActivity {
  const reviewId = stringField(params, "reviewId") ?? `guardian-${kind}`;
  const target = stringField(params, "targetItemId") ?? "permission review";
  const operation: RuntimeOperation = {
    id: reviewId,
    kind: "governance",
    name: "auto approval review",
    target,
    input: params as never,
  };
  const turnId = turnIdFromParams(params);
  const base: ProviderActivity = kind === "started"
    ? {
        type: "operation_started",
        operation,
      }
    : {
        type: "operation_resolved",
        operation,
      };
  return turnId !== undefined
    ? {
        ...base,
        turnId,
      }
    : base;
}

function withTurnId(activity: ProviderActivity, turnId: string | undefined): ProviderActivity {
  if (turnId === undefined) {
    return activity;
  }
  return {
    ...activity,
    turnId,
  } as ProviderActivity;
}

function commandStatusToObservationStatus(status: string | null | undefined): "running" | "completed" | "failed" {
  if (status === "completed") {
    return "completed";
  }
  if (status === "failed" || status === "declined") {
    return "failed";
  }
  return "running";
}

function statusIsTerminal(status: string | null | undefined): boolean {
  return status === "completed" || status === "failed" || status === "declined";
}

type FileChangeEntry = {
  path: string;
  diff?: string;
};

function firstStringField(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

function fileChangeEntryFromRecord(
  record: Record<string, unknown>,
  fallbackPath?: string,
): FileChangeEntry | null {
  const path = firstStringField(record, ["path", "file_path", "filePath", "file"]) ?? fallbackPath;
  if (!path) {
    return null;
  }
  const diff = firstStringField(record, [
    "diff",
    "patch",
    "unified_diff",
    "unifiedDiff",
    "content",
    "newString",
  ]);
  return {
    path,
    ...(diff !== undefined ? { diff } : {}),
  };
}

function parseFileChangeEntries(changes: unknown): FileChangeEntry[] {
  if (!changes) {
    return [];
  }

  if (Array.isArray(changes)) {
    return changes
      .flatMap((change) =>
        change && typeof change === "object" && !Array.isArray(change)
          ? [fileChangeEntryFromRecord(change as Record<string, unknown>)]
          : [],
      )
      .filter((entry): entry is FileChangeEntry => entry !== null);
  }

  if (typeof changes !== "object") {
    return [];
  }

  const record = changes as Record<string, unknown>;
  if (Array.isArray(record.files)) {
    return parseFileChangeEntries(record.files);
  }

  const single = fileChangeEntryFromRecord(record);
  if (single) {
    return [single];
  }

  return Object.entries(record)
    .flatMap(([path, value]) => {
      const normalizedPath = path.trim();
      if (!normalizedPath) {
        return [];
      }
      if (typeof value === "string" && value.length > 0) {
        return [{ path: normalizedPath, diff: value }];
      }
      if (value && typeof value === "object" && !Array.isArray(value)) {
        const entry = fileChangeEntryFromRecord(value as Record<string, unknown>, normalizedPath);
        return entry ? [entry] : [];
      }
      return [];
    });
}

function makeFileChangeToolCall(item: Record<string, unknown>): ToolCall {
  const changes = parseFileChangeEntries(item.changes ?? item.change ?? item);
  const files = [...new Set(changes.map((change) => change.path))];
  const diff = changes
    .map((change) => change.diff)
    .filter((text): text is string => Boolean(text))
    .join("\n\n");
  const artifacts: ToolCallArtifact[] = [];
  if (diff) {
    artifacts.push({ kind: "diff", format: "unified", text: diff });
  }
  if (files.length > 0) {
    artifacts.push({ kind: "file_refs", files });
  }
  return {
    id: stringField(item, "id") ?? "file-change",
    family: "patch",
    providerToolName: "fileChange",
    title: "Apply file changes",
    ...(files.length > 0 ? { input: { files } } : {}),
    ...(artifacts.length > 0 ? { detail: { artifacts } } : {}),
    ...(files.length > 0
      ? { summary: files.length === 1 ? files[0] : `${files[0]} (+${files.length - 1} files)` }
      : {}),
    ...(statusIsTerminal(stringField(item, "status"))
      ? { result: { success: stringField(item, "status") === "completed" } }
      : {}),
  };
}

function makeFileChangeObservation(item: Record<string, unknown>): WorkbenchObservation {
  const toolCall = makeFileChangeToolCall(item);
  const status = commandStatusToObservationStatus(stringField(item, "status"));
  const files = toolCall.detail?.artifacts
    .flatMap((artifact) => artifact.kind === "file_refs" ? artifact.files : [])
    ?? [];
  return {
    id: `obs-${toolCall.id}`,
    kind: "patch.apply",
    status,
    title: "Apply file changes",
    ...(files.length > 0 ? { subject: { files, providerCallId: toolCall.id } } : { subject: { providerCallId: toolCall.id } }),
    ...(toolCall.detail !== undefined ? { detail: toolCall.detail } : {}),
  };
}

function makeMcpToolCall(item: Record<string, unknown>): ToolCall {
  const id = stringField(item, "id") ?? "mcp-tool-call";
  const server = stringField(item, "server") ?? "mcp";
  const tool = stringField(item, "tool") ?? "tool";
  const result = recordField(item, "result");
  const error = recordField(item, "error");
  return {
    id,
    family: "mcp",
    providerToolName: `${server}.${tool}`,
    title: `${server}: ${tool}`,
    input: { arguments: item.arguments },
    ...(result ? { result } : error ? { result: error } : {}),
    detail: {
      artifacts: [
        { kind: "json", label: "arguments", value: item.arguments ?? null },
        ...(result ? [{ kind: "json" as const, label: "result", value: result }] : []),
        ...(error ? [{ kind: "json" as const, label: "error", value: error }] : []),
      ],
    },
  };
}

function makeGenericObservation(
  item: Record<string, unknown>,
  kind: WorkbenchObservation["kind"],
  title: string,
  status: WorkbenchObservation["status"],
): WorkbenchObservation {
  const id = stringField(item, "id") ?? `${kind}-${Date.now().toString(36)}`;
  return {
    id: `obs-${id}`,
    kind,
    status,
    title,
    subject: {
      providerCallId: id,
      ...(stringField(item, "query") ? { query: stringField(item, "query")! } : {}),
      ...(stringField(item, "path") ? { files: [stringField(item, "path")!] } : {}),
    },
    detail: {
      artifacts: [{ kind: "json", label: "item", value: item }],
    },
  };
}

function mapThreadItem(
  item: Record<string, unknown>,
  phase: "started" | "completed",
  turnId: string,
  state: CodexAppServerTranslationState,
): ProviderActivity[] {
  const itemType = stringField(item, "type");
  const id = stringField(item, "id") ?? `${itemType ?? "item"}-${Date.now().toString(36)}`;
  switch (itemType) {
    case "userMessage": {
      if (state.emittedUserMessageItemIds.has(id)) {
        return [];
      }
      const content = Array.isArray(item.content) ? item.content : [];
      const text = stripCodexContextualFragments(
        content
        .filter((part): part is Record<string, unknown> => Boolean(part) && typeof part === "object" && !Array.isArray(part))
        .map((part) => stringField(part, "text") ?? stringField(part, "url") ?? stringField(part, "path") ?? "")
        .filter(Boolean)
        .join("\n"),
      );
      if (text && isCodexInternalEnvironmentMessage(text)) {
        state.emittedUserMessageItemIds.add(id);
        return [];
      }
      const activities: ProviderActivity[] = text
        ? [
            { type: "message_part_added", turnId, part: { messageId: id, partId: id, kind: "text", text } },
            { type: "timeline_item", turnId, item: { kind: "user_message", text, messageId: id } },
          ]
        : [{ type: "message_part_added", turnId, part: { messageId: id, partId: id, kind: "unknown", metadata: item as never } }];
      state.emittedUserMessageItemIds.add(id);
      return activities;
    }
    case "agentMessage": {
      if (phase !== "completed") {
        return [];
      }
      if (state.completedAgentMessageItemIds.has(id)) {
        return [];
      }
      const text = stringField(item, "text") ?? "";
      const buffered = (state.agentMessageByItemId.get(id) ?? []).join("");
      const finalText = stripCodexContextualFragments(text || buffered);
      state.completedAgentMessageItemIds.add(id);
      state.agentMessageByItemId.delete(id);
      state.lastAgentMessageDeltaByItemId.delete(id);
      if (!finalText) {
        return [];
      }
      if (state.emittedAgentMessageDeltaItemIds.has(id)) {
        return [
          { type: "message_part_updated", turnId, part: { messageId: id, partId: id, kind: "text", text: finalText } },
          { type: "timeline_item_updated", turnId, item: { kind: "assistant_message", text: finalText, messageId: id } },
        ];
      }
      return [
        { type: "message_part_added", turnId, part: { messageId: id, partId: id, kind: "text", text: finalText } },
        { type: "timeline_item", turnId, item: { kind: "assistant_message", text: finalText, messageId: id } },
      ];
    }
    case "plan": {
      const text = stringField(item, "text") ?? "";
      return [
        { type: "message_part_added", turnId, part: { messageId: id, partId: id, kind: "step", text } },
        ...(text ? [{ type: "timeline_item" as const, turnId, item: { kind: "plan" as const, text } }] : []),
      ];
    }
    case "reasoning": {
      if (phase !== "completed") {
        return [];
      }
      if (state.completedReasoningItemIds.has(id)) {
        return [];
      }
      const summary = Array.isArray(item.summary) ? item.summary.filter((value): value is string => typeof value === "string") : [];
      const content = Array.isArray(item.content) ? item.content.filter((value): value is string => typeof value === "string") : [];
      const buffered = (state.reasoningByItemId.get(id) ?? []).join("");
      const text = [...summary, ...content].join("\n").trim() || buffered;
      state.completedReasoningItemIds.add(id);
      state.reasoningByItemId.delete(id);
      state.lastReasoningDeltaByItemId.delete(id);
      if (!text) {
        return [];
      }
      if (state.emittedReasoningDeltaItemIds.has(id)) {
        return [
          { type: "message_part_updated", turnId, part: { messageId: id, partId: id, kind: "reasoning", text } },
        ];
      }
      return [
        { type: "message_part_added", turnId, part: { messageId: id, partId: id, kind: "reasoning", text } },
        { type: "timeline_item", turnId, item: { kind: "reasoning", text } },
      ];
    }
    case "commandExecution": {
      const command = stringField(item, "command") ?? "unknown";
      const cwd = optionalStringField(item, "cwd");
      const exitCode = numberField(item, "exitCode");
      const output = optionalStringField(item, "aggregatedOutput");
      const toolCall = makeCommandToolCall(id, command, cwd, output, exitCode);
      const observation = completeObservation(makeCommandObservation(id, command, cwd), {
        ...(output !== undefined ? { output } : {}),
        ...(exitCode !== undefined ? { exitCode } : {}),
      });
      const status = stringField(item, "status");
      if (phase === "started" || !statusIsTerminal(status)) {
        return [
          { type: "observation_started", turnId, observation: makeCommandObservation(id, command, cwd) },
          { type: "tool_call_started", turnId, toolCall },
        ];
      }
      return observation.status === "failed"
        ? [
            { type: "observation_failed", turnId, observation, error: output ?? "Command failed" },
            { type: "tool_call_failed", turnId, toolCallId: id, error: output ?? "Command failed" },
          ]
        : [
            { type: "observation_completed", turnId, observation },
            { type: "tool_call_completed", turnId, toolCall },
          ];
    }
    case "fileChange": {
      const toolCall = makeFileChangeToolCall(item);
      const observation = makeFileChangeObservation(item);
      if (phase === "started" || observation.status === "running") {
        return [
          { type: "observation_started", turnId, observation: { ...observation, status: "running" } },
          { type: "tool_call_started", turnId, toolCall },
        ];
      }
      return observation.status === "failed"
        ? [
            { type: "observation_failed", turnId, observation, error: "File change failed" },
            { type: "tool_call_failed", turnId, toolCallId: toolCall.id, error: "File change failed" },
          ]
        : [
            { type: "observation_completed", turnId, observation },
            { type: "tool_call_completed", turnId, toolCall },
          ];
    }
    case "mcpToolCall": {
      const toolCall = makeMcpToolCall(item);
      const status = stringField(item, "status");
      const observation = makeGenericObservation(
        item,
        "mcp.call",
        toolCall.title ?? "MCP tool call",
        status === "completed" ? "completed" : status === "failed" ? "failed" : "running",
      );
      if (phase === "started" || observation.status === "running") {
        return [
          { type: "observation_started", turnId, observation },
          { type: "tool_call_started", turnId, toolCall },
        ];
      }
      return observation.status === "failed"
        ? [
            {
              type: "observation_failed",
              turnId,
              observation,
              ...(typeof recordField(item, "error")?.message === "string"
                ? { error: recordField(item, "error")!.message as string }
                : {}),
            },
            { type: "tool_call_failed", turnId, toolCallId: toolCall.id, error: String(recordField(item, "error")?.message ?? "MCP tool failed") },
          ]
        : [
            { type: "observation_completed", turnId, observation },
            { type: "tool_call_completed", turnId, toolCall },
          ];
    }
    case "dynamicToolCall":
      return [
        {
          type: phase === "started" ? "operation_requested" : "operation_resolved",
          turnId,
          operation: {
            id,
            kind: "external_tool",
            name: stringField(item, "tool") ?? "dynamic tool",
            target: "client",
            input: item as never,
          },
        },
      ];
    case "collabAgentToolCall": {
      const status = stringField(item, "status");
      const observation = makeGenericObservation(
        item,
        "subagent.lifecycle",
        stringField(item, "tool") ?? "Subagent activity",
        status === "completed" ? "completed" : status === "failed" ? "failed" : "running",
      );
      return [
        phase === "started" || observation.status === "running"
          ? { type: "observation_started", turnId, observation }
          : observation.status === "failed"
            ? { type: "observation_failed", turnId, observation, error: "Subagent activity failed" }
            : { type: "observation_completed", turnId, observation },
      ];
    }
    case "webSearch": {
      const observation = makeGenericObservation(item, "web.search", "Web search", phase === "started" ? "running" : "completed");
      return [
        phase === "started"
          ? { type: "observation_started", turnId, observation }
          : { type: "observation_completed", turnId, observation },
      ];
    }
    case "imageView":
    case "imageGeneration": {
      const observation = makeGenericObservation(item, "media.read", itemType === "imageView" ? "View image" : "Generate image", phase === "started" ? "running" : "completed");
      return [
        phase === "started"
          ? { type: "observation_started", turnId, observation }
          : { type: "observation_completed", turnId, observation },
      ];
    }
    case "contextCompaction":
      return [
        { type: "timeline_item", turnId, item: { kind: "compaction", status: phase === "started" ? "started" : "completed" } },
      ];
    case "hookPrompt": {
      return [
        {
          type: "timeline_item",
          turnId,
          item: {
            kind: "system",
            text: "Hook prompt generated.",
          },
        },
      ];
    }
    case "enteredReviewMode":
    case "exitedReviewMode":
      return [
        {
          type: "operation_resolved",
          turnId,
          operation: {
            id,
            kind: "governance",
            name: itemType,
            target: "review",
            input: item as never,
          },
        },
      ];
    default:
      return [
        {
          type: "observation_completed",
          turnId,
          observation: {
            id: `obs-${id}`,
            kind: "unknown",
            status: "completed",
            title: `Unhandled item ${itemType ?? "unknown"}`,
            subject: { providerCallId: id, providerToolName: itemType ?? "unknown" },
            detail: { artifacts: [{ kind: "json", label: "item", value: item }] },
          },
        },
      ];
  }
}

function makeTerminalCommandPreamble(command: string): string {
  return `$ ${command}\r\n`;
}

function makeTerminalCommandCompletion(exitCode?: number): string {
  if (exitCode !== undefined) {
    return `\r\n[exit ${exitCode}]\r\n$ `;
  }
  return "\r\n[command finished]\r\n$ ";
}

function makeTerminalOutputFallback(output?: string, stderr?: string): string | undefined {
  if (output && output.length > 0) {
    return output;
  }
  if (stderr && stderr.length > 0) {
    return stderr;
  }
  return undefined;
}

type QuestionDescriptor = {
  id: string;
  header: string;
  question: string;
  options: Array<{ label: string; description?: string }>;
};

function normalizeQuestions(raw: unknown): QuestionDescriptor[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw
    .filter((entry) => entry && typeof entry === "object" && !Array.isArray(entry))
    .map((entry) => entry as Record<string, unknown>)
    .flatMap((entry): QuestionDescriptor[] => {
      if (
        typeof entry.id !== "string" ||
        typeof entry.header !== "string" ||
        typeof entry.question !== "string"
      ) {
        return [];
      }
      const options = Array.isArray(entry.options)
        ? entry.options
            .filter((option) => option && typeof option === "object" && !Array.isArray(option))
            .map((option) => option as Record<string, unknown>)
            .flatMap((option) =>
              typeof option.label === "string"
                ? [
                    {
                      label: option.label,
                      ...(typeof option.description === "string"
                        ? { description: option.description }
                        : {}),
                    },
                  ]
                : [],
            )
        : [];
      return [
        {
          id: entry.id,
          header: entry.header,
          question: entry.question,
          options,
        },
      ];
    });
}

export function translateCodexAppServerNotification(
  notification: JsonRpcNotification,
  state: CodexAppServerTranslationState,
): CodexLiveTranslatedActivity[] {
  if (CODEX_APP_SERVER_IGNORED_NOTIFICATION_METHOD_SET.has(notification.method)) {
    return [];
  }

  switch (notification.method) {
    case "error": {
      const params = paramsRecord(notification);
      if (!params) {
        return invalidStreamActivities(notification, "error params were not an object");
      }
      const error = recordField(params, "error");
      const message = stringField(error ?? {}, "message") ?? "Codex error";
      const turnId = turnIdFromParams(params);
      if (params.willRetry === true) {
        const retryCount = parseRetryCount(message);
        return [
          translated(notification, {
            type: "runtime_status",
            status: "retrying",
            detail: message,
            ...(retryCount !== undefined ? { retryCount } : {}),
            ...(turnId !== undefined ? { turnId } : {}),
          }),
        ];
      }
      return turnId
        ? [translated(notification, { type: "turn_failed", turnId, error: message })]
        : [
            translated(notification, {
              type: "notification",
              level: "critical",
              title: "Codex error",
              body: message,
            }),
          ];
    }
    case "thread/started":
      return [
        translated(notification, {
          type: "runtime_status",
          status: "session_active",
          detail: "Thread started",
        }),
      ];
    case "thread/status/changed": {
      const params = paramsRecord(notification);
      if (!params) {
        return invalidStreamActivities(notification, "thread/status/changed params were not an object");
      }
      const activity = runtimeStatusFromThreadStatus(params.status);
      return activity ? [translated(notification, activity)] : invalidStreamActivities(notification, "thread status was not recognized");
    }
    case "thread/closed":
      return [translated(notification, { type: "session_exited", exitCode: 0 })];
    case "turn/started": {
      if (!notification.params || typeof notification.params !== "object" || Array.isArray(notification.params)) {
        return invalidStreamActivities(notification, "turn/started params were not an object");
      }
      const params = notification.params as Record<string, unknown>;
      const turn =
        params.turn && typeof params.turn === "object" && !Array.isArray(params.turn)
          ? (params.turn as Record<string, unknown>)
          : null;
      if (!turn || typeof turn.id !== "string") {
        return invalidStreamActivities(notification, "turn/started did not include turn.id");
      }
      return [translated(notification, { type: "turn_started", turnId: turn.id })];
    }
    case "hook/started": {
      const params = paramsRecord(notification);
      const run = params ? recordField(params, "run") : null;
      if (!run) {
        return invalidStreamActivities(notification, "hook/started did not include run");
      }
      const activity = makeOperationFromRun(run, "started");
      return [translated(notification, withTurnId(activity, turnIdFromParams(params!)))];
    }
    case "turn/completed": {
      if (!notification.params || typeof notification.params !== "object" || Array.isArray(notification.params)) {
        return invalidStreamActivities(notification, "turn/completed params were not an object");
      }
      const params = notification.params as Record<string, unknown>;
      const turn =
        params.turn && typeof params.turn === "object" && !Array.isArray(params.turn)
          ? (params.turn as Record<string, unknown>)
          : null;
      if (!turn || typeof turn.status !== "string") {
        return invalidStreamActivities(notification, "turn/completed did not include turn.status");
      }
      const turnId = typeof turn.id === "string" ? turn.id : "current-turn";
      if (turn.status === "failed") {
        const error =
          turn.error && typeof turn.error === "object" && !Array.isArray(turn.error)
            ? (turn.error as Record<string, unknown>)
            : null;
        return [
          translated(notification, {
            type: "turn_failed",
            turnId,
            error: typeof error?.message === "string" ? error.message : "Codex turn failed",
          }),
        ];
      }
      if (turn.status === "interrupted") {
        return [
          translated(notification, {
            type: "turn_canceled",
            turnId,
            reason: "interrupted",
          }),
        ];
      }
      return [translated(notification, { type: "turn_completed", turnId })];
    }
    case "hook/completed": {
      const params = paramsRecord(notification);
      const run = params ? recordField(params, "run") : null;
      if (!run) {
        return invalidStreamActivities(notification, "hook/completed did not include run");
      }
      const activity = makeOperationFromRun(run, "resolved");
      return [translated(notification, withTurnId(activity, turnIdFromParams(params!)))];
    }
    case "turn/diff/updated": {
      const params = paramsRecord(notification);
      if (!params || !stringField(params, "turnId")) {
        return invalidStreamActivities(notification, "turn/diff/updated did not include turnId");
      }
      const turnId = stringField(params, "turnId")!;
      const diff = stringField(params, "diff") ?? "";
      return [
        translated(notification, {
          type: "observation_updated",
          turnId,
          observation: {
            id: `obs-turn-diff-${turnId}`,
            kind: "patch.apply",
            status: "running",
            title: "Turn diff updated",
            detail: { artifacts: [{ kind: "diff", format: "unified", text: diff }] },
          },
        }),
      ];
    }
    case "thread/tokenUsage/updated": {
      const usage = parseUsage(notification);
      if (!usage) {
        return invalidStreamActivities(notification, "token usage payload was not recognized");
      }
      return [
        translated(notification, {
          type: "usage",
          usage,
        }),
      ];
    }
    case "item/started":
    case "item/completed": {
      const params = paramsRecord(notification);
      const item = params ? recordField(params, "item") : null;
      const turnId = params ? turnIdFromParams(params) : undefined;
      if (!item || !turnId) {
        return invalidStreamActivities(notification, `${notification.method} did not include item and turnId`);
      }
      const phase = notification.method === "item/started" ? "started" : "completed";
      return mapThreadItem(item, phase, turnId, state).map((activity) => translated(notification, activity));
    }
    case "item/autoApprovalReview/started": {
      const params = paramsRecord(notification);
      return params
        ? [translated(notification, makeGuardianReviewOperation(params, "started"))]
        : invalidStreamActivities(notification, "auto approval review started params were not an object");
    }
    case "item/autoApprovalReview/completed": {
      const params = paramsRecord(notification);
      return params
        ? [translated(notification, makeGuardianReviewOperation(params, "resolved"))]
        : invalidStreamActivities(notification, "auto approval review completed params were not an object");
    }
    case "item/agentMessage/delta": {
      const delta = parseTextDelta(notification);
      if (!delta) {
        return invalidStreamActivities(notification, "agent message delta payload was not recognized");
      }
      const visibleDelta = stripCodexContextualFragments(delta.delta, { trim: false });
      if (visibleDelta.length === 0) {
        return [];
      }
      const hasEmittedTimeline = state.emittedAgentMessageDeltaItemIds.has(delta.itemId);
      if (!appendDeltaIfNew(
        state.agentMessageByItemId,
        state.lastAgentMessageDeltaByItemId,
        delta.itemId,
        visibleDelta,
      )) {
        return [];
      }
      const fullText = (state.agentMessageByItemId.get(delta.itemId) ?? []).join("");
      const timelineActivity =
        fullText.trim().length > 0
          ? [
              translated(notification, {
                type: hasEmittedTimeline ? "timeline_item_updated" : "timeline_item",
                item: { kind: "assistant_message", text: fullText, messageId: delta.itemId },
              }),
            ]
          : [];
      if (timelineActivity.length > 0) {
        state.emittedAgentMessageDeltaItemIds.add(delta.itemId);
      }
      return [
        translated(notification, {
          type: "message_part_delta",
          part: {
            messageId: delta.itemId,
            partId: delta.itemId,
            kind: "text",
            delta: visibleDelta,
          },
        }),
        ...timelineActivity,
      ];
    }
    case "item/plan/delta": {
      const delta = parseTextDelta(notification);
      if (!delta) {
        return invalidStreamActivities(notification, "plan delta payload was not recognized");
      }
      return [
        translated(notification, {
          type: "message_part_delta",
          part: {
            messageId: delta.itemId,
            partId: delta.itemId,
            kind: "step",
            delta: delta.delta,
          },
        }),
      ];
    }
    case "item/reasoning/summaryTextDelta": {
      const delta = parseTextDelta(notification);
      if (!delta) {
        return invalidStreamActivities(notification, "reasoning delta payload was not recognized");
      }
      if (!appendDeltaIfNew(
        state.reasoningByItemId,
        state.lastReasoningDeltaByItemId,
        delta.itemId,
        delta.delta,
      )) {
        return [];
      }
      state.emittedReasoningDeltaItemIds.add(delta.itemId);
      return [
        translated(notification, {
          type: "message_part_delta",
          part: {
            messageId: delta.itemId,
            partId: delta.itemId,
            kind: "reasoning",
            delta: delta.delta,
          },
        }),
        translated(notification, {
          type: "timeline_item",
          item: { kind: "reasoning", text: delta.delta },
        }),
      ];
    }
    case "item/reasoning/summaryPartAdded": {
      const params = paramsRecord(notification);
      const itemId = params ? itemIdFromParams(params) : null;
      if (!itemId) {
        return invalidStreamActivities(notification, "reasoning summary part added payload was not recognized");
      }
      const sectionKey = `${itemId}:${String(params?.summaryIndex ?? 0)}`;
      if (state.reasoningSectionBreakKeys.has(sectionKey)) {
        return [];
      }
      state.reasoningSectionBreakKeys.add(sectionKey);
      return [
        translated(notification, {
          type: "message_part_added",
          part: {
            messageId: itemId,
            partId: `${itemId}:summary:${String(params?.summaryIndex ?? 0)}`,
            kind: "reasoning",
          },
        }),
      ];
    }
    case "item/reasoning/textDelta": {
      const delta = parseTextDelta(notification);
      if (!delta) {
        return invalidStreamActivities(notification, "reasoning text delta payload was not recognized");
      }
      if (!appendDeltaIfNew(
        state.reasoningByItemId,
        state.lastReasoningDeltaByItemId,
        delta.itemId,
        delta.delta,
      )) {
        return [];
      }
      state.emittedReasoningDeltaItemIds.add(delta.itemId);
      return [
        translated(notification, {
          type: "message_part_delta",
          part: {
            messageId: delta.itemId,
            partId: `${delta.itemId}:content`,
            kind: "reasoning",
            delta: delta.delta,
          },
        }),
        translated(notification, {
          type: "timeline_item",
          item: { kind: "reasoning", text: delta.delta },
        }),
      ];
    }
    case "turn/plan/updated": {
      const text = parsePlanUpdate(notification);
      if (!text) {
        return invalidStreamActivities(notification, "plan update payload was not recognized");
      }
      return [
        translated(notification, {
          type: "timeline_item",
          item: { kind: "plan", text },
        }),
      ];
    }
    case "codex/event/exec_command_begin": {
      const parsed = parseExecCommandStart(notification);
      if (!parsed) {
        return invalidStreamActivities(notification, "exec command begin payload was not recognized");
      }
      const toolCall = makeCommandToolCall(parsed.callId, parsed.command, parsed.cwd);
      const observation = makeCommandObservation(parsed.callId, parsed.command, parsed.cwd);
      state.pendingToolCalls.set(parsed.callId, { toolCall });
      state.commandObservationByCallId.set(parsed.callId, observation);
      state.commandOutputByCallId.delete(parsed.callId);
      state.lastCommandOutputDeltaByCallId.delete(parsed.callId);
      return [
        translated(notification, { type: "observation_started", observation }),
        translated(notification, { type: "tool_call_started", toolCall }),
        translated(notification, {
          type: "terminal_output",
          data: makeTerminalCommandPreamble(parsed.command),
        }),
      ];
    }
    case "item/commandExecution/outputDelta": {
      const parsed = parseTextDelta(notification);
      if (!parsed) {
        return invalidStreamActivities(notification, "command execution output delta payload was not recognized");
      }
      if (!appendDeltaIfNew(
        state.commandOutputByCallId,
        state.lastCommandOutputDeltaByCallId,
        parsed.itemId,
        parsed.delta,
      )) {
        return [];
      }
      const output = state.commandOutputByCallId.get(parsed.itemId)?.join("") ?? parsed.delta;
      const observation = state.commandObservationByCallId.get(parsed.itemId);
      return [
        ...(observation
          ? [
              translated(notification, {
                type: "observation_updated",
                observation: updateObservationOutput(observation, output),
              }),
            ]
          : []),
        translated(notification, {
          type: "tool_call_delta",
          toolCallId: parsed.itemId,
          detail: {
            artifacts: [{ kind: "text", label: "stdout", text: parsed.delta }],
          },
        }),
        translated(notification, {
          type: "terminal_output",
          data: parsed.delta,
        }),
      ];
    }
    case "command/exec/outputDelta": {
      const params = paramsRecord(notification);
      if (!params || !stringField(params, "processId")) {
        return invalidStreamActivities(notification, "command/exec output delta payload was not recognized");
      }
      const processId = stringField(params, "processId")!;
      const deltaBase64 = stringField(params, "deltaBase64") ?? "";
      const stream = stringField(params, "stream") ?? "output";
      const data = Buffer.from(deltaBase64, "base64").toString("utf8");
      return [
        translated(notification, {
          type: "observation_updated",
          observation: {
            id: `obs-command-exec-${processId}`,
            kind: "terminal.interaction",
            status: params.capReached === true ? "completed" : "running",
            title: "Command exec output",
            subject: { providerCallId: processId },
            detail: { artifacts: [{ kind: "text", label: stream, text: data }] },
          },
        }),
        translated(notification, { type: "terminal_output", data }),
      ];
    }
    case "codex/event/exec_command_output_delta": {
      const parsed = parseDeltaChunk(notification);
      if (!parsed) {
        return invalidStreamActivities(notification, "exec command output delta payload was not recognized");
      }
      if (!appendDeltaIfNew(
        state.commandOutputByCallId,
        state.lastCommandOutputDeltaByCallId,
        parsed.callId,
        parsed.chunk,
      )) {
        return [];
      }
      const output = state.commandOutputByCallId.get(parsed.callId)?.join("") ?? parsed.chunk;
      const observation = state.commandObservationByCallId.get(parsed.callId);
      return [
        ...(observation
          ? [
              translated(notification, {
                type: "observation_updated",
                observation: updateObservationOutput(observation, output),
              }),
            ]
          : []),
        translated(notification, {
          type: "tool_call_delta",
          toolCallId: parsed.callId,
          detail: {
            artifacts: [{ kind: "text", label: "stdout", text: parsed.chunk }],
          },
        }),
        translated(notification, {
          type: "terminal_output",
          data: parsed.chunk,
        }),
      ];
    }
    case "codex/event/exec_command_end": {
      const parsed = parseExecCommandEnd(notification);
      if (!parsed) {
        return invalidStreamActivities(notification, "exec command end payload was not recognized");
      }
      const pending = state.pendingToolCalls.get(parsed.callId);
      const hadDeltaOutput = (state.commandOutputByCallId.get(parsed.callId)?.length ?? 0) > 0;
      const deltaOutput = consumeDelta(state.commandOutputByCallId, parsed.callId);
      const pendingObservation = state.commandObservationByCallId.get(parsed.callId);
      state.commandObservationByCallId.delete(parsed.callId);
      state.pendingToolCalls.delete(parsed.callId);
      state.lastCommandOutputDeltaByCallId.delete(parsed.callId);
      const output = parsed.output ?? deltaOutput;
      const toolCall = pending?.toolCall
        ? {
            ...pending.toolCall,
            ...(output ? { detail: { artifacts: [...(pending.toolCall.detail?.artifacts ?? []), { kind: "text", label: "stdout", text: output } as ToolCallArtifact] } } : {}),
            ...(parsed.exitCode !== undefined ? { result: { exitCode: parsed.exitCode } } : {}),
            ...(parsed.exitCode !== undefined ? { summary: `Process exited with code ${parsed.exitCode}.` } : {}),
          }
        : makeCommandToolCall(parsed.callId, "unknown", undefined, output, parsed.exitCode);
      const completedObservation = pendingObservation
        ? completeObservation(pendingObservation, {
            ...(output !== undefined ? { output } : {}),
            ...(parsed.exitCode !== undefined ? { exitCode: parsed.exitCode } : {}),
          })
        : null;
      const completed = [
        ...(completedObservation
          ? [
              translated(
                notification,
                completedObservation.status === "failed"
                  ? {
                      type: "observation_failed",
                      observation: completedObservation,
                      ...(output !== undefined ? { error: output } : {}),
                    }
                  : {
                      type: "observation_completed",
                      observation: completedObservation,
                    },
              ),
            ]
          : []),
        translated(notification, { type: "tool_call_completed", toolCall }),
      ];
      const terminalActivities: CodexLiveTranslatedActivity[] = [];
      if (!hadDeltaOutput) {
        const fallbackOutput = makeTerminalOutputFallback(parsed.output, parsed.stderr);
        if (fallbackOutput) {
          terminalActivities.push(
            translated(notification, {
              type: "terminal_output",
              data: fallbackOutput,
            }),
          );
        }
      }
      terminalActivities.push(
        translated(notification, {
          type: "terminal_output",
          data: makeTerminalCommandCompletion(parsed.exitCode),
        }),
      );
      return [...completed, ...terminalActivities];
    }
    case "item/commandExecution/terminalInteraction": {
      const params = paramsRecord(notification);
      if (!params || !stringField(params, "itemId")) {
        return invalidStreamActivities(notification, "terminal interaction payload was not recognized");
      }
      const itemId = stringField(params, "itemId")!;
      return [
        translated(notification, {
          type: "observation_completed",
          observation: {
            id: `obs-terminal-interaction-${itemId}-${Date.now().toString(36)}`,
            kind: "terminal.interaction",
            status: "completed",
            title: "Terminal input",
            subject: {
              providerCallId: itemId,
              ...(stringField(params, "processId") ? { providerToolName: stringField(params, "processId")! } : {}),
            },
            detail: {
              artifacts: [{ kind: "text", label: "stdin", text: stringField(params, "stdin") ?? "" }],
            },
          },
        }),
      ];
    }
    case "codex/event/patch_apply_begin": {
      const parsed = parsePatchStart(notification);
      if (!parsed) {
        return invalidStreamActivities(notification, "patch begin payload was not recognized");
      }
      const toolCall = makePatchToolCall(parsed.callId);
      const observation = makePatchObservation(parsed.callId);
      state.pendingToolCalls.set(parsed.callId, { toolCall });
      state.patchObservationByCallId.set(parsed.callId, observation);
      state.patchOutputByCallId.delete(parsed.callId);
      state.lastPatchOutputDeltaByCallId.delete(parsed.callId);
      return [
        translated(notification, { type: "observation_started", observation }),
        translated(notification, { type: "tool_call_started", toolCall }),
      ];
    }
    case "item/fileChange/outputDelta": {
      const delta = parseTextDelta(notification);
      if (!delta) {
        return invalidStreamActivities(notification, "file change output delta payload was not recognized");
      }
      if (!appendDeltaIfNew(
        state.patchOutputByCallId,
        state.lastPatchOutputDeltaByCallId,
        delta.itemId,
        delta.delta,
      )) {
        return [];
      }
      const output = state.patchOutputByCallId.get(delta.itemId)?.join("") ?? delta.delta;
      const observation = state.patchObservationByCallId.get(delta.itemId);
      return [
        ...(observation
          ? [
              translated(notification, {
                type: "observation_updated",
                observation: updateObservationOutput(observation, output),
              }),
            ]
          : []),
        translated(notification, {
          type: "tool_call_delta",
          toolCallId: delta.itemId,
          detail: {
            artifacts: [{ kind: "text", label: "stdout", text: delta.delta }],
          },
        }),
      ];
    }
    case "codex/event/patch_apply_end": {
      const parsed = parsePatchEnd(notification);
      if (!parsed) {
        return invalidStreamActivities(notification, "patch end payload was not recognized");
      }
      const pending = state.pendingToolCalls.get(parsed.callId);
      const deltaOutput = consumeDelta(state.patchOutputByCallId, parsed.callId);
      const pendingObservation = state.patchObservationByCallId.get(parsed.callId);
      state.pendingToolCalls.delete(parsed.callId);
      state.patchObservationByCallId.delete(parsed.callId);
      state.lastPatchOutputDeltaByCallId.delete(parsed.callId);
      const stdout = parsed.stdout ?? deltaOutput;
      if (parsed.success === false) {
        return [
          ...(pendingObservation
            ? [
                translated(notification, {
                  type: "observation_failed",
                  observation: completePatchObservation(pendingObservation, {
                    success: false,
                    ...(stdout !== undefined ? { output: stdout } : {}),
                    ...(parsed.stderr !== undefined ? { error: parsed.stderr } : {}),
                  }),
                  error: parsed.stderr ?? "Patch apply failed",
                }),
              ]
            : []),
          translated(notification, {
            type: "tool_call_failed",
            toolCallId: parsed.callId,
            error: parsed.stderr ?? "Patch apply failed",
          }),
        ];
      }
      const toolCall = pending?.toolCall
        ? {
            ...pending.toolCall,
            ...(stdout ? { detail: { artifacts: [{ kind: "text", label: "stdout", text: stdout } as ToolCallArtifact] } } : {}),
            ...(parsed.success === true ? { result: { success: true } } : {}),
            ...(stdout ? { summary: stdout.split(/\r?\n/)[0] } : {}),
          }
        : makePatchToolCall(parsed.callId, stdout, parsed.success === true ? 0 : undefined);
      return [
        ...(pendingObservation
          ? [
              translated(notification, {
                type: "observation_completed",
                observation: completePatchObservation(pendingObservation, {
                  success: true,
                  ...(stdout !== undefined ? { output: stdout } : {}),
                }),
              }),
            ]
          : []),
        translated(notification, { type: "tool_call_completed", toolCall }),
      ];
    }
    case "serverRequest/resolved": {
      const params = paramsRecord(notification);
      const requestId = params ? String(params.requestId ?? "") : "";
      return requestId
        ? [translated(notification, { type: "operation_resolved", operation: { id: requestId, kind: "provider_internal", name: "server request resolved", target: "client" } })]
        : invalidStreamActivities(notification, "server request resolved payload was not recognized");
    }
    case "item/mcpToolCall/progress": {
      const params = paramsRecord(notification);
      const itemId = params ? itemIdFromParams(params) : null;
      if (!params || !itemId) {
        return invalidStreamActivities(notification, "MCP progress payload was not recognized");
      }
      const message = stringField(params, "message") ?? "";
      return [
        translated(notification, {
          type: "observation_updated",
          observation: {
            id: `obs-${itemId}`,
            kind: "mcp.call",
            status: "running",
            title: "MCP tool progress",
            summary: message,
            subject: { providerCallId: itemId },
            detail: { artifacts: [{ kind: "text", label: "progress", text: message }] },
          },
        }),
        translated(notification, {
          type: "tool_call_delta",
          toolCallId: itemId,
          detail: { artifacts: [{ kind: "text", label: "progress", text: message }] },
        }),
      ];
    }
    case "mcpServer/oauthLogin/completed":
    case "mcpServer/startupStatus/updated":
      return [
        translated(notification, {
          type: "runtime_status",
          status: notification.method === "mcpServer/startupStatus/updated" ? "connecting" : "connected",
          detail: JSON.stringify(notification.params ?? {}),
        }),
      ];
    case "account/updated":
    case "account/rateLimits/updated":
    case "account/login/completed":
      return [
        translated(notification, {
          type: "notification",
          level: "info",
          title: "Account updated",
          body: JSON.stringify(notification.params ?? {}),
        }),
      ];
    case "app/list/updated":
      return [
        translated(notification, {
          type: "notification",
          level: "info",
          title: "App list updated",
          body: "Available apps changed.",
        }),
      ];
    case "fs/changed": {
      const params = paramsRecord(notification);
      const files = Array.isArray(params?.changedPaths)
        ? params!.changedPaths.filter((value): value is string => typeof value === "string")
        : [];
      return [
        translated(notification, {
          type: "observation_completed",
          observation: {
            id: `obs-fs-changed-${String(params?.watchId ?? Date.now().toString(36))}`,
            kind: "file.edit",
            status: "completed",
            title: "Filesystem changed",
            subject: { files },
          },
        }),
      ];
    }
    case "thread/compacted": {
      const params = paramsRecord(notification);
      const turnId = params ? turnIdFromParams(params) : undefined;
      return [
        translated(notification, {
          type: "timeline_item",
          ...(turnId !== undefined ? { turnId } : {}),
          item: { kind: "compaction", status: "completed" },
        }),
      ];
    }
    case "model/rerouted": {
      const params = paramsRecord(notification);
      const turnId = params ? turnIdFromParams(params) : undefined;
      return [
        translated(notification, {
          type: "runtime_status",
          ...(turnId !== undefined ? { turnId } : {}),
          status: "streaming",
          detail: `Model rerouted from ${String(params?.fromModel ?? "unknown")} to ${String(params?.toModel ?? "unknown")}`,
        }),
      ];
    }
    case "deprecationNotice":
    case "configWarning":
    case "windows/worldWritableWarning":
    case "windowsSandbox/setupCompleted": {
      const params = paramsRecord(notification);
      const summary = stringField(params ?? {}, "summary") ?? notification.method;
      const details = stringField(params ?? {}, "details") ?? JSON.stringify(notification.params ?? {});
      return [
        translated(notification, {
          type: "notification",
          level: notification.method === "windowsSandbox/setupCompleted" ? "info" : "warning",
          title: summary,
          body: details,
        }),
      ];
    }
    case "fuzzyFileSearch/sessionUpdated": {
      const params = paramsRecord(notification);
      const sessionId = stringField(params ?? {}, "sessionId") ?? Date.now().toString(36);
      const query = stringField(params ?? {}, "query") ?? "";
      return [
        translated(notification, {
          type: "observation_updated",
          observation: {
            id: `obs-file-search-${sessionId}`,
            kind: "file.search",
            status: "running",
            title: "File search",
            subject: { query },
            detail: { artifacts: [{ kind: "json", label: "results", value: params?.files ?? [] }] },
          },
        }),
      ];
    }
    case "fuzzyFileSearch/sessionCompleted": {
      const params = paramsRecord(notification);
      const sessionId = stringField(params ?? {}, "sessionId") ?? Date.now().toString(36);
      return [
        translated(notification, {
          type: "observation_completed",
          observation: {
            id: `obs-file-search-${sessionId}`,
            kind: "file.search",
            status: "completed",
            title: "File search completed",
          },
        }),
      ];
    }
    case "thread/realtime/started":
    case "thread/realtime/sdp":
      return [
        translated(notification, {
          type: "runtime_status",
          status: "streaming",
          detail: notification.method,
        }),
      ];
    case "thread/realtime/transcript/delta": {
      const params = paramsRecord(notification);
      const role = stringField(params ?? {}, "role");
      const delta = stringField(params ?? {}, "delta") ?? "";
      return [
        translated(notification, {
          type: "message_part_delta",
          part: {
            messageId: `realtime-${role ?? "unknown"}`,
            partId: `realtime-${role ?? "unknown"}`,
            kind: role === "assistant" ? "text" : "unknown",
            delta,
          },
        }),
      ];
    }
    case "thread/realtime/transcript/done": {
      const params = paramsRecord(notification);
      const role = stringField(params ?? {}, "role");
      const text = stringField(params ?? {}, "text") ?? "";
      return [
        translated(notification, {
          type: "message_part_updated",
          part: {
            messageId: `realtime-${role ?? "unknown"}`,
            partId: `realtime-${role ?? "unknown"}`,
            kind: role === "assistant" ? "text" : "unknown",
            text,
          },
        }),
      ];
    }
    case "thread/realtime/itemAdded":
    case "thread/realtime/outputAudio/delta":
      return [
        translated(notification, {
          type: "observation_updated",
          observation: {
            id: `obs-${notification.method}-${Date.now().toString(36)}`,
            kind: "media.read",
            status: "running",
            title: notification.method,
            detail: { artifacts: [{ kind: "json", label: "raw", value: notification }] },
          },
        }),
      ];
    case "thread/realtime/error":
      return [
        translated(notification, {
          type: "runtime_status",
          status: "error",
          detail: stringField(paramsRecord(notification) ?? {}, "message") ?? "Realtime error",
        }),
      ];
    case "thread/realtime/closed":
      return [
        translated(notification, {
          type: "runtime_status",
          status: "finished",
          detail: stringField(paramsRecord(notification) ?? {}, "reason") ?? "Realtime closed",
        }),
      ];
    default:
      return invalidStreamActivities(notification, "method is not mapped by the Codex adapter");
  }
}

export function mapCodexQuestionRequestToActivities(params: {
  itemId: string;
  questions: unknown;
}): CodexLiveTranslatedActivity[] {
  const questions = normalizeQuestions(params.questions);
  if (questions.length === 0) {
    return [];
  }
  const text = questions
    .map((question) => {
      const lines = [`${question.header}: ${question.question}`];
      if (question.options.length > 0) {
        lines.push(`Options: ${question.options.map((option) => option.label).join(", ")}`);
      }
      return lines.join("\n");
    })
    .join("\n\n");

  const request: PermissionRequest = {
    id: `permission-${params.itemId}`,
    kind: "question",
    title: "Question",
    detail: {
      artifacts: [{ kind: "text", label: "question", text }],
    },
    input: {
      questions: questions as unknown as never,
    },
    actions: [
      { id: "allow", label: "Submit", behavior: "allow", variant: "primary" },
      { id: "deny", label: "Deny", behavior: "deny", variant: "danger" },
    ],
  };
  return [
    translated(
      { type: "item/tool/requestUserInput", params },
      {
        type: "tool_call_started",
        toolCall: {
          id: params.itemId,
          family: "other",
          providerToolName: "request_user_input",
          title: "Question",
          detail: {
            artifacts: [{ kind: "text", label: "question", text }],
          },
        },
      },
      { channel: "structured_live", authority: "derived" },
    ),
    translated(
      { type: "item/tool/requestUserInput", params },
      {
        type: "permission_requested",
        request,
      },
      { channel: "structured_live", authority: "derived" },
    ),
  ];
}

export function mapCodexPermissionResolution(params: {
  requestId: string;
  behavior: "allow" | "deny";
  message?: string;
  selectedActionId?: string;
  decision?: string;
  answers?: PermissionResolution["answers"];
}): CodexLiveTranslatedActivity {
  const resolution: PermissionResolution = {
    requestId: params.requestId,
    behavior: params.behavior,
    ...(params.message !== undefined ? { message: params.message } : {}),
    ...(params.selectedActionId !== undefined ? { selectedActionId: params.selectedActionId } : {}),
    ...(params.decision !== undefined ? { decision: params.decision } : {}),
    ...(params.answers !== undefined ? { answers: params.answers } : {}),
  };
  return translated(
    { type: "permission_resolved", params },
    {
      type: "permission_resolved",
      resolution,
    },
    { channel: "structured_live", authority: "derived" },
  );
}

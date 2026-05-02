import type {
  EventAuthority,
  EventChannel,
  TimelineIdentity,
  ToolCall,
  ToolCallArtifact,
  WorkbenchObservation,
} from "@rah/runtime-protocol";
import { classifyCodexCommand } from "./codex-command-classifier";
import { createCodexTimelineIdentity } from "./codex-timeline-identity";
import type { ProviderActivity } from "./provider-activity";

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
};

const CODEX_INTERRUPTED_PENDING_TOOL_ERROR =
  "Conversation interrupted before this tool completed.";

export interface CodexRolloutTranslationState {
  pendingToolCalls: Map<string, PendingToolCall>;
  lastTimelineTextSignature: string | null;
  providerSessionId?: string | undefined;
  currentTurnId?: string | undefined;
  nextTimelineItemIndex: number;
}

export function createCodexRolloutTranslationState(
  options: { providerSessionId?: string | undefined } = {},
): CodexRolloutTranslationState {
  const state: CodexRolloutTranslationState = {
    pendingToolCalls: new Map(),
    lastTimelineTextSignature: null,
    nextTimelineItemIndex: 0,
  };
  if (options.providerSessionId !== undefined) {
    state.providerSessionId = options.providerSessionId;
  }
  return state;
}

let invalidRolloutSequence = 0;
const IGNORED_PERSISTED_EVENT_MSG_TYPES = new Set([
  "task_started",
  "task_complete",
  "token_count",
  "user_message",
  "exec_command_begin",
  "exec_command_output_delta",
  "exec_command_end",
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
  const timestamp = typeof record.timestamp === "string" ? record.timestamp : "";
  const signature = `${kind}:${timestamp}:${text}`;
  if (state.lastTimelineTextSignature === signature) {
    return true;
  }
  state.lastTimelineTextSignature = signature;
  return false;
}

function timelineIdentityProps(identity: TimelineIdentity | undefined): { identity?: TimelineIdentity } {
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
  if (payload.type === "task_started" || record.type === "turn_context") {
    if (state.currentTurnId !== turnId) {
      state.currentTurnId = turnId;
      state.nextTimelineItemIndex = 0;
    }
    return;
  }
  if (payload.type === "task_complete" || payload.type === "turn_aborted") {
    if (state.currentTurnId === turnId) {
      state.currentTurnId = undefined;
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
  options: { includeTimelineStatus: boolean },
): CodexTranslatedActivity[] {
  if (state.pendingToolCalls.size === 0) {
    return [];
  }

  const result: CodexTranslatedActivity[] = [];
  for (const [callId, pending] of state.pendingToolCalls) {
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
  }
  state.pendingToolCalls.clear();

  if (options.includeTimelineStatus) {
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
    { includeTimelineStatus: true },
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
  syncRolloutStateFromRecord(state, record);
  if (record.type === "event_msg") {
    const payload = payloadRecord(record);
    if (!payload) {
      return [];
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
            item: { kind: "assistant_message", text },
            ...timelineIdentityProps(identity),
          },
          "authoritative",
        ),
      ];
    }
    if (payload.type === "turn_aborted") {
      return interruptedPendingToolActivities(
        state,
        record,
        { includeTimelineStatus: true },
      );
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
      return [];
    }
    if (payload.role === "user") {
      const rawText = textFromContentItems(payload.content, "input_text");
      if (rawText === null) {
        return [];
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
      const text = stripCodexContextualFragments(
        textFromContentItems(payload.content, "output_text") ?? "",
      );
      if (!text) {
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
            item: { kind: "assistant_message", text },
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

    const parsedOutput = parseFunctionCallOutput(payload.output);
    const artifacts = [...(pending.toolCall.detail?.artifacts ?? [])];
    const outputText = parsedOutput.textOutput ?? payload.output.trimEnd();
    if (outputText) {
      artifacts.push({
        kind: "text",
        label: "stdout",
        text: outputText,
      });
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
                  ...(parsedOutput.successText ? { summary: parsedOutput.successText.split(/\r?\n/)[0] } : {}),
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

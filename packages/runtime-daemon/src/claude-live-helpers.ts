import { randomUUID } from "node:crypto";
import {
  type CanUseTool,
  type Options as ClaudeOptions,
  type PermissionMode,
  type SDKAssistantMessage,
  type SDKMessage,
  type SDKResultMessage,
  type Query as ClaudeQuery,
} from "@anthropic-ai/claude-agent-sdk";
import type {
  AttachSessionRequest,
  ContextUsage,
  ManagedSession,
  PermissionRequest,
  TimelineIdentity,
} from "@rah/runtime-protocol";
import type { RuntimeServices } from "./provider-adapter";
import { resolveConfiguredBinary } from "./provider-binary-utils";
import { applyProviderActivity, type ProviderActivity } from "./provider-activity";
import type {
  LiveClaudeSession,
  LiveClaudeTurn,
  PendingClaudePermission,
} from "./claude-live-types";
import { withModelContextWindow } from "./model-context-window";
import { createClaudeTimelineIdentity } from "./claude-timeline-identity";

const SESSION_SOURCE = {
  provider: "system" as const,
  channel: "system" as const,
  authority: "authoritative" as const,
};

export async function waitForPendingClaudePermission(
  requestId: string,
  liveSession: LiveClaudeSession,
  timeoutMs = 1_000,
): Promise<PendingClaudePermission | null> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const pending = liveSession.pendingPermissions.get(requestId) ?? null;
    if (pending) {
      return pending;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return null;
}

export function publishSessionBootstrap(
  services: RuntimeServices,
  sessionId: string,
  session: ManagedSession,
) {
  services.eventBus.publish({
    sessionId,
    type: "session.created",
    source: SESSION_SOURCE,
    payload: { session },
  });
  services.eventBus.publish({
    sessionId,
    type: "session.started",
    source: SESSION_SOURCE,
    payload: { session },
  });
}

export function attachRequestedClient(
  services: RuntimeServices,
  sessionId: string,
  attach: AttachSessionRequest | undefined,
) {
  if (!attach) {
    return;
  }
  services.sessionStore.attachClient({
    sessionId,
    clientId: attach.client.id,
    kind: attach.client.kind,
    connectionId: attach.client.connectionId,
    attachMode: attach.mode,
    focus: true,
  });
  services.eventBus.publish({
    sessionId,
    type: "session.attached",
    source: SESSION_SOURCE,
    payload: {
      clientId: attach.client.id,
      clientKind: attach.client.kind,
    },
  });
  if (attach.claimControl) {
    services.sessionStore.claimControl(sessionId, attach.client.id, attach.client.kind);
    services.eventBus.publish({
      sessionId,
      type: "control.claimed",
      source: SESSION_SOURCE,
      payload: {
        clientId: attach.client.id,
        clientKind: attach.client.kind,
      },
    });
  }
}

export function applyActivity(
  services: RuntimeServices,
  sessionId: string,
  activity: ProviderActivity,
  raw?: unknown,
) {
  applyProviderActivity(
    services,
    sessionId,
    {
      provider: "claude" as const,
      channel: "structured_live" as const,
      authority: "derived" as const,
      ...(raw !== undefined ? { raw } : {}),
    },
    activity,
  );
}

function timelineIdentityProps(identity: TimelineIdentity | undefined): { identity?: TimelineIdentity } {
  return identity !== undefined ? { identity } : {};
}

export function humanizeClaudeToolName(name: string): string {
  switch (name) {
    case "Read":
      return "Read File";
    case "Write":
      return "Write File";
    case "Edit":
    case "MultiEdit":
      return "Edit File";
    case "Glob":
      return "Find Files";
    case "Grep":
      return "Search in Files";
    case "LS":
      return "List Directory";
    case "Bash":
      return "Run Command";
    case "WebFetch":
      return "Fetch Web Page";
    case "WebSearch":
      return "Search Web";
    default:
      return name.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/_/g, " ");
  }
}

function classifyClaudeToolFamily(name: string) {
  const normalized = name.toLowerCase();
  if (normalized === "read") return "file_read" as const;
  if (normalized === "write") return "file_write" as const;
  if (normalized === "edit" || normalized === "multiedit") return "file_edit" as const;
  if (normalized === "grep" || normalized === "glob" || normalized === "ls") return "search" as const;
  if (normalized === "bash") return "shell" as const;
  if (normalized === "webfetch") return "web_fetch" as const;
  if (normalized === "websearch") return "web_search" as const;
  if (normalized === "task") return "subagent" as const;
  return "other" as const;
}

function normalizeClaudeQuestionOptions(input: unknown): Array<{ label: string; description?: string }> {
  if (!Array.isArray(input)) {
    return [];
  }
  return input.flatMap((option) => {
    if (!option || typeof option !== "object" || Array.isArray(option)) {
      return [];
    }
    const record = option as Record<string, unknown>;
    if (typeof record.label !== "string") {
      return [];
    }
    return [
      {
        label: record.label,
        ...(typeof record.description === "string" ? { description: record.description } : {}),
      },
    ];
  });
}

function makeClaudeQuestionPermissionRequest(
  requestId: string,
  input: Record<string, unknown>,
): {
  request: PermissionRequest;
  questions: Array<{ id: string; question: string }>;
} {
  const rawQuestions = Array.isArray(input.questions) ? input.questions : [];
  const questions = rawQuestions
    .filter((entry) => entry && typeof entry === "object" && !Array.isArray(entry))
    .map((entry) => entry as Record<string, unknown>)
    .flatMap((entry, index) => {
      const id = typeof entry.id === "string" ? entry.id : `question-${index + 1}`;
      const question =
        typeof entry.question === "string" ? entry.question : `Question ${index + 1}`;
      const header = typeof entry.header === "string" ? entry.header : "Question";
      return [
        {
          id,
          header,
          question,
          options: normalizeClaudeQuestionOptions(entry.options),
        },
      ];
    });
  const fallbackQuestion =
    typeof input.question === "string" ? input.question : "Claude is asking for input.";
  const normalizedQuestions =
    questions.length > 0
      ? questions
      : [{ id: "question-1", header: "Question", question: fallbackQuestion, options: [] }];
  return {
    request: {
      id: requestId,
      kind: "question",
      title: "Ask User Question",
      description: "Claude is waiting for your answer.",
      actions: [
        { id: "submit", label: "Submit", behavior: "allow", variant: "primary" },
        { id: "deny", label: "Decline", behavior: "deny", variant: "danger" },
      ],
      input: {
        questions: normalizedQuestions,
      },
    },
    questions: normalizedQuestions.map((question) => ({
      id: question.id,
      question: question.question,
    })),
  };
}

async function resolveClaudeBinary(): Promise<string> {
  return await resolveConfiguredBinary("RAH_CLAUDE_BINARY", "claude");
}

export function approvalPolicyToPermissionMode(
  approvalPolicy: string | undefined,
): PermissionMode {
  if (approvalPolicy === "default") {
    return "default";
  }
  return "bypassPermissions";
}

export function buildClaudeOptions(args: {
  liveSession: LiveClaudeSession;
  canUseTool: CanUseTool;
}): Promise<ClaudeOptions> {
  return resolveClaudeBinary().then((binary) => ({
    cwd: args.liveSession.cwd,
    includePartialMessages: true,
    permissionMode: args.liveSession.permissionMode,
    allowDangerouslySkipPermissions: args.liveSession.permissionMode === "bypassPermissions",
    canUseTool: args.canUseTool,
    pathToClaudeCodeExecutable: binary,
    settingSources: ["user", "project"],
    ...(args.liveSession.providerSessionId ? { resume: args.liveSession.providerSessionId } : {}),
    ...(args.liveSession.model ? { model: args.liveSession.model } : {}),
    ...(args.liveSession.effort !== undefined ? { effort: args.liveSession.effort } : {}),
  }));
}

function usageFromResult(
  result: SDKResultMessage,
  liveSession: LiveClaudeSession,
): ContextUsage | undefined {
  if (result.type !== "result" || result.subtype !== "success") {
    return undefined;
  }
  const cachedInputTokens = result.usage.cache_read_input_tokens ?? 0;
  const usedTokens =
    result.usage.input_tokens + cachedInputTokens + result.usage.output_tokens;
  return withModelContextWindow({
    usedTokens,
    inputTokens: result.usage.input_tokens,
    cachedInputTokens,
    outputTokens: result.usage.output_tokens,
    source: "claude.sdk.result_usage",
  }, liveSession.contextWindow);
}

function patchProviderSessionId(
  services: RuntimeServices,
  liveSession: LiveClaudeSession,
  providerSessionId: string,
) {
  if (liveSession.providerSessionId === providerSessionId) {
    return;
  }
  liveSession.providerSessionId = providerSessionId;
  services.sessionStore.patchManagedSession(liveSession.sessionId, {
    providerSessionId,
  });
}

function handleAssistantMessage(
  services: RuntimeServices,
  liveSession: LiveClaudeSession,
  turnId: string,
  message: SDKAssistantMessage,
) {
  const content = Array.isArray(message.message.content) ? message.message.content : [];
  for (const block of content) {
    if (!block || typeof block !== "object" || Array.isArray(block) || !("type" in block)) {
      continue;
    }
    const typedBlock = block as unknown as Record<string, unknown>;
    if (typedBlock.type === "text" && typeof typedBlock.text === "string") {
      const identity = liveSession.providerSessionId
        ? createClaudeTimelineIdentity({
            providerSessionId: liveSession.providerSessionId,
            recordUuid: String(message.uuid),
            itemKind: "assistant_message",
            origin: "live",
          })
        : undefined;
      applyActivity(
        services,
        liveSession.sessionId,
        {
          type: "timeline_item",
          turnId,
          item: {
            kind: "assistant_message",
            text: typedBlock.text,
            messageId: String(message.uuid),
          },
          ...timelineIdentityProps(identity),
        },
        message,
      );
      continue;
    }
    if (typedBlock.type === "tool_use") {
      const toolId = typeof typedBlock.id === "string" ? typedBlock.id : randomUUID();
      const name = typeof typedBlock.name === "string" ? typedBlock.name : "unknown";
      const input =
        typedBlock.input && typeof typedBlock.input === "object" && !Array.isArray(typedBlock.input)
          ? (typedBlock.input as Record<string, unknown>)
          : undefined;
      if (name === "AskUserQuestion") {
        const requestId = `question-${toolId}`;
        const mapped = makeClaudeQuestionPermissionRequest(requestId, input ?? {});
        const query = liveSession.activeTurn?.query;
        if (query) {
          liveSession.pendingPermissions.set(requestId, {
            kind: "question",
            sessionId: liveSession.sessionId,
            requestId,
            toolUseId: toolId,
            query,
            questions: mapped.questions,
          });
          applyActivity(
            services,
            liveSession.sessionId,
            {
              type: "permission_requested",
              turnId,
              request: mapped.request,
            },
            message,
          );
        }
        continue;
      }
      applyActivity(
        services,
        liveSession.sessionId,
        {
          type: "tool_call_started",
          turnId,
          toolCall: {
            id: toolId,
            family: classifyClaudeToolFamily(name),
            providerToolName: name,
            title: humanizeClaudeToolName(name),
            ...(input ? { input } : {}),
          },
        },
        message,
      );
    }
  }
}

function handleClaudeSdkMessage(
  services: RuntimeServices,
  liveSession: LiveClaudeSession,
  message: SDKMessage,
) {
  if (message.type === "system" && message.subtype === "init") {
    return;
  }
  const subtype =
    "subtype" in message && typeof message.subtype === "string" ? message.subtype : null;
  if (subtype === "session_state_changed" && "state" in message) {
    applyActivity(
      services,
      liveSession.sessionId,
      {
        type: "runtime_status",
        status: message.state === "running" ? "streaming" : "session_active",
      },
      message,
    );
    return;
  }
  if (subtype === "notification" && "text" in message && typeof message.text === "string") {
    applyActivity(
      services,
      liveSession.sessionId,
      {
        type: "notification",
        level: "warning",
        title: "Claude notification",
        body: message.text,
      },
      message,
    );
  }
}

export async function consumeClaudeQuery(args: {
  services: RuntimeServices;
  liveSession: LiveClaudeSession;
  turnId: string;
  query: ClaudeQuery;
  activeTurn: LiveClaudeTurn;
}) {
  try {
    for await (const message of args.query) {
      if (args.activeTurn.aborted) {
        return;
      }
      if ("session_id" in message && typeof message.session_id === "string" && message.session_id) {
        patchProviderSessionId(args.services, args.liveSession, message.session_id);
      }
      switch (message.type) {
        case "assistant":
          handleAssistantMessage(args.services, args.liveSession, args.turnId, message);
          break;
        case "result": {
          const usage = usageFromResult(message, args.liveSession);
          applyActivity(
            args.services,
            args.liveSession.sessionId,
            {
              type: "turn_completed",
              turnId: args.turnId,
              ...(usage ? { usage } : {}),
            },
            message,
          );
          args.activeTurn.completed = true;
          args.services.sessionStore.setRuntimeState(args.liveSession.sessionId, "idle");
          if (args.liveSession.activeTurn === args.activeTurn) {
            args.liveSession.activeTurn = null;
          }
          return;
        }
        default:
          handleClaudeSdkMessage(args.services, args.liveSession, message);
          break;
      }
    }
  } catch (error) {
    if (args.activeTurn.aborted) {
      return;
    }
    applyActivity(
      args.services,
      args.liveSession.sessionId,
      {
        type: "turn_failed",
        turnId: args.turnId,
        error: error instanceof Error ? error.message : String(error),
      },
      error,
    );
    args.services.sessionStore.setRuntimeState(args.liveSession.sessionId, "failed");
    if (args.liveSession.activeTurn === args.activeTurn) {
      args.liveSession.activeTurn = null;
    }
  }
}

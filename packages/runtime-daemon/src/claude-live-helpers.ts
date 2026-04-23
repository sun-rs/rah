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
} from "@rah/runtime-protocol";
import type { RuntimeServices } from "./provider-adapter";
import { applyProviderActivity, type ProviderActivity } from "./provider-activity";
import type {
  LiveClaudeSession,
  PendingClaudePermission,
} from "./claude-live-types";

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

async function resolveClaudeBinary(): Promise<string> {
  return process.env.RAH_CLAUDE_BINARY ?? "claude";
}

export function approvalPolicyToPermissionMode(
  approvalPolicy: string | undefined,
): PermissionMode {
  return approvalPolicy === "never" ? "bypassPermissions" : "default";
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
  }));
}

function usageFromResult(result: SDKResultMessage): ContextUsage | undefined {
  if (result.type !== "result" || result.subtype !== "success") {
    return undefined;
  }
  return {
    inputTokens: result.usage.input_tokens,
    cachedInputTokens: result.usage.cache_read_input_tokens,
    outputTokens: result.usage.output_tokens,
  };
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
}) {
  try {
    for await (const message of args.query) {
      if ("session_id" in message && typeof message.session_id === "string" && message.session_id) {
        patchProviderSessionId(args.services, args.liveSession, message.session_id);
      }
      switch (message.type) {
        case "assistant":
          handleAssistantMessage(args.services, args.liveSession, args.turnId, message);
          break;
        case "result": {
          const usage = usageFromResult(message);
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
          args.services.sessionStore.setRuntimeState(args.liveSession.sessionId, "idle");
          args.liveSession.activeTurn = null;
          return;
        }
        default:
          handleClaudeSdkMessage(args.services, args.liveSession, message);
          break;
      }
    }
  } catch (error) {
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
    args.liveSession.activeTurn = null;
  }
}

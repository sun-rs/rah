import { randomUUID } from "node:crypto";
import {
  query as claudeQuery,
  type CanUseTool,
  type Options as ClaudeOptions,
  type PermissionResult,
  type PermissionUpdate,
  type PermissionMode,
  type Query as ClaudeQuery,
  type SDKAssistantMessage,
  type SDKMessage,
  type SDKResultMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type {
  AttachSessionRequest,
  CloseSessionRequest,
  ContextUsage,
  InterruptSessionRequest,
  ManagedSession,
  PermissionResponseRequest,
  SessionInputRequest,
  StartSessionRequest,
} from "@rah/runtime-protocol";
import type { RuntimeServices } from "./provider-adapter";
import { applyProviderActivity, type ProviderActivity } from "./provider-activity";
import { toSessionSummary } from "./session-store";

const SESSION_SOURCE = {
  provider: "system" as const,
  channel: "system" as const,
  authority: "authoritative" as const,
};

type PendingClaudePermission = {
  sessionId: string;
  requestId: string;
  allowResult: PermissionResult;
  allowForSessionResult?: PermissionResult;
  resolve: (value: PermissionResult) => void;
  reject: (error: Error) => void;
};

const pendingClaudePermissions = new Map<string, PendingClaudePermission>();

export type LiveClaudeTurn = {
  query: ClaudeQuery;
  turnId: string;
  completed: boolean;
};

export type LiveClaudeSession = {
  sessionId: string;
  cwd: string;
  model?: string;
  permissionMode: PermissionMode;
  providerSessionId?: string;
  activeTurn: LiveClaudeTurn | null;
  pendingPermissions: Map<string, PendingClaudePermission>;
  queryFactory: typeof claudeQuery;
};

export type ClaudeQueryFactory = typeof claudeQuery;

async function waitForPendingClaudePermission(
  sessionId: string,
  requestId: string,
  liveSession: LiveClaudeSession,
  timeoutMs = 1_000,
): Promise<PendingClaudePermission | null> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const pending =
      pendingClaudePermissions.get(`${sessionId}:${requestId}`) ??
      liveSession.pendingPermissions.get(requestId) ??
      null;
    if (pending) {
      return pending;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return null;
}

function publishSessionBootstrap(
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

function attachRequestedClient(
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

function providerActivityMeta(raw?: unknown) {
  return {
    provider: "claude" as const,
    channel: "structured_live" as const,
    authority: "derived" as const,
    ...(raw !== undefined ? { raw } : {}),
  };
}

function applyActivity(
  services: RuntimeServices,
  sessionId: string,
  activity: ProviderActivity,
  raw?: unknown,
) {
  applyProviderActivity(
    services,
    sessionId,
    providerActivityMeta(raw),
    activity,
  );
}

function humanizeClaudeToolName(name: string): string {
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

function approvalPolicyToPermissionMode(approvalPolicy: string | undefined): PermissionMode {
  return approvalPolicy === "never" ? "bypassPermissions" : "default";
}

function buildClaudeOptions(args: {
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
    return;
  }
}

async function consumeClaudeQuery(args: {
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

export async function startClaudeLiveSession(args: {
  services: RuntimeServices;
  request: StartSessionRequest;
  queryFactory?: typeof claudeQuery;
}) {
  const permissionMode = approvalPolicyToPermissionMode(args.request.approvalPolicy);
  const state = args.services.sessionStore.createManagedSession({
    provider: "claude",
    launchSource: "web",
    cwd: args.request.cwd,
    rootDir: args.request.cwd,
    ...(args.request.title ? { title: args.request.title } : {}),
    capabilities: {
      livePermissions: true,
      steerInput: true,
      queuedInput: false,
      modelSwitch: false,
      planMode: false,
      subagents: false,
    },
  });
  publishSessionBootstrap(args.services, state.session.id, state.session);
  attachRequestedClient(args.services, state.session.id, args.request.attach);
  args.services.sessionStore.setRuntimeState(state.session.id, "idle");
  const liveSession: LiveClaudeSession = {
    sessionId: state.session.id,
    cwd: args.request.cwd,
    ...(args.request.model ? { model: args.request.model } : {}),
    permissionMode,
    activeTurn: null,
    pendingPermissions: new Map(),
    queryFactory: args.queryFactory ?? claudeQuery,
  };
  return {
    summary: toSessionSummary(args.services.sessionStore.getSession(state.session.id)!),
    liveSession,
  };
}

export async function resumeClaudeLiveSession(args: {
  services: RuntimeServices;
  providerSessionId: string;
  cwd: string;
  permissionMode?: PermissionMode;
  attach?: AttachSessionRequest;
  queryFactory?: typeof claudeQuery;
}) {
  const state = args.services.sessionStore.createManagedSession({
    provider: "claude",
    providerSessionId: args.providerSessionId,
    launchSource: "web",
    cwd: args.cwd,
    rootDir: args.cwd,
    capabilities: {
      livePermissions: true,
      steerInput: true,
      queuedInput: false,
      modelSwitch: false,
      planMode: false,
      subagents: false,
    },
  });
  publishSessionBootstrap(args.services, state.session.id, state.session);
  attachRequestedClient(args.services, state.session.id, args.attach);
  args.services.sessionStore.setRuntimeState(state.session.id, "idle");
  const liveSession: LiveClaudeSession = {
    sessionId: state.session.id,
    cwd: args.cwd,
    providerSessionId: args.providerSessionId,
    permissionMode: args.permissionMode ?? "default",
    activeTurn: null,
    pendingPermissions: new Map(),
    queryFactory: args.queryFactory ?? claudeQuery,
  };
  return {
    summary: toSessionSummary(args.services.sessionStore.getSession(state.session.id)!),
    liveSession,
  };
}

export async function sendInputToClaudeLiveSession(args: {
  services: RuntimeServices;
  liveSession: LiveClaudeSession;
  request: SessionInputRequest;
}) {
  if (args.liveSession.activeTurn) {
    throw new Error("Claude session already has an active turn.");
  }
  if (!args.services.sessionStore.hasInputControl(args.liveSession.sessionId, args.request.clientId)) {
    throw new Error(
      `Client ${args.request.clientId} does not hold input control for ${args.liveSession.sessionId}.`,
    );
  }

  const turnId = randomUUID();
  applyActivity(
    args.services,
    args.liveSession.sessionId,
    {
      type: "turn_started",
      turnId,
    },
  );
  applyActivity(
    args.services,
    args.liveSession.sessionId,
    {
      type: "timeline_item",
      turnId,
      item: {
        kind: "user_message",
        text: args.request.text,
      },
    },
  );
  args.services.sessionStore.setRuntimeState(args.liveSession.sessionId, "running");

  const canUseTool: CanUseTool = async (toolName, input, options) => {
    const requestId = `permission-${randomUUID()}`;
    const suggestions = Array.isArray(options.suggestions)
      ? (options.suggestions as PermissionUpdate[])
      : [];
    const allowResult: PermissionResult = {
      behavior: "allow",
    };
    const allowForSessionResult =
      suggestions.length > 0
        ? ({
            behavior: "allow",
            updatedPermissions: suggestions,
          } satisfies PermissionResult)
        : undefined;
    const permissionRequest = {
      id: requestId,
      kind: "tool" as const,
      title: humanizeClaudeToolName(toolName),
      ...(options.description ?? options.title
        ? { description: options.description ?? options.title }
        : {}),
      actions: [
        { id: "allow", label: "Allow", behavior: "allow" as const, variant: "primary" as const },
        ...(allowForSessionResult
          ? [
              {
                id: "allow_for_session",
                label: "Allow for session",
                behavior: "allow" as const,
                variant: "secondary" as const,
              },
            ]
          : []),
        { id: "deny", label: "Deny", behavior: "deny" as const, variant: "danger" as const },
      ],
      detail: {
        artifacts: [{ kind: "json" as const, label: "input", value: input }],
      },
    };
    const resultPromise = new Promise<PermissionResult>((resolve, reject) => {
      args.liveSession.pendingPermissions.set(requestId, {
        sessionId: args.liveSession.sessionId,
        requestId,
        allowResult,
        ...(allowForSessionResult ? { allowForSessionResult } : {}),
        resolve,
        reject,
      });
      pendingClaudePermissions.set(`${args.liveSession.sessionId}:${requestId}`, {
        sessionId: args.liveSession.sessionId,
        requestId,
        allowResult,
        ...(allowForSessionResult ? { allowForSessionResult } : {}),
        resolve,
        reject,
      });
    });
    applyActivity(
      args.services,
      args.liveSession.sessionId,
      {
        type: "permission_requested",
        turnId,
        request: permissionRequest,
      },
      { toolName, input, options },
    );
    return await resultPromise;
  };

  const options = await buildClaudeOptions({
    liveSession: args.liveSession,
    canUseTool,
  });
  const query = args.liveSession.queryFactory({
    prompt: args.request.text,
    options,
  });
  args.liveSession.activeTurn = {
    query,
    turnId,
    completed: false,
  };
  void consumeClaudeQuery({
    services: args.services,
    liveSession: args.liveSession,
    turnId,
    query,
  });
}

export function interruptClaudeLiveSession(args: {
  services: RuntimeServices;
  liveSession: LiveClaudeSession;
  request: InterruptSessionRequest;
}) {
  if (!args.services.sessionStore.hasInputControl(args.liveSession.sessionId, args.request.clientId)) {
    throw new Error(
      `Client ${args.request.clientId} does not hold input control for ${args.liveSession.sessionId}.`,
    );
  }
  args.liveSession.activeTurn?.query.close();
  args.liveSession.activeTurn = null;
  args.services.sessionStore.setRuntimeState(args.liveSession.sessionId, "idle");
  const state = args.services.sessionStore.getSession(args.liveSession.sessionId);
  if (!state) {
    throw new Error(`Unknown session ${args.liveSession.sessionId}`);
  }
  return toSessionSummary(state);
}

export async function respondToClaudeLivePermission(args: {
  liveSession: LiveClaudeSession;
  services: RuntimeServices;
  requestId: string;
  response: PermissionResponseRequest;
}) {
  const pending = await waitForPendingClaudePermission(
    args.liveSession.sessionId,
    args.requestId,
    args.liveSession,
  );
  if (!pending) {
    throw new Error(
      `No pending Claude permission request '${args.requestId}'. Known pending keys: ${JSON.stringify([...pendingClaudePermissions.keys()])}`,
    );
  }
  const resolution = {
    requestId: args.requestId,
    behavior: args.response.behavior,
    ...(args.response.message !== undefined ? { message: args.response.message } : {}),
    ...(args.response.selectedActionId !== undefined
      ? { selectedActionId: args.response.selectedActionId }
      : {}),
    ...(args.response.decision !== undefined ? { decision: args.response.decision } : {}),
    ...(args.response.answers !== undefined ? { answers: args.response.answers } : {}),
  };
  applyActivity(
    args.services,
    args.liveSession.sessionId,
    {
      type: "permission_resolved",
      resolution,
      ...(args.liveSession.activeTurn ? { turnId: args.liveSession.activeTurn.turnId } : {}),
    },
  );
  pendingClaudePermissions.delete(`${args.liveSession.sessionId}:${args.requestId}`);
  args.liveSession.pendingPermissions.delete(args.requestId);
  if (args.response.behavior === "allow") {
    const selectedActionId = args.response.selectedActionId;
    const useSessionGrant =
      selectedActionId === "allow_for_session" ||
      args.response.decision === "approved_for_session" ||
      args.response.decision === "acceptForSession";
    pending.resolve(
      useSessionGrant && pending.allowForSessionResult
        ? pending.allowForSessionResult
        : pending.allowResult,
    );
    return;
  }
  pending.resolve({
    behavior: "deny",
    message: args.response.message ?? "Denied by user",
  });
}

export async function closeClaudeLiveSession(
  liveSession: LiveClaudeSession,
  _request?: CloseSessionRequest,
): Promise<void> {
  liveSession.activeTurn?.query.close();
  liveSession.activeTurn = null;
  for (const pending of liveSession.pendingPermissions.values()) {
    pendingClaudePermissions.delete(`${pending.sessionId}:${pending.requestId}`);
    pending.reject(new Error("Claude session closed"));
  }
  liveSession.pendingPermissions.clear();
}

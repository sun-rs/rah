import {
  isPermissionAbort,
  isPermissionDenied,
  isPermissionSessionGrant,
  type AttachSessionRequest,
  type ManagedSession,
  type PermissionRequest,
  type PermissionResponseRequest,
} from "@rah/runtime-protocol";
import type { RuntimeServices } from "./provider-adapter";
import { applyProviderActivity, type ProviderActivity } from "./provider-activity";
import {
  mapCodexQuestionRequestToActivities,
  translateCodexAppServerNotification,
} from "./codex-app-server-activity";
import { type CodexJsonRpcClient } from "./codex-live-rpc";
import {
  SESSION_SOURCE,
  type JsonRpcNotification,
  type JsonRpcRequest,
  type LiveCodexSession,
} from "./codex-live-types";

type BufferedServerRequest = {
  request: JsonRpcRequest;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

function makeQuestionPermissionRequestId(itemId: string): string {
  return `permission-${itemId}`;
}

function makeCommandPermissionRequest(requestId: string, params: Record<string, unknown>): PermissionRequest {
  const command = typeof params.command === "string" ? params.command : "Run command";
  const cwd = typeof params.cwd === "string" ? params.cwd : null;
  return {
    id: requestId,
    kind: "tool",
    title: command,
    ...(typeof params.reason === "string" ? { description: params.reason } : {}),
    detail: {
      artifacts: [
        {
          kind: "command",
          command,
          ...(cwd ? { cwd } : {}),
        },
      ],
    },
    actions: [
      { id: "allow", label: "Yes", behavior: "allow", variant: "primary" },
      { id: "allow_for_session", label: "Yes for session", behavior: "allow", variant: "secondary" },
      { id: "abort", label: "Abort", behavior: "deny", variant: "danger" },
    ],
  };
}

function makeFilePermissionRequest(requestId: string, params: Record<string, unknown>): PermissionRequest {
  return {
    id: requestId,
    kind: "tool",
    title: "Apply file changes",
    ...(typeof params.reason === "string" ? { description: params.reason } : {}),
    actions: [
      { id: "allow", label: "Yes", behavior: "allow", variant: "primary" },
      { id: "allow_for_session", label: "Yes for session", behavior: "allow", variant: "secondary" },
      { id: "abort", label: "Abort", behavior: "deny", variant: "danger" },
    ],
  };
}

function makePermissionsPermissionRequest(requestId: string, params: Record<string, unknown>): PermissionRequest {
  return {
    id: requestId,
    kind: "mode",
    title: "Grant additional permissions",
    ...(typeof params.reason === "string" ? { description: params.reason } : {}),
    detail: {
      artifacts: [{ kind: "json", label: "permissions", value: params.permissions ?? {} }],
    },
    input: {
      permissions: params.permissions as never,
    },
    actions: [
      { id: "allow", label: "Allow", behavior: "allow", variant: "primary" },
      { id: "deny", label: "Deny", behavior: "deny", variant: "danger" },
    ],
  };
}

function makeMcpElicitationPermissionRequest(requestId: string, params: Record<string, unknown>): PermissionRequest {
  const serverName = typeof params.serverName === "string" ? params.serverName : "MCP server";
  const message = typeof params.message === "string" ? params.message : "MCP server requested input.";
  return {
    id: requestId,
    kind: "question",
    title: `${serverName} elicitation`,
    description: message,
    detail: {
      artifacts: [{ kind: "json", label: "elicitation", value: params }],
    },
    input: params as never,
    actions: [
      { id: "allow", label: "Accept", behavior: "allow", variant: "primary" },
      { id: "deny", label: "Decline", behavior: "deny", variant: "danger" },
    ],
  };
}

function shouldAttachCurrentTurn(activity: ProviderActivity): boolean {
  switch (activity.type) {
    case "timeline_item":
    case "timeline_item_updated":
    case "message_part_added":
    case "message_part_updated":
    case "message_part_delta":
    case "message_part_removed":
    case "tool_call_started":
    case "tool_call_delta":
    case "tool_call_completed":
    case "tool_call_failed":
    case "observation_started":
    case "observation_updated":
    case "observation_completed":
    case "observation_failed":
    case "permission_requested":
    case "permission_resolved":
    case "operation_started":
    case "operation_resolved":
    case "operation_requested":
    case "governance_updated":
    case "runtime_status":
    case "notification":
    case "usage":
      return activity.turnId === undefined;
    default:
      return false;
  }
}

export function attachCurrentTurn(
  activity: ProviderActivity,
  currentTurnId: string | null,
): ProviderActivity {
  if (!currentTurnId || !shouldAttachCurrentTurn(activity)) {
    return activity;
  }
  return {
    ...activity,
    turnId: currentTurnId,
  } as ProviderActivity;
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

function applyCodexLiveTranslatedItems(
  services: RuntimeServices,
  liveSession: LiveCodexSession,
  items: ReturnType<typeof translateCodexAppServerNotification>,
) {
  for (const item of items) {
    const activity = attachCurrentTurn(item.activity, liveSession.currentTurnId);
    const events = applyProviderActivity(
      services,
      liveSession.sessionId,
      {
        provider: "codex",
        ...(item.channel !== undefined ? { channel: item.channel } : {}),
        ...(item.authority !== undefined ? { authority: item.authority } : {}),
        ...(item.raw !== undefined ? { raw: item.raw } : {}),
        ...(item.ts !== undefined ? { ts: item.ts } : {}),
      },
      activity,
    );
    for (const event of events) {
      if (event.type === "turn.started") {
        liveSession.currentTurnId = event.turnId ?? null;
      } else if (
        event.type === "turn.completed" ||
        event.type === "turn.failed" ||
        event.type === "turn.canceled"
      ) {
        liveSession.currentTurnId = null;
      }
    }
  }
}

function handleCodexLiveNotification(
  services: RuntimeServices,
  liveSession: LiveCodexSession,
  notification: JsonRpcNotification,
) {
  applyCodexLiveTranslatedItems(
    services,
    liveSession,
    translateCodexAppServerNotification(notification, liveSession.translationState),
  );
}

async function handleCodexLiveRequest(
  services: RuntimeServices,
  liveSession: LiveCodexSession,
  rpcRequest: JsonRpcRequest,
): Promise<unknown> {
  if (
    rpcRequest.method === "item/tool/requestUserInput" ||
    rpcRequest.method === "tool/requestUserInput"
  ) {
    const params =
      rpcRequest.params && typeof rpcRequest.params === "object" && !Array.isArray(rpcRequest.params)
        ? (rpcRequest.params as Record<string, unknown>)
        : {};
    const itemId = typeof params.itemId === "string" ? params.itemId : `question-${rpcRequest.id}`;
    const permissionRequestId = makeQuestionPermissionRequestId(itemId);
    const activities = mapCodexQuestionRequestToActivities({
      itemId,
      questions: params.questions,
    });
    liveSession.pendingQuestions.set(itemId, { permissionRequestId });
    for (const item of activities) {
      applyProviderActivity(
        services,
        liveSession.sessionId,
        {
          provider: "codex",
          ...(item.channel !== undefined ? { channel: item.channel } : {}),
          ...(item.authority !== undefined ? { authority: item.authority } : {}),
          ...(item.raw !== undefined ? { raw: item.raw } : {}),
          ...(item.ts !== undefined ? { ts: item.ts } : {}),
        },
        attachCurrentTurn(item.activity, liveSession.currentTurnId),
      );
    }
    return await new Promise((resolve) => {
      liveSession.pendingApprovals.set(permissionRequestId, {
        kind: "question",
        resolve,
        requestId: permissionRequestId,
        itemId,
        questions: params.questions,
      });
    });
  }

  if (
    rpcRequest.method === "item/commandExecution/requestApproval" ||
    rpcRequest.method === "item/fileChange/requestApproval" ||
    rpcRequest.method === "item/permissions/requestApproval" ||
    rpcRequest.method === "execCommandApproval" ||
    rpcRequest.method === "applyPatchApproval"
  ) {
    const params =
      rpcRequest.params && typeof rpcRequest.params === "object" && !Array.isArray(rpcRequest.params)
        ? (rpcRequest.params as Record<string, unknown>)
        : {};
    const itemId = typeof params.itemId === "string" ? params.itemId : `approval-${rpcRequest.id}`;
    const requestId = `permission-${itemId}`;
    const approvalKind =
      rpcRequest.method === "item/permissions/requestApproval"
        ? "permissions"
        : rpcRequest.method === "item/commandExecution/requestApproval" ||
            rpcRequest.method === "execCommandApproval"
          ? "command"
          : "file";
    const permissionRequest =
      approvalKind === "permissions"
        ? makePermissionsPermissionRequest(requestId, params)
        : approvalKind === "command"
          ? makeCommandPermissionRequest(requestId, params)
          : makeFilePermissionRequest(requestId, params);
    applyProviderActivity(
      services,
      liveSession.sessionId,
      { provider: "codex", channel: "structured_live", authority: "derived", raw: rpcRequest },
      liveSession.currentTurnId
        ? { type: "permission_requested", request: permissionRequest, turnId: liveSession.currentTurnId }
        : { type: "permission_requested", request: permissionRequest },
    );
    return await new Promise((resolve) => {
      liveSession.pendingApprovals.set(requestId, {
        kind: approvalKind,
        resolve,
        requestId,
        itemId,
        approvalProtocol:
          rpcRequest.method === "execCommandApproval" ||
          rpcRequest.method === "applyPatchApproval"
            ? "legacy"
            : "v2",
        ...(approvalKind === "permissions" ? { requestedPermissions: params.permissions } : {}),
      });
    });
  }

  if (rpcRequest.method === "mcpServer/elicitation/request") {
    const params =
      rpcRequest.params && typeof rpcRequest.params === "object" && !Array.isArray(rpcRequest.params)
        ? (rpcRequest.params as Record<string, unknown>)
        : {};
    const requestId = `permission-mcp-${rpcRequest.id}`;
    const turnId = typeof params.turnId === "string" ? params.turnId : liveSession.currentTurnId ?? undefined;
    applyProviderActivity(
      services,
      liveSession.sessionId,
      { provider: "codex", channel: "structured_live", authority: "derived", raw: rpcRequest },
      turnId
        ? {
            type: "permission_requested",
            request: makeMcpElicitationPermissionRequest(requestId, params),
            turnId,
          }
        : {
            type: "permission_requested",
            request: makeMcpElicitationPermissionRequest(requestId, params),
          },
    );
    return await new Promise((resolve) => {
      liveSession.pendingApprovals.set(requestId, {
        kind: "mcp_elicitation",
        resolve,
        requestId,
        itemId: requestId,
      });
    });
  }

  if (rpcRequest.method === "item/tool/call") {
    const params =
      rpcRequest.params && typeof rpcRequest.params === "object" && !Array.isArray(rpcRequest.params)
        ? (rpcRequest.params as Record<string, unknown>)
        : {};
    const callId = typeof params.callId === "string" ? params.callId : `dynamic-${rpcRequest.id}`;
    const tool = typeof params.tool === "string" ? params.tool : "dynamic tool";
    const turnId = typeof params.turnId === "string" ? params.turnId : liveSession.currentTurnId ?? undefined;
    applyProviderActivity(
      services,
      liveSession.sessionId,
      { provider: "codex", channel: "structured_live", authority: "derived", raw: rpcRequest },
      {
        type: "operation_requested",
        ...(turnId !== undefined ? { turnId } : {}),
        operation: {
          id: callId,
          kind: "external_tool",
          name: tool,
          target: "client",
          input: params as never,
        },
      },
    );
    applyProviderActivity(
      services,
      liveSession.sessionId,
      { provider: "codex", channel: "structured_live", authority: "derived", raw: rpcRequest },
      {
        type: "tool_call_failed",
        ...(turnId !== undefined ? { turnId } : {}),
        toolCallId: callId,
        error: "RAH does not implement client-side dynamic tool execution yet.",
      },
    );
    return {
      contentItems: [
        {
          type: "inputText",
          text: "RAH does not implement client-side dynamic tool execution yet.",
        },
      ],
      success: false,
    };
  }

  if (rpcRequest.method === "account/chatgptAuthTokens/refresh") {
    applyProviderActivity(
      services,
      liveSession.sessionId,
      { provider: "codex", channel: "structured_live", authority: "derived", raw: rpcRequest },
      {
        type: "operation_requested",
        operation: {
          id: `auth-refresh-${rpcRequest.id}`,
          kind: "provider_internal",
          name: "ChatGPT auth token refresh",
          target: "account",
          input: (rpcRequest.params ?? {}) as never,
        },
      },
    );
    throw new Error("RAH does not manage ChatGPT auth token refresh requests.");
  }

  return {};
}

export function createLiveSessionBridge(
  services: RuntimeServices,
  client: CodexJsonRpcClient,
) {
  const bufferedNotifications: JsonRpcNotification[] = [];
  const bufferedRequests: BufferedServerRequest[] = [];
  let liveSession: LiveCodexSession | null = null;

  client.setNotificationHandler((notification) => {
    if (!liveSession) {
      bufferedNotifications.push(notification);
      return;
    }
    handleCodexLiveNotification(services, liveSession, notification);
  });

  client.setRequestHandler((request) => {
    if (liveSession) {
      return handleCodexLiveRequest(services, liveSession, request);
    }
    return new Promise((resolve, reject) => {
      bufferedRequests.push({
        request,
        resolve,
        reject,
      });
    });
  });

  return {
    activate(nextLiveSession: LiveCodexSession) {
      liveSession = nextLiveSession;
      for (const notification of bufferedNotifications.splice(0)) {
        handleCodexLiveNotification(services, nextLiveSession, notification);
      }
      for (const pending of bufferedRequests.splice(0)) {
        void handleCodexLiveRequest(services, nextLiveSession, pending.request).then(
          pending.resolve,
          (error) => {
            pending.reject(error instanceof Error ? error : new Error(String(error)));
          },
        );
      }
    },
  };
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

export function runtimeStateFromThreadStatus(
  status: unknown,
): ManagedSession["runtimeState"] | undefined {
  if (!status || typeof status !== "object" || Array.isArray(status)) {
    return undefined;
  }
  const record = status as Record<string, unknown>;
  if (record.type === "idle") {
    return "idle";
  }
  if (record.type === "systemError") {
    return "failed";
  }
  if (record.type === "active") {
    const flags = Array.isArray(record.activeFlags)
      ? record.activeFlags.filter((flag): flag is string => typeof flag === "string")
      : [];
    if (flags.includes("waitingOnApproval")) {
      return "waiting_permission";
    }
    if (flags.includes("waitingOnUserInput")) {
      return "waiting_input";
    }
    return "running";
  }
  return undefined;
}

export function isCodexInternalThreadMetadataText(value: string | null | undefined): boolean {
  if (!value) {
    return false;
  }
  return (
    value.includes("<environment_context>") ||
    value.includes("# AGENTS.md instructions") ||
    value.includes("<INSTRUCTIONS>") ||
    value.includes("<permissions instructions>") ||
    value.includes("<skills_instructions>")
  );
}

export function resolveCodexApprovalDecision(
  response: PermissionResponseRequest,
  protocol: "v2" | "legacy",
): string {
  if (isPermissionSessionGrant(response)) {
    return protocol === "legacy" ? "approved_for_session" : "acceptForSession";
  }
  if (isPermissionAbort(response)) {
    return protocol === "legacy" ? "abort" : "cancel";
  }
  if (isPermissionDenied(response)) {
    return protocol === "legacy" ? "denied" : "decline";
  }
  if (response.behavior === "allow") {
    return protocol === "legacy" ? "approved" : "accept";
  }
  return protocol === "legacy" ? "denied" : "decline";
}

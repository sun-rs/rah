import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";
import {
  isPermissionAbort,
  isPermissionDenied,
  isPermissionSessionGrant,
  type AttachSessionRequest,
  type ManagedSession,
  type PermissionRequest,
  type PermissionResponseRequest,
  type ResumeSessionRequest,
  type StartSessionRequest,
} from "@rah/runtime-protocol";
import type { RuntimeServices } from "./provider-adapter";
import { applyProviderActivity, type ProviderActivity } from "./provider-activity";
import {
  mapCodexPermissionResolution,
  mapCodexQuestionRequestToActivities,
  translateCodexAppServerNotification,
  type CodexAppServerTranslationState,
  createCodexAppServerTranslationState,
} from "./codex-app-server-activity";
import {
  replayCodexStoredSessionRollout,
  type CodexStoredSessionRecord,
} from "./codex-stored-sessions";
import { toSessionSummary } from "./session-store";

type JsonRpcResponse = {
  id: number | string;
  result?: unknown;
  error?: { message?: string };
};

type JsonRpcRequest = {
  id: number | string;
  method: string;
  params?: unknown;
};

type JsonRpcNotification = {
  method: string;
  params?: unknown;
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

type LiveQuestionRequest = {
  permissionRequestId: string;
};

type PendingApproval = {
  kind: "command" | "file" | "question" | "permissions" | "mcp_elicitation";
  resolve: (value: unknown) => void;
  requestId: string;
  itemId: string;
  approvalProtocol?: "v2" | "legacy";
  questions?: unknown;
  requestedPermissions?: unknown;
};

export type LiveCodexSession = {
  sessionId: string;
  threadId: string;
  cwd: string;
  client: CodexJsonRpcClient;
  translationState: CodexAppServerTranslationState;
  currentTurnId: string | null;
  pendingQuestions: Map<string, LiveQuestionRequest>;
  pendingApprovals: Map<string, PendingApproval>;
};

type BufferedServerRequest = {
  request: JsonRpcRequest;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

const JSON_RPC_TIMEOUT_MS = 30_000;
const TURN_START_TIMEOUT_MS = 90_000;
const SESSION_SOURCE = {
  provider: "system" as const,
  channel: "system" as const,
  authority: "authoritative" as const,
};

function createInitializeParams() {
  return {
    clientInfo: {
      name: "rah",
      title: "rah",
      version: "0.0.0",
    },
    capabilities: {
      experimentalApi: true,
    },
  };
}

async function resolveCodexBinary(): Promise<string> {
  return process.env.RAH_CODEX_BINARY ?? "codex";
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

function normalizeQuestionInput(raw: unknown) {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw
    .filter((entry) => entry && typeof entry === "object" && !Array.isArray(entry))
    .map((entry) => entry as Record<string, unknown>)
    .flatMap((entry) => {
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

function shouldAttachCurrentTurn(activity: ProviderActivity): boolean {
  switch (activity.type) {
    case "timeline_item":
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

function attachCurrentTurn(activity: ProviderActivity, currentTurnId: string | null): ProviderActivity {
  if (!currentTurnId || !shouldAttachCurrentTurn(activity)) {
    return activity;
  }
  return {
    ...activity,
    turnId: currentTurnId,
  } as ProviderActivity;
}

export class CodexJsonRpcClient {
  private readonly rl: readline.Interface;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly child: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private notificationHandler: ((notification: JsonRpcNotification) => void) | null = null;
  private requestHandler:
    | ((request: JsonRpcRequest) => Promise<unknown> | unknown)
    | null = null;
  private disposed = false;

  constructor(child: ChildProcessWithoutNullStreams) {
    this.child = child;
    this.rl = readline.createInterface({ input: child.stdout });
    this.rl.on("line", (line) => {
      void this.handleLine(line);
    });
    child.on("exit", () => {
      this.disposePending(new Error("Codex app-server exited"));
    });
    child.on("error", (error) => {
      this.disposePending(error instanceof Error ? error : new Error(String(error)));
    });
  }

  setNotificationHandler(handler: (notification: JsonRpcNotification) => void) {
    this.notificationHandler = handler;
  }

  setRequestHandler(handler: (request: JsonRpcRequest) => Promise<unknown> | unknown) {
    this.requestHandler = handler;
  }

  request(method: string, params?: unknown, timeoutMs = JSON_RPC_TIMEOUT_MS): Promise<unknown> {
    if (this.disposed) {
      return Promise.reject(new Error("Codex JSON-RPC client is closed"));
    }
    const id = this.nextId++;
    this.child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex app-server request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
  }

  notify(method: string, params?: unknown): void {
    if (this.disposed) {
      return;
    }
    this.child.stdin.write(`${JSON.stringify({ method, params })}\n`);
  }

  async dispose(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.rl.close();
    this.child.kill("SIGTERM");
  }

  private disposePending(error: Error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.disposed = true;
  }

  private async handleLine(line: string) {
    if (!line.trim()) {
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return;
    }
    const message = parsed as Record<string, unknown>;
    if (typeof message.id === "number" && (message.result !== undefined || message.error !== undefined)) {
      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error && typeof message.error === "object" && !Array.isArray(message.error)) {
        const error = message.error as Record<string, unknown>;
        pending.reject(new Error(typeof error.message === "string" ? error.message : "JSON-RPC error"));
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (typeof message.id === "number" && typeof message.method === "string") {
      const request: JsonRpcRequest = {
        id: message.id,
        method: message.method,
        ...(message.params !== undefined ? { params: message.params } : {}),
      };
      try {
        const result = this.requestHandler ? await this.requestHandler(request) : {};
        this.child.stdin.write(`${JSON.stringify({ id: request.id, result })}\n`);
      } catch (error) {
        this.child.stdin.write(
          `${JSON.stringify({
            id: request.id,
            error: { message: error instanceof Error ? error.message : String(error) },
          })}\n`,
        );
      }
      return;
    }
    if (typeof message.method === "string") {
      this.notificationHandler?.({
        method: message.method,
        ...(message.params !== undefined ? { params: message.params } : {}),
      });
    }
  }
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

function createLiveSessionBridge(
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

export async function createCodexAppServerClient(): Promise<CodexJsonRpcClient> {
  const binary = await resolveCodexBinary();
  const child = spawn(binary, ["app-server"], {
    stdio: ["pipe", "pipe", "pipe"],
    env: process.env,
  });
  const client = new CodexJsonRpcClient(child);
  try {
    await client.request("initialize", createInitializeParams());
    client.notify("initialized", {});
    return client;
  } catch (error) {
    await client.dispose();
    throw error;
  }
}

function runtimeStateFromThreadStatus(status: unknown): ManagedSession["runtimeState"] | undefined {
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

function isCodexInternalThreadMetadataText(value: string | null | undefined): boolean {
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

export async function startCodexLiveSession(params: {
  services: RuntimeServices;
  request: StartSessionRequest;
  onLiveSessionReady: (liveSession: LiveCodexSession) => void;
}) {
  const { services, request } = params;
  const client = await createCodexAppServerClient();
  const bridge = createLiveSessionBridge(services, client);

  const threadStart = (await client.request("thread/start", {
    ...(request.cwd ? { cwd: request.cwd } : {}),
    approvalPolicy: request.approvalPolicy ?? "never",
    sandbox: request.sandbox ?? "danger-full-access",
    ...(request.model ? { model: request.model } : {}),
    experimentalRawEvents: false,
    persistExtendedHistory: true,
    ...(request.title ? { name: request.title } : {}),
  })) as { thread?: { id?: string } };
  const threadId = threadStart?.thread?.id;
  if (!threadId) {
    await client.dispose();
    throw new Error("Codex app-server did not return a thread id.");
  }

  const state = services.sessionStore.createManagedSession({
    provider: "codex",
    providerSessionId: threadId,
    launchSource: "web",
    cwd: request.cwd,
    rootDir: request.cwd,
    ...(request.title !== undefined ? { title: request.title } : {}),
    ...(request.initialPrompt !== undefined ? { preview: request.initialPrompt } : {}),
    capabilities: {
      steerInput: true,
    },
  });
  services.ptyHub.ensureSession(state.session.id);
  services.sessionStore.setRuntimeState(state.session.id, "idle");
  const runtimeSession = services.sessionStore.getSession(state.session.id);
  if (!runtimeSession) {
    await client.dispose();
    throw new Error("Failed to create runtime session for Codex live session.");
  }
  publishSessionBootstrap(services, state.session.id, runtimeSession.session);

  const liveSession: LiveCodexSession = {
    sessionId: state.session.id,
    threadId,
    cwd: request.cwd,
    client,
    translationState: createCodexAppServerTranslationState(),
    currentTurnId: runtimeSession.activeTurnId ?? null,
    pendingQuestions: new Map(),
    pendingApprovals: new Map(),
  };
  bridge.activate(liveSession);
  attachRequestedClient(services, state.session.id, request.attach);
  params.onLiveSessionReady(liveSession);
  return {
    sessionId: state.session.id,
    summary: toSessionSummary(services.sessionStore.getSession(state.session.id)!),
  };
}

export async function resumeCodexLiveSession(params: {
  services: RuntimeServices;
  request: ResumeSessionRequest;
  record?: CodexStoredSessionRecord;
  onLiveSessionReady: (liveSession: LiveCodexSession) => void;
}) {
  const { services, request, record } = params;
  const client = await createCodexAppServerClient();
  const bridge = createLiveSessionBridge(services, client);
  try {
    const resumeResponse = (await client.request(
      "thread/resume",
      { threadId: request.providerSessionId },
      TURN_START_TIMEOUT_MS,
    )) as {
      thread?: {
        id?: string;
        cwd?: string;
        preview?: string;
        name?: string | null;
        status?: unknown;
      };
      cwd?: string;
    };
    const thread = resumeResponse.thread;
    const threadId =
      (thread && typeof thread.id === "string" ? thread.id : null) ?? request.providerSessionId;
    const cwd =
      (typeof resumeResponse.cwd === "string" ? resumeResponse.cwd : null) ??
      (thread && typeof thread.cwd === "string" ? thread.cwd : null) ??
      request.cwd ??
      record?.ref.cwd ??
      process.cwd();
    const state = services.sessionStore.createManagedSession({
      provider: "codex",
      providerSessionId: threadId,
      launchSource: "web",
      cwd,
      rootDir: record?.ref.rootDir ?? cwd,
      ...(thread &&
      typeof thread.preview === "string" &&
      thread.preview.trim() &&
      !isCodexInternalThreadMetadataText(thread.preview)
        ? { title: thread.preview }
        : record?.ref.title !== undefined
          ? { title: record.ref.title }
          : thread &&
              typeof thread.name === "string" &&
              thread.name.trim() &&
              !isCodexInternalThreadMetadataText(thread.name)
            ? { title: thread.name }
            : {}),
      ...(thread &&
      typeof thread.preview === "string" &&
      thread.preview.trim() &&
      !isCodexInternalThreadMetadataText(thread.preview)
        ? { preview: thread.preview }
        : record?.ref.preview !== undefined
          ? { preview: record.ref.preview }
          : thread &&
              typeof thread.name === "string" &&
              thread.name.trim() &&
              !isCodexInternalThreadMetadataText(thread.name)
            ? { preview: thread.name }
          : {}),
      capabilities: {
        steerInput: true,
      },
    });
    services.ptyHub.ensureSession(state.session.id);
    services.sessionStore.setRuntimeState(
      state.session.id,
      runtimeStateFromThreadStatus(thread?.status) ?? "idle",
    );
    const runtimeSession = services.sessionStore.getSession(state.session.id);
    if (!runtimeSession) {
      throw new Error("Failed to create runtime session for resumed Codex thread.");
    }
    publishSessionBootstrap(services, state.session.id, runtimeSession.session);

    const attachedBanner = `Attached to external Codex thread ${threadId}\r\n`;
    if (record && request.historyReplay !== "skip") {
      try {
        replayCodexStoredSessionRollout({
          services,
          sessionId: state.session.id,
          record,
          bannerText: attachedBanner,
        });
        if (thread?.status !== undefined) {
          services.sessionStore.setRuntimeState(
            state.session.id,
            runtimeStateFromThreadStatus(thread.status) ?? runtimeSession.session.runtimeState,
          );
        }
      } catch {
        services.ptyHub.appendOutput(state.session.id, attachedBanner);
      }
    } else {
      services.ptyHub.appendOutput(state.session.id, attachedBanner);
    }

    const resumedState = services.sessionStore.getSession(state.session.id);
    if (!resumedState) {
      throw new Error("Failed to restore runtime state for resumed Codex thread.");
    }

    const liveSession: LiveCodexSession = {
      sessionId: state.session.id,
      threadId,
      cwd,
      client,
      translationState: createCodexAppServerTranslationState(),
      currentTurnId: resumedState.activeTurnId ?? null,
      pendingQuestions: new Map(),
      pendingApprovals: new Map(),
    };
    bridge.activate(liveSession);
    attachRequestedClient(services, state.session.id, request.attach);
    params.onLiveSessionReady(liveSession);
    return {
      sessionId: state.session.id,
      summary: toSessionSummary(services.sessionStore.getSession(state.session.id)!),
    };
  } catch (error) {
    await client.dispose();
    throw error;
  }
}

export async function respondToCodexLivePermission(params: {
  services: RuntimeServices;
  liveSession: LiveCodexSession;
  requestId: string;
  response: PermissionResponseRequest;
}) {
  const pending = params.liveSession.pendingApprovals.get(params.requestId);
  if (!pending) {
    throw new Error(`Unknown pending Codex permission request ${params.requestId}.`);
  }
  params.liveSession.pendingApprovals.delete(params.requestId);

  const resolution = mapCodexPermissionResolution({
    requestId: params.requestId,
    behavior: params.response.behavior,
    ...(params.response.message !== undefined ? { message: params.response.message } : {}),
    ...(params.response.selectedActionId !== undefined ? { selectedActionId: params.response.selectedActionId } : {}),
    ...(params.response.decision !== undefined ? { decision: params.response.decision } : {}),
    ...(params.response.answers !== undefined ? { answers: params.response.answers } : {}),
  });
  applyProviderActivity(
    params.services,
    params.liveSession.sessionId,
    { provider: "codex", channel: "structured_live", authority: "derived" },
    attachCurrentTurn(resolution.activity, params.liveSession.currentTurnId),
  );

  if (pending.kind === "question") {
    pending.resolve({
      answers: params.response.answers ?? {},
    });
    return;
  }

  if (pending.kind === "mcp_elicitation") {
    pending.resolve({
      action: params.response.behavior === "allow" ? "accept" : "decline",
      content: params.response.answers ?? null,
      _meta: null,
    });
    return;
  }

  if (pending.kind === "permissions") {
    const requested =
      pending.requestedPermissions &&
      typeof pending.requestedPermissions === "object" &&
      !Array.isArray(pending.requestedPermissions)
        ? (pending.requestedPermissions as Record<string, unknown>)
        : {};
    pending.resolve({
      permissions:
        params.response.behavior === "allow"
          ? {
              ...(requested.network !== undefined && requested.network !== null
                ? { network: requested.network }
                : {}),
              ...(requested.fileSystem !== undefined && requested.fileSystem !== null
                ? { fileSystem: requested.fileSystem }
                : {}),
            }
          : {},
      scope: "turn",
    });
    return;
  }

  pending.resolve({
    decision: resolveCodexApprovalDecision(params.response, pending.approvalProtocol ?? "v2"),
  });
}

function resolveCodexApprovalDecision(
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

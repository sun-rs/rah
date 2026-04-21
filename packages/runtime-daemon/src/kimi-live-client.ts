import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";
import type {
  AttachSessionRequest,
  CloseSessionRequest,
  ContextUsage,
  InterruptSessionRequest,
  ManagedSession,
  PermissionRequest,
  PermissionResponseRequest,
  SessionInputRequest,
  StartSessionRequest,
} from "@rah/runtime-protocol";
import type { RuntimeServices } from "./provider-adapter";
import { applyProviderActivity, type ProviderActivity } from "./provider-activity";
import { toSessionSummary } from "./session-store";

type JsonRpcSuccess = {
  jsonrpc: "2.0";
  id: string;
  result: unknown;
};

type JsonRpcError = {
  jsonrpc: "2.0";
  id: string | null;
  error: { code?: number; message?: string; data?: unknown };
};

type JsonRpcEvent = {
  jsonrpc: "2.0";
  method: "event";
  params: {
    type: string;
    payload: Record<string, unknown>;
  };
};

type JsonRpcRequest = {
  jsonrpc: "2.0";
  method: "request";
  id: string;
  params: {
    type: string;
    payload: Record<string, unknown>;
  };
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

type PendingInteractiveRequest =
  | {
      kind: "approval";
    }
  | {
      kind: "question";
      questions: Array<{ id: string; question: string }>;
    };

type BufferedServerRequest = {
  request: JsonRpcRequest;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

type KimiToolCallState = {
  id: string;
  name: string;
  family: ReturnType<typeof classifyKimiToolFamily>;
  title: string;
  argsText: string;
};

export type LiveKimiTurn = {
  promptRequestId: string;
  turnId: string;
  aborted: boolean;
  completed: boolean;
  latestToolCallId: string | null;
  toolCalls: Map<string, KimiToolCallState>;
};

export type LiveKimiSession = {
  sessionId: string;
  providerSessionId: string;
  cwd: string;
  model?: string;
  approvalMode: string;
  client: KimiJsonRpcClient;
  activeTurn: LiveKimiTurn | null;
  pendingRequests: Map<string, PendingInteractiveRequest>;
};

const JSON_RPC_TIMEOUT_MS = 30_000;
const PROMPT_TIMEOUT_MS = 180_000;
const SESSION_SOURCE = {
  provider: "system" as const,
  channel: "system" as const,
  authority: "authoritative" as const,
};

function classifyKimiToolFamily(name: string) {
  const normalized = name.toLowerCase();
  if (normalized.includes("read")) return "file_read" as const;
  if (normalized.includes("write")) return "file_write" as const;
  if (normalized.includes("replace") || normalized.includes("edit")) return "file_edit" as const;
  if (normalized.includes("shell") || normalized.includes("bash")) return "shell" as const;
  if (normalized.includes("grep") || normalized.includes("glob") || normalized.includes("search"))
    return "search" as const;
  if (normalized.includes("fetch")) return "web_fetch" as const;
  if (normalized.includes("web")) return "web_search" as const;
  if (normalized.includes("todo")) return "todo" as const;
  if (normalized.includes("agent") || normalized.includes("subagent")) return "subagent" as const;
  if (normalized.includes("mcp")) return "mcp" as const;
  return "other" as const;
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
    services.sessionStore.claimControl(sessionId, attach.client.id);
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

class KimiJsonRpcClient {
  private nextId = 1;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly stdout;
  private readonly stderr;

  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly onEvent: (event: JsonRpcEvent) => void,
    private readonly onRequest: (request: JsonRpcRequest) => Promise<void>,
  ) {
    this.stdout = readline.createInterface({
      input: child.stdout,
      crlfDelay: Infinity,
    });
    this.stderr = readline.createInterface({
      input: child.stderr,
      crlfDelay: Infinity,
    });
    this.stdout.on("line", (line) => {
      void this.handleStdoutLine(line);
    });
    this.child.once("exit", (code, signal) => {
      this.rejectAll(
        new Error(`Kimi wire process exited with code ${code ?? 0}${signal ? ` (${signal})` : ""}`),
      );
    });
  }

  onStderrLine(handler: (line: string) => void) {
    this.stderr.on("line", handler);
  }

  private async handleStdoutLine(line: string) {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return;
    }
    const message = parsed as Record<string, unknown>;
    if (typeof message.method === "string") {
      if (message.method === "event") {
        const params =
          message.params && typeof message.params === "object" && !Array.isArray(message.params)
            ? (message.params as Record<string, unknown>)
            : null;
        if (!params || typeof params.type !== "string") {
          return;
        }
        this.onEvent({
          jsonrpc: "2.0",
          method: "event",
          params: {
            type: params.type,
            payload:
              params.payload && typeof params.payload === "object" && !Array.isArray(params.payload)
                ? (params.payload as Record<string, unknown>)
                : {},
          },
        });
        return;
      }
      if (message.method === "request" && typeof message.id === "string") {
        const params =
          message.params && typeof message.params === "object" && !Array.isArray(message.params)
            ? (message.params as Record<string, unknown>)
            : null;
        if (!params || typeof params.type !== "string") {
          return;
        }
        await this.onRequest({
          jsonrpc: "2.0",
          method: "request",
          id: message.id,
          params: {
            type: params.type,
            payload:
              params.payload && typeof params.payload === "object" && !Array.isArray(params.payload)
                ? (params.payload as Record<string, unknown>)
                : {},
          },
        });
        return;
      }
    }
    if (typeof message.id === "string") {
      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error && typeof message.error === "object" && !Array.isArray(message.error)) {
        pending.reject(new Error(String((message.error as Record<string, unknown>).message ?? "JSON-RPC error")));
        return;
      }
      pending.resolve(message.result);
    }
  }

  private write(message: Record<string, unknown>) {
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  request(method: string, params: Record<string, unknown>, timeoutMs = JSON_RPC_TIMEOUT_MS) {
    const id = `rah-kimi-${this.nextId++}`;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for Kimi JSON-RPC response to ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.write({
        jsonrpc: "2.0",
        id,
        method,
        params,
      });
    });
  }

  respondSuccess(id: string, result: Record<string, unknown>) {
    this.write({
      jsonrpc: "2.0",
      id,
      result,
    });
  }

  respondError(id: string, message: string) {
    this.write({
      jsonrpc: "2.0",
      id,
      error: {
        code: -32003,
        message,
      },
    });
  }

  async dispose() {
    this.rejectAll(new Error("Kimi JSON-RPC client disposed"));
    this.stdout.close();
    this.stderr.close();
    this.child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      this.child.once("exit", () => resolve());
      setTimeout(resolve, 2_000);
    });
  }

  private rejectAll(error: Error) {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }
}

async function resolveKimiCommand(): Promise<{ command: string; args: string[] }> {
  if (process.env.RAH_KIMI_BINARY) {
    return { command: process.env.RAH_KIMI_BINARY, args: [] };
  }
  if (process.env.RAH_KIMI_PROJECT) {
    return {
      command: "uv",
      args: ["run", "--project", process.env.RAH_KIMI_PROJECT, "kimi"],
    };
  }
  return { command: "kimi", args: [] };
}

async function createKimiClient(params: {
  providerSessionId: string;
  cwd: string;
  onEvent: (event: JsonRpcEvent) => void;
  onRequest: (request: JsonRpcRequest) => Promise<void>;
}) {
  const { command, args } = await resolveKimiCommand();
  const child = spawn(
    command,
    [...args, "--wire", "--session", params.providerSessionId],
    {
      cwd: params.cwd,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );

  const client = new KimiJsonRpcClient(child, params.onEvent, params.onRequest);
  await client.request("initialize", {
    protocol_version: "1.9",
    client: {
      name: "rah",
      version: "0.0.0",
    },
    capabilities: {
      supports_question: true,
      supports_plan_mode: true,
    },
  });
  return client;
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
    {
      provider: "kimi",
      channel: "structured_live",
      authority: "derived",
      ...(raw !== undefined ? { raw } : {}),
    },
    activity,
  );
}

function mapContentPartToActivity(
  payload: Record<string, unknown>,
  turnId: string,
): ProviderActivity | null {
  const partType = typeof payload.type === "string" ? payload.type : null;
  if (partType === "text") {
    const text = typeof payload.text === "string" ? payload.text : "";
    return text
      ? {
          type: "timeline_item",
          turnId,
          item: { kind: "assistant_message", text },
        }
      : null;
  }
  if (partType === "think") {
    const text = typeof payload.think === "string" ? payload.think : "";
    return text
      ? {
          type: "timeline_item",
          turnId,
          item: { kind: "reasoning", text },
        }
      : null;
  }
  return null;
}

function usageFromStatus(payload: Record<string, unknown>): ContextUsage | undefined {
  const tokenUsage =
    payload.token_usage && typeof payload.token_usage === "object" && !Array.isArray(payload.token_usage)
      ? (payload.token_usage as Record<string, unknown>)
      : null;
  if (
    tokenUsage === null &&
    typeof payload.context_tokens !== "number" &&
    typeof payload.max_context_tokens !== "number"
  ) {
    return undefined;
  }
  return {
    ...(typeof payload.context_tokens === "number" ? { usedTokens: payload.context_tokens } : {}),
    ...(typeof payload.max_context_tokens === "number"
      ? { contextWindow: payload.max_context_tokens }
      : {}),
    ...(typeof payload.context_usage === "number"
      ? { percentRemaining: Math.max(0, 100 - payload.context_usage * 100) }
      : {}),
    ...(tokenUsage && typeof tokenUsage.input_other === "number"
      ? { inputTokens: tokenUsage.input_other }
      : {}),
    ...(tokenUsage && typeof tokenUsage.input_cache_read === "number"
      ? { cachedInputTokens: tokenUsage.input_cache_read }
      : {}),
    ...(tokenUsage && typeof tokenUsage.output === "number"
      ? { outputTokens: tokenUsage.output }
      : {}),
  };
}

function finalizeTurn(
  services: RuntimeServices,
  liveSession: LiveKimiSession,
  activity: ProviderActivity,
) {
  const activeTurn = liveSession.activeTurn;
  if (!activeTurn || activeTurn.completed) {
    return;
  }
  activeTurn.completed = true;
  applyActivity(services, liveSession.sessionId, activity);
  applyActivity(services, liveSession.sessionId, { type: "session_state", state: "idle" });
  services.sessionStore.setActiveTurn(liveSession.sessionId, undefined);
  liveSession.activeTurn = null;
}

async function handleKimiRequest(
  services: RuntimeServices,
  liveSession: LiveKimiSession,
  request: JsonRpcRequest,
) {
  switch (request.params.type) {
    case "ApprovalRequest": {
      liveSession.pendingRequests.set(request.id, { kind: "approval" });
      applyActivity(
        services,
        liveSession.sessionId,
        {
          type: "permission_requested",
          ...(liveSession.activeTurn ? { turnId: liveSession.activeTurn.turnId } : {}),
          request: approvalRequestFromPayload(request.id, request.params.payload),
        },
        request,
      );
      return;
    }
    case "QuestionRequest": {
      const mapped = questionRequestFromPayload(request.id, request.params.payload);
      liveSession.pendingRequests.set(request.id, {
        kind: "question",
        questions: mapped.questions,
      });
      applyActivity(
        services,
        liveSession.sessionId,
        {
          type: "permission_requested",
          ...(liveSession.activeTurn ? { turnId: liveSession.activeTurn.turnId } : {}),
          request: mapped.request,
        },
        request,
      );
      return;
    }
    case "ToolCallRequest": {
      request.params;
      liveSession.client.respondError(request.id, "RAH does not support Kimi external tool calls yet.");
      return;
    }
    default: {
      liveSession.client.respondError(request.id, `Unsupported Kimi wire request: ${request.params.type}`);
    }
  }
}

function approvalRequestFromPayload(
  requestId: string,
  payload: Record<string, unknown>,
): PermissionRequest {
  return {
    id: requestId,
    kind: "tool",
    title: typeof payload.action === "string" ? payload.action : "Approval required",
    ...(typeof payload.description === "string" ? { description: payload.description } : {}),
    detail: {
      artifacts: [{ kind: "json", label: "approval", value: payload }],
    },
    actions: [
      { id: "approve", label: "Allow", behavior: "allow", variant: "primary" },
      {
        id: "approve_for_session",
        label: "Allow for session",
        behavior: "allow",
        variant: "secondary",
      },
      { id: "reject", label: "Reject", behavior: "deny", variant: "danger" },
    ],
  };
}

function questionRequestFromPayload(
  requestId: string,
  payload: Record<string, unknown>,
): {
  request: PermissionRequest;
  questions: Array<{ id: string; question: string }>;
} {
  const rawQuestions = Array.isArray(payload.questions) ? payload.questions : [];
  const questions = rawQuestions
    .filter((entry) => entry && typeof entry === "object" && !Array.isArray(entry))
    .map((entry) => entry as Record<string, unknown>)
    .map((entry, index) => {
      const id = `q${index}`;
      const question = typeof entry.question === "string" ? entry.question : `Question ${index + 1}`;
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
      return {
        id,
        question,
        header: typeof entry.header === "string" ? entry.header : `Q${index + 1}`,
        options,
      };
    });

  return {
    request: {
      id: requestId,
      kind: "question",
      title: "Question",
      input: {
        questions: questions.map((question) => ({
          id: question.id,
          header: question.header,
          question: question.question,
          options: question.options,
        })),
      },
    },
    questions: questions.map((question) => ({
      id: question.id,
      question: question.question,
    })),
  };
}

function handleKimiEvent(
  services: RuntimeServices,
  liveSession: LiveKimiSession,
  event: JsonRpcEvent,
) {
  const activeTurn = liveSession.activeTurn;
  const turnId = activeTurn?.turnId;
  const payload = event.params.payload;

  switch (event.params.type) {
    case "TurnBegin":
    case "SteerInput":
      return;
    case "StepBegin":
      if (turnId) {
        applyActivity(services, liveSession.sessionId, {
          type: "turn_step_started",
          turnId,
          ...(typeof payload.n === "number" ? { index: payload.n } : {}),
        }, event);
      }
      return;
    case "StepInterrupted":
      if (turnId) {
        applyActivity(services, liveSession.sessionId, {
          type: "turn_step_interrupted",
          turnId,
        }, event);
      }
      return;
    case "ContentPart": {
      if (!turnId) {
        return;
      }
      const activity = mapContentPartToActivity(payload, turnId);
      if (activity) {
        applyActivity(services, liveSession.sessionId, activity, event);
      }
      return;
    }
    case "ToolCall": {
      if (!turnId || !activeTurn) {
        return;
      }
      const functionBody =
        payload.function && typeof payload.function === "object" && !Array.isArray(payload.function)
          ? (payload.function as Record<string, unknown>)
          : {};
      const name =
        typeof functionBody.name === "string"
          ? functionBody.name
          : typeof payload.name === "string"
            ? payload.name
            : "unknown";
      const id = typeof payload.id === "string" ? payload.id : randomUUID();
      const state: KimiToolCallState = {
        id,
        name,
        family: classifyKimiToolFamily(name),
        title: name,
        argsText: typeof functionBody.arguments === "string" ? functionBody.arguments : "",
      };
      activeTurn.latestToolCallId = id;
      activeTurn.toolCalls.set(id, state);
      let input: Record<string, unknown> | undefined;
      if (state.argsText) {
        try {
          const parsed = JSON.parse(state.argsText);
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            input = parsed as Record<string, unknown>;
          }
        } catch {}
      }
      applyActivity(services, liveSession.sessionId, {
        type: "tool_call_started",
        turnId,
        toolCall: {
          id,
          family: state.family,
          providerToolName: name,
          title: name,
          ...(input ? { input } : {}),
        },
      }, event);
      return;
    }
    case "ToolCallPart": {
      if (!activeTurn?.latestToolCallId) {
        return;
      }
      const current = activeTurn.toolCalls.get(activeTurn.latestToolCallId);
      if (!current) {
        return;
      }
      if (typeof payload.arguments_part === "string") {
        current.argsText += payload.arguments_part;
      }
      return;
    }
    case "ToolResult": {
      const toolCallId = typeof payload.tool_call_id === "string" ? payload.tool_call_id : null;
      if (!toolCallId) {
        return;
      }
      const pending = activeTurn?.toolCalls.get(toolCallId);
      const returnValue =
        payload.return_value && typeof payload.return_value === "object" && !Array.isArray(payload.return_value)
          ? (payload.return_value as Record<string, unknown>)
          : {};
      let input: Record<string, unknown> | undefined;
      if (pending?.argsText) {
        try {
          const parsed = JSON.parse(pending.argsText);
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            input = parsed as Record<string, unknown>;
          }
        } catch {}
      }
      const text = typeof returnValue.output === "string" && returnValue.output
        ? returnValue.output
        : typeof returnValue.message === "string"
          ? returnValue.message
          : "";
      if (returnValue.is_error) {
        applyActivity(services, liveSession.sessionId, {
          type: "tool_call_failed",
          ...(turnId ? { turnId } : {}),
          toolCallId,
          error: text || "Tool failed",
          ...(text
            ? {
                detail: {
                  artifacts: [{ kind: "text", label: "output", text }],
                },
              }
            : {}),
        }, event);
        return;
      }
      applyActivity(services, liveSession.sessionId, {
        type: "tool_call_completed",
        ...(turnId ? { turnId } : {}),
        toolCall: {
          id: toolCallId,
          family: pending?.family ?? "other",
          providerToolName: pending?.name ?? "unknown",
          title: pending?.title ?? "Tool",
          ...(input ? { input } : {}),
          ...(text
            ? {
                detail: {
                  artifacts: [{ kind: "text", label: "output", text }],
                },
              }
            : {}),
        },
      }, event);
      return;
    }
    case "StatusUpdate": {
      const usage = usageFromStatus(payload);
      if (usage) {
        applyActivity(services, liveSession.sessionId, {
          type: "usage",
          ...(turnId ? { turnId } : {}),
          usage,
        }, event);
      }
      return;
    }
    case "Notification": {
      applyActivity(services, liveSession.sessionId, {
        type: "notification",
        level:
          payload.severity === "error"
            ? "critical"
            : payload.severity === "warning"
              ? "warning"
              : "info",
        title: typeof payload.title === "string" ? payload.title : "Notification",
        body: typeof payload.body === "string" ? payload.body : "",
        ...(turnId ? { turnId } : {}),
      }, event);
      return;
    }
    case "PlanDisplay": {
      if (!turnId) {
        return;
      }
      if (typeof payload.content === "string") {
        applyActivity(services, liveSession.sessionId, {
          type: "timeline_item",
          turnId,
          item: { kind: "plan", text: payload.content },
        }, event);
      }
      return;
    }
    case "ApprovalResponse": {
      applyActivity(services, liveSession.sessionId, {
        type: "permission_resolved",
        ...(turnId ? { turnId } : {}),
        resolution: {
          requestId: String(payload.request_id ?? ""),
          behavior: payload.response === "reject" ? "deny" : "allow",
          ...(typeof payload.response === "string" ? { decision: payload.response } : {}),
        },
      }, event);
      return;
    }
  }
}

export async function startKimiLiveSession(params: {
  services: RuntimeServices;
  request: StartSessionRequest;
}) {
  const { services, request } = params;
  const providerSessionId = randomUUID();
  const state = services.sessionStore.createManagedSession({
    provider: "kimi",
    providerSessionId,
    launchSource: "web",
    cwd: request.cwd,
    rootDir: request.cwd,
    ...(request.title !== undefined ? { title: request.title } : {}),
    ...(request.initialPrompt !== undefined ? { preview: request.initialPrompt } : {}),
    capabilities: {
      livePermissions: true,
      steerInput: true,
      queuedInput: true,
      planMode: true,
    },
  });
  const liveSession: LiveKimiSession = {
    sessionId: state.session.id,
    providerSessionId,
    cwd: request.cwd,
    ...(request.model ? { model: request.model } : {}),
    approvalMode: request.approvalPolicy ?? "yolo",
    client: await createKimiClient({
      providerSessionId,
      cwd: request.cwd,
      onEvent: (event) => handleKimiEvent(services, liveSession, event),
      onRequest: (request) => handleKimiRequest(services, liveSession, request),
    }),
    activeTurn: null,
    pendingRequests: new Map(),
  };
  liveSession.client.onStderrLine((line) => {
    if (!line.trim()) {
      return;
    }
    applyActivity(services, liveSession.sessionId, {
      type: "notification",
      level: "warning",
      title: "Kimi CLI stderr",
      body: line,
    }, line);
  });

  services.sessionStore.setRuntimeState(state.session.id, "idle");
  const session = services.sessionStore.getSession(state.session.id);
  if (!session) {
    await liveSession.client.dispose();
    throw new Error("Failed to create runtime session for Kimi live session.");
  }
  publishSessionBootstrap(services, state.session.id, session.session);
  attachRequestedClient(services, state.session.id, request.attach);
  return {
    liveSession,
    summary: toSessionSummary(services.sessionStore.getSession(state.session.id)!),
  };
}

export async function resumeKimiLiveSession(params: {
  services: RuntimeServices;
  providerSessionId: string;
  cwd: string;
  attach?: AttachSessionRequest;
  model?: string;
  approvalPolicy?: string;
}) {
  const { services } = params;
  const state = services.sessionStore.createManagedSession({
    provider: "kimi",
    providerSessionId: params.providerSessionId,
    launchSource: "web",
    cwd: params.cwd,
    rootDir: params.cwd,
    capabilities: {
      livePermissions: true,
      steerInput: true,
      queuedInput: true,
      planMode: true,
    },
  });
  const liveSession: LiveKimiSession = {
    sessionId: state.session.id,
    providerSessionId: params.providerSessionId,
    cwd: params.cwd,
    ...(params.model ? { model: params.model } : {}),
    approvalMode: params.approvalPolicy ?? "yolo",
    client: await createKimiClient({
      providerSessionId: params.providerSessionId,
      cwd: params.cwd,
      onEvent: (event) => handleKimiEvent(services, liveSession, event),
      onRequest: (request) => handleKimiRequest(services, liveSession, request),
    }),
    activeTurn: null,
    pendingRequests: new Map(),
  };
  liveSession.client.onStderrLine((line) => {
    if (!line.trim()) {
      return;
    }
    applyActivity(services, liveSession.sessionId, {
      type: "notification",
      level: "warning",
      title: "Kimi CLI stderr",
      body: line,
    }, line);
  });
  services.sessionStore.setRuntimeState(state.session.id, "idle");
  const session = services.sessionStore.getSession(state.session.id);
  if (!session) {
    await liveSession.client.dispose();
    throw new Error("Failed to create runtime session for Kimi resume.");
  }
  publishSessionBootstrap(services, state.session.id, session.session);
  attachRequestedClient(services, state.session.id, params.attach);
  return {
    liveSession,
    summary: toSessionSummary(services.sessionStore.getSession(state.session.id)!),
  };
}

export async function sendInputToKimiLiveSession(params: {
  services: RuntimeServices;
  liveSession: LiveKimiSession;
  request: SessionInputRequest;
}) {
  const { services, liveSession, request } = params;
  if (liveSession.activeTurn) {
    throw new Error("Kimi session already has an active turn.");
  }
  if (!services.sessionStore.hasInputControl(liveSession.sessionId, request.clientId)) {
    throw new Error(
      `Client ${request.clientId} does not hold input control for ${liveSession.sessionId}.`,
    );
  }
  const turnId = randomUUID();
  liveSession.activeTurn = {
    promptRequestId: `rah-kimi-prompt-${turnId}`,
    turnId,
    aborted: false,
    completed: false,
    latestToolCallId: null,
    toolCalls: new Map(),
  };
  services.sessionStore.setActiveTurn(liveSession.sessionId, turnId);
  applyActivity(services, liveSession.sessionId, { type: "turn_started", turnId });
  applyActivity(services, liveSession.sessionId, {
    type: "timeline_item",
    turnId,
    item: { kind: "user_message", text: request.text },
  });
  applyActivity(services, liveSession.sessionId, { type: "session_state", state: "running" });

  try {
    const result = await liveSession.client.request(
      "prompt",
      {
        user_input: request.text,
      },
      PROMPT_TIMEOUT_MS,
    );
    const record =
      result && typeof result === "object" && !Array.isArray(result)
        ? (result as Record<string, unknown>)
        : {};
    const status = typeof record.status === "string" ? record.status : "finished";
    if (status === "finished") {
      finalizeTurn(services, liveSession, { type: "turn_completed", turnId });
      return;
    }
    if (status === "cancelled") {
      finalizeTurn(services, liveSession, {
        type: "turn_canceled",
        turnId,
        reason: "cancelled",
      });
      return;
    }
    finalizeTurn(services, liveSession, {
      type: "turn_failed",
      turnId,
      error: status,
    });
  } catch (error) {
    finalizeTurn(services, liveSession, {
      type: "turn_failed",
      turnId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function respondToKimiLivePermission(params: {
  liveSession: LiveKimiSession;
  requestId: string;
  response: PermissionResponseRequest;
}) {
  const { liveSession, requestId, response } = params;
  const pending = liveSession.pendingRequests.get(requestId);
  if (!pending) {
    throw new Error(`Unknown pending Kimi request ${requestId}`);
  }
  if (pending.kind === "approval") {
    const decision =
      response.selectedActionId === "approve"
        ? "approve"
        : response.selectedActionId === "approve_for_session" ||
            response.decision === "approved_for_session"
          ? "approve_for_session"
          : response.behavior === "deny" ||
              response.decision === "denied"
            ? "reject"
            : "approve";
    liveSession.client.respondSuccess(requestId, {
      request_id: requestId,
      response: decision,
      ...(response.message ? { feedback: response.message } : {}),
    });
    liveSession.pendingRequests.delete(requestId);
    return;
  }

  const answers: Record<string, string> = {};
  for (const question of pending.questions) {
    const raw = response.answers?.[question.id];
    const value = raw?.answers?.filter((entry): entry is string => typeof entry === "string").join(", ");
    if (value) {
      answers[question.question] = value;
    }
  }
  liveSession.client.respondSuccess(requestId, {
    request_id: requestId,
    answers,
  });
  liveSession.pendingRequests.delete(requestId);
}

export function interruptKimiLiveSession(params: {
  services: RuntimeServices;
  liveSession: LiveKimiSession;
  request: InterruptSessionRequest;
}) {
  const { services, liveSession, request } = params;
  if (!services.sessionStore.hasInputControl(liveSession.sessionId, request.clientId)) {
    throw new Error(
      `Client ${request.clientId} does not hold input control for ${liveSession.sessionId}.`,
    );
  }
  if (liveSession.activeTurn) {
    liveSession.activeTurn.aborted = true;
  }
  void liveSession.client.request("cancel", {}, JSON_RPC_TIMEOUT_MS).catch(() => undefined);
  const state = services.sessionStore.getSession(liveSession.sessionId);
  if (!state) {
    throw new Error(`Unknown session ${liveSession.sessionId}`);
  }
  return toSessionSummary(state);
}

export async function closeKimiLiveSession(
  liveSession: LiveKimiSession,
  _request?: CloseSessionRequest,
) {
  await liveSession.client.dispose();
}

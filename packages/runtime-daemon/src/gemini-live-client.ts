import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";
import type {
  AttachSessionRequest,
  CloseSessionRequest,
  ContextUsage,
  InterruptSessionRequest,
  ManagedSession,
  SessionInputRequest,
  StartSessionRequest,
} from "@rah/runtime-protocol";
import type { RuntimeServices } from "./provider-adapter";
import { applyProviderActivity, type ProviderActivity } from "./provider-activity";
import { toSessionSummary } from "./session-store";

export type LiveGeminiTurn = {
  child: ChildProcessWithoutNullStreams;
  turnId: string;
  aborted: boolean;
  completed: boolean;
  toolCalls: Map<
    string,
    {
      id: string;
      family: ReturnType<typeof classifyGeminiToolFamily>;
      providerToolName: string;
      title: string;
      input?: Record<string, unknown>;
    }
  >;
};

export type LiveGeminiSession = {
  sessionId: string;
  cwd: string;
  model?: string;
  approvalMode: string;
  providerSessionId?: string;
  activeTurn?: LiveGeminiTurn;
};

const SESSION_SOURCE = {
  provider: "system" as const,
  channel: "system" as const,
  authority: "authoritative" as const,
};

function classifyGeminiToolFamily(name: string) {
  const normalized = name.toLowerCase();
  if (normalized.includes("read") || normalized.includes("open")) return "file_read" as const;
  if (normalized.includes("write")) return "file_write" as const;
  if (normalized.includes("edit") || normalized.includes("replace")) return "file_edit" as const;
  if (normalized.includes("shell") || normalized.includes("bash") || normalized.includes("run"))
    return "shell" as const;
  if (normalized.includes("search") || normalized.includes("glob") || normalized.includes("grep"))
    return "search" as const;
  if (normalized.includes("fetch")) return "web_fetch" as const;
  if (normalized.includes("web")) return "web_search" as const;
  if (normalized.includes("memory")) return "memory" as const;
  if (normalized.includes("todo")) return "todo" as const;
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

async function resolveGeminiBinary(): Promise<string> {
  return process.env.RAH_GEMINI_BINARY ?? "gemini";
}

function buildGeminiArgs(params: {
  prompt: string;
  providerSessionId?: string;
  model?: string;
  approvalMode: string;
}) {
  const args = ["--output-format", "stream-json", "--approval-mode", params.approvalMode];
  if (params.model) {
    args.push("--model", params.model);
  }
  if (params.providerSessionId) {
    args.push("--resume", params.providerSessionId);
  }
  args.push("--prompt", params.prompt);
  return args;
}

function usageFromStats(stats: Record<string, unknown>): ContextUsage {
  return {
    ...(typeof stats.total_tokens === "number" ? { usedTokens: stats.total_tokens } : {}),
    ...(typeof stats.input_tokens === "number" ? { inputTokens: stats.input_tokens } : {}),
    ...(typeof stats.cached === "number" ? { cachedInputTokens: stats.cached } : {}),
    ...(typeof stats.output_tokens === "number" ? { outputTokens: stats.output_tokens } : {}),
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
    {
      provider: "gemini",
      channel: "structured_live",
      authority: "derived",
      ...(raw !== undefined ? { raw } : {}),
    },
    activity,
  );
}

async function runGeminiTurn(params: {
  services: RuntimeServices;
  liveSession: LiveGeminiSession;
  request: SessionInputRequest;
}) {
  const { services, liveSession, request } = params;
  if (liveSession.activeTurn) {
    throw new Error("Gemini session already has an active turn.");
  }
  if (!services.sessionStore.hasInputControl(liveSession.sessionId, request.clientId)) {
    throw new Error(
      `Client ${request.clientId} does not hold input control for ${liveSession.sessionId}.`,
    );
  }

  const turnId = randomUUID();
  const assistantMessageId = `${turnId}:assistant`;
  applyActivity(services, liveSession.sessionId, { type: "turn_started", turnId });
  applyActivity(services, liveSession.sessionId, {
    type: "timeline_item",
    turnId,
    item: {
      kind: "user_message",
      text: request.text,
    },
  });
  applyActivity(services, liveSession.sessionId, { type: "session_state", state: "running" });

  const binary = await resolveGeminiBinary();
  const child = spawn(
    binary,
    buildGeminiArgs({
      prompt: request.text,
      ...(liveSession.providerSessionId ? { providerSessionId: liveSession.providerSessionId } : {}),
      ...(liveSession.model ? { model: liveSession.model } : {}),
      approvalMode: liveSession.approvalMode,
    }),
    {
      cwd: liveSession.cwd,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  child.stdin.end();

  const activeTurn: LiveGeminiTurn = {
    child,
    turnId,
    aborted: false,
    completed: false,
    toolCalls: new Map(),
  };
  liveSession.activeTurn = activeTurn;
  services.sessionStore.setActiveTurn(liveSession.sessionId, turnId);

  const stdout = readline.createInterface({
    input: child.stdout,
    crlfDelay: Infinity,
  });
  const stderr = readline.createInterface({
    input: child.stderr,
    crlfDelay: Infinity,
  });

  stderr.on("line", (line) => {
    if (!line.trim()) {
      return;
    }
    applyActivity(
      services,
      liveSession.sessionId,
      {
        type: "notification",
        level: "warning",
        title: "Gemini CLI stderr",
        body: line,
        turnId,
      },
      line,
    );
  });

  let finalized = false;
  const finalize = (activity: ProviderActivity) => {
    if (finalized) {
      return;
    }
    finalized = true;
    activeTurn.completed = true;
    applyActivity(services, liveSession.sessionId, activity);
    applyActivity(services, liveSession.sessionId, { type: "session_state", state: "idle" });
    services.sessionStore.setActiveTurn(liveSession.sessionId, undefined);
    delete liveSession.activeTurn;
  };

  stdout.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      applyActivity(
        services,
        liveSession.sessionId,
        {
          type: "notification",
          level: "warning",
          title: "Gemini stream parse error",
          body: trimmed,
          turnId,
        },
        trimmed,
      );
      return;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return;
    }
    const event = parsed as Record<string, unknown>;
    switch (event.type) {
      case "init": {
        if (typeof event.session_id === "string") {
          liveSession.providerSessionId = event.session_id;
          services.sessionStore.patchManagedSession(liveSession.sessionId, {
            providerSessionId: event.session_id,
          });
        }
        break;
      }
      case "message": {
        if (event.role !== "assistant" || typeof event.content !== "string") {
          break;
        }
        applyActivity(
          services,
          liveSession.sessionId,
          {
            type: "timeline_item",
            turnId,
            item: {
              kind: "assistant_message",
              text: event.content,
              messageId: assistantMessageId,
            },
          },
          parsed,
        );
        break;
      }
      case "tool_use": {
        if (typeof event.tool_id !== "string" || typeof event.tool_name !== "string") {
          break;
        }
        const toolCall = {
          id: event.tool_id,
          family: classifyGeminiToolFamily(event.tool_name),
          providerToolName: event.tool_name,
          title: event.tool_name,
          ...(event.parameters && typeof event.parameters === "object" && !Array.isArray(event.parameters)
            ? { input: event.parameters as Record<string, unknown> }
            : {}),
        };
        activeTurn.toolCalls.set(event.tool_id, toolCall);
        applyActivity(
          services,
          liveSession.sessionId,
          {
            type: "tool_call_started",
            turnId,
            toolCall,
          },
          parsed,
        );
        break;
      }
      case "tool_result": {
        if (typeof event.tool_id !== "string") {
          break;
        }
        const existing = activeTurn.toolCalls.get(event.tool_id) ?? {
          id: event.tool_id,
          family: "other" as const,
          providerToolName: "unknown",
          title: "Gemini tool",
        };
        const detail =
          typeof event.output === "string" && event.output
            ? {
                artifacts: [{ kind: "text" as const, label: "output", text: event.output }],
              }
            : undefined;
        if (event.status === "error") {
          applyActivity(
            services,
            liveSession.sessionId,
            {
              type: "tool_call_failed",
              turnId,
              toolCallId: event.tool_id,
              error:
                event.error && typeof event.error === "object" && !Array.isArray(event.error)
                  ? String((event.error as Record<string, unknown>).message ?? "Tool failed")
                  : "Tool failed",
              ...(detail ? { detail } : {}),
            },
            parsed,
          );
          break;
        }
        applyActivity(
          services,
          liveSession.sessionId,
          {
            type: "tool_call_completed",
            turnId,
            toolCall: {
              ...existing,
              ...(detail ? { detail } : {}),
            },
          },
          parsed,
        );
        break;
      }
      case "error": {
        const message = typeof event.message === "string" ? event.message : "Gemini CLI error";
        applyActivity(
          services,
          liveSession.sessionId,
          {
            type: "notification",
            level: event.severity === "error" ? "critical" : "warning",
            title: "Gemini CLI error",
            body: message,
            turnId,
          },
          parsed,
        );
        break;
      }
      case "result": {
        if (event.status === "success") {
          if (event.stats && typeof event.stats === "object" && !Array.isArray(event.stats)) {
            applyActivity(services, liveSession.sessionId, {
              type: "usage",
              turnId,
              usage: usageFromStats(event.stats as Record<string, unknown>),
            });
          }
          finalize({ type: "turn_completed", turnId });
          break;
        }
        finalize({
          type: "turn_failed",
          turnId,
          error:
            event.error && typeof event.error === "object" && !Array.isArray(event.error)
              ? String((event.error as Record<string, unknown>).message ?? "Gemini turn failed")
              : "Gemini turn failed",
        });
        break;
      }
    }
  });

  child.once("error", (error) => {
    finalize({
      type: "turn_failed",
      turnId,
      error: error.message,
    });
  });

  child.once("exit", (code, signal) => {
    if (finalized) {
      return;
    }
    if (activeTurn.aborted) {
      finalize({
        type: "turn_canceled",
        turnId,
        reason: signal ? `aborted:${signal}` : "aborted",
      });
      return;
    }
    finalize({
      type: "turn_failed",
      turnId,
      error: signal ? `Gemini CLI exited via ${signal}` : `Gemini CLI exited with ${code ?? 0}`,
    });
  });
}

export function startGeminiLiveSession(params: {
  services: RuntimeServices;
  request: StartSessionRequest;
}) {
  const { services, request } = params;
  const state = services.sessionStore.createManagedSession({
    provider: "gemini",
    launchSource: "web",
    cwd: request.cwd,
    rootDir: request.cwd,
    ...(request.title !== undefined ? { title: request.title } : {}),
    ...(request.initialPrompt !== undefined ? { preview: request.initialPrompt } : {}),
    capabilities: {
      livePermissions: false,
      listProviderSessions: false,
      steerInput: true,
    },
  });
  services.sessionStore.setRuntimeState(state.session.id, "idle");
  const session = services.sessionStore.getSession(state.session.id);
  if (!session) {
    throw new Error("Failed to create runtime session for Gemini live session.");
  }
  publishSessionBootstrap(services, state.session.id, session.session);
  attachRequestedClient(services, state.session.id, request.attach);

  const liveSession: LiveGeminiSession = {
    sessionId: state.session.id,
    cwd: request.cwd,
    ...(request.model ? { model: request.model } : {}),
    approvalMode: request.approvalPolicy ?? "yolo",
  };
  return {
    liveSession,
    summary: toSessionSummary(services.sessionStore.getSession(state.session.id)!),
  };
}

export function resumeGeminiLiveSession(params: {
  services: RuntimeServices;
  request: {
    providerSessionId: string;
    cwd?: string;
    model?: string;
    approvalPolicy?: string;
    attach?: AttachSessionRequest;
  };
}) {
  const { services, request } = params;
  const cwd = request.cwd ?? process.cwd();
  const state = services.sessionStore.createManagedSession({
    provider: "gemini",
    providerSessionId: request.providerSessionId,
    launchSource: "web",
    cwd,
    rootDir: cwd,
    capabilities: {
      livePermissions: false,
      listProviderSessions: false,
      steerInput: true,
    },
  });
  services.sessionStore.setRuntimeState(state.session.id, "idle");
  const session = services.sessionStore.getSession(state.session.id);
  if (!session) {
    throw new Error("Failed to create runtime session for Gemini resume.");
  }
  publishSessionBootstrap(services, state.session.id, session.session);
  attachRequestedClient(services, state.session.id, request.attach);
  const liveSession: LiveGeminiSession = {
    sessionId: state.session.id,
    cwd,
    ...(request.model ? { model: request.model } : {}),
    approvalMode: request.approvalPolicy ?? "yolo",
    providerSessionId: request.providerSessionId,
  };
  return {
    liveSession,
    summary: toSessionSummary(services.sessionStore.getSession(state.session.id)!),
  };
}

export async function sendInputToGeminiLiveSession(params: {
  services: RuntimeServices;
  liveSession: LiveGeminiSession;
  sessionId: string;
  request: SessionInputRequest;
}) {
  await runGeminiTurn({
    services: params.services,
    liveSession: params.liveSession,
    request: params.request,
  });
}

export function interruptGeminiLiveSession(params: {
  services: RuntimeServices;
  liveSession: LiveGeminiSession;
  request: InterruptSessionRequest;
}) {
  const { services, liveSession, request } = params;
  if (!services.sessionStore.hasInputControl(liveSession.sessionId, request.clientId)) {
    throw new Error(
      `Client ${request.clientId} does not hold input control for ${liveSession.sessionId}.`,
    );
  }
  liveSession.activeTurn?.child.kill("SIGINT");
  if (liveSession.activeTurn) {
    liveSession.activeTurn.aborted = true;
  }
  const state = services.sessionStore.getSession(liveSession.sessionId);
  if (!state) {
    throw new Error(`Unknown session ${liveSession.sessionId}`);
  }
  return toSessionSummary(state);
}

export async function closeGeminiLiveSession(
  liveSession: LiveGeminiSession,
  _request?: CloseSessionRequest,
) {
  if (liveSession.activeTurn) {
    liveSession.activeTurn.aborted = true;
    liveSession.activeTurn.child.kill("SIGTERM");
  }
}

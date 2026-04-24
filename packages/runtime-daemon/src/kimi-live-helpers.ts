import { randomUUID } from "node:crypto";
import {
  type AttachSessionRequest,
  type ContextUsage,
  type ManagedSession,
  type PermissionRequest,
} from "@rah/runtime-protocol";
import type { RuntimeServices } from "./provider-adapter";
import { applyProviderActivity, type ProviderActivity } from "./provider-activity";
import {
  SESSION_SOURCE,
  type JsonRpcEvent,
  type JsonRpcRequest,
  type KimiToolCallState,
  type LiveKimiSession,
  type LiveKimiTurn,
} from "./kimi-live-types";

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

export function finalizeTurn(
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

export async function handleKimiRequest(
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
      liveSession.client.respondError(request.id, "RAH does not support Kimi external tool calls yet.");
      return;
    }
    default: {
      liveSession.client.respondError(request.id, `Unsupported Kimi wire request: ${request.params.type}`);
    }
  }
}

export function handleKimiEvent(
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
        applyActivity(
          services,
          liveSession.sessionId,
          {
            type: "turn_step_started",
            turnId,
            ...(typeof payload.n === "number" ? { index: payload.n } : {}),
          },
          event,
        );
      }
      return;
    case "StepInterrupted":
      if (turnId) {
        applyActivity(
          services,
          liveSession.sessionId,
          {
            type: "turn_step_interrupted",
            turnId,
          },
          event,
        );
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
      applyActivity(
        services,
        liveSession.sessionId,
        {
          type: "tool_call_started",
          turnId,
          toolCall: {
            id,
            family: state.family,
            providerToolName: name,
            title: name,
            ...(input ? { input } : {}),
          },
        },
        event,
      );
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
      const text =
        typeof returnValue.output === "string" && returnValue.output
          ? returnValue.output
          : typeof returnValue.message === "string"
            ? returnValue.message
            : "";
      if (returnValue.is_error) {
        applyActivity(
          services,
          liveSession.sessionId,
          {
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
          },
          event,
        );
        return;
      }
      applyActivity(
        services,
        liveSession.sessionId,
        {
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
        },
        event,
      );
      return;
    }
    case "StatusUpdate": {
      const usage = usageFromStatus(payload);
      if (usage) {
        applyActivity(
          services,
          liveSession.sessionId,
          {
            type: "usage",
            ...(turnId ? { turnId } : {}),
            usage,
          },
          event,
        );
      }
      return;
    }
    case "Notification": {
      applyActivity(
        services,
        liveSession.sessionId,
        {
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
        },
        event,
      );
      return;
    }
    case "PlanDisplay": {
      if (!turnId) {
        return;
      }
      if (typeof payload.content === "string") {
        applyActivity(
          services,
          liveSession.sessionId,
          {
            type: "timeline_item",
            turnId,
            item: { kind: "plan", text: payload.content },
          },
          event,
        );
      }
      return;
    }
    case "ApprovalResponse": {
      applyActivity(
        services,
        liveSession.sessionId,
        {
          type: "permission_resolved",
          ...(turnId ? { turnId } : {}),
          resolution: {
            requestId: String(payload.request_id ?? ""),
            behavior: payload.response === "reject" ? "deny" : "allow",
            ...(typeof payload.response === "string" ? { decision: payload.response } : {}),
          },
        },
        event,
      );
      return;
    }
  }
}

export function bindKimiClientStderr(
  services: RuntimeServices,
  liveSession: LiveKimiSession,
) {
  liveSession.client.onStderrLine((line) => {
    if (!line.trim()) {
      return;
    }
    applyActivity(
      services,
      liveSession.sessionId,
      {
        type: "notification",
        level: "warning",
        title: "Kimi CLI stderr",
        body: line,
      },
      line,
    );
  });
}

export function createInitialKimiTurn(turnId: string): LiveKimiTurn {
  return {
    promptRequestId: `rah-kimi-prompt-${turnId}`,
    turnId,
    aborted: false,
    completed: false,
    latestToolCallId: null,
    toolCalls: new Map(),
  };
}

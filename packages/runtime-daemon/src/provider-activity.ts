import type {
  AttentionItem,
  ContextUsage,
  EventAuthority,
  EventChannel,
  JsonObject,
  JsonValue,
  ManagedSession,
  MessagePartRef,
  PermissionRequest,
  PermissionResolution,
  RahEvent,
  RuntimeOperation,
  TimelineItem,
  ToolCall,
  ToolCallDetail,
  WorkbenchObservation,
} from "@rah/runtime-protocol";
import { normalizeContextUsage } from "./context-usage";
import type { RuntimeServices } from "./provider-adapter";

export interface ProviderActivityMeta {
  provider: ManagedSession["provider"];
  channel?: EventChannel;
  authority?: EventAuthority;
  raw?: unknown;
  ts?: string;
}

export type ProviderActivity =
  | {
      type: "session_state";
      state: ManagedSession["runtimeState"];
    }
  | {
      type: "session_failed";
      error: string;
    }
  | {
      type: "session_exited";
      exitCode?: number;
      signal?: string;
    }
  | {
      type: "turn_started";
      turnId: string;
    }
  | {
      type: "turn_completed";
      turnId: string;
      usage?: ContextUsage;
    }
  | {
      type: "turn_failed";
      turnId: string;
      error: string;
      code?: string;
    }
  | {
      type: "turn_canceled";
      turnId: string;
      reason: string;
    }
  | {
      type: "turn_step_started";
      turnId: string;
      index?: number;
      title?: string;
    }
  | {
      type: "turn_step_completed";
      turnId: string;
      index?: number;
      reason?: string;
    }
  | {
      type: "turn_step_interrupted";
      turnId: string;
      index?: number;
      reason?: string;
    }
  | {
      type: "turn_input_appended";
      turnId: string;
      text?: string;
      parts?: JsonValue[];
    }
  | {
      type: "timeline_item";
      item: TimelineItem;
      turnId?: string;
    }
  | {
      type: "timeline_item_updated";
      item: TimelineItem;
      turnId?: string;
    }
  | {
      type: "message_part_added";
      part: MessagePartRef;
      turnId?: string;
    }
  | {
      type: "message_part_updated";
      part: MessagePartRef;
      turnId?: string;
    }
  | {
      type: "message_part_delta";
      part: MessagePartRef;
      turnId?: string;
    }
  | {
      type: "message_part_removed";
      messageId: string;
      partId: string;
      turnId?: string;
    }
  | {
      type: "tool_call_started";
      toolCall: ToolCall;
      turnId?: string;
    }
  | {
      type: "tool_call_delta";
      toolCallId: string;
      detail: ToolCallDetail;
      turnId?: string;
    }
  | {
      type: "tool_call_completed";
      toolCall: ToolCall;
      turnId?: string;
    }
  | {
      type: "tool_call_failed";
      toolCallId: string;
      error: string;
      turnId?: string;
    }
  | {
      type: "observation_started";
      observation: WorkbenchObservation;
      turnId?: string;
    }
  | {
      type: "observation_updated";
      observation: WorkbenchObservation;
      turnId?: string;
    }
  | {
      type: "observation_completed";
      observation: WorkbenchObservation;
      turnId?: string;
    }
  | {
      type: "observation_failed";
      observation: WorkbenchObservation;
      error?: string;
      turnId?: string;
    }
  | {
      type: "permission_requested";
      request: PermissionRequest;
      turnId?: string;
    }
  | {
      type: "permission_resolved";
      resolution: PermissionResolution;
      turnId?: string;
    }
  | {
      type: "operation_started";
      operation: RuntimeOperation;
      turnId?: string;
    }
  | {
      type: "operation_resolved";
      operation: RuntimeOperation;
      turnId?: string;
    }
  | {
      type: "operation_requested";
      operation: RuntimeOperation;
      turnId?: string;
    }
  | {
      type: "governance_updated";
      policy: JsonObject;
      turnId?: string;
    }
  | {
      type: "usage";
      usage: ContextUsage;
      turnId?: string;
    }
  | {
      type: "runtime_status";
      status:
        | "connecting"
        | "connected"
        | "authenticated"
        | "session_active"
        | "thinking"
        | "streaming"
        | "retrying"
        | "finished"
        | "error";
      detail?: string;
      retryCount?: number;
      turnId?: string;
    }
  | {
      type: "attention";
      item: AttentionItem;
    }
  | {
      type: "attention_cleared";
      id: string;
    }
  | {
      type: "notification";
      level: "info" | "warning" | "critical";
      title: string;
      body: string;
      url?: string;
      turnId?: string;
    }
  | {
      type: "host_updated";
      hostId: string;
      metadata?: JsonObject;
    }
  | {
      type: "transport_changed";
      status: string;
      subscriptionId?: string;
    }
  | {
      type: "heartbeat";
      timestamp?: number;
    }
  | {
      type: "terminal_output";
      data: string;
    }
  | {
      type: "terminal_exited";
      exitCode?: number;
      signal?: string;
    };

function sourceFromMeta(meta: ProviderActivityMeta) {
  return {
    provider: meta.provider,
    channel: meta.channel ?? "structured_live",
    authority: meta.authority ?? "derived",
  } as const;
}

function withRaw<T extends object>(value: T, meta: ProviderActivityMeta): T & { raw?: unknown } {
  if (meta.raw === undefined) {
    return value as T & { raw?: unknown };
  }
  return {
    ...value,
    raw: meta.raw,
  };
}

function withTurnId<T extends object>(value: T, turnId?: string): T & { turnId?: string } {
  if (turnId === undefined) {
    return value as T & { turnId?: string };
  }
  return {
    ...value,
    turnId,
  };
}

function withTs<T extends object>(value: T, ts?: string): T & { ts?: string } {
  if (ts === undefined) {
    return value as T & { ts?: string };
  }
  return {
    ...value,
    ts,
  };
}

function attentionForPermission(params: {
  sessionId: string;
  request: PermissionRequest;
  ts?: string;
}): AttentionItem {
  return {
    id: `attention-permission-${params.request.id}`,
    sessionId: params.sessionId,
    level: "warning",
    reason: "permission_needed",
    title: params.request.title,
    body: params.request.description ?? "Agent needs permission to continue.",
    dedupeKey: `permission:${params.request.id}`,
    createdAt: params.ts ?? new Date().toISOString(),
  };
}

function attentionForTurnFailure(params: {
  sessionId: string;
  turnId: string;
  error: string;
  ts?: string;
}): AttentionItem {
  return {
    id: `attention-turn-failed-${params.turnId}`,
    sessionId: params.sessionId,
    level: "critical",
    reason: "turn_failed",
    title: "Turn failed",
    body: params.error,
    dedupeKey: `turn_failed:${params.turnId}`,
    createdAt: params.ts ?? new Date().toISOString(),
  };
}

export function applyProviderActivity(
  services: RuntimeServices,
  sessionId: string,
  meta: ProviderActivityMeta,
  activity: ProviderActivity,
): RahEvent[] {
  const source = sourceFromMeta(meta);
  const ts = meta.ts;
  const published: RahEvent[] = [];

  switch (activity.type) {
    case "session_state":
      services.sessionStore.setRuntimeState(sessionId, activity.state);
      published.push(
        services.eventBus.publish(
          withRaw(
            withTs(
              {
                sessionId,
                type: "session.state.changed",
                source,
                payload: { state: activity.state },
              },
              ts,
            ),
            meta,
          ),
        ),
      );
      break;
    case "session_failed":
      services.sessionStore.setRuntimeState(sessionId, "failed");
      published.push(
        services.eventBus.publish(
          withRaw(
            withTs(
              {
                sessionId,
                type: "session.failed",
                source,
                payload: { error: activity.error },
              },
              ts,
            ),
            meta,
          ),
        ),
      );
      break;
    case "session_exited":
      services.sessionStore.setRuntimeState(sessionId, "stopped");
      services.ptyHub.emitExit(sessionId, activity.exitCode, activity.signal);
      published.push(
        services.eventBus.publish(
          withRaw(
            withTs(
              {
                sessionId,
                type: "session.exited",
                source,
                payload: {
                  ...(activity.exitCode !== undefined ? { exitCode: activity.exitCode } : {}),
                  ...(activity.signal !== undefined ? { signal: activity.signal } : {}),
                },
              },
              ts,
            ),
            meta,
          ),
        ),
      );
      break;
    case "turn_started":
      services.sessionStore.setActiveTurn(sessionId, activity.turnId);
      services.sessionStore.setRuntimeState(sessionId, "running");
      published.push(
        services.eventBus.publish(
          withRaw(
            withTs(
              {
                sessionId,
                type: "turn.started",
                source,
                payload: {},
                turnId: activity.turnId,
              },
              ts,
            ),
            meta,
          ),
        ),
      );
      break;
    case "turn_completed":
      services.sessionStore.setActiveTurn(sessionId, undefined);
      services.sessionStore.setRuntimeState(sessionId, "idle");
      const completedUsage = activity.usage ? normalizeContextUsage(activity.usage) : undefined;
      if (activity.usage) {
        services.sessionStore.updateUsage(sessionId, completedUsage);
      }
      published.push(
        services.eventBus.publish(
          withRaw(
            withTs(
              {
                sessionId,
                type: "turn.completed",
                source,
                payload: completedUsage ? { usage: completedUsage } : {},
                turnId: activity.turnId,
              },
              ts,
            ),
            meta,
          ),
        ),
      );
      break;
    case "turn_failed":
      services.sessionStore.setActiveTurn(sessionId, undefined);
      services.sessionStore.setRuntimeState(sessionId, "failed");
      published.push(
        services.eventBus.publish(
          withRaw(
            withTs(
              {
                sessionId,
                type: "turn.failed",
                source,
                payload: {
                  error: activity.error,
                  ...(activity.code !== undefined ? { code: activity.code } : {}),
                },
                turnId: activity.turnId,
              },
              ts,
            ),
            meta,
          ),
        ),
      );
      published.push(
        services.eventBus.publish(
          withRaw(
            withTs(
              {
                sessionId,
                type: "attention.required",
                source,
                payload: {
                  item: attentionForTurnFailure({
                    sessionId,
                    turnId: activity.turnId,
                    error: activity.error,
                    ...(ts !== undefined ? { ts } : {}),
                  }),
                },
              },
              ts,
            ),
            meta,
          ),
        ),
      );
      break;
    case "turn_canceled":
      services.sessionStore.setActiveTurn(sessionId, undefined);
      services.sessionStore.setRuntimeState(sessionId, "idle");
      published.push(
        services.eventBus.publish(
          withRaw(
            withTs(
              {
                sessionId,
                type: "turn.canceled",
                source,
                payload: { reason: activity.reason },
                turnId: activity.turnId,
              },
              ts,
            ),
            meta,
          ),
        ),
      );
      break;
    case "turn_step_started":
      published.push(
        services.eventBus.publish(
          withRaw(
            withTs(
              {
                sessionId,
                type: "turn.step.started",
                source,
                payload: {
                  ...(activity.index !== undefined ? { index: activity.index } : {}),
                  ...(activity.title !== undefined ? { title: activity.title } : {}),
                },
                turnId: activity.turnId,
              },
              ts,
            ),
            meta,
          ),
        ),
      );
      break;
    case "turn_step_completed":
      published.push(
        services.eventBus.publish(
          withRaw(
            withTs(
              {
                sessionId,
                type: "turn.step.completed",
                source,
                payload: {
                  ...(activity.index !== undefined ? { index: activity.index } : {}),
                  ...(activity.reason !== undefined ? { reason: activity.reason } : {}),
                },
                turnId: activity.turnId,
              },
              ts,
            ),
            meta,
          ),
        ),
      );
      break;
    case "turn_step_interrupted":
      published.push(
        services.eventBus.publish(
          withRaw(
            withTs(
              {
                sessionId,
                type: "turn.step.interrupted",
                source,
                payload: {
                  ...(activity.index !== undefined ? { index: activity.index } : {}),
                  ...(activity.reason !== undefined ? { reason: activity.reason } : {}),
                },
                turnId: activity.turnId,
              },
              ts,
            ),
            meta,
          ),
        ),
      );
      break;
    case "turn_input_appended":
      published.push(
        services.eventBus.publish(
          withRaw(
            withTs(
              {
                sessionId,
                type: "turn.input.appended",
                source,
                payload: {
                  ...(activity.text !== undefined ? { text: activity.text } : {}),
                  ...(activity.parts !== undefined ? { parts: activity.parts } : {}),
                },
                turnId: activity.turnId,
              },
              ts,
            ),
            meta,
          ),
        ),
      );
      break;
    case "timeline_item":
      published.push(
        services.eventBus.publish(
          withRaw(
            withTurnId(
              withTs(
                {
                  sessionId,
                  type: "timeline.item.added",
                  source,
                  payload: { item: activity.item },
                },
                ts,
              ),
              activity.turnId,
            ),
            meta,
          ),
        ),
      );
      break;
    case "timeline_item_updated":
      published.push(
        services.eventBus.publish(
          withRaw(
            withTurnId(
              withTs(
                {
                  sessionId,
                  type: "timeline.item.updated",
                  source,
                  payload: { item: activity.item },
                },
                ts,
              ),
              activity.turnId,
            ),
            meta,
          ),
        ),
      );
      break;
    case "message_part_added":
      published.push(
        services.eventBus.publish(
          withRaw(
            withTurnId(
              withTs(
                {
                  sessionId,
                  type: "message.part.added",
                  source,
                  payload: { part: activity.part },
                },
                ts,
              ),
              activity.turnId,
            ),
            meta,
          ),
        ),
      );
      break;
    case "message_part_updated":
      published.push(
        services.eventBus.publish(
          withRaw(
            withTurnId(
              withTs(
                {
                  sessionId,
                  type: "message.part.updated",
                  source,
                  payload: { part: activity.part },
                },
                ts,
              ),
              activity.turnId,
            ),
            meta,
          ),
        ),
      );
      break;
    case "message_part_delta":
      published.push(
        services.eventBus.publish(
          withRaw(
            withTurnId(
              withTs(
                {
                  sessionId,
                  type: "message.part.delta",
                  source,
                  payload: { part: activity.part },
                },
                ts,
              ),
              activity.turnId,
            ),
            meta,
          ),
        ),
      );
      break;
    case "message_part_removed":
      published.push(
        services.eventBus.publish(
          withRaw(
            withTurnId(
              withTs(
                {
                  sessionId,
                  type: "message.part.removed",
                  source,
                  payload: {
                    messageId: activity.messageId,
                    partId: activity.partId,
                  },
                },
                ts,
              ),
              activity.turnId,
            ),
            meta,
          ),
        ),
      );
      break;
    case "tool_call_started":
      published.push(
        services.eventBus.publish(
          withRaw(
            withTurnId(
              withTs(
                {
                  sessionId,
                  type: "tool.call.started",
                  source,
                  payload: { toolCall: activity.toolCall },
                },
                ts,
              ),
              activity.turnId,
            ),
            meta,
          ),
        ),
      );
      break;
    case "tool_call_delta":
      published.push(
        services.eventBus.publish(
          withRaw(
            withTurnId(
              withTs(
                {
                  sessionId,
                  type: "tool.call.delta",
                  source,
                  payload: {
                    toolCallId: activity.toolCallId,
                    detail: activity.detail,
                  },
                },
                ts,
              ),
              activity.turnId,
            ),
            meta,
          ),
        ),
      );
      break;
    case "tool_call_completed":
      published.push(
        services.eventBus.publish(
          withRaw(
            withTurnId(
              withTs(
                {
                  sessionId,
                  type: "tool.call.completed",
                  source,
                  payload: { toolCall: activity.toolCall },
                },
                ts,
              ),
              activity.turnId,
            ),
            meta,
          ),
        ),
      );
      break;
    case "tool_call_failed":
      published.push(
        services.eventBus.publish(
          withRaw(
            withTurnId(
              withTs(
                {
                  sessionId,
                  type: "tool.call.failed",
                  source,
                  payload: {
                    toolCallId: activity.toolCallId,
                    error: activity.error,
                  },
                },
                ts,
              ),
              activity.turnId,
            ),
            meta,
          ),
        ),
      );
      break;
    case "observation_started":
      published.push(
        services.eventBus.publish(
          withRaw(
            withTurnId(
              withTs(
                {
                  sessionId,
                  type: "observation.started",
                  source,
                  payload: { observation: activity.observation },
                },
                ts,
              ),
              activity.turnId,
            ),
            meta,
          ),
        ),
      );
      break;
    case "observation_updated":
      published.push(
        services.eventBus.publish(
          withRaw(
            withTurnId(
              withTs(
                {
                  sessionId,
                  type: "observation.updated",
                  source,
                  payload: { observation: activity.observation },
                },
                ts,
              ),
              activity.turnId,
            ),
            meta,
          ),
        ),
      );
      break;
    case "observation_completed":
      published.push(
        services.eventBus.publish(
          withRaw(
            withTurnId(
              withTs(
                {
                  sessionId,
                  type: "observation.completed",
                  source,
                  payload: { observation: activity.observation },
                },
                ts,
              ),
              activity.turnId,
            ),
            meta,
          ),
        ),
      );
      break;
    case "observation_failed":
      published.push(
        services.eventBus.publish(
          withRaw(
            withTurnId(
              withTs(
                {
                  sessionId,
                  type: "observation.failed",
                  source,
                  payload: {
                    observation: activity.observation,
                    ...(activity.error !== undefined ? { error: activity.error } : {}),
                  },
                },
                ts,
              ),
              activity.turnId,
            ),
            meta,
          ),
        ),
      );
      break;
    case "permission_requested":
      services.sessionStore.setRuntimeState(sessionId, "waiting_permission");
      published.push(
        services.eventBus.publish(
          withRaw(
            withTurnId(
              withTs(
                {
                  sessionId,
                  type: "permission.requested",
                  source,
                  payload: { request: activity.request },
                },
                ts,
              ),
              activity.turnId,
            ),
            meta,
          ),
        ),
      );
      published.push(
        services.eventBus.publish(
          withRaw(
            withTurnId(
              withTs(
                {
                  sessionId,
                  type: "attention.required",
                  source,
                  payload: {
                    item: attentionForPermission({
                      sessionId,
                      request: activity.request,
                      ...(ts !== undefined ? { ts } : {}),
                    }),
                  },
                },
                ts,
              ),
              activity.turnId,
            ),
            meta,
          ),
        ),
      );
      break;
    case "permission_resolved":
      services.sessionStore.setRuntimeState(sessionId, "running");
      published.push(
        services.eventBus.publish(
          withRaw(
            withTurnId(
              withTs(
                {
                  sessionId,
                  type: "permission.resolved",
                  source,
                  payload: { resolution: activity.resolution },
                },
                ts,
              ),
              activity.turnId,
            ),
            meta,
          ),
        ),
      );
      published.push(
        services.eventBus.publish(
          withRaw(
            withTurnId(
              withTs(
                {
                  sessionId,
                  type: "attention.cleared",
                  source,
                  payload: { id: `attention-permission-${activity.resolution.requestId}` },
                },
                ts,
              ),
              activity.turnId,
            ),
            meta,
          ),
        ),
      );
      break;
    case "operation_started":
      published.push(
        services.eventBus.publish(
          withRaw(
            withTurnId(
              withTs(
                {
                  sessionId,
                  type: "operation.started",
                  source,
                  payload: { operation: activity.operation },
                },
                ts,
              ),
              activity.turnId,
            ),
            meta,
          ),
        ),
      );
      break;
    case "operation_resolved":
      published.push(
        services.eventBus.publish(
          withRaw(
            withTurnId(
              withTs(
                {
                  sessionId,
                  type: "operation.resolved",
                  source,
                  payload: { operation: activity.operation },
                },
                ts,
              ),
              activity.turnId,
            ),
            meta,
          ),
        ),
      );
      break;
    case "operation_requested":
      published.push(
        services.eventBus.publish(
          withRaw(
            withTurnId(
              withTs(
                {
                  sessionId,
                  type: "operation.requested",
                  source,
                  payload: { operation: activity.operation },
                },
                ts,
              ),
              activity.turnId,
            ),
            meta,
          ),
        ),
      );
      break;
    case "governance_updated":
      published.push(
        services.eventBus.publish(
          withRaw(
            withTurnId(
              withTs(
                {
                  sessionId,
                  type: "governance.updated",
                  source,
                  payload: { policy: activity.policy },
                },
                ts,
              ),
              activity.turnId,
            ),
            meta,
          ),
        ),
      );
      break;
    case "usage": {
      const usage = normalizeContextUsage(activity.usage);
      services.sessionStore.updateUsage(sessionId, usage);
      const usageEvent = services.eventBus.publish(
        withRaw(
          withTurnId(
            withTs(
              {
                sessionId,
                type: "usage.updated",
                source,
                payload: { usage },
              },
              ts,
            ),
            activity.turnId,
          ),
          meta,
        ),
      );
      published.push(usageEvent);
      break;
    }
    case "runtime_status":
      published.push(
        services.eventBus.publish(
          withRaw(
            withTurnId(
              withTs(
                {
                  sessionId,
                  type: "runtime.status",
                  source,
                  payload: {
                    status: activity.status,
                    ...(activity.detail !== undefined ? { detail: activity.detail } : {}),
                    ...(activity.retryCount !== undefined ? { retryCount: activity.retryCount } : {}),
                  },
                },
                ts,
              ),
              activity.turnId,
            ),
            meta,
          ),
        ),
      );
      break;
    case "attention":
      published.push(
        services.eventBus.publish(
          withRaw(
            withTs(
              {
                sessionId,
                type: "attention.required",
                source,
                payload: { item: activity.item },
              },
              ts,
            ),
            meta,
          ),
        ),
      );
      break;
    case "attention_cleared":
      published.push(
        services.eventBus.publish(
          withRaw(
            withTs(
              {
                sessionId,
                type: "attention.cleared",
                source,
                payload: { id: activity.id },
              },
              ts,
            ),
            meta,
          ),
        ),
      );
      break;
    case "notification":
      published.push(
        services.eventBus.publish(
          withRaw(
            withTurnId(
              withTs(
                {
                  sessionId,
                  type: "notification.emitted",
                  source,
                  payload: {
                    level: activity.level,
                    title: activity.title,
                    body: activity.body,
                    ...(activity.url !== undefined ? { url: activity.url } : {}),
                  },
                },
                ts,
              ),
              activity.turnId,
            ),
            meta,
          ),
        ),
      );
      break;
    case "host_updated":
      published.push(
        services.eventBus.publish(
          withRaw(
            withTs(
              {
                sessionId,
                type: "host.updated",
                source,
                payload: {
                  hostId: activity.hostId,
                  ...(activity.metadata !== undefined ? { metadata: activity.metadata } : {}),
                },
              },
              ts,
            ),
            meta,
          ),
        ),
      );
      break;
    case "transport_changed":
      published.push(
        services.eventBus.publish(
          withRaw(
            withTs(
              {
                sessionId,
                type: "transport.changed",
                source,
                payload: {
                  status: activity.status,
                  ...(activity.subscriptionId !== undefined
                    ? { subscriptionId: activity.subscriptionId }
                    : {}),
                },
              },
              ts,
            ),
            meta,
          ),
        ),
      );
      break;
    case "heartbeat":
      published.push(
        services.eventBus.publish(
          withRaw(
            withTs(
              {
                sessionId,
                type: "heartbeat",
                source,
                payload: {
                  ...(activity.timestamp !== undefined ? { timestamp: activity.timestamp } : {}),
                },
              },
              ts,
            ),
            meta,
          ),
        ),
      );
      break;
    case "terminal_output":
      services.ptyHub.appendOutput(sessionId, activity.data);
      published.push(
        services.eventBus.publish(
          withRaw(
            withTs(
              {
                sessionId,
                type: "terminal.output",
                source: {
                  provider: "system",
                  channel: "pty",
                  authority: "authoritative",
                },
                payload: { data: activity.data },
              },
              ts,
            ),
            meta,
          ),
        ),
      );
      break;
    case "terminal_exited":
      services.ptyHub.emitExit(sessionId, activity.exitCode, activity.signal);
      published.push(
        services.eventBus.publish(
          withRaw(
            withTs(
              {
                sessionId,
                type: "terminal.exited",
                source: {
                  provider: "system",
                  channel: "pty",
                  authority: "authoritative",
                },
                payload: {
                  ...(activity.exitCode !== undefined ? { exitCode: activity.exitCode } : {}),
                  ...(activity.signal !== undefined ? { signal: activity.signal } : {}),
                },
              },
              ts,
            ),
            meta,
          ),
        ),
      );
      break;
  }

  return published;
}

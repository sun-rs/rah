import type {
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
  TimelineIdentity,
  TimelineRuntimeModel,
  TimelineTurnIdentity,
  TimelineItem,
  ToolCall,
  ToolCallDetail,
  WorkbenchObservation,
} from "@rah/runtime-protocol";
import { normalizeContextUsage } from "./context-usage";
import type { RuntimeServices } from "./provider-adapter";
import { recordTimelineIdentityTelemetry } from "./timeline-identity-telemetry";
import {
  reconcileTimelineActivity,
  reconcileTurnLifecycleActivity,
} from "./timeline-reconciler";
import { COUNCIL_MCP_TIMELINE_MESSAGE_ID_PREFIX } from "./council/council-mcp-projection";
import type { StoredSessionState } from "./session-store";

export interface ProviderActivityMeta {
  provider: ManagedSession["provider"];
  channel?: EventChannel;
  authority?: EventAuthority;
  raw?: unknown;
  ts?: string;
}

function shouldMirrorProviderTerminalOutputToPty(
  state: StoredSessionState | undefined,
): boolean {
  if (!state) {
    return true;
  }
  const { session } = state;
  if (session.runtime?.tuiRole === "session_owner") {
    return true;
  }
  return session.liveBackend === "native_tui" || session.liveBackend === "tui_mux";
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
      identity?: TimelineTurnIdentity;
    }
  | {
      type: "turn_failed";
      turnId: string;
      error: string;
      code?: string;
      identity?: TimelineTurnIdentity;
    }
  | {
      type: "turn_canceled";
      turnId: string;
      reason: string;
      identity?: TimelineTurnIdentity;
    }
  | {
      type: "turn_step_started";
      turnId: string;
      index?: number;
      title?: string;
      runtimeModel?: TimelineRuntimeModel;
    }
  | {
      type: "turn_step_completed";
      turnId: string;
      index?: number;
      reason?: string;
      runtimeModel?: TimelineRuntimeModel;
    }
  | {
      type: "turn_step_interrupted";
      turnId: string;
      index?: number;
      reason?: string;
      runtimeModel?: TimelineRuntimeModel;
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
      identity?: TimelineIdentity;
    }
  | {
      type: "timeline_item_updated";
      item: TimelineItem;
      turnId?: string;
      identity?: TimelineIdentity;
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

function isCouncilManagedSession(services: RuntimeServices, sessionId: string): boolean {
  return services.sessionStore.getSession(sessionId)?.session.origin?.kind === "council";
}

export function isCouncilMcpTimelinePost(item: TimelineItem): boolean {
  return (
    (item.kind === "assistant_message" || item.kind === "user_message") &&
    item.messageId?.startsWith(COUNCIL_MCP_TIMELINE_MESSAGE_ID_PREFIX) === true
  );
}

function isConversationTimelineItem(item: TimelineItem): boolean {
  return item.kind === "user_message" || item.kind === "assistant_message";
}

export function shouldSuppressCouncilManagedActivity(activity: ProviderActivity): boolean {
  switch (activity.type) {
    case "timeline_item":
    case "timeline_item_updated":
      return !isCouncilMcpTimelinePost(activity.item);
    case "runtime_status":
      return activity.status !== "error";
    case "session_state":
      return activity.state !== "stopped" && activity.state !== "failed";
    case "session_failed":
    case "session_exited":
    case "permission_requested":
    case "permission_resolved":
    case "notification":
    case "terminal_exited":
    case "terminal_output":
    case "transport_changed":
    case "host_updated":
    case "heartbeat":
      return false;
    default:
      return true;
  }
}

export function shouldSuppressCouncilManagedHistoryEvent(event: RahEvent): boolean {
  switch (event.type) {
    case "timeline.item.added":
    case "timeline.item.updated":
      return !isCouncilMcpTimelinePost(event.payload.item);
    case "runtime.status":
      return event.payload.status !== "error";
    case "session.state.changed":
      return event.payload.state !== "stopped" && event.payload.state !== "failed";
    case "session.failed":
    case "session.exited":
    case "permission.requested":
    case "permission.resolved":
    case "notification.emitted":
    case "terminal.exited":
    case "terminal.output":
    case "transport.changed":
    case "host.updated":
    case "heartbeat":
      return false;
    default:
      return true;
  }
}

export function applyProviderActivity(
  services: RuntimeServices,
  sessionId: string,
  meta: ProviderActivityMeta,
  activity: ProviderActivity,
): RahEvent[] {
  if (isCouncilManagedSession(services, sessionId) && shouldSuppressCouncilManagedActivity(activity)) {
    return [];
  }
  const source = sourceFromMeta(meta);
  const ts = meta.ts;
  const published: RahEvent[] = [];

  switch (activity.type) {
    case "session_state":
      if (
        activity.state === "idle" ||
        activity.state === "stopped" ||
        activity.state === "failed"
      ) {
        services.sessionStore.setActiveTurn(sessionId, undefined);
      }
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
      {
        const reconciled = reconcileTurnLifecycleActivity(services, sessionId, activity);
        if (reconciled === null) {
          break;
        }
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
                  payload: {
                    ...(completedUsage ? { usage: completedUsage } : {}),
                    ...(reconciled.identity !== undefined ? { identity: reconciled.identity } : {}),
                  },
                  turnId: reconciled.activity.turnId,
                },
                ts,
              ),
              meta,
            ),
          ),
        );
      }
      break;
    case "turn_failed":
      {
        const reconciled = reconcileTurnLifecycleActivity(services, sessionId, activity);
        if (reconciled === null) {
          break;
        }
        services.sessionStore.setActiveTurn(sessionId, undefined);
        services.sessionStore.setRuntimeState(sessionId, "idle");
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
                      status: "error",
                      detail: reconciled.activity.error,
                    },
                  },
                  ts,
                ),
                reconciled.activity.turnId,
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
                  type: "turn.failed",
                  source,
                  payload: {
                    error: reconciled.activity.error,
                    ...(reconciled.activity.code !== undefined ? { code: reconciled.activity.code } : {}),
                    ...(reconciled.identity !== undefined ? { identity: reconciled.identity } : {}),
                  },
                  turnId: reconciled.activity.turnId,
                },
                ts,
              ),
              meta,
            ),
          ),
        );
      }
      break;
    case "turn_canceled":
      {
        const reconciled = reconcileTurnLifecycleActivity(services, sessionId, activity);
        if (reconciled === null) {
          break;
        }
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
                  payload: {
                    reason: reconciled.activity.reason,
                    ...(reconciled.identity !== undefined ? { identity: reconciled.identity } : {}),
                  },
                  turnId: reconciled.activity.turnId,
                },
                ts,
              ),
              meta,
            ),
          ),
        );
      }
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
                  ...(activity.runtimeModel !== undefined ? { runtimeModel: activity.runtimeModel } : {}),
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
                  ...(activity.runtimeModel !== undefined ? { runtimeModel: activity.runtimeModel } : {}),
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
                  ...(activity.runtimeModel !== undefined ? { runtimeModel: activity.runtimeModel } : {}),
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
      recordTimelineIdentityTelemetry(services, {
        sessionId,
        provider: meta.provider,
        channel: meta.channel,
        authority: meta.authority,
        activityType: activity.type,
        item: activity.item,
        turnId: activity.turnId,
        identity: activity.identity,
      });
      {
        const reconciled = reconcileTimelineActivity(services, sessionId, activity);
        if (reconciled === null) {
          break;
        }
        const activityTs = ts ?? new Date().toISOString();
        services.sessionStore.touchSessionActivity(sessionId, activityTs, {
          conversation: isConversationTimelineItem(reconciled.item),
        });
        published.push(
          services.eventBus.publish(
            withRaw(
              withTurnId(
                withTs(
                  {
                    sessionId,
                    type:
                      reconciled.type === "timeline_item_updated"
                        ? "timeline.item.updated"
                        : "timeline.item.added",
                    source,
                    payload: {
                      item: reconciled.item,
                      ...(reconciled.identity !== undefined ? { identity: reconciled.identity } : {}),
                    },
                  },
                  activityTs,
                ),
                reconciled.turnId,
              ),
              meta,
            ),
          ),
        );
      }
      break;
    case "timeline_item_updated":
      recordTimelineIdentityTelemetry(services, {
        sessionId,
        provider: meta.provider,
        channel: meta.channel,
        authority: meta.authority,
        activityType: activity.type,
        item: activity.item,
        turnId: activity.turnId,
        identity: activity.identity,
      });
      {
        const reconciled = reconcileTimelineActivity(services, sessionId, activity);
        if (reconciled === null) {
          break;
        }
        const activityTs = ts ?? new Date().toISOString();
        services.sessionStore.touchSessionActivity(sessionId, activityTs, {
          conversation: isConversationTimelineItem(reconciled.item),
        });
        published.push(
          services.eventBus.publish(
            withRaw(
              withTurnId(
                withTs(
                  {
                    sessionId,
                    type:
                      reconciled.type === "timeline_item_updated"
                        ? "timeline.item.updated"
                        : "timeline.item.added",
                    source,
                    payload: {
                      item: reconciled.item,
                      ...(reconciled.identity !== undefined ? { identity: reconciled.identity } : {}),
                    },
                  },
                  activityTs,
                ),
                reconciled.turnId,
              ),
              meta,
            ),
          ),
        );
      }
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
      if (shouldMirrorProviderTerminalOutputToPty(services.sessionStore.getSession(sessionId))) {
        services.ptyHub.appendOutput(sessionId, activity.data);
      }
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
      if (shouldMirrorProviderTerminalOutputToPty(services.sessionStore.getSession(sessionId))) {
        services.ptyHub.emitExit(sessionId, activity.exitCode, activity.signal);
      }
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

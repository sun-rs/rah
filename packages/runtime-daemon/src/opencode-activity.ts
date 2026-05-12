import { randomUUID } from "node:crypto";
import type {
  ContextUsage,
  JsonObject,
  PermissionAction,
  ProviderKind,
  TimelineIdentity,
  TimelineTurnIdentity,
  ToolCall,
  ToolFamily,
} from "@rah/runtime-protocol";
import type { ProviderActivity } from "./provider-activity";
import {
  createOpenCodeTimelineIdentity,
  createOpenCodeTimelineTurnIdentity,
} from "./opencode-timeline-identity";
import { openCodeRuntimeModelFromMessage } from "./timeline-runtime-model";
import type {
  OpenCodeEvent,
  OpenCodeMessageInfo,
  OpenCodeMessageWithParts,
  OpenCodePart,
} from "./opencode-api";

type OpenCodeMessageRole = "user" | "assistant";

interface OpenCodeActivityStateOptions {
  /**
   * Terminal-owned sessions need provider user messages to open turns. Web-owned
   * sessions already open turns before calling OpenCode, so late user events must
   * not resurrect a completed turn.
   */
  userMessagesStartTurns?: boolean;
  emitUserMessages?: boolean;
  origin?: "live" | "history";
}

export interface OpenCodeActivityState {
  readonly provider: Extract<ProviderKind, "opencode">;
  readonly providerSessionId: string;
  readonly userMessagesStartTurns: boolean;
  readonly emitUserMessages: boolean;
  readonly origin: "live" | "history";
  currentTurnId?: string;
  readonly turnByMessageId: Map<string, string>;
  readonly turnRootMessageIdByMessageId: Map<string, string>;
  readonly roleByMessageId: Map<string, OpenCodeMessageRole>;
  readonly ignoredMessageIds: Set<string>;
  readonly userStartedTurnByMessageId: Map<string, string>;
  readonly runtimeModelByMessageId: Map<string, ReturnType<typeof openCodeRuntimeModelFromMessage>>;
  readonly partMessageIdByPartId: Map<string, string>;
  readonly partTypeByPartId: Map<string, string>;
  readonly partTextByPartId: Map<string, string>;
  readonly pendingPartsByMessageId: Map<string, OpenCodePart[]>;
  readonly pendingTextDeltasByPartId: Map<string, PendingOpenCodeTextDelta[]>;
  readonly pendingSubmittedUserMessages: PendingSubmittedOpenCodeUserMessage[];
  readonly startedToolCallIds: Set<string>;
  readonly completedToolCallIds: Set<string>;
  readonly stepStartedPartIds: Set<string>;
  readonly stepFinishedPartIds: Set<string>;
  readonly nextStepIndexByTurnId: Map<string, number>;
  readonly openStepIndexByTurnId: Map<string, number>;
  readonly stepIndexByPartId: Map<string, number>;
  readonly pendingPermissions: Map<string, string | undefined>;
}

interface PendingOpenCodeTextDelta {
  messageID: string;
  partID: string;
  delta: string;
}

interface PendingSubmittedOpenCodeUserMessage {
  text: string;
  turnId: string;
  clientMessageId?: string;
  clientTurnId?: string;
}

function isOpenCodeInternalInitiatorText(text: string): boolean {
  if (/<!--\s*OMO_INTERNAL_INITIATOR\s*-->/.test(text)) {
    return true;
  }
  if (!/^\s*<system-reminder>[\s\S]*<\/system-reminder>\s*$/m.test(text)) {
    return false;
  }
  return /\[(?:ALL BACKGROUND TASKS COMPLETE|BACKGROUND TASK COMPLETED|BACKGROUND TASK FAILED)\]/.test(text);
}

function isOpenCodeInternalUserPart(part: OpenCodePart): boolean {
  if (part.type !== "text") {
    return false;
  }
  const text = readStringProperty(part, "text");
  return typeof text === "string" && isOpenCodeInternalInitiatorText(text);
}

function isOpenCodeInternalUserMessage(message: OpenCodeMessageWithParts): boolean {
  return message.info.role === "user" && message.parts.some(isOpenCodeInternalUserPart);
}

function forgetOpenCodeInternalUserMessage(state: OpenCodeActivityState, messageId: string): ProviderActivity[] {
  state.ignoredMessageIds.add(messageId);
  const internalTurnId = state.userStartedTurnByMessageId.get(messageId);
  const turnIdentity = internalTurnId ? openCodeTurnIdentityForTurn(state, internalTurnId) : undefined;
  state.turnByMessageId.delete(messageId);
  state.turnRootMessageIdByMessageId.delete(messageId);
  state.roleByMessageId.delete(messageId);
  state.userStartedTurnByMessageId.delete(messageId);
  state.runtimeModelByMessageId.delete(messageId);
  state.pendingPartsByMessageId.delete(messageId);
  for (const [partId, deltas] of [...state.pendingTextDeltasByPartId]) {
    const remaining = deltas.filter((delta) => delta.messageID !== messageId);
    if (remaining.length === 0) {
      state.pendingTextDeltasByPartId.delete(partId);
    } else if (remaining.length !== deltas.length) {
      state.pendingTextDeltasByPartId.set(partId, remaining);
    }
  }
  for (const [partId, mappedMessageId] of [...state.partMessageIdByPartId]) {
    if (mappedMessageId !== messageId) {
      continue;
    }
    state.partMessageIdByPartId.delete(partId);
    state.partTypeByPartId.delete(partId);
    state.partTextByPartId.delete(partId);
    state.pendingTextDeltasByPartId.delete(partId);
  }
  if (!internalTurnId) {
    return [];
  }
  if (state.currentTurnId === internalTurnId) {
    delete state.currentTurnId;
  }
  return [
    { type: "runtime_status", status: "finished", turnId: internalTurnId },
    {
      type: "turn_completed",
      turnId: internalTurnId,
      ...turnIdentityProps(turnIdentity),
    },
  ];
}

export function createOpenCodeActivityState(
  providerSessionId: string,
  options: OpenCodeActivityStateOptions = {},
): OpenCodeActivityState {
  return {
    provider: "opencode",
    providerSessionId,
    userMessagesStartTurns: options.userMessagesStartTurns ?? true,
    emitUserMessages: options.emitUserMessages ?? true,
    origin: options.origin ?? "live",
    turnByMessageId: new Map(),
    turnRootMessageIdByMessageId: new Map(),
    roleByMessageId: new Map(),
    ignoredMessageIds: new Set(),
    userStartedTurnByMessageId: new Map(),
    runtimeModelByMessageId: new Map(),
    partMessageIdByPartId: new Map(),
    partTypeByPartId: new Map(),
    partTextByPartId: new Map(),
    pendingPartsByMessageId: new Map(),
    pendingTextDeltasByPartId: new Map(),
    pendingSubmittedUserMessages: [],
    startedToolCallIds: new Set(),
    completedToolCallIds: new Set(),
    stepStartedPartIds: new Set(),
    stepFinishedPartIds: new Set(),
    nextStepIndexByTurnId: new Map(),
    openStepIndexByTurnId: new Map(),
    stepIndexByPartId: new Map(),
    pendingPermissions: new Map(),
  };
}

export function recordOpenCodeSubmittedUserMessage(
  state: OpenCodeActivityState,
  message: PendingSubmittedOpenCodeUserMessage,
): void {
  state.pendingSubmittedUserMessages.push(message);
}

export function startOpenCodeTurn(
  state: OpenCodeActivityState,
  turnId = randomUUID(),
): ProviderActivity[] {
  state.currentTurnId = turnId;
  return [{ type: "turn_started", turnId }, { type: "runtime_status", status: "thinking", turnId }];
}

export function completeOpenCodeTurn(
  state: OpenCodeActivityState,
  turnId = state.currentTurnId,
): ProviderActivity[] {
  if (!turnId) {
    return [];
  }
  if (state.currentTurnId === turnId) {
    delete state.currentTurnId;
  }
  return [
    { type: "runtime_status", status: "finished", turnId },
    {
      type: "turn_completed",
      turnId,
      ...turnIdentityProps(openCodeTurnIdentityForTurn(state, turnId)),
    },
  ];
}

export function translateOpenCodeHistory(messages: readonly OpenCodeMessageWithParts[]): ProviderActivity[] {
  const state = createOpenCodeActivityState(messages[0]?.info.sessionID ?? "history", {
    origin: "history",
  });
  const activities: ProviderActivity[] = [];
  for (const message of messages) {
    activities.push(...translateOpenCodeMessage(state, message));
  }
  if (state.currentTurnId) {
    activities.push(...completeOpenCodeTurn(state));
  }
  return activities;
}

export function translateOpenCodeMessage(
  state: OpenCodeActivityState,
  message: OpenCodeMessageWithParts,
): ProviderActivity[] {
  if (isOpenCodeInternalUserMessage(message)) {
    return [];
  }
  const activities: ProviderActivity[] = [];
  activities.push(...rememberMessageInfo(state, message.info));
  activities.push(...usageActivitiesForMessageInfo(state, message.info));
  for (const part of message.parts) {
    activities.push(...translateOpenCodePart(state, part));
  }
  if (isOpenCodeMessageAborted(message.info)) {
    activities.push(...cancelOpenCodeTurn(state, message.info));
    return activities;
  }
  if (isTerminalAssistantMessage(message.info)) {
    activities.push(...completeOpenCodeTurn(state, state.turnByMessageId.get(message.info.id) ?? state.currentTurnId));
  }
  return activities;
}

export function translateOpenCodeEvent(
  state: OpenCodeActivityState,
  event: OpenCodeEvent,
): ProviderActivity[] {
  switch (event.type) {
    case "server.connected":
    case "server.heartbeat":
      return [];
    case "session.status":
      return translateStatus(state, event.properties);
    case "session.error":
      return translateError(state, event.properties);
    case "message.updated":
      return translateMessageUpdated(state, event.properties);
    case "message.part.updated":
      return translatePartUpdated(state, event.properties);
    case "message.part.delta":
      return translatePartDelta(state, event.properties);
    case "message.part.removed":
      return translatePartRemoved(state, event.properties);
    case "permission.asked":
      return translatePermissionAsked(state, event.properties);
    case "permission.replied":
      return translatePermissionReplied(state, event.properties);
    default:
      return [];
  }
}

function translateStatus(
  state: OpenCodeActivityState,
  properties: Record<string, unknown> | undefined,
): ProviderActivity[] {
  if (properties?.sessionID !== state.providerSessionId) {
    return [];
  }
  const status = readRecord(properties.status);
  const type = typeof status?.type === "string" ? status.type : undefined;
  if (type === "busy") {
    if (state.currentTurnId) {
      return [{ type: "runtime_status", status: "thinking", turnId: state.currentTurnId }];
    }
    return startOpenCodeTurn(state);
  }
  if (type === "idle") {
    return completeOpenCodeTurn(state);
  }
  if (type === "retry") {
    return [
      {
        type: "runtime_status",
        status: "retrying",
        ...(typeof status?.attempt === "number" ? { retryCount: status.attempt } : {}),
        ...(typeof status?.message === "string" ? { detail: status.message } : {}),
        ...(state.currentTurnId ? { turnId: state.currentTurnId } : {}),
      },
      {
        type: "timeline_item",
        item: {
          kind: "retry",
          attempt: typeof status?.attempt === "number" ? status.attempt : 1,
          ...(typeof status?.message === "string" ? { error: status.message } : {}),
        },
        ...(state.currentTurnId ? { turnId: state.currentTurnId } : {}),
      },
    ];
  }
  return [];
}

function translateError(
  state: OpenCodeActivityState,
  properties: Record<string, unknown> | undefined,
): ProviderActivity[] {
  if (properties?.sessionID !== state.providerSessionId) {
    return [];
  }
  const error = readRecord(properties.error);
  const message =
    typeof error?.message === "string"
      ? error.message
      : typeof properties.error === "string"
        ? properties.error
        : "OpenCode session error";
  const turnId = state.currentTurnId ?? randomUUID();
  delete state.currentTurnId;
  return [{ type: "turn_failed", turnId, error: message }];
}

function translateMessageUpdated(
  state: OpenCodeActivityState,
  properties: Record<string, unknown> | undefined,
): ProviderActivity[] {
  const info = readRecord(properties?.info) as OpenCodeMessageInfo | undefined;
  if (!info || info.sessionID !== state.providerSessionId) {
    return [];
  }
  const activities = rememberMessageInfo(state, info);
  activities.push(...drainPendingPartsForMessage(state, info.id));
  activities.push(...usageActivitiesForMessageInfo(state, info));
  if (isOpenCodeMessageAborted(info)) {
    activities.push(...cancelOpenCodeTurn(state, info));
    return activities;
  }
  if (isTerminalAssistantMessage(info)) {
    activities.push(...completeOpenCodeTurn(state, state.turnByMessageId.get(info.id) ?? state.currentTurnId));
  }
  return activities;
}

function rememberMessageInfo(
  state: OpenCodeActivityState,
  info: OpenCodeMessageInfo,
): ProviderActivity[] {
  if (info.sessionID !== state.providerSessionId) {
    return [];
  }
  if (state.ignoredMessageIds.has(info.id)) {
    return [];
  }
  if (info.role === "assistant") {
    const runtimeModel = openCodeRuntimeModelFromMessage(info);
    if (runtimeModel) {
      state.runtimeModelByMessageId.set(info.id, runtimeModel);
    }
  }
  const knownTurnId = state.turnByMessageId.get(info.id);
  if (knownTurnId) {
    state.roleByMessageId.set(info.id, info.role);
    return runtimeModelUpdatesForKnownAssistantMessage(state, info.id, knownTurnId);
  }
  state.roleByMessageId.set(info.id, info.role);
  if (info.role === "user") {
    if (!state.currentTurnId && !state.userMessagesStartTurns) {
      return [];
    }
    const reuseLiveTurn = state.origin === "live" && state.currentTurnId !== undefined;
    const turnId = reuseLiveTurn ? state.currentTurnId! : `opencode:${info.id}`;
    const started = reuseLiveTurn ? [] : [{ type: "turn_started" as const, turnId }];
    if (!reuseLiveTurn) {
      state.userStartedTurnByMessageId.set(info.id, turnId);
    }
    state.turnRootMessageIdByMessageId.set(info.id, info.id);
    state.currentTurnId = turnId;
    state.turnByMessageId.set(info.id, turnId);
    return started;
  }
  const parentTurnId = info.parentID ? state.turnByMessageId.get(info.parentID) : undefined;
  const parentRootMessageId = info.parentID ? state.turnRootMessageIdByMessageId.get(info.parentID) : undefined;
  const turnId = parentTurnId ?? state.currentTurnId ?? `opencode:${info.id}`;
  state.turnRootMessageIdByMessageId.set(info.id, parentRootMessageId ?? info.id);
  if (state.currentTurnId === undefined || state.currentTurnId === parentTurnId) {
    state.currentTurnId = turnId;
  }
  state.turnByMessageId.set(info.id, turnId);
  return [];
}

function runtimeModelPropsForMessage(state: OpenCodeActivityState, messageId: string) {
  const runtimeModel = state.runtimeModelByMessageId.get(messageId);
  return runtimeModel ? { runtimeModel } : {};
}

function runtimeModelUpdatesForKnownAssistantMessage(
  state: OpenCodeActivityState,
  messageId: string,
  turnId: string,
): ProviderActivity[] {
  const runtimeModel = state.runtimeModelByMessageId.get(messageId);
  if (!runtimeModel || state.roleByMessageId.get(messageId) !== "assistant") {
    return [];
  }
  const activities: ProviderActivity[] = [];
  for (const [partId, mappedMessageId] of state.partMessageIdByPartId) {
    if (mappedMessageId !== messageId) {
      continue;
    }
    const partType = state.partTypeByPartId.get(partId);
    const text = state.partTextByPartId.get(partId);
    if (partType === "text" && text) {
      activities.push({
        type: "timeline_item_updated",
        item: {
          kind: "assistant_message",
          text,
          messageId,
          runtimeModel,
        },
        ...timelineIdentityProps(openCodeDeltaTimelineIdentity(state, messageId, partId, "assistant_message")),
        turnId,
      });
      continue;
    }
    if (partType === "reasoning" && text) {
      activities.push({
        type: "timeline_item_updated",
        item: {
          kind: "reasoning",
          text,
          runtimeModel,
        },
        ...timelineIdentityProps(openCodeDeltaTimelineIdentity(state, messageId, partId, "reasoning")),
        turnId,
      });
      continue;
    }
    const stepIndex = state.stepIndexByPartId.get(partId);
    if (partType === "step-start" && stepIndex !== undefined) {
      activities.push({
        type: "turn_step_started",
        turnId,
        index: stepIndex,
        runtimeModel,
      });
      continue;
    }
    if (partType === "step-finish" && stepIndex !== undefined) {
      activities.push({
        type: "turn_step_completed",
        turnId,
        index: stepIndex,
        runtimeModel,
      });
    }
  }
  return activities;
}

function takePendingSubmittedUserMessage(
  state: OpenCodeActivityState,
  text: string,
): PendingSubmittedOpenCodeUserMessage | undefined {
  const index = state.pendingSubmittedUserMessages.findIndex((message) => message.text === text);
  if (index < 0) {
    return undefined;
  }
  const [message] = state.pendingSubmittedUserMessages.splice(index, 1);
  return message;
}

function timelineIdentityProps(identity: TimelineIdentity | undefined): { identity?: TimelineIdentity } {
  return identity !== undefined ? { identity } : {};
}

function turnIdentityProps(identity: TimelineTurnIdentity | undefined): { identity?: TimelineTurnIdentity } {
  return identity !== undefined ? { identity } : {};
}

function rootMessageIdForMessage(state: OpenCodeActivityState, messageId: string): string {
  return state.turnRootMessageIdByMessageId.get(messageId) ?? messageId;
}

function openCodeTurnIdentityForTurn(
  state: OpenCodeActivityState,
  turnId: string,
): TimelineTurnIdentity | undefined {
  for (const [messageId, mappedTurnId] of state.turnByMessageId) {
    if (mappedTurnId !== turnId) {
      continue;
    }
    return createOpenCodeTimelineTurnIdentity({
      providerSessionId: state.providerSessionId,
      messageId: rootMessageIdForMessage(state, messageId),
      origin: state.origin,
    });
  }
  return undefined;
}

function openCodeTimelineIdentity(
  state: OpenCodeActivityState,
  part: OpenCodePart,
  itemKind: "user_message" | "assistant_message" | "reasoning",
): TimelineIdentity {
  return createOpenCodeTimelineIdentity({
    providerSessionId: state.providerSessionId,
    messageId: part.messageID,
    turnMessageId: rootMessageIdForMessage(state, part.messageID),
    partId: part.id,
    itemKind,
    origin: state.origin,
  });
}

function openCodeDeltaTimelineIdentity(
  state: OpenCodeActivityState,
  messageId: string,
  partId: string,
  itemKind: "assistant_message" | "reasoning",
): TimelineIdentity {
  return createOpenCodeTimelineIdentity({
    providerSessionId: state.providerSessionId,
    messageId,
    turnMessageId: rootMessageIdForMessage(state, messageId),
    partId,
    itemKind,
    origin: state.origin,
  });
}

function usageActivitiesForMessageInfo(
  state: OpenCodeActivityState,
  info: OpenCodeMessageInfo,
): ProviderActivity[] {
  const usage = openCodeUsageFromMessage(info);
  if (!usage) {
    return [];
  }
  const turnId = state.turnByMessageId.get(info.id) ?? state.currentTurnId;
  return [
    {
      type: "usage",
      usage,
      ...(turnId ? { turnId } : {}),
    },
  ];
}

export function isTerminalAssistantMessage(info: OpenCodeMessageInfo): boolean {
  return (
    info.role === "assistant" &&
    !isOpenCodeMessageAborted(info) &&
    info.finish !== "tool-calls" &&
    (info.time?.completed !== undefined || info.finish !== undefined)
  );
}

function isOpenCodeMessageAborted(info: OpenCodeMessageInfo): boolean {
  const error = readRecord(info.error);
  return (
    info.role === "assistant" &&
    (error?.name === "MessageAbortedError" ||
      readStringProperty(readRecord(error?.data) ?? {}, "message") === "Aborted")
  );
}

function cancelOpenCodeTurn(
  state: OpenCodeActivityState,
  info: OpenCodeMessageInfo,
): ProviderActivity[] {
  const turnId =
    state.turnByMessageId.get(info.id) ??
    state.currentTurnId ??
    `opencode:${info.id}`;
  if (state.currentTurnId === turnId) {
    delete state.currentTurnId;
  }
  return [
    {
      type: "turn_canceled",
      turnId,
      reason: "interrupted",
      ...turnIdentityProps(openCodeTurnIdentityForTurn(state, turnId)),
    },
  ];
}

function translatePartUpdated(
  state: OpenCodeActivityState,
  properties: Record<string, unknown> | undefined,
): ProviderActivity[] {
  const part = readRecord(properties?.part) as OpenCodePart | undefined;
  if (!part || part.sessionID !== state.providerSessionId) {
    return [];
  }
  if (typeof part.id !== "string" || typeof part.messageID !== "string") {
    return [];
  }
  if (state.ignoredMessageIds.has(part.messageID)) {
    return [];
  }
  if (isOpenCodeInternalUserPart(part)) {
    return forgetOpenCodeInternalUserMessage(state, part.messageID);
  }
  rememberPartInfo(state, part);
  if (!state.roleByMessageId.has(part.messageID) && part.type !== "step-finish") {
    queuePendingPart(state, part);
    return [];
  }
  const activities = translateOpenCodePart(state, part);
  activities.push(...drainPendingTextDeltasForPart(state, part));
  return activities;
}

function translateOpenCodePart(
  state: OpenCodeActivityState,
  part: OpenCodePart,
): ProviderActivity[] {
  if (typeof part.id !== "string" || typeof part.messageID !== "string") {
    return [];
  }
  rememberPartInfo(state, part);
  const role = state.roleByMessageId.get(part.messageID);
  const turnId = state.turnByMessageId.get(part.messageID) ?? state.currentTurnId;
  switch (part.type) {
    case "text": {
      const text = readStringProperty(part, "text");
      if (!text || readBooleanProperty(part, "synthetic") || readBooleanProperty(part, "ignored")) {
        return [];
      }
      state.partTextByPartId.set(part.id, text);
      if (!role) {
        return [];
      }
      if (role === "user") {
        if (isOpenCodeInternalInitiatorText(text)) {
          return forgetOpenCodeInternalUserMessage(state, part.messageID);
        }
        if (!state.emitUserMessages) {
          return [];
        }
        const submitted = takePendingSubmittedUserMessage(state, text);
        const userTurnId = submitted?.turnId ?? turnId;
        return [
          {
            type: "timeline_item",
            item: {
              kind: "user_message",
              text,
              messageId: part.messageID,
              ...(submitted?.clientMessageId !== undefined
                ? { clientMessageId: submitted.clientMessageId }
                : {}),
              ...(submitted?.clientTurnId !== undefined ? { clientTurnId: submitted.clientTurnId } : {}),
            },
            ...timelineIdentityProps(openCodeTimelineIdentity(state, part, "user_message")),
            ...(userTurnId ? { turnId: userTurnId } : {}),
          },
        ];
      }
      return [
        {
          type: "timeline_item",
          item: {
            kind: "assistant_message",
            text,
            messageId: part.messageID,
            ...runtimeModelPropsForMessage(state, part.messageID),
          },
          ...timelineIdentityProps(openCodeTimelineIdentity(state, part, "assistant_message")),
          ...(turnId ? { turnId } : {}),
        },
      ];
    }
    case "reasoning": {
      const text = readStringProperty(part, "text");
      if (text) {
        state.partTextByPartId.set(part.id, text);
      }
      if (!role) {
        return [];
      }
      return text
        ? [
            {
              type: "timeline_item",
              item: { kind: "reasoning", text, ...runtimeModelPropsForMessage(state, part.messageID) },
              ...timelineIdentityProps(openCodeTimelineIdentity(state, part, "reasoning")),
              ...(turnId ? { turnId } : {}),
            },
          ]
        : [];
    }
    case "tool":
      return translateToolPart(state, part, turnId);
    case "file":
      return [
        {
          type: "message_part_added",
          part: {
            messageId: part.messageID,
            partId: part.id,
            kind: "file",
            metadata: jsonObject({
              ...(readStringProperty(part, "filename") ? { filename: readStringProperty(part, "filename") } : {}),
              ...(readStringProperty(part, "mime") ? { mime: readStringProperty(part, "mime") } : {}),
              ...(readStringProperty(part, "url") ? { url: readStringProperty(part, "url") } : {}),
            }),
          },
          ...(turnId ? { turnId } : {}),
        },
      ];
    case "step-start": {
      const title = readStringProperty(part, "title");
      return startOpenCodeStep(state, part, turnId ?? state.currentTurnId ?? randomUUID(), title);
    }
    case "step-finish": {
      const stepTurnId = turnId ?? state.currentTurnId ?? randomUUID();
      const reason = readStringProperty(part, "reason");
      const activities: ProviderActivity[] = finishOpenCodeStep(state, part, stepTurnId, reason);
      if (role !== "user" && reason !== "tool-calls") {
        activities.push(...completeOpenCodeTurn(state, stepTurnId));
      }
      return activities;
    }
    default:
      return [];
  }
}

function translatePartDelta(
  state: OpenCodeActivityState,
  properties: Record<string, unknown> | undefined,
): ProviderActivity[] {
  if (properties?.sessionID !== state.providerSessionId) {
    return [];
  }
  const messageID = typeof properties.messageID === "string" ? properties.messageID : undefined;
  const partID = typeof properties.partID === "string" ? properties.partID : undefined;
  const field = typeof properties.field === "string" ? properties.field : undefined;
  const delta = typeof properties.delta === "string" ? properties.delta : undefined;
  if (!messageID || !partID || field !== "text" || !delta) {
    return [];
  }
  if (state.ignoredMessageIds.has(messageID)) {
    return [];
  }
  const role = state.roleByMessageId.get(messageID);
  if (!role) {
    queuePendingTextDelta(state, { messageID, partID, delta });
    return [];
  }
  const turnId = state.turnByMessageId.get(messageID) ?? state.currentTurnId;
  if (role === "user") {
    return [];
  }
  const partType = state.partTypeByPartId.get(partID);
  if (partType === undefined) {
    queuePendingTextDelta(state, { messageID, partID, delta });
    return [];
  }
  if (partType === "reasoning") {
    const text = appendOpenCodePartTextDelta(state, partID, delta);
    return [
      {
        type: "timeline_item",
        item: { kind: "reasoning", text, ...runtimeModelPropsForMessage(state, messageID) },
        ...timelineIdentityProps(openCodeDeltaTimelineIdentity(state, messageID, partID, "reasoning")),
        ...(turnId ? { turnId } : {}),
      },
    ];
  }
  if (partType !== "text") {
    return [];
  }
  const text = appendOpenCodePartTextDelta(state, partID, delta);
  return [
    {
      type: "timeline_item",
      item: {
        kind: "assistant_message",
        text,
        messageId: messageID,
        ...runtimeModelPropsForMessage(state, messageID),
      },
      ...timelineIdentityProps(openCodeDeltaTimelineIdentity(state, messageID, partID, "assistant_message")),
      ...(turnId ? { turnId } : {}),
    },
  ];
}

function queuePendingPart(state: OpenCodeActivityState, part: OpenCodePart): void {
  const existing = state.pendingPartsByMessageId.get(part.messageID) ?? [];
  const withoutDuplicate = existing.filter((candidate) => candidate.id !== part.id);
  withoutDuplicate.push(part);
  state.pendingPartsByMessageId.set(part.messageID, withoutDuplicate);
}

function drainPendingPartsForMessage(
  state: OpenCodeActivityState,
  messageId: string,
): ProviderActivity[] {
  const parts = state.pendingPartsByMessageId.get(messageId);
  if (!parts || parts.length === 0) {
    return [];
  }
  state.pendingPartsByMessageId.delete(messageId);
  const activities: ProviderActivity[] = [];
  for (const part of parts) {
    rememberPartInfo(state, part);
    activities.push(...translateOpenCodePart(state, part));
    activities.push(...drainPendingTextDeltasForPart(state, part));
  }
  return activities;
}

function queuePendingTextDelta(
  state: OpenCodeActivityState,
  delta: PendingOpenCodeTextDelta,
): void {
  const existing = state.pendingTextDeltasByPartId.get(delta.partID) ?? [];
  existing.push(delta);
  state.pendingTextDeltasByPartId.set(delta.partID, existing);
}

function drainPendingTextDeltasForPart(
  state: OpenCodeActivityState,
  part: OpenCodePart,
): ProviderActivity[] {
  const deltas = state.pendingTextDeltasByPartId.get(part.id);
  if (!deltas || deltas.length === 0) {
    return [];
  }
  const activities: ProviderActivity[] = [];
  for (const delta of deltas) {
    activities.push(...translateKnownOpenCodeTextDelta(state, delta, { skipDuplicateSuffix: true }));
  }
  state.pendingTextDeltasByPartId.delete(part.id);
  return activities;
}

function appendOpenCodePartTextDelta(
  state: OpenCodeActivityState,
  partId: string,
  delta: string,
  options: { skipDuplicateSuffix?: boolean } = {},
): string {
  const current = state.partTextByPartId.get(partId) ?? "";
  const text = options.skipDuplicateSuffix === true && current.endsWith(delta)
    ? current
    : `${current}${delta}`;
  state.partTextByPartId.set(partId, text);
  return text;
}

function translateKnownOpenCodeTextDelta(
  state: OpenCodeActivityState,
  delta: PendingOpenCodeTextDelta,
  options: { skipDuplicateSuffix?: boolean } = {},
): ProviderActivity[] {
  const role = state.roleByMessageId.get(delta.messageID);
  if (role !== "assistant") {
    return [];
  }
  const partType = state.partTypeByPartId.get(delta.partID);
  if (partType !== "text" && partType !== "reasoning") {
    return [];
  }
  const turnId = state.turnByMessageId.get(delta.messageID) ?? state.currentTurnId;
  const text = appendOpenCodePartTextDelta(state, delta.partID, delta.delta, options);
  if (partType === "reasoning") {
    return [
      {
        type: "timeline_item",
        item: { kind: "reasoning", text, ...runtimeModelPropsForMessage(state, delta.messageID) },
        ...timelineIdentityProps(openCodeDeltaTimelineIdentity(state, delta.messageID, delta.partID, "reasoning")),
        ...(turnId ? { turnId } : {}),
      },
    ];
  }
  return [
    {
      type: "timeline_item",
      item: {
        kind: "assistant_message",
        text,
        messageId: delta.messageID,
        ...runtimeModelPropsForMessage(state, delta.messageID),
      },
      ...timelineIdentityProps(openCodeDeltaTimelineIdentity(state, delta.messageID, delta.partID, "assistant_message")),
      ...(turnId ? { turnId } : {}),
    },
  ];
}

function translatePartRemoved(
  state: OpenCodeActivityState,
  properties: Record<string, unknown> | undefined,
): ProviderActivity[] {
  if (properties?.sessionID !== state.providerSessionId) {
    return [];
  }
  const messageID = typeof properties.messageID === "string" ? properties.messageID : undefined;
  const partID = typeof properties.partID === "string" ? properties.partID : undefined;
  if (!messageID || !partID) {
    return [];
  }
  if (state.ignoredMessageIds.has(messageID)) {
    return [];
  }
  return [
    {
      type: "message_part_removed",
      messageId: messageID,
      partId: partID,
      ...(state.turnByMessageId.get(messageID) ? { turnId: state.turnByMessageId.get(messageID)! } : {}),
    },
  ];
}

function translatePermissionAsked(
  state: OpenCodeActivityState,
  properties: Record<string, unknown> | undefined,
): ProviderActivity[] {
  if (properties?.sessionID !== state.providerSessionId) {
    return [];
  }
  const id = typeof properties.id === "string" ? properties.id : undefined;
  if (!id) {
    return [];
  }
  const permission = typeof properties.permission === "string" ? properties.permission : "permission";
  const patterns = Array.isArray(properties.patterns)
    ? properties.patterns.filter((item): item is string => typeof item === "string")
    : [];
  const input = jsonObject(readRecord(properties.metadata) ?? {});
  state.pendingPermissions.set(id, state.currentTurnId);
  const actions: PermissionAction[] = [
    { id: "once", label: "Allow once", behavior: "allow", variant: "primary" },
    { id: "always", label: "Always allow", behavior: "allow" },
    { id: "reject", label: "Reject", behavior: "deny", variant: "danger" },
  ];
  const request = {
    id,
    kind: "tool" as const,
    title: permission,
    input,
    actions,
    ...(patterns.length > 0 ? { description: patterns.join(", ") } : {}),
  };
  return [
    {
      type: "permission_requested",
      request,
      ...(state.currentTurnId ? { turnId: state.currentTurnId } : {}),
    },
  ];
}

function translatePermissionReplied(
  state: OpenCodeActivityState,
  properties: Record<string, unknown> | undefined,
): ProviderActivity[] {
  if (properties?.sessionID !== state.providerSessionId) {
    return [];
  }
  const requestId = typeof properties.requestID === "string" ? properties.requestID : undefined;
  if (!requestId) {
    return [];
  }
  const reply = typeof properties.reply === "string" ? properties.reply : "reject";
  const turnId = state.pendingPermissions.get(requestId) ?? state.currentTurnId;
  state.pendingPermissions.delete(requestId);
  return [
    {
      type: "permission_resolved",
      resolution: {
        requestId,
        behavior: reply === "reject" ? "deny" : "allow",
        selectedActionId: reply,
        decision: reply,
      },
      ...(turnId ? { turnId } : {}),
    },
  ];
}

function translateToolPart(
  activityState: OpenCodeActivityState,
  part: OpenCodePart,
  turnId: string | undefined,
): ProviderActivity[] {
  const callId = readStringProperty(part, "callID");
  const tool = readStringProperty(part, "tool");
  const state = readRecord(readProperty(part, "state"));
  const status = typeof state?.status === "string" ? state.status : undefined;
  if (!callId || !tool || !state || !status) {
    return [];
  }
  const input = readRecord(state.input);
  const toolCall: ToolCall = {
    id: callId,
    family: classifyOpenCodeToolFamily(tool),
    providerToolName: tool,
    title: toolTitle(tool, state),
    ...(input ? { input } : {}),
  };
  if (status === "pending") {
    return [];
  }
  if (status === "running") {
    if (activityState.completedToolCallIds.has(callId)) {
      return [];
    }
    const detail = toolDetailFromState(state);
    if (activityState.startedToolCallIds.has(callId)) {
      return detail
        ? [{ type: "tool_call_delta", toolCallId: callId, detail, ...(turnId ? { turnId } : {}) }]
        : [];
    }
    activityState.startedToolCallIds.add(callId);
    return [
      {
        type: "tool_call_started",
        toolCall,
        ...(turnId ? { turnId } : {}),
      },
    ];
  }
  if (status === "completed") {
    if (activityState.completedToolCallIds.has(callId)) {
      return [];
    }
    activityState.startedToolCallIds.delete(callId);
    activityState.completedToolCallIds.add(callId);
    const output = typeof state.output === "string" ? state.output : undefined;
    const metadata = readRecord(state.metadata);
    return [
      {
        type: "tool_call_completed",
        toolCall: {
          ...toolCall,
          result: jsonObject({
            ...(output ? { output } : {}),
            ...(metadata ? { metadata } : {}),
          }),
          detail: {
            artifacts: output
              ? [{ kind: "text", label: toolCall.title ?? tool, text: output }]
              : [],
          },
        },
        ...(turnId ? { turnId } : {}),
      },
    ];
  }
  return [
    {
      type: "tool_call_failed",
      toolCallId: callId,
      error: typeof state.error === "string" ? state.error : "OpenCode tool failed",
      ...(turnId ? { turnId } : {}),
    },
  ];
}

function startOpenCodeStep(
  state: OpenCodeActivityState,
  part: OpenCodePart,
  turnId: string,
  title: string | undefined,
): ProviderActivity[] {
  if (!title) {
    return [];
  }
  if (state.stepStartedPartIds.has(part.id)) {
    return [];
  }
  state.stepStartedPartIds.add(part.id);
  const index = stepIndexForStartPart(state, part.id, turnId);
  state.openStepIndexByTurnId.set(turnId, index);
  return [
    {
      type: "turn_step_started",
      turnId,
      index,
      ...(title ? { title } : {}),
      ...runtimeModelPropsForMessage(state, part.messageID),
    },
  ];
}

function finishOpenCodeStep(
  state: OpenCodeActivityState,
  part: OpenCodePart,
  turnId: string,
  reason: string | undefined,
): ProviderActivity[] {
  if (state.stepFinishedPartIds.has(part.id)) {
    return [];
  }
  const openIndex = state.openStepIndexByTurnId.get(turnId);
  const existingIndex = state.stepIndexByPartId.get(part.id);
  const index = openIndex ?? existingIndex;
  if (index === undefined) {
    return [];
  }
  state.stepFinishedPartIds.add(part.id);
  state.openStepIndexByTurnId.delete(turnId);
  return [
    {
      type: "turn_step_completed",
      turnId,
      index,
      ...(reason ? { reason } : {}),
      ...runtimeModelPropsForMessage(state, part.messageID),
    },
  ];
}

function stepIndexForStartPart(
  state: OpenCodeActivityState,
  partId: string,
  turnId: string,
): number {
  const existing = state.stepIndexByPartId.get(partId);
  if (existing !== undefined) {
    return existing;
  }
  const next = (state.nextStepIndexByTurnId.get(turnId) ?? 0) + 1;
  state.nextStepIndexByTurnId.set(turnId, next);
  state.stepIndexByPartId.set(partId, next);
  return next;
}

function stepIndexForFinishPart(
  state: OpenCodeActivityState,
  partId: string,
  turnId: string,
): number {
  const existing = state.stepIndexByPartId.get(partId);
  if (existing !== undefined) {
    return existing;
  }
  const next = (state.nextStepIndexByTurnId.get(turnId) ?? 0) + 1;
  state.nextStepIndexByTurnId.set(turnId, next);
  state.stepIndexByPartId.set(partId, next);
  return next;
}

function toolTitle(tool: string, state: Record<string, unknown>): string {
  if (typeof state.title === "string" && state.title) {
    return state.title;
  }
  return tool;
}

function rememberPartInfo(state: OpenCodeActivityState, part: OpenCodePart): void {
  state.partMessageIdByPartId.set(part.id, part.messageID);
  state.partTypeByPartId.set(part.id, part.type);
}

function toolDetailFromState(state: Record<string, unknown>) {
  const output = readToolOutput(state);
  return output
    ? {
        artifacts: [{ kind: "text" as const, label: "Output", text: output }],
      }
    : undefined;
}

function readToolOutput(state: Record<string, unknown>): string | undefined {
  if (typeof state.output === "string" && state.output) {
    return state.output;
  }
  const metadata = readRecord(state.metadata);
  return typeof metadata?.output === "string" && metadata.output ? metadata.output : undefined;
}

function classifyOpenCodeToolFamily(name: string): ToolFamily {
  const normalized = name.toLowerCase();
  if (normalized.includes("bash") || normalized.includes("shell")) return "shell";
  if (normalized.includes("edit")) return "file_edit";
  if (normalized.includes("write")) return "file_write";
  if (normalized.includes("read")) return "file_read";
  if (normalized.includes("grep") || normalized.includes("glob") || normalized.includes("search")) return "search";
  if (normalized.includes("fetch")) return "web_fetch";
  if (normalized.includes("todo")) return "todo";
  if (normalized.includes("task")) return "subagent";
  return "other";
}

export function openCodeUsageFromMessage(info: OpenCodeMessageInfo): ContextUsage | undefined {
  const tokens = info.tokens;
  if (!tokens && typeof info.cost !== "number") {
    return undefined;
  }
  const tokenTotal =
    tokens !== undefined
      ? (tokens.input ?? 0) +
        (tokens.output ?? 0) +
        (tokens.reasoning ?? 0) +
        (tokens.cache?.read ?? 0) +
        (tokens.cache?.write ?? 0)
      : undefined;
  return {
    source: "opencode.message.usage",
    ...(tokenTotal !== undefined && tokenTotal > 0 ? { usedTokens: tokenTotal } : {}),
    ...(tokens?.input !== undefined ? { inputTokens: tokens.input } : {}),
    ...(tokens?.output !== undefined ? { outputTokens: tokens.output } : {}),
    ...(tokens?.reasoning !== undefined ? { reasoningOutputTokens: tokens.reasoning } : {}),
    ...(tokens?.cache?.read !== undefined ? { cachedInputTokens: tokens.cache.read } : {}),
    ...(typeof info.cost === "number" ? { totalCostUsd: info.cost } : {}),
  };
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

function readProperty(value: object, key: string): unknown {
  return (value as Record<string, unknown>)[key];
}

function readStringProperty(value: object, key: string): string | undefined {
  const property = readProperty(value, key);
  return typeof property === "string" ? property : undefined;
}

function readBooleanProperty(value: object, key: string): boolean {
  return readProperty(value, key) === true;
}

function jsonObject(value: Record<string, unknown>): JsonObject {
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, JsonObject[string]] => isJsonValue(entry[1])),
  );
}

function isJsonValue(value: unknown): value is JsonObject[string] {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return true;
  }
  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }
  if (value && typeof value === "object") {
    return Object.values(value).every(isJsonValue);
  }
  return false;
}

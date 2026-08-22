import type {
  SessionInputAttachment,
  TimelineIdentity,
  TimelineUserInputPlacement,
} from "@rah/runtime-protocol";
import type { ProviderActivity } from "./provider-activity";

export type CodexSubmittedUserMessage = {
  text: string;
  attachments?: SessionInputAttachment[];
  clientMessageId?: string;
  clientTurnId?: string;
  inputPlacement?: TimelineUserInputPlacement;
  causalAfterItemId?: string;
};

export type CodexLiveSubmittedUserMessageParams = {
  turnId: string;
  providerSessionId?: string | undefined;
  message: CodexSubmittedUserMessage;
};

export interface CodexSubmittedUserMessageState {
  pendingSubmittedUserMessages: CodexSubmittedUserMessage[];
  submittedUserMessagesByTurnId: Map<string, CodexSubmittedUserMessage[]>;
  emittedClientUserMessageIds: Set<string>;
}

export function createCodexSubmittedUserMessageState(): CodexSubmittedUserMessageState {
  return {
    pendingSubmittedUserMessages: [],
    submittedUserMessagesByTurnId: new Map(),
    emittedClientUserMessageIds: new Set(),
  };
}

export function submittedUserMessageKey(
  message: CodexSubmittedUserMessage,
): string | undefined {
  return message.clientMessageId ?? message.clientTurnId;
}

export function recordCodexSubmittedUserMessage(
  state: CodexSubmittedUserMessageState,
  message: CodexSubmittedUserMessage,
): void {
  const key = submittedUserMessageKey(message);
  if (
    key &&
    state.pendingSubmittedUserMessages.some(
      (candidate) => submittedUserMessageKey(candidate) === key,
    )
  ) {
    return;
  }
  state.pendingSubmittedUserMessages.push({
    ...message,
    inputPlacement: message.inputPlacement ?? "turn_start",
  });
  if (state.pendingSubmittedUserMessages.length > 128) {
    state.pendingSubmittedUserMessages.splice(
      0,
      state.pendingSubmittedUserMessages.length - 128,
    );
  }
}

export function bindCodexSubmittedUserMessageToTurn(
  state: CodexSubmittedUserMessageState,
  turnId: string,
): CodexSubmittedUserMessage | undefined {
  const existing = state.submittedUserMessagesByTurnId.get(turnId);
  if (existing !== undefined) {
    return existing[0];
  }
  const pending = state.pendingSubmittedUserMessages.shift();
  if (!pending) {
    return undefined;
  }
  state.submittedUserMessagesByTurnId.set(turnId, [pending]);
  return pending;
}

export function recordCodexSubmittedUserMessageForTurn(
  state: CodexSubmittedUserMessageState,
  turnId: string,
  message: CodexSubmittedUserMessage,
): void {
  const messages = state.submittedUserMessagesByTurnId.get(turnId) ?? [];
  const key = submittedUserMessageKey(message);
  if (
    key &&
    messages.some((candidate) => submittedUserMessageKey(candidate) === key)
  ) {
    return;
  }
  messages.push({
    ...message,
    inputPlacement: message.inputPlacement ?? "turn_steer",
  });
  state.submittedUserMessagesByTurnId.set(turnId, messages);
}

export function discardPendingCodexSubmittedUserMessage(
  state: CodexSubmittedUserMessageState,
  clientMessageId: string | undefined,
): void {
  const index = state.pendingSubmittedUserMessages.findIndex(
    (message) =>
      clientMessageId === undefined || message.clientMessageId === clientMessageId,
  );
  if (index >= 0) {
    state.pendingSubmittedUserMessages.splice(index, 1);
  }
}

export function discardCodexSubmittedUserMessageFromTurn(
  state: CodexSubmittedUserMessageState,
  turnId: string,
  clientMessageId: string | undefined,
): void {
  const messages = state.submittedUserMessagesByTurnId.get(turnId);
  if (!messages) {
    return;
  }
  const next = messages.filter(
    (message) =>
      clientMessageId !== undefined && message.clientMessageId !== clientMessageId,
  );
  if (next.length > 0) {
    state.submittedUserMessagesByTurnId.set(turnId, next);
  } else {
    state.submittedUserMessagesByTurnId.delete(turnId);
  }
}

export function wasCodexSubmittedUserMessageEmitted(
  state: CodexSubmittedUserMessageState,
  message: CodexSubmittedUserMessage,
): boolean {
  const key = submittedUserMessageKey(message);
  return key !== undefined && state.emittedClientUserMessageIds.has(key);
}

export function markCodexSubmittedUserMessageEmitted(
  state: CodexSubmittedUserMessageState,
  message: CodexSubmittedUserMessage,
): void {
  const key = submittedUserMessageKey(message);
  if (!key) {
    return;
  }
  state.emittedClientUserMessageIds.add(key);
  if (state.emittedClientUserMessageIds.size > 512) {
    const oldest = state.emittedClientUserMessageIds.values().next().value;
    if (oldest !== undefined) {
      state.emittedClientUserMessageIds.delete(oldest);
    }
  }
}

export function createCodexSubmittedUserMessageActivity(
  state: CodexSubmittedUserMessageState,
  params: {
    turnId: string;
    message: CodexSubmittedUserMessage;
    identity?: TimelineIdentity | undefined;
  },
): ProviderActivity | null {
  if (wasCodexSubmittedUserMessageEmitted(state, params.message)) {
    return null;
  }
  const messageId =
    params.message.clientMessageId ??
    params.message.clientTurnId ??
    `client-input:${params.turnId}:${Date.now().toString(36)}`;
  markCodexSubmittedUserMessageEmitted(state, params.message);
  return {
    type: "timeline_item",
    turnId: params.turnId,
    item: {
      kind: "user_message",
      text: params.message.text,
      messageId,
      ...(params.message.clientMessageId !== undefined
        ? { clientMessageId: params.message.clientMessageId }
        : {}),
      ...(params.message.clientTurnId !== undefined
        ? { clientTurnId: params.message.clientTurnId }
        : {}),
      ...(params.message.inputPlacement !== undefined
        ? { inputPlacement: params.message.inputPlacement }
        : {}),
      ...(params.message.causalAfterItemId !== undefined
        ? { causalAfterItemId: params.message.causalAfterItemId }
        : {}),
      ...(params.message.attachments?.length
        ? { attachments: params.message.attachments }
        : {}),
      ...(params.message.attachments?.some(
        (attachment) => attachment.kind === "image",
      )
        ? {
            imageCount: params.message.attachments.filter(
              (attachment) => attachment.kind === "image",
            ).length,
          }
        : {}),
    },
    ...(params.identity ? { identity: params.identity } : {}),
  };
}

export function takeCodexSubmittedUserMessageForEcho(
  state: CodexSubmittedUserMessageState,
  turnId: string,
  params: {
    providerMessageId: string;
    clientMessageId?: string | undefined;
    text: string;
  },
): CodexSubmittedUserMessage | undefined {
  const messages = state.submittedUserMessagesByTurnId.get(turnId);
  if (!messages?.length) {
    return undefined;
  }
  const normalizedText = params.text.trim();
  let index = messages.findIndex((message) => {
    const key = submittedUserMessageKey(message);
    return (
      key === params.providerMessageId ||
      (params.clientMessageId !== undefined && key === params.clientMessageId)
    );
  });
  if (index < 0 && normalizedText) {
    index = messages.findIndex(
      (message) => message.text.trim() === normalizedText,
    );
  }
  if (index < 0) {
    return undefined;
  }
  const [message] = messages.splice(index, 1);
  // Preserve the empty binding until turn completion. If a native user echo
  // races ahead of turn/started, that later lifecycle event must not steal the
  // next queued turn's input.
  state.submittedUserMessagesByTurnId.set(turnId, messages);
  return message;
}

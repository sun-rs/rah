import type { SessionInputAttachment, TimelineIdentity, TimelineItem } from "@rah/runtime-protocol";

type CodexRolloutUserMessage = Extract<TimelineItem, { kind: "user_message" }>;

export interface CodexRolloutUserInputState {
  currentTurnUserMessageCount: number;
  lastPersistedUserMessage?: {
    turnId: string;
    text: string;
    identity: TimelineIdentity;
    item: CodexRolloutUserMessage;
  } | undefined;
}

export function createCodexRolloutUserInputState(): CodexRolloutUserInputState {
  return { currentTurnUserMessageCount: 0 };
}

export function resetCodexRolloutUserInputState(state: CodexRolloutUserInputState): void {
  state.currentTurnUserMessageCount = 0;
  state.lastPersistedUserMessage = undefined;
}

export function takeCodexRolloutUserPlacement(
  state: CodexRolloutUserInputState,
): Pick<CodexRolloutUserMessage, "inputPlacement" | "causalAfterItemId"> {
  const inputPlacement = state.currentTurnUserMessageCount === 0 ? "turn_start" : "turn_steer";
  state.currentTurnUserMessageCount += 1;
  return { inputPlacement };
}

export function rememberCodexRolloutUserMessage(
  state: CodexRolloutUserInputState,
  params: {
    turnId?: string | undefined;
    text: string;
    identity?: TimelineIdentity | undefined;
    placement: Pick<CodexRolloutUserMessage, "inputPlacement" | "causalAfterItemId">;
    imageCount: number;
    attachments: SessionInputAttachment[];
  },
): CodexRolloutUserMessage {
  const item: CodexRolloutUserMessage = {
    kind: "user_message",
    text: params.text,
    ...params.placement,
    ...(params.imageCount > 0 ? { imageCount: params.imageCount } : {}),
    ...(params.attachments.length > 0 ? { attachments: params.attachments } : {}),
  };
  if (params.identity && params.turnId) {
    state.lastPersistedUserMessage = {
      turnId: params.turnId,
      text: params.text,
      identity: params.identity,
      item,
    };
  }
  return item;
}

export function correlateCodexRolloutUserMessage(
  state: CodexRolloutUserInputState,
  params: {
    clientMessageId?: string | undefined;
    turnId?: string | undefined;
    text?: string | undefined;
  },
): { turnId: string; identity: TimelineIdentity; item: CodexRolloutUserMessage } | undefined {
  const previous = state.lastPersistedUserMessage;
  if (!params.clientMessageId || !params.text || !previous ||
      previous.turnId !== params.turnId || previous.text.trim() !== params.text.trim()) {
    return undefined;
  }
  const item = { ...previous.item, clientMessageId: params.clientMessageId };
  state.lastPersistedUserMessage = { ...previous, item };
  return { turnId: previous.turnId, identity: previous.identity, item };
}

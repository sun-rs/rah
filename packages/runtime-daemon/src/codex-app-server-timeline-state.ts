import type { TimelineIdentity } from "@rah/runtime-protocol";
import { createCodexTimelineIdentity } from "./codex-timeline-identity";

type CodexLiveTimelineItemKind =
  | "user_message"
  | "assistant_message"
  | "reasoning"
  | "plan"
  | "compaction";

export interface CodexAppServerTimelineState {
  timelineItemIndexByProviderItemKey: Map<string, number>;
  userTimelineItemIndexByTurnId: Map<string, number>;
  reservedUserTimelineItemIndexByTurnId: Map<string, number>;
  nextTimelineItemIndexByTurnId: Map<string, number>;
  seenUserMessageCountByTurnId: Map<string, number>;
}

export function createCodexAppServerTimelineState(): CodexAppServerTimelineState {
  return {
    timelineItemIndexByProviderItemKey: new Map(),
    userTimelineItemIndexByTurnId: new Map(),
    reservedUserTimelineItemIndexByTurnId: new Map(),
    nextTimelineItemIndexByTurnId: new Map(),
    seenUserMessageCountByTurnId: new Map(),
  };
}

function allocateTimelineItemIndex(
  state: CodexAppServerTimelineState,
  params: {
    turnId: string;
    itemKind: CodexLiveTimelineItemKind;
    providerItemKey: string;
  },
): number {
  const scopedKey = `${params.turnId}:${params.providerItemKey}`;
  const existing = state.timelineItemIndexByProviderItemKey.get(scopedKey);
  if (existing !== undefined) return existing;
  const knownUserIndex = state.userTimelineItemIndexByTurnId.get(params.turnId);
  if (params.itemKind === "user_message") {
    const reserved = state.reservedUserTimelineItemIndexByTurnId.get(params.turnId);
    if (reserved !== undefined) {
      state.reservedUserTimelineItemIndexByTurnId.delete(params.turnId);
      state.timelineItemIndexByProviderItemKey.set(scopedKey, reserved);
      return reserved;
    }
  } else if (knownUserIndex === undefined) {
    // Reserve the first provider turn slot for a user echo that can arrive
    // after assistant/reasoning output. This aligns live and rollout ids.
    const userIndex = state.nextTimelineItemIndexByTurnId.get(params.turnId) ?? 0;
    state.nextTimelineItemIndexByTurnId.set(params.turnId, userIndex + 1);
    state.userTimelineItemIndexByTurnId.set(params.turnId, userIndex);
    state.reservedUserTimelineItemIndexByTurnId.set(params.turnId, userIndex);
  }
  const next = state.nextTimelineItemIndexByTurnId.get(params.turnId) ?? 0;
  state.nextTimelineItemIndexByTurnId.set(params.turnId, next + 1);
  state.timelineItemIndexByProviderItemKey.set(scopedKey, next);
  if (params.itemKind === "user_message" && knownUserIndex === undefined) {
    state.userTimelineItemIndexByTurnId.set(params.turnId, next);
  }
  return next;
}

export function createLiveTimelineIdentity(
  state: CodexAppServerTimelineState,
  params: {
    providerSessionId?: string | undefined;
    turnId: string;
    itemKind: CodexLiveTimelineItemKind;
    providerItemKey: string;
    providerEventId?: string | undefined;
    providerMessageId?: string | undefined;
  },
): TimelineIdentity | undefined {
  if (!params.providerSessionId) return undefined;
  const itemIndex = allocateTimelineItemIndex(state, {
    turnId: params.turnId,
    itemKind: params.itemKind,
    providerItemKey: `${params.itemKind}:${params.providerItemKey}`,
  });
  const identity = createCodexTimelineIdentity({
    providerSessionId: params.providerSessionId,
    turnId: params.turnId,
    itemKind: params.itemKind,
    itemIndex,
    origin: "live",
    confidence: "derived",
    ...(params.providerEventId ? { providerEventId: params.providerEventId } : {}),
    ...(params.providerMessageId ? { providerMessageId: params.providerMessageId } : {}),
  });
  return identity;
}

export function inferredUserInputPlacement(
  state: CodexAppServerTimelineState,
  turnId: string,
): "turn_start" | "turn_steer" {
  return (state.seenUserMessageCountByTurnId.get(turnId) ?? 0) === 0
    ? "turn_start"
    : "turn_steer";
}

export function rememberCanonicalUserMessage(
  state: CodexAppServerTimelineState,
  turnId: string,
): void {
  state.seenUserMessageCountByTurnId.set(
    turnId,
    (state.seenUserMessageCountByTurnId.get(turnId) ?? 0) + 1,
  );
}

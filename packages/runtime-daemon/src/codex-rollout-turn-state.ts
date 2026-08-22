import type { TimelineRuntimeModel } from "@rah/runtime-protocol";
import {
  createCodexRolloutUserInputState,
  resetCodexRolloutUserInputState,
  type CodexRolloutUserInputState,
} from "./codex-rollout-user-input";
import { codexRuntimeModelFromTurnContext } from "./timeline-runtime-model";

export interface CodexRolloutTurnState extends CodexRolloutUserInputState {
  providerSessionId?: string | undefined;
  currentTurnId?: string | undefined;
  currentRuntimeModel?: TimelineRuntimeModel | undefined;
  nextTimelineItemIndex: number;
}

export function createCodexRolloutTurnState(
  options: { providerSessionId?: string | undefined },
): CodexRolloutTurnState {
  return {
    ...createCodexRolloutUserInputState(),
    nextTimelineItemIndex: 0,
    ...(options.providerSessionId ? { providerSessionId: options.providerSessionId } : {}),
  };
}

export function codexRolloutPayload(
  record: Record<string, unknown>,
): Record<string, unknown> | null {
  return record.payload && typeof record.payload === "object" && !Array.isArray(record.payload)
    ? (record.payload as Record<string, unknown>)
    : null;
}

function startCodexRolloutTurn(state: CodexRolloutTurnState, turnId: string): void {
  if (state.currentTurnId === turnId) return;
  state.currentTurnId = turnId;
  state.nextTimelineItemIndex = 0;
  resetCodexRolloutUserInputState(state);
}

export function syncCodexRolloutTurnState(
  state: CodexRolloutTurnState,
  record: Record<string, unknown>,
): void {
  const payload = codexRolloutPayload(record);
  if (!payload) return;
  if (record.type === "session_meta" && typeof payload.id === "string") {
    state.providerSessionId = state.providerSessionId ?? payload.id;
    return;
  }
  if (record.type !== "event_msg" && record.type !== "turn_context") return;
  const turnId = typeof payload.turn_id === "string" ? payload.turn_id : undefined;
  if (!turnId) return;
  if (record.type === "turn_context") {
    startCodexRolloutTurn(state, turnId);
    state.currentRuntimeModel = codexRuntimeModelFromTurnContext(payload);
    return;
  }
  if (payload.type === "task_started") {
    startCodexRolloutTurn(state, turnId);
    return;
  }
  if ((payload.type === "task_complete" || payload.type === "turn_aborted") &&
      state.currentTurnId === turnId) {
    state.currentTurnId = undefined;
    state.currentRuntimeModel = undefined;
    state.nextTimelineItemIndex = 0;
    resetCodexRolloutUserInputState(state);
  }
}

import type { ConversationTurnProjection } from "@rah/runtime-protocol";

export function latestCompletedProviderTurnId(
  turns: readonly ConversationTurnProjection[] | undefined,
): string | undefined {
  if (!turns) {
    return undefined;
  }

  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index];
    if (turn?.status !== "completed") {
      continue;
    }
    const providerTurnId = turn.providerTurnId?.trim();
    if (providerTurnId) {
      return providerTurnId;
    }
  }

  return undefined;
}

import type { ConversationTurnProjection, TimelineItem } from "@rah/runtime-protocol";
import { conversationItemFeedKey } from "../../conversation-feed";
import type { FeedEntry } from "../../types";

export type CurrentPlan = {
  key: string;
  turn: ConversationTurnProjection;
  item: Extract<TimelineItem, { kind: "plan" }>;
};

function turnHasFinalAnswer(turn: ConversationTurnProjection): boolean {
  return Boolean(
    turn.finalAnswerItemId || turn.items.some((item) => item.role === "final"),
  );
}

export function latestCurrentPlan(
  turns: readonly ConversationTurnProjection[],
): CurrentPlan | null {
  const turn = turns.at(-1);
  if (!turn || turn.status !== "in_progress" || turnHasFinalAnswer(turn)) {
    return null;
  }
  for (let itemIndex = turn.items.length - 1; itemIndex >= 0; itemIndex -= 1) {
    const item = turn.items[itemIndex];
    if (item?.content.kind === "timeline" && item.content.item.kind === "plan") {
      return {
        key: conversationItemFeedKey(item.id),
        turn,
        item: item.content.item,
      };
    }
  }
  return null;
}

export function withoutInlinePlans(entries: readonly FeedEntry[]): FeedEntry[] {
  return entries.filter(
    (entry) => entry.kind !== "timeline" || entry.item.kind !== "plan",
  );
}

export function currentPlanProgress(plan: CurrentPlan): {
  completed: number;
  total: number;
  activeStep: string | null;
} | null {
  const steps = plan.item.steps;
  if (!steps || steps.length === 0) {
    return null;
  }
  return {
    completed: steps.filter((step) => step.status === "completed").length,
    total: steps.length,
    activeStep: steps.find((step) => step.status === "in_progress")?.text ?? null,
  };
}

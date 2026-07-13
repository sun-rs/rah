import type { FeedEntry } from "../../types";
import type { TimelineItem } from "@rah/runtime-protocol";

export type CurrentPlan = {
  key: string;
  turnId?: string;
  item: Extract<TimelineItem, { kind: "plan" }>;
};

export function latestCurrentPlan(entries: readonly FeedEntry[]): CurrentPlan | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.kind === "timeline" && entry.item.kind === "plan") {
      const turnId = entry.providerTurnId ?? entry.canonicalTurnId ?? entry.turnId;
      return {
        key: entry.key,
        ...(turnId ? { turnId } : {}),
        item: entry.item,
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

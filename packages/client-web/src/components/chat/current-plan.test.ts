import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, test } from "node:test";
import type { ConversationItemProjection, ConversationTurnProjection } from "@rah/runtime-protocol";
import { summarizeConversationActivities } from "@rah/runtime-protocol";
import type { FeedEntry } from "../../types";
import { TaskSummaryDock } from "./TaskSummaryDock";
import { currentPlanProgress, latestCurrentPlan, withoutInlinePlans } from "./current-plan";

const planEntry = (key: string, completed: number): FeedEntry => ({
  key,
  kind: "timeline",
  ts: "2026-07-12T00:00:00.000Z",
  item: {
    kind: "plan",
    text: "- Inspect\n- Fix",
    steps: [
      { text: "Inspect", status: completed > 0 ? "completed" : "in_progress" },
      { text: "Fix", status: completed > 1 ? "completed" : "pending" },
    ],
  },
});

function planItem(id: string, turnId: string, completed: number): ConversationItemProjection {
  return {
    id,
    turnId,
    role: "process",
    status: "completed",
    content: {
      kind: "timeline",
      item: planEntry(id, completed).item as Extract<
        FeedEntry,
        { kind: "timeline" }
      >["item"],
    },
    source: { provider: "codex", channel: "history", authority: "provider_native" },
    revision: 1,
  };
}

function conversationTurn(
  id: string,
  items: ConversationItemProjection[],
  status: ConversationTurnProjection["status"] = "completed",
): ConversationTurnProjection {
  return {
    id,
    provider: "codex",
    providerTurnId: `provider-${id}`,
    status,
    statusAuthority: "native",
    items,
    activities: summarizeConversationActivities(items),
    failedItemCount: 0,
    revision: 1,
  };
}

describe("current plan", () => {
  test("keeps the latest plan from the active turn in a dedicated surface", () => {
    const entries: FeedEntry[] = [
      planEntry("plan-1", 0),
      {
        key: "assistant",
        kind: "timeline",
        ts: "2026-07-12T00:00:01.000Z",
        item: { kind: "assistant_message", text: "Working" },
      },
      planEntry("plan-2", 1),
    ];

    const turn = conversationTurn(
      "turn-1",
      [planItem("plan-1", "turn-1", 0), planItem("plan-2", "turn-1", 1)],
      "in_progress",
    );

    assert.equal(latestCurrentPlan([turn])?.key, "conversation:plan-2");
    assert.deepEqual(withoutInlinePlans(entries).map((entry) => entry.key), ["assistant"]);
    assert.deepEqual(currentPlanProgress(latestCurrentPlan([turn])!), {
      completed: 1,
      total: 2,
      activeStep: null,
    });
  });

  test("keeps the plan bound to its active canonical turn", () => {
    const priorTurn = conversationTurn("turn-prior", []);
    const planTurn = conversationTurn(
      "turn-plan",
      [planItem("plan-1", "turn-plan", 0)],
      "in_progress",
    );
    const plan = latestCurrentPlan([priorTurn, planTurn]);

    assert.equal(plan?.turn, planTurn);
    assert.equal(plan?.turn.id, "turn-plan");
  });

  test("hides terminal plans and does not revive an older plan for a later turn", () => {
    for (const status of ["completed", "interrupted", "failed"] as const) {
      const turn = conversationTurn(
        `turn-${status}`,
        [planItem(`plan-${status}`, `turn-${status}`, 2)],
        status,
      );
      assert.equal(latestCurrentPlan([turn]), null);
    }

    const olderActiveTurn = conversationTurn(
      "turn-older",
      [planItem("plan-older", "turn-older", 0)],
      "in_progress",
    );
    const laterTurn = conversationTurn("turn-later", [], "in_progress");
    assert.equal(latestCurrentPlan([olderActiveTurn, laterTurn]), null);
  });

  test("hides a plan as soon as its turn has a canonical final answer", () => {
    const plan = planItem("plan-1", "turn-1", 2);
    const final: ConversationItemProjection = {
      id: "final-1",
      turnId: "turn-1",
      role: "final",
      status: "completed",
      content: {
        kind: "timeline",
        item: { kind: "assistant_message", text: "Done", phase: "final_answer" },
      },
      source: { provider: "codex", channel: "live", authority: "provider_native" },
      revision: 1,
    };
    const turn = conversationTurn("turn-1", [plan, final], "in_progress");
    turn.finalAnswerItemId = final.id;

    assert.equal(latestCurrentPlan([turn]), null);
  });

  test("does not create a task summary from an orphaned flat-feed plan", () => {
    assert.equal(latestCurrentPlan([]), null);
    assert.equal(withoutInlinePlans([planEntry("orphan-plan", 0)]).length, 0);
  });

  test("renders one task summary surface with canonical turn status", () => {
    const item = planItem("plan-1", "turn-1", 1);
    const turn = conversationTurn("turn-1", [item], "in_progress");
    turn.activities = [{
      kind: "command",
      totalCount: 2,
      runningCount: 1,
      interruptedCount: 0,
      failureCount: 0,
      issueCount: 0,
    }];
    const html = renderToStaticMarkup(
      createElement(TaskSummaryDock, {
        plan: latestCurrentPlan([turn])!,
      }),
    );

    assert.match(html, /aria-label="Task summary"/);
    assert.match(html, />Task summary</);
    assert.match(html, /Working · 1\/2/);
    assert.doesNotMatch(html, /Current plan/);
  });
});

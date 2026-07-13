import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, test } from "node:test";
import type { ConversationTurnProjection } from "@rah/runtime-protocol";
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

describe("current plan", () => {
  test("keeps the latest plan in a dedicated surface and removes inline copies", () => {
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

    assert.equal(latestCurrentPlan(entries)?.key, "plan-2");
    assert.deepEqual(withoutInlinePlans(entries).map((entry) => entry.key), ["assistant"]);
    assert.deepEqual(currentPlanProgress(latestCurrentPlan(entries)!), {
      completed: 1,
      total: 2,
      activeStep: null,
    });
  });

  test("keeps the plan turn identity instead of borrowing a later turn", () => {
    const plan = {
      ...planEntry("plan-1", 0),
      providerTurnId: "provider-turn-plan",
    } satisfies FeedEntry;

    assert.equal(latestCurrentPlan([plan])?.turnId, "provider-turn-plan");
  });

  test("renders one task summary surface with canonical turn status", () => {
    const entries = [planEntry("plan-1", 1)];
    const turn: ConversationTurnProjection = {
      id: "turn-1",
      provider: "codex",
      status: "in_progress",
      statusAuthority: "native",
      items: [],
      activities: [
        {
          kind: "command",
          totalCount: 2,
          runningCount: 1,
          interruptedCount: 0,
          failureCount: 0,
          issueCount: 0,
        },
      ],
      failedItemCount: 0,
      revision: 1,
    };
    const html = renderToStaticMarkup(
      createElement(TaskSummaryDock, {
        plan: latestCurrentPlan(entries)!,
        turn,
      }),
    );

    assert.match(html, /aria-label="Task summary"/);
    assert.match(html, />Task summary</);
    assert.match(html, /Working · 1\/2/);
    assert.doesNotMatch(html, /Current plan/);
  });
});

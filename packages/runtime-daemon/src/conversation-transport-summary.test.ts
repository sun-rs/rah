import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  ConversationItemProjection,
  ConversationTurnProjection,
  TimelineItem,
} from "@rah/runtime-protocol";
import { summarizeConversationTurnForTransport } from "./conversation-transport-summary";

function timelineItem(args: {
  id: string;
  role?: ConversationItemProjection["role"];
  status?: ConversationItemProjection["status"];
  item: TimelineItem;
}): ConversationItemProjection {
  return {
    id: args.id,
    turnId: "turn-1",
    role: args.role ?? "process",
    status: args.status ?? "completed",
    content: { kind: "timeline", item: args.item },
    source: {
      provider: "codex",
      channel: "structured_live",
      authority: "authoritative",
    },
    revision: 1,
  };
}

function toolItem(index: number, status: ConversationItemProjection["status"] = "completed"):
  ConversationItemProjection {
  return {
    id: `tool-${index}`,
    turnId: "turn-1",
    role: "process",
    status,
    content: {
      kind: "tool",
      toolCall: {
        id: `tool-${index}`,
        family: "shell",
        providerToolName: "exec_command",
        summary: `command ${index} ${"x".repeat(900)}`,
      },
    },
    source: {
      provider: "codex",
      channel: "structured_live",
      authority: "authoritative",
    },
    revision: 1,
  };
}

test("bounds oversized live turns while preserving visible conversation semantics", () => {
  const user = timelineItem({
    id: "user",
    role: "user",
    item: { kind: "user_message", text: "Please inspect this workspace." },
  });
  const commentary = Array.from({ length: 70 }, (_, index) =>
    timelineItem({
      id: `commentary-${index}`,
      item: {
        kind: "assistant_message",
        phase: "commentary",
        text: `Progress ${index} ${"y".repeat(900)}`,
      },
    }),
  );
  const plan = timelineItem({
    id: "plan",
    item: { kind: "plan", text: "Inspect, patch, and verify." },
  });
  const tools = Array.from({ length: 300 }, (_, index) => toolItem(index));
  const running = toolItem(999, "running");
  const failed = toolItem(1000, "failed");
  const final = timelineItem({
    id: "final",
    role: "final",
    item: {
      kind: "assistant_message",
      phase: "final_answer",
      text: "The task is complete.",
    },
  });
  const turn: ConversationTurnProjection = {
    id: "turn-1",
    provider: "codex",
    status: "in_progress",
    statusAuthority: "native",
    items: [user, ...commentary, plan, ...tools, running, failed, final],
    activities: [],
    finalAnswerItemId: final.id,
    failedItemCount: 1,
    revision: 1,
  };

  const originalItemCount = turn.items.length;
  const summarized = summarizeConversationTurnForTransport(turn);
  const summarizedIds = new Set(summarized.items.map((item) => item.id));

  assert.equal(turn.items.length, originalItemCount);
  assert.equal(summarized.itemsView, "summary");
  assert.ok(summarized.items.length < originalItemCount / 2);
  assert.ok(Buffer.byteLength(JSON.stringify(summarized.items), "utf8") < 78 * 1024);
  assert.ok(summarizedIds.has(user.id));
  assert.ok(summarizedIds.has(plan.id));
  assert.ok(summarizedIds.has(running.id));
  assert.ok(summarizedIds.has(failed.id));
  assert.ok(summarizedIds.has(final.id));
  assert.ok(summarizedIds.has("commentary-69"));
  assert.ok(!summarizedIds.has("tool-0"));
});

test("leaves ordinary turns unchanged", () => {
  const turn: ConversationTurnProjection = {
    id: "turn-small",
    provider: "codex",
    status: "completed",
    statusAuthority: "native",
    items: [
      timelineItem({
        id: "small-user",
        role: "user",
        item: { kind: "user_message", text: "Hello" },
      }),
    ],
    activities: [],
    failedItemCount: 0,
    revision: 1,
  };

  assert.equal(summarizeConversationTurnForTransport(turn), turn);
});

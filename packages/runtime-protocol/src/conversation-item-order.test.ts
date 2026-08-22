import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ConversationItemProjection } from "./conversation";
import { orderConversationTurnItems } from "./conversation-item-order";

const source = {
  provider: "codex" as const,
  channel: "structured_persisted" as const,
  authority: "authoritative" as const,
};

function item(
  id: string,
  role: ConversationItemProjection["role"],
  startedAt: string | undefined,
  revision = 1,
): ConversationItemProjection {
  return {
    id,
    turnId: "turn-1",
    role,
    status: "completed",
    ...(startedAt ? { startedAt } : {}),
    content: {
      kind: "timeline",
      item:
        role === "user"
          ? { kind: "user_message", text: id }
          : { kind: "assistant_message", text: id },
    },
    source,
    revision,
  };
}

describe("conversation turn item order", () => {
  test("moves a late persisted activation prompt ahead of Resume preflight work", () => {
    const items = [
      item("compaction", "process", "2026-08-14T08:37:44.995Z"),
      item("prompt", "user", "2026-08-14T08:37:45.004Z"),
      item("reasoning", "process", "2026-08-14T08:37:46.000Z"),
      item("answer", "final", "2026-08-14T08:43:07.811Z"),
    ];

    assert.deepEqual(
      orderConversationTurnItems(items).map((candidate) => candidate.id),
      ["prompt", "compaction", "reasoning", "answer"],
    );
  });

  test("keeps later Guide input among process evidence", () => {
    const items = [
      item("preflight", "process", "2026-08-14T08:37:44.995Z"),
      item("prompt", "user", "2026-08-14T08:37:45.004Z"),
      item("reasoning", "process", "2026-08-14T08:37:46.000Z"),
      item("guide", "user", "2026-08-14T08:38:00.000Z"),
      item("after-guide", "process", "2026-08-14T08:38:01.000Z"),
      item("answer", "final", "2026-08-14T08:43:07.811Z"),
    ];

    assert.deepEqual(
      orderConversationTurnItems(items).map((candidate) => candidate.id),
      ["prompt", "preflight", "reasoning", "guide", "after-guide", "answer"],
    );
  });

  test("restores a late-arriving Guide to its causal anchor", () => {
    const prompt = item("prompt", "user", "2026-08-14T08:37:45.004Z");
    if (prompt.content.kind === "timeline" && prompt.content.item.kind === "user_message") {
      prompt.content.item.inputPlacement = "turn_start";
    }
    const guide = item("guide", "user", "2026-08-14T08:38:00.000Z");
    if (guide.content.kind === "timeline" && guide.content.item.kind === "user_message") {
      guide.content.item.inputPlacement = "turn_steer";
      guide.content.item.causalAfterItemId = "reasoning-before";
    }
    const items = [
      prompt,
      item("reasoning-before", "process", "2026-08-14T08:37:46.000Z"),
      item("reasoning-after", "process", "2026-08-14T08:38:01.000Z"),
      item("answer", "final", "2026-08-14T08:43:07.811Z"),
      guide,
    ];

    assert.deepEqual(
      orderConversationTurnItems(items).map((candidate) => candidate.id),
      ["prompt", "reasoning-before", "guide", "reasoning-after", "answer"],
    );
  });

  test("does not mistake a timestamped Guide for an undated activation prompt", () => {
    const items = [
      item("preflight", "process", "2026-08-14T08:37:44.995Z", 1),
      item("prompt", "user", undefined, 2),
      item("guide", "user", "2026-08-14T08:38:00.000Z", 3),
      item("answer", "final", "2026-08-14T08:43:07.811Z", 4),
    ];

    assert.deepEqual(
      orderConversationTurnItems(items).map((candidate) => candidate.id),
      ["prompt", "preflight", "guide", "answer"],
    );
  });

  test("moves late process evidence before an already projected final answer", () => {
    const items = [
      item("prompt", "user", "2026-08-14T08:37:45.004Z"),
      item("answer", "final", "2026-08-14T08:43:07.811Z"),
      item("late-tool", "process", "2026-08-14T08:40:00.000Z"),
    ];

    assert.deepEqual(
      orderConversationTurnItems(items).map((candidate) => candidate.id),
      ["prompt", "late-tool", "answer"],
    );
  });

  test("preserves the array identity when it is already canonical", () => {
    const items = [
      item("prompt", "user", "2026-08-14T08:37:45.004Z"),
      item("reasoning", "process", "2026-08-14T08:37:46.000Z"),
      item("answer", "final", "2026-08-14T08:43:07.811Z"),
    ];

    assert.strictEqual(orderConversationTurnItems(items), items);
  });
});

import assert from "node:assert/strict";
import test from "node:test";
import type {
  ConversationItemProjection,
  ConversationTurnProjection,
  ConversationTurnsPageResponse,
} from "@rah/runtime-protocol";
import { buildConversationTurnDirectory } from "./conversation-turn-directory";

function item(args: {
  id: string;
  turnId: string;
  role: "user" | "final";
  text: string;
  startedAt: string;
}): ConversationItemProjection {
  return {
    id: args.id,
    turnId: args.turnId,
    providerItemId: args.id,
    role: args.role,
    status: "completed",
    startedAt: args.startedAt,
    content: {
      kind: "timeline",
      item: {
        kind: args.role === "user" ? "user_message" : "assistant_message",
        text: args.text,
        ...(args.role === "final" ? { phase: "final_answer" as const } : {}),
      },
    },
    source: {
      provider: "claude",
      channel: "structured_persisted",
      authority: "authoritative",
    },
    revision: 1,
  };
}

function turn(args: {
  id: string;
  startedAt: string;
  question: string;
  answer?: string;
  revision?: number;
}): ConversationTurnProjection {
  const user = item({
    id: `${args.id}:user`,
    turnId: `canonical:${args.id}`,
    role: "user",
    text: args.question,
    startedAt: args.startedAt,
  });
  const final = args.answer
    ? item({
        id: `${args.id}:final`,
        turnId: `canonical:${args.id}`,
        role: "final",
        text: args.answer,
        startedAt: args.startedAt,
      })
    : undefined;
  return {
    id: `canonical:${args.id}`,
    provider: "claude",
    providerTurnId: args.id,
    status: final ? "completed" : "in_progress",
    statusAuthority: "derived",
    startedAt: args.startedAt,
    items: final ? [user, final] : [user],
    ...(final ? { finalAnswerItemId: final.id } : {}),
    failedItemCount: 0,
    activities: [],
    revision: args.revision ?? 1,
  };
}

function page(
  turns: ConversationTurnProjection[],
  revision: number,
  nextCursor?: string,
): ConversationTurnsPageResponse {
  return {
    sessionId: "session-1",
    turns,
    revision,
    generatedAt: "2026-07-12T00:00:00.000Z",
    sourceEventCount: turns.length,
    approximateBytes: 100,
    ...(nextCursor ? { nextCursor } : {}),
  };
}

test("builds one provider-neutral directory across canonical history pages", async () => {
  const pages = new Map<string | undefined, ConversationTurnsPageResponse>([
    [undefined, page([turn({ id: "turn-2", startedAt: "2026-07-12T00:02:00.000Z", question: "Q2", answer: "A2" })], 3, "older")],
    ["older", page([turn({ id: "turn-1", startedAt: "2026-07-12T00:01:00.000Z", question: "Q1", answer: "A1" })], 2)],
  ]);
  const requested: Array<string | undefined> = [];
  const directory = await buildConversationTurnDirectory({
    sessionId: "session-1",
    loadPage: async (cursor) => {
      requested.push(cursor);
      const value = pages.get(cursor);
      assert.ok(value);
      return value;
    },
  });

  assert.deepEqual(requested, [undefined, "older"]);
  assert.equal(directory.complete, true);
  assert.equal(directory.sourceBytes, 200);
  assert.deepEqual(
    directory.items.map((entry) => [entry.ordinal, entry.id, entry.userPreview, entry.assistantPreview]),
    [[0, "turn-1", "Q1", "A1"], [1, "turn-2", "Q2", "A2"]],
  );
});

test("stops safely when a provider repeats a paging cursor", async () => {
  let calls = 0;
  const directory = await buildConversationTurnDirectory({
    sessionId: "session-1",
    loadPage: async () => {
      calls += 1;
      return page([
        turn({ id: "turn-1", startedAt: "2026-07-12T00:01:00.000Z", question: "Q1" }),
      ], calls, "same");
    },
  });
  assert.equal(calls, 2);
  assert.equal(directory.complete, false);
  assert.equal(directory.items.length, 1);
});

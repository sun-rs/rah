import assert from "node:assert/strict";
import test from "node:test";

import type {
  ConversationTurnProjection,
  SessionQueuedInput,
} from "@rah/runtime-protocol";

import {
  conversationDisplayRows,
  isDetachedTerminalSubagentTurn,
  conversationFeedWithInputQueue,
  conversationTurnsToFeed,
  stableConversationLocalFeed,
} from "./conversation-feed.js";
import type { FeedEntry } from "./types.js";

function queuedInput(
  overrides: Partial<SessionQueuedInput> = {},
): SessionQueuedInput {
  return {
    clientMessageId: "message-1",
    clientTurnId: "turn-1",
    text: "queued message",
    queuedAt: "2026-07-20T00:00:00.000Z",
    position: 1,
    state: "queued",
    ...overrides,
  } as SessionQueuedInput;
}

function canonicalUserMessage(
  overrides: Partial<Extract<FeedEntry, { kind: "timeline" }>> = {},
): FeedEntry {
  return {
    key: "timeline:user:message-1",
    kind: "timeline",
    item: {
      kind: "user_message",
      text: "queued message",
      clientMessageId: "message-1",
    },
    ts: "2026-07-20T00:00:01.000Z",
    ...overrides,
  };
}

test("keeps a queued input out of the conversation timeline", () => {
  const projected = conversationFeedWithInputQueue([], [queuedInput()]);

  assert.deepEqual(projected, []);
});

test("projects a submitting input into the timeline so refresh cannot hide an owned prompt", () => {
  const projected = conversationFeedWithInputQueue(
    [],
    [queuedInput({ state: "submitting" })],
  );

  assert.equal(projected.length, 1);
  assert.equal(projected[0]?.key, "submitting:user:message-1");
  assert.deepEqual(
    projected[0]?.kind === "timeline" ? projected[0].item : null,
    {
      kind: "user_message",
      text: "queued message",
      clientMessageId: "message-1",
      clientTurnId: "turn-1",
    },
  );
});

test("canonical user item replaces the queue projection without duplication", () => {
  const canonical = canonicalUserMessage();
  const projected = conversationFeedWithInputQueue(
    [canonical],
    [queuedInput({ state: "submitting" })],
  );

  assert.deepEqual(projected, [canonical]);
});

test("does not synthesize a second bubble for a distinct queued message", () => {
  const canonical = canonicalUserMessage({
    key: "timeline:user:message-2",
    item: {
      kind: "user_message",
      text: "queued message",
      clientMessageId: "message-2",
    },
  });
  const projected = conversationFeedWithInputQueue(
    [canonical],
    [queuedInput()],
  );

  assert.deepEqual(projected, [canonical]);
});

test("keeps the chat-local feed stable across process-output-only updates", () => {
  const optimisticUser = canonicalUserMessage({
    key: "optimistic:user:message-1",
  });
  const firstProcessEntry: FeedEntry = {
    key: "tool:command-1",
    kind: "tool_call",
    toolCall: {
      id: "command-1",
      kind: "command",
      title: "Run command",
      detailAvailable: true,
    },
    status: "running",
    ts: "2026-07-20T00:00:02.000Z",
  };
  const updatedProcessEntry: FeedEntry = {
    ...firstProcessEntry,
    status: "completed",
  };

  const first = stableConversationLocalFeed([
    optimisticUser,
    firstProcessEntry,
  ]);
  const afterOutput = stableConversationLocalFeed(
    [optimisticUser, updatedProcessEntry],
    first,
  );

  assert.strictEqual(afterOutput, first);
  assert.deepEqual(afterOutput, [optimisticUser]);

  const replacedOptimisticUser = {
    ...optimisticUser,
    item: {
      ...optimisticUser.item,
      text: "updated optimistic message",
    },
  } satisfies FeedEntry;
  const afterUserChange = stableConversationLocalFeed(
    [replacedOptimisticUser, updatedProcessEntry],
    afterOutput,
  );

  assert.notStrictEqual(afterUserChange, afterOutput);
  assert.deepEqual(afterUserChange, [replacedOptimisticUser]);
});

test("keeps canonical and provider turn identities on historical timeline items", () => {
  const turn: ConversationTurnProjection = {
    id: "canonical-turn-1",
    provider: "codex",
    providerSessionId: "provider-session-1",
    providerTurnId: "provider-turn-1",
    status: "completed",
    statusAuthority: "native",
    startedAt: "2026-07-20T00:00:00.000Z",
    completedAt: "2026-07-20T00:00:01.000Z",
    durationMs: 1_000,
    items: [
      {
        id: "canonical-item-1",
        turnId: "canonical-turn-1",
        providerItemId: "item:0",
        role: "user",
        status: "completed",
        startedAt: "2026-07-20T00:00:00.000Z",
        content: {
          kind: "timeline",
          item: {
            kind: "user_message",
            text: "message with an image",
            imageCount: 1,
          },
        },
        source: {
          provider: "codex",
          channel: "structured_persisted",
          authority: "authoritative",
        },
        revision: 1,
      },
    ],
    failedItemCount: 0,
    itemsView: "summary",
    revision: 1,
  };

  const [entry] = conversationTurnsToFeed([turn]);
  assert.equal(entry?.kind, "timeline");
  if (entry?.kind !== "timeline") {
    return;
  }
  assert.equal(entry.turnId, "provider-turn-1");
  assert.equal(entry.providerTurnId, "provider-turn-1");
  assert.equal(entry.canonicalTurnId, "canonical-turn-1");
});

test("filters legacy orphan subagent turns from the public conversation feed", () => {
  const orphan: ConversationTurnProjection = {
    id: "subagent-turn",
    provider: "codex",
    providerTurnId: "subagent-turn",
    status: "in_progress",
    statusAuthority: "derived",
    items: [
      {
        id: "subagent-observation",
        turnId: "subagent-turn",
        role: "process",
        status: "completed",
        content: {
          kind: "observation",
          observation: {
            id: "subagent-observation",
            kind: "subagent.lifecycle",
            status: "completed",
            title: "Coordinated subagents",
          },
        },
        source: {
          provider: "codex",
          channel: "structured_live",
          authority: "derived",
        },
        revision: 1,
      },
    ],
    activities: [],
    failedItemCount: 0,
    revision: 1,
  };

  assert.equal(isDetachedTerminalSubagentTurn(orphan), true);
  assert.deepEqual(conversationTurnsToFeed([orphan]), []);
});

test("does not append orphan Working and Coordinated subagents rows after a final answer", () => {
  const completed: ConversationTurnProjection = {
    id: "main-turn",
    provider: "codex",
    providerSessionId: "main-session",
    providerTurnId: "main-turn",
    status: "completed",
    statusAuthority: "native",
    finalAnswerItemId: "final-answer",
    items: [
      {
        id: "final-answer",
        turnId: "main-turn",
        role: "final",
        status: "completed",
        content: {
          kind: "timeline",
          item: {
            kind: "assistant_message",
            phase: "final_answer",
            text: "The audit is complete.",
          },
        },
        source: {
          provider: "codex",
          channel: "structured_persisted",
          authority: "provider_native",
        },
        revision: 1,
      },
    ],
    activities: [],
    failedItemCount: 0,
    revision: 1,
  };
  const orphan = {
    id: "nested-turn",
    provider: "codex",
    providerTurnId: "nested-turn",
    status: "in_progress",
    statusAuthority: "derived",
    items: [
      {
        id: "nested-observation",
        turnId: "nested-turn",
        role: "process",
        status: "completed",
        content: {
          kind: "observation",
          observation: {
            id: "nested-observation",
            kind: "subagent.lifecycle",
            status: "completed",
            title: "Coordinated subagents",
          },
        },
        source: {
          provider: "codex",
          channel: "structured_live",
          authority: "derived",
        },
        revision: 1,
      },
    ],
    activities: [],
    failedItemCount: 0,
    revision: 1,
  } satisfies ConversationTurnProjection;
  const turns = [completed, orphan];
  const feed = conversationTurnsToFeed(turns);
  const rows = conversationDisplayRows(turns, feed);

  assert.equal(
    rows.some((row) => row.key === "conversation-process:nested-turn"),
    false,
  );
  assert.equal(
    rows.some(
      (row) =>
        row.kind === "feed_entry" &&
        row.entry.kind === "timeline" &&
        row.entry.item.kind === "assistant_message" &&
        row.entry.item.text === "The audit is complete.",
    ),
    true,
  );
});

test("keeps an accepted guide inside its active turn process timeline", () => {
  const source = {
    provider: "codex" as const,
    channel: "structured_live" as const,
    authority: "derived" as const,
  };
  const turn: ConversationTurnProjection = {
    id: "turn-guided",
    provider: "codex",
    providerSessionId: "thread-guided",
    providerTurnId: "turn-guided",
    status: "completed",
    statusAuthority: "native",
    finalAnswerItemId: "final-guided",
    items: [
      {
        id: "initial-user",
        turnId: "turn-guided",
        role: "user",
        status: "completed",
        content: {
          kind: "timeline",
          item: { kind: "user_message", text: "Audit the data" },
        },
        source,
        revision: 1,
      },
      {
        id: "reasoning-before-guide",
        turnId: "turn-guided",
        role: "process",
        status: "completed",
        content: {
          kind: "timeline",
          item: { kind: "reasoning", text: "Reading the first source" },
        },
        source,
        revision: 1,
      },
      {
        id: "guide-user",
        turnId: "turn-guided",
        role: "user",
        status: "completed",
        content: {
          kind: "timeline",
          item: {
            kind: "user_message",
            text: "Focus on the lab folder",
            clientMessageId: "guide-message",
          },
        },
        source,
        revision: 1,
      },
      {
        id: "reasoning-after-guide",
        turnId: "turn-guided",
        role: "process",
        status: "completed",
        content: {
          kind: "timeline",
          item: { kind: "reasoning", text: "Applying the guide" },
        },
        source,
        revision: 1,
      },
      {
        id: "final-guided",
        turnId: "turn-guided",
        role: "final",
        status: "completed",
        content: {
          kind: "timeline",
          item: {
            kind: "assistant_message",
            phase: "final_answer",
            text: "Audit complete",
          },
        },
        source,
        revision: 1,
      },
    ],
    activities: [],
    failedItemCount: 0,
    revision: 1,
  };
  const rows = conversationDisplayRows([turn], conversationTurnsToFeed([turn]));
  assert.deepEqual(rows.map((row) => row.kind), [
    "feed_entry",
    "assistant_process_group",
    "feed_entry",
    "turn_copy_action",
  ]);
  const process = rows[1];
  assert.equal(process?.kind, "assistant_process_group");
  assert.deepEqual(
    process?.kind === "assistant_process_group"
      ? process.entries.map((entry) =>
          entry.kind === "timeline" ? entry.item.kind : entry.kind,
        )
      : [],
    ["reasoning", "user_message", "reasoning"],
  );
});

test("renders a late persisted Resume prompt before Worked and the final reply", () => {
  const source = {
    provider: "codex" as const,
    channel: "structured_persisted" as const,
    authority: "authoritative" as const,
  };
  const runtimeModel = {
    modelId: "gpt-5.6-sol",
    optionId: "xhigh",
    optionKind: "reasoning_effort" as const,
    source: "native" as const,
  };
  const turn: ConversationTurnProjection = {
    id: "turn-resume",
    provider: "codex",
    providerSessionId: "thread-resume",
    providerTurnId: "turn-resume",
    status: "completed",
    statusAuthority: "native",
    startedAt: "2026-08-14T08:36:43.510Z",
    completedAt: "2026-08-14T08:43:07.987Z",
    finalAnswerItemId: "answer",
    items: [
      {
        id: "compaction",
        turnId: "turn-resume",
        role: "process",
        status: "completed",
        startedAt: "2026-08-14T08:37:44.995Z",
        content: {
          kind: "timeline",
          item: { kind: "compaction", status: "completed", count: 1 },
        },
        source,
        revision: 1,
      },
      {
        id: "prompt",
        turnId: "turn-resume",
        role: "user",
        status: "completed",
        startedAt: "2026-08-14T08:37:45.004Z",
        content: {
          kind: "timeline",
          item: { kind: "user_message", text: "Continue the audit" },
        },
        source,
        revision: 1,
      },
      {
        id: "answer",
        turnId: "turn-resume",
        role: "final",
        status: "completed",
        startedAt: "2026-08-14T08:43:07.811Z",
        content: {
          kind: "timeline",
          item: {
            kind: "assistant_message",
            phase: "final_answer",
            text: "Audit resumed",
            runtimeModel,
          },
        },
        source,
        revision: 1,
      },
    ],
    activities: [],
    failedItemCount: 0,
    revision: 1,
  };

  const rows = conversationDisplayRows([turn], conversationTurnsToFeed([turn]));
  assert.deepEqual(rows.map((row) => row.kind), [
    "feed_entry",
    "assistant_process_group",
    "feed_entry",
    "turn_copy_action",
  ]);
  assert.equal(
    rows[0]?.kind === "feed_entry" &&
      rows[0].entry.kind === "timeline" &&
      rows[0].entry.item.kind === "user_message"
      ? rows[0].entry.item.text
      : null,
    "Continue the audit",
  );
  assert.deepEqual(
    rows[1]?.kind === "assistant_process_group" ? rows[1].runtimeModel : null,
    runtimeModel,
  );
});

test("places an optimistic Guide inside Worked before its native echo arrives", () => {
  const source = {
    provider: "codex" as const,
    channel: "structured_live" as const,
    authority: "derived" as const,
  };
  const turn: ConversationTurnProjection = {
    id: "canonical-active-turn",
    provider: "codex",
    providerSessionId: "thread-active",
    providerTurnId: "provider-active-turn",
    status: "in_progress",
    statusAuthority: "native",
    startedAt: "2026-08-13T00:00:00.000Z",
    items: [
      {
        id: "initial-active-user",
        turnId: "canonical-active-turn",
        role: "user",
        status: "completed",
        content: {
          kind: "timeline",
          item: { kind: "user_message", text: "Start the audit" },
        },
        source,
        startedAt: "2026-08-13T00:00:00.000Z",
        revision: 1,
      },
      {
        id: "active-reasoning",
        turnId: "canonical-active-turn",
        role: "process",
        status: "running",
        content: {
          kind: "timeline",
          item: { kind: "reasoning", text: "Inspecting files" },
        },
        source,
        startedAt: "2026-08-13T00:00:01.000Z",
        revision: 1,
      },
      {
        id: "reasoning-after-guide-click",
        turnId: "canonical-active-turn",
        role: "process",
        status: "running",
        content: {
          kind: "timeline",
          item: { kind: "reasoning", text: "Inspecting the selected folder" },
        },
        source,
        startedAt: "2026-08-13T00:00:03.000Z",
        revision: 2,
      },
    ],
    activities: [],
    failedItemCount: 0,
    revision: 1,
  };
  const optimisticGuide: FeedEntry = {
    key: "optimistic:user:guide-optimistic",
    kind: "timeline",
    item: {
      kind: "user_message",
      text: "Inspect only the lab folder",
      clientMessageId: "guide-optimistic",
      inputPlacement: "turn_steer",
      causalAfterItemId: "active-reasoning",
    },
    ts: "2026-08-13T00:00:02.000Z",
    turnId: "provider-active-turn",
    canonicalTurnId: "canonical-active-turn",
    providerTurnId: "provider-active-turn",
  };
  const feed = conversationTurnsToFeed([turn], [optimisticGuide]);
  const rows = conversationDisplayRows([turn], feed, feed, {
    generationActive: true,
  });

  assert.deepEqual(rows.map((row) => row.kind), [
    "feed_entry",
    "assistant_process_group",
  ]);
  const process = rows[1];
  assert.equal(process?.kind, "assistant_process_group");
  assert.deepEqual(
    process?.kind === "assistant_process_group"
      ? process.entries.map((entry) =>
          entry.kind === "timeline" ? entry.item.kind : entry.kind,
        )
      : [],
    ["reasoning", "user_message", "reasoning"],
  );
});

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { EventSource, RahEvent } from "@rah/runtime-protocol";
import { projectConversation } from "./conversation-projector";
import { createTimelineIdentity, createTimelineTurnIdentity } from "./timeline-identity";

const CODEX_SOURCE: EventSource = {
  provider: "codex",
  channel: "structured_live",
  authority: "authoritative",
};

const OPENCODE_SOURCE: EventSource = {
  provider: "opencode",
  channel: "structured_live",
  authority: "authoritative",
};

const CLAUDE_SOURCE: EventSource = {
  provider: "claude",
  channel: "structured_persisted",
  authority: "derived",
};

function event(
  seq: number,
  type: RahEvent["type"],
  source: EventSource,
  turnId: string,
  payload: unknown,
): RahEvent {
  return {
    id: `event-${seq}`,
    seq,
    ts: new Date(Date.UTC(2026, 6, 10, 0, 0, seq)).toISOString(),
    sessionId: "session-1",
    turnId,
    type,
    source,
    payload,
  } as RahEvent;
}

describe("conversation projector", () => {
  test("preserves Codex turn lifecycle and keeps subagent work inside the main turn", () => {
    const turnIdentity = createTimelineTurnIdentity({
      provider: "codex",
      providerSessionId: "thread-1",
      turnKey: "turn-1",
      origin: "live",
      confidence: "native",
    });
    const itemIdentity = (itemKey: string, itemKind: string) =>
      createTimelineIdentity({
        provider: "codex",
        providerSessionId: "thread-1",
        turnKey: "turn-1",
        itemKind,
        itemKey,
        origin: "live",
        confidence: "native",
      });
    const events: RahEvent[] = [
      event(1, "turn.started", CODEX_SOURCE, "turn-1", {
        identity: turnIdentity,
        startedAt: "2026-07-10T00:00:01.000Z",
      }),
      event(2, "timeline.item.added", CODEX_SOURCE, "turn-1", {
        identity: itemIdentity("user-1", "user_message"),
        item: { kind: "user_message", text: "audit it", messageId: "user-1" },
      }),
      event(3, "timeline.item.added", CODEX_SOURCE, "turn-1", {
        identity: itemIdentity("assistant-process", "assistant_message"),
        item: {
          kind: "assistant_message",
          text: "I am checking the repository.",
          phase: "commentary",
          messageId: "assistant-process",
        },
      }),
      event(4, "observation.completed", CODEX_SOURCE, "turn-1", {
        observation: {
          id: "subagent-1",
          kind: "subagent.lifecycle",
          status: "completed",
          title: "Reviewer completed",
        },
      }),
      event(5, "timeline.item.added", CODEX_SOURCE, "turn-1", {
        identity: itemIdentity("assistant-final", "assistant_message"),
        item: {
          kind: "assistant_message",
          text: "The audit is complete.",
          phase: "final_answer",
          messageId: "assistant-final",
        },
      }),
      event(6, "turn.completed", CODEX_SOURCE, "turn-1", {
        identity: turnIdentity,
        startedAt: "2026-07-10T00:00:01.000Z",
        completedAt: "2026-07-10T00:00:06.000Z",
        durationMs: 5_000,
      }),
    ];

    const projection = projectConversation("session-1", events, {
      generatedAt: "2026-07-10T00:01:00.000Z",
    });
    assert.equal(projection.turns.length, 1);
    const turn = projection.turns[0];
    assert.ok(turn);
    assert.equal(turn.id, turnIdentity.canonicalTurnId);
    assert.equal(turn.status, "completed");
    assert.equal(turn.statusAuthority, "native");
    assert.equal(turn.durationMs, 5_000);
    assert.equal(turn.items.length, 4);
    assert.equal(
      turn.items.find((item) => item.id === turn.finalAnswerItemId)?.content.kind,
      "timeline",
    );
    assert.equal(
      turn.items.find((item) => item.id === turn.finalAnswerItemId)?.role,
      "final",
    );
    assert.equal(
      turn.items.find((item) => item.content.kind === "observation")?.status,
      "completed",
    );
  });

  test("upgrades an OpenCode provisional turn and chooses a final only after completion", () => {
    const rootIdentity = createTimelineIdentity({
      provider: "opencode",
      providerSessionId: "opencode-session-1",
      turnKey: "message:user-1",
      itemKind: "user_message",
      itemKey: "user-1",
      origin: "live",
      confidence: "native",
    });
    const assistantIdentity = createTimelineIdentity({
      provider: "opencode",
      providerSessionId: "opencode-session-1",
      turnKey: "message:user-1",
      itemKind: "assistant_message",
      itemKey: "assistant-1",
      origin: "live",
      confidence: "native",
    });
    const events: RahEvent[] = [
      event(1, "turn.started", OPENCODE_SOURCE, "runtime-turn-1", {}),
      event(2, "timeline.item.added", OPENCODE_SOURCE, "runtime-turn-1", {
        identity: rootIdentity,
        item: { kind: "user_message", text: "hello", messageId: "user-1" },
      }),
      event(3, "timeline.item.added", OPENCODE_SOURCE, "runtime-turn-1", {
        identity: assistantIdentity,
        item: { kind: "assistant_message", text: "hello back", messageId: "assistant-1" },
      }),
    ];

    const active = projectConversation("session-1", events);
    assert.equal(active.turns.length, 1);
    assert.equal(active.turns[0]?.id, rootIdentity.canonicalTurnId);
    assert.equal(active.turns[0]?.status, "in_progress");
    assert.equal(active.turns[0]?.finalAnswerItemId, undefined);
    assert.equal(active.turns[0]?.items.at(-1)?.role, "process");

    const completed = projectConversation("session-1", [
      ...events,
      event(4, "turn.completed", OPENCODE_SOURCE, "runtime-turn-1", {}),
    ]);
    assert.equal(completed.turns.length, 1);
    assert.equal(completed.turns[0]?.status, "completed");
    assert.equal(completed.turns[0]?.finalAnswerItemId, assistantIdentity.canonicalItemId);
    assert.equal(completed.turns[0]?.items.at(-1)?.role, "final");
  });

  test("derives Claude boundaries without pretending the open live turn completed", () => {
    const turnIdentity = (recordUuid: string) =>
      createTimelineTurnIdentity({
        provider: "claude",
        providerSessionId: "claude-session-1",
        turnKey: `record:${recordUuid}`,
        origin: "history",
        confidence: "native",
      });
    const itemIdentity = (
      turnRecordUuid: string,
      recordUuid: string,
      itemKind: "user_message" | "assistant_message",
    ) =>
      createTimelineIdentity({
        provider: "claude",
        providerSessionId: "claude-session-1",
        turnKey: `record:${turnRecordUuid}`,
        itemKind,
        itemKey: recordUuid,
        origin: "history",
        confidence: "native",
      });
    const events: RahEvent[] = [
      event(1, "turn.started", CLAUDE_SOURCE, "turn:user-1", {
        identity: turnIdentity("user-1"),
      }),
      event(2, "timeline.item.added", CLAUDE_SOURCE, "turn:user-1", {
        identity: itemIdentity("user-1", "user-1", "user_message"),
        item: { kind: "user_message", text: "first", messageId: "user-1" },
      }),
      event(3, "timeline.item.added", CLAUDE_SOURCE, "turn:user-1", {
        identity: itemIdentity("user-1", "assistant-1", "assistant_message"),
        item: { kind: "assistant_message", text: "first answer", messageId: "assistant-1" },
      }),
      event(4, "turn.started", CLAUDE_SOURCE, "turn:user-2", {
        identity: turnIdentity("user-2"),
      }),
      event(5, "timeline.item.added", CLAUDE_SOURCE, "turn:user-2", {
        identity: itemIdentity("user-2", "user-2", "user_message"),
        item: { kind: "user_message", text: "second", messageId: "user-2" },
      }),
      event(6, "timeline.item.added", CLAUDE_SOURCE, "turn:user-2", {
        identity: itemIdentity("user-2", "assistant-2", "assistant_message"),
        item: { kind: "assistant_message", text: "second answer", messageId: "assistant-2" },
      }),
    ];

    const live = projectConversation("session-1", events);
    assert.deepEqual(
      live.turns.map((turn) => [turn.status, turn.statusAuthority]),
      [
        ["completed", "derived"],
        ["in_progress", "derived"],
      ],
    );
    assert.equal(live.turns[0]?.finalAnswerItemId, itemIdentity("user-1", "assistant-1", "assistant_message").canonicalItemId);
    assert.equal(live.turns[1]?.finalAnswerItemId, undefined);

    const settled = projectConversation("session-1", events, { assumeSettled: true });
    assert.equal(settled.turns[1]?.status, "completed");
    assert.equal(settled.turns[1]?.statusAuthority, "derived");
    assert.equal(settled.turns[1]?.finalAnswerItemId, itemIdentity("user-2", "assistant-2", "assistant_message").canonicalItemId);
  });

  test("settles completed-looking persisted turns without provider-specific rules", () => {
    const identity = createTimelineIdentity({
      provider: "codex",
      providerSessionId: "thread-history",
      turnKey: "turn-history",
      itemKind: "assistant_message",
      itemKey: "assistant-final",
      origin: "history",
      confidence: "native",
    });
    const events: RahEvent[] = [
      event(1, "timeline.item.added", CODEX_SOURCE, "turn-history", {
        identity,
        item: {
          kind: "assistant_message",
          text: "Stored final answer",
          phase: "final_answer",
        },
      }),
    ];

    assert.equal(projectConversation("session-1", events).turns[0]?.status, "in_progress");
    const settled = projectConversation("session-1", events, { assumeSettled: true });
    assert.equal(settled.turns[0]?.status, "completed");
    assert.equal(settled.turns[0]?.finalAnswerItemId, identity.canonicalItemId);
  });

  test("prefers normalized observations over duplicate tool calls and localizes failures", () => {
    const events: RahEvent[] = [
      event(1, "turn.started", CODEX_SOURCE, "turn-1", {}),
      event(2, "tool.call.started", CODEX_SOURCE, "turn-1", {
        toolCall: {
          id: "call-1",
          family: "test",
          providerToolName: "exec_command",
          title: "Run tests",
        },
      }),
      event(3, "observation.failed", CODEX_SOURCE, "turn-1", {
        observation: {
          id: "observation-1",
          kind: "test.run",
          status: "failed",
          title: "Run tests",
          subject: { providerCallId: "call-1" },
          exitCode: 1,
        },
        error: "test result: FAILED",
      }),
      event(4, "turn.completed", CODEX_SOURCE, "turn-1", {}),
    ];

    const projection = projectConversation("session-1", events);
    const turn = projection.turns[0];
    assert.ok(turn);
    assert.equal(turn.status, "completed");
    assert.equal(turn.failedItemCount, 1);
    assert.equal(turn.items.length, 1);
    assert.equal(turn.items[0]?.content.kind, "observation");
    assert.equal(turn.items[0]?.status, "failed");
  });

  test("does not regress terminal history when a live replay starts the same lifecycle again", () => {
    const events: RahEvent[] = [
      event(1, "turn.started", CODEX_SOURCE, "turn-1", {}),
      event(2, "observation.completed", CODEX_SOURCE, "turn-1", {
        observation: {
          id: "obs-call-1",
          kind: "command.run",
          status: "completed",
          title: "Run command",
          subject: { providerCallId: "call-1" },
          exitCode: 0,
        },
      }),
      event(3, "turn.completed", CODEX_SOURCE, "turn-1", {}),
      event(4, "turn.started", CODEX_SOURCE, "turn-1", {}),
      event(5, "observation.started", CODEX_SOURCE, "turn-1", {
        observation: {
          id: "obs-call-1",
          kind: "command.run",
          status: "running",
          title: "Run command",
          subject: { providerCallId: "call-1" },
        },
      }),
    ];

    const projection = projectConversation("session-1", events);
    assert.equal(projection.turns[0]?.status, "completed");
    assert.equal(projection.turns[0]?.items[0]?.status, "completed");
    assert.equal(
      projection.turns[0]?.items[0]?.content.kind === "observation"
        ? projection.turns[0].items[0].content.observation.exitCode
        : undefined,
      0,
    );
  });

  test("settles open process items when their owning turn is interrupted", () => {
    const events: RahEvent[] = [
      event(1, "turn.started", CODEX_SOURCE, "turn-1", {}),
      event(2, "observation.started", CODEX_SOURCE, "turn-1", {
        observation: {
          id: "obs-call-1",
          kind: "command.run",
          status: "running",
          title: "Run command",
          subject: { providerCallId: "call-1" },
        },
      }),
      event(3, "turn.canceled", CODEX_SOURCE, "turn-1", {
        reason: "Interrupted by user",
      }),
    ];

    const turn = projectConversation("session-1", events).turns[0];
    assert.equal(turn?.status, "interrupted");
    assert.equal(turn?.items[0]?.status, "interrupted");
    assert.equal(turn?.items[0]?.completedAt, events[2]?.ts);
    assert.equal(turn?.failedItemCount, 0);
  });
});

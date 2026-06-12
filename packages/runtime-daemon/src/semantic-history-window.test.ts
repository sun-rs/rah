import assert from "node:assert/strict";
import { test } from "node:test";
import type { RahEvent } from "@rah/runtime-protocol";
import { selectSemanticRecentWindow } from "./semantic-history-window";

function timelineEvent(args: {
  seq: number;
  kind: "user_message" | "assistant_message";
  text: string;
  turnId?: string;
}): RahEvent {
  return {
    id: `event-${args.seq}`,
    seq: args.seq,
    ts: `2026-06-06T12:00:${String(args.seq).padStart(2, "0")}.000Z`,
    sessionId: "session-1",
    ...(args.turnId ? { turnId: args.turnId } : {}),
    type: "timeline.item.added",
    source: {
      provider: "codex",
      channel: "structured_persisted",
      authority: "authoritative",
    },
    payload: {
      item:
        args.kind === "user_message"
          ? { kind: "user_message", text: args.text }
          : { kind: "assistant_message", text: args.text },
    },
  };
}

test("semantic recent window keeps a hard event budget", () => {
  const events = [
    timelineEvent({ seq: 1, kind: "user_message", text: "older", turnId: "older" }),
    ...Array.from({ length: 12 }, (_, index) =>
      timelineEvent({
        seq: index + 2,
        kind: index === 0 ? "user_message" : "assistant_message",
        text: `recent-${index}`,
        turnId: "recent",
      }),
    ),
  ];

  const page = selectSemanticRecentWindow(events, 5);

  assert.equal(page.length, 5);
  assert.deepEqual(
    page.map((event) =>
      event.type === "timeline.item.added" &&
      (event.payload.item.kind === "user_message" ||
        event.payload.item.kind === "assistant_message")
        ? event.payload.item.text
        : "",
    ),
    ["recent-7", "recent-8", "recent-9", "recent-10", "recent-11"],
  );
});

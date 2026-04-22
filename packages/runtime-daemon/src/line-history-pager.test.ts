import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { RahEvent } from "@rah/runtime-protocol";
import { createLineFrozenHistoryPageLoader } from "./line-history-pager";

function historyEvent(text: string, seq: number): RahEvent {
  const second = String((seq % 60) + 1).padStart(2, "0");
  return {
    id: `event-${seq}`,
    seq,
    ts: `2025-07-19T22:21:${second}.000Z`,
    sessionId: "session-1",
    type: "timeline.item.added",
    source: {
      provider: "codex",
      channel: "structured_persisted",
      authority: "authoritative",
    },
    payload: {
      item: {
        kind: "assistant_message",
        text,
      },
    },
  };
}

describe("line history pager", () => {
  test("preserves excluded semantic-rewind prefix for the next older page", () => {
    const loader = createLineFrozenHistoryPageLoader({
      boundary: {
        kind: "frozen",
        sourceRevision: "rev-1",
      },
      snapshotEndOffset: 20,
      readWindow: ({ endOffset }) => {
        if (endOffset === 20) {
          return {
            startOffset: 10,
            events: ["older-a", "older-b", "recent-user", "recent-assistant"].map((text, index) =>
              historyEvent(text, index + 1),
            ),
          };
        }
        return {
          startOffset: 0,
          events: ["root-a", "root-b"].map((text, index) => historyEvent(text, index + 10)),
        };
      },
      selectPage: (events, limit) => {
        const naivePage = events.slice(Math.max(0, events.length - limit));
        const firstRecent = events.findIndex(
          (event) =>
            event.type === "timeline.item.added" &&
            event.payload.item.kind === "assistant_message" &&
            event.payload.item.text === "recent-user",
        );
        if (naivePage.length === 1 && firstRecent >= 0) {
          return events.slice(firstRecent);
        }
        return naivePage;
      },
    });

    const initial = loader.loadInitialPage(1);
    assert.deepEqual(
      initial.events.map((event) =>
        event.type === "timeline.item.added" && event.payload.item.kind === "assistant_message"
          ? event.payload.item.text
          : null,
      ),
      ["recent-user", "recent-assistant"],
    );
    assert.ok(initial.nextCursor);

    const older = loader.loadOlderPage(initial.nextCursor!, 2, initial.boundary);
    assert.deepEqual(
      older.events.map((event) =>
        event.type === "timeline.item.added" && event.payload.item.kind === "assistant_message"
          ? event.payload.item.text
          : null,
      ),
      ["older-a", "older-b"],
    );
  });

  test("reuses in-memory carry events before reading more raw windows", () => {
    const seenEndOffsets: number[] = [];
    const loader = createLineFrozenHistoryPageLoader({
      boundary: {
        kind: "frozen",
        sourceRevision: "rev-1",
      },
      snapshotEndOffset: 30,
      readWindow: ({ endOffset }) => {
        seenEndOffsets.push(endOffset);
        if (endOffset === 30) {
          return {
            startOffset: 20,
            events: ["a", "b", "c", "d"].map((text, index) => historyEvent(text, index + 1)),
          };
        }
        return {
          startOffset: 0,
          events: ["root"].map((text, index) => historyEvent(text, index + 10)),
        };
      },
      selectPage: (events, limit) => {
        if (events.length > limit) {
          return events.slice(events.length - limit - 1);
        }
        return [...events];
      },
    });

    const initial = loader.loadInitialPage(2);
    assert.ok(initial.nextCursor);
    const older = loader.loadOlderPage(initial.nextCursor!, 1, initial.boundary);
    assert.deepEqual(
      older.events.map((event) =>
        event.type === "timeline.item.added" && event.payload.item.kind === "assistant_message"
          ? event.payload.item.text
          : null,
      ),
      ["a"],
    );
    assert.deepEqual(seenEndOffsets, [30]);
  });
});

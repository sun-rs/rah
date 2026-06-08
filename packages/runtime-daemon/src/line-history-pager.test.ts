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

function userHistoryEvent(text: string, seq: number): RahEvent {
  const base = historyEvent(text, seq);
  if (base.type !== "timeline.item.added") {
    return base;
  }
  return {
    ...base,
    payload: {
      item: {
        kind: "user_message",
        text,
      },
    },
  };
}

function identifiedHistoryEvent(text: string, seq: number): RahEvent {
  const event = historyEvent(text, seq);
  if (event.type !== "timeline.item.added") {
    return event;
  }
  return {
    ...event,
    payload: {
      ...event.payload,
      identity: {
        canonicalItemId: `item-${seq}`,
        canonicalTurnId: "turn-1",
      } as never,
    },
  };
}

function toolEvent(seq: number): RahEvent {
  return {
    id: `tool-${seq}`,
    seq,
    ts: `2025-07-19T22:22:${String((seq % 60) + 1).padStart(2, "0")}.000Z`,
    sessionId: "session-1",
    type: "tool.call.completed",
    source: {
      provider: "codex",
      channel: "structured_persisted",
      authority: "authoritative",
    },
    payload: {
      toolCall: {
        id: `tool-${seq}`,
        family: "shell",
        providerToolName: "exec_command",
        title: "Run command",
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

  test("expands a full recent window until the selected page is stable", () => {
    const seenLineBudgets: number[] = [];
    const loader = createLineFrozenHistoryPageLoader({
      boundary: {
        kind: "frozen",
        sourceRevision: "rev-1",
      },
      snapshotEndOffset: 40,
      initialLineBudget: 1,
      maxLineBudget: 8,
      readWindow: ({ lineBudget }) => {
        seenLineBudgets.push(lineBudget);
        if (lineBudget < 4) {
          return {
            startOffset: 20,
            events: ["assistant-a", "assistant-b", "assistant-c"].map((text, index) =>
              historyEvent(text, index + 1),
            ),
          };
        }
        return {
          startOffset: 0,
          events: ["user", "assistant-a", "assistant-b", "assistant-c"].map((text, index) =>
            identifiedHistoryEvent(text, index + 1),
          ),
        };
      },
      isPageStable: (events) =>
        events.every(
          (event) =>
            event.type !== "timeline.item.added" ||
            typeof event.payload.identity?.canonicalItemId === "string",
        ),
    });

    const initial = loader.loadInitialPage(2);

    assert.deepEqual(seenLineBudgets, [1, 2, 4]);
    assert.deepEqual(
      initial.events.map((event) =>
        event.type === "timeline.item.added" && event.payload.item.kind === "assistant_message"
          ? event.payload.item.text
          : null,
      ),
      ["assistant-b", "assistant-c"],
    );
    assert.ok(
      initial.events.every(
        (event) =>
          event.type !== "timeline.item.added" ||
          typeof event.payload.identity?.canonicalItemId === "string",
      ),
    );
  });

  test("filters before paging so tool-heavy windows still return a full conversation page", () => {
    const loader = createLineFrozenHistoryPageLoader({
      boundary: {
        kind: "frozen",
        sourceRevision: "rev-1",
      },
      snapshotEndOffset: 40,
      initialLineBudget: 5,
      maxLineBudget: 20,
      readWindow: ({ endOffset }) => {
        if (endOffset === 40) {
          return {
            startOffset: 20,
            events: [
              historyEvent("one", 1),
              toolEvent(2),
              toolEvent(3),
              historyEvent("two", 4),
              toolEvent(5),
              historyEvent("three", 6),
            ],
          };
        }
        return {
          startOffset: 0,
          events: [historyEvent("zero", 0)],
        };
      },
    });

    const initial = loader.loadInitialPage(2, {
      eventFilter: (event) => event.type.startsWith("timeline."),
    });
    assert.deepEqual(
      initial.events.map((event) =>
        event.type === "timeline.item.added" && event.payload.item.kind === "assistant_message"
          ? event.payload.item.text
          : null,
      ),
      ["two", "three"],
    );
    assert.ok(initial.nextCursor);

    const older = loader.loadOlderPage(initial.nextCursor!, 2, initial.boundary, {
      eventFilter: (event) => event.type.startsWith("timeline."),
    });
    assert.deepEqual(
      older.events.map((event) =>
        event.type === "timeline.item.added" && event.payload.item.kind === "assistant_message"
          ? event.payload.item.text
          : null,
      ),
      ["zero", "one"],
    );
  });

  test("filtered paging still uses the provider semantic selector", () => {
    const loader = createLineFrozenHistoryPageLoader({
      boundary: {
        kind: "frozen",
        sourceRevision: "rev-1",
      },
      snapshotEndOffset: 20,
      initialLineBudget: 4,
      readWindow: () => ({
        startOffset: 0,
        events: [
          userHistoryEvent("question", 1),
          toolEvent(2),
          historyEvent("answer", 3),
        ],
      }),
      selectPage: (events, limit) => {
        const page = events.slice(Math.max(0, events.length - limit));
        const first = page[0];
        if (
          page.length === 1 &&
          first?.type === "timeline.item.added" &&
          first.payload.item.kind === "assistant_message"
        ) {
          return events.slice(Math.max(0, events.length - 2));
        }
        return page;
      },
    });

    const initial = loader.loadInitialPage(1, {
      eventFilter: (event) => event.type.startsWith("timeline."),
    });

    assert.deepEqual(
      initial.events.map((event) =>
        event.type === "timeline.item.added" ? event.payload.item.kind : null,
      ),
      ["user_message", "assistant_message"],
    );
  });
});

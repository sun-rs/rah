import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { RahEvent } from "@rah/runtime-protocol";
import { createLineHistoryWindowTranslator } from "./line-history-checkpoint";

function eventFor(text: string, seq: number): RahEvent {
  const second = String(seq).padStart(2, "0");
  return {
    id: `raw-${seq}`,
    seq,
    ts: `2025-07-19T22:21:${second}.000Z`,
    sessionId: "raw-session",
    type: "timeline.item.added",
    source: {
      provider: "claude",
      channel: "structured_persisted",
      authority: "authoritative",
    },
    payload: {
      item: {
        kind: text.startsWith("user") ? "user_message" : "assistant_message",
        text,
      },
    },
    ...(text.startsWith("user") || text.startsWith("assistant")
      ? { turnId: text.includes("2") ? "turn-2" : "turn-1" }
      : {}),
  };
}

describe("line history checkpoint", () => {
  test("reuses safe suffix translation when the same end offset expands", () => {
    const translatedInputs: string[][] = [];
    const translateWindow = createLineHistoryWindowTranslator({
      sessionId: "session-1",
      findSafeBoundaryIndex: (lines) => lines.findIndex((line) => line.startsWith("user:")),
      translateLines: (lines) => {
        translatedInputs.push([...lines]);
        return lines.map((line) => {
          const normalized = line.replace("user:", "user ").replace("assistant:", "assistant ");
          const seqMap: Record<string, number> = {
            "prefix:a": 1,
            "prefix:b": 2,
            "noise:older": 3,
            "user one": 4,
            "assistant one": 5,
          };
          return eventFor(normalized, seqMap[normalized] ?? 99);
        });
      },
    });

    const first = translateWindow(100, [
      "noise:older",
      "user:one",
      "assistant:one",
    ]);
    assert.deepEqual(
      first.map((event) =>
        event.type === "timeline.item.added" &&
        (event.payload.item.kind === "user_message" ||
          event.payload.item.kind === "assistant_message")
          ? event.payload.item.text
          : null,
      ),
      ["noise:older", "user one", "assistant one"],
    );

    const second = translateWindow(100, [
      "prefix:a",
      "prefix:b",
      "noise:older",
      "user:one",
      "assistant:one",
    ]);
    assert.deepEqual(
      translatedInputs,
      [
        ["noise:older", "user:one", "assistant:one"],
        ["prefix:a", "prefix:b", "noise:older"],
        ["user:one", "assistant:one"],
      ],
    );
    assert.deepEqual(
      second.map((event) =>
        event.type === "timeline.item.added" &&
        (event.payload.item.kind === "user_message" ||
          event.payload.item.kind === "assistant_message")
          ? event.payload.item.text
          : null,
      ),
      ["prefix:a", "prefix:b", "noise:older", "user one", "assistant one"],
    );
    const turnIds = second
      .map((event) => event.turnId)
      .filter((value): value is string => value !== undefined);
    assert.equal(new Set(turnIds).size, 1);
  });
});

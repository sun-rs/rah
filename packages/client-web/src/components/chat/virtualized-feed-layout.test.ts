import { describe, expect, test } from "bun:test";
import type { FeedEntry } from "../../types";
import {
  buildVirtualFeedLayout,
  resolveVirtualFeedWindow,
} from "./virtualized-feed-layout";

function messageEntry(key: string, text: string): FeedEntry {
  return {
    key,
    kind: "timeline",
    item: {
      kind: "assistant_message",
      text,
    },
    ts: "2026-04-22T00:00:00.000Z",
  };
}

describe("virtualized feed layout", () => {
  test("prefers measured heights while preserving cumulative offsets", () => {
    const entries = [
      messageEntry("a", "short"),
      messageEntry("b", "short"),
      messageEntry("c", "short"),
    ];
    const layout = buildVirtualFeedLayout(
      entries,
      new Map([
        ["a", 80],
        ["b", 120],
      ]),
    );

    expect(layout.rows.map((row) => ({ key: row.key, height: row.height, offsetTop: row.offsetTop }))).toEqual([
      { key: "a", height: 80, offsetTop: 0 },
      { key: "b", height: 120, offsetTop: 80 },
      { key: "c", height: layout.rows[2]!.height, offsetTop: 200 },
    ]);
    expect(layout.totalHeight).toBe(layout.rows[2]!.offsetTop + layout.rows[2]!.height);
  });

  test("derives a stable rendered window with overscan spacers", () => {
    const entries = Array.from({ length: 20 }, (_, index) =>
      messageEntry(`entry-${index}`, `message ${index}`),
    );
    const measuredHeights = new Map(entries.map((entry) => [entry.key, 100] as const));
    const layout = buildVirtualFeedLayout(entries, measuredHeights);

    const window = resolveVirtualFeedWindow({
      layout,
      scrollTop: 450,
      viewportHeight: 300,
      overscan: 2,
    });

    expect(window).toEqual({
      startIndex: 2,
      endIndex: 10,
      topSpacerHeight: 200,
      bottomSpacerHeight: 1000,
    });
  });
});

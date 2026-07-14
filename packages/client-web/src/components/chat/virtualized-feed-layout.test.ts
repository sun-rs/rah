import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { FeedEntry } from "../../types";
import {
  buildVirtualFeedLayout,
  projectVirtualAnchorScrollTop,
  resolveVirtualFeedWindow,
  VIRTUAL_FEED_ROW_GAP_PX,
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
  test("prefers measured content heights while preserving cumulative offsets with row gaps", () => {
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

    assert.deepEqual(
      layout.rows.map((row) => ({ key: row.key, height: row.height, offsetTop: row.offsetTop })),
      [
        { key: "a", height: 80 + VIRTUAL_FEED_ROW_GAP_PX, offsetTop: 0 },
        {
          key: "b",
          height: 120 + VIRTUAL_FEED_ROW_GAP_PX,
          offsetTop: 80 + VIRTUAL_FEED_ROW_GAP_PX,
        },
        {
          key: "c",
          height: layout.rows[2]!.height,
          offsetTop: 200 + VIRTUAL_FEED_ROW_GAP_PX * 2,
        },
      ],
    );
    assert.equal(layout.totalHeight, layout.rows[2]!.offsetTop + layout.rows[2]!.height);
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

    assert.deepEqual(window, {
      startIndex: 1,
      endIndex: 9,
      topSpacerHeight: 120,
      bottomSpacerHeight: 1300,
    });
  });

  test("uses custom row gaps in cumulative offsets", () => {
    const entries = [
      messageEntry("a", "short"),
      messageEntry("b", "short"),
      messageEntry("c", "short"),
    ];
    const measuredHeights = new Map(entries.map((entry) => [entry.key, 100] as const));
    const layout = buildVirtualFeedLayout(entries, measuredHeights, (_entry, index) =>
      index === 0 ? 8 : VIRTUAL_FEED_ROW_GAP_PX,
    );

    assert.deepEqual(
      layout.rows.map((row) => ({ key: row.key, height: row.height, offsetTop: row.offsetTop })),
      [
        { key: "a", height: 108, offsetTop: 0 },
        { key: "b", height: 120, offsetTop: 108 },
        { key: "c", height: 100, offsetTop: 228 },
      ],
    );
    assert.equal(layout.totalHeight, 328);
  });

  test("projects a prepended anchor into the next virtual window before DOM alignment", () => {
    const entries = Array.from({ length: 12 }, (_, index) =>
      messageEntry(`entry-${index}`, `message ${index}`),
    );
    const layout = buildVirtualFeedLayout(
      entries,
      new Map(entries.map((entry) => [entry.key, 100] as const)),
    );

    const projectedScrollTop = projectVirtualAnchorScrollTop({
      layout,
      entryKey: "entry-8",
      viewportOffset: 40,
      contentTopOffset: 24,
    });

    assert.equal(projectedScrollTop, 944);
    const window = resolveVirtualFeedWindow({
      layout,
      scrollTop: projectedScrollTop!,
      viewportHeight: 300,
      overscan: 1,
    });
    assert.ok(window.startIndex <= 8);
    assert.ok(window.endIndex > 8);
  });

  test("does not project an anchor that is absent from the loaded page", () => {
    const entries = [messageEntry("entry-0", "message")];
    const layout = buildVirtualFeedLayout(entries, new Map());
    assert.equal(
      projectVirtualAnchorScrollTop({
        layout,
        entryKey: "missing",
        viewportOffset: 0,
        contentTopOffset: 0,
      }),
      null,
    );
  });

  test("does not collapse an unmeasured long reply into a short placeholder", () => {
    const entry = messageEntry("long", "x".repeat(8_000));
    const layout = buildVirtualFeedLayout([entry], new Map());

    assert.ok(layout.rows[0]!.height > 3_000);
  });
});

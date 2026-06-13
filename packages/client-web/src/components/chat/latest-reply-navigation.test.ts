import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { FeedEntry } from "../../types";
import { buildVirtualFeedLayout } from "./virtualized-feed-layout";
import { resolveLatestReplyStartTarget } from "./latest-reply-navigation";

function assistantEntry(key: string): FeedEntry {
  return {
    key,
    kind: "timeline",
    item: { kind: "assistant_message", text: key },
    ts: "2026-06-13T00:00:00.000Z",
  };
}

function userEntry(key: string): FeedEntry {
  return {
    key,
    kind: "timeline",
    item: { kind: "user_message", text: key },
    ts: "2026-06-13T00:00:00.000Z",
  };
}

describe("latest reply navigation", () => {
  test("does not target short latest replies", () => {
    const entries = [userEntry("question"), assistantEntry("answer")];
    const layout = buildVirtualFeedLayout(entries, new Map([["answer", 120]]));

    assert.equal(
      resolveLatestReplyStartTarget({
        entries,
        layout,
        measuredHeights: new Map([["answer", 120]]),
        scrollTop: 200,
        viewportHeight: 240,
      }),
      null,
    );
  });

  test("targets the latest long assistant reply when the reader is below its top", () => {
    const entries = [userEntry("question"), assistantEntry("answer")];
    const measuredHeights = new Map([
      ["question", 80],
      ["answer", 520],
    ]);
    const layout = buildVirtualFeedLayout(entries, measuredHeights);

    const target = resolveLatestReplyStartTarget({
      entries,
      layout,
      measuredHeights,
      scrollTop: 500,
      viewportHeight: 220,
      contentTopOffset: 12,
    });

    assert.equal(target?.entryKey, "answer");
    assert.equal(target?.replyHeight, 520);
    assert.equal(target?.targetScrollTop, layout.rows[1]!.offsetTop + 12);
  });

  test("targets a latest reply that barely exceeds the visible chat viewport", () => {
    const entries = [userEntry("question"), assistantEntry("answer")];
    const measuredHeights = new Map([
      ["question", 80],
      ["answer", 430],
    ]);
    const layout = buildVirtualFeedLayout(entries, measuredHeights);

    const target = resolveLatestReplyStartTarget({
      entries,
      layout,
      measuredHeights,
      scrollTop: layout.rows[1]!.offsetTop + 28,
      viewportHeight: 440,
    });

    assert.equal(target?.entryKey, "answer");
  });

  test("does not target a latest reply that fits inside the visible chat viewport", () => {
    const entries = [userEntry("question"), assistantEntry("answer")];
    const measuredHeights = new Map([
      ["question", 80],
      ["answer", 400],
    ]);
    const layout = buildVirtualFeedLayout(entries, measuredHeights);

    assert.equal(
      resolveLatestReplyStartTarget({
        entries,
        layout,
        measuredHeights,
        scrollTop: layout.rows[1]!.offsetTop + 28,
        viewportHeight: 440,
      }),
      null,
    );
  });

  test("does not target an older long reply after a newer short reply arrives", () => {
    const entries = [
      userEntry("question"),
      assistantEntry("long-answer"),
      userEntry("follow-up"),
      assistantEntry("short-answer"),
    ];
    const measuredHeights = new Map([
      ["question", 80],
      ["long-answer", 520],
      ["follow-up", 80],
      ["short-answer", 80],
    ]);
    const layout = buildVirtualFeedLayout(entries, measuredHeights);

    assert.equal(
      resolveLatestReplyStartTarget({
        entries,
        layout,
        measuredHeights,
        scrollTop: 740,
        viewportHeight: 220,
      }),
      null,
    );
  });

  test("hides the target once the latest long reply top is already visible", () => {
    const entries = [userEntry("question"), assistantEntry("answer")];
    const measuredHeights = new Map([
      ["question", 80],
      ["answer", 520],
    ]);
    const layout = buildVirtualFeedLayout(entries, measuredHeights);
    const targetScrollTop = layout.rows[1]!.offsetTop;

    assert.equal(
      resolveLatestReplyStartTarget({
        entries,
        layout,
        measuredHeights,
        scrollTop: targetScrollTop + 12,
        viewportHeight: 220,
      }),
      null,
    );
  });
});

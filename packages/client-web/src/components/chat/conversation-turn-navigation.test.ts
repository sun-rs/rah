import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import type { FeedEntry } from "../../types";
import {
  buildConversationTurnNavigationItems,
  visibleConversationTurnKeys,
} from "./conversation-turn-navigation";
import { buildVirtualFeedLayout } from "./virtualized-feed-layout";

function userEntry(key: string, text = key): FeedEntry {
  return {
    key,
    kind: "timeline",
    item: { kind: "user_message", text },
    ts: "2026-07-10T00:00:00.000Z",
  };
}

function assistantEntry(
  key: string,
  text: string,
  phase?: "commentary" | "final_answer",
): FeedEntry {
  return {
    key,
    kind: "timeline",
    item: { kind: "assistant_message", text, ...(phase ? { phase } : {}) },
    ts: "2026-07-10T00:00:01.000Z",
  };
}

describe("conversation turn navigation", () => {
  test("keeps the compact navigator visible without hover or fine-pointer requirements", () => {
    const styles = readFileSync(new URL("../../styles.css", import.meta.url), "utf8");

    assert.match(styles, /\.chat-turn-navigator\s*{\s*display:\s*block;/);
    assert.doesNotMatch(styles, /\.chat-turn-navigator\s*{\s*display:\s*none;/);
    assert.match(styles, /\.chat-thread-scroll-container\s*{\s*padding-left:\s*2\.25rem/);
    assert.match(styles, /\.chat-turn-navigator-preview\s*{\s*display:\s*none;/);
  });

  test("builds one navigation item per visible user turn and prefers final answers", () => {
    const entries = [
      userEntry("q1", "First question"),
      assistantEntry("work", "Checking the repository", "commentary"),
      assistantEntry("a1", "First final answer", "final_answer"),
      userEntry("q2", "Second question"),
      assistantEntry("a2", "Second answer"),
    ];
    const layout = buildVirtualFeedLayout(entries, new Map(entries.map((entry) => [entry.key, 100])));
    const items = buildConversationTurnNavigationItems(entries, layout);

    assert.equal(items.length, 2);
    assert.equal(items[0]?.userPreview, "First question");
    assert.equal(items[0]?.assistantPreview, "First final answer");
    assert.equal(items[0]?.startOffset, layout.rows[0]?.offsetTop);
    assert.equal(items[0]?.endOffset, layout.rows[3]?.offsetTop);
    assert.equal(items[1]?.assistantPreview, "Second answer");
  });

  test("does not treat internal reminders as conversation turns", () => {
    const entries = [
      userEntry("q1"),
      userEntry(
        "reminder",
        "<system-reminder>[BACKGROUND TASK COMPLETED] internal state</system-reminder>",
      ),
      assistantEntry("a1", "Answer", "final_answer"),
    ];
    const layout = buildVirtualFeedLayout(entries, new Map());

    assert.deepEqual(
      buildConversationTurnNavigationItems(entries, layout).map((item) => item.userEntryKey),
      ["q1"],
    );
  });

  test("keeps the explicit final answer when commentary arrives later", () => {
    const entries = [
      userEntry("q1"),
      assistantEntry("a1", "Canonical final", "final_answer"),
      assistantEntry("late-work", "Late process echo", "commentary"),
    ];
    const layout = buildVirtualFeedLayout(entries, new Map());

    assert.equal(
      buildConversationTurnNavigationItems(entries, layout)[0]?.assistantPreview,
      "Canonical final",
    );
  });

  test("extracts compact file labels without retaining full paths", () => {
    const entries: FeedEntry[] = [
      userEntry("q1"),
      {
        key: "tool",
        kind: "tool_call",
        toolCall: {
          id: "tool",
          family: "file_edit",
          providerToolName: "apply_patch",
          detail: {
            artifacts: [
              { kind: "file_refs", files: ["/Users/sun/Code/rah/App.tsx", "/tmp/Store.ts"] },
            ],
          },
        },
        status: "completed",
        ts: "2026-07-10T00:00:01.000Z",
      },
    ];
    const layout = buildVirtualFeedLayout(entries, new Map());

    assert.deepEqual(buildConversationTurnNavigationItems(entries, layout)[0]?.fileNames, [
      "App.tsx",
      "Store.ts",
    ]);
  });

  test("marks every turn intersecting the current viewport as visible", () => {
    const entries = [
      userEntry("q1"),
      assistantEntry("a1", "Answer one"),
      userEntry("q2"),
      assistantEntry("a2", "Answer two"),
      userEntry("q3"),
      assistantEntry("a3", "Answer three"),
    ];
    const measured = new Map(entries.map((entry) => [entry.key, 100]));
    const layout = buildVirtualFeedLayout(entries, measured);
    const items = buildConversationTurnNavigationItems(entries, layout);
    const active = visibleConversationTurnKeys({
      items,
      scrollTop: items[0]!.endOffset - 30,
      viewportHeight: 80,
    });

    assert.deepEqual([...active], [items[0]!.key, items[1]!.key]);
  });

  test("accounts for the feed content offset inside the scroll container", () => {
    const entries = [userEntry("q1"), assistantEntry("a1", "Answer")];
    const layout = buildVirtualFeedLayout(entries, new Map());
    const items = buildConversationTurnNavigationItems(entries, layout);

    assert.deepEqual(
      [...visibleConversationTurnKeys({
        items,
        scrollTop: 20,
        viewportHeight: 100,
        contentTopOffset: 20,
      })],
      [items[0]!.key],
    );
  });

  test("uses the complete directory while only marking loaded turns as visible", () => {
    const loadedUser: FeedEntry = {
      ...userEntry("q3", "Third question"),
      turnId: "turn-3",
      providerTurnId: "turn-3",
    };
    const entries = [loadedUser, assistantEntry("a3", "Third answer", "final_answer")];
    const layout = buildVirtualFeedLayout(entries, new Map());
    const items = buildConversationTurnNavigationItems(entries, layout, [
      {
        id: "turn-1",
        ordinal: 0,
        userPreview: "First question",
        assistantPreview: "First answer",
        startedAt: "2026-07-10T00:00:00.000Z",
        status: "completed",
      },
      {
        id: "turn-2",
        ordinal: 1,
        userPreview: "Second question",
        startedAt: "2026-07-10T00:01:00.000Z",
        status: "interrupted",
      },
      {
        id: "turn-3",
        ordinal: 2,
        userPreview: "Third question",
        assistantPreview: "Third answer",
        startedAt: "2026-07-10T00:02:00.000Z",
        status: "completed",
      },
    ]);

    assert.equal(items.length, 3);
    assert.equal(items[0]?.userEntryKey, undefined);
    assert.equal(items[1]?.startOffset, undefined);
    assert.equal(items[2]?.userEntryKey, "q3");
    assert.deepEqual(
      [...visibleConversationTurnKeys({ items, scrollTop: 0, viewportHeight: 1_000 })],
      ["conversation-turn:turn-3"],
    );
  });
});

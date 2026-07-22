import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import type { FeedEntry } from "../../types";
import {
  buildConversationTurnNavigationItems,
  conversationTurnIndexAtScrollableRailPosition,
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
  test("keeps the navigator on browser surfaces and disables it in PWA mode", () => {
    const chatThread = readFileSync(new URL("./ChatThread.tsx", import.meta.url), "utf8");
    const styles = readFileSync(new URL("../../styles.css", import.meta.url), "utf8");

    assert.match(styles, /\.chat-turn-navigator\s*{\s*display:\s*flex;/);
    assert.doesNotMatch(styles, /\.chat-turn-navigator\s*{\s*display:\s*none;/);
    assert.match(styles, /\.chat-thread-scroll-container\s*{\s*padding-left:\s*2rem/);
    assert.match(chatThread, /const isPwaDisplayMode = usePwaDisplayMode\(\)/);
    assert.match(chatThread, /data-turn-navigation=\{isPwaDisplayMode \? "hidden" : "visible"\}/);
    assert.match(chatThread, /\{!isPwaDisplayMode \? \(/);
    assert.match(
      styles,
      /\.chat-thread-shell\[data-turn-navigation="hidden"\] \.chat-thread-scroll-container/,
    );
    assert.match(styles, /\.chat-turn-navigator-preview\s*{\s*display:\s*none;/);
  });

  test("uses an exact scrollable marker row for every directory turn", () => {
    const component = readFileSync(
      new URL("./ConversationTurnNavigator.tsx", import.meta.url),
      "utf8",
    );
    const styles = readFileSync(new URL("../../styles.css", import.meta.url), "utf8");

    assert.doesNotMatch(component, /<canvas\b/);
    assert.doesNotMatch(component, /<svg\b/);
    assert.match(component, /conversationTurnIndexAtScrollableRailPosition/);
    assert.match(component, /props\.items\.map/);
    assert.match(component, /MIN_NAVIGATION_TURNS = 1/);
    assert.match(component, /setPointerCapture\(event\.pointerId\)/);
    assert.match(component, /ensureIndexVisible\(index\)/);
    assert.doesNotMatch(component, /scrollIntoView/);
    assert.doesNotMatch(component, /onClick=\{\(event\).*props\.onNavigate/s);
    assert.match(styles, /\.chat-turn-navigator-list\s*{/);
    assert.match(styles, /max-height:\s*min\(70vh, 40rem/);
    assert.match(styles, /overflow-y:\s*auto/);
    assert.match(styles, /\.chat-turn-navigator-row/);
    assert.doesNotMatch(styles, /\.chat-turn-navigator-svg/);
  });

  test("keeps the dormant navigator subtle and expands markers only around interaction", () => {
    const component = readFileSync(
      new URL("./ConversationTurnNavigator.tsx", import.meta.url),
      "utf8",
    );
    const styles = readFileSync(new URL("../../styles.css", import.meta.url), "utf8");

    assert.match(component, /if \(interactionDistance === 0\) return 24/);
    assert.match(component, /if \(interactionDistance === 1\) return 15/);
    assert.match(component, /return 5/);
    assert.doesNotMatch(component, /index === activeIndex/);
    assert.match(styles, /\.chat-turn-navigator-marker\s*\{[^}]*height:\s*1px/s);
    assert.match(styles, /\.chat-turn-navigator-marker\s*\{[^}]*opacity:\s*0\.22/s);
    assert.match(
      styles,
      /\.chat-turn-navigator-marker\[data-active="true"\]\s*\{[^}]*background:\s*var\(--app-hint\)[^}]*opacity:\s*0\.36/s,
    );
    assert.match(component, /const previewItem = interactionIndex === null \? undefined/);
    assert.match(component, /\{previewItem \? \([\s\S]*chat-turn-navigator-preview/);
  });

  test("maps the visible rail and its scroll position to the exact turn", () => {
    assert.equal(conversationTurnIndexAtScrollableRailPosition(1_586, 0, 0, 10), 0);
    assert.equal(conversationTurnIndexAtScrollableRailPosition(1_586, 300, 0, 10), 30);
    assert.equal(conversationTurnIndexAtScrollableRailPosition(1_586, 300, 500, 10), 80);
    assert.equal(conversationTurnIndexAtScrollableRailPosition(1_586, 10_000, 10_000, 10), 1_585);
    assert.equal(conversationTurnIndexAtScrollableRailPosition(0, 0, 0, 10), -1);
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

  test("does not infer output files from rendered tool artifacts", () => {
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

    assert.deepEqual(buildConversationTurnNavigationItems(entries, layout)[0]?.fileNames, []);
  });

  test("uses canonical turn outputs for file labels", () => {
    const entries: FeedEntry[] = [
      {
        ...userEntry("q1"),
        providerTurnId: "provider-turn-1",
      },
      {
        key: "tool",
        kind: "tool_call",
        toolCall: {
          id: "tool",
          family: "file_edit",
          providerToolName: "apply_patch",
          detail: {
            artifacts: [{ kind: "file_refs", files: ["/tmp/legacy.ts"] }],
          },
        },
        status: "completed",
        ts: "2026-07-10T00:00:01.000Z",
      },
    ];
    const layout = buildVirtualFeedLayout(entries, new Map());
    const items = buildConversationTurnNavigationItems(entries, layout, [], [
      {
        id: "canonical-turn-1",
        provider: "codex",
        providerTurnId: "provider-turn-1",
        status: "completed",
        statusAuthority: "native",
        items: [],
        activities: [],
        outputs: [
          {
            id: "output-report",
            kind: "file",
            label: "report.md",
            path: "/workspace/report.md",
            activity: "written",
            confidence: "authoritative",
            sourceItemIds: ["tool"],
          },
        ],
        failedItemCount: 0,
        revision: 1,
      },
    ]);

    assert.deepEqual(items[0]?.fileNames, ["report.md"]);
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

  test("anchors a loaded turn to its process row when no visible user row exists", () => {
    const layout = buildVirtualFeedLayout(
      [
        { key: "conversation-process:turn-hidden-user" },
        { key: "conversation:final-hidden-user" },
      ],
      new Map(),
      undefined,
      () => 100,
    );
    const items = buildConversationTurnNavigationItems(
      [],
      layout,
      [
        {
          id: "provider-turn-hidden-user",
          ordinal: 0,
          userPreview: "Goal continuation",
          assistantPreview: "Completed goal work",
          startedAt: "2026-07-10T00:00:00.000Z",
          status: "completed",
        },
      ],
      [
        {
          id: "turn-hidden-user",
          provider: "codex",
          providerTurnId: "provider-turn-hidden-user",
          status: "completed",
          statusAuthority: "native",
          items: [
            {
              id: "process-hidden-user",
              role: "process",
              status: "completed",
              source: { provider: "codex", origin: "native" },
              content: {
                kind: "timeline",
                item: { kind: "assistant_message", text: "Working" },
              },
            },
            {
              id: "final-hidden-user",
              role: "final",
              status: "completed",
              source: { provider: "codex", origin: "native" },
              content: {
                kind: "timeline",
                item: { kind: "assistant_message", text: "Completed goal work" },
              },
            },
          ],
          failedItemCount: 0,
          revision: 1,
        },
      ],
    );

    assert.equal(items[0]?.anchorEntryKey, "conversation-process:turn-hidden-user");
    assert.equal(items[0]?.startOffset, 0);
    assert.equal(items[0]?.endOffset, layout.totalHeight);
  });
});

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { FeedEntry } from "../../types";
import { buildVirtualFeedLayout } from "./virtualized-feed-layout";
import {
  advanceLatestReplyAutoNavigationState,
  createLatestReplyAutoNavigationState,
  latestNavigableAssistantReplyKeyAtOrAfter,
  latestNavigableAssistantReplyKey,
  latestVisibleUserMessageKey,
  resolveLatestReplyStartTarget,
  resolveRequestedReplyStartTarget,
  resolveReplyStartTarget,
  suspendLatestReplyAutoNavigationState,
} from "./latest-reply-navigation";
import type { ChatDisplayRow } from "./assistant-process-groups";

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

function reasoningEntry(key: string): FeedEntry {
  return {
    key,
    kind: "timeline",
    item: { kind: "reasoning", text: key },
    ts: "2026-06-13T00:00:00.000Z",
  };
}

describe("latest reply navigation", () => {
  test("arms on live work and targets a canonical final before the runtime becomes idle", () => {
    let state = createLatestReplyAutoNavigationState({
      latestUserKey: "older-question",
      latestReplyKey: null,
      generationActive: false,
    });

    state = advanceLatestReplyAutoNavigationState(state, {
      latestUserKey: "optimistic:user:question",
      latestReplyKey: null,
      generationActive: true,
    });

    state = advanceLatestReplyAutoNavigationState(state, {
      latestUserKey: "optimistic:user:question",
      latestReplyKey: "answer",
      generationActive: true,
    });

    assert.equal(state.pendingReplyKey, "answer");
    assert.equal(state.armed, false);
  });

  test("waits for the final answer to become latest when another prompt is queued", () => {
    let state = createLatestReplyAutoNavigationState({
      latestUserKey: "question-1",
      latestReplyKey: null,
      generationActive: true,
    });
    state = advanceLatestReplyAutoNavigationState(state, {
      latestUserKey: "optimistic:user:question-2",
      latestReplyKey: null,
      generationActive: true,
    });
    assert.equal(state.pendingReplyKey, null);

    state = advanceLatestReplyAutoNavigationState(state, {
      latestUserKey: "optimistic:user:question-2",
      latestReplyKey: "answer-2",
      generationActive: true,
    });
    assert.equal(state.pendingReplyKey, "answer-2");
  });

  test("does not arm merely because the reader opens an already-running session", () => {
    let state = createLatestReplyAutoNavigationState({
      latestUserKey: "question",
      latestReplyKey: null,
      generationActive: true,
    });

    state = advanceLatestReplyAutoNavigationState(state, {
      latestUserKey: "question",
      latestReplyKey: "answer",
      generationActive: true,
    });

    assert.equal(state.pendingReplyKey, null);
    assert.equal(state.armed, false);
  });

  test("foreground catch-up cannot arm from a stale runtime-status transition alone", () => {
    let state = createLatestReplyAutoNavigationState({
      latestUserKey: "question",
      latestReplyKey: null,
      generationActive: false,
    });

    state = advanceLatestReplyAutoNavigationState(state, {
      latestUserKey: "question",
      latestReplyKey: null,
      generationActive: true,
    });
    state = advanceLatestReplyAutoNavigationState(state, {
      latestUserKey: "question",
      latestReplyKey: "background-answer",
      generationActive: false,
    });

    assert.equal(state.pendingReplyKey, null);
    assert.equal(state.armed, false);
  });

  test("foreground history hydration cannot arm from a newly discovered canonical user", () => {
    let state = createLatestReplyAutoNavigationState({
      latestUserKey: "older-question",
      latestReplyKey: null,
      generationActive: false,
    });

    state = advanceLatestReplyAutoNavigationState(state, {
      latestUserKey: "background-question",
      latestReplyKey: null,
      generationActive: true,
    });
    state = advanceLatestReplyAutoNavigationState(state, {
      latestUserKey: "background-question",
      latestReplyKey: "background-answer",
      generationActive: false,
    });

    assert.equal(state.pendingReplyKey, null);
    assert.equal(state.armed, false);
  });

  test("canonical handoff preserves a locally submitted optimistic turn lease", () => {
    let state = createLatestReplyAutoNavigationState({
      latestUserKey: "older-question",
      latestReplyKey: null,
      generationActive: false,
    });

    state = advanceLatestReplyAutoNavigationState(state, {
      latestUserKey: "optimistic:user:local-question",
      latestReplyKey: null,
      generationActive: true,
    });
    state = advanceLatestReplyAutoNavigationState(state, {
      latestUserKey: "canonical:user:local-question",
      latestReplyKey: null,
      generationActive: true,
    });
    state = advanceLatestReplyAutoNavigationState(state, {
      latestUserKey: "canonical:user:local-question",
      latestReplyKey: "canonical:answer",
      generationActive: false,
    });

    assert.equal(state.pendingReplyKey, "canonical:answer");
    assert.equal(state.armed, false);
  });

  test("window or page departure cancels a pending automatic reply-start jump", () => {
    const state = suspendLatestReplyAutoNavigationState({
      latestUserKey: "question",
      latestReplyKey: "answer",
      generationActive: true,
      armed: true,
      pendingReplyKey: "answer",
    });

    assert.equal(state.pendingReplyKey, null);
    assert.equal(state.armed, false);
  });

  test("a final arriving while the reader is away cannot jump on return", () => {
    let state = createLatestReplyAutoNavigationState({
      latestUserKey: "older-question",
      latestReplyKey: null,
      generationActive: false,
    });

    state = advanceLatestReplyAutoNavigationState(state, {
      latestUserKey: "optimistic:user:question",
      latestReplyKey: null,
      generationActive: true,
    });
    assert.equal(state.armed, true);

    state = suspendLatestReplyAutoNavigationState(state);
    state = advanceLatestReplyAutoNavigationState(state, {
      latestUserKey: "optimistic:user:question",
      latestReplyKey: "long-answer",
      generationActive: false,
    });

    assert.equal(state.pendingReplyKey, null);
    assert.equal(state.armed, false);

    state = advanceLatestReplyAutoNavigationState(state, {
      latestUserKey: "optimistic:user:question",
      latestReplyKey: "long-answer",
      generationActive: false,
    });
    assert.equal(state.pendingReplyKey, null);
  });

  test("a reader gesture spends the current turn ticket permanently", () => {
    let state = createLatestReplyAutoNavigationState({
      latestUserKey: "older-question",
      latestReplyKey: null,
      generationActive: false,
    });

    state = advanceLatestReplyAutoNavigationState(state, {
      latestUserKey: "optimistic:user:question",
      latestReplyKey: null,
      generationActive: true,
    });
    assert.equal(state.armed, true);

    state = suspendLatestReplyAutoNavigationState(state);
    assert.equal(state.armed, false);

    // Re-rendering the same in-flight turn after the gesture must not issue a
    // second ticket, and its eventual final must not recenter the reader.
    state = advanceLatestReplyAutoNavigationState(state, {
      latestUserKey: "optimistic:user:question",
      latestReplyKey: null,
      generationActive: true,
    });
    state = advanceLatestReplyAutoNavigationState(state, {
      latestUserKey: "optimistic:user:question",
      latestReplyKey: "answer",
      generationActive: false,
    });

    assert.equal(state.armed, false);
    assert.equal(state.pendingReplyKey, null);
  });

  test("does not arm an already completed historical conversation", () => {
    const entries = [userEntry("question"), assistantEntry("answer")];
    const state = createLatestReplyAutoNavigationState({
      latestUserKey: latestVisibleUserMessageKey(entries),
      latestReplyKey: latestNavigableAssistantReplyKey(entries, new Set(["answer"])),
      generationActive: false,
    });

    assert.equal(state.armed, false);
    assert.equal(state.pendingReplyKey, null);
  });

  test("targets a short latest reply when trailing turn chrome moves its start above the viewport", () => {
    const entries = [userEntry("question"), assistantEntry("answer")];
    const measuredHeights = new Map([
      ["question", 80],
      ["answer", 120],
    ]);
    const layout = buildVirtualFeedLayout(entries, measuredHeights);

    const target = resolveLatestReplyStartTarget({
      entries,
      layout,
      scrollTop: layout.rows[1]!.offsetTop + 28,
      viewportHeight: 240,
    });

    assert.equal(target?.entryKey, "answer");
    assert.equal(target?.targetScrollTop, layout.rows[1]!.offsetTop);
  });

  test("explicit unread navigation resolves the frozen reply even from another viewport position", () => {
    const entries = [
      userEntry("question-1"),
      assistantEntry("answer-1"),
      userEntry("question-2"),
      assistantEntry("answer-2"),
    ];
    const layout = buildVirtualFeedLayout(
      entries,
      new Map(entries.map((entry) => [entry.key, 120])),
    );

    const target = resolveReplyStartTarget({
      entries,
      layout,
      entryKey: "answer-2",
      navigableAssistantKeys: new Set(["answer-1", "answer-2"]),
    });

    assert.equal(target?.entryKey, "answer-2");
    assert.equal(target?.targetScrollTop, layout.rows[3]!.offsetTop);
  });

  test("slow canonical replay cannot substitute an older reply for the unread target", () => {
    const entries = [assistantEntry("older"), assistantEntry("newer")];
    entries[0]!.ts = "2026-06-13T00:00:00.000Z";
    entries[1]!.ts = "2026-06-13T00:05:00.000Z";
    const navigableKeys = new Set(["older", "newer"]);

    assert.equal(
      latestNavigableAssistantReplyKeyAtOrAfter(
        entries.slice(0, 1),
        navigableKeys,
        Date.parse(entries[1]!.ts),
      ),
      null,
    );
    assert.equal(
      latestNavigableAssistantReplyKeyAtOrAfter(
        entries,
        navigableKeys,
        Date.parse(entries[1]!.ts),
      ),
      "newer",
    );
  });

  test("a completed turn waits for its own final row instead of taking an older reply", () => {
    const older = assistantEntry("older");
    older.turnId = "turn-old";
    older.ts = "2026-06-13T00:00:00.000Z";
    const newer = assistantEntry("newer");
    newer.turnId = "turn-new";
    newer.ts = "2026-06-13T00:05:00.000Z";
    const entries = [older, newer];
    const layout = buildVirtualFeedLayout(entries, new Map());
    const args = {
      layout,
      navigableAssistantKeys: new Set(["older", "newer"]),
      entryKey: null,
      turnId: "turn-new",
      minimumTimestampMs: Date.parse(newer.ts),
    };

    assert.equal(resolveRequestedReplyStartTarget({ ...args, entries: [older] }), null);
    assert.equal(resolveRequestedReplyStartTarget({ ...args, entries })?.entryKey, "newer");
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
      scrollTop: 500,
      viewportHeight: 220,
      contentTopOffset: 12,
    });

    assert.equal(target?.entryKey, "answer");
    assert.equal(target?.targetScrollTop, layout.rows[1]!.offsetTop + 12);
  });

  test("resolves the reply against display rows when turn chrome changes row indices", () => {
    const entries = [userEntry("question"), assistantEntry("answer")];
    const displayRows: ChatDisplayRow[] = [
      { kind: "feed_entry", key: "question", entry: entries[0]! },
      {
        kind: "assistant_process_group",
        key: "process",
        entries: [],
        completed: true,
        active: false,
        hasFinalAnswer: true,
        startedAt: "2026-06-13T00:00:00.000Z",
        activities: [],
      },
      { kind: "feed_entry", key: "answer", entry: entries[1]! },
      { kind: "turn_copy_action", key: "copy", content: "answer" },
    ];
    const measuredHeights = new Map([
      ["question", 80],
      ["process", 48],
      ["answer", 520],
      ["copy", 30],
    ]);
    const layout = buildVirtualFeedLayout(displayRows, measuredHeights);

    const target = resolveLatestReplyStartTarget({
      entries,
      displayRows,
      layout,
      scrollTop: 620,
      viewportHeight: 220,
    });

    assert.equal(target?.entryKey, "answer");
    assert.equal(target?.entryIndex, 1);
    assert.equal(target?.targetScrollTop, layout.rows[2]!.offsetTop);
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
      scrollTop: layout.rows[1]!.offsetTop + 28,
      viewportHeight: 440,
    });

    assert.equal(target?.entryKey, "answer");
  });

  test("uses reply-start occlusion rather than standalone reply height", () => {
    const entries = [userEntry("question"), assistantEntry("answer")];
    const measuredHeights = new Map([
      ["question", 80],
      ["answer", 400],
    ]);
    const layout = buildVirtualFeedLayout(entries, measuredHeights);

    const target = resolveLatestReplyStartTarget({
      entries,
      layout,
      scrollTop: layout.rows[1]!.offsetTop + 28,
      viewportHeight: 440,
    });

    assert.equal(target?.entryKey, "answer");
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
        scrollTop: layout.rows[3]!.offsetTop + 3,
        viewportHeight: 220,
      }),
      null,
    );
  });

  test("does not target a long reply after a newer user message arrives", () => {
    const entries = [
      userEntry("question"),
      assistantEntry("long-answer"),
      userEntry("new-question"),
    ];
    const measuredHeights = new Map([
      ["question", 80],
      ["long-answer", 520],
      ["new-question", 80],
    ]);
    const layout = buildVirtualFeedLayout(entries, measuredHeights);

    assert.equal(
      resolveLatestReplyStartTarget({
        entries,
        layout,
        scrollTop: 740,
        viewportHeight: 220,
      }),
      null,
    );
  });

  test("does not target process assistant messages excluded from final reply actions", () => {
    const entries = [
      userEntry("question"),
      assistantEntry("final-answer"),
      assistantEntry("process-update"),
    ];
    const measuredHeights = new Map([
      ["question", 80],
      ["final-answer", 120],
      ["process-update", 520],
    ]);
    const layout = buildVirtualFeedLayout(entries, measuredHeights);

    assert.equal(
      resolveLatestReplyStartTarget({
        entries,
        layout,
        scrollTop: 740,
        viewportHeight: 220,
        navigableAssistantKeys: new Set(["final-answer"]),
      }),
      null,
    );
  });

  test("ignores non-message entries after the latest long assistant reply", () => {
    const entries = [
      userEntry("question"),
      assistantEntry("answer"),
      reasoningEntry("reasoning-after-answer"),
    ];
    const measuredHeights = new Map([
      ["question", 80],
      ["answer", 520],
      ["reasoning-after-answer", 80],
    ]);
    const layout = buildVirtualFeedLayout(entries, measuredHeights);

    const target = resolveLatestReplyStartTarget({
      entries,
      layout,
      scrollTop: 660,
      viewportHeight: 220,
    });

    assert.equal(target?.entryKey, "answer");
  });

  test("ignores internal user reminders after the latest long assistant reply", () => {
    const entries = [
      userEntry("question"),
      assistantEntry("answer"),
      {
        ...userEntry("internal-reminder"),
        item: {
          kind: "user_message" as const,
          text: [
            "<system-reminder>",
            "[BACKGROUND TASK COMPLETED]",
            "Use `background_output(task_id=\"bg_1\")` to retrieve this result when ready.",
            "</system-reminder>",
            "<!-- OMO_INTERNAL_INITIATOR -->",
          ].join("\n"),
        },
      },
    ];
    const measuredHeights = new Map([
      ["question", 80],
      ["answer", 520],
      ["internal-reminder", 80],
    ]);
    const layout = buildVirtualFeedLayout(entries, measuredHeights);

    const target = resolveLatestReplyStartTarget({
      entries,
      layout,
      scrollTop: 660,
      viewportHeight: 220,
    });

    assert.equal(target?.entryKey, "answer");
  });

  test("hides the target while the latest reply top is within geometry tolerance", () => {
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
        scrollTop: targetScrollTop + 4,
        viewportHeight: 220,
      }),
      null,
    );
  });

  test("shows the target as soon as the latest reply top is genuinely occluded", () => {
    const entries = [userEntry("question"), assistantEntry("answer")];
    const measuredHeights = new Map([
      ["question", 80],
      ["answer", 120],
    ]);
    const layout = buildVirtualFeedLayout(entries, measuredHeights);
    const targetScrollTop = layout.rows[1]!.offsetTop;

    const target = resolveLatestReplyStartTarget({
      entries,
      layout,
      scrollTop: targetScrollTop + 5,
      viewportHeight: 220,
    });

    assert.equal(target?.entryKey, "answer");
  });
});

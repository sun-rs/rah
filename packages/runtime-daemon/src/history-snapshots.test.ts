import { test } from "node:test";
import assert from "node:assert/strict";
import type { RahEvent } from "@rah/runtime-protocol";
import {
  type FrozenHistoryBoundary,
  type FrozenHistoryPageLoader,
  HistorySnapshotStore,
} from "./history-snapshots";

const source = {
  provider: "codex" as const,
  channel: "structured_persisted" as const,
  authority: "authoritative" as const,
};

function timelineEvent(args: {
  id: string;
  seq: number;
  ts: string;
  sessionId?: string;
  canonicalItemId: string;
  text: string;
}): RahEvent {
  return {
    id: args.id,
    seq: args.seq,
    ts: args.ts,
    sessionId: args.sessionId ?? "source-session",
    type: "timeline.item.added",
    source,
    payload: {
      item: { kind: "assistant_message", text: args.text },
      identity: {
        canonicalItemId: args.canonicalItemId,
        canonicalTurnId: `turn:${args.canonicalItemId}`,
        provider: "codex",
        providerSessionId: "provider-session",
        turnKey: "turn:1",
        itemKind: "assistant_message",
        itemKey: args.canonicalItemId,
        origin: "history",
        confidence: "derived",
      },
    },
  };
}

function timelineText(event: RahEvent): string | null {
  if (event.type !== "timeline.item.added") {
    return null;
  }
  const item = event.payload.item;
  return "text" in item ? item.text : null;
}

test("history snapshots dedupe materialized pages by canonical timeline item id", () => {
  const store = new HistorySnapshotStore();
  const page = store.getPage({
    sessionId: "target-session",
    limit: 10,
    loadEvents: () => [
      timelineEvent({
        id: "one",
        seq: 1,
        ts: "2026-05-03T00:00:00.000Z",
        canonicalItemId: "same",
        text: "First copy",
      }),
      timelineEvent({
        id: "two",
        seq: 2,
        ts: "2026-05-03T00:00:01.000Z",
        canonicalItemId: "same",
        text: "Second copy",
      }),
      timelineEvent({
        id: "three",
        seq: 3,
        ts: "2026-05-03T00:00:02.000Z",
        canonicalItemId: "different",
        text: "Different item",
      }),
    ],
  });

  assert.deepEqual(
    page.events.map(timelineText),
    ["First copy", "Different item"],
  );
});

test("history snapshots dedupe frozen initial and older pages by canonical timeline item id", () => {
  const store = new HistorySnapshotStore();
  const boundary: FrozenHistoryBoundary = {
    kind: "frozen",
    sourceRevision: "revision-one",
  };
  const loader: FrozenHistoryPageLoader = {
    loadInitialPage: () => ({
      boundary,
      events: [
        timelineEvent({
          id: "initial-one",
          seq: 1,
          ts: "2026-05-03T00:00:00.000Z",
          canonicalItemId: "initial",
          text: "Initial copy",
        }),
        timelineEvent({
          id: "initial-two",
          seq: 2,
          ts: "2026-05-03T00:00:01.000Z",
          canonicalItemId: "initial",
          text: "Initial duplicate",
        }),
      ],
      nextCursor: "older",
    }),
    loadOlderPage: () => ({
      boundary,
      events: [
        timelineEvent({
          id: "older-one",
          seq: 3,
          ts: "2026-05-02T00:00:00.000Z",
          canonicalItemId: "older",
          text: "Older copy",
        }),
        timelineEvent({
          id: "older-two",
          seq: 4,
          ts: "2026-05-02T00:00:01.000Z",
          canonicalItemId: "older",
          text: "Older duplicate",
        }),
      ],
    }),
  };

  const initialPage = store.getPage({
    sessionId: "target-session",
    limit: 10,
    loadEvents: () => [],
    loadFrozenPage: () => loader,
  });
  const olderPage = store.getPage({
    sessionId: "target-session",
    cursor: "older",
    limit: 10,
    loadEvents: () => [],
    loadFrozenPage: () => loader,
  });

  assert.deepEqual(
    initialPage.events.map(timelineText),
    ["Initial copy"],
  );
  assert.deepEqual(
    olderPage.events.map(timelineText),
    ["Older copy"],
  );
});

test("history snapshots upgrade an early empty materialized page once provider frozen history appears", () => {
  const store = new HistorySnapshotStore();
  const firstPage = store.getPage({
    sessionId: "target-session",
    limit: 10,
    loadEvents: () => [],
    loadFrozenPage: () => undefined,
  });

  assert.deepEqual(firstPage.events, []);

  const boundary: FrozenHistoryBoundary = {
    kind: "frozen",
    sourceRevision: "revision-after-provider-file-appeared",
  };
  const loader: FrozenHistoryPageLoader = {
    loadInitialPage: () => ({
      boundary,
      events: [
        timelineEvent({
          id: "late-provider-event",
          seq: 1,
          ts: "2026-05-03T00:00:00.000Z",
          canonicalItemId: "late-provider-event",
          text: "Loaded after provider file appeared",
        }),
      ],
    }),
    loadOlderPage: () => ({
      boundary,
      events: [],
    }),
  };

  const upgradedPage = store.getPage({
    sessionId: "target-session",
    limit: 10,
    loadEvents: () => [],
    loadFrozenPage: () => loader,
  });

  assert.deepEqual(
    upgradedPage.events.map(timelineText),
    ["Loaded after provider file appeared"],
  );
  assert.equal(upgradedPage.nextCursor, undefined);
  assert.equal(upgradedPage.nextBeforeTs, undefined);
});

test("history snapshots only expose older history markers when an older page exists", () => {
  const materializedStore = new HistorySnapshotStore();
  const materializedOnlyPage = materializedStore.getPage({
    sessionId: "target-session",
    limit: 10,
    loadEvents: () => [
      timelineEvent({
        id: "only-materialized",
        seq: 1,
        ts: "2026-05-03T00:00:00.000Z",
        canonicalItemId: "only-materialized",
        text: "Only materialized item",
      }),
    ],
  });
  assert.equal(materializedOnlyPage.nextCursor, undefined);
  assert.equal(materializedOnlyPage.nextBeforeTs, undefined);

  const frozenStore = new HistorySnapshotStore();
  const boundary: FrozenHistoryBoundary = {
    kind: "frozen",
    sourceRevision: "single-page-frozen-revision",
  };
  const singlePageLoader: FrozenHistoryPageLoader = {
    loadInitialPage: () => ({
      boundary,
      events: [
        timelineEvent({
          id: "only-frozen",
          seq: 1,
          ts: "2026-05-03T00:00:00.000Z",
          canonicalItemId: "only-frozen",
          text: "Only frozen item",
        }),
      ],
    }),
    loadOlderPage: () => ({
      boundary,
      events: [],
    }),
  };
  const frozenOnlyPage = frozenStore.getPage({
    sessionId: "target-session",
    limit: 10,
    loadEvents: () => [],
    loadFrozenPage: () => singlePageLoader,
  });
  assert.equal(frozenOnlyPage.nextCursor, undefined);
  assert.equal(frozenOnlyPage.nextBeforeTs, undefined);

  const pagedStore = new HistorySnapshotStore();
  const pagedLoader: FrozenHistoryPageLoader = {
    loadInitialPage: () => ({
      boundary,
      events: [
        timelineEvent({
          id: "newer-frozen",
          seq: 2,
          ts: "2026-05-03T00:00:01.000Z",
          canonicalItemId: "newer-frozen",
          text: "Newer frozen item",
        }),
      ],
      nextCursor: "older",
    }),
    loadOlderPage: () => ({
      boundary,
      events: [
        timelineEvent({
          id: "older-frozen",
          seq: 1,
          ts: "2026-05-03T00:00:00.000Z",
          canonicalItemId: "older-frozen",
          text: "Older frozen item",
        }),
      ],
    }),
  };
  const pagedInitialPage = pagedStore.getPage({
    sessionId: "target-session",
    limit: 10,
    loadEvents: () => [],
    loadFrozenPage: () => pagedLoader,
  });
  assert.equal(pagedInitialPage.nextCursor, "older");
  assert.equal(pagedInitialPage.nextBeforeTs, "2026-05-03T00:00:01.000Z");
});

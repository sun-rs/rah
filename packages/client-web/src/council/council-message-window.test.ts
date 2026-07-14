import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { CouncilMessage, CouncilSnapshot, CouncilSummary } from "@rah/runtime-protocol";
import {
  councilNeedsLatestMessages,
  councilSnapshotFromSummary,
  mergeCouncilLists,
  mergeLatestCouncilMessagesPage,
  mergeCouncilMessageEvent,
} from "./council-message-window";

const timestamp = "2026-07-14T00:00:00.000Z";

function summary(overrides: Partial<CouncilSummary> = {}): CouncilSummary {
  return {
    id: "council-1",
    title: "Council 1",
    workspace: "/workspace/rah",
    status: "running",
    phase: "ready",
    agents: [],
    createdAt: timestamp,
    updatedAt: timestamp,
    meta: { messageCount: 3 },
    ...overrides,
  };
}

function message(id: number, text = `message-${id}`): CouncilMessage {
  return {
    id,
    councilId: "council-1",
    actorId: "agent-1",
    role: "agent",
    parts: [{ kind: "text", text }],
    createdAt: timestamp,
  };
}

describe("Council message windows", () => {
  test("keeps loaded messages while applying lightweight list summaries", () => {
    const current: CouncilSnapshot = {
      ...summary(),
      messages: [message(1), message(2), message(3)],
      messageWindow: { total: 3, loaded: 3, hasMoreBefore: false },
    };

    const [merged] = mergeCouncilLists([current], [
      summary({ title: "Renamed", updatedAt: "2026-07-14T00:01:00.000Z" }),
    ]);

    assert.equal(merged?.title, "Renamed");
    assert.deepEqual(merged?.messages.map((entry) => entry.id), [1, 2, 3]);
    assert.equal(merged?.messageWindow?.loaded, 3);
  });

  test("creates an unloaded window for a summary without transferring history", () => {
    const snapshot = councilSnapshotFromSummary(summary());

    assert.deepEqual(snapshot.messages, []);
    assert.deepEqual(snapshot.messageWindow, {
      total: 3,
      loaded: 0,
      hasMoreBefore: true,
    });
  });

  test("does not let a stale list response overwrite a newer live summary", () => {
    const current: CouncilSnapshot = {
      ...summary({
        title: "Live title",
        updatedAt: "2026-07-14T00:02:00.000Z",
        meta: { messageCount: 4 },
      }),
      messages: [message(4)],
      messageWindow: { total: 4, loaded: 1, hasMoreBefore: true, nextBeforeMessageId: 4 },
    };

    const [merged] = mergeCouncilLists([current], [
      summary({ title: "Stale title", updatedAt: "2026-07-14T00:01:00.000Z" }),
    ]);

    assert.equal(merged?.title, "Live title");
    assert.equal(merged?.meta?.messageCount, 4);
    assert.deepEqual(merged?.messages.map((entry) => entry.id), [4]);
  });

  test("merges repeated live message events by provider message id", () => {
    const incomingSummary = summary({ meta: { messageCount: 4 } });
    const first = mergeCouncilMessageEvent(undefined, incomingSummary, message(4));
    const repeated = mergeCouncilMessageEvent(first, incomingSummary, message(4));

    assert.deepEqual(repeated.messages.map((entry) => entry.id), [4]);
    assert.equal(repeated.messageWindow?.total, 4);
    assert.equal(repeated.messageWindow?.hasMoreBefore, true);
    assert.equal(repeated.messageWindow?.nextBeforeMessageId, 4);
  });

  test("merges a refreshed latest page when it overlaps the loaded suffix", () => {
    const current: CouncilSnapshot = {
      ...summary({ meta: { messageCount: 4 } }),
      messages: [message(2), message(3)],
      messageWindow: { total: 3, loaded: 2, hasMoreBefore: true, nextBeforeMessageId: 2 },
    };

    const merged = mergeLatestCouncilMessagesPage(current, {
      councilId: current.id,
      messages: [message(3), message(4)],
      total: 4,
      hasMoreBefore: true,
      nextBeforeMessageId: 3,
    });

    assert.deepEqual(merged.messages.map((entry) => entry.id), [2, 3, 4]);
    assert.deepEqual(merged.messageWindow, {
      total: 4,
      loaded: 3,
      hasMoreBefore: true,
      nextBeforeMessageId: 2,
    });
  });

  test("replaces a disconnected latest window when there is no overlap", () => {
    const current: CouncilSnapshot = {
      ...summary({ meta: { messageCount: 11 } }),
      messages: [message(1), message(2)],
      messageWindow: { total: 2, loaded: 2, hasMoreBefore: false },
    };

    const merged = mergeLatestCouncilMessagesPage(current, {
      councilId: current.id,
      messages: [message(10), message(11)],
      total: 11,
      hasMoreBefore: true,
      nextBeforeMessageId: 10,
    });

    assert.deepEqual(merged.messages.map((entry) => entry.id), [10, 11]);
    assert.deepEqual(merged.messageWindow, {
      total: 11,
      loaded: 2,
      hasMoreBefore: true,
      nextBeforeMessageId: 10,
    });
  });

  test("detects a stale full-size window from the summary tail id", () => {
    const messages = Array.from({ length: 100 }, (_, index) => message(index + 1));
    const staleWindow: CouncilSnapshot = {
      ...summary({
        meta: {
          messageCount: 101,
          lastMessage: {
            id: 101,
            role: "agent",
            actorId: "agent-1",
            text: "message-101",
            createdAt: timestamp,
          },
        },
      }),
      messages,
      messageWindow: { total: 101, loaded: 100, hasMoreBefore: true, nextBeforeMessageId: 1 },
    };

    assert.equal(councilNeedsLatestMessages(staleWindow, 100), true);
    staleWindow.messages = [...messages.slice(1), message(101)];
    assert.equal(councilNeedsLatestMessages(staleWindow, 100), false);
  });
});

import test from "node:test";
import assert from "node:assert/strict";
import type { RahEvent } from "@rah/runtime-protocol";
import { HistorySnapshotStore, type FrozenHistoryPageLoader } from "./history-snapshots";
import {
  historyEventMatchesItem,
  matchesSessionHistoryScope,
  summarizeHistoryPage,
} from "./history-event-projection";

function event(base: Partial<RahEvent> & Pick<RahEvent, "type" | "payload">): RahEvent {
  return {
    id: base.id ?? crypto.randomUUID(),
    sessionId: base.sessionId ?? "session-1",
    seq: base.seq ?? 1,
    ts: base.ts ?? "2026-06-05T00:00:00.000Z",
    source: {
      provider: "codex",
      channel: "structured_persisted",
      authority: "authoritative",
    },
    type: base.type,
    payload: base.payload,
    ...(base.turnId !== undefined ? { turnId: base.turnId } : {}),
    ...(base.raw !== undefined ? { raw: base.raw } : {}),
  } as unknown as RahEvent;
}

test("history summary strips heavyweight tool details while preserving hydration markers", () => {
  const full = event({
    id: "event-tool-completed",
    type: "tool.call.completed",
    raw: { payload: "raw".repeat(10_000) },
    payload: {
      toolCall: {
        id: "tool-1",
        family: "shell",
        providerToolName: "exec_command",
        title: "Run command",
        input: { command: "npm test", blob: "x".repeat(10_000) },
        result: { stdout: "y".repeat(10_000) },
        detail: {
          artifacts: [{ kind: "text", label: "stdout", text: "z".repeat(10_000) }],
        },
      },
    },
  });

  const page = summarizeHistoryPage({
    sessionId: "session-1",
    events: [full],
  });

  const summarized = page.events[0];
  assert.equal(page.detailMode, "summary");
  assert.equal(summarized?.type, "tool.call.completed");
  if (summarized?.type !== "tool.call.completed") {
    assert.fail("Expected a summarized tool completion event.");
  }
  assert.equal(summarized.raw, undefined);
  assert.equal(summarized.payload.toolCall.detail, undefined);
  assert.equal(summarized.payload.toolCall.input, undefined);
  assert.equal(summarized.payload.toolCall.result, undefined);
  assert.equal(summarized.payload.toolCall.detailAvailable, true);
  assert.ok((summarized.payload.toolCall.detailSizeBytes ?? 0) > 10_000);
  assert.ok((page.approximateBytes ?? 0) < 2_000);
});

test("history summary preserves failed tool hydration markers without payload detail", () => {
  const full = event({
    id: "event-tool-failed",
    type: "tool.call.failed",
    payload: {
      toolCallId: "tool-1",
      error: "command failed",
      detail: {
        artifacts: [{ kind: "text", label: "stderr", text: "z".repeat(10_000) }],
      },
    },
  });

  const page = summarizeHistoryPage({
    sessionId: "session-1",
    events: [full],
  });
  const summarized = page.events[0];

  assert.equal(summarized?.type, "tool.call.failed");
  if (summarized?.type !== "tool.call.failed") {
    assert.fail("Expected failed tool event.");
  }
  assert.equal(summarized.payload.detail, undefined);
  assert.equal(summarized.payload.detailAvailable, true);
  assert.ok((summarized.payload.detailSizeBytes ?? 0) > 10_000);
});

test("conversation history scope excludes all tool and observation events", () => {
  const failedTool = event({
    type: "tool.call.failed",
    payload: { toolCallId: "tool-1", error: "failed" },
  });
  const failedObservation = event({
    type: "observation.failed",
    payload: {
      observation: {
        id: "obs-1",
        kind: "command.run",
        status: "failed",
        title: "Run command",
      },
      error: "failed",
    },
  });
  const assistant = event({
    type: "timeline.item.added",
    payload: { item: { kind: "assistant_message", text: "done" } },
  });

  assert.equal(matchesSessionHistoryScope(failedTool, "conversation"), false);
  assert.equal(matchesSessionHistoryScope(failedObservation, "conversation"), false);
  assert.equal(matchesSessionHistoryScope(assistant, "conversation"), true);
});

test("history snapshot cache keeps full events available for item hydration", () => {
  const full = event({
    id: "event-observation-completed",
    type: "observation.completed",
    payload: {
      observation: {
        id: "obs-1",
        kind: "command.run",
        status: "completed",
        title: "Run command",
        detail: {
          artifacts: [{ kind: "text", label: "stdout", text: "full output" }],
        },
      },
    },
  });
  const loader: FrozenHistoryPageLoader = {
    loadInitialPage: () => ({
      boundary: { kind: "frozen", sourceRevision: "rev-1" },
      events: [full],
    }),
    loadOlderPage: () => ({
      boundary: { kind: "frozen", sourceRevision: "rev-1" },
      events: [],
    }),
  };
  const store = new HistorySnapshotStore();

  const page = store.getPage({
    sessionId: "session-1",
    loadEvents: () => [],
    loadFrozenPage: () => loader,
  });
  assert.equal(page.events.length, 1);

  const details = store.findCachedEvents("session-1", (candidate) =>
    historyEventMatchesItem(candidate, "observation", "obs-1"),
  );
  assert.equal(details.length, 1);
  const detail = details[0];
  assert.equal(detail?.type, "observation.completed");
  if (detail?.type !== "observation.completed") {
    assert.fail("Expected full observation detail.");
  }
  assert.equal(detail.payload.observation.detail?.artifacts[0]?.kind, "text");
});

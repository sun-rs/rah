import { test } from "node:test";
import assert from "node:assert/strict";
import type { RahEvent, SessionSummary } from "@rah/runtime-protocol";
import { shouldDeferEventForHistoryBootstrap } from "./session-store-history-bootstrap";
import { initialHistorySyncState, type SessionProjection } from "./types";

function summary(): SessionSummary {
  return {
    session: {
      id: "session-1",
      provider: "claude",
      launchSource: "terminal",
      cwd: "/workspace/rah",
      rootDir: "/workspace/rah",
      runtimeState: "running",
      providerSessionId: "provider-session-1",
      capabilities: {
        liveAttach: true,
        structuredTimeline: true,
        livePermissions: false,
        contextUsage: true,
        resumeByProvider: true,
        listProviderSessions: true,
        steerInput: true,
        queuedInput: true,
        modelSwitch: false,
        planMode: false,
        subagents: false,
      },
      createdAt: "2026-05-10T00:00:00.000Z",
      updatedAt: "2026-05-10T00:00:00.000Z",
    },
    attachedClients: [],
    controlLease: { sessionId: "session-1" },
  };
}

function loadingProjection(): SessionProjection {
  return {
    summary: summary(),
    feed: [],
    events: [],
    lastSeq: 0,
    history: {
      ...initialHistorySyncState(),
      phase: "loading",
    },
  };
}

function timelineEvent(): RahEvent {
  return {
    id: "event-1",
    seq: 1,
    ts: "2026-05-10T00:00:01.000Z",
    sessionId: "session-1",
    type: "timeline.item.added",
    source: {
      provider: "claude",
      channel: "structured_persisted",
      authority: "authoritative",
    },
    payload: {
      item: {
        kind: "assistant_message",
        text: "done",
        messageId: "message-1",
      },
      identity: {
        provider: "claude",
        providerSessionId: "provider-session-1",
        canonicalItemId: "canonical-item-1",
        canonicalTurnId: "canonical-turn-1",
        turnKey: "turn-1",
        itemKind: "assistant_message",
        itemKey: "message-1",
        origin: "history",
        confidence: "native",
      },
    },
    turnId: "turn-1",
  };
}

test("history bootstrap does not block native mirror timeline events", () => {
  assert.equal(
    shouldDeferEventForHistoryBootstrap(loadingProjection(), timelineEvent()),
    false,
  );
});

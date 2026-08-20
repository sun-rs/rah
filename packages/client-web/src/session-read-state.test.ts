import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import type { SessionSummary } from "@rah/runtime-protocol";
import {
  hasUnreadSinceLastSeen,
  latestFinalReplyEntryKey,
  latestFinalReplyNavigationTarget,
  markProjectionSeen,
  sessionReadKey,
} from "./session-read-state";
import { type SessionProjection } from "./types";

const originalWindow = (globalThis as typeof globalThis & { window?: unknown }).window;

function installLocalStorageMock(store = new Map<string, string>()) {
  (globalThis as typeof globalThis & { window?: unknown }).window = {
    localStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        store.set(key, value);
      },
      removeItem: (key: string) => {
        store.delete(key);
      },
    },
  };
  return store;
}

function summary(args: {
  id: string;
  providerSessionId?: string;
  updatedAt: string;
}): SessionSummary {
  return {
    session: {
      id: args.id,
      provider: "codex",
      ...(args.providerSessionId ? { providerSessionId: args.providerSessionId } : {}),
      launchSource: "web",
      status: "running",
      phase: "ready",
      cwd: "/tmp/rah",
      rootDir: "/tmp/rah",
      runtimeState: "idle",
      ptyId: `pty-${args.id}`,
      capabilities: {
        liveAttach: true,
        structuredTimeline: true,
        nativeTui: false,
        rawPtyInput: false,
        chatMirror: false,
        structuredControl: true,
        livePermissions: true,
        contextUsage: false,
        resumeByProvider: true,
        listProviderSessions: true,
        actions: { info: true, stop: true, delete: true, rename: "native" },
        steerInput: true,
        queuedInput: false,
        modelSwitch: true,
        planMode: true,
        subagents: false,
      },
      createdAt: "2026-06-01T00:00:00.000Z",
      updatedAt: args.updatedAt,
    },
    attachedClients: [],
    controlLease: { sessionId: args.id },
  };
}

function projection(args: {
  id: string;
  providerSessionId?: string;
  updatedAt: string;
  assistantAt?: string;
  assistantPhase?: "commentary" | "final_answer";
}): SessionProjection {
  return {
    summary: summary(args),
    feed: args.assistantAt
      ? [
          {
            key: `assistant:${args.id}`,
            kind: "timeline",
            item: {
              kind: "assistant_message",
              text: "done",
              phase: args.assistantPhase ?? "final_answer",
            },
            ts: args.assistantAt,
          },
        ]
      : [],
    events: [],
    lastSeq: 0,
  };
}

describe("session read state", () => {
  beforeEach(() => installLocalStorageMock());
  afterEach(() => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      writable: true,
      value: originalWindow,
    });
  });

  test("uses provider session identity across runtime ids", () => {
    const first = projection({
      id: "runtime-a",
      providerSessionId: "thread-1",
      updatedAt: "2026-06-01T00:00:00.000Z",
      assistantAt: "2026-06-01T00:01:00.000Z",
    });
    const second = projection({
      id: "runtime-b",
      providerSessionId: "thread-1",
      updatedAt: "2026-06-01T00:02:00.000Z",
      assistantAt: "2026-06-01T00:01:00.000Z",
    });

    assert.equal(sessionReadKey(first.summary), sessionReadKey(second.summary));
    assert.equal(hasUnreadSinceLastSeen(first), false);

    markProjectionSeen(first);

    assert.equal(hasUnreadSinceLastSeen(second), false);
  });

  test("detects assistant history newer than this browser last saw", () => {
    const seen = projection({
      id: "runtime-a",
      providerSessionId: "thread-2",
      updatedAt: "2026-06-01T00:00:00.000Z",
      assistantAt: "2026-06-01T00:01:00.000Z",
    });
    const later = projection({
      id: "runtime-b",
      providerSessionId: "thread-2",
      updatedAt: "2026-06-01T00:05:00.000Z",
      assistantAt: "2026-06-01T00:05:00.000Z",
    });

    markProjectionSeen(seen);

    assert.equal(hasUnreadSinceLastSeen(later), true);
  });

  test("keeps read receipts isolated between browser storage containers", () => {
    const macStorage = installLocalStorageMock();
    const baseline = projection({
      id: "runtime-device-baseline",
      providerSessionId: "thread-per-client",
      updatedAt: "2026-06-01T00:01:00.000Z",
      assistantAt: "2026-06-01T00:01:00.000Z",
    });
    const later = projection({
      id: "runtime-device-later",
      providerSessionId: "thread-per-client",
      updatedAt: "2026-06-01T00:05:00.000Z",
      assistantAt: "2026-06-01T00:05:00.000Z",
    });

    markProjectionSeen(baseline);

    const iosStorage = installLocalStorageMock();
    markProjectionSeen(baseline);

    installLocalStorageMock(macStorage);
    assert.equal(hasUnreadSinceLastSeen(later), true);
    markProjectionSeen(later);
    assert.equal(hasUnreadSinceLastSeen(later), false);

    installLocalStorageMock(iosStorage);
    assert.equal(hasUnreadSinceLastSeen(later), true);
  });

  test("does not turn lifecycle-only running updates into unread replies", () => {
    const seen = projection({
      id: "runtime-heartbeat-a",
      providerSessionId: "thread-heartbeat",
      updatedAt: "2026-06-01T00:01:00.000Z",
    });
    const heartbeatOnly = projection({
      id: "runtime-heartbeat-b",
      providerSessionId: "thread-heartbeat",
      updatedAt: "2026-06-01T00:05:00.000Z",
    });

    markProjectionSeen(seen);

    assert.equal(hasUnreadSinceLastSeen(heartbeatOnly), false);
  });

  test("does not turn in-progress commentary into a completed unread turn", () => {
    const seen = projection({
      id: "runtime-commentary-a",
      providerSessionId: "thread-commentary",
      updatedAt: "2026-06-01T00:01:00.000Z",
    });
    const commentary = projection({
      id: "runtime-commentary-b",
      providerSessionId: "thread-commentary",
      updatedAt: "2026-06-01T00:05:00.000Z",
      assistantAt: "2026-06-01T00:05:00.000Z",
      assistantPhase: "commentary",
    });

    markProjectionSeen(seen);

    assert.equal(hasUnreadSinceLastSeen(commentary), false);
  });

  test("uses a canonical final answer as unread evidence after foreground catch-up", () => {
    const seen = projection({
      id: "runtime-canonical-a",
      providerSessionId: "thread-canonical",
      updatedAt: "2026-06-01T00:01:00.000Z",
    });
    const canonical = projection({
      id: "runtime-canonical-b",
      providerSessionId: "thread-canonical",
      updatedAt: "2026-06-01T00:05:00.000Z",
    });
    canonical.conversation = {
      phase: "ready",
      loadedScope: "history",
      turns: [
        {
          id: "turn-1",
          provider: "codex",
          status: "completed",
          statusAuthority: "native",
          completedAt: "2026-06-01T00:04:00.000Z",
          items: [
            {
              id: "final-1",
              turnId: "turn-1",
              role: "final",
              status: "completed",
              completedAt: "2026-06-01T00:04:00.000Z",
              content: {
                kind: "timeline",
                item: { kind: "assistant_message", text: "done" },
              },
              source: {
                provider: "codex",
                channel: "structured_live",
                authority: "authoritative",
              },
              revision: 1,
            },
          ],
          activities: [],
          finalAnswerItemId: "final-1",
          failedItemCount: 0,
          revision: 1,
        },
      ],
      nextCursor: null,
      revision: 1,
      daemonRevision: 1,
      pendingDeltas: [],
      needsRefresh: false,
      approximateBytes: null,
      sourceRevision: "source-1",
      loadedAt: "2026-06-01T00:05:00.000Z",
      lastError: null,
    };

    markProjectionSeen(seen);

    assert.equal(hasUnreadSinceLastSeen(canonical), true);
    assert.equal(latestFinalReplyEntryKey(canonical), "conversation:final-1");
  });

  test("freezes the newest final reply key before the unread marker is cleared", () => {
    const item = projection({
      id: "runtime-final-key",
      providerSessionId: "thread-final-key",
      updatedAt: "2026-06-01T00:06:00.000Z",
      assistantAt: "2026-06-01T00:05:00.000Z",
    });
    item.feed.unshift({
      key: "assistant:older",
      kind: "timeline",
      item: { kind: "assistant_message", text: "older", phase: "final_answer" },
      ts: "2026-06-01T00:03:00.000Z",
    });

    assert.equal(latestFinalReplyEntryKey(item), "assistant:runtime-final-key");
  });

  test("freezes a completed turn identity instead of substituting an older final reply", () => {
    const item = projection({
      id: "runtime-final-race",
      updatedAt: "2026-06-01T00:06:00.000Z",
      assistantAt: "2026-06-01T00:03:00.000Z",
    });
    item.feed[0]!.turnId = "turn-old";
    item.events.push({
      id: "event-turn-new-completed",
      seq: 2,
      ts: "2026-06-01T00:06:00.000Z",
      sessionId: item.summary.session.id,
      turnId: "turn-new",
      type: "turn.completed",
      source: {
        provider: "codex",
        channel: "structured_live",
        authority: "authoritative",
      },
      payload: { completedAt: "2026-06-01T00:06:00.000Z" },
    });

    assert.deepEqual(latestFinalReplyNavigationTarget(item), {
      entryKey: null,
      turnId: "turn-new",
      replyTimestampMs: Date.parse("2026-06-01T00:06:00.000Z"),
    });
  });

  test("does not let a stale completion event override a newer canonical final reply", () => {
    const item = projection({
      id: "runtime-stale-terminal",
      updatedAt: "2026-06-01T00:08:00.000Z",
      assistantAt: "2026-06-01T00:08:00.000Z",
    });
    item.feed[0]!.turnId = "turn-new";
    item.events.push({
      id: "event-turn-old-completed",
      seq: 1,
      ts: "2026-06-01T00:03:00.000Z",
      sessionId: item.summary.session.id,
      turnId: "turn-old",
      type: "turn.completed",
      source: {
        provider: "codex",
        channel: "structured_live",
        authority: "authoritative",
      },
      payload: { completedAt: "2026-06-01T00:03:00.000Z" },
    });

    assert.deepEqual(latestFinalReplyNavigationTarget(item), {
      entryKey: "assistant:runtime-stale-terminal",
      turnId: "turn-new",
      replyTimestampMs: Date.parse("2026-06-01T00:08:00.000Z"),
    });
  });

  test("ignores unread reconstruction when localStorage access is blocked", () => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      get() {
        throw new Error("localStorage blocked");
      },
    });
    const item = projection({
      id: "runtime-blocked",
      providerSessionId: "thread-blocked",
      updatedAt: "2026-06-01T00:05:00.000Z",
      assistantAt: "2026-06-01T00:05:00.000Z",
    });

    assert.doesNotThrow(() => markProjectionSeen(item));
    assert.equal(hasUnreadSinceLastSeen(item), false);
  });
});

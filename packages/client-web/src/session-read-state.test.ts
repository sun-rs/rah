import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import type { SessionSummary } from "@rah/runtime-protocol";
import {
  hasUnreadSinceLastSeen,
  markProjectionSeen,
  sessionReadKey,
} from "./session-read-state";
import { type SessionProjection } from "./types";

const originalWindow = (globalThis as typeof globalThis & { window?: unknown }).window;

function installLocalStorageMock() {
  const store = new Map<string, string>();
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
}): SessionProjection {
  return {
    summary: summary(args),
    feed: args.assistantAt
      ? [
          {
            key: `assistant:${args.id}`,
            kind: "timeline",
            item: { kind: "assistant_message", text: "done" },
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

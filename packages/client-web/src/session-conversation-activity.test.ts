import { test } from "node:test";
import assert from "node:assert/strict";
import type { SessionSummary } from "@rah/runtime-protocol";
import {
  deriveSessionConversationActivityAt,
  runningSessionActivityAt,
} from "./session-conversation-activity";
import type { FeedEntry } from "./types";

function summary(overrides: {
  id?: string;
  createdAt?: string;
  updatedAt?: string;
} = {}): SessionSummary {
  const id = overrides.id ?? "session-1";
  return {
    session: {
      id,
      provider: "opencode",
      providerSessionId: `${id}-provider`,
      launchSource: "web",
      status: "running",
      phase: "ready",
      cwd: "/workspace/rah",
      rootDir: "/workspace/rah",
      runtimeState: "idle",
      ptyId: "pty-1",
      capabilities: {
        liveAttach: true,
        structuredTimeline: true,
        livePermissions: true,
        contextUsage: true,
        resumeByProvider: true,
        listProviderSessions: true,
        steerInput: true,
        queuedInput: false,
        modelSwitch: false,
        planMode: false,
        subagents: false,
      },
      createdAt: overrides.createdAt ?? "2026-05-01T10:00:00.000Z",
      updatedAt: overrides.updatedAt ?? "2026-05-01T10:00:00.000Z",
    },
    attachedClients: [],
    controlLease: { sessionId: id },
  };
}

function timeline(kind: "user_message" | "assistant_message" | "reasoning", text: string, ts: string): FeedEntry {
  return {
    key: `${kind}:${ts}`,
    kind: "timeline",
    item: { kind, text },
    ts,
  } as FeedEntry;
}

test("derives running session activity from the latest visible conversation message", () => {
  const sessionSummary = summary({ updatedAt: "2026-05-01T10:59:00.000Z" });
  const activityAt = deriveSessionConversationActivityAt({
    summary: sessionSummary,
    feed: [
      timeline("user_message", "hello", "2026-05-01T10:03:00.000Z"),
      timeline("reasoning", "hidden work", "2026-05-01T10:58:00.000Z"),
      {
        key: "runtime:latest",
        kind: "runtime_status",
        status: "thinking",
        ts: "2026-05-01T10:59:00.000Z",
      } as FeedEntry,
      timeline("assistant_message", "answer", "2026-05-01T10:04:00.000Z"),
    ],
  });

  assert.equal(activityAt, "2026-05-01T10:04:00.000Z");
});

test("falls back to session creation time when no conversation messages are loaded", () => {
  const sessionSummary = summary({
    createdAt: "2026-05-01T10:00:00.000Z",
    updatedAt: "2026-05-01T10:59:00.000Z",
  });
  const activityAt = deriveSessionConversationActivityAt({
    summary: sessionSummary,
    feed: [
      timeline("reasoning", "hidden work", "2026-05-01T10:58:00.000Z"),
      {
        key: "runtime:latest",
        kind: "runtime_status",
        status: "thinking",
        ts: "2026-05-01T10:59:00.000Z",
      } as FeedEntry,
    ],
  });

  assert.equal(activityAt, "2026-05-01T10:00:00.000Z");
  assert.equal(runningSessionActivityAt(sessionSummary, undefined), "2026-05-01T10:00:00.000Z");
  assert.equal(
    runningSessionActivityAt(sessionSummary, "2026-05-01T10:03:00.000Z"),
    "2026-05-01T10:03:00.000Z",
  );
});

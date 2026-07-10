import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type { RahEvent, SessionSummary } from "@rah/runtime-protocol";
import {
  ensureSessionTurnDirectoryCommand,
  loadSessionTurnHistoryCommand,
} from "./session-store-turn-directory";
import { replayEventsIntoProjection } from "./session-store-history";
import type { SessionProjection } from "./types";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function summary(): SessionSummary {
  return {
    session: {
      id: "session-1",
      provider: "codex",
      providerSessionId: "provider-session-1",
      launchSource: "web",
      cwd: "/tmp/project",
      rootDir: "/tmp/project",
      runtimeState: "stopped",
      capabilities: {
        liveAttach: false,
        structuredTimeline: true,
        livePermissions: false,
        contextUsage: false,
        resumeByProvider: true,
        listProviderSessions: true,
        steerInput: false,
        queuedInput: false,
        modelSwitch: false,
        planMode: false,
        subagents: false,
      },
      createdAt: "2026-07-10T00:00:00.000Z",
      updatedAt: "2026-07-10T00:00:02.000Z",
    },
    attachedClients: [],
    controlLease: { sessionId: "session-1" },
  };
}

function turnEvent(kind: "user_message" | "assistant_message", text: string): RahEvent {
  const itemKey = kind === "user_message" ? "user:0" : "assistant:1";
  return {
    id: `history-turn:session-1:turn-1:${itemKey}`,
    seq: kind === "user_message" ? 1_100_000_000 : 1_100_000_001,
    ts: kind === "user_message"
      ? "2026-07-10T00:00:00.000Z"
      : "2026-07-10T00:00:02.000Z",
    sessionId: "session-1",
    turnId: "turn-1",
    type: "timeline.item.added",
    source: {
      provider: "codex",
      channel: "structured_persisted",
      authority: "authoritative",
    },
    payload: {
      item: {
        kind,
        text,
        ...(kind === "assistant_message" ? { phase: "final_answer" as const } : {}),
      },
      identity: {
        canonicalItemId: `item:${itemKey}`,
        canonicalTurnId: "canonical-turn-1",
        provider: "codex",
        providerSessionId: "provider-session-1",
        turnKey: "turn:turn-1",
        itemKind: kind,
        itemKey,
        origin: "history",
        confidence: "derived",
      },
    },
  };
}

function commandState() {
  let state = {
    projections: new Map<string, SessionProjection>([
      ["session-1", replayEventsIntoProjection(summary(), [])],
    ]),
  };
  return {
    get: () => state,
    set: (
      update:
        | Partial<typeof state>
        | ((current: typeof state) => Partial<typeof state> | typeof state),
    ) => {
      state = { ...state, ...(typeof update === "function" ? update(state) : update) };
    },
  };
}

test("turn directory loads once and a selected turn merges by provider turn id", async () => {
  const state = commandState();
  const requested: string[] = [];
  globalThis.fetch = async (input) => {
    const url = String(input);
    requested.push(url);
    if (url.includes("turn-directory")) {
      return Response.json({
        sessionId: "session-1",
        revision: "revision-1",
        complete: true,
        sourceBytes: 42_000_000,
        generatedAt: "2026-07-10T00:00:03.000Z",
        items: [
          {
            id: "turn-1",
            ordinal: 0,
            userPreview: "First question",
            assistantPreview: "First answer",
            startedAt: "2026-07-10T00:00:00.000Z",
            completedAt: "2026-07-10T00:00:02.000Z",
            status: "completed",
          },
        ],
      });
    }
    return Response.json({
      sessionId: "session-1",
      turnId: "turn-1",
      events: [turnEvent("user_message", "First question"), turnEvent("assistant_message", "First answer")],
    });
  };

  await ensureSessionTurnDirectoryCommand({ ...state, sessionId: "session-1" });
  await ensureSessionTurnDirectoryCommand({ ...state, sessionId: "session-1" });
  assert.equal(state.get().projections.get("session-1")?.turnDirectory?.phase, "ready");
  assert.equal(requested.filter((url) => url.includes("turn-directory")).length, 1);

  await loadSessionTurnHistoryCommand({ ...state, sessionId: "session-1", turnId: "turn-1" });
  await loadSessionTurnHistoryCommand({ ...state, sessionId: "session-1", turnId: "turn-1" });
  const feed = state.get().projections.get("session-1")?.feed ?? [];
  assert.deepEqual(
    feed.flatMap((entry) =>
      entry.kind === "timeline" &&
      (entry.item.kind === "user_message" || entry.item.kind === "assistant_message")
        ? [entry.item.text]
        : [],
    ),
    ["First question", "First answer"],
  );
  assert.equal(
    feed.every((entry) => entry.kind !== "timeline" || entry.providerTurnId === "turn-1"),
    true,
  );
  assert.equal(requested.filter((url) => url.includes("history/turn?")).length, 1);
});

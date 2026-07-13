import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type {
  ConversationItemProjection,
  ConversationTurnProjection,
  SessionSummary,
} from "@rah/runtime-protocol";
import {
  ensureSessionConversationDirectoryCommand,
  loadConversationDirectoryTurnCommand,
} from "./session-store-conversation-directory";
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

function turnItem(
  kind: "user_message" | "assistant_message",
  text: string,
): ConversationItemProjection {
  const itemKey = kind === "user_message" ? "user:0" : "assistant:1";
  return {
    id: `item:${itemKey}`,
    turnId: "canonical-turn-1",
    providerItemId: itemKey,
    role: kind === "user_message" ? "user" : "final",
    status: "completed",
    startedAt: kind === "user_message"
      ? "2026-07-10T00:00:00.000Z"
      : "2026-07-10T00:00:02.000Z",
    content: {
      kind: "timeline",
      item: {
        kind,
        text,
        ...(kind === "assistant_message" ? { phase: "final_answer" as const } : {}),
      },
    },
    source: {
      provider: "codex",
      channel: "structured_persisted",
      authority: "authoritative",
    },
    revision: 1,
  };
}

function canonicalTurn(items: ConversationItemProjection[], itemsView: "summary" | "full"):
  ConversationTurnProjection {
  return {
    id: "canonical-turn-1",
    provider: "codex",
    providerSessionId: "provider-session-1",
    providerTurnId: "turn-1",
    status: "completed",
    statusAuthority: "native",
    startedAt: "2026-07-10T00:00:00.000Z",
    completedAt: "2026-07-10T00:00:02.000Z",
    durationMs: 2_000,
    items,
    finalAnswerItemId: "item:assistant:1",
    failedItemCount: 0,
    itemsView,
    revision: 1,
  };
}

function commandState() {
  let state = {
    projections: new Map<string, SessionProjection>([
      ["session-1", {
        summary: summary(),
        feed: [],
        events: [],
        lastSeq: 0,
      }],
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
    if (url.includes("/conversation/directory")) {
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
    if (url.includes("/conversation/turns/canonical-turn-1/detail")) {
      return Response.json({
        sessionId: "session-1",
        turnId: "canonical-turn-1",
        turn: canonicalTurn(
          [turnItem("user_message", "First question"), turnItem("assistant_message", "First answer")],
          "full",
        ),
      });
    }
    return Response.json({
      sessionId: "session-1",
      turns: [canonicalTurn([], "summary")],
      revision: 1,
      liveRevision: 1,
      generatedAt: "2026-07-10T00:00:03.000Z",
      sourceEventCount: 2,
    });
  };

  await ensureSessionConversationDirectoryCommand({ ...state, sessionId: "session-1" });
  await ensureSessionConversationDirectoryCommand({ ...state, sessionId: "session-1" });
  assert.equal(state.get().projections.get("session-1")?.turnDirectory?.phase, "ready");
  assert.equal(requested.filter((url) => url.includes("/conversation/directory")).length, 1);

  await loadConversationDirectoryTurnCommand({ ...state, sessionId: "session-1", turnId: "turn-1" });
  await loadConversationDirectoryTurnCommand({ ...state, sessionId: "session-1", turnId: "turn-1" });
  const turns = state.get().projections.get("session-1")?.conversation?.turns ?? [];
  assert.deepEqual(
    turns.flatMap((turn) => turn.items.flatMap((item) =>
      item.content.kind === "timeline" &&
      (item.content.item.kind === "user_message" || item.content.item.kind === "assistant_message")
        ? [item.content.item.text]
        : [],
    )),
    ["First question", "First answer"],
  );
  assert.equal(
    turns.every((turn) => turn.providerTurnId === "turn-1"),
    true,
  );
  assert.equal(
    requested.filter((url) => url.includes("/conversation/turns/canonical-turn-1/detail")).length,
    1,
  );
});

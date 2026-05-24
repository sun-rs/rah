import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { RahEvent, SessionSummary } from "@rah/runtime-protocol";
import {
  notificationCandidateFromEvent,
  notificationDedupKeyFromEvent,
  shouldNotifyForUnreadEvent,
  textFromCouncilParts,
} from "./browser-notifications";

function baseEvent<T extends RahEvent["type"]>(
  type: T,
  payload: Extract<RahEvent, { type: T }>["payload"],
  patch: Partial<RahEvent> = {},
): Extract<RahEvent, { type: T }> {
  return {
    id: `event-${type}`,
    seq: 1,
    ts: "2026-05-23T00:00:00.000Z",
    sessionId: "session-1",
    turnId: "turn-1",
    source: { provider: "codex", channel: "structured_live", authority: "authoritative" },
    type,
    payload,
    ...patch,
  } as Extract<RahEvent, { type: T }>;
}

function assistantEvent(text: string): Extract<RahEvent, { type: "timeline.item.updated" }> {
  return baseEvent("timeline.item.updated", {
    item: { kind: "assistant_message", text, messageId: "message-1" },
    identity: { canonicalItemId: "item-1" } as never,
  });
}

function userEvent(): Extract<RahEvent, { type: "timeline.item.added" }> {
  return baseEvent("timeline.item.added", {
    item: { kind: "user_message", text: "hello" },
    identity: { canonicalItemId: "user-item-1" } as never,
  });
}

function sessionSummary(): SessionSummary {
  return {
    session: {
      id: "session-1",
      provider: "codex",
      launchSource: "web",
      status: "running",
      phase: "thinking",
      cwd: "/tmp/project",
      rootDir: "/tmp/project",
      runtimeState: "running",
      ptyId: "pty-1",
      title: "Backtest work",
      capabilities: {} as never,
      createdAt: "2026-05-23T00:00:00.000Z",
      updatedAt: "2026-05-23T00:00:00.000Z",
    },
    attachedClients: [],
    controlLease: { holderClientId: null, holderClientKind: null } as never,
  };
}

describe("browser notification event policy", () => {
  test("builds a notification for an assistant timeline item", () => {
    const candidate = notificationCandidateFromEvent(assistantEvent("A useful reply."), sessionSummary());

    assert.equal(candidate?.key, "session:session-1:assistant:item-1");
    assert.equal(candidate?.target.kind, "session");
    assert.equal(candidate?.target.id, "session-1");
    assert.equal(candidate?.title, "Codex: Backtest work");
    assert.equal(candidate?.body, "A useful reply.");
  });

  test("ignores user messages and empty assistant updates", () => {
    assert.equal(notificationCandidateFromEvent(userEvent()), null);
    assert.equal(notificationCandidateFromEvent(assistantEvent("   \n  ")), null);
  });

  test("suppresses the visible focused conversation", () => {
    assert.equal(
      shouldNotifyForUnreadEvent({
        event: assistantEvent("Visible reply"),
        activeTargets: [{ kind: "session", id: "session-1" }],
        documentVisible: true,
        documentFocused: true,
      }),
      false,
    );
  });

  test("notifies for the selected conversation when the document is hidden or unfocused", () => {
    assert.equal(
      shouldNotifyForUnreadEvent({
        event: assistantEvent("Hidden reply"),
        activeTargets: [{ kind: "session", id: "session-1" }],
        documentVisible: false,
        documentFocused: true,
      }),
      true,
    );
    assert.equal(
      shouldNotifyForUnreadEvent({
        event: assistantEvent("Unfocused reply"),
        activeTargets: [{ kind: "session", id: "session-1" }],
        documentVisible: true,
        documentFocused: false,
      }),
      true,
    );
  });

  test("notifies for a different visible conversation", () => {
    assert.equal(
      shouldNotifyForUnreadEvent({
        event: assistantEvent("Other reply"),
        activeTargets: [{ kind: "session", id: "session-2" }],
        documentVisible: true,
        documentFocused: true,
      }),
      true,
    );
  });

  test("builds a notification for permission requests", () => {
    const event = baseEvent("permission.requested", {
      request: {
        id: "permission-1",
        kind: "tool",
        title: "Run command?",
        description: "Codex wants to run npm test.",
      },
    });

    const candidate = notificationCandidateFromEvent(event, sessionSummary());

    assert.equal(candidate?.key, "session:session-1:permission:permission-1");
    assert.equal(candidate?.title, "Codex: Backtest work");
    assert.equal(candidate?.body, "Codex wants to run npm test.");
  });

  test("builds a notification for Council agent messages", () => {
    const event = baseEvent(
      "council.message.created",
      {
        council: {
          id: "council-1",
          title: "Design review",
          workspace: "/tmp/project",
          status: "running",
          phase: "idle",
          agents: [],
          messages: [],
          createdAt: "2026-05-23T00:00:00.000Z",
          updatedAt: "2026-05-23T00:00:00.000Z",
        },
        message: {
          id: 12,
          councilId: "council-1",
          actorId: "agent-1",
          role: "agent",
          parts: [{ kind: "text", text: "I found the issue." }],
          createdAt: "2026-05-23T00:00:00.000Z",
        },
      },
      { sessionId: "council-1", source: { provider: "system", channel: "system", authority: "authoritative" } },
    );

    const candidate = notificationCandidateFromEvent(event);

    assert.equal(candidate?.key, "council:council-1:message:12");
    assert.equal(candidate?.target.kind, "council");
    assert.equal(candidate?.title, "Council: Design review");
    assert.equal(candidate?.body, "I found the issue.");
  });

  test("does not notify for Council user messages", () => {
    const event = baseEvent("council.message.created", {
      council: {
        id: "council-1",
        title: "Design review",
        workspace: "/tmp/project",
        status: "running",
        phase: "idle",
        agents: [],
        messages: [],
        createdAt: "2026-05-23T00:00:00.000Z",
        updatedAt: "2026-05-23T00:00:00.000Z",
      },
      message: {
        id: 13,
        councilId: "council-1",
        actorId: "user",
        role: "user",
        parts: [{ kind: "text", text: "Please continue." }],
        createdAt: "2026-05-23T00:00:00.000Z",
      },
    });

    assert.equal(notificationCandidateFromEvent(event), null);
  });

  test("keeps stable assistant keys across added and updated events", () => {
    const added = baseEvent("timeline.item.added", {
      item: { kind: "assistant_message", text: "start", messageId: "message-1" },
      identity: { canonicalItemId: "item-1" } as never,
    });
    const updated = assistantEvent("done");

    assert.equal(notificationDedupKeyFromEvent(added), notificationDedupKeyFromEvent(updated));
  });

  test("extracts visible Council text parts only", () => {
    assert.equal(
      textFromCouncilParts([
        { kind: "text", text: "hello\n" },
        { kind: "data", data: { hidden: true } },
        { kind: "text", text: "world" },
      ]),
      "hello world",
    );
  });
});

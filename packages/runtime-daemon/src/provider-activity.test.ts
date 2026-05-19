import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { ToolCall } from "@rah/runtime-protocol";
import { EventBus } from "./event-bus";
import { PtyHub } from "./pty-hub";
import { applyProviderActivity } from "./provider-activity";
import { SessionStore } from "./session-store";
import { createTimelineIdentity } from "./timeline-identity";
import {
  resetTimelineIdentityTelemetryForTests,
  setTimelineIdentityTelemetryWarnSinkForTests,
  type TimelineIdentityTelemetryWarning,
} from "./timeline-identity-telemetry";
import { resetTimelineReconcilerForTests } from "./timeline-reconciler";

function createServices() {
  return {
    eventBus: new EventBus(),
    ptyHub: new PtyHub(),
    sessionStore: new SessionStore(),
  };
}

function createSession(services: ReturnType<typeof createServices>) {
  return services.sessionStore.createManagedSession({
    provider: "codex",
    launchSource: "web",
    cwd: "/workspace/demo",
    rootDir: "/workspace/demo",
    title: "demo",
  }).session.id;
}

function createCouncilSession(services: ReturnType<typeof createServices>) {
  return services.sessionStore.createManagedSession({
    provider: "opencode",
    launchSource: "web",
    cwd: "/workspace/demo",
    rootDir: "/workspace/demo",
    title: "Council Agent",
    origin: {
      kind: "council",
      councilId: "council-1",
      councilTitle: "Council",
      agentId: "agent-1",
      agentLabel: "Agent",
    },
  }).session.id;
}

describe("applyProviderActivity", () => {
  test("keeps Council managed session chat focused on channel_post projections", () => {
    const services = createServices();
    const sessionId = createCouncilSession(services);

    assert.deepEqual(
      applyProviderActivity(
        services,
        sessionId,
        { provider: "opencode" },
        { type: "turn_started", turnId: "turn-control" },
      ),
      [],
    );
    assert.equal(services.sessionStore.getSession(sessionId)?.activeTurnId, undefined);

    assert.deepEqual(
      applyProviderActivity(
        services,
        sessionId,
        { provider: "opencode" },
        {
          type: "timeline_item",
          item: {
            kind: "assistant_message",
            text: "Joined successfully. Entering listen loop.",
          },
        },
      ),
      [],
    );

    assert.deepEqual(
      applyProviderActivity(
        services,
        sessionId,
        { provider: "opencode" },
        { type: "runtime_status", status: "thinking" },
      ),
      [],
    );

    const receivedUser = applyProviderActivity(
      services,
      sessionId,
      { provider: "opencode", ts: "2099-05-19T09:59:59.000Z" },
      {
        type: "timeline_item",
        item: {
          kind: "user_message",
          messageId: "council-mcp:user:1",
          text: "Council prompt",
        },
        identity: createTimelineIdentity({
          provider: "opencode",
          providerSessionId: "provider-council-1",
          turnKey: "message:user-council",
          itemKind: "user_message",
          itemKey: "user-1",
          origin: "live",
          confidence: "derived",
        }),
      },
    );
    assert.equal(receivedUser.length, 1);
    assert.equal(receivedUser[0]?.type, "timeline.item.added");

    const posted = applyProviderActivity(
      services,
      sessionId,
      { provider: "opencode", ts: "2099-05-19T10:00:00.000Z" },
      {
        type: "timeline_item",
        item: {
          kind: "assistant_message",
          messageId: "council-mcp:call-post",
          text: "Visible Council reply",
        },
        identity: createTimelineIdentity({
          provider: "opencode",
          providerSessionId: "provider-council-1",
          turnKey: "message:assistant-council",
          itemKind: "assistant_message",
          itemKey: "call-post",
          origin: "live",
          confidence: "derived",
        }),
      },
    );
    assert.equal(posted.length, 1);
    assert.equal(posted[0]?.type, "timeline.item.added");
    assert.equal(
      services.sessionStore.getSession(sessionId)?.session.updatedAt,
      posted[0]?.ts,
    );
    assert.equal(
      services.sessionStore.getSession(sessionId)?.conversationActivityAt,
      posted[0]?.ts,
    );

    const stopped = applyProviderActivity(
      services,
      sessionId,
      { provider: "opencode" },
      { type: "session_state", state: "stopped" },
    );
    assert.equal(stopped.length, 1);
    assert.equal(services.sessionStore.getSession(sessionId)?.session.runtimeState, "stopped");
  });

  test("tracks conversation activity separately from non-chat timeline updates", () => {
    const services = createServices();
    const sessionId = createSession(services);

    applyProviderActivity(
      services,
      sessionId,
      { provider: "codex", ts: "2099-05-19T10:00:00.000Z" },
      {
        type: "timeline_item",
        item: { kind: "assistant_message", text: "Visible answer" },
      },
    );
    applyProviderActivity(
      services,
      sessionId,
      { provider: "codex", ts: "2099-05-19T10:05:00.000Z" },
      {
        type: "timeline_item",
        item: { kind: "reasoning", text: "Internal reasoning" },
      },
    );

    const state = services.sessionStore.getSession(sessionId);
    assert.equal(state?.session.updatedAt, "2099-05-19T10:05:00.000Z");
    assert.equal(state?.conversationActivityAt, "2099-05-19T10:00:00.000Z");
  });

  test("clears active turn when provider reports the session is idle", () => {
    const services = createServices();
    const sessionId = createSession(services);

    applyProviderActivity(
      services,
      sessionId,
      { provider: "codex" },
      { type: "turn_started", turnId: "turn-1" },
    );
    assert.equal(services.sessionStore.getSession(sessionId)?.activeTurnId, "turn-1");

    applyProviderActivity(
      services,
      sessionId,
      { provider: "codex" },
      { type: "session_state", state: "idle" },
    );

    assert.equal(services.sessionStore.getSession(sessionId)?.activeTurnId, undefined);
    assert.equal(services.sessionStore.getSession(sessionId)?.session.runtimeState, "idle");
  });

  test("passes timeline identity through without making origin part of the key", () => {
    const services = createServices();
    const sessionId = createSession(services);
    const liveIdentity = createTimelineIdentity({
      provider: "codex",
      providerSessionId: "provider-session-1",
      turnKey: "turn-1",
      itemKind: "assistant_message",
      itemKey: "message-1",
      origin: "live",
      confidence: "native",
    });
    const historyIdentity = createTimelineIdentity({
      provider: "codex",
      providerSessionId: "provider-session-1",
      turnKey: "turn-1",
      itemKind: "assistant_message",
      itemKey: "message-1",
      origin: "history",
      contentHash: "different-source-content-checksum",
      confidence: "native",
    });

    assert.equal(liveIdentity.canonicalItemId, historyIdentity.canonicalItemId);
    assert.equal(liveIdentity.canonicalTurnId, historyIdentity.canonicalTurnId);

    applyProviderActivity(
      services,
      sessionId,
      { provider: "codex" },
      {
        type: "timeline_item",
        turnId: "turn-1",
        item: { kind: "assistant_message", text: "hello" },
        identity: liveIdentity,
      },
    );

    const [event] = services.eventBus.list({ sessionIds: [sessionId] });
    assert.equal(event?.type, "timeline.item.added");
    if (event?.type === "timeline.item.added") {
      assert.deepEqual(event.payload.identity, liveIdentity);
    }
  });

  test("reconciles repeated canonical timeline items before they reach the UI", () => {
    resetTimelineReconcilerForTests();
    const services = createServices();
    const sessionId = createSession(services);
    const liveIdentity = createTimelineIdentity({
      provider: "codex",
      providerSessionId: "provider-session-1",
      turnKey: "turn-1",
      itemKind: "assistant_message",
      itemKey: "message-1",
      origin: "live",
      confidence: "native",
    });
    const historyIdentity = createTimelineIdentity({
      provider: "codex",
      providerSessionId: "provider-session-1",
      turnKey: "turn-1",
      itemKind: "assistant_message",
      itemKey: "message-1",
      origin: "history",
      confidence: "native",
    });

    const first = applyProviderActivity(
      services,
      sessionId,
      { provider: "codex", channel: "structured_live" },
      {
        type: "timeline_item",
        turnId: "turn-1",
        item: { kind: "assistant_message", text: "partial" },
        identity: liveIdentity,
      },
    );
    const duplicate = applyProviderActivity(
      services,
      sessionId,
      { provider: "codex", channel: "structured_persisted" },
      {
        type: "timeline_item",
        turnId: "turn-1",
        item: { kind: "assistant_message", text: "partial" },
        identity: historyIdentity,
      },
    );
    const replacement = applyProviderActivity(
      services,
      sessionId,
      { provider: "codex", channel: "structured_persisted" },
      {
        type: "timeline_item",
        turnId: "turn-1",
        item: { kind: "assistant_message", text: "final" },
        identity: historyIdentity,
      },
    );

    assert.deepEqual(first.map((event) => event.type), ["timeline.item.added"]);
    assert.deepEqual(duplicate.map((event) => event.type), []);
    assert.deepEqual(replacement.map((event) => event.type), ["timeline.item.updated"]);

    const events = services.eventBus.list({ sessionIds: [sessionId] });
    assert.deepEqual(events.map((event) => event.type), [
      "timeline.item.added",
      "timeline.item.updated",
    ]);
    const updated = events[1];
    assert.equal(updated?.type, "timeline.item.updated");
    if (updated?.type === "timeline.item.updated") {
      assert.deepEqual(updated.payload.item, { kind: "assistant_message", text: "final" });
      assert.equal(updated.payload.identity?.origin, "history");
    }
  });

  test("maps timeline and tool calls into canonical events", () => {
    const services = createServices();
    const sessionId = createSession(services);
    const toolCall: ToolCall = {
      id: "tool-1",
      family: "shell",
      providerToolName: "exec_command",
      title: "Run command",
      input: { command: "echo hello" },
    };

    applyProviderActivity(
      services,
      sessionId,
      { provider: "codex", raw: { rawType: "message.part.delta" } },
      {
        type: "timeline_item",
        turnId: "turn-1",
        item: { kind: "system", text: "hello" },
      },
    );
    applyProviderActivity(
      services,
      sessionId,
      { provider: "codex" },
      {
        type: "timeline_item_updated",
        turnId: "turn-1",
        item: { kind: "system", text: "hello final" },
      },
    );
    applyProviderActivity(
      services,
      sessionId,
      { provider: "codex" },
      {
        type: "tool_call_started",
        turnId: "turn-1",
        toolCall,
      },
    );

    const events = services.eventBus.list({ sessionIds: [sessionId] });
    assert.equal(events.length, 3);
    assert.deepEqual(
      {
        type: events[0]?.type,
        turnId: events[0]?.turnId,
        payload: events[0]?.payload,
        raw: events[0]?.raw,
      },
      {
        type: "timeline.item.added",
        turnId: "turn-1",
        payload: { item: { kind: "system", text: "hello" } },
        raw: { rawType: "message.part.delta" },
      },
    );
    assert.deepEqual(
      {
        type: events[1]?.type,
        turnId: events[1]?.turnId,
        payload: events[1]?.payload,
      },
      {
        type: "timeline.item.updated",
        turnId: "turn-1",
        payload: { item: { kind: "system", text: "hello final" } },
      },
    );
    assert.deepEqual(
      {
        type: events[2]?.type,
        turnId: events[2]?.turnId,
        toolCallId:
          events[2]?.type === "tool.call.started" ? events[2].payload.toolCall.id : undefined,
        toolCallFamily:
          events[2]?.type === "tool.call.started"
            ? events[2].payload.toolCall.family
            : undefined,
      },
      {
        type: "tool.call.started",
        turnId: "turn-1",
        toolCallId: "tool-1",
        toolCallFamily: "shell",
      },
    );
  });

  test("updates session state for permissions and usage", () => {
    const services = createServices();
    const sessionId = createSession(services);

    applyProviderActivity(
      services,
      sessionId,
      { provider: "claude" },
      {
        type: "permission_requested",
        turnId: "turn-perm",
        request: {
          id: "perm-1",
          kind: "tool",
          title: "Allow command",
        },
      },
    );
    assert.equal(
      services.sessionStore.getSession(sessionId)?.session.runtimeState,
      "waiting_permission",
    );

    applyProviderActivity(
      services,
      sessionId,
      { provider: "claude" },
      {
        type: "permission_resolved",
        turnId: "turn-perm",
        resolution: {
          requestId: "perm-1",
          behavior: "deny",
        },
      },
    );

    const usageEvents = applyProviderActivity(
      services,
      sessionId,
      { provider: "claude" },
      {
        type: "usage",
        turnId: "turn-perm",
        usage: {
          usedTokens: 123,
          contextWindow: 10_000,
          percentRemaining: 98,
        },
      },
    );
    assert.deepEqual(usageEvents.map((event) => event.type), ["usage.updated"]);
    assert.deepEqual(services.sessionStore.getSession(sessionId)?.usage, {
      usedTokens: 123,
      contextWindow: 10_000,
      percentUsed: 1.2,
      percentRemaining: 98.8,
      basis: "context_window",
      precision: "exact",
    });
  });

  test("turn failures publish only turn failure events", () => {
    const services = createServices();
    const sessionId = createSession(services);

    applyProviderActivity(
      services,
      sessionId,
      { provider: "codex" },
      {
        type: "turn_started",
        turnId: "turn-fail",
      },
    );
    applyProviderActivity(
      services,
      sessionId,
      { provider: "codex" },
      {
        type: "turn_failed",
        turnId: "turn-fail",
        error: "model error",
      },
    );
    applyProviderActivity(
      services,
      sessionId,
      { provider: "codex" },
      {
        type: "turn_started",
        turnId: "turn-ok",
      },
    );
    applyProviderActivity(
      services,
      sessionId,
      { provider: "codex" },
      {
        type: "turn_completed",
        turnId: "turn-ok",
      },
    );

    assert.deepEqual(
      services.eventBus
        .list({ sessionIds: [sessionId] })
        .filter((event) => event.type === "turn.failed")
        .map((event) => event.payload.error),
      ["model error"],
    );
  });

  test("mirrors terminal output into both PTY replay and canonical terminal events", () => {
    const services = createServices();
    const sessionId = createSession(services);
    const frames: unknown[] = [];
    const unsubscribe = services.ptyHub.subscribe(sessionId, (frame) => {
      frames.push(frame);
    });

    applyProviderActivity(
      services,
      sessionId,
      { provider: "codex" },
      {
        type: "terminal_output",
        data: "line one\r\n",
      },
    );
    applyProviderActivity(
      services,
      sessionId,
      { provider: "codex" },
      {
        type: "terminal_exited",
        exitCode: 0,
      },
    );
    unsubscribe();

    assert.ok(
      frames.some((frame) => {
        const output = frame as { type?: string; sessionId?: string; data?: string };
        return (
          output.type === "pty.output" &&
          output.sessionId === sessionId &&
          output.data === "line one\r\n"
        );
      }),
    );
    assert.ok(
      frames.some((frame) => {
        const exited = frame as { type?: string; sessionId?: string; exitCode?: number };
        return (
          exited.type === "pty.exited" &&
          exited.sessionId === sessionId &&
          exited.exitCode === 0
        );
      }),
    );

    const events = services.eventBus.list({ sessionIds: [sessionId] });
    assert.deepEqual(events.map((event) => event.type), [
      "terminal.output",
      "terminal.exited",
    ]);
  });

  test("warns once when a high-value timeline item is missing identity", () => {
    resetTimelineIdentityTelemetryForTests();
    const warnings: TimelineIdentityTelemetryWarning[] = [];
    setTimelineIdentityTelemetryWarnSinkForTests((warning) => warnings.push(warning));
    const services = createServices();
    const sessionId = createSession(services);

    try {
      applyProviderActivity(
        services,
        sessionId,
        { provider: "codex" },
        {
          type: "timeline_item",
          turnId: "turn-1",
          item: { kind: "assistant_message", text: "hello" },
        },
      );
      applyProviderActivity(
        services,
        sessionId,
        { provider: "codex" },
        {
          type: "timeline_item",
          turnId: "turn-2",
          item: { kind: "assistant_message", text: "hello again" },
        },
      );

      assert.equal(warnings.length, 1);
      assert.equal(warnings[0]?.code, "timeline.identity.missing");
      assert.equal(warnings[0]?.provider, "codex");
      assert.equal(warnings[0]?.itemKind, "assistant_message");
    } finally {
      resetTimelineIdentityTelemetryForTests();
    }
  });

  test("does not warn for local live user echoes without provider identity", () => {
    resetTimelineIdentityTelemetryForTests();
    const warnings: TimelineIdentityTelemetryWarning[] = [];
    setTimelineIdentityTelemetryWarnSinkForTests((warning) => warnings.push(warning));
    const services = createServices();
    const sessionId = createSession(services);

    try {
      applyProviderActivity(
        services,
        sessionId,
        { provider: "codex", channel: "structured_live", authority: "derived" },
        {
          type: "timeline_item",
          turnId: "turn-1",
          item: { kind: "user_message", text: "hello" },
        },
      );

      assert.equal(warnings.length, 0);
    } finally {
      resetTimelineIdentityTelemetryForTests();
    }
  });

  test("warns when the same canonical timeline item id has conflicting identity fields", () => {
    resetTimelineIdentityTelemetryForTests();
    const warnings: TimelineIdentityTelemetryWarning[] = [];
    setTimelineIdentityTelemetryWarnSinkForTests((warning) => warnings.push(warning));
    const services = createServices();
    const sessionId = createSession(services);
    const firstIdentity = createTimelineIdentity({
      provider: "codex",
      providerSessionId: "provider-session-1",
      turnKey: "turn-1",
      itemKind: "assistant_message",
      itemKey: "message-1",
      origin: "live",
    });
    const conflictingIdentity = {
      ...firstIdentity,
      canonicalTurnId: "different-turn-id",
    };

    try {
      applyProviderActivity(
        services,
        sessionId,
        { provider: "codex" },
        {
          type: "timeline_item",
          turnId: "turn-1",
          item: { kind: "assistant_message", text: "hello" },
          identity: firstIdentity,
        },
      );
      applyProviderActivity(
        services,
        sessionId,
        { provider: "codex" },
        {
          type: "timeline_item",
          turnId: "turn-1",
          item: { kind: "assistant_message", text: "hello from history" },
          identity: conflictingIdentity,
        },
      );

      assert.equal(warnings.length, 1);
      assert.equal(warnings[0]?.code, "timeline.identity.collision");
      assert.equal(warnings[0]?.canonicalItemId, firstIdentity.canonicalItemId);
    } finally {
      resetTimelineIdentityTelemetryForTests();
    }
  });
});

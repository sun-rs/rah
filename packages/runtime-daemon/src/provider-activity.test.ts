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

describe("applyProviderActivity", () => {
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
    assert.ok(
      services.eventBus.list({ sessionIds: [sessionId] }).some(
        (event) =>
          event.type === "attention.required" &&
          event.payload.item.reason === "permission_needed",
      ),
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
    assert.ok(
      services.eventBus.list({ sessionIds: [sessionId] }).some(
        (event) =>
          event.type === "attention.cleared" &&
          event.payload.id === "attention-permission-perm-1",
      ),
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

  test("turn failures request attention without notifying successful turns", () => {
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

    const attentionEvents = services.eventBus.list({ sessionIds: [sessionId] }).filter(
      (event) => event.type === "attention.required",
    );
    assert.deepEqual(attentionEvents.map((event) => event.payload.item.reason), ["turn_failed"]);
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
      frames.some((frame) =>
        JSON.stringify(frame) ===
        JSON.stringify({
          type: "pty.output",
          sessionId,
          data: "line one\r\n",
        }),
      ),
    );
    assert.ok(
      frames.some((frame) =>
        JSON.stringify(frame) ===
        JSON.stringify({
          type: "pty.exited",
          sessionId,
          exitCode: 0,
        }),
      ),
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

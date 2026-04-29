import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  formatRahConformanceReport,
  rahEventTier,
  validateRahEventSequence,
  type ProviderKind,
  type RahEvent,
} from "@rah/runtime-protocol";
import {
  createCodexAppServerTranslationState,
  translateCodexAppServerNotification,
  type CodexLiveTranslatedActivity,
} from "./codex-app-server-activity";
import { EventBus } from "./event-bus";
import { applyProviderActivity, type ProviderActivity } from "./provider-activity";
import { PtyHub } from "./pty-hub";
import { SessionStore } from "./session-store";

function createServices() {
  return {
    eventBus: new EventBus(),
    ptyHub: new PtyHub(),
    sessionStore: new SessionStore(),
  };
}

function createSession(
  services: ReturnType<typeof createServices>,
  provider: ProviderKind = "codex",
) {
  return services.sessionStore.createManagedSession({
    provider,
    launchSource: "web",
    cwd: "/workspace/demo",
    rootDir: "/workspace/demo",
    title: "demo",
  }).session.id;
}

function assertConforms(events: RahEvent[]) {
  const report = validateRahEventSequence(events, {
    requireRawForHeuristic: true,
    requireTurnScopedWork: true,
  });
  assert.equal(report.ok, true, formatRahConformanceReport(report));
}

function applyActivity(
  services: ReturnType<typeof createServices>,
  sessionId: string,
  activity: ProviderActivity,
) {
  applyProviderActivity(
    services,
    sessionId,
    { provider: "codex", raw: { test: activity.type } },
    activity,
  );
}

describe("RAH event contract", () => {
  test("separates core workbench events from infrastructure events", () => {
    assert.equal(rahEventTier("timeline.item.added"), "core_workbench");
    assert.equal(rahEventTier("tool.call.started"), "core_workbench");
    assert.equal(rahEventTier("observation.completed"), "core_workbench");
    assert.equal(rahEventTier("permission.requested"), "core_workbench");
    assert.equal(rahEventTier("operation.started"), "infrastructure");
    assert.equal(rahEventTier("runtime.status"), "infrastructure");
    assert.equal(rahEventTier("notification.emitted"), "infrastructure");
    assert.equal(rahEventTier("host.updated"), "infrastructure");
  });

  test("ProviderActivity can publish the full canonical backend surface", () => {
    const services = createServices();
    const sessionId = createSession(services);
    const turnId = "turn-1";

    applyActivity(services, sessionId, { type: "turn_started", turnId });
    applyActivity(services, sessionId, {
      type: "turn_step_started",
      turnId,
      index: 0,
      title: "Inspect",
    });
    applyActivity(services, sessionId, {
      type: "turn_input_appended",
      turnId,
      text: "continue",
    });
    applyActivity(services, sessionId, {
      type: "timeline_item",
      turnId,
      item: { kind: "assistant_message", text: "Working" },
    });
    applyActivity(services, sessionId, {
      type: "timeline_item_updated",
      turnId,
      item: { kind: "assistant_message", text: "Working now" },
    });
    applyActivity(services, sessionId, {
      type: "message_part_added",
      turnId,
      part: {
        messageId: "message-1",
        partId: "part-1",
        kind: "text",
        text: "Working",
      },
    });
    applyActivity(services, sessionId, {
      type: "message_part_delta",
      turnId,
      part: {
        messageId: "message-1",
        partId: "part-1",
        kind: "text",
        delta: " now",
      },
    });
    applyActivity(services, sessionId, {
      type: "message_part_updated",
      turnId,
      part: {
        messageId: "message-1",
        partId: "part-1",
        kind: "text",
        text: "Working now",
      },
    });
    applyActivity(services, sessionId, {
      type: "message_part_removed",
      turnId,
      messageId: "message-1",
      partId: "part-1",
    });
    applyActivity(services, sessionId, {
      type: "tool_call_started",
      turnId,
      toolCall: {
        id: "tool-1",
        family: "shell",
        providerToolName: "exec_command",
        title: "Run command",
        input: { command: "echo ok" },
      },
    });
    applyActivity(services, sessionId, {
      type: "tool_call_delta",
      turnId,
      toolCallId: "tool-1",
      detail: {
        artifacts: [{ kind: "text", label: "stdout", text: "ok" }],
      },
    });
    applyActivity(services, sessionId, {
      type: "observation_started",
      turnId,
      observation: {
        id: "obs-tool-1",
        kind: "command.run",
        status: "running",
        title: "Run command",
        subject: { command: "echo ok", providerCallId: "tool-1" },
      },
    });
    applyActivity(services, sessionId, {
      type: "observation_updated",
      turnId,
      observation: {
        id: "obs-tool-1",
        kind: "command.run",
        status: "running",
        title: "Run command",
        subject: { command: "echo ok", providerCallId: "tool-1" },
        detail: {
          artifacts: [{ kind: "text", label: "stdout", text: "ok" }],
        },
      },
    });
    applyActivity(services, sessionId, {
      type: "observation_completed",
      turnId,
      observation: {
        id: "obs-tool-1",
        kind: "command.run",
        status: "completed",
        title: "Run command",
        exitCode: 0,
      },
    });
    applyActivity(services, sessionId, {
      type: "tool_call_completed",
      turnId,
      toolCall: {
        id: "tool-1",
        family: "shell",
        providerToolName: "exec_command",
        result: { exitCode: 0 },
      },
    });
    applyActivity(services, sessionId, {
      type: "permission_requested",
      turnId,
      request: {
        id: "perm-1",
        kind: "tool",
        title: "Allow command",
        actions: [
          { id: "allow", label: "Allow", behavior: "allow" },
          { id: "deny", label: "Deny", behavior: "deny" },
        ],
      },
    });
    applyActivity(services, sessionId, {
      type: "permission_resolved",
      turnId,
      resolution: {
        requestId: "perm-1",
        behavior: "allow",
      },
    });
    applyActivity(services, sessionId, {
      type: "operation_started",
      turnId,
      operation: {
        id: "hook-1",
        kind: "automation",
        name: "pre-tool hook",
        target: "exec_command",
      },
    });
    applyActivity(services, sessionId, {
      type: "operation_resolved",
      turnId,
      operation: {
        id: "hook-1",
        kind: "automation",
        name: "pre-tool hook",
        target: "exec_command",
        action: "allow",
      },
    });
    applyActivity(services, sessionId, {
      type: "operation_requested",
      turnId,
      operation: {
        id: "external-1",
        kind: "external_tool",
        name: "client operation",
        target: "browser",
      },
    });
    applyActivity(services, sessionId, {
      type: "governance_updated",
      turnId,
      policy: { approvals: "on-request" },
    });
    applyActivity(services, sessionId, {
      type: "runtime_status",
      turnId,
      status: "streaming",
      detail: "assistant delta",
    });
    applyActivity(services, sessionId, {
      type: "usage",
      turnId,
      usage: { usedTokens: 100, contextWindow: 1000, percentUsed: 10, percentRemaining: 90 },
    });
    applyActivity(services, sessionId, {
      type: "attention",
      item: {
        id: "attention-1",
        sessionId,
        level: "info",
        reason: "turn_finished",
        title: "Turn finished",
        body: "Ready",
        dedupeKey: "turn-finished",
        createdAt: new Date().toISOString(),
      },
    });
    applyActivity(services, sessionId, {
      type: "attention_cleared",
      id: "attention-1",
    });
    applyActivity(services, sessionId, {
      type: "notification",
      turnId,
      level: "info",
      title: "Done",
      body: "Turn completed",
    });
    applyActivity(services, sessionId, {
      type: "host_updated",
      hostId: "host-1",
      metadata: { os: "darwin" },
    });
    applyActivity(services, sessionId, {
      type: "transport_changed",
      status: "connected",
      subscriptionId: "sub-1",
    });
    applyActivity(services, sessionId, {
      type: "heartbeat",
      timestamp: Date.now(),
    });
    applyActivity(services, sessionId, {
      type: "turn_step_completed",
      turnId,
      index: 0,
      reason: "done",
    });
    applyActivity(services, sessionId, { type: "turn_completed", turnId });

    assertConforms(services.eventBus.list({ sessionIds: [sessionId] }));
  });

  test("Codex live translator emits contract-conformant reference events", () => {
    const services = createServices();
    const sessionId = createSession(services);
    const state = createCodexAppServerTranslationState();
    let currentTurnId: string | null = null;

    function applyTranslated(items: CodexLiveTranslatedActivity[]) {
      for (const item of items) {
        const activity =
          currentTurnId &&
          supportsTurnId(item.activity) &&
          item.activity.turnId === undefined &&
          item.activity.type !== "turn_started"
            ? { ...item.activity, turnId: currentTurnId }
            : item.activity;
        const events = applyProviderActivity(
          services,
          sessionId,
          {
            provider: "codex",
            ...(item.channel !== undefined ? { channel: item.channel } : {}),
            ...(item.authority !== undefined ? { authority: item.authority } : {}),
            ...(item.raw !== undefined ? { raw: item.raw } : {}),
            ...(item.ts !== undefined ? { ts: item.ts } : {}),
          },
          activity,
        );
        for (const event of events) {
          if (event.type === "turn.started") {
            currentTurnId = event.turnId ?? null;
          }
          if (
            event.type === "turn.completed" ||
            event.type === "turn.failed" ||
            event.type === "turn.canceled"
          ) {
            currentTurnId = null;
          }
        }
      }
    }

    function supportsTurnId(activity: CodexLiveTranslatedActivity["activity"]): activity is typeof activity & { turnId?: string } {
      return [
        "timeline_item",
        "timeline_item_updated",
        "message_part_added",
        "message_part_updated",
        "message_part_delta",
        "message_part_removed",
        "tool_call_started",
        "tool_call_delta",
        "tool_call_completed",
        "tool_call_failed",
        "observation_started",
        "observation_updated",
        "observation_completed",
        "observation_failed",
        "permission_requested",
        "permission_resolved",
        "operation_started",
        "operation_resolved",
        "operation_requested",
        "governance_updated",
        "runtime_status",
        "notification",
        "usage",
      ].includes(activity.type);
    }

    const notifications = [
      { method: "turn/started", params: { turn: { id: "turn-1" } } },
      { method: "item/agentMessage/delta", params: { itemId: "msg-1", delta: "Hello" } },
      {
        method: "item/reasoning/summaryTextDelta",
        params: { itemId: "reasoning-1", delta: "Inspecting" },
      },
      {
        method: "codex/event/exec_command_begin",
        params: {
          msg: {
            call_id: "call-1",
            command: "cat package.json",
            cwd: "/workspace/demo",
          },
        },
      },
      {
        method: "codex/event/exec_command_output_delta",
        params: { msg: { call_id: "call-1", chunk: "{}" } },
      },
      {
        method: "codex/event/exec_command_end",
        params: { msg: { call_id: "call-1", exit_code: 0 } },
      },
      {
        method: "codex/event/patch_apply_begin",
        params: { msg: { call_id: "patch-1" } },
      },
      {
        method: "item/fileChange/outputDelta",
        params: {
          itemId: "patch-1",
          delta: "Success. Updated the following files:\nM src/demo.ts",
        },
      },
      {
        method: "codex/event/patch_apply_end",
        params: { msg: { call_id: "patch-1", success: true } },
      },
      { method: "codex/event/new_future_event", params: { value: true } },
      { method: "turn/completed", params: { turn: { id: "turn-1", status: "completed" } } },
    ];

    for (const notification of notifications) {
      applyTranslated(translateCodexAppServerNotification(notification, state));
    }

    const events = services.eventBus.list({ sessionIds: [sessionId] });
    assert.ok(events.some((event) => event.type === "message.part.delta"));
    assert.ok(events.some((event) => event.type === "tool.call.delta"));
    assert.ok(events.some((event) => event.type === "observation.updated"));
    assert.ok(
      events.some(
        (event) =>
          event.type === "observation.completed" &&
          event.payload.observation.kind === "runtime.invalid_stream",
      ),
    );
    assertConforms(events);
  });

  test("event bus rejects invalid canonical events before they reach the UI", () => {
    const services = createServices();
    const sessionId = createSession(services);

    assert.throws(
      () =>
        applyProviderActivity(
          services,
          sessionId,
          { provider: "codex" },
          {
            type: "observation_completed",
            observation: {
              id: "obs-bad",
              kind: "command.run",
              status: "running",
              title: "Bad completed observation",
            },
          },
        ),
      /observation\.status\.mismatch/,
    );
    assert.equal(services.eventBus.list({ sessionIds: [sessionId] }).length, 0);
  });

  test("contract requires invalid_stream observations to retain raw heuristic evidence", () => {
    const sessionId = "session-1";
    const report = validateRahEventSequence(
      [
        {
          id: "event-1",
          seq: 1,
          ts: new Date().toISOString(),
          sessionId,
          turnId: "turn-1",
          type: "observation.completed",
          source: {
            provider: "codex",
            channel: "structured_live",
            authority: "heuristic",
          },
          payload: {
            observation: {
              id: "obs-1",
              kind: "runtime.invalid_stream",
              status: "completed",
              title: "Unknown provider event",
            },
          },
        },
      ],
      {
        requireRawForHeuristic: true,
      },
    );

    assert.equal(report.ok, false);
    assert.ok(
      report.errors.some((issue) => issue.code === "invalid_stream.raw.missing"),
      formatRahConformanceReport(report),
    );
  });

  test("contract rejects invalid_stream observations that are not heuristic", () => {
    const sessionId = "session-1";
    const report = validateRahEventSequence([
      {
        id: "event-1",
        seq: 1,
        ts: new Date().toISOString(),
        sessionId,
        turnId: "turn-1",
        type: "observation.completed",
        source: {
          provider: "codex",
          channel: "structured_live",
          authority: "derived",
        },
        payload: {
          observation: {
            id: "obs-1",
            kind: "runtime.invalid_stream",
            status: "completed",
            title: "Unknown provider event",
          },
        },
        raw: { method: "future/provider/event" },
      },
    ]);

    assert.equal(report.ok, false);
    assert.ok(
      report.errors.some((issue) => issue.code === "invalid_stream.authority.invalid"),
      formatRahConformanceReport(report),
    );
  });

  test("contract reports turn mismatches across tool and permission lifecycles", () => {
    const sessionId = "session-1";
    const report = validateRahEventSequence(
      [
        {
          id: "turn-start",
          seq: 1,
          ts: new Date().toISOString(),
          sessionId,
          turnId: "turn-1",
          type: "turn.started",
          source: { provider: "codex", channel: "structured_live", authority: "derived" },
          payload: {},
        },
        {
          id: "tool-start",
          seq: 2,
          ts: new Date().toISOString(),
          sessionId,
          turnId: "turn-1",
          type: "tool.call.started",
          source: { provider: "codex", channel: "structured_live", authority: "derived" },
          payload: {
            toolCall: {
              id: "tool-1",
              family: "shell",
              providerToolName: "exec_command",
            },
          },
        },
        {
          id: "perm-request",
          seq: 3,
          ts: new Date().toISOString(),
          sessionId,
          turnId: "turn-1",
          type: "permission.requested",
          source: { provider: "codex", channel: "structured_live", authority: "derived" },
          payload: {
            request: {
              id: "perm-1",
              kind: "tool",
              title: "Allow command",
            },
          },
        },
        {
          id: "turn-two-start",
          seq: 4,
          ts: new Date().toISOString(),
          sessionId,
          turnId: "turn-2",
          type: "turn.started",
          source: { provider: "codex", channel: "structured_live", authority: "derived" },
          payload: {},
        },
        {
          id: "tool-end",
          seq: 5,
          ts: new Date().toISOString(),
          sessionId,
          turnId: "turn-2",
          type: "tool.call.completed",
          source: { provider: "codex", channel: "structured_live", authority: "derived" },
          payload: {
            toolCall: {
              id: "tool-1",
              family: "shell",
              providerToolName: "exec_command",
            },
          },
        },
        {
          id: "perm-end",
          seq: 6,
          ts: new Date().toISOString(),
          sessionId,
          turnId: "turn-2",
          type: "permission.resolved",
          source: { provider: "codex", channel: "structured_live", authority: "derived" },
          payload: {
            resolution: {
              requestId: "perm-1",
              behavior: "allow",
            },
          },
        },
      ],
      {
        requireTurnScopedWork: true,
      },
    );

    assert.equal(report.ok, false);
    assert.ok(
      report.errors.some((issue) => issue.code === "tool.turn_id.mismatch"),
      formatRahConformanceReport(report),
    );
    assert.ok(
      report.errors.some((issue) => issue.code === "permission.turn_id.mismatch"),
      formatRahConformanceReport(report),
    );
  });

  test("event bus exposes replay gap bounds for reconnect logic", () => {
    const bus = new EventBus({ maxEvents: 3 });

    bus.publish({
      sessionId: "session-1",
      type: "runtime.status",
      source: {
        provider: "system",
        channel: "system",
        authority: "authoritative",
      },
      payload: {
        status: "session_active",
      },
    });
    bus.publish({
      sessionId: "session-1",
      type: "runtime.status",
      source: {
        provider: "system",
        channel: "system",
        authority: "authoritative",
      },
      payload: {
        status: "streaming",
      },
    });
    bus.publish({
      sessionId: "session-1",
      type: "runtime.status",
      source: {
        provider: "system",
        channel: "system",
        authority: "authoritative",
      },
      payload: {
        status: "connected",
      },
    });
    bus.publish({
      sessionId: "session-1",
      type: "runtime.status",
      source: {
        provider: "system",
        channel: "system",
        authority: "authoritative",
      },
      payload: {
        status: "session_active",
      },
    });

    assert.equal(bus.oldestSeq(), 2);
    assert.equal(bus.newestSeq(), 4);
  });

  test("event bus isolates subscriber failures", () => {
    const subscriberErrors: unknown[] = [];
    const bus = new EventBus({
      onSubscriberError: (error) => {
        subscriberErrors.push(error);
      },
    });
    let secondSubscriberCalled = false;

    bus.subscribe({}, () => {
      throw new Error("subscriber failed");
    });
    bus.subscribe({}, () => {
      secondSubscriberCalled = true;
    });

    assert.doesNotThrow(() => {
      bus.publish({
        sessionId: "session-1",
        type: "runtime.status",
        source: {
          provider: "system",
          channel: "system",
          authority: "authoritative",
        },
        payload: {
          status: "session_active",
        },
      });
    });
    assert.equal(secondSubscriberCalled, true);
    assert.equal(subscriberErrors.length, 1);
  });
});

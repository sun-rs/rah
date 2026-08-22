import assert from "node:assert/strict";
import test from "node:test";
import type {
  CouncilMessage,
  CouncilSnapshot,
  SessionInputRequest,
} from "@rah/runtime-protocol";
import { EventBus } from "../event-bus";
import {
  CouncilDeliveryCoordinator,
} from "./council-delivery-coordinator";
import { councilMessageTargetAgentIds } from "./council-message-routing";

const SOURCE = {
  provider: "system" as const,
  channel: "system" as const,
  authority: "authoritative" as const,
};

function snapshot(): CouncilSnapshot {
  return {
    id: "council-1",
    title: "Delivery Council",
    workspace: "/tmp",
    status: "running",
    phase: "ready",
    createdAt: "2026-08-23T00:00:00.000Z",
    updatedAt: "2026-08-23T00:00:00.000Z",
    agents: [{
      id: "Agent A",
      councilId: "council-1",
      label: "Agent A",
      provider: "codex",
      role: "Review the message batch.",
      status: "idle",
      updatedAt: "2026-08-23T00:00:00.000Z",
    }],
    messages: [],
  };
}

function message(id: number, text: string, role: CouncilMessage["role"] = "user"): CouncilMessage {
  return {
    id,
    councilId: "council-1",
    actorId: role === "agent" ? "Agent B" : "user",
    role,
    parts: [{ kind: "text", text }],
    createdAt: `2026-08-23T00:00:0${id}.000Z`,
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(predicate(), true);
}

test("coalesces busy Council messages and wakes once with their complete content", async () => {
  const eventBus = new EventBus();
  const sent: Array<{ sessionId: string; request: SessionInputRequest }> = [];
  let busy = true;
  const coordinator = new CouncilDeliveryCoordinator({
    eventBus,
    sendInput: (_agent, sessionId, request) => sent.push({ sessionId, request }),
    isSessionBusy: () => busy,
    updateStatus: () => undefined,
    councilSnapshot: snapshot,
  });
  const council = snapshot();
  coordinator.registerAgent({
    councilId: council.id,
    agent: council.agents[0]!,
    sessionId: "session-a",
    ready: true,
    cursor: 0,
  });

  coordinator.routeMessage(message(1, "first question"));
  coordinator.routeMessage(message(2, "second question", "agent"));
  await new Promise<void>((resolve) => setTimeout(resolve, 150));
  assert.equal(sent.length, 0, "busy provider turns retain messages in the daemon queue");

  busy = false;
  eventBus.publish({
    sessionId: "session-a",
    type: "turn.completed",
    turnId: "unrelated-busy-turn",
    source: SOURCE,
    payload: { completedAt: new Date().toISOString() },
  });
  await waitFor(() => sent.length === 1);
  assert.match(sent[0]!.request.text, /first question/);
  assert.match(sent[0]!.request.text, /second question/);
  assert.match(sent[0]!.request.text, /无需先调用 inbox、history 或 join/);
  assert.ok(sent[0]!.request.clientMessageId);
  assert.ok(sent[0]!.request.clientTurnId);

  eventBus.publish({
    sessionId: "session-a",
    type: "session.input.accepted",
    source: SOURCE,
    payload: {
      clientMessageId: sent[0]!.request.clientMessageId!,
      clientTurnId: sent[0]!.request.clientTurnId,
    },
  });
  assert.equal(coordinator.deliveryCursor(council.id, "Agent A"), 2);

  coordinator.routeMessage(message(3, "arrived while working"));
  await new Promise<void>((resolve) => setTimeout(resolve, 150));
  assert.equal(sent.length, 1, "an active wake owns one turn and later messages remain queued");

  eventBus.publish({
    sessionId: "session-a",
    type: "turn.completed",
    turnId: sent[0]!.request.clientTurnId!,
    source: SOURCE,
    payload: { completedAt: new Date().toISOString() },
  });
  await waitFor(() => sent.length === 2);
  assert.doesNotMatch(sent[1]!.request.text, /first question/);
  assert.match(sent[1]!.request.text, /arrived while working/);
  coordinator.shutdown();
});

test("keeps hot-wait delivery out of the wake queue and ignores lifecycle rows", async () => {
  const sent: SessionInputRequest[] = [];
  const coordinator = new CouncilDeliveryCoordinator({
    sendInput: (_agent, _sessionId, request) => sent.push(request),
    updateStatus: () => undefined,
    councilSnapshot: snapshot,
  });
  const council = snapshot();
  coordinator.registerAgent({
    councilId: council.id,
    agent: council.agents[0]!,
    sessionId: "session-a",
    ready: true,
  });

  coordinator.routeMessage(message(1, "delivered by waiter"), new Set(["Agent A"]));
  coordinator.routeMessage(message(2, "Agent A sleeping", "system"));
  await new Promise<void>((resolve) => setTimeout(resolve, 150));
  assert.equal(sent.length, 0);
  coordinator.shutdown();
});

test("narrows explicit Council mentions while leaving plain text and @all as broadcasts", () => {
  assert.deepEqual(
    [...(councilMessageTargetAgentIds(
      message(1, "@Agent A please review; @Agent B implement"),
      ["Agent A", "Agent B", "Agent C"],
    ) ?? [])],
    ["Agent A", "Agent B"],
  );
  assert.equal(
    councilMessageTargetAgentIds(message(2, "plain broadcast"), ["Agent A"]),
    null,
  );
  assert.equal(
    councilMessageTargetAgentIds(message(3, "@all discuss"), ["Agent A"]),
    null,
  );
  assert.equal(
    councilMessageTargetAgentIds(message(4, "mail@example.com"), ["example.com"]),
    null,
  );
});

test("retains MCP readiness that arrives before the managed-session start response", async () => {
  const sent: SessionInputRequest[] = [];
  const coordinator = new CouncilDeliveryCoordinator({
    sendInput: (_agent, _sessionId, request) => sent.push(request),
    updateStatus: () => undefined,
    councilSnapshot: snapshot,
  });
  const council = snapshot();
  coordinator.prepareAgent(council.id, "Agent A");
  coordinator.markReady(council.id, "Agent A");
  coordinator.registerAgent({
    councilId: council.id,
    agent: council.agents[0]!,
    sessionId: "session-a",
    ready: false,
  });
  coordinator.routeMessage(message(1, "ready raced start"));
  await waitFor(() => sent.length === 1);
  assert.match(sent[0]!.text, /ready raced start/);
  coordinator.shutdown();
});

test("settles an accepted ultra-short wake when the provider is already idle", async () => {
  const eventBus = new EventBus();
  const sent: SessionInputRequest[] = [];
  const lifecycles: string[] = [];
  const coordinator = new CouncilDeliveryCoordinator({
    eventBus,
    sendInput: (_agent, _sessionId, request) => sent.push(request),
    isSessionBusy: () => false,
    updateStatus: (_councilId, _agentId, _status, _detail, lifecycle) => {
      if (lifecycle) lifecycles.push(lifecycle);
    },
    councilSnapshot: snapshot,
  });
  const council = snapshot();
  coordinator.registerAgent({
    councilId: council.id,
    agent: council.agents[0]!,
    sessionId: "session-a",
    ready: true,
  });
  coordinator.routeMessage(message(1, "ultra short"));
  await waitFor(() => sent.length === 1);
  eventBus.publish({
    sessionId: "session-a",
    type: "session.input.accepted",
    source: SOURCE,
    payload: {
      clientMessageId: sent[0]!.clientMessageId!,
      clientTurnId: sent[0]!.clientTurnId!,
    },
  });
  await waitFor(() => lifecycles.includes("sleeping"));
  assert.equal(lifecycles.includes("working"), true);
  assert.equal(coordinator.requestRecovery(council.id, "Agent A"), true);
  coordinator.shutdown();
});

import assert from "node:assert/strict";
import { test } from "node:test";
import type { CouncilSnapshot } from "@rah/runtime-protocol";
import { projectCouncilDisplayItems } from "./council-display-items";

function snapshot(messages: CouncilSnapshot["messages"]): CouncilSnapshot {
  return {
    id: "council-1",
    title: "Council",
    workspace: "/tmp",
    status: "running",
    phase: "waiting",
    createdAt: "2026-07-16T00:00:00.000Z",
    updatedAt: "2026-07-16T00:00:00.000Z",
    agents: [],
    messages,
  };
}

function systemMessage(
  id: number,
  text: string,
  actorId = "agent-a",
): CouncilSnapshot["messages"][number] {
  return {
    id,
    councilId: "council-1",
    actorId,
    role: "system",
    parts: [{ kind: "text", text }],
    createdAt: `2026-07-16T00:00:0${id}.000Z`,
  };
}

test("projects one stable lifecycle row with the latest agent status", () => {
  const items = projectCouncilDisplayItems(snapshot([
    systemMessage(1, "agent-a sent"),
    systemMessage(2, "agent-a joined"),
    systemMessage(3, "agent-a listening"),
  ]));

  assert.deepEqual(
    items.map((item) => item.kind === "agent-status" ? item.status : item.kind),
    ["ready"],
  );
  assert.equal(items[0]?.kind === "agent-status" ? items[0].key : null, "agent-status:agent-a");
  assert.equal(items[0]?.kind === "agent-status" ? items[0].messageId : null, 3);
});

test("updates an agent status in its original timeline position", () => {
  const assistantMessage: CouncilSnapshot["messages"][number] = {
    id: 2,
    councilId: "council-1",
    actorId: "agent-a",
    role: "assistant",
    parts: [{ kind: "text", text: "Finished." }],
    createdAt: "2026-07-16T00:00:02.000Z",
  };
  const items = projectCouncilDisplayItems(snapshot([
    systemMessage(1, "agent-a sent"),
    assistantMessage,
    systemMessage(3, "agent-a listening"),
  ]));

  assert.deepEqual(items.map((item) => item.kind), ["agent-status", "message"]);
  assert.equal(items[0]?.kind === "agent-status" ? items[0].status : null, "ready");
});

test("keeps independent lifecycle rows for different agents", () => {
  const items = projectCouncilDisplayItems(snapshot([
    systemMessage(1, "agent-a sent"),
    systemMessage(2, "agent-b sent", "agent-b"),
    systemMessage(3, "agent-a listening"),
    systemMessage(4, "agent-b joined", "agent-b"),
  ]));

  assert.deepEqual(
    items.map((item) =>
      item.kind === "agent-status" ? `${item.actorId}:${item.status}` : item.kind
    ),
    ["agent-a:ready", "agent-b:joined"],
  );
});

test("folds daemon subscription, wake, hot-listening, and sleep into one lifecycle row", () => {
  const items = projectCouncilDisplayItems(snapshot([
    systemMessage(1, "agent-a subscribed"),
    systemMessage(2, "agent-a waking"),
    systemMessage(3, "agent-a working"),
    systemMessage(4, "agent-a queued"),
    systemMessage(5, "agent-a listening"),
    systemMessage(6, "agent-a sleeping"),
  ]));

  assert.equal(items.length, 1);
  assert.equal(items[0]?.kind === "agent-status" ? items[0].status : null, "sleeping");
  assert.equal(items[0]?.kind === "agent-status" ? items[0].messageId : null, 6);
});

test("filters only the wait timeout transport noise", () => {
  const items = projectCouncilDisplayItems(snapshot([
    systemMessage(1, "wait timed out; no active listener is currently blocking on channel_wait_new"),
    systemMessage(2, "agent-a joined"),
  ]));

  assert.equal(items.length, 1);
  assert.equal(items[0]?.kind, "agent-status");
});

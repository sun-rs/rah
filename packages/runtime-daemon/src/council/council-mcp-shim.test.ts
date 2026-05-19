import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CouncilStore } from "./council-store";
import { handleCouncilMcpRequest } from "./council-mcp-shim";

test("Council MCP shim handles join, post, history, wait, and status tools", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "rah-council-mcp-"));
  try {
    const store = new CouncilStore(path.join(root, "councils.json"));
    const council = store.createCouncil({
      workspace: root,
      agents: [
        { id: "agent-a", provider: "codex", label: "Agent A" },
        { id: "agent-b", provider: "claude", label: "Agent B" },
      ],
    });
    const agentA = council.agents[0]!.id;
    const agentB = council.agents[1]!.id;

    const joined = handleCouncilMcpRequest(store, {
      councilId: council.id,
      actorId: agentA,
      clientId: "client-a",
      tool: "channel_join",
    }) as { ok: true; result: { council: string; last_msg_id: number; recent_messages: unknown[] } };
    assert.equal(joined.ok, true);
    assert.equal(joined.result.council, council.id);
    assert.equal(joined.result.last_msg_id, 0);
    assert.deepEqual(joined.result.recent_messages, []);
    assert.equal(store.snapshot(council.id).agents[0]!.status, "idle");

    const posted = handleCouncilMcpRequest(store, {
      councilId: council.id,
      actorId: agentA,
      clientId: "client-a",
      tool: "channel_post",
      arguments: { content: "agent message" },
    }) as { ok: true; result: { msg_id: number; message: { actor: string; client_id: string; content: string } } };
    assert.equal(posted.result.msg_id, 1);
    assert.equal(posted.result.message.actor, agentA);
    assert.equal(posted.result.message.client_id, "client-a");
    assert.equal(posted.result.message.content, "agent message");

    const history = handleCouncilMcpRequest(store, {
      councilId: council.id,
      actorId: agentA,
      tool: "channel_history",
      arguments: { limit: 10 },
    }) as { ok: true; result: { messages: unknown[] } };
    assert.equal(history.result.messages.length, 1);

    const wait = await handleCouncilMcpRequest(store, {
      councilId: council.id,
      actorId: agentB,
      clientId: "client-b",
      tool: "channel_wait_new",
      arguments: { since_id: 0 },
    }) as { ok: true; result: { msg: { actor: string; client_id: string; content: string } } };
    assert.equal(wait.result.msg.actor, agentA);
    assert.equal(wait.result.msg.client_id, "client-a");
    assert.equal(wait.result.msg.content, "agent message");

    const selfWait = await handleCouncilMcpRequest(store, {
      councilId: council.id,
      actorId: agentA,
      clientId: "client-a",
      tool: "channel_wait_new",
      arguments: { since_id: 0 },
    }) as { ok: true; result: { timed_out: true } };
    assert.equal(selfWait.result.timed_out, true);

    handleCouncilMcpRequest(store, {
      councilId: council.id,
      actorId: agentA,
      tool: "channel_set_status",
      arguments: { phase: "thinking", detail: "working" },
    });
    assert.equal(store.snapshot(council.id).agents[0]!.status, "thinking");
    assert.equal(store.snapshot(council.id).agents[0]!.lastStatusDetail, "working");

    assert.throws(
      () => handleCouncilMcpRequest(store, {
        councilId: council.id,
        actorId: "intruder",
        tool: "channel_history",
      }),
      /Unknown council agent intruder/,
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

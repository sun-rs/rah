import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CouncilStore } from "./council-store";
import { handleCouncilMcpRequest } from "./council-mcp-shim";

test("Council MCP shim handles join, post, history, wait, and status tools", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "rah-council-mcp-"));
  try {
    const store = new CouncilStore(path.join(root, "rooms.json"));
    const room = store.createRoom({
      workspace: root,
      agents: [{ id: "agent-a", provider: "codex", label: "Agent A" }],
    });

    const joined = handleCouncilMcpRequest(store, {
      roomId: room.room.id,
      actorId: "agent-a",
      tool: "channel_join",
    });
    assert.equal(joined.ok, true);
    assert.equal(store.snapshot(room.room.id).agents[0]!.status, "idle");

    const posted = handleCouncilMcpRequest(store, {
      roomId: room.room.id,
      actorId: "agent-a",
      tool: "channel_post",
      arguments: { content: "agent message" },
    });
    assert.equal((posted.result as { actorId: string }).actorId, "agent-a");

    const history = handleCouncilMcpRequest(store, {
      roomId: room.room.id,
      actorId: "agent-a",
      tool: "channel_history",
      arguments: { limit: 10 },
    });
    assert.equal((history.result as unknown[]).length, 1);

    handleCouncilMcpRequest(store, {
      roomId: room.room.id,
      actorId: "agent-a",
      tool: "channel_set_status",
      arguments: { phase: "thinking", detail: "working" },
    });
    assert.equal(store.snapshot(room.room.id).agents[0]!.status, "thinking");
    assert.equal(store.snapshot(room.room.id).agents[0]!.lastStatusDetail, "working");

    assert.throws(
      () => handleCouncilMcpRequest(store, {
        roomId: room.room.id,
        actorId: "intruder",
        tool: "channel_history",
      }),
      /Unknown council agent intruder/,
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

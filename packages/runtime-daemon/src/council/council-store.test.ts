import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CouncilStore } from "./council-store";

test("CouncilStore persists rooms, agents, ordered messages, and stopped status", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "rah-council-store-"));
  const filePath = path.join(root, "rooms.json");
  try {
    const store = new CouncilStore(filePath);
    const created = store.createRoom({
      title: "Runtime Council",
      workspace: root,
      agents: [
        { id: "codex-lead", provider: "codex", label: "Codex Lead" },
        { id: "codex-lead", provider: "claude", label: "Claude Reviewer" },
      ],
    });

    assert.equal(created.room.title, "Runtime Council");
    assert.equal(created.agents.length, 2);
    assert.deepEqual(created.agents.map((agent) => agent.id), ["Codex Lead", "Claude Reviewer"]);
    assert.deepEqual(created.agents.map((agent) => agent.label), ["Codex Lead", "Claude Reviewer"]);
    assert.deepEqual(created.storage, {
      storePath: filePath,
      messageLogPath: path.join(root, "messages", `${encodeURIComponent(created.room.id)}.jsonl`),
    });

    const first = store.appendMessage({
      roomId: created.room.id,
      actorId: "user",
      role: "user",
      text: "请讨论方案",
    });
    const second = store.appendMessage({
      roomId: created.room.id,
      actorId: created.agents[0]!.id,
      role: "agent",
      text: "  收到\n",
    });
    assert.equal(second.id, first.id + 1);
    assert.equal(second.parts[0]?.kind === "text" ? second.parts[0].text : "", "  收到\n");
    assert.deepEqual(
      store.snapshot(created.room.id, { sinceMessageId: first.id }).messages.map((message) => message.id),
      [second.id],
    );

    store.updateAgent(created.room.id, created.agents[0]!.id, {
      status: "idle",
      zellijPaneId: "terminal_1",
    });
    store.stopRoom(created.room.id);
    const persisted = JSON.parse(readFileSync(filePath, "utf8")) as { messages?: unknown[] };
    assert.deepEqual(persisted.messages, []);
    assert.ok(existsSync(path.join(root, "messages", `${encodeURIComponent(created.room.id)}.jsonl`)));

    const reloaded = new CouncilStore(filePath);
    const snapshot = reloaded.snapshot(created.room.id);
    assert.equal(snapshot.room.status, "stopped");
    assert.equal(snapshot.agents[0]!.status, "stopped");
    assert.equal(snapshot.agents[0]!.zellijPaneId, "terminal_1");
    assert.equal(snapshot.messages.length, 2);

    reloaded.deleteRoom(created.room.id);
    assert.equal(reloaded.listRooms().length, 0);
    assert.throws(() => reloaded.snapshot(created.room.id), /Unknown council room/);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("CouncilStore normalizes slashes in agent labels and ids", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "rah-council-store-label-"));
  const filePath = path.join(root, "rooms.json");
  try {
    const store = new CouncilStore(filePath);
    const created = store.createRoom({
      workspace: root,
      agents: [
        { provider: "opencode", label: "aihubmix/grok-4.3/high" },
        { provider: "codex", label: "", id: "gpt-5.5/xhigh" },
      ],
    });
    assert.deepEqual(
      created.agents.map((agent) => agent.id),
      ["aihubmix-grok-4.3-high", "gpt-5.5-xhigh"],
    );

    const added = store.addAgent(created.room.id, {
      provider: "claude",
      label: "default/max",
    });
    assert.equal(added.id, "default-max");
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("CouncilStore marks rooms and active agents failed with diagnostic detail", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "rah-council-store-fail-"));
  try {
    const store = new CouncilStore(path.join(root, "rooms.json"));
    const created = store.createRoom({
      workspace: root,
      agents: [{ id: "agent-a", provider: "codex", label: "Agent A" }],
    });

    const failed = store.failRoom(created.room.id, "launch failed");

    assert.equal(failed.room.status, "failed");
    assert.equal(failed.room.error, "launch failed");
    assert.equal(failed.agents[0]!.status, "failed");
    assert.equal(failed.agents[0]!.lastStatusDetail, "launch failed");
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("CouncilStore assigns numbered room titles when title is omitted", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "rah-council-store-title-"));
  try {
    const store = new CouncilStore(path.join(root, "rooms.json"));
    const first = store.createRoom({
      workspace: root,
      agents: [{ provider: "codex", label: "Codex" }],
    });
    const second = store.createRoom({
      title: "  ",
      workspace: root,
      agents: [{ provider: "claude", label: "Claude" }],
    });
    const named = store.createRoom({
      title: "Architecture Review",
      workspace: root,
      agents: [{ provider: "opencode", label: "OpenCode" }],
    });

    assert.equal(first.room.title, "Room-0001");
    assert.equal(second.room.title, "Room-0002");
    assert.equal(named.room.title, "Architecture Review");
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CouncilStore } from "./council-store";

test("CouncilStore persists councils, agents, ordered messages, and stopped status", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "rah-council-store-"));
  const filePath = path.join(root, "councils.json");
  try {
    const store = new CouncilStore(filePath);
    const created = store.createCouncil({
      title: "Runtime Council",
      workspace: root,
      agents: [
        { id: "codex-lead", provider: "codex", label: "Codex Lead" },
        { id: "codex-lead", provider: "claude", label: "Claude Reviewer" },
      ],
    });

    assert.equal(created.title, "Runtime Council");
    assert.equal(created.agents.length, 2);
    assert.deepEqual(created.agents.map((agent) => agent.id), ["Codex Lead", "Claude Reviewer"]);
    assert.deepEqual(created.agents.map((agent) => agent.label), ["Codex Lead", "Claude Reviewer"]);
    assert.deepEqual(created.storage, {
      storePath: filePath,
      messageLogPath: path.join(root, "messages", `${encodeURIComponent(created.id)}.jsonl`),
    });

    const first = store.appendMessage({
      councilId: created.id,
      actorId: "user",
      role: "user",
      text: "请讨论方案",
    });
    const second = store.appendMessage({
      councilId: created.id,
      actorId: created.agents[0]!.id,
      role: "agent",
      text: "  收到\n",
    });
    assert.equal(second.id, first.id + 1);
    assert.equal(second.parts[0]?.kind === "text" ? second.parts[0].text : "", "  收到\n");
    assert.deepEqual(
      store.snapshot(created.id, { sinceMessageId: first.id }).messages.map((message) => message.id),
      [second.id],
    );

    const renamedRunning = store.updateCouncil(created.id, { title: "Renamed Running Council" });
    assert.equal(renamedRunning.title, "Renamed Running Council");

    store.updateAgent(created.id, created.agents[0]!.id, {
      status: "idle",
      terminalId: "terminal_1",
    });
    store.stopCouncil(created.id);
    const renamedStopped = store.updateCouncil(created.id, { title: "Renamed Stopped Council" });
    assert.equal(renamedStopped.title, "Renamed Stopped Council");
    const persisted = JSON.parse(readFileSync(filePath, "utf8")) as { messages?: unknown[] };
    assert.deepEqual(persisted.messages, []);
    assert.ok(existsSync(path.join(root, "messages", `${encodeURIComponent(created.id)}.jsonl`)));

    const reloaded = new CouncilStore(filePath);
    const snapshot = reloaded.snapshot(created.id);
    assert.equal(snapshot.title, "Renamed Stopped Council");
    assert.equal(snapshot.status, "stopped");
    assert.equal(snapshot.agents[0]!.status, "stopped");
    assert.equal(snapshot.agents[0]!.terminalId, "terminal_1");
    assert.equal(snapshot.messages.length, 2);

    reloaded.deleteCouncil(created.id);
    assert.equal(reloaded.listCouncils().length, 0);
    assert.throws(() => reloaded.snapshot(created.id), /Unknown council/);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("CouncilStore normalizes slashes in agent labels and ids", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "rah-council-store-label-"));
  const filePath = path.join(root, "councils.json");
  try {
    const store = new CouncilStore(filePath);
    const created = store.createCouncil({
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

    const added = store.addAgent(created.id, {
      provider: "claude",
      label: "default/max",
    });
    assert.equal(added.id, "default-max");
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("CouncilStore snapshot returns the full transcript unless a limit is requested", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "rah-council-store-full-snapshot-"));
  try {
    const store = new CouncilStore(path.join(root, "councils.json"));
    const created = store.createCouncil({
      workspace: root,
      agents: [{ id: "agent-a", provider: "codex", label: "Agent A" }],
    });

    const first = store.appendMessage({
      councilId: created.id,
      actorId: "user",
      role: "user",
      text: "first message",
    });
    for (let index = 0; index < 220; index += 1) {
      store.appendMessage({
        councilId: created.id,
        actorId: created.agents[0]!.id,
        role: "agent",
        text: `agent message ${index + 1}`,
      });
    }

    const full = store.snapshot(created.id);
    assert.equal(full.messages.length, 221);
    assert.equal(full.messages[0]!.id, first.id);
    assert.equal(full.messages[0]!.parts[0]?.kind === "text" ? full.messages[0]!.parts[0].text : "", "first message");

    const limited = store.snapshot(created.id, { limit: 200 });
    assert.equal(limited.messages.length, 200);
    assert.equal(limited.messages[0]!.id, first.id + 21);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("CouncilStore exposes message metadata, tail windows, and older pages", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "rah-council-store-message-window-"));
  try {
    const store = new CouncilStore(path.join(root, "councils.json"));
    const created = store.createCouncil({
      title: "Windowed Council",
      workspace: root,
      agents: [{ id: "agent-a", provider: "codex", label: "Agent A" }],
    });

    const first = store.appendMessage({
      councilId: created.id,
      actorId: "user",
      role: "user",
      text: "first question",
    });
    store.appendMessage({
      councilId: created.id,
      actorId: created.agents[0]!.id,
      role: "agent",
      text: "first answer",
    });
    for (let index = 0; index < 8; index += 1) {
      store.appendMessage({
        councilId: created.id,
        actorId: created.agents[0]!.id,
        role: "agent",
        text: `tail ${index + 1}`,
      });
    }

    const [listed] = store.listCouncils({ messageLimit: 3 });
    assert.equal(listed!.messages.length, 3);
    assert.equal(listed!.meta?.messageCount, 10);
    assert.equal(listed!.meta?.firstUserMessage?.id, first.id);
    assert.equal(listed!.meta?.firstUserMessage?.text, "first question");
    assert.equal(listed!.meta?.lastContentMessage?.text, "tail 8");
    assert.equal(listed!.messageWindow?.hasMoreBefore, true);
    assert.equal(listed!.messageWindow?.nextBeforeMessageId, listed!.messages[0]!.id);

    const older = store.messagePage(created.id, {
      beforeMessageId: listed!.messageWindow!.nextBeforeMessageId,
      limit: 4,
    });
    assert.equal(older.messages.length, 4);
    assert.equal(older.total, 10);
    assert.equal(older.hasMoreBefore, true);
    assert.equal(older.nextBeforeMessageId, older.messages[0]!.id);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("CouncilStore marks councils and active agents failed with diagnostic detail", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "rah-council-store-fail-"));
  try {
    const store = new CouncilStore(path.join(root, "councils.json"));
    const created = store.createCouncil({
      workspace: root,
      agents: [{ id: "agent-a", provider: "codex", label: "Agent A" }],
    });

    const failed = store.failCouncil(created.id, "launch failed");

    assert.equal(failed.status, "stopped");
    assert.equal(failed.phase, "failed");
    assert.equal(failed.error, "launch failed");
    assert.equal(failed.agents[0]!.status, "failed");
    assert.equal(failed.agents[0]!.lastStatusDetail, "launch failed");
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("CouncilStore assigns numbered council titles when title is omitted", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "rah-council-store-title-"));
  try {
    const store = new CouncilStore(path.join(root, "councils.json"));
    const first = store.createCouncil({
      workspace: root,
      agents: [{ provider: "codex", label: "Codex" }],
    });
    const second = store.createCouncil({
      title: "  ",
      workspace: root,
      agents: [{ provider: "claude", label: "Claude" }],
    });
    const named = store.createCouncil({
      title: "Architecture Review",
      workspace: root,
      agents: [{ provider: "opencode", label: "OpenCode" }],
    });

    assert.equal(first.title, "Council-0001");
    assert.equal(second.title, "Council-0002");
    assert.equal(named.title, "Architecture Review");
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

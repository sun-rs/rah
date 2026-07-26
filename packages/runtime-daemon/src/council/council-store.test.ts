import assert from "node:assert/strict";
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CouncilStore } from "./council-store";

test("CouncilStore persists councils, agents, ordered messages, and stopped status", async () => {
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
    await store.flush();
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
    await reloaded.flush();
    assert.equal(
      existsSync(path.join(root, "messages", `${encodeURIComponent(created.id)}.jsonl`)),
      false,
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("CouncilStore normalizes slashes in agent labels and ids", async () => {
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
    await store.flush();
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("CouncilStore normalizes file claim paths before conflict checks", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "rah-council-store-claims-"));
  try {
    const store = new CouncilStore(path.join(root, "councils.json"));
    const created = store.createCouncil({
      workspace: root,
      agents: [
        { id: "agent-a", provider: "codex", label: "Agent A" },
        { id: "agent-b", provider: "claude", label: "Agent B" },
      ],
    });

    const claim = store.claimFile(created.id, created.agents[0]!.id, "./src/../src/file.ts");
    assert.equal(claim.path, "src/file.ts");
    assert.throws(
      () => store.claimFile(created.id, created.agents[1]!.id, "src/file.ts"),
      /file_conflict: src\/file\.ts is already claimed by Agent A/,
    );

    assert.equal(store.releaseFile(created.id, created.agents[0]!.id, "src/./file.ts"), true);
    assert.equal(
      store.claimFile(created.id, created.agents[1]!.id, path.join(root, "src", "file.ts")).path,
      "src/file.ts",
    );
    assert.throws(
      () => store.claimFile(created.id, created.agents[0]!.id, path.join(root, "..", "outside.ts")),
      /must remain inside the council workspace/,
    );
    await store.flush();
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("CouncilStore snapshot returns the full transcript unless a limit is requested", async () => {
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
    await store.flush();
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("CouncilStore exposes message metadata, tail windows, and older pages", async () => {
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
    await store.flush();
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("CouncilStore lists persisted metadata without loading transcripts and recovers stale message ids", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "rah-council-store-lazy-meta-"));
  const filePath = path.join(root, "councils.json");
  try {
    const store = new CouncilStore(filePath);
    const created = store.createCouncil({
      workspace: root,
      agents: [{ provider: "codex", label: "Agent A" }],
    });
    const first = store.appendMessage({
      councilId: created.id,
      actorId: "user",
      role: "user",
      text: "first question",
    });
    store.appendMessage({
      councilId: created.id,
      actorId: "system",
      role: "system",
      text: "wait timed out; no active listener is currently blocking on channel_wait_new",
    });
    store.appendMessage({
      councilId: created.id,
      actorId: created.agents[0]!.id,
      role: "agent",
      text: "first answer",
    });

    await store.flush();
    const persisted = JSON.parse(readFileSync(filePath, "utf8")) as Record<string, unknown>;
    persisted.nextMessageId = 1;
    writeFileSync(filePath, `${JSON.stringify(persisted, null, 2)}\n`, "utf8");

    const recovered = new CouncilStore(filePath);
    const appended = recovered.appendMessage({
      councilId: created.id,
      actorId: created.agents[0]!.id,
      role: "agent",
      text: "second answer",
    });
    assert.equal(appended.id, first.id + 3);

    await recovered.flush();
    const lazy = new CouncilStore(filePath);
    const [summary] = lazy.listCouncils({
      metadataOnly: true,
    });
    assert.equal(summary!.messages.length, 0);
    assert.equal(summary!.meta?.messageCount, 3);
    assert.equal(summary!.meta?.firstUserMessage?.text, "first question");
    assert.equal(summary!.meta?.lastContentMessage?.text, "second answer");

    rmSync(summary!.storage!.messageLogPath, { force: true });
    const [metadataAfterLogRemoval] = lazy.listCouncils({
      metadataOnly: true,
    });
    assert.equal(metadataAfterLogRemoval!.meta?.messageCount, 3);
    assert.deepEqual(lazy.messagePage(created.id, { limit: 20 }).messages, []);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("CouncilStore migrates legacy inline messages when no message log exists", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "rah-council-store-legacy-inline-"));
  const filePath = path.join(root, "councils.json");
  try {
    const store = new CouncilStore(filePath);
    const created = store.createCouncil({
      workspace: root,
      agents: [{ provider: "codex", label: "Agent A" }],
    });
    await store.flush();
    const persisted = JSON.parse(readFileSync(filePath, "utf8")) as Record<string, unknown>;
    delete persisted.messageMeta;
    persisted.messages = [{
      id: 1,
      councilId: created.id,
      actorId: "user",
      role: "user",
      parts: [{ kind: "text", text: "legacy inline question" }],
      createdAt: new Date().toISOString(),
    }];
    persisted.nextMessageId = 2;
    writeFileSync(filePath, `${JSON.stringify(persisted, null, 2)}\n`, "utf8");

    const migrated = new CouncilStore(filePath);
    assert.equal(migrated.snapshot(created.id).messages[0]?.parts[0]?.kind, "text");
    assert.equal(migrated.listCouncils({ metadataOnly: true })[0]?.meta?.messageCount, 1);
    const migratedFile = JSON.parse(readFileSync(filePath, "utf8")) as { messages?: unknown[] };
    assert.deepEqual(migratedFile.messages, []);
    await migrated.flush();
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("CouncilStore marks councils and active agents failed with diagnostic detail", async () => {
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
    await store.flush();
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("CouncilStore assigns numbered council titles when title is omitted", async () => {
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
    await store.flush();
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("CouncilStore keeps the event loop responsive while flushing a large message batch", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "rah-council-store-pressure-"));
  const filePath = path.join(root, "councils.json");
  try {
    const store = new CouncilStore(filePath);
    const created = store.createCouncil({
      workspace: root,
      agents: [{ provider: "codex", label: "Agent A" }],
    });
    const messageCount = 6_000;
    for (let index = 0; index < messageCount; index += 1) {
      store.appendMessage({
        councilId: created.id,
        actorId: created.agents[0]!.id,
        role: "agent",
        text: `message ${index + 1} ${"x".repeat(160)}`,
      });
    }

    let heartbeatTicks = 0;
    const heartbeat = setInterval(() => {
      heartbeatTicks += 1;
    }, 1);
    try {
      await store.flush();
    } finally {
      clearInterval(heartbeat);
    }

    assert.ok(
      heartbeatTicks > 0,
      "Council persistence should yield while serializing and writing a large batch",
    );
    const messageLogPath = path.join(
      root,
      "messages",
      `${encodeURIComponent(created.id)}.jsonl`,
    );
    assert.equal(
      readFileSync(messageLogPath, "utf8").trim().split("\n").length,
      messageCount,
    );
    const reloaded = new CouncilStore(filePath);
    const [summary] = reloaded.listCouncils({ metadataOnly: true });
    assert.equal(summary?.meta?.messageCount, messageCount);
    assert.equal(reloaded.lastMessageId(created.id), messageCount);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("CouncilStore truncates an interrupted journal tail before appending again", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "rah-council-store-tail-repair-"));
  const filePath = path.join(root, "councils.json");
  try {
    const store = new CouncilStore(filePath);
    const created = store.createCouncil({
      workspace: root,
      agents: [{ provider: "codex", label: "Agent A" }],
    });
    const first = store.appendMessage({
      councilId: created.id,
      actorId: created.agents[0]!.id,
      role: "agent",
      text: "first complete message",
    });
    await store.flush();

    const messageLogPath = path.join(
      root,
      "messages",
      `${encodeURIComponent(created.id)}.jsonl`,
    );
    appendFileSync(messageLogPath, '{"id":2,"councilId":"interrupted');

    const recovered = new CouncilStore(filePath);
    const second = recovered.appendMessage({
      councilId: created.id,
      actorId: created.agents[0]!.id,
      role: "agent",
      text: "second complete message",
    });
    assert.equal(second.id, first.id + 1);
    await recovered.flush();

    const reloaded = new CouncilStore(filePath);
    assert.deepEqual(
      reloaded.snapshot(created.id).messages.map((message) => message.id),
      [first.id, second.id],
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("CouncilStore treats retried journal records as idempotent", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "rah-council-store-idempotent-log-"));
  const filePath = path.join(root, "councils.json");
  try {
    const store = new CouncilStore(filePath);
    const created = store.createCouncil({
      workspace: root,
      agents: [{ provider: "codex", label: "Agent A" }],
    });
    const message = store.appendMessage({
      councilId: created.id,
      actorId: created.agents[0]!.id,
      role: "agent",
      text: "persist me exactly once",
    });
    await store.flush();

    const messageLogPath = path.join(
      root,
      "messages",
      `${encodeURIComponent(created.id)}.jsonl`,
    );
    appendFileSync(messageLogPath, `${JSON.stringify(message)}\n`);

    const reloaded = new CouncilStore(filePath);
    assert.deepEqual(
      reloaded.snapshot(created.id).messages.map((candidate) => candidate.id),
      [message.id],
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

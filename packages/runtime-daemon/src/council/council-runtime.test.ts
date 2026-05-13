import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { EventBus } from "../event-bus";
import { PtyHub, type PtyServerFrame } from "../pty-hub";
import type {
  PtySessionRuntimeEntry,
  PtySessionRuntimeStartRequest,
} from "../pty-session-runtime";
import { CouncilStore } from "./council-store";
import { CouncilRuntime } from "./council-runtime";

class FakePtyRuntime {
  readonly created: PtySessionRuntimeStartRequest[] = [];
  readonly closed: string[] = [];
  readonly writes: Array<{ id: string; data: string }> = [];
  readonly resizes: Array<{ id: string; cols: number; rows: number }> = [];
  failOnCreateIndex: number | null = null;
  private readonly sessions = new Map<string, PtySessionRuntimeStartRequest>();

  create(request: PtySessionRuntimeStartRequest): PtySessionRuntimeEntry {
    if (this.failOnCreateIndex === this.created.length) {
      throw new Error("pty launch failed");
    }
    const id = request.id ?? `fake-pty-${this.created.length + 1}`;
    this.created.push(request);
    this.sessions.set(id, request);
    request.onData(id, `ready:${id}`);
    return {
      id,
      cwd: request.cwd,
      shell: request.command ?? "sh",
      process: {
        write() {},
        resize() {},
        close: async () => {},
        waitUntilReady: async () => {},
        shell: request.command ?? "sh",
      } as unknown as PtySessionRuntimeEntry["process"],
    };
  }

  has(id: string): boolean {
    return this.sessions.has(id);
  }

  write(id: string, data: string): boolean {
    if (!this.sessions.has(id)) {
      return false;
    }
    this.writes.push({ id, data });
    return true;
  }

  resize(id: string, cols: number, rows: number): boolean {
    if (!this.sessions.has(id)) {
      return false;
    }
    this.resizes.push({ id, cols, rows });
    return true;
  }

  async close(id: string): Promise<boolean> {
    const request = this.sessions.get(id);
    if (!request) {
      return false;
    }
    this.sessions.delete(id);
    this.closed.push(id);
    request.onExit(id, { exitCode: 0 });
    return true;
  }
}

function fakeBinary(root: string, name: string): string {
  const binaryPath = path.join(root, name);
  writeFileSync(binaryPath, "#!/bin/sh\nprintf ready\n", "utf8");
  chmodSync(binaryPath, 0o755);
  return binaryPath;
}

function councilTerminalId(roomId: string, agentId: string): string {
  return `council:${roomId}:${Buffer.from(agentId, "utf8").toString("base64url")}`;
}

function assertBootstrapPromptSubmitted(write: { id: string; data: string }, args: {
  roomId: string;
  agentId: string;
}): void {
  assert.equal(write.id, councilTerminalId(args.roomId, args.agentId));
  assert.match(write.data, /^\x15/);
  assert.match(write.data, new RegExp(args.agentId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(write.data, /channel_join/);
  assert.doesNotMatch(write.data, /\r$/);
}

function waitForBootstrapPromptSubmit(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 220));
}

function waitForClaudeBootstrapPromptSubmit(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 420));
}

test("CouncilRuntime launches agent PTYs with provider launch specs and archives the room", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "rah-council-runtime-"));
  const previousCodex = process.env.RAH_CODEX_BINARY;
  const previousClaude = process.env.RAH_CLAUDE_BINARY;
  const previousOpenCode = process.env.RAH_OPENCODE_BINARY;
  const previousRahHome = process.env.RAH_HOME;
  process.env.RAH_CODEX_BINARY = fakeBinary(root, "codex");
  process.env.RAH_CLAUDE_BINARY = fakeBinary(root, "claude");
  process.env.RAH_OPENCODE_BINARY = fakeBinary(root, "opencode");
  process.env.RAH_HOME = path.join(root, "rah-home");
  try {
    const ptySessions = new FakePtyRuntime();
    const eventBus = new EventBus();
    const runtime = new CouncilRuntime({
      store: new CouncilStore(path.join(root, "rooms.json")),
      ptySessions,
      eventBus,
    });
    const response = await runtime.createRoom({
      title: "Launch Council",
      workspace: root,
      agents: [
        {
          id: "codex-lead",
          provider: "codex",
          label: "Codex Lead",
          role: "Lead implementation and propose concrete changes.",
          modelId: "gpt-5.5",
          reasoningId: "xhigh",
          modeId: "never/danger-full-access",
        },
        {
          id: "claude-reviewer",
          provider: "claude",
          label: "Claude Reviewer",
          role: "Review risks and challenge weak assumptions.",
          modelId: "opus",
          optionValues: { effort: "max" },
          modeId: "bypassPermissions",
        },
        {
          id: "opencode-builder",
          provider: "opencode",
          label: "OpenCode Builder",
          role: "Inspect implementation details and report exact findings.",
        },
      ],
    });

    assert.equal(response.room.room.status, "running");
    assert.deepEqual(response.room.agents.map((agent) => agent.status), ["starting", "starting", "starting"]);
    const codexId = response.room.agents[0]!.id;
    const claudeId = response.room.agents[1]!.id;
    const opencodeId = response.room.agents[2]!.id;
    assert.deepEqual([codexId, claudeId, opencodeId], ["Codex Lead", "Claude Reviewer", "OpenCode Builder"]);
    assert.equal(ptySessions.created.length, 3);
    assert.equal(ptySessions.created[0]!.id, councilTerminalId(response.room.room.id, codexId));
    assert.equal(ptySessions.created[1]!.id, councilTerminalId(response.room.room.id, claudeId));
    assert.equal(ptySessions.created[2]!.id, councilTerminalId(response.room.room.id, opencodeId));
    assert.deepEqual(ptySessions.created[0]!.args?.slice(0, 2), ["--cd", root]);
    assert.equal(ptySessions.created[0]!.env?.RAH_COUNCIL_ACTOR_ID, codexId);
    assert.equal(ptySessions.created[0]!.env?.RAH_COUNCIL_ACTOR_LABEL, codexId);
    assert.equal(ptySessions.created[0]!.env?.RAH_COUNCIL_ACTOR_ROLE, "Lead implementation and propose concrete changes.");
    assert.ok(ptySessions.created[0]!.args?.includes("model_reasoning_effort=\"xhigh\""));
    assert.ok(ptySessions.created[0]!.args?.some((arg) => arg.startsWith("mcp_servers.rah_council.args=")));
    assert.ok(ptySessions.created[0]!.args?.some((arg) => arg.includes("调用 channel_join")));
    const codexPrompt = ptySessions.created[0]!.args?.at(-1) ?? "";
    assert.match(codexPrompt, /你的唯一名字是 'Codex Lead'/);
    assert.match(codexPrompt, /你的角色: Lead implementation and propose concrete changes\./);
    assert.match(codexPrompt, /用户消息优先级最高/);
    assert.match(codexPrompt, /只能处理 rah_council 工具返回的 recent_messages 或 msg/);
    assert.match(codexPrompt, /timeout 是心跳/);
    assert.match(codexPrompt, /收到 timed_out=true 后不要输出任何自然语言/);
    assert.equal(ptySessions.created[1]!.env?.RAH_COUNCIL_ACTOR_ID, claudeId);
    assert.equal(ptySessions.created[1]!.env?.RAH_COUNCIL_ACTOR_LABEL, claudeId);
    assert.equal(ptySessions.created[1]!.env?.RAH_COUNCIL_ACTOR_ROLE, "Review risks and challenge weak assumptions.");
    assert.ok(ptySessions.created[1]!.args?.includes("--effort"));
    assert.ok(ptySessions.created[1]!.args?.includes("--mcp-config"));
    const claudePrompt = ptySessions.created[1]!.args?.at(-1) ?? "";
    assert.match(claudePrompt, /你的唯一名字是 'Claude Reviewer'/);
    assert.match(claudePrompt, /你的角色: Review risks and challenge weak assumptions\./);
    assert.match(claudePrompt, /mcp__rah_council__channel_join/);
    assert.match(claudePrompt, /不要用 Bash、echo、curl、ps、node/);
    assert.match(claudePrompt, /必须先实际调用下面的 MCP 工具/);
    assert.doesNotMatch(claudePrompt, /工具不可见/);
    assert.equal(ptySessions.created[2]!.env?.RAH_COUNCIL_ACTOR_ID, opencodeId);
    assert.equal(ptySessions.created[2]!.env?.RAH_COUNCIL_ACTOR_LABEL, opencodeId);
    assert.equal(ptySessions.created[2]!.env?.RAH_COUNCIL_ACTOR_ROLE, "Inspect implementation details and report exact findings.");
    const openCodePromptIndex = ptySessions.created[2]!.args?.indexOf("--prompt") ?? -1;
    assert.notEqual(openCodePromptIndex, -1);
    const openCodePrompt = ptySessions.created[2]!.args?.[openCodePromptIndex + 1] ?? "";
    assert.match(openCodePrompt, /你的唯一名字是 'OpenCode Builder'/);
    assert.match(openCodePrompt, /你的角色: Inspect implementation details and report exact findings\./);
    assert.match(openCodePrompt, /timeout_s=120/);
    const initialStatusTexts = response.room.messages.map((message) =>
      message.parts.map((part) => part.kind === "text" ? part.text : JSON.stringify(part.data)).join("\n")
    );
    assert.equal(initialStatusTexts.includes(`${codexId} sent`), true);
    assert.equal(initialStatusTexts.includes(`${claudeId} sent`), true);
    assert.equal(initialStatusTexts.includes(`${opencodeId} sent`), true);
    assert.equal(
      eventBus.list({
        sessionIds: [response.room.room.id],
        eventTypes: ["council.message.created"],
      }).length,
      4,
    );
    await runtime.callMcpTool({
      roomId: response.room.room.id,
      actorId: codexId,
      tool: "channel_post",
      arguments: { content: "Codex lead reporting in." },
    });
    const councilEvents = eventBus.list({
      sessionIds: [response.room.room.id],
      eventTypes: ["council.message.created"],
    });
    assert.equal(councilEvents.length, 5);
    const agentMessageEvent = councilEvents.at(-1)!;
    assert.equal(agentMessageEvent.type, "council.message.created");
    if (agentMessageEvent.type === "council.message.created") {
      assert.equal(agentMessageEvent.payload.message.actorId, codexId);
    }

    const tui = await runtime.getAgentTui(response.room.room.id, codexId);
    assert.equal(tui.terminalId, councilTerminalId(response.room.room.id, codexId));
    assert.equal(tui.screen, undefined);

    await runtime.archiveRoom(response.room.room.id);
    assert.deepEqual(ptySessions.closed, [
      councilTerminalId(response.room.room.id, codexId),
      councilTerminalId(response.room.room.id, claudeId),
      councilTerminalId(response.room.room.id, opencodeId),
    ]);
    assert.equal(runtime.listRooms().rooms[0]!.room.status, "stopped");
  } finally {
    if (previousCodex === undefined) delete process.env.RAH_CODEX_BINARY;
    else process.env.RAH_CODEX_BINARY = previousCodex;
    if (previousClaude === undefined) delete process.env.RAH_CLAUDE_BINARY;
    else process.env.RAH_CLAUDE_BINARY = previousClaude;
    if (previousOpenCode === undefined) delete process.env.RAH_OPENCODE_BINARY;
    else process.env.RAH_OPENCODE_BINARY = previousOpenCode;
    if (previousRahHome === undefined) delete process.env.RAH_HOME;
    else process.env.RAH_HOME = previousRahHome;
    rmSync(root, { force: true, recursive: true });
  }
});

test("CouncilRuntime dry-run records launch-ready PTYs", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "rah-council-dry-"));
  const previousOpenCode = process.env.RAH_OPENCODE_BINARY;
  process.env.RAH_OPENCODE_BINARY = fakeBinary(root, "opencode");
  try {
    const runtime = new CouncilRuntime({
      store: new CouncilStore(path.join(root, "rooms.json")),
      dryRun: true,
    });
    const response = await runtime.createRoom({
      workspace: root,
      agents: [{ id: "opencode-api", provider: "opencode", label: "OpenCode API" }],
    });
    const agentId = response.room.agents[0]!.id;
    assert.equal(agentId, "OpenCode API");
    assert.equal(response.room.agents[0]!.nativeSessionId, councilTerminalId(response.room.room.id, agentId));
    assert.equal(response.room.agents[0]!.zellijPaneId, councilTerminalId(response.room.room.id, agentId));
    assert.equal(response.room.room.status, "running");
    assert.throws(() => runtime.deleteRoom(response.room.room.id), /Stop this council room before deleting/);
    await runtime.archiveRoom(response.room.room.id);
    runtime.deleteRoom(response.room.room.id);
    assert.equal(runtime.listRooms().rooms.length, 0);
  } finally {
    if (previousOpenCode === undefined) delete process.env.RAH_OPENCODE_BINARY;
    else process.env.RAH_OPENCODE_BINARY = previousOpenCode;
    rmSync(root, { force: true, recursive: true });
  }
});

test("CouncilRuntime projects persisted active rooms from live PTY facts without mutating store", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "rah-council-runtime-projection-"));
  const filePath = path.join(root, "rooms.json");
  try {
    const store = new CouncilStore(filePath);
    const created = store.createRoom({
      workspace: root,
      agents: [{ id: "agent-a", provider: "codex", label: "Agent A" }],
    });
    const agentId = created.agents[0]!.id;
    store.updateRoom(created.room.id, { status: "running" });
    store.updateAgent(created.room.id, agentId, {
      status: "idle",
      nativeSessionId: councilTerminalId(created.room.id, agentId),
    });

    const reloadedStore = new CouncilStore(filePath);
    assert.equal(reloadedStore.snapshot(created.room.id).room.status, "running");

    const runtime = new CouncilRuntime({
      store: reloadedStore,
      ptySessions: new FakePtyRuntime(),
    });
    const projected = runtime.listRooms().rooms.find((room) => room.room.id === created.room.id);

    assert.equal(projected?.room.status, "stopped");
    assert.equal(projected?.agents[0]?.status, "stopped");
    assert.equal(reloadedStore.snapshot(created.room.id).room.status, "running");
    assert.throws(
      () => runtime.postMessage(created.room.id, { text: "should not post to stale room" }),
      /Council room is stopped/,
    );
    const state = await runtime.callMcpTool({
      roomId: created.room.id,
      actorId: agentId,
      clientId: "client-a",
      tool: "channel_state",
    }) as {
      result: {
        room: { status: string };
        agents: Array<{ status: string }>;
        active_agents: Array<{ status: string }>;
      };
    };
    assert.equal(state.result.room.status, "stopped");
    assert.equal(state.result.agents[0]?.status, "stopped");
    assert.equal(state.result.active_agents[0]?.status, "stopped");
    const history = await runtime.callMcpTool({
      roomId: created.room.id,
      actorId: agentId,
      clientId: "client-a",
      tool: "channel_history",
    }) as { result: { messages: unknown[] } };
    assert.equal(Array.isArray(history.result.messages), true);
    await assert.rejects(
      () => runtime.callMcpTool({
        roomId: created.room.id,
        actorId: agentId,
        clientId: "client-a",
        tool: "channel_join",
      }),
      /Council room is stopped/,
    );
    await assert.rejects(
      () => runtime.callMcpTool({
        roomId: created.room.id,
        actorId: agentId,
        clientId: "client-a",
        tool: "channel_post",
        arguments: { content: "should not post to stale room" },
      }),
      /Council room is stopped/,
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("CouncilRuntime preserves agent-council wait cursor, inbox, claims, and controls", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "rah-council-runtime-mcp-"));
  try {
    const runtime = new CouncilRuntime({
      store: new CouncilStore(path.join(root, "rooms.json")),
      dryRun: true,
    });
    const response = await runtime.createRoom({
      workspace: root,
      agents: [
        { id: "agent-a", provider: "codex", label: "Agent A" },
        { id: "agent-b", provider: "claude", label: "Agent B" },
      ],
    });
    const roomId = response.room.room.id;
    const agentA = response.room.agents[0]!.id;
    const agentB = response.room.agents[1]!.id;

    const joined = await runtime.callMcpTool({
      roomId,
      actorId: agentA,
      clientId: "client-a",
      tool: "channel_join",
    }) as { result: { last_msg_id: number; recent_messages: unknown[] } };
    assert.equal(joined.result.last_msg_id, 1);
    assert.equal(joined.result.recent_messages.length, 1);

    const waiting = runtime.callMcpTool({
      roomId,
      actorId: agentA,
      clientId: "client-a",
      tool: "channel_wait_new",
      arguments: { timeout_s: 1 },
    }) as Promise<{ result: { msg?: { actor: string; content: string }; timed_out?: true } }>;
    runtime.postMessage(roomId, { text: "Question for the council." });
    const waited = await waiting;
    assert.equal(waited.result.msg?.actor, "user");
    assert.equal(waited.result.msg?.content, "Question for the council.");

    const repeated = await runtime.callMcpTool({
      roomId,
      actorId: agentA,
      clientId: "client-a",
      tool: "channel_wait_new",
      arguments: { timeout_s: 0.01 },
    }) as { result: { timed_out?: true } };
    assert.equal(repeated.result.timed_out, true);

    runtime.postMessage(roomId, { actorId: "user", text: "Non-blocking inbox item." });
    const peeked = await runtime.callMcpTool({
      roomId,
      actorId: agentA,
      clientId: "client-a",
      tool: "channel_peek_inbox",
    }) as { result: { messages: Array<{ content: string }> } };
    assert.equal(peeked.result.messages.at(-1)?.content, "Non-blocking inbox item.");
    const peekedAgain = await runtime.callMcpTool({
      roomId,
      actorId: agentA,
      clientId: "client-a",
      tool: "channel_peek_inbox",
    }) as { result: { messages: unknown[] } };
    assert.equal(peekedAgain.result.messages.length, 0);

    const claim = await runtime.callMcpTool({
      roomId,
      actorId: agentA,
      clientId: "client-a",
      tool: "channel_claim_file",
      arguments: { path: "src/shared.ts" },
    }) as { result: { actor: string; path: string } };
    assert.equal(claim.result.actor, agentA);
    assert.equal(claim.result.path, "src/shared.ts");
    await assert.rejects(
      () => runtime.callMcpTool({
        roomId,
        actorId: agentB,
        clientId: "client-b",
        tool: "channel_claim_file",
        arguments: { path: "src/shared.ts" },
      }),
      /file_conflict/,
    );

    await runtime.callMcpTool({
      roomId,
      actorId: agentA,
      clientId: "client-a",
      tool: "channel_send_control",
      arguments: { target: agentB, action: "interrupt", task_id: "task-1" },
    });
    const controls = await runtime.callMcpTool({
      roomId,
      actorId: agentB,
      clientId: "client-b",
      tool: "channel_peek_control",
    }) as { result: { count: number; controls: Array<{ action: string; taskId?: string }> } };
    assert.equal(controls.result.count, 1);
    assert.equal(controls.result.controls[0]!.action, "interrupt");
    assert.equal(controls.result.controls[0]!.taskId, "task-1");
    await runtime.archiveRoom(roomId);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("CouncilRuntime treats wait timeout as a heartbeat without auto re-injection", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "rah-council-runtime-wait-timeout-"));
  try {
    const runtime = new CouncilRuntime({
      store: new CouncilStore(path.join(root, "rooms.json")),
      dryRun: true,
    });
    const response = await runtime.createRoom({
      workspace: root,
      agents: [{ provider: "codex", label: "Codex Listener" }],
    });
    const roomId = response.room.room.id;
    const agentId = response.room.agents[0]!.id;

    const before = runtime.listRooms().rooms.find((room) => room.room.id === roomId)!;
    const beforeMessageCount = before.messages.length;
    const timedOut = await runtime.callMcpTool({
      roomId,
      actorId: agentId,
      clientId: "client-a",
      tool: "channel_wait_new",
      arguments: { timeout_s: 0.01 },
    }) as { result: { timed_out?: true; next_action?: string; instruction?: string } };
    assert.equal(timedOut.result.timed_out, true);
    assert.equal(timedOut.result.next_action, "call_channel_wait_new_again");
    assert.match(timedOut.result.instruction ?? "", /heartbeat/);

    const snapshot = runtime.listRooms().rooms.find((room) => room.room.id === roomId)!;
    assert.equal(snapshot.agents[0]!.status, "waiting");
    assert.equal(snapshot.agents[0]!.lastStatusDetail, "listening");
    assert.equal(snapshot.messages.length, beforeMessageCount + 1);
    const lastMessage = snapshot.messages.at(-1);
    const lastPart = lastMessage?.parts[0];
    assert.equal(lastMessage?.role, "system");
    assert.match(lastPart?.kind === "text" ? lastPart.text : "", /listening/);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("CouncilRuntime does not project legacy wait-timeout noise to frontend rooms or events", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "rah-council-runtime-timeout-noise-"));
  try {
    const eventBus = new EventBus();
    const runtime = new CouncilRuntime({
      store: new CouncilStore(path.join(root, "rooms.json")),
      dryRun: true,
      eventBus,
    });
    const response = await runtime.createRoom({
      workspace: root,
      agents: [{ provider: "codex", label: "Codex Listener" }],
    });
    const roomId = response.room.room.id;

    const beforeEvents = eventBus.list({
      sessionIds: [roomId],
      eventTypes: ["council.message.created"],
    }).length;
    runtime.postMessage(roomId, {
      role: "system",
      text: "Codex Listener wait timed out; no active listener is currently blocking on channel_wait_new.",
    });

    const projected = runtime.listRooms().rooms.find((room) => room.room.id === roomId)!;
    assert.equal(
      projected.messages.some((message) => (
        message.parts.some((part) => part.kind === "text" && part.text.includes("wait timed out"))
      )),
      false,
    );
    assert.equal(
      eventBus.list({
        sessionIds: [roomId],
        eventTypes: ["council.message.created"],
      }).length,
      beforeEvents,
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("CouncilRuntime projects joined and listening diagnostics for UI status folding", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "rah-council-runtime-project-status-"));
  try {
    const eventBus = new EventBus();
    const runtime = new CouncilRuntime({
      store: new CouncilStore(path.join(root, "rooms.json")),
      dryRun: true,
      eventBus,
    });
    const response = await runtime.createRoom({
      workspace: root,
      agents: [{ provider: "codex", label: "Codex Listener" }],
    });
    const roomId = response.room.room.id;
    const agentId = response.room.agents[0]!.id;
    const beforeEvents = eventBus.list({
      sessionIds: [roomId],
      eventTypes: ["council.message.created"],
    }).length;

    await runtime.callMcpTool({
      roomId,
      actorId: agentId,
      clientId: "client-a",
      tool: "channel_join",
    });
    await runtime.callMcpTool({
      roomId,
      actorId: agentId,
      clientId: "client-a",
      tool: "channel_wait_new",
      arguments: { timeout_s: 0.01 },
    });

    const projected = runtime.listRooms().rooms.find((room) => room.room.id === roomId)!;
    const visibleTexts = projected.messages.map((message) =>
      message.parts.map((part) => part.kind === "text" ? part.text : JSON.stringify(part.data)).join("\n")
    );
    assert.equal(visibleTexts.includes(`${agentId} joined`), true);
    assert.equal(visibleTexts.includes(`${agentId} listening`), true);
    const events = eventBus.list({
      sessionIds: [roomId],
      eventTypes: ["council.message.created"],
    });
    assert.equal(events.length, beforeEvents + 2);
    const lastEvent = events.at(-1) as {
      payload: {
        message: {
          parts: Array<{ kind: "text"; text: string } | { kind: "data"; data: unknown }>;
        };
      };
    } | undefined;
    assert.equal(lastEvent?.payload.message.parts[0]?.kind, "text");
    assert.equal(
      lastEvent?.payload.message.parts[0]?.kind === "text"
        ? lastEvent.payload.message.parts[0].text
        : "",
      `${agentId} listening`,
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("CouncilRuntime keeps an agent waiting when it re-enters wait after timeout", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "rah-council-runtime-rewait-"));
  try {
    const runtime = new CouncilRuntime({
      store: new CouncilStore(path.join(root, "rooms.json")),
      dryRun: true,
    });
    const response = await runtime.createRoom({
      workspace: root,
      agents: [{ provider: "codex", label: "Codex Listener" }],
    });
    const roomId = response.room.room.id;
    const agentId = response.room.agents[0]!.id;

    const timedOut = await runtime.callMcpTool({
      roomId,
      actorId: agentId,
      clientId: "client-a",
      tool: "channel_wait_new",
      arguments: { timeout_s: 0.01 },
    }) as { result: { timed_out?: true } };
    assert.equal(timedOut.result.timed_out, true);

    const secondWait = runtime.callMcpTool({
      roomId,
      actorId: agentId,
      clientId: "client-a",
      tool: "channel_wait_new",
      arguments: { timeout_s: 1 },
    }) as Promise<{ result: { msg?: { content: string } } }>;

    const waitingSnapshot = runtime.listRooms().rooms.find((room) => room.room.id === roomId)!;
    assert.equal(waitingSnapshot.agents[0]!.status, "waiting");
    assert.equal(waitingSnapshot.agents[0]!.lastStatusDetail, "listening");

    runtime.postMessage(roomId, { text: "Still listening?" });
    const delivered = await secondWait;
    assert.equal(delivered.result.msg?.content, "Still listening?");
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("CouncilRuntime announces listening again after an agent re-joins", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "rah-council-runtime-rejoin-listening-"));
  try {
    const runtime = new CouncilRuntime({
      store: new CouncilStore(path.join(root, "rooms.json")),
      dryRun: true,
    });
    const response = await runtime.createRoom({
      workspace: root,
      agents: [{ provider: "codex", label: "Codex Listener" }],
    });
    const roomId = response.room.room.id;
    const agentId = response.room.agents[0]!.id;

    await runtime.callMcpTool({
      roomId,
      actorId: agentId,
      clientId: "client-a",
      tool: "channel_join",
    });
    await runtime.callMcpTool({
      roomId,
      actorId: agentId,
      clientId: "client-a",
      tool: "channel_wait_new",
      arguments: { timeout_s: 0.01 },
    });
    await runtime.callMcpTool({
      roomId,
      actorId: agentId,
      clientId: "client-a",
      tool: "channel_join",
    });
    await runtime.callMcpTool({
      roomId,
      actorId: agentId,
      clientId: "client-a",
      tool: "channel_wait_new",
      arguments: { timeout_s: 0.01 },
    });

    const snapshot = runtime.listRooms().rooms.find((room) => room.room.id === roomId)!;
    const listeningMessages = snapshot.messages.filter((message) => (
      message.role === "system" &&
      message.actorId === agentId &&
      message.parts.some((part) => part.kind === "text" && part.text.includes("listening"))
    ));
    assert.equal(listeningMessages.length, 2);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("CouncilRuntime does not auto re-inject bootstrap prompt after a live agent reply", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "rah-council-runtime-listener-reinject-"));
  const previousCodex = process.env.RAH_CODEX_BINARY;
  process.env.RAH_CODEX_BINARY = fakeBinary(root, "codex");
  try {
    const ptySessions = new FakePtyRuntime();
    const runtime = new CouncilRuntime({
      store: new CouncilStore(path.join(root, "rooms.json")),
      ptySessions,
    });
    const response = await runtime.createRoom({
      workspace: root,
      agents: [{ provider: "codex", label: "Codex Listener" }],
    });
    const roomId = response.room.room.id;
    const agentId = response.room.agents[0]!.id;

    await runtime.callMcpTool({
      roomId,
      actorId: agentId,
      clientId: "client-a",
      tool: "channel_join",
    });
    const waiting = runtime.callMcpTool({
      roomId,
      actorId: agentId,
      clientId: "client-a",
      tool: "channel_wait_new",
      arguments: { timeout_s: 1 },
    }) as Promise<{ result: { msg?: { content: string } } }>;
    runtime.postMessage(roomId, { text: "Introduce yourself." });
    const waited = await waiting;
    assert.equal(waited.result.msg?.content, "Introduce yourself.");

    await runtime.callMcpTool({
      roomId,
      actorId: agentId,
      clientId: "client-a",
      tool: "channel_post",
      arguments: { text: "I am still here." },
    });

    const snapshot = runtime.listRooms().rooms.find((room) => room.room.id === roomId)!;
    assert.equal(snapshot.agents[0]!.status, "waiting");
    assert.equal(snapshot.agents[0]!.lastStatusDetail, "listening");
    assert.equal(ptySessions.writes.length, 0);
    assert.equal(
      snapshot.messages.some((message) =>
        message.parts.some((part) => part.kind === "text" && part.text.includes("bootstrap prompt re-injected"))
      ),
      false,
    );
  } finally {
    if (previousCodex === undefined) delete process.env.RAH_CODEX_BINARY;
    else process.env.RAH_CODEX_BINARY = previousCodex;
    rmSync(root, { force: true, recursive: true });
  }
});

test("CouncilRuntime exposes council agent PTYs through the interactive PTY stream", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "rah-council-runtime-terminal-"));
  const previousCodex = process.env.RAH_CODEX_BINARY;
  process.env.RAH_CODEX_BINARY = fakeBinary(root, "codex");
  try {
    const ptySessions = new FakePtyRuntime();
    const ptyHub = new PtyHub();
    const runtime = new CouncilRuntime({
      store: new CouncilStore(path.join(root, "rooms.json")),
      ptySessions,
      ptyHub,
    });
    const response = await runtime.createRoom({
      workspace: root,
      agents: [{ id: "codex-lead", provider: "codex", label: "Codex Lead" }],
    });
    const agentId = response.room.agents[0]!.id;

    const tui = await runtime.getAgentTui(response.room.room.id, agentId);
    assert.equal(tui.terminalId, councilTerminalId(response.room.room.id, agentId));
    assert.equal(tui.screen, undefined);
    assert.ok(ptyHub.stats(tui.terminalId!)?.replayChunks);

    const frames: PtyServerFrame[] = [];
    const unsubscribe = ptyHub.subscribe(tui.terminalId!, (frame) => frames.push(frame));
    unsubscribe();
    const replay = frames.find((frame) => frame.type === "pty.replay");
    assert.ok(replay?.chunks.join("").includes(`ready:${tui.terminalId}`));

    await runtime.claimAgentTuiSurface(tui.terminalId!, {
      clientId: "web-client",
      clientKind: "web",
      cols: 120,
      rows: 36,
    });
    assert.equal(runtime.handlePtyInput(tui.terminalId!, "web-client", "hello"), true);
    assert.deepEqual(ptySessions.writes, [
      {
        id: tui.terminalId,
        data: "hello",
      },
    ]);
    assert.equal(runtime.handlePtyResize(tui.terminalId!, "web-client", 140, 40), true);
    assert.deepEqual(ptySessions.resizes.slice(-3), [
      { id: tui.terminalId!, cols: 119, rows: 36 },
      { id: tui.terminalId!, cols: 120, rows: 36 },
      { id: tui.terminalId!, cols: 140, rows: 40 },
    ]);

    await runtime.archiveRoom(response.room.room.id);
    assert.equal(ptyHub.stats(tui.terminalId!), null);
  } finally {
    if (previousCodex === undefined) delete process.env.RAH_CODEX_BINARY;
    else process.env.RAH_CODEX_BINARY = previousCodex;
    rmSync(root, { force: true, recursive: true });
  }
});

test("CouncilRuntime can re-inject bootstrap prompts and remove an agent without closing its terminal", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "rah-council-runtime-reinject-"));
  const previousCodex = process.env.RAH_CODEX_BINARY;
  process.env.RAH_CODEX_BINARY = fakeBinary(root, "codex");
  try {
    const ptySessions = new FakePtyRuntime();
    const runtime = new CouncilRuntime({
      store: new CouncilStore(path.join(root, "rooms.json")),
      ptySessions,
    });
    const response = await runtime.createRoom({
      workspace: root,
      agents: [{ provider: "codex", label: "Codex Lead" }],
    });
    const roomId = response.room.room.id;
    const agentId = response.room.agents[0]!.id;
    const terminalId = councilTerminalId(roomId, agentId);

    const reinjected = runtime.reinjectAgentPrompt(roomId, agentId);
    assert.deepEqual(reinjected.injectedAgentIds, [agentId]);
    assertBootstrapPromptSubmitted(ptySessions.writes.at(-1)!, { roomId, agentId });
    await waitForBootstrapPromptSubmit();
    assert.deepEqual(ptySessions.writes.at(-1), {
      id: terminalId,
      data: "\r",
    });
    assert.equal(reinjected.room.agents[0]!.status, "starting");
    assert.equal(reinjected.room.agents[0]!.lastStatusDetail, "bootstrap prompt re-injected");

    await runtime.callMcpTool({
      roomId,
      actorId: agentId,
      clientId: "client-a",
      tool: "channel_join",
    });
    const removed = runtime.removeAgentFromRoom(roomId, agentId);
    assert.equal(removed.room.agents[0]!.status, "stopped");
    assert.equal(ptySessions.has(terminalId), true);
    await assert.rejects(
      () => runtime.callMcpTool({
        roomId,
        actorId: agentId,
        clientId: "client-a",
        tool: "channel_wait_new",
        arguments: { timeout_s: 0.01 },
      }),
      /cannot receive MCP writes/,
    );
  } finally {
    if (previousCodex === undefined) delete process.env.RAH_CODEX_BINARY;
    else process.env.RAH_CODEX_BINARY = previousCodex;
    rmSync(root, { force: true, recursive: true });
  }
});

test("CouncilRuntime re-injects Claude bootstrap prompts with escape and delayed submit", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "rah-council-runtime-claude-reinject-"));
  const previousClaude = process.env.RAH_CLAUDE_BINARY;
  const previousRahHome = process.env.RAH_HOME;
  process.env.RAH_CLAUDE_BINARY = fakeBinary(root, "claude");
  process.env.RAH_HOME = path.join(root, "rah-home");
  try {
    const ptySessions = new FakePtyRuntime();
    const runtime = new CouncilRuntime({
      store: new CouncilStore(path.join(root, "rooms.json")),
      ptySessions,
    });
    const response = await runtime.createRoom({
      workspace: root,
      agents: [{ provider: "claude", label: "Claude Reviewer" }],
    });
    const roomId = response.room.room.id;
    const agentId = response.room.agents[0]!.id;
    const terminalId = councilTerminalId(roomId, agentId);

    const reinjected = runtime.reinjectAgentPrompt(roomId, agentId);
    assert.deepEqual(reinjected.injectedAgentIds, [agentId]);
    assert.deepEqual(ptySessions.writes.at(-1), {
      id: terminalId,
      data: "\x1b",
    });
    await waitForBootstrapPromptSubmit();
    assertBootstrapPromptSubmitted(ptySessions.writes.at(-1)!, { roomId, agentId });
    await waitForClaudeBootstrapPromptSubmit();
    assert.deepEqual(ptySessions.writes.at(-1), {
      id: terminalId,
      data: "\r",
    });
  } finally {
    if (previousClaude === undefined) delete process.env.RAH_CLAUDE_BINARY;
    else process.env.RAH_CLAUDE_BINARY = previousClaude;
    if (previousRahHome === undefined) delete process.env.RAH_HOME;
    else process.env.RAH_HOME = previousRahHome;
    rmSync(root, { force: true, recursive: true });
  }
});

test("CouncilRuntime skips bootstrap re-injection while an agent has an active listener", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "rah-council-runtime-reinject-active-listener-"));
  const previousCodex = process.env.RAH_CODEX_BINARY;
  process.env.RAH_CODEX_BINARY = fakeBinary(root, "codex");
  try {
    const ptySessions = new FakePtyRuntime();
    const runtime = new CouncilRuntime({
      store: new CouncilStore(path.join(root, "rooms.json")),
      ptySessions,
    });
    const response = await runtime.createRoom({
      workspace: root,
      agents: [{ provider: "codex", label: "Codex Listener" }],
    });
    const roomId = response.room.room.id;
    const agentId = response.room.agents[0]!.id;
    await runtime.callMcpTool({
      roomId,
      actorId: agentId,
      clientId: "client-a",
      tool: "channel_join",
    });
    const waitPromise = runtime.callMcpTool({
      roomId,
      actorId: agentId,
      clientId: "client-a",
      tool: "channel_wait_new",
      arguments: { timeout_s: 10 },
    });
    const writesBefore = ptySessions.writes.length;

    const reinjected = runtime.reinjectAgentPrompt(roomId, agentId);

    assert.deepEqual(reinjected.injectedAgentIds, []);
    assert.deepEqual(reinjected.skippedAgentIds, [agentId]);
    assert.equal(ptySessions.writes.length, writesBefore);
    assert.equal(reinjected.room.agents[0]!.status, "waiting");
    runtime.postMessage(roomId, { text: "wake listener" });
    await waitPromise;
  } finally {
    if (previousCodex === undefined) delete process.env.RAH_CODEX_BINARY;
    else process.env.RAH_CODEX_BINARY = previousCodex;
    rmSync(root, { force: true, recursive: true });
  }
});

test("CouncilRuntime re-injects only missing live agents", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "rah-council-runtime-reinject-missing-"));
  const previousCodex = process.env.RAH_CODEX_BINARY;
  process.env.RAH_CODEX_BINARY = fakeBinary(root, "codex");
  try {
    const ptySessions = new FakePtyRuntime();
    const runtime = new CouncilRuntime({
      store: new CouncilStore(path.join(root, "rooms.json")),
      ptySessions,
    });
    const response = await runtime.createRoom({
      workspace: root,
      agents: [
        { provider: "codex", label: "Missing Agent" },
        { provider: "codex", label: "Joined Only Agent" },
        { provider: "codex", label: "Waiting Without Listener Agent" },
        { provider: "codex", label: "Active Waiting Agent" },
      ],
    });
    const roomId = response.room.room.id;
    const missingId = response.room.agents[0]!.id;
    const joinedOnlyId = response.room.agents[1]!.id;
    const waitingWithoutListenerId = response.room.agents[2]!.id;
    const activeWaitingId = response.room.agents[3]!.id;
    await runtime.callMcpTool({
      roomId,
      actorId: joinedOnlyId,
      clientId: "client-joined",
      tool: "channel_join",
    });
    await runtime.callMcpTool({
      roomId,
      actorId: joinedOnlyId,
      clientId: "client-joined",
      tool: "channel_set_status",
      arguments: { phase: "idle", detail: "joined" },
    });
    await runtime.callMcpTool({
      roomId,
      actorId: waitingWithoutListenerId,
      clientId: "client-b",
      tool: "channel_set_status",
      arguments: { phase: "waiting", detail: "ready" },
    });
    await runtime.callMcpTool({
      roomId,
      actorId: activeWaitingId,
      clientId: "client-active",
      tool: "channel_join",
    });
    await runtime.callMcpTool({
      roomId,
      actorId: activeWaitingId,
      clientId: "client-active",
      tool: "channel_wait_new",
      arguments: { timeout_s: 0.01 },
    });

    const result = runtime.reinjectMissingAgentPrompts(roomId);

    assert.deepEqual(result.injectedAgentIds, [missingId, joinedOnlyId, waitingWithoutListenerId]);
    assert.equal(ptySessions.writes.length, 3);
    assertBootstrapPromptSubmitted(ptySessions.writes[0]!, { roomId, agentId: missingId });
    assertBootstrapPromptSubmitted(ptySessions.writes[1]!, { roomId, agentId: joinedOnlyId });
    assertBootstrapPromptSubmitted(ptySessions.writes[2]!, { roomId, agentId: waitingWithoutListenerId });
    assert.equal(
      ptySessions.writes.some((write) => write.id === councilTerminalId(roomId, activeWaitingId)),
      false,
    );
  } finally {
    if (previousCodex === undefined) delete process.env.RAH_CODEX_BINARY;
    else process.env.RAH_CODEX_BINARY = previousCodex;
    rmSync(root, { force: true, recursive: true });
  }
});

test("CouncilRuntime returns a diagnostic screen for persisted agents whose PTY is no longer live", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "rah-council-stale-"));
  const previousOpenCode = process.env.RAH_OPENCODE_BINARY;
  process.env.RAH_OPENCODE_BINARY = fakeBinary(root, "opencode");
  try {
    const ptySessions = new FakePtyRuntime();
    const store = new CouncilStore(path.join(root, "rooms.json"));
    const runtime = new CouncilRuntime({
      store,
      ptySessions,
    });
    const response = await runtime.createRoom({
      workspace: root,
      agents: [{ id: "opencode-api", provider: "opencode", label: "OpenCode API" }],
    });
    const agentId = response.room.agents[0]!.id;
    const terminalId = response.room.agents[0]!.nativeSessionId!;
    await ptySessions.close(terminalId);

    const tui = await runtime.getAgentTui(response.room.room.id, agentId);
    assert.equal(tui.terminalId, undefined);
    assert.match(tui.screen ?? "", /terminal is not live anymore/);
  } finally {
    if (previousOpenCode === undefined) delete process.env.RAH_OPENCODE_BINARY;
    else process.env.RAH_OPENCODE_BINARY = previousOpenCode;
    rmSync(root, { force: true, recursive: true });
  }
});

test("CouncilRuntime cleans up PTYs and records failure when agent launch fails", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "rah-council-runtime-fail-"));
  const previousCodex = process.env.RAH_CODEX_BINARY;
  process.env.RAH_CODEX_BINARY = fakeBinary(root, "codex");
  try {
    const ptySessions = new FakePtyRuntime();
    ptySessions.failOnCreateIndex = 1;
    const runtime = new CouncilRuntime({
      store: new CouncilStore(path.join(root, "rooms.json")),
      ptySessions,
    });

    const response = await runtime.createRoom({
      workspace: root,
      agents: [
        { id: "codex-a", provider: "codex", label: "Codex A" },
        { id: "codex-b", provider: "codex", label: "Codex B" },
      ],
    });

    assert.equal(response.room.room.status, "failed");
    assert.match(response.room.room.error ?? "", /pty launch failed/);
    assert.deepEqual(response.room.agents.map((agent) => agent.status), ["failed", "failed"]);
    assert.deepEqual(ptySessions.closed, [councilTerminalId(response.room.room.id, "Codex A")]);
    assert.equal(response.room.messages.at(-1)?.role, "system");
    const lastPart = response.room.messages.at(-1)?.parts[0];
    assert.match(
      lastPart?.kind === "text" ? lastPart.text : "",
      /Council failed to start/,
    );
  } finally {
    if (previousCodex === undefined) delete process.env.RAH_CODEX_BINARY;
    else process.env.RAH_CODEX_BINARY = previousCodex;
    rmSync(root, { force: true, recursive: true });
  }
});

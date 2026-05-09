import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type {
  CreateMuxPaneRequest,
  CreateMuxPaneResult,
  DumpMuxScreenOptions,
  MuxPaneId,
  MuxPaneState,
  MuxPaneSubscription,
  MuxPaneUpdate,
  SubscribeMuxPaneOptions,
} from "../mux-runtime";
import { EventBus } from "../event-bus";
import { CouncilStore } from "./council-store";
import { CouncilRuntime } from "./council-runtime";

class FakeMux {
  readonly created: CreateMuxPaneRequest[] = [];
  readonly killed: string[] = [];
  failOnCreateIndex: number | null = null;

  async ensureAvailable(): Promise<void> {}
  async listSessions(): Promise<Array<{ sessionName: string }>> { return []; }
  async createSession(request: CreateMuxPaneRequest): Promise<CreateMuxPaneResult> {
    return await this.createProviderPane(request);
  }
  async createProviderPane(request: CreateMuxPaneRequest): Promise<CreateMuxPaneResult> {
    if (this.failOnCreateIndex === this.created.length) {
      throw new Error("pane launch failed");
    }
    this.created.push(request);
    return { sessionName: request.sessionName, paneId: `terminal_${this.created.length}` };
  }
  async listPanes(): Promise<MuxPaneState[]> { return []; }
  async dumpScreen(
    sessionName: string,
    paneId: MuxPaneId,
    _options?: DumpMuxScreenOptions,
  ): Promise<string> {
    return `screen:${sessionName}:${paneId}`;
  }
  subscribePane(
    _sessionName: string,
    _paneId: MuxPaneId,
    _onUpdate: (update: MuxPaneUpdate) => void,
    _options?: SubscribeMuxPaneOptions,
  ): MuxPaneSubscription {
    return { close() {} };
  }
  async writeChars(): Promise<void> {}
  async writeBytes(): Promise<void> {}
  async sendKeys(): Promise<void> {}
  async closePane(): Promise<void> {}
  async killSession(sessionName: string): Promise<void> {
    this.killed.push(sessionName);
  }
}

function fakeBinary(root: string, name: string): string {
  const binaryPath = path.join(root, name);
  writeFileSync(binaryPath, "#!/bin/sh\nprintf ready\n", "utf8");
  chmodSync(binaryPath, 0o755);
  return binaryPath;
}

test("CouncilRuntime launches zellij panes with provider launch specs and archives the room", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "rah-council-runtime-"));
  const previousCodex = process.env.RAH_CODEX_BINARY;
  const previousClaude = process.env.RAH_CLAUDE_BINARY;
  const previousRahHome = process.env.RAH_HOME;
  process.env.RAH_CODEX_BINARY = fakeBinary(root, "codex");
  process.env.RAH_CLAUDE_BINARY = fakeBinary(root, "claude");
  process.env.RAH_HOME = path.join(root, "rah-home");
  try {
    const mux = new FakeMux();
    const eventBus = new EventBus();
    const runtime = new CouncilRuntime({
      store: new CouncilStore(path.join(root, "rooms.json")),
      mux,
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
          modelId: "gpt-5.5",
          reasoningId: "xhigh",
          modeId: "never/danger-full-access",
        },
        {
          id: "claude-reviewer",
          provider: "claude",
          label: "Claude Reviewer",
          modelId: "opus",
          optionValues: { effort: "max" },
          modeId: "bypassPermissions",
        },
      ],
    });

    assert.equal(response.room.room.status, "running");
    assert.deepEqual(response.room.agents.map((agent) => agent.status), ["starting", "starting"]);
    assert.equal(mux.created.length, 2);
    assert.match(mux.created[0]!.sessionName, /^rah-council-/);
    assert.deepEqual(mux.created[0]!.args?.slice(0, 2), ["--cd", root]);
    assert.equal(mux.created[0]!.env?.RAH_COUNCIL_ACTOR_ID, "codex-lead");
    assert.ok(mux.created[0]!.args?.includes("model_reasoning_effort=\"xhigh\""));
    assert.ok(mux.created[0]!.args?.some((arg) => arg.startsWith("mcp_servers.rah_council.args=")));
    assert.ok(mux.created[0]!.args?.some((arg) => arg.includes("channel_join first")));
    assert.equal(mux.created[1]!.env?.RAH_COUNCIL_ACTOR_ID, "claude-reviewer");
    assert.ok(mux.created[1]!.args?.includes("--effort"));
    assert.ok(mux.created[1]!.args?.includes("--mcp-config"));
    assert.equal(
      eventBus.list({
        sessionIds: [response.room.room.id],
        eventTypes: ["council.message.created"],
      }).length,
      1,
    );
    runtime.callMcpTool({
      roomId: response.room.room.id,
      actorId: "codex-lead",
      tool: "channel_post",
      arguments: { content: "Codex lead reporting in." },
    });
    const councilEvents = eventBus.list({
      sessionIds: [response.room.room.id],
      eventTypes: ["council.message.created"],
    });
    assert.equal(councilEvents.length, 2);
    const agentMessageEvent = councilEvents[1]!;
    assert.equal(agentMessageEvent.type, "council.message.created");
    if (agentMessageEvent.type === "council.message.created") {
      assert.equal(agentMessageEvent.payload.message.actorId, "codex-lead");
    }

    const tui = await runtime.getAgentTui(response.room.room.id, "codex-lead");
    assert.equal(tui.screen, `screen:${mux.created[0]!.sessionName}:terminal_1`);

    await runtime.archiveRoom(response.room.room.id);
    assert.deepEqual(mux.killed, [mux.created[0]!.sessionName]);
    assert.equal(runtime.listRooms().rooms[0]!.room.status, "stopped");
  } finally {
    if (previousCodex === undefined) delete process.env.RAH_CODEX_BINARY;
    else process.env.RAH_CODEX_BINARY = previousCodex;
    if (previousClaude === undefined) delete process.env.RAH_CLAUDE_BINARY;
    else process.env.RAH_CLAUDE_BINARY = previousClaude;
    if (previousRahHome === undefined) delete process.env.RAH_HOME;
    else process.env.RAH_HOME = previousRahHome;
    rmSync(root, { force: true, recursive: true });
  }
});

test("CouncilRuntime dry-run records launch-ready panes without zellij", async () => {
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
    assert.equal(response.room.agents[0]!.zellijPaneId, "dry-run-opencode-api");
    assert.equal(response.room.room.status, "running");
  } finally {
    if (previousOpenCode === undefined) delete process.env.RAH_OPENCODE_BINARY;
    else process.env.RAH_OPENCODE_BINARY = previousOpenCode;
    rmSync(root, { force: true, recursive: true });
  }
});

test("CouncilRuntime cleans up zellij session and records failure when agent launch fails", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "rah-council-runtime-fail-"));
  const previousCodex = process.env.RAH_CODEX_BINARY;
  process.env.RAH_CODEX_BINARY = fakeBinary(root, "codex");
  try {
    const mux = new FakeMux();
    mux.failOnCreateIndex = 1;
    const runtime = new CouncilRuntime({
      store: new CouncilStore(path.join(root, "rooms.json")),
      mux,
    });

    const response = await runtime.createRoom({
      workspace: root,
      agents: [
        { id: "codex-a", provider: "codex", label: "Codex A" },
        { id: "codex-b", provider: "codex", label: "Codex B" },
      ],
    });

    assert.equal(response.room.room.status, "failed");
    assert.match(response.room.room.error ?? "", /pane launch failed/);
    assert.deepEqual(response.room.agents.map((agent) => agent.status), ["failed", "failed"]);
    assert.deepEqual(mux.killed, [mux.created[0]!.sessionName]);
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

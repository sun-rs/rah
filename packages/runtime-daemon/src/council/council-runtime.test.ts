import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { EventBus } from "../event-bus";
import type {
  SessionInputRequest,
  StartSessionRequest,
  StartSessionResponse,
} from "@rah/runtime-protocol";
import { CouncilStore } from "./council-store";
import { CouncilRuntime, type CouncilRuntimeOptions } from "./council-runtime";
import type { StartSessionMcpOptions } from "../provider-mcp-server-spec";

class FakeManagedSessionRunner {
  readonly started: Array<StartSessionRequest & StartSessionMcpOptions> = [];
  readonly inputs: Array<{ sessionId: string; request: SessionInputRequest }> = [];
  readonly interrupted: Array<{ sessionId: string; clientId: string }> = [];
  readonly closed: string[] = [];
  failOnStartIndex: number | null = null;
  private readonly sessions = new Set<string>();

  options(): Pick<
    CouncilRuntimeOptions,
    "startSession" | "sendInput" | "interruptSession" | "closeSession" | "hasSession"
  > {
    return {
      startSession: async (request) => {
        if (this.failOnStartIndex === this.started.length) {
          throw new Error("managed session launch failed");
        }
        const id = `managed:${request.provider}:${this.started.length + 1}`;
        this.started.push(request);
        this.sessions.add(id);
        return {
          session: {
            session: {
              id,
              provider: request.provider,
              providerSessionId: id,
              ...(request.origin !== undefined ? { origin: request.origin } : {}),
              launchSource: request.attach?.client.kind === "terminal" ? "terminal" : "web",
              liveBackend: request.liveBackend ?? "native_local_server",
              cwd: request.cwd,
              rootDir: request.cwd,
              title: request.title ?? id,
              preview: request.initialPrompt ?? "",
              runtimeState: "idle",
              updatedAt: new Date().toISOString(),
              createdAt: new Date().toISOString(),
              capabilities: {
                liveAttach: true,
                structuredTimeline: true,
                nativeTui: true,
                rawPtyInput: true,
                chatMirror: true,
                structuredControl: true,
                livePermissions: true,
                contextUsage: true,
                resumeByProvider: true,
                listProviderSessions: true,
                renameSession: false,
                actions: {
                  info: true,
                  stop: true,
                  delete: false,
                  rename: "none",
                },
                steerInput: true,
                queuedInput: true,
                modelSwitch: true,
                planMode: true,
                subagents: false,
              },
            },
            attachedClients: [],
            controlLease: {},
          },
        } as unknown as StartSessionResponse;
      },
      sendInput: (sessionId, request) => {
        this.inputs.push({ sessionId, request });
      },
      interruptSession: (sessionId, request) => {
        this.interrupted.push({ sessionId, clientId: request.clientId });
      },
      closeSession: async (sessionId) => {
        if (this.sessions.delete(sessionId)) {
          this.closed.push(sessionId);
        }
      },
      hasSession: (sessionId) => this.sessions.has(sessionId),
    };
  }
}

function createCouncilRuntime(
  options: CouncilRuntimeOptions,
  managedRunner = new FakeManagedSessionRunner(),
): CouncilRuntime {
  return new CouncilRuntime({
    ...options,
    ...managedRunner.options(),
  });
}

function fakeBinary(root: string, name: string): string {
  const binaryPath = path.join(root, name);
  writeFileSync(binaryPath, "#!/bin/sh\nprintf ready\n", "utf8");
  chmodSync(binaryPath, 0o755);
  return binaryPath;
}

function councilTerminalId(councilId: string, agentId: string): string {
  return `council:${councilId}:${Buffer.from(agentId, "utf8").toString("base64url")}`;
}

async function waitForCondition(
  predicate: () => boolean,
  message: string,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(predicate(), true, message);
}

test("CouncilRuntime launches managed agent sessions with provider launch specs and stops the council", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "rah-council-runtime-"));
  const previousCodex = process.env.RAH_CODEX_BINARY;
  const previousClaude = process.env.RAH_CLAUDE_BINARY;
  const previousGemini = process.env.RAH_GEMINI_BINARY;
  const previousOpenCode = process.env.RAH_OPENCODE_BINARY;
  const previousRahHome = process.env.RAH_HOME;
  process.env.RAH_CODEX_BINARY = fakeBinary(root, "codex");
  process.env.RAH_CLAUDE_BINARY = fakeBinary(root, "claude");
  process.env.RAH_GEMINI_BINARY = fakeBinary(root, "gemini");
  process.env.RAH_OPENCODE_BINARY = fakeBinary(root, "opencode");
  process.env.RAH_HOME = path.join(root, "rah-home");
  try {
    const managed = new FakeManagedSessionRunner();
    const eventBus = new EventBus();
    const runtime = createCouncilRuntime({
      store: new CouncilStore(path.join(root, "councils.json")),
      eventBus,
    }, managed);
    const response = await runtime.createCouncil({
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
          id: "gemini-planner",
          provider: "gemini",
          label: "Gemini Planner",
          role: "Plan implementation options with Gemini.",
          modelId: "gemini-2.5-pro",
          modeId: "yolo",
        },
        {
          id: "opencode-builder",
          provider: "opencode",
          label: "OpenCode Builder",
          role: "Inspect implementation details and report exact findings.",
        },
      ],
    });

    assert.equal(response.council.status, "running");
    assert.equal(response.council.phase, "starting");
    assert.deepEqual(response.council.agents.map((agent) => agent.status), ["starting", "starting", "starting", "starting"]);
    const codexId = response.council.agents[0]!.id;
    const claudeId = response.council.agents[1]!.id;
    const geminiId = response.council.agents[2]!.id;
    const opencodeId = response.council.agents[3]!.id;
    assert.deepEqual([codexId, claudeId, geminiId, opencodeId], ["Codex Lead", "Claude Reviewer", "Gemini Planner", "OpenCode Builder"]);
    await waitForCondition(() => managed.started.length === 4, "expected all council agents to launch as managed sessions");
    const launchedCouncil = runtime.listCouncils().councils.find((council) => council.id === response.council.id)!;
    assert.equal(launchedCouncil.status, "running");
    assert.equal(managed.started[0]!.provider, "codex");
    assert.equal(managed.started[0]!.liveBackend, "native_local_server");
    assert.deepEqual(managed.started[0]!.origin, {
      kind: "council",
      councilId: response.council.id,
      councilTitle: "Launch Council",
      agentId: codexId,
      agentLabel: "Codex Lead",
    });
    assert.equal(managed.started[0]!.cwd, root);
    assert.equal(managed.started[0]!.model, "gpt-5.5");
    assert.equal(managed.started[0]!.reasoningId, "xhigh");
    assert.equal(managed.started[0]!.modeId, "never/danger-full-access");
    assert.equal(managed.started[0]!.attach?.client.id, `rah-council:${response.council.id}:${codexId}`);
    assert.equal(managed.started[0]!.attach?.claimControl, true);
    assert.equal(managed.started[0]!.extraMcpServers?.[0]?.name, "rah_council");
    const codexPrompt = managed.inputs.find((input) => input.sessionId === "managed:codex:1")?.request.text ?? "";
    assert.match(codexPrompt, /你的唯一名字是 'Codex Lead'/);
    assert.match(codexPrompt, /你的角色: Lead implementation and propose concrete changes\./);
    assert.match(codexPrompt, /用户消息优先级最高/);
    assert.match(codexPrompt, /只能处理 rah_council 工具返回的 recent_messages 或 msg/);
    assert.match(codexPrompt, /@all 表示全体 agent 都应参与讨论/);
    assert.doesNotMatch(codexPrompt, /@council/);
    assert.match(codexPrompt, /timeout 是心跳/);
    assert.match(codexPrompt, /收到 timed_out=true 后不要输出任何自然语言/);
    assert.equal(managed.started[1]!.provider, "claude");
    assert.equal(managed.started[1]!.liveBackend, "tui_mux");
    assert.equal(managed.started[1]!.model, "opus");
    assert.deepEqual(managed.started[1]!.optionValues, { effort: "max" });
    assert.equal(managed.started[1]!.modeId, "bypassPermissions");
    assert.equal(managed.started[1]!.extraMcpServers?.[0]?.name, "rah_council");
    assert.deepEqual(managed.started[1]!.origin, {
      kind: "council",
      councilId: response.council.id,
      councilTitle: "Launch Council",
      agentId: claudeId,
      agentLabel: "Claude Reviewer",
    });
    const claudePrompt = managed.started[1]!.initialPrompt ?? "";
    assert.match(claudePrompt, /你的唯一名字是 'Claude Reviewer'/);
    assert.match(claudePrompt, /你的角色: Review risks and challenge weak assumptions\./);
    assert.match(claudePrompt, /mcp__rah_council__channel_join/);
    assert.match(claudePrompt, /不要用 Bash、echo、curl、ps、node/);
    assert.match(claudePrompt, /必须先实际调用下面的 MCP 工具/);
    assert.doesNotMatch(claudePrompt, /工具不可见/);
    const claudeSentMessage = runtime.listCouncils().councils
      .find((council) => council.id === response.council.id)?.messages
      .some((message) => message.parts.some((part) => part.kind === "text" && part.text === `${claudeId} sent`));
    assert.equal(claudeSentMessage, true);
    assert.equal(managed.started[2]!.provider, "gemini");
    assert.equal(managed.started[2]!.liveBackend, "tui_mux");
    assert.equal(managed.started[2]!.model, "gemini-2.5-pro");
    assert.equal(managed.started[2]!.modeId, "yolo");
    assert.equal(managed.started[2]!.extraMcpServers?.[0]?.name, "rah_council");
    assert.deepEqual(managed.started[2]!.origin, {
      kind: "council",
      councilId: response.council.id,
      councilTitle: "Launch Council",
      agentId: geminiId,
      agentLabel: "Gemini Planner",
    });
    const geminiPrompt = managed.started[2]!.initialPrompt ?? "";
    assert.match(geminiPrompt, /你的唯一名字是 'Gemini Planner'/);
    assert.match(geminiPrompt, /你的角色: Plan implementation options with Gemini\./);
    assert.match(geminiPrompt, /mcp_rah_council_channel_join/);
    assert.doesNotMatch(geminiPrompt, /mcp__rah_council__channel_join/);
    assert.equal(managed.started[3]!.provider, "opencode");
    assert.equal(managed.started[3]!.liveBackend, "native_local_server");
    assert.equal(managed.started[3]!.extraMcpServers?.[0]?.name, "rah_council");
    const openCodePrompt = managed.inputs.find((input) => input.sessionId === "managed:opencode:4")?.request.text ?? "";
    assert.match(openCodePrompt, /你的唯一名字是 'OpenCode Builder'/);
    assert.match(openCodePrompt, /你的角色: Inspect implementation details and report exact findings\./);
    assert.match(openCodePrompt, /timeout_s=120/);
    const initialStatusTexts = runtime.listCouncils().councils.find((council) => council.id === response.council.id)!.messages.map((message) =>
      message.parts.map((part) => part.kind === "text" ? part.text : JSON.stringify(part.data)).join("\n")
    );
    assert.equal(initialStatusTexts.includes(`${codexId} sent`), true);
    assert.equal(initialStatusTexts.includes(`${claudeId} sent`), true);
    assert.equal(initialStatusTexts.includes(`${geminiId} sent`), true);
    assert.equal(initialStatusTexts.includes(`${opencodeId} sent`), true);
    assert.equal(
      eventBus.list({
        sessionIds: [response.council.id],
        eventTypes: ["council.message.created"],
      }).length,
      5,
    );
    await runtime.callMcpTool({
      councilId: response.council.id,
      actorId: codexId,
      tool: "channel_post",
      arguments: { content: "Codex lead reporting in." },
    });
    const councilEvents = eventBus.list({
      sessionIds: [response.council.id],
      eventTypes: ["council.message.created"],
    });
    assert.equal(councilEvents.length, 6);
    const agentMessageEvent = councilEvents.at(-1)!;
    assert.equal(agentMessageEvent.type, "council.message.created");
    if (agentMessageEvent.type === "council.message.created") {
      assert.equal(agentMessageEvent.payload.message.actorId, codexId);
    }

    const tui = await runtime.getAgentTui(response.council.id, codexId);
    assert.equal(tui.terminalId, "managed:codex:1");
    assert.equal(tui.screen, undefined);

    await runtime.stopCouncil(response.council.id);
    assert.deepEqual(managed.closed, ["managed:codex:1", "managed:claude:2", "managed:gemini:3", "managed:opencode:4"]);
    assert.equal(runtime.listCouncils().councils[0]!.status, "stopped");
  } finally {
    if (previousCodex === undefined) delete process.env.RAH_CODEX_BINARY;
    else process.env.RAH_CODEX_BINARY = previousCodex;
    if (previousClaude === undefined) delete process.env.RAH_CLAUDE_BINARY;
    else process.env.RAH_CLAUDE_BINARY = previousClaude;
    if (previousGemini === undefined) delete process.env.RAH_GEMINI_BINARY;
    else process.env.RAH_GEMINI_BINARY = previousGemini;
    if (previousOpenCode === undefined) delete process.env.RAH_OPENCODE_BINARY;
    else process.env.RAH_OPENCODE_BINARY = previousOpenCode;
    if (previousRahHome === undefined) delete process.env.RAH_HOME;
    else process.env.RAH_HOME = previousRahHome;
    rmSync(root, { force: true, recursive: true });
  }
});

test("CouncilRuntime can append an agent to an already running council", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "rah-council-runtime-add-agent-"));
  const previousCodex = process.env.RAH_CODEX_BINARY;
  const previousOpenCode = process.env.RAH_OPENCODE_BINARY;
  const previousRahHome = process.env.RAH_HOME;
  process.env.RAH_CODEX_BINARY = fakeBinary(root, "codex");
  process.env.RAH_OPENCODE_BINARY = fakeBinary(root, "opencode");
  process.env.RAH_HOME = path.join(root, "rah-home");
  try {
    const managed = new FakeManagedSessionRunner();
    const runtime = createCouncilRuntime({
      store: new CouncilStore(path.join(root, "councils.json")),
    }, managed);
    const created = await runtime.createCouncil({
      title: "Expandable Council",
      workspace: root,
      agents: [{ provider: "codex", label: "Codex Lead" }],
    });
    const councilId = created.council.id;
    await waitForCondition(() => managed.started.length === 1, "expected initial council managed session to launch");
    assert.equal(managed.started[0]!.provider, "codex");

    const added = await runtime.addAgent(councilId, {
      agent: {
        provider: "opencode",
        label: "OpenCode Reviewer",
        role: "Review the current plan.",
        modelId: "deepseek/deepseek-v4-pro",
        reasoningId: "high",
        optionValues: { reasoning_effort: "high" },
      },
    });

    assert.equal(added.agent.id, "OpenCode Reviewer");
    assert.equal(added.council.status, "running");
    assert.equal(added.council.agents.length, 2);
    assert.equal(managed.started.length, 2);
    assert.equal(managed.started[1]!.provider, "opencode");
    assert.equal(managed.started[1]!.model, "deepseek/deepseek-v4-pro");
    assert.equal(managed.started[1]!.reasoningId, "high");
    assert.deepEqual(managed.started[1]!.optionValues, { reasoning_effort: "high" });
    assert.match(managed.inputs.at(-1)?.request.text ?? "", /OpenCode Reviewer/);
    assert.equal(
      added.council.messages.some((message) =>
        message.actorId === "OpenCode Reviewer" &&
        message.parts.some((part) => part.kind === "text" && part.text === "OpenCode Reviewer sent")
      ),
      true,
    );

    await runtime.stopCouncil(councilId);
    assert.deepEqual(managed.closed, ["managed:codex:1", "managed:opencode:2"]);
  } finally {
    if (previousCodex === undefined) delete process.env.RAH_CODEX_BINARY;
    else process.env.RAH_CODEX_BINARY = previousCodex;
    if (previousOpenCode === undefined) delete process.env.RAH_OPENCODE_BINARY;
    else process.env.RAH_OPENCODE_BINARY = previousOpenCode;
    if (previousRahHome === undefined) delete process.env.RAH_HOME;
    else process.env.RAH_HOME = previousRahHome;
    rmSync(root, { force: true, recursive: true });
  }
});

test("CouncilRuntime dry-run records launch-ready native local server terminals", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "rah-council-dry-"));
  const previousOpenCode = process.env.RAH_OPENCODE_BINARY;
  process.env.RAH_OPENCODE_BINARY = fakeBinary(root, "opencode");
  try {
    const runtime = createCouncilRuntime({
      store: new CouncilStore(path.join(root, "councils.json")),
      dryRun: true,
    });
    const response = await runtime.createCouncil({
      workspace: root,
      agents: [{ id: "opencode-api", provider: "opencode", label: "OpenCode API" }],
    });
    const agentId = response.council.agents[0]!.id;
    assert.equal(agentId, "OpenCode API");
    assert.equal(response.council.agents[0]!.nativeSessionId, councilTerminalId(response.council.id, agentId));
    assert.equal(response.council.agents[0]!.terminalId, undefined);
    assert.equal(response.council.status, "running");
    assert.throws(() => runtime.deleteCouncil(response.council.id), /Stop this council before deleting/);
    await runtime.stopCouncil(response.council.id);
    runtime.deleteCouncil(response.council.id);
    assert.equal(runtime.listCouncils().councils.length, 0);
  } finally {
    if (previousOpenCode === undefined) delete process.env.RAH_OPENCODE_BINARY;
    else process.env.RAH_OPENCODE_BINARY = previousOpenCode;
    rmSync(root, { force: true, recursive: true });
  }
});

test("CouncilRuntime renames running and stopped councils", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "rah-council-rename-"));
  try {
    const store = new CouncilStore(path.join(root, "councils.json"));
    const created = store.createCouncil({
      title: "Original Council",
      workspace: root,
      agents: [{ id: "agent-a", provider: "codex", label: "Agent A" }],
    });
    const runtime = createCouncilRuntime({ store });

    const renamedRunning = runtime.renameCouncil(created.id, "  Running Rename  ");
    assert.equal(renamedRunning.title, "Running Rename");

    await runtime.stopCouncil(created.id);
    const renamedStopped = runtime.renameCouncil(created.id, "Stopped Rename");
    assert.equal(renamedStopped.title, "Stopped Rename");
    assert.equal(
      runtime.listCouncils().councils.find((council) => council.id === created.id)?.title,
      "Stopped Rename",
    );
    assert.throws(() => runtime.renameCouncil(created.id, "  "), /Council title is required/);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("CouncilRuntime projects persisted active councils from live managed session facts without mutating store", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "rah-council-runtime-projection-"));
  const filePath = path.join(root, "councils.json");
  try {
    const store = new CouncilStore(filePath);
    const created = store.createCouncil({
      workspace: root,
      agents: [{ id: "agent-a", provider: "codex", label: "Agent A" }],
    });
    const agentId = created.agents[0]!.id;
    store.updateCouncil(created.id, { status: "running", phase: "ready" });
    store.updateAgent(created.id, agentId, {
      status: "idle",
      nativeSessionId: councilTerminalId(created.id, agentId),
    });

    const reloadedStore = new CouncilStore(filePath);
    assert.equal(reloadedStore.snapshot(created.id).status, "running");

    const runtime = createCouncilRuntime({
      store: reloadedStore,
    });
    const projected = runtime.listCouncils().councils.find((council) => council.id === created.id);

    assert.equal(projected?.status, "stopped");
    assert.equal(projected?.agents[0]?.status, "stopped");
    assert.equal(reloadedStore.snapshot(created.id).status, "running");
    assert.throws(
      () => runtime.postMessage(created.id, { text: "should not post to stale council" }),
      /Council is stopped/,
    );
    const state = await runtime.callMcpTool({
      councilId: created.id,
      actorId: agentId,
      clientId: "client-a",
      tool: "channel_state",
    }) as {
      result: {
        council: { status: string };
        agents: Array<{ status: string }>;
        active_agents: Array<{ status: string }>;
      };
    };
    assert.equal(state.result.council.status, "stopped");
    assert.equal(state.result.agents[0]?.status, "stopped");
    assert.equal(state.result.active_agents[0]?.status, "stopped");
    const history = await runtime.callMcpTool({
      councilId: created.id,
      actorId: agentId,
      clientId: "client-a",
      tool: "channel_history",
    }) as { result: { messages: unknown[] } };
    assert.equal(Array.isArray(history.result.messages), true);
    await assert.rejects(
      () => runtime.callMcpTool({
        councilId: created.id,
        actorId: agentId,
        clientId: "client-a",
        tool: "channel_join",
      }),
      /Council is stopped/,
    );
    await assert.rejects(
      () => runtime.callMcpTool({
        councilId: created.id,
        actorId: agentId,
        clientId: "client-a",
        tool: "channel_post",
        arguments: { content: "should not post to stale council" },
      }),
      /Council is stopped/,
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("CouncilRuntime preserves agent-council wait cursor, inbox, claims, and controls", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "rah-council-runtime-mcp-"));
  try {
    const runtime = createCouncilRuntime({
      store: new CouncilStore(path.join(root, "councils.json")),
      dryRun: true,
    });
    const response = await runtime.createCouncil({
      workspace: root,
      agents: [
        { id: "agent-a", provider: "codex", label: "Agent A" },
        { id: "agent-b", provider: "claude", label: "Agent B" },
      ],
    });
    const councilId = response.council.id;
    const agentA = response.council.agents[0]!.id;
    const agentB = response.council.agents[1]!.id;

    const joined = await runtime.callMcpTool({
      councilId,
      actorId: agentA,
      clientId: "client-a",
      tool: "channel_join",
    }) as { result: { last_msg_id: number; recent_messages: unknown[] } };
    assert.equal(joined.result.last_msg_id, 1);
    assert.equal(joined.result.recent_messages.length, 1);

    const waiting = runtime.callMcpTool({
      councilId,
      actorId: agentA,
      clientId: "client-a",
      tool: "channel_wait_new",
      arguments: { timeout_s: 1 },
    }) as Promise<{ result: { msg?: { actor: string; content: string }; timed_out?: true } }>;
    runtime.postMessage(councilId, { text: "Question for the council." });
    const waited = await waiting;
    assert.equal(waited.result.msg?.actor, "user");
    assert.equal(waited.result.msg?.content, "Question for the council.");

    const repeated = await runtime.callMcpTool({
      councilId,
      actorId: agentA,
      clientId: "client-a",
      tool: "channel_wait_new",
      arguments: { timeout_s: 0.01 },
    }) as { result: { timed_out?: true } };
    assert.equal(repeated.result.timed_out, true);

    runtime.postMessage(councilId, { actorId: "user", text: "Non-blocking inbox item." });
    const peeked = await runtime.callMcpTool({
      councilId,
      actorId: agentA,
      clientId: "client-a",
      tool: "channel_peek_inbox",
    }) as { result: { messages: Array<{ content: string }> } };
    assert.equal(peeked.result.messages.at(-1)?.content, "Non-blocking inbox item.");
    const peekedAgain = await runtime.callMcpTool({
      councilId,
      actorId: agentA,
      clientId: "client-a",
      tool: "channel_peek_inbox",
    }) as { result: { messages: unknown[] } };
    assert.equal(peekedAgain.result.messages.length, 0);

    const claim = await runtime.callMcpTool({
      councilId,
      actorId: agentA,
      clientId: "client-a",
      tool: "channel_claim_file",
      arguments: { path: "src/shared.ts" },
    }) as { result: { actor: string; path: string } };
    assert.equal(claim.result.actor, agentA);
    assert.equal(claim.result.path, "src/shared.ts");
    await assert.rejects(
      () => runtime.callMcpTool({
        councilId,
        actorId: agentB,
        clientId: "client-b",
        tool: "channel_claim_file",
        arguments: { path: "src/shared.ts" },
      }),
      /file_conflict/,
    );

    await runtime.callMcpTool({
      councilId,
      actorId: agentA,
      clientId: "client-a",
      tool: "channel_send_control",
      arguments: { target: agentB, action: "interrupt", task_id: "task-1" },
    });
    const controls = await runtime.callMcpTool({
      councilId,
      actorId: agentB,
      clientId: "client-b",
      tool: "channel_peek_control",
    }) as { result: { count: number; controls: Array<{ action: string; taskId?: string }> } };
    assert.equal(controls.result.count, 1);
    assert.equal(controls.result.controls[0]!.action, "interrupt");
    assert.equal(controls.result.controls[0]!.taskId, "task-1");
    await runtime.stopCouncil(councilId);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("CouncilRuntime treats wait timeout as a heartbeat without auto re-injection", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "rah-council-runtime-wait-timeout-"));
  try {
    const runtime = createCouncilRuntime({
      store: new CouncilStore(path.join(root, "councils.json")),
      dryRun: true,
    });
    const response = await runtime.createCouncil({
      workspace: root,
      agents: [{ provider: "codex", label: "Codex Listener" }],
    });
    const councilId = response.council.id;
    const agentId = response.council.agents[0]!.id;

    const before = runtime.listCouncils().councils.find((council) => council.id === councilId)!;
    const beforeMessageCount = before.messages.length;
    const timedOut = await runtime.callMcpTool({
      councilId,
      actorId: agentId,
      clientId: "client-a",
      tool: "channel_wait_new",
      arguments: { timeout_s: 0.01 },
    }) as { result: { timed_out?: true; next_action?: string; instruction?: string } };
    assert.equal(timedOut.result.timed_out, true);
    assert.equal(timedOut.result.next_action, "call_channel_wait_new_again");
    assert.match(timedOut.result.instruction ?? "", /heartbeat/);

    const snapshot = runtime.listCouncils().councils.find((council) => council.id === councilId)!;
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

test("CouncilRuntime does not project legacy wait-timeout noise to frontend councils or events", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "rah-council-runtime-timeout-noise-"));
  try {
    const eventBus = new EventBus();
    const runtime = createCouncilRuntime({
      store: new CouncilStore(path.join(root, "councils.json")),
      dryRun: true,
      eventBus,
    });
    const response = await runtime.createCouncil({
      workspace: root,
      agents: [{ provider: "codex", label: "Codex Listener" }],
    });
    const councilId = response.council.id;

    const beforeEvents = eventBus.list({
      sessionIds: [councilId],
      eventTypes: ["council.message.created"],
    }).length;
    runtime.postMessage(councilId, {
      role: "system",
      text: "Codex Listener wait timed out; no active listener is currently blocking on channel_wait_new.",
    });

    const projected = runtime.listCouncils().councils.find((council) => council.id === councilId)!;
    assert.equal(
      projected.messages.some((message) => (
        message.parts.some((part) => part.kind === "text" && part.text.includes("wait timed out"))
      )),
      false,
    );
    const page = runtime.readCouncilMessages(councilId, { limit: 100 });
    assert.equal(page.total, projected.messages.length);
    assert.deepEqual(
      page.messages.map((message) => message.id),
      projected.messages.map((message) => message.id),
    );
    assert.equal(
      eventBus.list({
        sessionIds: [councilId],
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
    const runtime = createCouncilRuntime({
      store: new CouncilStore(path.join(root, "councils.json")),
      dryRun: true,
      eventBus,
    });
    const response = await runtime.createCouncil({
      workspace: root,
      agents: [{ provider: "codex", label: "Codex Listener" }],
    });
    const councilId = response.council.id;
    const agentId = response.council.agents[0]!.id;
    const beforeEvents = eventBus.list({
      sessionIds: [councilId],
      eventTypes: ["council.message.created"],
    }).length;

    await runtime.callMcpTool({
      councilId,
      actorId: agentId,
      clientId: "client-a",
      tool: "channel_join",
    });
    await runtime.callMcpTool({
      councilId,
      actorId: agentId,
      clientId: "client-a",
      tool: "channel_wait_new",
      arguments: { timeout_s: 0.01 },
    });

    const projected = runtime.listCouncils().councils.find((council) => council.id === councilId)!;
    const visibleTexts = projected.messages.map((message) =>
      message.parts.map((part) => part.kind === "text" ? part.text : JSON.stringify(part.data)).join("\n")
    );
    assert.equal(visibleTexts.includes(`${agentId} joined`), true);
    assert.equal(visibleTexts.includes(`${agentId} listening`), true);
    const events = eventBus.list({
      sessionIds: [councilId],
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
    const runtime = createCouncilRuntime({
      store: new CouncilStore(path.join(root, "councils.json")),
      dryRun: true,
    });
    const response = await runtime.createCouncil({
      workspace: root,
      agents: [{ provider: "codex", label: "Codex Listener" }],
    });
    const councilId = response.council.id;
    const agentId = response.council.agents[0]!.id;

    const timedOut = await runtime.callMcpTool({
      councilId,
      actorId: agentId,
      clientId: "client-a",
      tool: "channel_wait_new",
      arguments: { timeout_s: 0.01 },
    }) as { result: { timed_out?: true } };
    assert.equal(timedOut.result.timed_out, true);

    const secondWait = runtime.callMcpTool({
      councilId,
      actorId: agentId,
      clientId: "client-a",
      tool: "channel_wait_new",
      arguments: { timeout_s: 1 },
    }) as Promise<{ result: { msg?: { content: string } } }>;

    const waitingSnapshot = runtime.listCouncils().councils.find((council) => council.id === councilId)!;
    assert.equal(waitingSnapshot.agents[0]!.status, "waiting");
    assert.equal(waitingSnapshot.agents[0]!.lastStatusDetail, "listening");

    runtime.postMessage(councilId, { text: "Still listening?" });
    const delivered = await secondWait;
    assert.equal(delivered.result.msg?.content, "Still listening?");
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("CouncilRuntime announces listening again after an agent re-joins", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "rah-council-runtime-rejoin-listening-"));
  try {
    const runtime = createCouncilRuntime({
      store: new CouncilStore(path.join(root, "councils.json")),
      dryRun: true,
    });
    const response = await runtime.createCouncil({
      workspace: root,
      agents: [{ provider: "codex", label: "Codex Listener" }],
    });
    const councilId = response.council.id;
    const agentId = response.council.agents[0]!.id;

    await runtime.callMcpTool({
      councilId,
      actorId: agentId,
      clientId: "client-a",
      tool: "channel_join",
    });
    await runtime.callMcpTool({
      councilId,
      actorId: agentId,
      clientId: "client-a",
      tool: "channel_wait_new",
      arguments: { timeout_s: 0.01 },
    });
    await runtime.callMcpTool({
      councilId,
      actorId: agentId,
      clientId: "client-a",
      tool: "channel_join",
    });
    await runtime.callMcpTool({
      councilId,
      actorId: agentId,
      clientId: "client-a",
      tool: "channel_wait_new",
      arguments: { timeout_s: 0.01 },
    });

    const snapshot = runtime.listCouncils().councils.find((council) => council.id === councilId)!;
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
    const managed = new FakeManagedSessionRunner();
    const runtime = createCouncilRuntime({
      store: new CouncilStore(path.join(root, "councils.json")),
    }, managed);
    const response = await runtime.createCouncil({
      workspace: root,
      agents: [{ provider: "codex", label: "Codex Listener" }],
    });
    const councilId = response.council.id;
    const agentId = response.council.agents[0]!.id;

    await runtime.callMcpTool({
      councilId,
      actorId: agentId,
      clientId: "client-a",
      tool: "channel_join",
    });
    const waiting = runtime.callMcpTool({
      councilId,
      actorId: agentId,
      clientId: "client-a",
      tool: "channel_wait_new",
      arguments: { timeout_s: 1 },
    }) as Promise<{ result: { msg?: { content: string } } }>;
    runtime.postMessage(councilId, { text: "Introduce yourself." });
    const waited = await waiting;
    assert.equal(waited.result.msg?.content, "Introduce yourself.");

    await runtime.callMcpTool({
      councilId,
      actorId: agentId,
      clientId: "client-a",
      tool: "channel_post",
      arguments: { text: "I am still here." },
    });

    const snapshot = runtime.listCouncils().councils.find((council) => council.id === councilId)!;
    assert.equal(snapshot.agents[0]!.status, "waiting");
    assert.equal(snapshot.agents[0]!.lastStatusDetail, "listening");
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

test("CouncilRuntime exposes council managed agents through the existing session TUI stream", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "rah-council-runtime-terminal-"));
  const previousClaude = process.env.RAH_CLAUDE_BINARY;
  process.env.RAH_CLAUDE_BINARY = fakeBinary(root, "claude");
  try {
    const managed = new FakeManagedSessionRunner();
    const store = new CouncilStore(path.join(root, "councils.json"));
    const runtime = createCouncilRuntime({
      store,
    }, managed);
    const response = await runtime.createCouncil({
      workspace: root,
      agents: [{ id: "claude-reviewer", provider: "claude", label: "Claude Reviewer" }],
    });
    const agentId = response.council.agents[0]!.id;
    await waitForCondition(() => managed.started.length === 1, "expected council managed session to launch");

    const tui = await runtime.getAgentTui(response.council.id, agentId);
    assert.equal(tui.terminalId, "managed:claude:1");
    assert.equal(tui.screen, undefined);

    await runtime.stopCouncil(response.council.id);
    assert.deepEqual(managed.closed, ["managed:claude:1"]);
  } finally {
    if (previousClaude === undefined) delete process.env.RAH_CLAUDE_BINARY;
    else process.env.RAH_CLAUDE_BINARY = previousClaude;
    rmSync(root, { force: true, recursive: true });
  }
});

test("CouncilRuntime shutdown closes live managed agent sessions", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "rah-council-runtime-shutdown-"));
  const previousClaude = process.env.RAH_CLAUDE_BINARY;
  process.env.RAH_CLAUDE_BINARY = fakeBinary(root, "claude");
  try {
    const managed = new FakeManagedSessionRunner();
    const store = new CouncilStore(path.join(root, "councils.json"));
    const runtime = createCouncilRuntime({
      store,
    }, managed);
    const response = await runtime.createCouncil({
      workspace: root,
      agents: [{ id: "claude-reviewer", provider: "claude", label: "Claude Reviewer" }],
    });
    await waitForCondition(() => managed.started.length === 1, "expected council managed session to launch");
    const agentId = response.council.agents[0]!.id;
    const tui = await runtime.getAgentTui(response.council.id, agentId);
    assert.equal(tui.terminalId, "managed:claude:1");

    await runtime.shutdown();

    assert.deepEqual(managed.closed, ["managed:claude:1"]);
    const persisted = store.snapshot(response.council.id);
    assert.equal(persisted.status, "stopped");
    assert.equal(persisted.agents[0]?.status, "stopped");
  } finally {
    if (previousClaude === undefined) delete process.env.RAH_CLAUDE_BINARY;
    else process.env.RAH_CLAUDE_BINARY = previousClaude;
    rmSync(root, { force: true, recursive: true });
  }
});

test("CouncilRuntime does not own snapshot frames for managed agent TUIs", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "rah-council-runtime-terminal-no-snapshot-"));
  const previousClaude = process.env.RAH_CLAUDE_BINARY;
  process.env.RAH_CLAUDE_BINARY = fakeBinary(root, "claude");
  try {
    const managed = new FakeManagedSessionRunner();
    const runtime = createCouncilRuntime({
      store: new CouncilStore(path.join(root, "councils.json")),
    }, managed);
    const response = await runtime.createCouncil({
      workspace: root,
      agents: [{ id: "claude-reviewer", provider: "claude", label: "Claude Reviewer" }],
    });
    const agentId = response.council.agents[0]!.id;
    await waitForCondition(() => managed.started.length === 1, "expected council managed session to launch");

    const tui = await runtime.getAgentTui(response.council.id, agentId);
    assert.equal(tui.terminalId, "managed:claude:1");
  } finally {
    if (previousClaude === undefined) delete process.env.RAH_CLAUDE_BINARY;
    else process.env.RAH_CLAUDE_BINARY = previousClaude;
    rmSync(root, { force: true, recursive: true });
  }
});

test("CouncilRuntime delegates managed agent replay ownership to the managed session", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "rah-council-runtime-terminal-raw-replay-"));
  const previousClaude = process.env.RAH_CLAUDE_BINARY;
  process.env.RAH_CLAUDE_BINARY = fakeBinary(root, "claude");
  try {
    const managed = new FakeManagedSessionRunner();
    const runtime = createCouncilRuntime({
      store: new CouncilStore(path.join(root, "councils.json")),
    }, managed);
    const response = await runtime.createCouncil({
      workspace: root,
      agents: [{ id: "claude-reviewer", provider: "claude", label: "Claude Reviewer" }],
    });
    const agentId = response.council.agents[0]!.id;
    await waitForCondition(() => managed.started.length === 1, "expected council managed session to launch");

    const tui = await runtime.getAgentTui(response.council.id, agentId);
    assert.equal(tui.terminalId, "managed:claude:1");
  } finally {
    if (previousClaude === undefined) delete process.env.RAH_CLAUDE_BINARY;
    else process.env.RAH_CLAUDE_BINARY = previousClaude;
    rmSync(root, { force: true, recursive: true });
  }
});

test("CouncilRuntime can re-inject bootstrap prompts and pause a managed agent listener without closing its session", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "rah-council-runtime-reinject-"));
  const previousClaude = process.env.RAH_CLAUDE_BINARY;
  process.env.RAH_CLAUDE_BINARY = fakeBinary(root, "claude");
  try {
    const managed = new FakeManagedSessionRunner();
    const runtime = createCouncilRuntime({
      store: new CouncilStore(path.join(root, "councils.json")),
    }, managed);
    const response = await runtime.createCouncil({
      workspace: root,
      agents: [{ provider: "claude", label: "Claude Reviewer" }],
    });
    const councilId = response.council.id;
    const agentId = response.council.agents[0]!.id;
    const terminalId = "managed:claude:1";
    await waitForCondition(() => managed.started.length === 1, "expected council managed session to launch");
    assert.equal(managed.started[0]!.initialPrompt?.includes("channel_join"), true);

    const reinjected = runtime.reinjectAgentPrompt(councilId, agentId);
    assert.deepEqual(reinjected.injectedAgentIds, [agentId]);
    assert.match(managed.inputs.at(-1)?.request.text ?? "", /channel_join/);
    assert.equal(managed.inputs.at(-1)?.sessionId, terminalId);
    assert.equal(reinjected.council.agents[0]!.status, "starting");
    assert.equal(reinjected.council.agents[0]!.lastStatusDetail, "bootstrap prompt re-injected");

    await runtime.callMcpTool({
      councilId,
      actorId: agentId,
      clientId: "client-a",
      tool: "channel_join",
    });
    const removed = runtime.removeAgentFromCouncil(councilId, agentId);
    assert.equal(removed.council.agents[0]!.status, "idle");
    assert.equal(removed.council.agents[0]!.lastStatusDetail, "listening paused");
    assert.equal(managed.options().hasSession!(terminalId), true);
    assert.deepEqual(managed.interrupted, [{ sessionId: terminalId, clientId: `rah-council:${councilId}:${agentId}` }]);
    const reinjectedAfterPause = runtime.reinjectAgentPrompt(councilId, agentId);
    assert.deepEqual(reinjectedAfterPause.injectedAgentIds, [agentId]);
    assert.equal(reinjectedAfterPause.council.agents[0]!.status, "starting");
    assert.equal(reinjectedAfterPause.council.agents[0]!.lastStatusDetail, "bootstrap prompt re-injected");
  } finally {
    if (previousClaude === undefined) delete process.env.RAH_CLAUDE_BINARY;
    else process.env.RAH_CLAUDE_BINARY = previousClaude;
    rmSync(root, { force: true, recursive: true });
  }
});

test("CouncilRuntime pauses managed OpenCode sessions through the structured runner", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "rah-council-runtime-opencode-pause-"));
  const previousOpenCode = process.env.RAH_OPENCODE_BINARY;
  process.env.RAH_OPENCODE_BINARY = fakeBinary(root, "opencode");
  try {
    const managed = new FakeManagedSessionRunner();
    const runtime = createCouncilRuntime({
      store: new CouncilStore(path.join(root, "councils.json")),
    }, managed);
    const response = await runtime.createCouncil({
      workspace: root,
      agents: [{ provider: "opencode", label: "OpenCode Builder" }],
    });
    const councilId = response.council.id;
    const agentId = response.council.agents[0]!.id;
    await waitForCondition(() => managed.started.length === 1, "expected OpenCode managed session to launch");

    const paused = runtime.removeAgentFromCouncil(councilId, agentId);

    assert.equal(paused.council.agents[0]!.status, "idle");
    assert.equal(paused.council.agents[0]!.lastStatusDetail, "listening paused");
    assert.deepEqual(managed.interrupted, [{ sessionId: "managed:opencode:1", clientId: `rah-council:${councilId}:${agentId}` }]);
  } finally {
    if (previousOpenCode === undefined) delete process.env.RAH_OPENCODE_BINARY;
    else process.env.RAH_OPENCODE_BINARY = previousOpenCode;
    rmSync(root, { force: true, recursive: true });
  }
});

test("CouncilRuntime pauses active managed OpenCode waiters without raw TUI escape", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "rah-council-runtime-opencode-active-pause-"));
  const previousOpenCode = process.env.RAH_OPENCODE_BINARY;
  process.env.RAH_OPENCODE_BINARY = fakeBinary(root, "opencode");
  try {
    const managed = new FakeManagedSessionRunner();
    const runtime = createCouncilRuntime({
      store: new CouncilStore(path.join(root, "councils.json")),
    }, managed);
    const response = await runtime.createCouncil({
      workspace: root,
      agents: [{ provider: "opencode", label: "OpenCode Builder" }],
    });
    const councilId = response.council.id;
    const agentId = response.council.agents[0]!.id;
    await waitForCondition(() => managed.started.length === 1, "expected OpenCode managed session to launch");
    await runtime.callMcpTool({
      councilId,
      actorId: agentId,
      clientId: "opencode-client",
      tool: "channel_join",
    });
    const waitPromise = runtime.callMcpTool({
      councilId,
      actorId: agentId,
      clientId: "opencode-client",
      tool: "channel_wait_new",
      arguments: { timeout_s: 60 },
    });

    const paused = runtime.removeAgentFromCouncil(councilId, agentId);

    assert.equal(paused.council.agents[0]!.status, "idle");
    assert.equal(paused.council.agents[0]!.lastStatusDetail, "listening paused");
    assert.deepEqual(managed.interrupted, []);
    assert.deepEqual((await waitPromise).result, {
      ok: true,
      paused: true,
      next_action: "stop_wait_loop",
      instruction: "Council listening was paused by the user. Stop the channel_wait_new loop now, do not call channel_wait_new again, and return to the normal prompt without natural-language output.",
    });
    const afterPrompt = runtime.listCouncils().councils.find((council) => council.id === councilId)!;
    assert.equal(afterPrompt.agents[0]!.status, "idle");
    assert.equal(afterPrompt.agents[0]!.lastStatusDetail, "listening paused");

    const reinjected = runtime.reinjectAgentPrompt(councilId, agentId);
    assert.deepEqual(reinjected.injectedAgentIds, [agentId]);
    assert.equal(reinjected.council.agents[0]!.status, "starting");
  } finally {
    if (previousOpenCode === undefined) delete process.env.RAH_OPENCODE_BINARY;
    else process.env.RAH_OPENCODE_BINARY = previousOpenCode;
    rmSync(root, { force: true, recursive: true });
  }
});

test("CouncilRuntime stops one agent terminal without affecting other agents", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "rah-council-runtime-stop-agent-"));
  const previousCodex = process.env.RAH_CODEX_BINARY;
  process.env.RAH_CODEX_BINARY = fakeBinary(root, "codex");
  try {
    const managed = new FakeManagedSessionRunner();
    const runtime = createCouncilRuntime({
      store: new CouncilStore(path.join(root, "councils.json")),
    }, managed);
    const response = await runtime.createCouncil({
      workspace: root,
      agents: [
        { provider: "codex", label: "Codex A" },
        { provider: "codex", label: "Codex B" },
      ],
    });
    const councilId = response.council.id;
    await waitForCondition(() => managed.started.length === 2, "expected both council managed sessions to launch");
    const stoppedTerminalId = "managed:codex:1";
    const liveTerminalId = "managed:codex:2";
    await runtime.callMcpTool({
      councilId,
      actorId: "Codex A",
      clientId: "codex-a-client",
      tool: "channel_join",
    });
    const waitPromise = runtime.callMcpTool({
      councilId,
      actorId: "Codex A",
      clientId: "codex-a-client",
      tool: "channel_wait_new",
      arguments: { timeout_s: 60 },
    });

    const stopped = await runtime.stopAgentInCouncil(councilId, "Codex A");

    assert.deepEqual(managed.closed, [stoppedTerminalId]);
    assert.equal(managed.options().hasSession!(stoppedTerminalId), false);
    assert.equal(managed.options().hasSession!(liveTerminalId), true);
    assert.equal(stopped.council.status, "running");
    assert.equal(stopped.council.agents.find((agent) => agent.id === "Codex A")!.status, "stopped");
    assert.equal(stopped.council.agents.find((agent) => agent.id === "Codex A")!.lastStatusDetail, "removed by user");
    assert.equal(stopped.council.agents.find((agent) => agent.id === "Codex B")!.status, "starting");
    assert.equal(stopped.council.messages.some((message) =>
      message.parts.some((part) => part.kind === "text" && part.text === "Codex A removed from council by user.")
    ), true);
    assert.deepEqual((await waitPromise).result, {
      ok: true,
      paused: true,
      next_action: "stop_wait_loop",
      instruction: "Council listening was paused by the user. Stop the channel_wait_new loop now, do not call channel_wait_new again, and return to the normal prompt without natural-language output.",
    });
  } finally {
    if (previousCodex === undefined) delete process.env.RAH_CODEX_BINARY;
    else process.env.RAH_CODEX_BINARY = previousCodex;
    rmSync(root, { force: true, recursive: true });
  }
});

test("CouncilRuntime stops the council when the last agent terminal is removed", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "rah-council-runtime-stop-last-agent-"));
  const previousCodex = process.env.RAH_CODEX_BINARY;
  process.env.RAH_CODEX_BINARY = fakeBinary(root, "codex");
  try {
    const managed = new FakeManagedSessionRunner();
    const runtime = createCouncilRuntime({
      store: new CouncilStore(path.join(root, "councils.json")),
    }, managed);
    const response = await runtime.createCouncil({
      workspace: root,
      agents: [
        {
          provider: "codex",
          label: "Codex Solo",
          modelId: "gpt-5.5",
        },
      ],
    });
    const councilId = response.council.id;
    await waitForCondition(() => managed.started.length === 1, "expected council managed session to launch");
    const terminalId = "managed:codex:1";

    const stopped = await runtime.stopAgentInCouncil(councilId, "Codex Solo");

    assert.deepEqual(managed.closed, [terminalId]);
    assert.equal(managed.options().hasSession!(terminalId), false);
    assert.equal(stopped.council.status, "stopped");
    assert.equal(stopped.council.agents[0]!.status, "stopped");
    assert.equal(stopped.council.agents[0]!.lastStatusDetail, "removed by user");
    assert.equal(runtime.listCouncils().councils.find((council) => council.id === councilId)!.status, "stopped");
    assert.throws(
      () => runtime.postMessage(councilId, { text: "hello after stop" }),
      /Council is stopped and cannot receive messages/,
    );
  } finally {
    if (previousCodex === undefined) delete process.env.RAH_CODEX_BINARY;
    else process.env.RAH_CODEX_BINARY = previousCodex;
    rmSync(root, { force: true, recursive: true });
  }
});

test("CouncilRuntime pauses active Claude waiters without sending Escape", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "rah-council-runtime-claude-pause-waiter-"));
  const previousClaude = process.env.RAH_CLAUDE_BINARY;
  const previousRahHome = process.env.RAH_HOME;
  process.env.RAH_CLAUDE_BINARY = fakeBinary(root, "claude");
  process.env.RAH_HOME = path.join(root, "rah-home");
  try {
    const runtime = createCouncilRuntime({
      store: new CouncilStore(path.join(root, "councils.json")),
    });
    const response = await runtime.createCouncil({
      workspace: root,
      agents: [{ provider: "claude", label: "Claude Reviewer" }],
    });
    const councilId = response.council.id;
    const agentId = response.council.agents[0]!.id;
    await runtime.callMcpTool({
      councilId,
      actorId: agentId,
      clientId: "claude-client",
      tool: "channel_join",
    });
    const waitPromise = runtime.callMcpTool({
      councilId,
      actorId: agentId,
      clientId: "claude-client",
      tool: "channel_wait_new",
      arguments: { timeout_s: 60 },
    });
    const paused = runtime.removeAgentFromCouncil(councilId, agentId);
    const waitResult = await waitPromise;

    assert.equal(paused.council.agents[0]!.status, "idle");
    assert.equal(paused.council.agents[0]!.lastStatusDetail, "listening paused");
    assert.deepEqual(waitResult.result, {
      ok: true,
      paused: true,
      next_action: "stop_wait_loop",
      instruction: "Council listening was paused by the user. Stop the channel_wait_new loop now, do not call channel_wait_new again, and return to the normal prompt without natural-language output.",
    });
  } finally {
    if (previousClaude === undefined) delete process.env.RAH_CLAUDE_BINARY;
    else process.env.RAH_CLAUDE_BINARY = previousClaude;
    if (previousRahHome === undefined) delete process.env.RAH_HOME;
    else process.env.RAH_HOME = previousRahHome;
    rmSync(root, { force: true, recursive: true });
  }
});

test("CouncilRuntime re-injects Claude bootstrap prompts without interrupting the TUI", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "rah-council-runtime-claude-reinject-"));
  const previousClaude = process.env.RAH_CLAUDE_BINARY;
  const previousRahHome = process.env.RAH_HOME;
  process.env.RAH_CLAUDE_BINARY = fakeBinary(root, "claude");
  process.env.RAH_HOME = path.join(root, "rah-home");
  try {
    const managed = new FakeManagedSessionRunner();
    const runtime = createCouncilRuntime({
      store: new CouncilStore(path.join(root, "councils.json")),
    }, managed);
    const response = await runtime.createCouncil({
      workspace: root,
      agents: [{ provider: "claude", label: "Claude Reviewer" }],
    });
    const councilId = response.council.id;
    const agentId = response.council.agents[0]!.id;
    await waitForCondition(() => managed.started.length === 1, "expected council managed session to launch");

    const reinjected = runtime.reinjectAgentPrompt(councilId, agentId);
    assert.deepEqual(reinjected.injectedAgentIds, [agentId]);
    assert.equal(reinjected.council.agents[0]!.lastStatusDetail, "bootstrap prompt re-injected");
    assert.deepEqual(managed.interrupted, []);
    assert.equal(managed.inputs.at(-1)?.sessionId, "managed:claude:1");
    assert.match(managed.inputs.at(-1)?.request.text ?? "", /mcp__rah_council__channel_join/);
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
    const runtime = createCouncilRuntime({
      store: new CouncilStore(path.join(root, "councils.json")),
    });
    const response = await runtime.createCouncil({
      workspace: root,
      agents: [{ provider: "codex", label: "Codex Listener" }],
    });
    const councilId = response.council.id;
    const agentId = response.council.agents[0]!.id;
    await runtime.callMcpTool({
      councilId,
      actorId: agentId,
      clientId: "client-a",
      tool: "channel_join",
    });
    const waitPromise = runtime.callMcpTool({
      councilId,
      actorId: agentId,
      clientId: "client-a",
      tool: "channel_wait_new",
      arguments: { timeout_s: 10 },
    });
    const reinjected = runtime.reinjectAgentPrompt(councilId, agentId);

    assert.deepEqual(reinjected.injectedAgentIds, []);
    assert.deepEqual(reinjected.skippedAgentIds, [agentId]);
    assert.equal(reinjected.council.agents[0]!.status, "waiting");
    runtime.postMessage(councilId, { text: "wake listener" });
    await waitPromise;
  } finally {
    if (previousCodex === undefined) delete process.env.RAH_CODEX_BINARY;
    else process.env.RAH_CODEX_BINARY = previousCodex;
    rmSync(root, { force: true, recursive: true });
  }
});

test("CouncilRuntime returns a diagnostic screen for persisted agents whose managed session is no longer live", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "rah-council-stale-"));
  const previousClaude = process.env.RAH_CLAUDE_BINARY;
  process.env.RAH_CLAUDE_BINARY = fakeBinary(root, "claude");
  try {
    const managed = new FakeManagedSessionRunner();
    const store = new CouncilStore(path.join(root, "councils.json"));
    const runtime = createCouncilRuntime({
      store,
    }, managed);
    const response = await runtime.createCouncil({
      workspace: root,
      agents: [{ id: "claude-reviewer", provider: "claude", label: "Claude Reviewer" }],
    });
    const agentId = response.council.agents[0]!.id;
    await waitForCondition(() => managed.started.length === 1, "expected council managed session to launch");
    const started = runtime.listCouncils().councils.find((council) => council.id === response.council.id)!;
    const terminalId = started.agents[0]!.nativeSessionId!;
    await managed.options().closeSession!(terminalId);

    const tui = await runtime.getAgentTui(response.council.id, agentId);
    assert.equal(tui.terminalId, undefined);
    assert.match(tui.screen ?? "", /terminal is not live anymore/);
  } finally {
    if (previousClaude === undefined) delete process.env.RAH_CLAUDE_BINARY;
    else process.env.RAH_CLAUDE_BINARY = previousClaude;
    rmSync(root, { force: true, recursive: true });
  }
});

test("CouncilRuntime reconciles persisted running councils without live agents", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "rah-council-stale-reconcile-"));
  const previousClaude = process.env.RAH_CLAUDE_BINARY;
  process.env.RAH_CLAUDE_BINARY = fakeBinary(root, "claude");
  try {
    const managed = new FakeManagedSessionRunner();
    const store = new CouncilStore(path.join(root, "councils.json"));
    const runtime = createCouncilRuntime({
      store,
    }, managed);
    const response = await runtime.createCouncil({
      workspace: root,
      agents: [{ id: "claude-reviewer", provider: "claude", label: "Claude Reviewer" }],
    });
    await waitForCondition(() => managed.started.length === 1, "expected council managed session to launch");
    const started = runtime.listCouncils().councils.find((council) => council.id === response.council.id)!;
    const terminalId = started.agents[0]!.nativeSessionId!;
    await managed.options().closeSession!(terminalId);

    runtime.reconcilePersistedRuntimeState();

    const persisted = store.snapshot(response.council.id);
    assert.equal(persisted.status, "stopped");
    assert.equal(persisted.agents[0]?.status, "stopped");
  } finally {
    if (previousClaude === undefined) delete process.env.RAH_CLAUDE_BINARY;
    else process.env.RAH_CLAUDE_BINARY = previousClaude;
    rmSync(root, { force: true, recursive: true });
  }
});

test("CouncilRuntime isolates a failed background agent launch without closing the council", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "rah-council-runtime-fail-"));
  const previousCodex = process.env.RAH_CODEX_BINARY;
  process.env.RAH_CODEX_BINARY = fakeBinary(root, "codex");
  try {
    const managed = new FakeManagedSessionRunner();
    managed.failOnStartIndex = 1;
    const runtime = createCouncilRuntime({
      store: new CouncilStore(path.join(root, "councils.json")),
    }, managed);

    const response = await runtime.createCouncil({
      workspace: root,
      agents: [
        { id: "codex-a", provider: "codex", label: "Codex A" },
        { id: "codex-b", provider: "codex", label: "Codex B" },
      ],
    });

    assert.equal(response.council.status, "running");
    assert.equal(response.council.phase, "starting");
    await waitForCondition(
      () => runtime.listCouncils().councils.find((council) => council.id === response.council.id)?.agents.some((agent) => agent.status === "failed") === true,
      "expected failed agent status after background launch",
    );
    const snapshot = runtime.listCouncils().councils.find((council) => council.id === response.council.id)!;
    assert.equal(snapshot.status, "running");
    assert.deepEqual(snapshot.agents.map((agent) => agent.status), ["starting", "failed"]);
    assert.deepEqual(managed.closed, []);
    assert.equal(snapshot.messages.at(-1)?.role, "system");
    const lastPart = snapshot.messages.at(-1)?.parts[0];
    assert.match(
      lastPart?.kind === "text" ? lastPart.text : "",
      /Codex B failed to start: managed session launch failed/,
    );
  } finally {
    if (previousCodex === undefined) delete process.env.RAH_CODEX_BINARY;
    else process.env.RAH_CODEX_BINARY = previousCodex;
    rmSync(root, { force: true, recursive: true });
  }
});

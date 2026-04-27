import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { validateProviderModelCatalog } from "@rah/runtime-protocol";
import { ClaudeAdapter } from "./claude-adapter";
import { EventBus } from "./event-bus";
import { PtyHub } from "./pty-hub";
import { SessionStore } from "./session-store";

describe("ClaudeAdapter", () => {
  let tmpClaudeConfig: string;
  let previousClaudeConfig: string | undefined;
  let previousClaudeModelCatalogOffline: string | undefined;
  let workDir: string;
  let projectDir: string;

  beforeEach(() => {
    previousClaudeConfig = process.env.CLAUDE_CONFIG_DIR;
    previousClaudeModelCatalogOffline = process.env.RAH_CLAUDE_MODEL_CATALOG_OFFLINE;
    tmpClaudeConfig = mkdtempSync(path.join(os.tmpdir(), "rah-claude-adapter-"));
    workDir = mkdtempSync(path.join(os.tmpdir(), "rah-claude-adapter-workdir-"));
    const projectId = path.resolve(workDir).replace(/[^a-zA-Z0-9]/g, "-");
    projectDir = path.join(tmpClaudeConfig, "projects", projectId);
    mkdirSync(projectDir, { recursive: true });
    process.env.CLAUDE_CONFIG_DIR = tmpClaudeConfig;
    process.env.RAH_CLAUDE_MODEL_CATALOG_OFFLINE = "1";
  });

  afterEach(() => {
    if (previousClaudeConfig === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR;
    } else {
      process.env.CLAUDE_CONFIG_DIR = previousClaudeConfig;
    }
    if (previousClaudeModelCatalogOffline === undefined) {
      delete process.env.RAH_CLAUDE_MODEL_CATALOG_OFFLINE;
    } else {
      process.env.RAH_CLAUDE_MODEL_CATALOG_OFFLINE = previousClaudeModelCatalogOffline;
    }
    rmSync(tmpClaudeConfig, { recursive: true, force: true });
    rmSync(workDir, { recursive: true, force: true });
  });

  function createServices() {
    return {
      eventBus: new EventBus(),
      ptyHub: new PtyHub(),
      sessionStore: new SessionStore(),
    };
  }

  function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
    const started = Date.now();
    return new Promise((resolve, reject) => {
      const tick = () => {
        if (predicate()) {
          resolve();
          return;
        }
        if (Date.now() - started > timeoutMs) {
          reject(new Error("Timed out waiting for condition"));
          return;
        }
        setTimeout(tick, 25);
      };
      tick();
    });
  }

  function writeClaudeSession() {
    writeFileSync(
      path.join(projectDir, "session-1.jsonl"),
      [
        JSON.stringify({
          type: "user",
          uuid: "user-1",
          cwd: workDir,
          sessionId: "session-1",
          timestamp: "2025-07-19T22:21:00.000Z",
          message: {
            content: "say lol",
          },
        }),
        JSON.stringify({
          type: "assistant",
          uuid: "assistant-1",
          cwd: workDir,
          sessionId: "session-1",
          timestamp: "2025-07-19T22:21:04.000Z",
          message: {
            content: [{ type: "text", text: "lol" }],
          },
        }),
      ].join("\n") + "\n",
    );
  }

  test("discovers stored sessions and rehydrates replay history", async () => {
    writeClaudeSession();
    const services = createServices();
    const adapter = new ClaudeAdapter(services);

    const stored = adapter.listStoredSessions();
    assert.equal(stored.length, 1);
    assert.equal(stored[0]?.providerSessionId, "session-1");

    const resumed = await adapter.resumeSession({
      provider: "claude",
      providerSessionId: "session-1",
      cwd: workDir,
      preferStoredReplay: true,
      attach: {
        client: {
          id: "web-1",
          kind: "web",
          connectionId: "web-1",
        },
        mode: "observe",
      },
    });

    assert.equal(resumed.session.session.capabilities.steerInput, false);
    assert.equal(resumed.session.session.capabilities.livePermissions, false);
    assert.equal(resumed.session.session.capabilities.actions.archive, false);
    assert.equal(
      services.eventBus
        .list({ sessionIds: [resumed.session.session.id] })
        .filter((event) => event.type === "timeline.item.added").length,
      0,
    );

    const page = adapter.getSessionHistoryPage(resumed.session.session.id, { limit: 20 });
    assert.ok(
      page.events.some(
        (event) =>
          event.type === "timeline.item.added" &&
          event.payload.item.kind === "user_message" &&
          event.payload.item.text === "say lol",
      ),
    );
    assert.ok(
      page.events.some(
        (event) =>
          event.type === "timeline.item.added" &&
          event.payload.item.kind === "assistant_message" &&
          event.payload.item.text === "lol",
      ),
    );
  });

  test("lists Claude models from layered local settings before a live session exists", async () => {
    writeFileSync(
      path.join(tmpClaudeConfig, "settings.json"),
      JSON.stringify({
        env: {
          ANTHROPIC_DEFAULT_SONNET_MODEL: "claude-sonnet-4-5",
          ANTHROPIC_DEFAULT_OPUS_MODEL: "claude-opus-4-6",
        },
        model: "opus",
      }),
      "utf8",
    );
    mkdirSync(path.join(workDir, ".claude"), { recursive: true });
    writeFileSync(
      path.join(workDir, ".claude", "settings.local.json"),
      JSON.stringify({
        env: {
          ANTHROPIC_DEFAULT_HAIKU_MODEL: "claude-haiku-4-5",
        },
        model: "haiku",
      }),
      "utf8",
    );

    const services = createServices();
    const adapter = new ClaudeAdapter(services);
    const catalog = await adapter.listModels({ cwd: workDir });

    assert.equal(catalog.provider, "claude");
    assert.equal(catalog.currentModelId, "haiku");
    assert.equal(catalog.source, "fallback");
    assert.equal(catalog.sourceDetail, "static_builtin");
    assert.equal(catalog.freshness, "stale");
    assert.equal(catalog.modelsExact, false);
    assert.equal(catalog.optionsExact, false);
    assert.equal(validateProviderModelCatalog(catalog).ok, true);
    assert.equal(catalog.modelProfiles?.find((profile) => profile.modelId === "default")?.configOptions[0]?.id, "effort");
    assert.equal(catalog.modelProfiles?.find((profile) => profile.modelId === "opus[1m]")?.configOptions[0]?.id, "effort");
    assert.equal(catalog.modelProfiles?.find((profile) => profile.modelId === "haiku")?.configOptions.length, 0);
    assert.deepEqual(
      catalog.models.map((model) => model.id),
      ["default", "sonnet[1m]", "opus[1m]", "haiku"],
    );
    assert.equal(catalog.models[0]?.label, "Default");
    assert.equal(catalog.models[1]?.label, "Sonnet (1M context)");
    assert.equal(catalog.models[2]?.label, "Opus (1M context)");
    assert.equal(catalog.models[3]?.label, "Haiku");
  });

  test("resumed live Claude sessions can be archived from RAH", async () => {
    const services = createServices();
    const adapter = new ClaudeAdapter(services, {
      queryFactory: (() => {
        throw new Error("query should not start during resume");
      }) as any,
    });

    const resumed = await adapter.resumeSession({
      provider: "claude",
      providerSessionId: "session-live-1",
      cwd: workDir,
      preferStoredReplay: false,
      attach: {
        client: {
          id: "web-1",
          kind: "web",
          connectionId: "web-1",
        },
        mode: "interactive",
        claimControl: true,
      },
    });

    assert.equal(resumed.session.session.capabilities.steerInput, true);
    assert.equal(resumed.session.session.capabilities.actions.archive, true);
  });

  test("starts a live Claude session, emits assistant text, and round-trips permissions", async () => {
    mkdirSync(path.join(workDir, ".claude"), { recursive: true });
    writeFileSync(
      path.join(workDir, ".claude", "settings.json"),
      JSON.stringify({
        env: {
          ANTHROPIC_DEFAULT_SONNET_MODEL: "claude-sonnet-4-5",
          ANTHROPIC_DEFAULT_OPUS_MODEL: "claude-opus-4-6",
        },
        model: "opus",
      }),
      "utf8",
    );
    const services = createServices();
    let observedEffort: string | number | undefined;
    const adapter = new ClaudeAdapter(services, {
      queryFactory: ({ options }) => {
        observedEffort = options?.effort;
        const iterator = (async function* () {
          const permissionResult = options?.canUseTool
            ? await options.canUseTool("Read", { file_path: "README.md" }, {
                signal: new AbortController().signal,
                toolUseID: "toolu_1",
                description: "Read README.md",
              })
            : { behavior: "allow" as const };
          if (permissionResult.behavior === "allow") {
            yield {
              type: "assistant",
              message: {
                role: "assistant",
                content: [{ type: "text", text: "Claude says hi" }],
              },
              parent_tool_use_id: null,
              uuid: "assistant-1",
              session_id: "claude-live-session-1",
            };
          }
          yield {
            type: "result",
            subtype: "success",
            duration_ms: 10,
            duration_api_ms: 5,
            is_error: false,
            num_turns: 1,
            result: "ok",
            stop_reason: null,
            total_cost_usd: 0,
            usage: {
              input_tokens: 5,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 0,
              output_tokens: 3,
            },
            modelUsage: {},
            permission_denials: [],
            uuid: "result-1",
            session_id: "claude-live-session-1",
          };
        })();
        return {
          next: iterator.next.bind(iterator),
          return: iterator.return?.bind(iterator),
          throw: iterator.throw?.bind(iterator),
          [Symbol.asyncIterator]() {
            return this;
          },
          close() {},
        } as any;
      },
    });

    const started = await adapter.startSession({
      provider: "claude",
      cwd: workDir,
      attach: {
        client: {
          id: "web-1",
          kind: "web",
          connectionId: "web-1",
        },
        mode: "interactive",
        claimControl: true,
      },
      providerConfig: {
        effort: "high",
      },
    });
    assert.equal(started.session.session.model?.currentModelId, "opus[1m]");
    assert.equal(started.session.session.model?.mutable, true);
    assert.equal(started.session.session.model?.availableModels.length, 4);
    assert.equal(started.session.session.modelProfile?.modelId, "opus[1m]");
    assert.equal(started.session.session.config?.values.effort, "high");

    adapter.sendInput(started.session.session.id, {
      clientId: "web-1",
      text: "say hi",
    });

    await waitFor(() => {
      const events = services.eventBus.list({ sessionIds: [started.session.session.id] });
      return events.some((event) => event.type === "permission.requested");
    });

    const permissionRequest = services.eventBus
      .list({ sessionIds: [started.session.session.id] })
      .find((event) => event.type === "permission.requested");
    assert.ok(permissionRequest);

    await adapter.respondToPermission(
      started.session.session.id,
      permissionRequest!.payload.request.id,
      { behavior: "allow" },
    );

    await waitFor(() => {
      const state = services.sessionStore.getSession(started.session.session.id);
      return state?.session.runtimeState === "idle";
    });

    const events = services.eventBus.list({ sessionIds: [started.session.session.id] });
    assert.ok(
      events.some(
        (event) =>
          event.type === "timeline.item.added" &&
          event.payload.item.kind === "assistant_message" &&
          event.payload.item.text === "Claude says hi",
      ),
    );
    assert.ok(
      events.some(
        (event) =>
          event.type === "permission.requested" &&
          event.payload.request.title === "Read File",
      ),
    );
    assert.ok(
      events.some(
        (event) =>
          event.type === "permission.resolved" &&
          event.payload.resolution.requestId === permissionRequest!.payload.request.id &&
          event.payload.resolution.behavior === "allow",
      ),
    );
    assert.ok(
      events.some(
        (event) =>
          event.type === "turn.completed" &&
          event.payload.usage?.inputTokens === 5,
      ),
    );
    assert.equal(observedEffort, "high");
  });

  test("switches Claude model and effort for subsequent turns", async () => {
    mkdirSync(path.join(workDir, ".claude"), { recursive: true });
    writeFileSync(
      path.join(workDir, ".claude", "settings.json"),
      JSON.stringify({
        env: {
          ANTHROPIC_DEFAULT_SONNET_MODEL: "claude-sonnet-4-5",
          ANTHROPIC_DEFAULT_OPUS_MODEL: "claude-opus-4-6",
        },
        model: "opus",
      }),
      "utf8",
    );
    const services = createServices();
    const observed: Array<{ model?: string; effort?: string | number }> = [];
    const adapter = new ClaudeAdapter(services, {
      queryFactory: ({ options }) => {
        observed.push({
          ...(options?.model ? { model: options.model } : {}),
          ...(options?.effort !== undefined ? { effort: options.effort } : {}),
        });
        const iterator = (async function* () {
          yield {
            type: "assistant",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "Claude switched" }],
            },
            parent_tool_use_id: null,
            uuid: "assistant-1",
            session_id: "claude-live-session-2",
          };
          yield {
            type: "result",
            subtype: "success",
            duration_ms: 10,
            duration_api_ms: 5,
            is_error: false,
            num_turns: 1,
            result: "ok",
            stop_reason: null,
            total_cost_usd: 0,
            usage: {
              input_tokens: 5,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 0,
              output_tokens: 3,
            },
            modelUsage: {},
            permission_denials: [],
            uuid: "result-1",
            session_id: "claude-live-session-2",
          };
        })();
        return {
          next: iterator.next.bind(iterator),
          return: iterator.return?.bind(iterator),
          throw: iterator.throw?.bind(iterator),
          [Symbol.asyncIterator]() {
            return this;
          },
          close() {},
        } as any;
      },
    });

    const started = await adapter.startSession({
      provider: "claude",
      cwd: workDir,
      attach: {
        client: {
          id: "web-1",
          kind: "web",
          connectionId: "web-1",
        },
        mode: "interactive",
        claimControl: true,
      },
    });
    const updated = await adapter.setSessionModel?.(started.session.session.id, {
      modelId: "default",
      reasoningId: "max",
    });

    assert.equal(updated?.session.model?.currentModelId, "default");
    assert.equal(updated?.session.model?.currentReasoningId, "max");
    assert.equal(updated?.session.modelProfile?.modelId, "default");
    assert.equal(updated?.session.config?.values.effort, "max");

    adapter.sendInput(started.session.session.id, {
      clientId: "web-1",
      text: "use selected model",
    });

    await waitFor(() => {
      const state = services.sessionStore.getSession(started.session.session.id);
      return state?.session.runtimeState === "idle";
    });

    assert.deepEqual(observed[0], {
      effort: "max",
    });
  });

  test("starts Claude with an explicit model and effort", async () => {
    const services = createServices();
    const observed: Array<{ model?: string; effort?: string | number }> = [];
    const adapter = new ClaudeAdapter(services, {
      queryFactory: ({ options }) => {
        observed.push({
          ...(options?.model ? { model: options.model } : {}),
          ...(options?.effort !== undefined ? { effort: options.effort } : {}),
        });
        const iterator = (async function* () {
          yield {
            type: "result",
            subtype: "success",
            duration_ms: 1,
            duration_api_ms: 1,
            is_error: false,
            num_turns: 1,
            result: "ok",
            stop_reason: null,
            total_cost_usd: 0,
            usage: {
              input_tokens: 1,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 0,
              output_tokens: 1,
            },
            modelUsage: {},
            permission_denials: [],
            uuid: "result-explicit",
            session_id: "claude-live-session-explicit",
          };
        })();
        return {
          next: iterator.next.bind(iterator),
          return: iterator.return?.bind(iterator),
          throw: iterator.throw?.bind(iterator),
          [Symbol.asyncIterator]() {
            return this;
          },
          close() {},
        } as any;
      },
    });

    const started = await adapter.startSession({
      provider: "claude",
      cwd: workDir,
      model: "opus[1m]",
      reasoningId: "max",
      attach: {
        client: {
          id: "web-1",
          kind: "web",
          connectionId: "web-1",
        },
        mode: "interactive",
        claimControl: true,
      },
    });

    adapter.sendInput(started.session.session.id, {
      clientId: "web-1",
      text: "use explicit model",
    });

    await waitFor(() => {
      const state = services.sessionStore.getSession(started.session.session.id);
      return state?.session.runtimeState === "idle";
    });

    assert.deepEqual(observed[0], {
      model: "opus[1m]",
      effort: "max",
    });
  });
});

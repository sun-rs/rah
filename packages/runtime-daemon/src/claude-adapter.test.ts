import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ClaudeAdapter } from "./claude-adapter";
import { EventBus } from "./event-bus";
import { PtyHub } from "./pty-hub";
import { SessionStore } from "./session-store";

describe("ClaudeAdapter", () => {
  let tmpClaudeConfig: string;
  let previousClaudeConfig: string | undefined;
  let workDir: string;
  let projectDir: string;

  beforeEach(() => {
    previousClaudeConfig = process.env.CLAUDE_CONFIG_DIR;
    tmpClaudeConfig = mkdtempSync(path.join(os.tmpdir(), "rah-claude-adapter-"));
    workDir = mkdtempSync(path.join(os.tmpdir(), "rah-claude-adapter-workdir-"));
    const projectId = path.resolve(workDir).replace(/[^a-zA-Z0-9]/g, "-");
    projectDir = path.join(tmpClaudeConfig, "projects", projectId);
    mkdirSync(projectDir, { recursive: true });
    process.env.CLAUDE_CONFIG_DIR = tmpClaudeConfig;
  });

  afterEach(() => {
    if (previousClaudeConfig === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR;
    } else {
      process.env.CLAUDE_CONFIG_DIR = previousClaudeConfig;
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

  test("starts a live Claude session, emits assistant text, and round-trips permissions", async () => {
    const services = createServices();
    const adapter = new ClaudeAdapter(services, {
      queryFactory: ({ options }) => {
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
    });

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
  });
});

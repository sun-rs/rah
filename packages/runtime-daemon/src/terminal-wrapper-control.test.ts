import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { TerminalWrapperRegistry, type TerminalWrapperBinding } from "./terminal-wrapper-control";

function createBinding(overrides?: Partial<TerminalWrapperBinding>): TerminalWrapperBinding {
  return {
    sessionId: "session-1",
    provider: "codex",
    cwd: "/repo",
    rootDir: "/repo",
    terminalPid: 1234,
    launchCommand: ["rah", "codex"],
    surfaceId: "terminal:1234:1",
    operatorGroupId: "group-1",
    promptState: "prompt_clean",
    ...overrides,
  };
}

describe("terminal wrapper registry", () => {
  test("registers and returns wrapper bindings without queue internals", () => {
    const registry = new TerminalWrapperRegistry();
    const binding = createBinding();
    registry.register(binding);

    assert.deepEqual(registry.get(binding.sessionId), binding);
  });

  test("updates prompt state and provider binding", () => {
    const registry = new TerminalWrapperRegistry();
    registry.register(createBinding());

    assert.equal(
      registry.updatePromptState("session-1", "prompt_dirty").promptState,
      "prompt_dirty",
    );
    assert.equal(
      registry.bindProviderSession("session-1", "thread-1").providerSessionId,
      "thread-1",
    );
  });

  test("queues remote turns in FIFO order", () => {
    const registry = new TerminalWrapperRegistry();
    registry.register(createBinding({ promptState: "prompt_dirty" }));

    const first = registry.enqueueRemoteTurn("session-1", "web:1", "one");
    const second = registry.enqueueRemoteTurn("session-1", "web:2", "two");

    assert.equal(registry.queuedTurnCount("session-1"), 2);
    assert.deepEqual(registry.peekQueuedTurn("session-1"), first);
    assert.equal(second.queuedTurnId, "session-1:queued:2");
  });

  test("only dequeues turns while prompt is clean", () => {
    const registry = new TerminalWrapperRegistry();
    registry.register(createBinding({ promptState: "agent_busy" }));

    const queuedTurn = registry.enqueueRemoteTurn("session-1", "web:1", "hello");
    assert.equal(registry.dequeueInjectableTurn("session-1"), undefined);

    registry.updatePromptState("session-1", "prompt_clean");
    assert.deepEqual(registry.dequeueInjectableTurn("session-1"), queuedTurn);
    assert.equal(registry.queuedTurnCount("session-1"), 0);
  });

  test("removes wrapper state", () => {
    const registry = new TerminalWrapperRegistry();
    registry.register(createBinding());
    registry.remove("session-1");

    assert.equal(registry.get("session-1"), undefined);
  });
});

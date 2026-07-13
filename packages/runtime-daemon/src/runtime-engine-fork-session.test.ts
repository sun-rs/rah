import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  ForkSessionRequest,
  ForkSessionResponse,
} from "@rah/runtime-protocol";
import type {
  ProviderAdapter,
  ProviderStructuredLifecycleAdapter,
} from "./provider-adapter";
import { RuntimeEngine } from "./runtime-engine";
import { toSessionSummary } from "./session-store";

class DelayedForkAdapter
  implements ProviderAdapter, ProviderStructuredLifecycleAdapter
{
  readonly id = "delayed-fork";
  readonly providers = ["codex" as const];
  engine!: RuntimeEngine;
  calls = 0;
  private releaseFork!: () => void;
  private readonly forkGate = new Promise<void>((resolve) => {
    this.releaseFork = resolve;
  });
  private notifyForkStarted!: () => void;
  readonly forkStarted = new Promise<void>((resolve) => {
    this.notifyForkStarted = resolve;
  });

  release(): void {
    this.releaseFork();
  }

  async forkSession(
    parentSessionId: string,
    request: ForkSessionRequest,
  ): Promise<ForkSessionResponse> {
    this.calls += 1;
    this.notifyForkStarted();
    await this.forkGate;
    const parent = this.engine.sessionStore.getSession(parentSessionId);
    assert.ok(parent);
    const child = this.engine.sessionStore.createManagedSession({
      provider: "codex",
      providerSessionId: `thread-child-${this.calls}`,
      launchSource: "web",
      cwd: parent.session.cwd,
      rootDir: parent.session.rootDir,
      relationship: {
        parentSessionId,
        ...(parent.session.providerSessionId
          ? { parentProviderSessionId: parent.session.providerSessionId }
          : {}),
        ...(request.lastTurnId ? { forkPointTurnId: request.lastTurnId } : {}),
        kind: request.kind,
        workspaceMode: request.workspaceMode,
        persistence: request.kind === "side" ? "ephemeral" : "persistent",
      },
    });
    return { session: toSessionSummary(child) };
  }
}

class RetryDestroyAdapter implements ProviderAdapter, ProviderStructuredLifecycleAdapter {
  readonly id = "retry-destroy";
  readonly providers = ["codex" as const];
  calls = 0;

  async destroySession(): Promise<void> {
    this.calls += 1;
    if (this.calls === 1) {
      throw new Error("temporary orphan cleanup failure");
    }
  }
}

class NoDestroyLifecycleAdapter implements ProviderAdapter, ProviderStructuredLifecycleAdapter {
  readonly id = "no-destroy-lifecycle";
  readonly providers = ["codex" as const];

  startSession(): never {
    throw new Error("not implemented");
  }
}

async function flushPromises(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

test("fork operations are single-flight and idempotent by operationId", async () => {
  const adapter = new DelayedForkAdapter();
  const engine = new RuntimeEngine([adapter]);
  adapter.engine = engine;
  await (engine as unknown as { startupMaintenance: Promise<void> }).startupMaintenance;
  const parent = engine.sessionStore.createManagedSession({
    provider: "codex",
    providerSessionId: "thread-parent",
    launchSource: "web",
    cwd: "/workspace/fork-idempotency",
    rootDir: "/workspace/fork-idempotency",
    capabilities: {
      branching: { sameWorkspace: true, worktree: false, side: true },
    },
  });
  engine.sessionStore.attachClient({
    sessionId: parent.session.id,
    clientId: "web-fork-test",
    kind: "web",
    connectionId: "connection-fork-test",
    attachMode: "interactive",
    focus: true,
  });
  const request: ForkSessionRequest = {
    operationId: "operation-1",
    kind: "side",
    workspaceMode: "shared",
  };

  try {
    const first = engine.forkSession(parent.session.id, request);
    await adapter.forkStarted;
    const duplicate = engine.forkSession(parent.session.id, request);
    await assert.rejects(
      engine.forkSession(parent.session.id, {
        ...request,
        operationId: "operation-2",
      }),
      /branch operation is already running/,
    );

    adapter.release();
    const [firstResponse, duplicateResponse] = await Promise.all([first, duplicate]);
    assert.equal(firstResponse.session.session.id, duplicateResponse.session.session.id);
    assert.equal(adapter.calls, 1);

    const retried = await engine.forkSession(parent.session.id, request);
    assert.equal(retried.session.session.id, firstResponse.session.session.id);
    assert.equal(adapter.calls, 1);
    await assert.rejects(
      engine.forkSession(parent.session.id, {
        ...request,
        kind: "fork",
      }),
      /already used with different parameters/,
    );
  } finally {
    adapter.release();
    await engine.shutdown();
  }
});

test("orphan pruning retains local state until provider cleanup succeeds", async () => {
  const adapter = new RetryDestroyAdapter();
  const engine = new RuntimeEngine([adapter]);
  await (engine as unknown as { startupMaintenance: Promise<void> }).startupMaintenance;
  const orphan = engine.sessionStore.createManagedSession({
    provider: "codex",
    providerSessionId: "thread-orphan-retry",
    launchSource: "web",
    cwd: "/workspace/orphan-retry",
    rootDir: "/workspace/orphan-retry",
  });

  try {
    engine.listSessions({ storedSessionsMode: "recent" });
    await flushPromises();
    assert.equal(engine.sessionStore.getSession(orphan.session.id)?.session.id, orphan.session.id);
    assert.equal(adapter.calls, 1);

    engine.listSessions({ storedSessionsMode: "recent" });
    await flushPromises();
    assert.equal(engine.sessionStore.getSession(orphan.session.id), undefined);
    assert.equal(adapter.calls, 2);
  } finally {
    await engine.shutdown();
  }
});

test("orphan pruning does not discard local state without provider destroy support", async () => {
  const engine = new RuntimeEngine([new NoDestroyLifecycleAdapter()]);
  await (engine as unknown as { startupMaintenance: Promise<void> }).startupMaintenance;
  const orphan = engine.sessionStore.createManagedSession({
    provider: "codex",
    providerSessionId: "thread-orphan-without-destroy",
    launchSource: "web",
    cwd: "/workspace/orphan-without-destroy",
    rootDir: "/workspace/orphan-without-destroy",
  });

  try {
    assert.doesNotThrow(() => engine.listSessions({ storedSessionsMode: "recent" }));
    await flushPromises();
    assert.equal(engine.sessionStore.getSession(orphan.session.id)?.session.id, orphan.session.id);
  } finally {
    await engine.shutdown();
  }
});

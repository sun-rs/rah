import assert from "node:assert/strict";
import test from "node:test";

import { BoundedTaskScheduler } from "./bounded-task-scheduler";
import { EventBus } from "./event-bus";
import { NativeTuiDiagnosticStore } from "./native-tui-diagnostics";
import type { NativeTuiMirrorProvider } from "./native-tui-mirror-provider";
import { NativeTuiMirrorRuntime } from "./native-tui-mirror-runtime";
import type { NativeTuiProviderMirror } from "./native-tui-provider-runtime-types";
import {
  clearNativeTuiSessionTimers,
  type NativeTuiSessionState,
} from "./native-tui-session-state";
import { PtyHub } from "./pty-hub";
import { SessionStore } from "./session-store";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function nativeSession(sessionId: string): NativeTuiSessionState {
  return {
    sessionId,
    provider: "codex",
    providerSessionId: `provider-${sessionId}`,
    cwd: "/tmp",
    startupTimestampMs: Date.now(),
    promptState: "prompt_clean",
    promptTracker: { draftText: "" },
  } as NativeTuiSessionState;
}

function createRuntime(
  sessions: Map<string, NativeTuiSessionState>,
  updateMirror: NativeTuiMirrorProvider["updateMirror"],
  scheduler: BoundedTaskScheduler,
  options: { mirrorIntervalMs?: number; mirrorMaxIntervalMs?: number } = {},
) {
  return new NativeTuiMirrorRuntime({
    eventBus: new EventBus(),
    ptyHub: new PtyHub(),
    sessionStore: new SessionStore(),
    nativeTuiMirrors: {
      providers: ["codex"],
      supports: () => true,
      updateMirror,
    } as unknown as NativeTuiMirrorProvider,
    diagnostics: new NativeTuiDiagnosticStore(),
    getSession: (sessionId) => sessions.get(sessionId),
    updatePromptState: () => undefined,
    confirmQueuedInputHandoff: () => undefined,
    scheduler,
    ...options,
  });
}

test("native TUI mirrors share a bounded cross-session concurrency budget", async () => {
  const sessions = new Map(
    ["one", "two", "three"].map((id) => [id, nativeSession(id)]),
  );
  const gates = [deferred(), deferred(), deferred()];
  let nextGate = 0;
  let active = 0;
  let peak = 0;
  const runtime = createRuntime(
    sessions,
    async (runtimeSession) => {
      const gate = gates[nextGate++]!;
      active += 1;
      peak = Math.max(peak, active);
      await gate.promise;
      active -= 1;
      return {
        status: "ok",
        mirror: {
          provider: "codex",
          providerSessionId: runtimeSession.providerSessionId!,
        } as NativeTuiProviderMirror,
        items: [],
      };
    },
    new BoundedTaskScheduler({ maxConcurrency: 2, maxQueued: 4 }),
  );

  runtime.mirrorSession("one");
  runtime.mirrorSession("two");
  runtime.mirrorSession("three");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(peak, 2);
  assert.equal(nextGate, 2);

  gates[0]!.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(nextGate, 3);
  gates[1]!.resolve();
  gates[2]!.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(peak, 2);
  runtime.shutdown();
});

test("repeated ticks for one session stay single-flight and coalesce to one rerun", async () => {
  const session = nativeSession("one");
  const sessions = new Map([["one", session]]);
  const firstGate = deferred();
  let calls = 0;
  let active = 0;
  let peak = 0;
  const runtime = createRuntime(
    sessions,
    async (runtimeSession) => {
      calls += 1;
      active += 1;
      peak = Math.max(peak, active);
      if (calls === 1) {
        await firstGate.promise;
      }
      active -= 1;
      return {
        status: "ok",
        mirror: {
          provider: "codex",
          providerSessionId: runtimeSession.providerSessionId!,
        } as NativeTuiProviderMirror,
        items: [],
      };
    },
    new BoundedTaskScheduler({ maxConcurrency: 2, maxQueued: 4 }),
  );

  runtime.mirrorSession("one");
  runtime.mirrorSession("one");
  runtime.mirrorSession("one");
  assert.equal(calls, 1);
  firstGate.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 2);
  assert.equal(peak, 1);
  runtime.shutdown();
});

test("idle mirrors back off while active or externally woken mirrors return to low latency", async () => {
  const session = nativeSession("one");
  const sessions = new Map([["one", session]]);
  let calls = 0;
  const runtime = createRuntime(
    sessions,
    async (runtimeSession) => {
      calls += 1;
      return {
        status: "ok",
        mirror: {
          provider: "codex",
          providerSessionId: runtimeSession.providerSessionId!,
        } as NativeTuiProviderMirror,
        items: [],
      };
    },
    new BoundedTaskScheduler({ maxConcurrency: 1, maxQueued: 1 }),
    { mirrorIntervalMs: 10, mirrorMaxIntervalMs: 80 },
  );

  runtime.startSessionMirror("one");
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  assert.equal(session.mirrorPollIntervalMs, 20);
  assert.notEqual(session.mirrorTimer, undefined);

  session.promptState = "agent_busy";
  runtime.mirrorSession("one");
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 2);
  assert.equal(session.mirrorPollIntervalMs, 10);

  clearNativeTuiSessionTimers(session);
  runtime.shutdown();
});

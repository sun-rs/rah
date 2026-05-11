import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { IndependentTerminalProcess } from "./independent-terminal";
import {
  cancelNativeTuiQueuedInputsForClient,
  clearNativeTuiSessionTimers,
  dequeueNativeTuiQueuedInput,
  enqueueNativeTuiQueuedInput,
  nativeTuiProviderRuntimeSession,
  type NativeTuiSessionState,
} from "./native-tui-session-state";

function nativeSession(overrides: Partial<NativeTuiSessionState> = {}): NativeTuiSessionState {
  return {
    sessionId: "session-a",
    process: {} as IndependentTerminalProcess,
    provider: "codex",
    cwd: "/tmp/project",
    startupTimestampMs: 1_000,
    promptState: "prompt_clean",
    promptTracker: { draftText: "" },
    queuedInputs: [],
    ...overrides,
  };
}

describe("native TUI session state", () => {
  test("projects runtime session fields without leaking coordinator-only state", () => {
    const projected = nativeTuiProviderRuntimeSession(
      nativeSession({
        providerSessionId: "provider-a",
        queuedInputs: [{ clientId: "client-a", text: "hello", queuedAt: "now" }],
      }),
    );

    assert.deepEqual(projected, {
      sessionId: "session-a",
      provider: "codex",
      cwd: "/tmp/project",
      startupTimestampMs: 1_000,
      providerSessionId: "provider-a",
    });
  });

  test("omits providerSessionId while a native session is still unbound", () => {
    assert.deepEqual(nativeTuiProviderRuntimeSession(nativeSession()), {
      sessionId: "session-a",
      provider: "codex",
      cwd: "/tmp/project",
      startupTimestampMs: 1_000,
    });
  });

  test("queues and dequeues chat input in FIFO order", () => {
    const native = nativeSession();

    assert.equal(
      enqueueNativeTuiQueuedInput(
        native,
        { clientId: "client-a", text: "first", queuedAt: "t1" },
        2,
      ),
      true,
    );
    assert.equal(
      enqueueNativeTuiQueuedInput(
        native,
        { clientId: "client-b", text: "second", queuedAt: "t2" },
        2,
      ),
      true,
    );
    assert.equal(
      enqueueNativeTuiQueuedInput(
        native,
        { clientId: "client-c", text: "third", queuedAt: "t3" },
        2,
      ),
      false,
    );

    assert.equal(dequeueNativeTuiQueuedInput(native)?.text, "first");
    assert.equal(dequeueNativeTuiQueuedInput(native)?.text, "second");
    assert.equal(dequeueNativeTuiQueuedInput(native), undefined);
  });

  test("cancels only queued input for the interrupted client", () => {
    const native = nativeSession({
      queuedInputs: [
        { clientId: "client-a", text: "drop-1", queuedAt: "t1" },
        { clientId: "client-b", text: "keep", queuedAt: "t2" },
        { clientId: "client-a", text: "drop-2", queuedAt: "t3" },
      ],
    });

    cancelNativeTuiQueuedInputsForClient(native, "client-a");

    assert.deepEqual(native.queuedInputs, [
      { clientId: "client-b", text: "keep", queuedAt: "t2" },
    ]);
  });

  test("clears binding, mirror, and stop timers", () => {
    const bindingTimer = setInterval(() => undefined, 60_000);
    const mirrorTimer = setInterval(() => undefined, 60_000);
    const stopTimer = setTimeout(() => undefined, 60_000);
    const promptClearTimer = setTimeout(() => undefined, 60_000);
    bindingTimer.unref();
    mirrorTimer.unref();
    stopTimer.unref();
    promptClearTimer.unref();
    const native = nativeSession({
      bindingTimer,
      mirrorTimer,
      stopTimer,
      promptClearTimer,
      promptClearScheduledAtMs: 1_000,
      stopPending: true,
      stopTurnId: "turn-1",
    });

    clearNativeTuiSessionTimers(native);

    assert.equal(native.bindingTimer, undefined);
    assert.equal(native.mirrorTimer, undefined);
    assert.equal(native.stopTimer, undefined);
    assert.equal(native.promptClearTimer, undefined);
    assert.equal(native.promptClearScheduledAtMs, undefined);
    assert.equal(native.stopPending, undefined);
    assert.equal(native.stopTurnId, undefined);
  });
});

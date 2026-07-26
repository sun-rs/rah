import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { IndependentTerminalProcess } from "./independent-terminal";
import {
  cancelNativeTuiQueuedInputsForClient,
  clearNativeTuiSessionTimers,
  confirmNativeTuiQueuedInput,
  deleteNativeTuiQueuedInput,
  enqueueNativeTuiQueuedInput,
  markNextNativeTuiQueuedInputSubmitting,
  nativeTuiProviderRuntimeSession,
  updateNativeTuiQueuedInput,
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
        queuedInputs: [
          {
            clientId: "client-a",
            clientMessageId: "message-a",
            text: "hello",
            queuedAt: "now",
            state: "queued",
          },
        ],
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

  test("keeps submitted chat input visible until canonical handoff confirms it", () => {
    const native = nativeSession();

    assert.equal(
      enqueueNativeTuiQueuedInput(
        native,
        { clientId: "client-a", clientMessageId: "message-1", text: "first", queuedAt: "t1" },
        2,
      ),
      true,
    );
    assert.equal(
      enqueueNativeTuiQueuedInput(
        native,
        { clientId: "client-b", clientMessageId: "message-2", text: "second", queuedAt: "t2" },
        2,
      ),
      true,
    );
    assert.equal(
      enqueueNativeTuiQueuedInput(
        native,
        { clientId: "client-c", clientMessageId: "message-3", text: "third", queuedAt: "t3" },
        2,
      ),
      false,
    );

    const first = markNextNativeTuiQueuedInputSubmitting(native);
    assert.equal(first?.text, "first");
    assert.equal(first?.state, "submitting");
    assert.equal(native.queuedInputs.length, 2);
    assert.equal(markNextNativeTuiQueuedInputSubmitting(native), undefined);

    assert.equal(confirmNativeTuiQueuedInput(native, "message-1"), true);
    assert.equal(native.queuedInputs.length, 1);

    const second = markNextNativeTuiQueuedInputSubmitting(native);
    assert.equal(second?.text, "second");
    assert.equal(second?.state, "submitting");
    assert.equal(confirmNativeTuiQueuedInput(native, "message-2"), true);
    assert.equal(confirmNativeTuiQueuedInput(native, "message-2"), false);
    assert.deepEqual(native.queuedInputs, []);
  });

  test("cancels only queued input for the interrupted client", () => {
    const native = nativeSession({
      queuedInputs: [
        {
          clientId: "client-a",
          clientMessageId: "message-1",
          text: "drop-1",
          queuedAt: "t1",
          state: "queued",
        },
        {
          clientId: "client-b",
          clientMessageId: "message-2",
          text: "keep",
          queuedAt: "t2",
          state: "queued",
        },
        {
          clientId: "client-a",
          clientMessageId: "message-3",
          text: "drop-2",
          queuedAt: "t3",
          state: "queued",
        },
      ],
    });

    cancelNativeTuiQueuedInputsForClient(native, "client-a");

    assert.deepEqual(native.queuedInputs, [
      {
        clientId: "client-b",
        clientMessageId: "message-2",
        text: "keep",
        queuedAt: "t2",
        state: "queued",
      },
    ]);
  });

  test("edits and deletes queued input by stable client message id", () => {
    const native = nativeSession({
      queuedInputs: [
        {
          clientId: "client-a",
          clientMessageId: "message-1",
          text: "first",
          queuedAt: "t1",
          state: "queued",
        },
        {
          clientId: "client-a",
          clientMessageId: "message-2",
          text: "second",
          queuedAt: "t2",
          state: "queued",
        },
      ],
    });

    assert.equal(updateNativeTuiQueuedInput(native, "message-2", "edited"), true);
    assert.equal(updateNativeTuiQueuedInput(native, "missing", "ignored"), false);
    markNextNativeTuiQueuedInputSubmitting(native);
    assert.equal(updateNativeTuiQueuedInput(native, "message-1", "too late"), false);
    assert.equal(deleteNativeTuiQueuedInput(native, "message-1"), false);
    assert.equal(deleteNativeTuiQueuedInput(native, "message-2"), true);
    assert.equal(deleteNativeTuiQueuedInput(native, "missing"), false);
    assert.equal(confirmNativeTuiQueuedInput(native, "message-1"), true);
    assert.deepEqual(native.queuedInputs, []);
  });

  test("clears binding, mirror, and stop timers", () => {
    const bindingTimer = setInterval(() => undefined, 60_000);
    const mirrorTimer = setTimeout(() => undefined, 60_000);
    const stopTimer = setTimeout(() => undefined, 60_000);
    bindingTimer.unref();
    mirrorTimer.unref();
    stopTimer.unref();
    const native = nativeSession({
      bindingTimer,
      mirrorTimer,
      mirrorPollingEnabled: true,
      mirrorPollIntervalMs: 400,
      stopTimer,
      stopPending: true,
    });

    clearNativeTuiSessionTimers(native);

    assert.equal(native.bindingTimer, undefined);
    assert.equal(native.mirrorTimer, undefined);
    assert.equal(native.mirrorPollingEnabled, false);
    assert.equal(native.mirrorPollIntervalMs, undefined);
    assert.equal(native.stopTimer, undefined);
    assert.equal(native.stopPending, undefined);
  });
});

import assert from "node:assert/strict";
import test from "node:test";
import {
  deleteRuntimeQueuedInput,
  markRuntimeQueuedInputQueued,
  markRuntimeQueuedInputSubmitting,
  projectSessionInputQueue,
  restoreRuntimeQueuedInput,
  runtimeQueuedInput,
  updateRuntimeQueuedInput,
  withdrawRuntimeQueuedInput,
} from "./session-input-queue";

test("queued input keeps stable identity while editing and reindexes after withdrawal", () => {
  const first = runtimeQueuedInput({
    clientId: "client-1",
    clientMessageId: "message-1",
    clientTurnId: "turn-1",
    text: "first",
  });
  const second = runtimeQueuedInput({
    clientId: "client-1",
    clientMessageId: "message-2",
    clientTurnId: "turn-2",
    text: "second",
  });
  const queue = [first, second];

  assert.equal(updateRuntimeQueuedInput(queue, "message-2", "edited second"), true);
  assert.equal(queue[1]?.clientMessageId, "message-2");
  assert.equal(queue[1]?.clientTurnId, "turn-2");
  assert.equal(queue[1]?.text, "edited second");

  assert.equal(deleteRuntimeQueuedInput(queue, "message-1"), true);
  assert.deepEqual(projectSessionInputQueue(queue), [
    {
      clientMessageId: "message-2",
      clientTurnId: "turn-2",
      text: "edited second",
      queuedAt: second.queuedAt,
      position: 1,
      state: "queued",
    },
  ]);
});

test("restoring an uncertain queued input preserves FIFO order and is idempotent", () => {
  const first = runtimeQueuedInput({
    clientId: "client-1",
    clientMessageId: "message-1",
    text: "first",
  });
  const second = runtimeQueuedInput({
    clientId: "client-1",
    clientMessageId: "message-2",
    text: "second",
  });
  const queue = [second];

  assert.equal(restoreRuntimeQueuedInput(queue, first), true);
  assert.deepEqual(
    queue.map((item) => item.clientMessageId),
    ["message-1", "message-2"],
  );
  assert.equal(restoreRuntimeQueuedInput(queue, first), false);
  assert.deepEqual(
    queue.map((item) => item.clientMessageId),
    ["message-1", "message-2"],
  );
});

test("queued input edits and withdrawals reject stale ids without mutating the queue", () => {
  const item = runtimeQueuedInput({
    clientId: "client-1",
    clientMessageId: "message-1",
    text: "first",
  });
  const queue = [item];

  assert.equal(updateRuntimeQueuedInput(queue, "missing", "changed"), false);
  assert.equal(deleteRuntimeQueuedInput(queue, "missing"), false);
  assert.equal(queue[0]?.text, "first");
  assert.equal(queue.length, 1);
});

test("submitting input remains projected until canonical timeline handoff", () => {
  const item = runtimeQueuedInput({
    clientId: "client-1",
    clientMessageId: "message-1",
    text: "first",
  });
  const queue = [item];

  assert.equal(markRuntimeQueuedInputSubmitting(queue, "message-1"), true);
  assert.equal(projectSessionInputQueue(queue)[0]?.state, "submitting");
  assert.equal(updateRuntimeQueuedInput(queue, "message-1", "changed"), false);
  assert.equal(withdrawRuntimeQueuedInput(queue, "message-1"), false);
  assert.equal(queue.length, 1);

  assert.equal(markRuntimeQueuedInputQueued(queue, "message-1"), true);
  assert.equal(withdrawRuntimeQueuedInput(queue, "message-1"), true);
  assert.equal(queue.length, 0);
});

test("restoring an existing uncertain submission resets it to queued", () => {
  const item = runtimeQueuedInput({
    clientId: "client-1",
    clientMessageId: "message-1",
    text: "first",
  });
  const queue = [item];

  assert.equal(markRuntimeQueuedInputSubmitting(queue, "message-1"), true);
  assert.equal(restoreRuntimeQueuedInput(queue, item), false);
  assert.equal(queue[0]?.state, "queued");
});

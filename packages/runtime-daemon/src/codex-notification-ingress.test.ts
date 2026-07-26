import assert from "node:assert/strict";
import test from "node:test";
import {
  codexNotificationCoalescing,
  codexNotificationCoalesceKey,
  isCodexOutputDetailIncomplete,
  materializeCodexCoalescedNotification,
  markCodexCompletionOutputIncomplete,
  prepareCodexNotificationForIngress,
} from "./codex-notification-ingress";

test("bounds aggregate command output while preserving completion semantics", () => {
  const prepared = prepareCodexNotificationForIngress(
    {
      method: "item/completed",
      params: {
        turnId: "turn-1",
        item: {
          type: "commandExecution",
          id: "command-1",
          status: "completed",
          aggregatedOutput: `prefix-${"界".repeat(300_000)}`,
          exitCode: 0,
        },
      },
    },
    4_096,
  );

  assert.equal(prepared.completionOutputKey, "command-1");
  assert.equal(prepared.truncatedProcessOutput, true);
  const params = prepared.notification.params as {
    item: { aggregatedOutput: string; exitCode: number };
  };
  assert.ok(Buffer.byteLength(params.item.aggregatedOutput, "utf8") <= 4_096);
  assert.equal(params.item.exitCode, 0);
  assert.doesNotMatch(params.item.aggregatedOutput, /\uFFFD/);
});

test("marks a completion whose streamed detail was dropped", () => {
  const completion = markCodexCompletionOutputIncomplete({
    method: "item/completed",
    params: {
      item: {
        type: "commandExecution",
        id: "command-1",
        aggregatedOutput: "tail",
      },
    },
  });
  const item = (completion.params as { item: Record<string, unknown> }).item;
  assert.equal(isCodexOutputDetailIncomplete(item), true);
});

test("bounds base64 process deltas on quartet boundaries", () => {
  const encoded = Buffer.from("x".repeat(100_000), "utf8").toString("base64");
  const prepared = prepareCodexNotificationForIngress(
    {
      method: "command/exec/outputDelta",
      params: {
        processId: "process-1",
        deltaBase64: encoded,
      },
    },
    1_024,
  );
  const params = prepared.notification.params as { deltaBase64: string };
  assert.equal(prepared.processOutputKey, "process-1");
  assert.equal(prepared.truncatedProcessOutput, true);
  assert.equal(params.deltaBase64.length % 4, 0);
  assert.ok(Buffer.from(params.deltaBase64, "base64").byteLength <= 1_024);
});

test("coalesces cumulative turn diff snapshots by turn", () => {
  assert.equal(
    codexNotificationCoalesceKey({
      method: "turn/diff/updated",
      params: { turnId: "turn-1", diff: "first" },
    }),
    "turn-diff:turn-1",
  );
  assert.equal(
    codexNotificationCoalesceKey({
      method: "item/completed",
      params: { turnId: "turn-1" },
    }),
    undefined,
  );
});

test("classifies incremental text and process notifications by item", () => {
  assert.deepEqual(
    codexNotificationCoalescing({
      method: "item/agentMessage/delta",
      params: {
        turnId: "turn-1",
        itemId: "message-1",
        delta: "hello",
      },
    }),
    {
      key: "delta:item/agentMessage/delta:turn-1:message-1:",
      mode: "utf8-delta",
      chunk: "hello",
    },
  );
  assert.deepEqual(
    codexNotificationCoalescing({
      method: "command/exec/outputDelta",
      params: {
        turnId: "turn-1",
        processId: "process-1",
        stream: "stdout",
        deltaBase64: Buffer.from("hello").toString("base64"),
      },
    }),
    {
      key: "delta:command/exec/outputDelta:turn-1:process-1:stdout",
      mode: "base64-delta",
      chunk: Buffer.from("hello").toString("base64"),
    },
  );
});

test("materializes coalesced incremental fields once at the drain boundary", () => {
  const text = materializeCodexCoalescedNotification(
    {
      method: "item/agentMessage/delta",
      params: {
        turnId: "turn-1",
        itemId: "message-1",
        delta: "latest-template",
      },
    },
    "utf8-delta",
    ["hello", " ", "world"],
  );
  assert.equal(
    (text.params as { delta: string }).delta,
    "hello world",
  );

  const base64 = materializeCodexCoalescedNotification(
    {
      method: "command/exec/outputDelta",
      params: {
        processId: "process-1",
        deltaBase64: "",
      },
    },
    "base64-delta",
    [
      Buffer.from("hello ").toString("base64"),
      Buffer.from("world").toString("base64"),
    ],
  );
  assert.equal(
    Buffer.from(
      (base64.params as { deltaBase64: string }).deltaBase64,
      "base64",
    ).toString("utf8"),
    "hello world",
  );
});

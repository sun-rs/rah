import assert from "node:assert/strict";
import { test } from "node:test";
import type { CodexAppServerRpcClient } from "./codex-live-rpc";
import { requestCodexThreadForkWithoutTranscript } from "./codex-app-server-fork";

function clientWithRequest(
  request: CodexAppServerRpcClient["request"],
): CodexAppServerRpcClient {
  return {
    setNotificationHandler() {},
    setRequestHandler() {},
    setCloseHandler() {},
    request,
    notify() {},
    async dispose() {},
  };
}

test("Codex lightweight fork requires the official excludeTurns path", async () => {
  const requests: unknown[] = [];
  const client = clientWithRequest(async (_method, params) => {
    requests.push(params);
    return { thread: { id: "thread-fork-1" } };
  });

  const result = await requestCodexThreadForkWithoutTranscript({
    client,
    params: {
      threadId: "thread-parent",
      lastTurnId: "turn-7",
      ephemeral: true,
    },
    timeoutMs: 1_000,
  });
  assert.deepEqual(result, { thread: { id: "thread-fork-1" } });
  assert.deepEqual(requests, [
    {
      threadId: "thread-parent",
      lastTurnId: "turn-7",
      ephemeral: true,
      excludeTurns: true,
    },
  ]);
});

test("Codex lightweight fork does not retry an unsupported protocol shape", async () => {
  let requests = 0;
  const client = clientWithRequest(async () => {
    requests += 1;
    throw new Error("unknown field `excludeTurns`");
  });

  await assert.rejects(
    requestCodexThreadForkWithoutTranscript({
      client,
      params: { threadId: "thread-parent" },
      timeoutMs: 1_000,
    }),
    /excludeTurns/,
  );
  assert.equal(requests, 1);
});

test("Codex lightweight fork does not mask real fork errors", async () => {
  let requests = 0;
  const client = clientWithRequest(async () => {
    requests += 1;
    throw new Error("thread cannot be forked");
  });

  await assert.rejects(
    requestCodexThreadForkWithoutTranscript({
      client,
      params: { threadId: "thread-parent" },
      timeoutMs: 1_000,
    }),
    /cannot be forked/,
  );
  assert.equal(requests, 1);
});

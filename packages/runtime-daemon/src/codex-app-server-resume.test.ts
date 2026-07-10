import assert from "node:assert/strict";
import { test } from "node:test";
import type { CodexAppServerRpcClient } from "./codex-live-rpc";
import { requestCodexThreadResumeWithoutTranscript } from "./codex-app-server-resume";

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

test("Codex lightweight resume retries old servers without excludeTurns", async () => {
  const requests: unknown[] = [];
  const client = clientWithRequest(async (_method, params) => {
    requests.push(params);
    if ((params as Record<string, unknown>).excludeTurns === true) {
      throw new Error("unknown field `excludeTurns`");
    }
    return { thread: { id: "thread-1" } };
  });

  const result = await requestCodexThreadResumeWithoutTranscript({
    client,
    params: { threadId: "thread-1", sandbox: "workspace-write" },
    timeoutMs: 1_000,
  });
  assert.deepEqual(result, { thread: { id: "thread-1" } });
  assert.deepEqual(requests, [
    { threadId: "thread-1", sandbox: "workspace-write", excludeTurns: true },
    { threadId: "thread-1", sandbox: "workspace-write" },
  ]);
});

test("Codex lightweight resume does not mask real resume errors", async () => {
  let requests = 0;
  const client = clientWithRequest(async () => {
    requests += 1;
    throw new Error("thread is already running");
  });
  await assert.rejects(
    requestCodexThreadResumeWithoutTranscript({
      client,
      params: { threadId: "thread-1" },
      timeoutMs: 1_000,
    }),
    /already running/,
  );
  assert.equal(requests, 1);
});

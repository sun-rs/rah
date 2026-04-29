import { EventEmitter } from "node:events";
import assert from "node:assert/strict";
import { test } from "node:test";
import { PassThrough, Writable } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { CodexJsonRpcClient } from "./codex-live-rpc";

test("CodexJsonRpcClient records pending request before writing to stdin", async () => {
  const stdout = new PassThrough();
  const stdin = new Writable({
    write(_chunk, _encoding, callback) {
      stdout.write(`${JSON.stringify({ id: 1, result: "ok" })}\n`);
      callback();
    },
  });
  const child = new EventEmitter() as ChildProcessWithoutNullStreams;
  Object.assign(child, {
    stdin,
    stdout,
    stderr: new PassThrough(),
    exitCode: null,
    signalCode: null,
    kill() {
      child.emit("exit", 0, null);
      return true;
    },
  });

  const client = new CodexJsonRpcClient(child);
  assert.equal(await client.request("ping", {}, 100), "ok");
  await client.dispose();
});

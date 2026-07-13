import { EventEmitter, once } from "node:events";
import assert from "node:assert/strict";
import { test } from "node:test";
import { PassThrough, Writable } from "node:stream";
import type { ChildProcess, ChildProcessWithoutNullStreams } from "node:child_process";
import { WebSocket, WebSocketServer } from "ws";
import { CodexJsonRpcClient, CodexWebSocketRpcClient } from "./codex-live-rpc";

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

test("CodexWebSocketRpcClient can still terminate its child after transport loss", async () => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const endpoint = `ws://127.0.0.1:${address.port}`;
  const accepted = new Promise<WebSocket>((resolve) => {
    server.once("connection", resolve);
  });
  const socket = new WebSocket(endpoint);
  await once(socket, "open");
  const serverSocket = await accepted;

  const child = new EventEmitter() as unknown as ChildProcess;
  const signals: NodeJS.Signals[] = [];
  Object.assign(child, {
    exitCode: null,
    signalCode: null,
    kill(signal: NodeJS.Signals) {
      signals.push(signal);
      child.emit("exit", 0, signal);
      return true;
    },
  });
  const client = new CodexWebSocketRpcClient(socket, child, endpoint);
  const closed = new Promise<void>((resolve) => {
    client.setCloseHandler(() => resolve());
  });

  serverSocket.close();
  await closed;
  assert.deepEqual(signals, []);
  await client.dispose();
  assert.deepEqual(signals, ["SIGTERM"]);

  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

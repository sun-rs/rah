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

test("CodexJsonRpcClient drains a final response before transport exit", async () => {
  const stdout = new PassThrough();
  const stdin = new Writable({
    write(_chunk, _encoding, callback) {
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
      return true;
    },
  });

  const client = new CodexJsonRpcClient(child);
  const response = client.request("final", {}, 500);
  stdout.end(`${JSON.stringify({ id: 1, result: "delivered" })}\n`);
  Object.assign(child, { exitCode: 0 });
  child.emit("exit", 0, null);
  child.emit("close", 0, null);

  assert.equal(await response, "delivered");
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

test("CodexWebSocketRpcClient drains a final response before socket close", async () => {
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
  Object.assign(child, {
    exitCode: null,
    signalCode: null,
    kill() {
      return true;
    },
  });
  const client = new CodexWebSocketRpcClient(socket, child, endpoint);
  serverSocket.once("message", (data) => {
    const request = JSON.parse(data.toString()) as { id: number };
    serverSocket.send(JSON.stringify({ id: request.id, result: "delivered" }));
    serverSocket.close();
    Object.assign(child, { exitCode: 0 });
  });

  assert.equal(await client.request("final", {}, 500), "delivered");
  await client.dispose();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

test("CodexJsonRpcClient rejects an oversized line before JSON parsing", async () => {
  const stdout = new PassThrough();
  const child = new EventEmitter() as ChildProcessWithoutNullStreams;
  const signals: NodeJS.Signals[] = [];
  Object.assign(child, {
    stdin: new PassThrough(),
    stdout,
    stderr: new PassThrough(),
    exitCode: null,
    signalCode: null,
    kill(signal: NodeJS.Signals) {
      signals.push(signal);
      Object.assign(child, { exitCode: 0 });
      child.emit("exit", 0, signal);
      return true;
    },
  });
  const client = new CodexJsonRpcClient(child, 64);
  const closed = new Promise<Error>((resolve) => {
    client.setCloseHandler(resolve);
  });

  stdout.write(Buffer.alloc(65, 0x78));
  assert.match((await closed).message, /exceeded 64 bytes/);
  assert.deepEqual(signals, ["SIGTERM"]);
  await client.dispose();
});

test("CodexWebSocketRpcClient closes an oversized message before JSON parsing", async () => {
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
      Object.assign(child, { exitCode: 0 });
      child.emit("exit", 0, signal);
      return true;
    },
  });
  const client = new CodexWebSocketRpcClient(socket, child, endpoint, 64);
  const closed = new Promise<Error>((resolve) => {
    client.setCloseHandler(resolve);
  });

  serverSocket.send(Buffer.alloc(65, 0x78));
  assert.match((await closed).message, /exceeded 64 bytes/);
  assert.deepEqual(signals, []);
  await client.dispose();
  assert.deepEqual(signals, ["SIGTERM"]);

  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

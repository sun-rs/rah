import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";
import { DeviceAuthManager } from "./device-auth";
import { startRahDaemon, type RahDaemon } from "./http-server";
import { RuntimeEngine } from "./runtime-engine";

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Could not allocate a test port."));
        return;
      }
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

async function jsonRequest(args: {
  port: number;
  path: string;
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
}): Promise<{ status: number; body: any; cookie?: string }> {
  const response = await fetch(`http://127.0.0.1:${args.port}${args.path}`, {
    method: args.method ?? "GET",
    headers: {
      ...(args.body !== undefined ? { "content-type": "application/json" } : {}),
      ...(args.method && args.method !== "GET" ? { "x-rah-client": "web" } : {}),
      ...(args.headers ?? {}),
    },
    ...(args.body !== undefined ? { body: JSON.stringify(args.body) } : {}),
  });
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
  return {
    status: response.status,
    body: await response.json(),
    ...(cookie ? { cookie } : {}),
  };
}

async function websocketResult(url: string, cookie?: string): Promise<"open" | "closed"> {
  const socket = new WebSocket(url, cookie ? { headers: { cookie } } : undefined);
  return await new Promise((resolve) => {
    const timer = setTimeout(() => {
      socket.close();
      resolve("closed");
    }, 1_000);
    socket.once("open", () => {
      clearTimeout(timer);
      socket.close();
      resolve("open");
    });
    socket.once("error", () => {
      clearTimeout(timer);
      resolve("closed");
    });
    socket.once("close", () => {
      clearTimeout(timer);
      resolve("closed");
    });
  });
}

async function openWebsocket(url: string, cookie: string): Promise<WebSocket> {
  const socket = new WebSocket(url, { headers: { cookie } });
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  return socket;
}

function waitForWebsocketClose(socket: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => {
    socket.once("close", (code, reason) => {
      resolve({ code, reason: reason.toString("utf8") });
    });
  });
}

function authRequest(args: {
  remoteAddress: string;
  host: string;
  headers?: Record<string, string>;
}): IncomingMessage {
  return {
    headers: {
      host: args.host,
      ...(args.headers ?? {}),
    },
    socket: { remoteAddress: args.remoteAddress },
  } as unknown as IncomingMessage;
}

describe("device authentication", () => {
  let tempHome: string;
  let daemon: RahDaemon | null;
  let port: number;
  let auth: DeviceAuthManager;

  beforeEach(async () => {
    tempHome = mkdtempSync(path.join(os.tmpdir(), "rah-device-auth-"));
    port = await freePort();
    auth = new DeviceAuthManager({ rootDir: path.join(tempHome, "auth") });
    daemon = await startRahDaemon({
      host: "127.0.0.1",
      port,
      engine: new RuntimeEngine(),
      auth,
    });
  });

  afterEach(async () => {
    await daemon?.close();
    daemon = null;
    rmSync(tempHome, { recursive: true, force: true });
  });

  test("allows direct loopback while retaining paired device identity", async () => {
    const sessionsWithoutCookie = await jsonRequest({ port, path: "/api/sessions" });
    assert.equal(sessionsWithoutCookie.status, 200);

    const initialStatus = await jsonRequest({ port, path: "/api/auth/status" });
    assert.deepEqual(initialStatus.body, {
      authenticated: true,
      hasTrustedDevices: false,
    });

    const managementToken = readFileSync(auth.managementTokenPath, "utf8").trim();
    const pairing = await jsonRequest({
      port,
      path: "/api/auth/pairing-code",
      method: "POST",
      headers: { authorization: `Bearer ${managementToken}` },
      body: {},
    });
    assert.equal(pairing.status, 200);
    assert.match(pairing.body.id, /^[0-9a-f-]{36}$/i);
    assert.match(pairing.body.code, /^\d{8}$/);

    const activePairing = await jsonRequest({
      port,
      path: `/api/auth/pairing-code/${pairing.body.id}/status`,
      headers: { authorization: `Bearer ${managementToken}` },
    });
    assert.deepEqual(activePairing.body, { active: true });

    const paired = await jsonRequest({
      port,
      path: "/api/auth/pair",
      method: "POST",
      body: { code: pairing.body.code, name: "Test browser" },
    });
    assert.equal(paired.status, 200);
    assert.ok(paired.cookie?.startsWith("rah_device="));
    assert.equal(paired.body.device.name, "Test browser");

    const consumedPairing = await jsonRequest({
      port,
      path: `/api/auth/pairing-code/${pairing.body.id}/status`,
      headers: { authorization: `Bearer ${managementToken}` },
    });
    assert.deepEqual(consumedPairing.body, { active: false });

    const trustedStatus = await jsonRequest({
      port,
      path: "/api/auth/status",
      headers: { cookie: paired.cookie! },
    });
    assert.equal(trustedStatus.body.authenticated, true);
    assert.equal(trustedStatus.body.hasTrustedDevices, true);
    assert.equal(trustedStatus.body.device.id, paired.body.device.id);

    const sessions = await jsonRequest({
      port,
      path: "/api/sessions?storedSessions=recent",
      headers: { cookie: paired.cookie! },
    });
    assert.equal(sessions.status, 200);

    assert.equal(await websocketResult(`ws://127.0.0.1:${port}/api/events`), "open");
    assert.equal(await websocketResult(`ws://127.0.0.1:${port}/api/pty/auth-test`), "open");
    assert.equal(
      await websocketResult(`ws://127.0.0.1:${port}/api/events`, paired.cookie),
      "open",
    );

    const rawRegistry = readFileSync(auth.registryPath, "utf8");
    assert.doesNotMatch(rawRegistry, new RegExp(paired.cookie!.split("=")[1]!));
    assert.match(rawRegistry, /"tokenHash"/);
  });

  test("limits the loopback bypass to direct loopback requests", () => {
    assert.deepEqual(
      auth.authenticate(authRequest({ remoteAddress: "127.0.0.1", host: "127.0.0.1:43111" })),
      { kind: "local" },
    );
    assert.deepEqual(
      auth.authenticate(authRequest({ remoteAddress: "::1", host: "[::1]:43111" })),
      { kind: "local" },
    );
    assert.deepEqual(
      auth.authenticate(authRequest({ remoteAddress: "::ffff:127.0.0.1", host: "localhost:43111" })),
      { kind: "local" },
    );
    assert.deepEqual(
      auth.authenticate(authRequest({
        remoteAddress: "127.0.0.1",
        host: "127.0.0.1:43111",
        headers: { cookie: "rah_device=stale-token" },
      })),
      { kind: "local" },
    );

    assert.equal(
      auth.authenticate(authRequest({
        remoteAddress: "127.0.0.1",
        host: "mac-studio.example.ts.net",
      })),
      null,
    );
    assert.equal(
      auth.authenticate(authRequest({
        remoteAddress: "127.0.0.1",
        host: "127.0.0.1:43111",
        headers: { "x-forwarded-for": "203.0.113.8" },
      })),
      null,
    );
    assert.equal(
      auth.authenticate(authRequest({
        remoteAddress: "192.168.1.42",
        host: "127.0.0.1:43111",
      })),
      null,
    );
  });

  test("revoking the current device immediately invalidates its cookie", async () => {
    const managementToken = readFileSync(auth.managementTokenPath, "utf8").trim();
    const pairing = await jsonRequest({
      port,
      path: "/api/auth/pairing-code",
      method: "POST",
      headers: { authorization: `Bearer ${managementToken}` },
      body: {},
    });
    const paired = await jsonRequest({
      port,
      path: "/api/auth/pair",
      method: "POST",
      body: { code: pairing.body.code, name: "Disposable browser" },
    });
    const deviceId = paired.body.device.id as string;
    const eventsSocket = await openWebsocket(
      `ws://127.0.0.1:${port}/api/events`,
      paired.cookie!,
    );
    const ptySocket = await openWebsocket(
      `ws://127.0.0.1:${port}/api/pty/auth-test`,
      paired.cookie!,
    );
    const eventsSocketClosed = waitForWebsocketClose(eventsSocket);
    const ptySocketClosed = waitForWebsocketClose(ptySocket);

    const revoked = await jsonRequest({
      port,
      path: `/api/auth/devices/${encodeURIComponent(deviceId)}`,
      method: "DELETE",
      headers: { cookie: paired.cookie! },
    });
    assert.equal(revoked.status, 200);
    assert.equal(revoked.body.revokedCurrentDevice, true);
    assert.deepEqual(await eventsSocketClosed, {
      code: 4001,
      reason: "device trust revoked",
    });
    assert.deepEqual(await ptySocketClosed, {
      code: 4001,
      reason: "device trust revoked",
    });

    const localFallback = await jsonRequest({
      port,
      path: "/api/sessions",
      headers: { cookie: paired.cookie! },
    });
    assert.equal(localFallback.status, 200);
    assert.equal(
      auth.authenticate(authRequest({
        remoteAddress: "192.168.1.42",
        host: "192.168.1.86:43111",
        headers: { cookie: paired.cookie! },
      })),
      null,
    );
  });

  test("rate limits invalid pairing attempts until a new code is generated", async () => {
    const managementToken = readFileSync(auth.managementTokenPath, "utf8").trim();
    const firstPairing = await jsonRequest({
      port,
      path: "/api/auth/pairing-code",
      method: "POST",
      headers: { authorization: `Bearer ${managementToken}` },
      body: {},
    });
    assert.equal(firstPairing.status, 200);

    for (let attempt = 0; attempt < 8; attempt += 1) {
      const rejected = await jsonRequest({
        port,
        path: "/api/auth/pair",
        method: "POST",
        body: { code: "99999999", name: "Untrusted browser" },
      });
      assert.equal(rejected.status, 400);
    }

    const rateLimited = await jsonRequest({
      port,
      path: "/api/auth/pair",
      method: "POST",
      body: { code: firstPairing.body.code, name: "Blocked browser" },
    });
    assert.equal(rateLimited.status, 429);

    const replacementPairing = await jsonRequest({
      port,
      path: "/api/auth/pairing-code",
      method: "POST",
      headers: { authorization: `Bearer ${managementToken}` },
      body: {},
    });
    const paired = await jsonRequest({
      port,
      path: "/api/auth/pair",
      method: "POST",
      body: { code: replacementPairing.body.code, name: "Recovered browser" },
    });
    assert.equal(paired.status, 200);
  });
});

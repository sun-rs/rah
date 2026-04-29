import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { RuntimeEngine } from "./runtime-engine";
import { startRahDaemon, type RahDaemon } from "./http-server";
import {
  MAX_JSON_BODY_BYTES,
  readJsonBody,
  requestErrorStatus,
} from "./http-server-response";
import { isLoopbackRemoteAddress } from "./http-server-websocket";

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Could not allocate free port."));
        return;
      }
      const port = address.port;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}

async function requestJson(args: {
  port: number;
  path: string;
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
}): Promise<{ status: number; json: unknown }> {
  const response = await fetch(`http://127.0.0.1:${args.port}${args.path}`, {
    method: args.method ?? "GET",
    headers: {
      ...(args.body !== undefined ? { "content-type": "application/json" } : {}),
      ...(args.headers ?? {}),
    },
    ...(args.body !== undefined ? { body: JSON.stringify(args.body) } : {}),
  });
  return {
    status: response.status,
    json: await response.json(),
  };
}

describe("startRahDaemon", () => {
  let tempHome: string;
  let previousRahHome: string | undefined;
  let daemon: RahDaemon | null = null;
  let port: number;

  beforeEach(async () => {
    previousRahHome = process.env.RAH_HOME;
    tempHome = mkdtempSync(path.join(os.tmpdir(), "rah-http-server-"));
    process.env.RAH_HOME = tempHome;
    port = await freePort();
    daemon = await startRahDaemon({
      port,
      engine: new RuntimeEngine(),
    });
  });

  afterEach(async () => {
    await daemon?.close();
    daemon = null;
    if (previousRahHome === undefined) {
      delete process.env.RAH_HOME;
    } else {
      process.env.RAH_HOME = previousRahHome;
    }
    rmSync(tempHome, { recursive: true, force: true });
  });

  test("rejects cross-origin API requests", async () => {
    const response = await requestJson({
      port,
      path: "/api/sessions",
      headers: { Origin: "http://evil.example" },
    });
    assert.equal(response.status, 403);
    assert.deepEqual(response.json, { error: "Cross-origin requests are not allowed." });
  });

  test("requires x-rah-client for same-origin POST requests", async () => {
    const response = await requestJson({
      port,
      path: "/api/workspaces/select",
      method: "POST",
      headers: { Origin: `http://127.0.0.1:${port}` },
      body: { dir: tempHome },
    });
    assert.equal(response.status, 403);
    assert.deepEqual(response.json, { error: "Missing required RAH client header." });
  });

  test("accepts same-origin POST requests with x-rah-client", async () => {
    const response = await requestJson({
      port,
      path: "/api/workspaces/select",
      method: "POST",
      headers: {
        Origin: `http://127.0.0.1:${port}`,
        "x-rah-client": "web",
      },
      body: { dir: tempHome },
    });
    assert.equal(response.status, 200);
    assert.equal(typeof response.json, "object");
  });

  test("rejects oversized JSON request bodies before buffering them", async () => {
    const request = Readable.from([]) as unknown as IncomingMessage;
    Object.defineProperty(request, "headers", {
      value: { "content-length": String(MAX_JSON_BODY_BYTES + 1) },
    });

    await assert.rejects(readJsonBody(request), /Request body too large/);
  });

  test("maps known request errors to client-facing HTTP statuses", () => {
    assert.equal(
      requestErrorStatus(
        new Error("Requested workspace scope is outside the session workspace boundary."),
      ),
      403,
    );
    assert.equal(
      requestErrorStatus(new Error("Cannot remove a workspace with active live sessions.")),
      400,
    );
  });

  test("limits wrapper control upgrades to loopback clients", () => {
    assert.equal(isLoopbackRemoteAddress("127.0.0.1"), true);
    assert.equal(isLoopbackRemoteAddress("::1"), true);
    assert.equal(isLoopbackRemoteAddress("::ffff:127.0.0.1"), true);
    assert.equal(isLoopbackRemoteAddress("192.168.1.20"), false);
    assert.equal(isLoopbackRemoteAddress(undefined), false);
  });

  test("rejects unregistered workspace file reads", async () => {
    const response = await requestJson({
      port,
      path: `/api/workspace/file?dir=${encodeURIComponent("/etc")}&path=${encodeURIComponent("hosts")}`,
      headers: { Origin: `http://127.0.0.1:${port}` },
    });
    assert.equal(response.status, 403);
    assert.deepEqual(response.json, { error: "Workspace directory is not registered." });
  });

  test("rejects session scopeRoot outside the registered workspace boundary", async () => {
    const scenarios = (await requestJson({
      port,
      path: "/api/debug/scenarios",
      headers: { Origin: `http://127.0.0.1:${port}` },
    })) as { status: number; json: { scenarios: Array<{ id: string }> } };
    assert.equal(scenarios.status, 200);
    const scenarioId = scenarios.json.scenarios[0]?.id;
    assert.equal(typeof scenarioId, "string");

    const started = (await requestJson({
      port,
      path: "/api/debug/scenarios/start",
      method: "POST",
      headers: {
        Origin: `http://127.0.0.1:${port}`,
        "x-rah-client": "web",
      },
      body: { scenarioId },
    })) as { status: number; json: { session: { session: { id: string } } } };
    assert.equal(started.status, 200);
    const sessionId = started.json.session.session.id;

    const response = await requestJson({
      port,
      path:
        `/api/sessions/${sessionId}/file?path=${encodeURIComponent("README.md")}` +
        `&scopeRoot=${encodeURIComponent("/etc")}`,
      headers: { Origin: `http://127.0.0.1:${port}` },
    });
    assert.equal(response.status, 403);
    assert.deepEqual(response.json, { error: "Workspace directory is not registered." });
  });

  test("serves workspace file and search routes for a registered workspace", async () => {
    const nestedDir = path.join(tempHome, "project");
    writeFileSync(path.join(tempHome, "hello.txt"), "hello rah\n");
    writeFileSync(path.join(tempHome, "notes.md"), "workspace search target\n");

    const selected = await requestJson({
      port,
      path: "/api/workspaces/select",
      method: "POST",
      headers: {
        Origin: `http://127.0.0.1:${port}`,
        "x-rah-client": "web",
      },
      body: { dir: tempHome },
    });
    assert.equal(selected.status, 200);

    const fileResponse = await requestJson({
      port,
      path:
        `/api/workspace/file?dir=${encodeURIComponent(tempHome)}` +
        `&path=${encodeURIComponent("hello.txt")}`,
      headers: { Origin: `http://127.0.0.1:${port}` },
    });
    assert.equal(fileResponse.status, 200);
    assert.equal(typeof fileResponse.json, "object");
    assert.equal((fileResponse.json as { content: string }).content, "hello rah\n");

    const searchResponse = await requestJson({
      port,
      path:
        `/api/workspace/file-search?dir=${encodeURIComponent(tempHome)}` +
        `&query=${encodeURIComponent("notes")}`,
      headers: { Origin: `http://127.0.0.1:${port}` },
    });
    assert.equal(searchResponse.status, 200);
    assert.equal(typeof searchResponse.json, "object");
    assert.deepEqual(
      (searchResponse.json as { files: Array<{ path: string }> }).files.map((entry) => entry.path),
      ["notes.md"],
    );

    void nestedDir;
  });

  test("serves workspace git routes for a registered workspace", async () => {
    await requestJson({
      port,
      path: "/api/workspaces/select",
      method: "POST",
      headers: {
        Origin: `http://127.0.0.1:${port}`,
        "x-rah-client": "web",
      },
      body: { dir: tempHome },
    });

    const gitStatus = await requestJson({
      port,
      path: `/api/workspace/git-status?dir=${encodeURIComponent(tempHome)}`,
      headers: { Origin: `http://127.0.0.1:${port}` },
    });
    assert.equal(gitStatus.status, 200);
    assert.equal(typeof gitStatus.json, "object");
    assert.deepEqual((gitStatus.json as { changedFiles: string[] }).changedFiles, []);

    const gitDiff = await requestJson({
      port,
      path:
        `/api/workspace/git-diff?dir=${encodeURIComponent(tempHome)}` +
        `&path=${encodeURIComponent("hello.txt")}`,
      headers: { Origin: `http://127.0.0.1:${port}` },
    });
    assert.equal(gitDiff.status, 200);
    assert.equal(typeof gitDiff.json, "object");
    assert.equal((gitDiff.json as { diff: string }).diff, "");
  });
});

import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { RuntimeEngine } from "./runtime-engine";
import { startRahDaemon, type RahDaemon } from "./http-server";

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
});

import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import assert from "node:assert/strict";

const execFileAsync = promisify(execFile);

async function listen(server: ReturnType<typeof createServer>): Promise<number> {
  return await new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Could not allocate a port."));
        return;
      }
      resolve(address.port);
    });
  });
}

async function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

test("rah status trusts daemon runtime identity and writes a structured pid record", async () => {
  const rahHome = mkdtempSync(path.join(os.tmpdir(), "rah-cli-management-"));
  const rootDir = process.cwd();
  let port = 0;
  const server = createServer((req, res) => {
    if (req.url === "/readyz") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
      return;
    }
    if (req.url === "/api/runtime") {
      const body = JSON.stringify({
        name: "rah",
        runtimeId: "runtime-test",
        pid: process.pid,
        port,
        startedAt: "2026-05-21T00:00:00.000Z",
        rootDir,
        version: "test",
        sourceRevision: "test-revision",
        sourceDirty: false,
      });
      res.writeHead(200, {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body),
      });
      res.end(body);
      return;
    }
    res.writeHead(404);
    res.end();
  });

  try {
    port = await listen(server);
    const daemonUrl = `http://127.0.0.1:${port}`;
    const { stdout } = await execFileAsync(
      process.execPath,
      ["bin/rah.mjs", "status", "--daemon-url", daemonUrl],
      {
        cwd: rootDir,
        env: {
          ...process.env,
          RAH_HOME: rahHome,
        },
      },
    );

    assert.match(stdout, new RegExp(`Daemon: running \\(${daemonUrl}\\)`));
    assert.match(stdout, new RegExp(`Managed pid: ${process.pid}`));

    const recordPath = path.join(rahHome, `daemon-${port}.pid`);
    const record = JSON.parse(readFileSync(recordPath, "utf8")) as Record<string, unknown>;
    assert.equal(record.schemaVersion, 1);
    assert.equal(record.name, "rah");
    assert.equal(record.pid, process.pid);
    assert.equal(record.runtimeId, "runtime-test");
    assert.equal(record.rootDir, rootDir);
    assert.equal(record.port, port);
    assert.equal(record.daemonUrl, daemonUrl);
    assert.equal(record.sourceDirty, false);
  } finally {
    await closeServer(server);
    rmSync(rahHome, { recursive: true, force: true });
  }
});

test("rah status rejects a daemon identity from another RAH checkout", async () => {
  const rahHome = mkdtempSync(path.join(os.tmpdir(), "rah-cli-management-"));
  const rootDir = process.cwd();
  let port = 0;
  const server = createServer((req, res) => {
    if (req.url === "/readyz") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
      return;
    }
    if (req.url === "/api/runtime") {
      const body = JSON.stringify({
        name: "rah",
        runtimeId: "runtime-other-root",
        pid: process.pid,
        port,
        startedAt: "2026-05-21T00:00:00.000Z",
        rootDir: path.join(rootDir, "other-rah-checkout"),
      });
      res.writeHead(200, {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body),
      });
      res.end(body);
      return;
    }
    res.writeHead(404);
    res.end();
  });

  try {
    port = await listen(server);
    const daemonUrl = `http://127.0.0.1:${port}/`;
    await assert.rejects(
      execFileAsync(process.execPath, ["bin/rah.mjs", "status", "--daemon-url", daemonUrl], {
        cwd: rootDir,
        env: {
          ...process.env,
          RAH_HOME: rahHome,
        },
      }),
      (error: unknown) => {
        assert.ok(error && typeof error === "object");
        const failed = error as { stderr?: string };
        assert.match(
          failed.stderr ?? "",
          new RegExp(`Port ${port} is occupied by a different RAH daemon`),
        );
        return true;
      },
    );
  } finally {
    await closeServer(server);
    rmSync(rahHome, { recursive: true, force: true });
  }
});

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { WebSocketServer } from "ws";

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function writeJson(res: ServerResponse, statusCode: number, body: unknown): void {
  res.writeHead(statusCode, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function listen(server: ReturnType<typeof createServer>): Promise<number> {
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address && typeof address === "object");
  return address.port;
}

async function closeServer(server: ReturnType<typeof createServer>, wss: WebSocketServer): Promise<void> {
  await new Promise<void>((resolve) => {
    wss.close(() => resolve());
  });
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}

test("rah provider command creates a native TUI session and attaches to PTY", async () => {
  const startRequests: unknown[] = [];
  const detachRequests: unknown[] = [];
  const ptyMessages: unknown[] = [];
  const wss = new WebSocketServer({ noServer: true });
  const server = createServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/readyz") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
      return;
    }
    if (req.method === "POST" && req.url === "/api/sessions/start") {
      startRequests.push(await readJsonBody(req));
      writeJson(res, 200, {
        session: {
          id: "session-1",
          provider: "codex",
          launchSource: "terminal",
          liveBackend: "native_tui",
          cwd: "/tmp",
          rootDir: "/tmp",
          runtimeState: "idle",
          ptyId: "session-1",
          capabilities: {},
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      });
      return;
    }
    if (req.method === "POST" && req.url === "/api/sessions/session-1/detach") {
      detachRequests.push(await readJsonBody(req));
      writeJson(res, 200, {
        session: {
          id: "session-1",
          provider: "codex",
          launchSource: "terminal",
          liveBackend: "native_tui",
          cwd: "/tmp",
          rootDir: "/tmp",
          runtimeState: "stopped",
          ptyId: "session-1",
          capabilities: {},
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      });
      return;
    }
    res.writeHead(404);
    res.end("not found");
  });
  server.on("upgrade", (req, socket, head) => {
    if (req.url?.startsWith("/api/pty/session-1")) {
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws, req);
      });
      return;
    }
    socket.destroy();
  });
  wss.on("connection", (ws) => {
    ws.on("message", (raw) => {
      ptyMessages.push(JSON.parse(raw.toString("utf8")));
    });
    ws.send(JSON.stringify({
      type: "pty.replay",
      sessionId: "session-1",
      chunks: ["rah cli pty attached\n"],
      status: "open",
    }));
    setTimeout(() => {
      ws.send(JSON.stringify({
        type: "pty.exited",
        sessionId: "session-1",
        exitCode: 0,
      }));
    }, 20);
  });

  const port = await listen(server);
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "rah-cli-pty-first-"));
  const child = spawn(
    process.execPath,
    [
      "bin/rah.mjs",
      "codex",
      "--daemon-url",
      `http://127.0.0.1:${port}`,
      "--cwd",
      tmpDir,
    ],
    {
      cwd: process.cwd(),
      env: { ...process.env, RAH_LEGACY_WRAPPER: "" },
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr?.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code) => resolve(code));
  });
  await closeServer(server, wss);

  assert.equal(exitCode, 0, stderr);
  assert.match(stdout, /rah cli pty attached/);
  assert.equal(startRequests.length, 1);
  const startRequest = startRequests[0] as {
    provider: string;
    cwd: string;
    liveBackend: string;
    attach: {
      client: {
        id: string;
        kind: string;
        connectionId: string;
        cols: number;
        rows: number;
      };
      mode: string;
      claimControl: boolean;
    };
  };
  assert.equal(startRequest.provider, "codex");
  assert.equal(startRequest.cwd, tmpDir);
  assert.equal(startRequest.liveBackend, "native_tui");
  assert.match(startRequest.attach.client.id, /^terminal:/);
  assert.equal(startRequest.attach.client.kind, "terminal");
  assert.equal(startRequest.attach.client.connectionId, `pid:${child.pid}`);
  assert.equal(startRequest.attach.client.cols, 100);
  assert.equal(startRequest.attach.client.rows, 32);
  assert.equal(startRequest.attach.mode, "interactive");
  assert.equal(startRequest.attach.claimControl, true);
  assert.deepEqual(detachRequests, [{ clientId: startRequest.attach.client.id }]);
  assert.deepEqual(ptyMessages[0], {
    type: "pty.resize",
    sessionId: "session-1",
    clientId: startRequest.attach.client.id,
    cols: 100,
    rows: 32,
  });
});

test("rah provider resume command creates a native TUI resume session and attaches to PTY", async () => {
  const resumeRequests: unknown[] = [];
  const detachRequests: unknown[] = [];
  const wss = new WebSocketServer({ noServer: true });
  const server = createServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/readyz") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
      return;
    }
    if (req.method === "POST" && req.url === "/api/sessions/resume") {
      resumeRequests.push(await readJsonBody(req));
      writeJson(res, 200, {
        session: {
          id: "session-resume-1",
          provider: "codex",
          providerSessionId: "provider-session-1",
          launchSource: "terminal",
          liveBackend: "native_tui",
          cwd: "/tmp",
          rootDir: "/tmp",
          runtimeState: "idle",
          ptyId: "session-resume-1",
          capabilities: {},
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      });
      return;
    }
    if (req.method === "POST" && req.url === "/api/sessions/session-resume-1/detach") {
      detachRequests.push(await readJsonBody(req));
      writeJson(res, 200, {
        session: {
          id: "session-resume-1",
          provider: "codex",
          providerSessionId: "provider-session-1",
          launchSource: "terminal",
          liveBackend: "native_tui",
          cwd: "/tmp",
          rootDir: "/tmp",
          runtimeState: "stopped",
          ptyId: "session-resume-1",
          capabilities: {},
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      });
      return;
    }
    res.writeHead(404);
    res.end("not found");
  });
  server.on("upgrade", (req, socket, head) => {
    if (req.url?.startsWith("/api/pty/session-resume-1")) {
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws, req);
      });
      return;
    }
    socket.destroy();
  });
  wss.on("connection", (ws) => {
    ws.send(JSON.stringify({
      type: "pty.replay",
      sessionId: "session-resume-1",
      chunks: ["rah cli resume pty attached\n"],
      status: "open",
    }));
    setTimeout(() => {
      ws.send(JSON.stringify({
        type: "pty.exited",
        sessionId: "session-resume-1",
        exitCode: 0,
      }));
    }, 20);
  });

  const port = await listen(server);
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "rah-cli-pty-resume-"));
  const child = spawn(
    process.execPath,
    [
      "bin/rah.mjs",
      "codex",
      "resume",
      "provider-session-1",
      "--daemon-url",
      `http://127.0.0.1:${port}`,
      "--cwd",
      tmpDir,
    ],
    {
      cwd: process.cwd(),
      env: { ...process.env, RAH_LEGACY_WRAPPER: "" },
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr?.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code) => resolve(code));
  });
  await closeServer(server, wss);

  assert.equal(exitCode, 0, stderr);
  assert.match(stdout, /rah cli resume pty attached/);
  assert.equal(resumeRequests.length, 1);
  const resumeRequest = resumeRequests[0] as {
    provider: string;
    providerSessionId: string;
    cwd: string;
    liveBackend: string;
    attach: {
      client: {
        id: string;
        kind: string;
        connectionId: string;
      };
      mode: string;
      claimControl: boolean;
    };
  };
  assert.equal(resumeRequest.provider, "codex");
  assert.equal(resumeRequest.providerSessionId, "provider-session-1");
  assert.equal(resumeRequest.cwd, tmpDir);
  assert.equal(resumeRequest.liveBackend, "native_tui");
  assert.match(resumeRequest.attach.client.id, /^terminal:/);
  assert.equal(resumeRequest.attach.client.kind, "terminal");
  assert.equal(resumeRequest.attach.client.connectionId, `pid:${child.pid}`);
  assert.equal(resumeRequest.attach.mode, "interactive");
  assert.equal(resumeRequest.attach.claimControl, true);
  assert.deepEqual(detachRequests, [{ clientId: resumeRequest.attach.client.id }]);
});

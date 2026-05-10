import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

function sessionSummary(session: Record<string, unknown>): Record<string, unknown> {
  return {
    session,
    attachedClients: [],
    controlLease: {},
    feed: [],
  };
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

test("rah help documents core live providers", async () => {
  const child = spawn(process.execPath, ["bin/rah.mjs", "--help"], {
    cwd: process.cwd(),
  });
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

  assert.equal(exitCode, 0, stderr);
  assert.match(stdout, /codex \| claude \| opencode/);
  assert.doesNotMatch(stdout, /unknown-provider/);
  assert.doesNotMatch(stdout, /approval-mode/);
  assert.doesNotMatch(stdout, /RAH_ENABLE_ARCHIVED_PROVIDER_LIVE/);
});

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
        session: sessionSummary({
          id: "session-1",
          provider: "codex",
          launchSource: "terminal",
          liveBackend: "native_tui",
          cwd: "/tmp",
          rootDir: "/tmp",
          runtimeState: "idle",
          ptyId: "session-1",
          nativeTui: {
            terminalId: "session-1",
            viewAvailable: true,
            promptState: "prompt_clean",
          },
          capabilities: {},
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }),
      });
      return;
    }
    if (req.method === "POST" && req.url === "/api/sessions/session-1/detach") {
      detachRequests.push(await readJsonBody(req));
      writeJson(res, 200, {
        session: sessionSummary({
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
        }),
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
      "--mux",
      "native",
      "--daemon-url",
      `http://127.0.0.1:${port}`,
      "--cwd",
      tmpDir,
    ],
    {
      cwd: process.cwd(),
      env: { ...process.env, RAH_LEGACY_WRAPPER: "1" },
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

test("rah codex defaults to native local-server and attaches the official remote TUI client", async () => {
  const startRequests: unknown[] = [];
  const attachRequests: unknown[] = [];
  const detachRequests: unknown[] = [];
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
        session: sessionSummary({
          id: "session-codex-native-local",
          provider: "codex",
          launchSource: "terminal",
          liveBackend: "native_local_server",
          cwd: "/tmp",
          rootDir: "/tmp",
          runtimeState: "idle",
          runtime: {
            kind: "native_local_server",
            protocolStability: "project_native",
            liveSource: "provider_server",
            tuiRole: "client_view",
            structuredLiveEvents: true,
            tuiContinuity: true,
          },
          runtimeDiagnostics: {
            serverEndpoint: "ws://127.0.0.1:59999",
            attachState: "ready",
            lastEventCursor: "thread:pending",
          },
          capabilities: {},
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }),
      });
      return;
    }
    if (req.method === "POST" && req.url === "/api/sessions/session-codex-native-local/attach") {
      attachRequests.push(await readJsonBody(req));
      writeJson(res, 200, {
        session: sessionSummary({
          id: "session-codex-native-local",
          provider: "codex",
          launchSource: "terminal",
          liveBackend: "native_local_server",
          cwd: "/tmp",
          rootDir: "/tmp",
          runtimeState: "idle",
          capabilities: {},
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }),
      });
      return;
    }
    if (req.method === "POST" && req.url === "/api/sessions/session-codex-native-local/detach") {
      detachRequests.push(await readJsonBody(req));
      writeJson(res, 200, {
        session: sessionSummary({
          id: "session-codex-native-local",
          provider: "codex",
          launchSource: "terminal",
          liveBackend: "native_local_server",
          cwd: "/tmp",
          rootDir: "/tmp",
          runtimeState: "idle",
          capabilities: {},
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }),
      });
      return;
    }
    res.writeHead(404);
    res.end("not found");
  });

  const port = await listen(server);
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "rah-cli-codex-native-local-"));
  const fakeBin = path.join(tmpDir, "bin");
  const logPath = path.join(tmpDir, "codex-remote-attach.log");
  const fakeCodex = path.join(fakeBin, "codex");
  mkdirSync(fakeBin, { recursive: true });
  writeFileSync(
    fakeCodex,
    [
      "#!/bin/sh",
      "printf 'cwd=%s\\n' \"$PWD\" > \"$RAH_CODEX_REMOTE_ATTACH_LOG\"",
      "printf 'args=%s\\n' \"$*\" >> \"$RAH_CODEX_REMOTE_ATTACH_LOG\"",
    ].join("\n"),
  );
  chmodSync(fakeCodex, 0o755);

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
      env: {
        ...process.env,
        PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`,
        RAH_CODEX_BINARY: fakeCodex,
        RAH_CODEX_REMOTE_ATTACH_LOG: logPath,
        RAH_MUX_BACKEND: "",
      },
    },
  );
  let stderr = "";
  child.stderr?.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code) => resolve(code));
  });
  await closeServer(server, wss);

  try {
    assert.equal(exitCode, 0, stderr);
    assert.equal(startRequests.length, 1);
    const startRequest = startRequests[0] as {
      provider: string;
      liveBackend: string;
      attach: { client: { id: string }; claimControl: boolean };
    };
    assert.equal(startRequest.provider, "codex");
    assert.equal(startRequest.liveBackend, "native_local_server");
    assert.equal(startRequest.attach.claimControl, true);
    assert.equal(attachRequests.length, 1);
    const attachRequest = attachRequests[0] as { client: { id: string }; claimControl?: boolean };
    assert.equal(attachRequest.client.id, startRequest.attach.client.id);
    assert.equal(attachRequest.claimControl, false);
    assert.deepEqual(detachRequests, [{ clientId: startRequest.attach.client.id }]);
    const attachLog = readFileSync(logPath, "utf8");
    assert.match(attachLog, /^cwd=\/(?:private\/)?tmp$/m);
    assert.match(attachLog, /args=--remote ws:\/\/127\.0\.0\.1:59999/);
    assert.doesNotMatch(attachLog, /resume/);
  } finally {
    rmSync(tmpDir, { force: true, recursive: true });
  }
});

test("rah codex resume defaults to native local-server and attaches the official remote TUI client", async () => {
  const resumeRequests: unknown[] = [];
  const attachRequests: unknown[] = [];
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
        session: sessionSummary({
          id: "session-codex-resume-native-local",
          provider: "codex",
          providerSessionId: "codex-thread-resume-1",
          launchSource: "terminal",
          liveBackend: "native_local_server",
          cwd: "/tmp",
          rootDir: "/tmp",
          runtimeState: "idle",
          runtime: {
            kind: "native_local_server",
            protocolStability: "project_native",
            liveSource: "provider_server",
            tuiRole: "client_view",
            structuredLiveEvents: true,
            tuiContinuity: true,
          },
          runtimeDiagnostics: {
            serverEndpoint: "ws://127.0.0.1:59998",
            attachState: "ready",
            lastEventCursor: "thread:codex-thread-resume-1",
          },
          capabilities: {},
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }),
      });
      return;
    }
    if (req.method === "POST" && req.url === "/api/sessions/session-codex-resume-native-local/attach") {
      attachRequests.push(await readJsonBody(req));
      writeJson(res, 200, {
        session: sessionSummary({
          id: "session-codex-resume-native-local",
          provider: "codex",
          providerSessionId: "codex-thread-resume-1",
          launchSource: "terminal",
          liveBackend: "native_local_server",
          cwd: "/tmp",
          rootDir: "/tmp",
          runtimeState: "idle",
          capabilities: {},
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }),
      });
      return;
    }
    if (req.method === "POST" && req.url === "/api/sessions/session-codex-resume-native-local/detach") {
      detachRequests.push(await readJsonBody(req));
      writeJson(res, 200, {
        session: sessionSummary({
          id: "session-codex-resume-native-local",
          provider: "codex",
          providerSessionId: "codex-thread-resume-1",
          launchSource: "terminal",
          liveBackend: "native_local_server",
          cwd: "/tmp",
          rootDir: "/tmp",
          runtimeState: "idle",
          capabilities: {},
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }),
      });
      return;
    }
    res.writeHead(404);
    res.end("not found");
  });

  const port = await listen(server);
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "rah-cli-codex-resume-native-local-"));
  const fakeBin = path.join(tmpDir, "bin");
  const logPath = path.join(tmpDir, "codex-remote-resume-attach.log");
  const fakeCodex = path.join(fakeBin, "codex");
  mkdirSync(fakeBin, { recursive: true });
  writeFileSync(
    fakeCodex,
    [
      "#!/bin/sh",
      "printf 'cwd=%s\\n' \"$PWD\" > \"$RAH_CODEX_REMOTE_ATTACH_LOG\"",
      "printf 'args=%s\\n' \"$*\" >> \"$RAH_CODEX_REMOTE_ATTACH_LOG\"",
    ].join("\n"),
  );
  chmodSync(fakeCodex, 0o755);

  const child = spawn(
    process.execPath,
    [
      "bin/rah.mjs",
      "codex",
      "resume",
      "codex-thread-resume-1",
      "--daemon-url",
      `http://127.0.0.1:${port}`,
      "--cwd",
      tmpDir,
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`,
        RAH_CODEX_BINARY: fakeCodex,
        RAH_CODEX_REMOTE_ATTACH_LOG: logPath,
        RAH_MUX_BACKEND: "",
      },
    },
  );
  let stderr = "";
  child.stderr?.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code) => resolve(code));
  });
  await closeServer(server, wss);

  try {
    assert.equal(exitCode, 0, stderr);
    assert.equal(resumeRequests.length, 1);
    const resumeRequest = resumeRequests[0] as {
      provider: string;
      providerSessionId: string;
      liveBackend: string;
      attach: { client: { id: string }; claimControl: boolean };
    };
    assert.equal(resumeRequest.provider, "codex");
    assert.equal(resumeRequest.providerSessionId, "codex-thread-resume-1");
    assert.equal(resumeRequest.liveBackend, "native_local_server");
    assert.equal(resumeRequest.attach.claimControl, true);
    const attachRequest = attachRequests[0] as { client: { id: string }; claimControl?: boolean };
    assert.equal(attachRequest.client.id, resumeRequest.attach.client.id);
    assert.equal(attachRequest.claimControl, false);
    assert.deepEqual(detachRequests, [{ clientId: resumeRequest.attach.client.id }]);
    const attachLog = readFileSync(logPath, "utf8");
    assert.match(attachLog, /^cwd=\/(?:private\/)?tmp$/m);
    assert.match(attachLog, /args=--remote ws:\/\/127\.0\.0\.1:59998 resume codex-thread-resume-1/);
  } finally {
    rmSync(tmpDir, { force: true, recursive: true });
  }
});

test("rah opencode defaults to native local-server and attaches the official TUI client", async () => {
  const startRequests: unknown[] = [];
  const attachRequests: unknown[] = [];
  const detachRequests: unknown[] = [];
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
        session: sessionSummary({
          id: "session-opencode-native-local",
          provider: "opencode",
          providerSessionId: "opencode-session-1",
          launchSource: "terminal",
          liveBackend: "native_local_server",
          cwd: "/tmp",
          rootDir: "/tmp",
          runtimeState: "idle",
          runtime: {
            kind: "native_local_server",
            protocolStability: "project_native",
            liveSource: "provider_server",
            tuiRole: "client_view",
            structuredLiveEvents: true,
            tuiContinuity: true,
          },
          runtimeDiagnostics: {
            serverEndpoint: "http://127.0.0.1:59997",
            attachCommand: "opencode attach http://127.0.0.1:59997 --session opencode-session-1",
            attachState: "ready",
            lastEventCursor: "session:opencode-session-1",
          },
          capabilities: {},
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }),
      });
      return;
    }
    if (req.method === "POST" && req.url === "/api/sessions/session-opencode-native-local/attach") {
      attachRequests.push(await readJsonBody(req));
      writeJson(res, 200, {
        session: sessionSummary({
          id: "session-opencode-native-local",
          provider: "opencode",
          providerSessionId: "opencode-session-1",
          launchSource: "terminal",
          liveBackend: "native_local_server",
          cwd: "/tmp",
          rootDir: "/tmp",
          runtimeState: "idle",
          capabilities: {},
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }),
      });
      return;
    }
    if (req.method === "POST" && req.url === "/api/sessions/session-opencode-native-local/detach") {
      detachRequests.push(await readJsonBody(req));
      writeJson(res, 200, {
        session: sessionSummary({
          id: "session-opencode-native-local",
          provider: "opencode",
          providerSessionId: "opencode-session-1",
          launchSource: "terminal",
          liveBackend: "native_local_server",
          cwd: "/tmp",
          rootDir: "/tmp",
          runtimeState: "idle",
          capabilities: {},
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }),
      });
      return;
    }
    res.writeHead(404);
    res.end("not found");
  });

  const port = await listen(server);
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "rah-cli-opencode-native-local-"));
  const fakeBin = path.join(tmpDir, "bin");
  const logPath = path.join(tmpDir, "opencode-native-attach.log");
  const fakeOpenCode = path.join(fakeBin, "opencode");
  mkdirSync(fakeBin, { recursive: true });
  writeFileSync(
    fakeOpenCode,
    [
      "#!/bin/sh",
      "printf 'cwd=%s\\n' \"$PWD\" > \"$RAH_OPENCODE_ATTACH_LOG\"",
      "printf 'args=%s\\n' \"$*\" >> \"$RAH_OPENCODE_ATTACH_LOG\"",
    ].join("\n"),
  );
  chmodSync(fakeOpenCode, 0o755);

  const child = spawn(
    process.execPath,
    [
      "bin/rah.mjs",
      "opencode",
      "--daemon-url",
      `http://127.0.0.1:${port}`,
      "--cwd",
      tmpDir,
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`,
        RAH_OPENCODE_BINARY: fakeOpenCode,
        RAH_OPENCODE_ATTACH_LOG: logPath,
        RAH_MUX_BACKEND: "",
      },
    },
  );
  let stderr = "";
  child.stderr?.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code) => resolve(code));
  });
  await closeServer(server, wss);

  try {
    assert.equal(exitCode, 0, stderr);
    assert.equal(startRequests.length, 1);
    const startRequest = startRequests[0] as {
      provider: string;
      liveBackend: string;
      attach: { client: { id: string }; claimControl: boolean };
    };
    assert.equal(startRequest.provider, "opencode");
    assert.equal(startRequest.liveBackend, "native_local_server");
    assert.equal(startRequest.attach.claimControl, true);
    const attachRequest = attachRequests[0] as { client: { id: string }; claimControl?: boolean };
    assert.equal(attachRequest.client.id, startRequest.attach.client.id);
    assert.equal(attachRequest.claimControl, false);
    assert.deepEqual(detachRequests, [{ clientId: startRequest.attach.client.id }]);
    const attachLog = readFileSync(logPath, "utf8");
    assert.match(attachLog, /^cwd=\/(?:private\/)?tmp$/m);
    assert.match(attachLog, /args=attach http:\/\/127\.0\.0\.1:59997 --session opencode-session-1/);
  } finally {
    rmSync(tmpDir, { force: true, recursive: true });
  }
});

test("rah provider command accepts --mux zellij and requests the zellij live backend", async () => {
  const startRequests: unknown[] = [];
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
        session: sessionSummary({
          id: "session-zellij-flag",
          provider: "codex",
          launchSource: "terminal",
          liveBackend: "zellij_tui",
          cwd: "/tmp",
          rootDir: "/tmp",
          runtimeState: "idle",
          ptyId: "session-zellij-flag",
          nativeTui: {
            terminalId: "session-zellij-flag",
            viewAvailable: true,
            promptState: "prompt_clean",
          },
          capabilities: {},
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }),
      });
      return;
    }
    if (req.method === "POST" && req.url === "/api/sessions/session-zellij-flag/detach") {
      await readJsonBody(req);
      writeJson(res, 200, {
        session: sessionSummary({
          id: "session-zellij-flag",
          provider: "codex",
          launchSource: "terminal",
          liveBackend: "zellij_tui",
          cwd: "/tmp",
          rootDir: "/tmp",
          runtimeState: "stopped",
          ptyId: "session-zellij-flag",
          capabilities: {},
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }),
      });
      return;
    }
    res.writeHead(404);
    res.end("not found");
  });
  server.on("upgrade", (req, socket, head) => {
    if (req.url?.startsWith("/api/pty/session-zellij-flag")) {
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
      sessionId: "session-zellij-flag",
      chunks: ["rah cli zellij flag attached\n"],
      status: "open",
    }));
    setTimeout(() => {
      ws.send(JSON.stringify({
        type: "pty.exited",
        sessionId: "session-zellij-flag",
        exitCode: 0,
      }));
    }, 20);
  });

  const port = await listen(server);
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "rah-cli-zellij-flag-"));
  const child = spawn(
    process.execPath,
    [
      "bin/rah.mjs",
      "codex",
      "--mux",
      "zellij",
      "--daemon-url",
      `http://127.0.0.1:${port}`,
      "--cwd",
      tmpDir,
    ],
    {
      cwd: process.cwd(),
      env: { ...process.env },
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
  assert.match(stdout, /rah cli zellij flag attached/);
  assert.equal(startRequests.length, 1);
  const startRequest = startRequests[0] as { liveBackend: string };
  assert.equal(startRequest.liveBackend, "zellij_tui");
});

test("rah provider command honors RAH_MUX_BACKEND=zellij", async () => {
  const startRequests: unknown[] = [];
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
        session: sessionSummary({
          id: "session-zellij-env",
          provider: "claude",
          launchSource: "terminal",
          liveBackend: "zellij_tui",
          cwd: "/tmp",
          rootDir: "/tmp",
          runtimeState: "idle",
          ptyId: "session-zellij-env",
          nativeTui: {
            terminalId: "session-zellij-env",
            viewAvailable: true,
            promptState: "prompt_clean",
          },
          capabilities: {},
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }),
      });
      return;
    }
    if (req.method === "POST" && req.url === "/api/sessions/session-zellij-env/detach") {
      await readJsonBody(req);
      writeJson(res, 200, {
        session: sessionSummary({
          id: "session-zellij-env",
          provider: "claude",
          launchSource: "terminal",
          liveBackend: "zellij_tui",
          cwd: "/tmp",
          rootDir: "/tmp",
          runtimeState: "stopped",
          ptyId: "session-zellij-env",
          capabilities: {},
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }),
      });
      return;
    }
    res.writeHead(404);
    res.end("not found");
  });
  server.on("upgrade", (req, socket, head) => {
    if (req.url?.startsWith("/api/pty/session-zellij-env")) {
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
      sessionId: "session-zellij-env",
      chunks: ["rah cli zellij env attached\n"],
      status: "open",
    }));
    setTimeout(() => {
      ws.send(JSON.stringify({
        type: "pty.exited",
        sessionId: "session-zellij-env",
        exitCode: 0,
      }));
    }, 20);
  });

  const port = await listen(server);
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "rah-cli-zellij-env-"));
  const child = spawn(
    process.execPath,
    [
      "bin/rah.mjs",
      "claude",
      "--daemon-url",
      `http://127.0.0.1:${port}`,
      "--cwd",
      tmpDir,
    ],
    {
      cwd: process.cwd(),
      env: { ...process.env, RAH_MUX_BACKEND: "zellij" },
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
  assert.match(stdout, /rah cli zellij env attached/);
  assert.equal(startRequests.length, 1);
  const startRequest = startRequests[0] as { liveBackend: string };
  assert.equal(startRequest.liveBackend, "zellij_tui");
});

test("rah claude attaches local terminal through zellij when mux metadata is present", async () => {
  const startRequests: unknown[] = [];
  const detachRequests: unknown[] = [];
  const surfaceClaims: unknown[] = [];
  const surfaceReleases: unknown[] = [];
  let activeSurface: unknown;
  let ptyConnected = false;
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
        session: sessionSummary({
          id: "session-zellij-attach",
          provider: "claude",
          launchSource: "terminal",
          liveBackend: "zellij_tui",
          cwd: "/tmp",
          rootDir: "/tmp",
          runtimeState: "idle",
          ptyId: "session-zellij-attach",
          nativeTui: {
            terminalId: "session-zellij-attach",
            viewAvailable: true,
            promptState: "prompt_clean",
          },
          mux: {
            backend: "zellij",
            sessionName: "rah-attachtest",
            paneId: "terminal_1",
            socketDir: "/tmp/rah-zellij-attach-test",
          },
          capabilities: {},
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }),
      });
      return;
    }
    if (req.method === "POST" && req.url === "/api/sessions/session-zellij-attach/tui-surface/claim") {
      const body = await readJsonBody(req);
      surfaceClaims.push(body);
      activeSurface = {
        sessionId: "session-zellij-attach",
        clientId: (body as { clientId: string }).clientId,
        clientKind: (body as { clientKind: string }).clientKind,
        attachedAt: new Date().toISOString(),
      };
      writeJson(res, 200, { surface: activeSurface });
      return;
    }
    if (req.method === "POST" && req.url === "/api/sessions/session-zellij-attach/tui-surface/release") {
      surfaceReleases.push(await readJsonBody(req));
      activeSurface = undefined;
      writeJson(res, 200, {});
      return;
    }
    if (req.method === "GET" && req.url === "/api/sessions/session-zellij-attach/tui-surface") {
      writeJson(res, 200, activeSurface ? { surface: activeSurface } : {});
      return;
    }
    if (req.method === "POST" && req.url === "/api/sessions/session-zellij-attach/detach") {
      detachRequests.push(await readJsonBody(req));
      writeJson(res, 200, {
        session: sessionSummary({
          id: "session-zellij-attach",
          provider: "codex",
          launchSource: "terminal",
          liveBackend: "zellij_tui",
          cwd: "/tmp",
          rootDir: "/tmp",
          runtimeState: "stopped",
          ptyId: "session-zellij-attach",
          capabilities: {},
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }),
      });
      return;
    }
    res.writeHead(404);
    res.end("not found");
  });
  server.on("upgrade", (req, socket, head) => {
    if (req.url?.startsWith("/api/pty/session-zellij-attach")) {
      ptyConnected = true;
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws, req);
      });
      return;
    }
    socket.destroy();
  });

  const port = await listen(server);
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "rah-cli-zellij-attach-"));
  const fakeBin = path.join(tmpDir, "bin");
  const logPath = path.join(tmpDir, "zellij-attach.log");
  const fakeZellij = path.join(fakeBin, "zellij");
  mkdirSync(fakeBin, { recursive: true });
  writeFileSync(
    fakeZellij,
    [
      "#!/bin/sh",
      "printf 'cwd=%s\\n' \"$PWD\" > \"$RAH_ZELLIJ_ATTACH_LOG\"",
      "printf 'socket=%s\\n' \"$ZELLIJ_SOCKET_DIR\" >> \"$RAH_ZELLIJ_ATTACH_LOG\"",
      "printf 'args=%s\\n' \"$*\" >> \"$RAH_ZELLIJ_ATTACH_LOG\"",
    ].join("\n"),
  );
  chmodSync(fakeZellij, 0o755);
  const child = spawn(
    process.execPath,
    [
      "bin/rah.mjs",
      "claude",
      "--daemon-url",
      `http://127.0.0.1:${port}`,
      "--cwd",
      tmpDir,
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`,
        RAH_ZELLIJ_ATTACH_LOG: logPath,
      },
    },
  );
  let stderr = "";
  child.stderr?.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code) => resolve(code));
  });
  await closeServer(server, wss);

  try {
    assert.equal(exitCode, 0, stderr);
    assert.equal(startRequests.length, 1);
    const startRequest = startRequests[0] as {
      provider: string;
      liveBackend: string;
      attach: { client: { id: string } };
    };
    assert.equal(startRequest.provider, "claude");
    assert.equal(startRequest.liveBackend, "zellij_tui");
    assert.equal(ptyConnected, false);
    assert.deepEqual(surfaceClaims, [{
      clientId: startRequest.attach.client.id,
      clientKind: "terminal",
      cols: 100,
      rows: 32,
    }]);
    assert.deepEqual(surfaceReleases, [{ clientId: startRequest.attach.client.id }]);
    assert.deepEqual(detachRequests, [{ clientId: startRequest.attach.client.id }]);
    const attachLog = readFileSync(logPath, "utf8");
    assert.match(attachLog, /^cwd=\/(?:private\/)?tmp$/m);
    assert.match(attachLog, /socket=\/tmp\/rah-zellij-attach-test/);
    assert.match(attachLog, /args=attach rah-attachtest options --mirror-session true --pane-frames false --show-startup-tips false/);
  } finally {
    rmSync(tmpDir, { force: true, recursive: true });
  }
});

test("rah attach uses provider-native attach for OpenCode native local-server sessions", async () => {
  const attachRequests: unknown[] = [];
  const detachRequests: unknown[] = [];
  const wss = new WebSocketServer({ noServer: true });
  const server = createServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/readyz") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
      return;
    }
    if (req.method === "GET" && req.url === "/api/sessions") {
      writeJson(res, 200, {
        sessions: [
          sessionSummary({
            id: "session-opencode-native",
            provider: "opencode",
            providerSessionId: "opencode-native-1",
            launchSource: "web",
            liveBackend: "native_local_server",
            cwd: "/tmp",
            rootDir: "/tmp",
            runtimeState: "idle",
            runtime: {
              kind: "native_local_server",
              protocolStability: "project_native",
              liveSource: "provider_server",
              tuiRole: "client_view",
              structuredLiveEvents: true,
              tuiContinuity: true,
            },
            runtimeDiagnostics: {
              serverEndpoint: "http://127.0.0.1:49999",
              attachCommand: "opencode attach http://127.0.0.1:49999 --session opencode-native-1",
              attachState: "ready",
              lastEventCursor: "session:opencode-native-1",
            },
            ptyId: "session-opencode-native",
            capabilities: {},
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          }),
        ],
        storedSessions: [],
        recentSessions: [],
        workspaceDirs: [],
      });
      return;
    }
    if (req.method === "POST" && req.url === "/api/sessions/session-opencode-native/attach") {
      attachRequests.push(await readJsonBody(req));
      writeJson(res, 200, {
        session: sessionSummary({
          id: "session-opencode-native",
          provider: "opencode",
          launchSource: "web",
          liveBackend: "native_local_server",
          cwd: "/tmp",
          rootDir: "/tmp",
          runtimeState: "idle",
          ptyId: "session-opencode-native",
          capabilities: {},
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }),
      });
      return;
    }
    if (req.method === "POST" && req.url === "/api/sessions/session-opencode-native/detach") {
      detachRequests.push(await readJsonBody(req));
      writeJson(res, 200, {
        session: sessionSummary({
          id: "session-opencode-native",
          provider: "opencode",
          launchSource: "web",
          liveBackend: "native_local_server",
          cwd: "/tmp",
          rootDir: "/tmp",
          runtimeState: "idle",
          ptyId: "session-opencode-native",
          capabilities: {},
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }),
      });
      return;
    }
    res.writeHead(404);
    res.end("not found");
  });

  const port = await listen(server);
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "rah-cli-opencode-attach-"));
  const fakeBin = path.join(tmpDir, "bin");
  const logPath = path.join(tmpDir, "opencode-attach.log");
  const fakeOpenCode = path.join(fakeBin, "opencode");
  mkdirSync(fakeBin, { recursive: true });
  writeFileSync(
    fakeOpenCode,
    [
      "#!/bin/sh",
      "printf 'cwd=%s\\n' \"$PWD\" > \"$RAH_OPENCODE_ATTACH_LOG\"",
      "printf 'args=%s\\n' \"$*\" >> \"$RAH_OPENCODE_ATTACH_LOG\"",
    ].join("\n"),
  );
  chmodSync(fakeOpenCode, 0o755);

  const child = spawn(
    process.execPath,
    [
      "bin/rah.mjs",
      "attach",
      "session-opencode-native",
      "--daemon-url",
      `http://127.0.0.1:${port}`,
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`,
        RAH_OPENCODE_ATTACH_LOG: logPath,
      },
    },
  );
  let stderr = "";
  child.stderr?.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code) => resolve(code));
  });
  await closeServer(server, wss);

  try {
    assert.equal(exitCode, 0, stderr);
    assert.equal(attachRequests.length, 1);
    assert.equal(detachRequests.length, 1);
    const attachRequest = attachRequests[0] as { client: { id: string }; claimControl?: boolean };
    assert.match(attachRequest.client.id, /^terminal:/);
    assert.equal(attachRequest.claimControl, false);
    assert.deepEqual(detachRequests, [{ clientId: attachRequest.client.id }]);
    const attachLog = readFileSync(logPath, "utf8");
    assert.match(attachLog, /^cwd=\/(?:private\/)?tmp$/m);
    assert.match(attachLog, /args=attach http:\/\/127\.0\.0\.1:49999 --session opencode-native-1/);
  } finally {
    rmSync(tmpDir, { force: true, recursive: true });
  }
});

test("rah attach terminates the managed provider client when the live session is archived", async () => {
  const attachRequests: unknown[] = [];
  const detachRequests: unknown[] = [];
  const wss = new WebSocketServer({ noServer: true });
  const sessionPayload = sessionSummary({
    id: "session-opencode-archive",
    provider: "opencode",
    providerSessionId: "opencode-archive-1",
    launchSource: "web",
    liveBackend: "native_local_server",
    cwd: "/tmp",
    rootDir: "/tmp",
    runtimeState: "idle",
    runtime: {
      kind: "native_local_server",
      protocolStability: "project_native",
      liveSource: "provider_server",
      tuiRole: "client_view",
      structuredLiveEvents: true,
      tuiContinuity: true,
    },
    runtimeDiagnostics: {
      serverEndpoint: "http://127.0.0.1:49998",
      attachCommand: "opencode attach http://127.0.0.1:49998 --session opencode-archive-1",
      attachState: "ready",
      lastEventCursor: "session:opencode-archive-1",
    },
    ptyId: "session-opencode-archive",
    capabilities: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  const server = createServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/readyz") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
      return;
    }
    if (req.method === "GET" && req.url === "/api/sessions") {
      writeJson(res, 200, {
        sessions: attachRequests.length > 0 ? [] : [sessionPayload],
        storedSessions: [],
        recentSessions: [],
        workspaceDirs: [],
      });
      return;
    }
    if (req.method === "POST" && req.url === "/api/sessions/session-opencode-archive/attach") {
      attachRequests.push(await readJsonBody(req));
      writeJson(res, 200, { session: sessionPayload });
      return;
    }
    if (req.method === "POST" && req.url === "/api/sessions/session-opencode-archive/detach") {
      detachRequests.push(await readJsonBody(req));
      writeJson(res, 200, { session: sessionPayload });
      return;
    }
    res.writeHead(404);
    res.end("not found");
  });

  const port = await listen(server);
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "rah-cli-opencode-archive-"));
  const fakeBin = path.join(tmpDir, "bin");
  const logPath = path.join(tmpDir, "opencode-archive.log");
  const fakeOpenCode = path.join(fakeBin, "opencode");
  mkdirSync(fakeBin, { recursive: true });
  writeFileSync(
    fakeOpenCode,
    [
      "#!/bin/sh",
      "printf 'start args=%s\\n' \"$*\" >> \"$RAH_OPENCODE_ATTACH_LOG\"",
      "trap 'printf signal=HUP\\n >> \"$RAH_OPENCODE_ATTACH_LOG\"; exit 0' HUP",
      "trap 'printf signal=TERM\\n >> \"$RAH_OPENCODE_ATTACH_LOG\"; exit 0' TERM",
      "while true; do sleep 1; done",
    ].join("\n"),
  );
  chmodSync(fakeOpenCode, 0o755);

  const child = spawn(
    process.execPath,
    [
      "bin/rah.mjs",
      "attach",
      "session-opencode-archive",
      "--daemon-url",
      `http://127.0.0.1:${port}`,
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`,
        RAH_OPENCODE_ATTACH_LOG: logPath,
      },
    },
  );
  let stderr = "";
  child.stderr?.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("timed out waiting for managed attach to exit"));
    }, 4_000);
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("exit", (code) => {
      clearTimeout(timeout);
      resolve(code);
    });
  });
  await closeServer(server, wss);

  try {
    assert.equal(exitCode, 0, stderr);
    assert.equal(attachRequests.length, 1);
    assert.equal(detachRequests.length, 1);
    const attachRequest = attachRequests[0] as { client: { id: string }; claimControl?: boolean };
    assert.deepEqual(detachRequests, [{ clientId: attachRequest.client.id }]);
    const attachLog = readFileSync(logPath, "utf8");
    assert.match(attachLog, /start args=attach http:\/\/127\.0\.0\.1:49998 --session opencode-archive-1/);
    assert.equal((attachLog.match(/start args=/g) ?? []).length, 1);
    assert.match(attachLog, /signal=HUP/);
  } finally {
    rmSync(tmpDir, { force: true, recursive: true });
  }
});

test("rah provider attach resolves a live session by provider session id", async () => {
  const attachRequests: unknown[] = [];
  const detachRequests: unknown[] = [];
  const wss = new WebSocketServer({ noServer: true });
  const server = createServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/readyz") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
      return;
    }
    if (req.method === "GET" && req.url === "/api/sessions") {
      writeJson(res, 200, {
        sessions: [
          sessionSummary({
            id: "rah-live-opencode-1",
            provider: "opencode",
            providerSessionId: "opencode-provider-1",
            launchSource: "web",
            liveBackend: "native_local_server",
            cwd: "/tmp",
            rootDir: "/tmp",
            runtimeState: "idle",
            runtimeDiagnostics: {
              serverEndpoint: "http://127.0.0.1:49997",
              attachCommand: "opencode attach http://127.0.0.1:49997 --session opencode-provider-1",
              attachState: "ready",
              lastEventCursor: "session:opencode-provider-1",
            },
            ptyId: "rah-live-opencode-1",
            capabilities: {},
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          }),
        ],
        storedSessions: [],
        recentSessions: [],
        workspaceDirs: [],
      });
      return;
    }
    if (req.method === "POST" && req.url === "/api/sessions/rah-live-opencode-1/attach") {
      attachRequests.push(await readJsonBody(req));
      writeJson(res, 200, { session: sessionSummary({ id: "rah-live-opencode-1" }) });
      return;
    }
    if (req.method === "POST" && req.url === "/api/sessions/rah-live-opencode-1/detach") {
      detachRequests.push(await readJsonBody(req));
      writeJson(res, 200, { session: sessionSummary({ id: "rah-live-opencode-1" }) });
      return;
    }
    res.writeHead(404);
    res.end("not found");
  });

  const port = await listen(server);
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "rah-cli-provider-attach-"));
  const fakeBin = path.join(tmpDir, "bin");
  const logPath = path.join(tmpDir, "opencode-provider-attach.log");
  const fakeOpenCode = path.join(fakeBin, "opencode");
  mkdirSync(fakeBin, { recursive: true });
  writeFileSync(
    fakeOpenCode,
    [
      "#!/bin/sh",
      "printf 'args=%s\\n' \"$*\" > \"$RAH_OPENCODE_ATTACH_LOG\"",
    ].join("\n"),
  );
  chmodSync(fakeOpenCode, 0o755);

  const child = spawn(
    process.execPath,
    [
      "bin/rah.mjs",
      "opencode",
      "attach",
      "opencode-provider-1",
      "--daemon-url",
      `http://127.0.0.1:${port}`,
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`,
        RAH_OPENCODE_ATTACH_LOG: logPath,
      },
    },
  );
  let stderr = "";
  child.stderr?.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code) => resolve(code));
  });
  await closeServer(server, wss);

  try {
    assert.equal(exitCode, 0, stderr);
    assert.equal(attachRequests.length, 1);
    assert.equal(detachRequests.length, 1);
    const attachRequest = attachRequests[0] as { client: { id: string }; claimControl?: boolean };
    assert.deepEqual(detachRequests, [{ clientId: attachRequest.client.id }]);
    const attachLog = readFileSync(logPath, "utf8");
    assert.match(attachLog, /args=attach http:\/\/127\.0\.0\.1:49997 --session opencode-provider-1/);
  } finally {
    rmSync(tmpDir, { force: true, recursive: true });
  }
});

test("rah provider attach reports non-live provider sessions as resumable", async () => {
  const wss = new WebSocketServer({ noServer: true });
  const server = createServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/readyz") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
      return;
    }
    if (req.method === "GET" && req.url === "/api/sessions") {
      writeJson(res, 200, {
        sessions: [
          sessionSummary({
            id: "session-opencode-native",
            provider: "opencode",
            providerSessionId: "opencode-native-1",
            launchSource: "web",
            liveBackend: "native_local_server",
            cwd: "/tmp",
            rootDir: "/tmp",
            runtimeState: "idle",
            ptyId: "session-opencode-native",
            capabilities: {},
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          }),
        ],
        storedSessions: [],
        recentSessions: [],
        workspaceDirs: [],
      });
      return;
    }
    res.writeHead(404);
    res.end("not found");
  });

  const port = await listen(server);
  const child = spawn(
    process.execPath,
    [
      "bin/rah.mjs",
      "codex",
      "attach",
      "codex-provider-missing",
      "--daemon-url",
      `http://127.0.0.1:${port}`,
    ],
    {
      cwd: process.cwd(),
    },
  );
  let stderr = "";
  child.stderr?.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code) => resolve(code));
  });
  await closeServer(server, wss);

  assert.equal(exitCode, 1);
  assert.match(
    stderr,
    /No live codex session found for provider session codex-provider-missing\. Use `rah codex resume codex-provider-missing` to start it\./,
  );
});

test("rah provider command preserves UTF-8 input split across stdin chunks", async () => {
  const startRequests: unknown[] = [];
  const ptyInputs: string[] = [];
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
        session: sessionSummary({
          id: "session-utf8",
          provider: "codex",
          launchSource: "terminal",
          liveBackend: "native_tui",
          cwd: "/tmp",
          rootDir: "/tmp",
          runtimeState: "idle",
          ptyId: "session-utf8",
          nativeTui: {
            terminalId: "session-utf8",
            viewAvailable: true,
            promptState: "prompt_clean",
          },
          capabilities: {},
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }),
      });
      return;
    }
    if (req.method === "POST" && req.url === "/api/sessions/session-utf8/detach") {
      await readJsonBody(req);
      writeJson(res, 200, {
        session: sessionSummary({
          id: "session-utf8",
          provider: "codex",
          launchSource: "terminal",
          liveBackend: "native_tui",
          cwd: "/tmp",
          rootDir: "/tmp",
          runtimeState: "stopped",
          ptyId: "session-utf8",
          capabilities: {},
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }),
      });
      return;
    }
    res.writeHead(404);
    res.end("not found");
  });
  server.on("upgrade", (req, socket, head) => {
    if (req.url?.startsWith("/api/pty/session-utf8")) {
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws, req);
      });
      return;
    }
    socket.destroy();
  });
  wss.on("connection", (ws) => {
    ws.on("message", (raw) => {
      const parsed = JSON.parse(raw.toString("utf8"));
      if (parsed.type === "pty.input") {
        ptyInputs.push(parsed.data);
        ws.send(JSON.stringify({
          type: "pty.exited",
          sessionId: "session-utf8",
          exitCode: 0,
        }));
      }
    });
    ws.send(JSON.stringify({
      type: "pty.replay",
      sessionId: "session-utf8",
      chunks: ["ready\n"],
      status: "open",
    }));
  });

  const port = await listen(server);
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "rah-cli-pty-utf8-"));
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
      env: { ...process.env },
    },
  );
  let stderr = "";
  child.stderr?.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });
  const bytes = Buffer.from("你");
  setTimeout(() => child.stdin?.write(bytes.subarray(0, 1)), 50);
  setTimeout(() => child.stdin?.write(bytes.subarray(1)), 80);
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code) => resolve(code));
  });
  await closeServer(server, wss);

  assert.equal(exitCode, 0, stderr);
  assert.equal(startRequests.length, 1);
  assert.deepEqual(ptyInputs, ["你"]);
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
        session: sessionSummary({
          id: "session-resume-1",
          provider: "codex",
          providerSessionId: "provider-session-1",
          launchSource: "terminal",
          liveBackend: "native_tui",
          cwd: "/tmp",
          rootDir: "/tmp",
          runtimeState: "idle",
          ptyId: "session-resume-1",
          nativeTui: {
            terminalId: "session-resume-1",
            viewAvailable: true,
            promptState: "prompt_clean",
          },
          capabilities: {},
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }),
      });
      return;
    }
    if (req.method === "POST" && req.url === "/api/sessions/session-resume-1/detach") {
      detachRequests.push(await readJsonBody(req));
      writeJson(res, 200, {
        session: sessionSummary({
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
        }),
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
      "--mux",
      "native",
      "--daemon-url",
      `http://127.0.0.1:${port}`,
      "--cwd",
      tmpDir,
    ],
    {
      cwd: process.cwd(),
      env: { ...process.env },
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

test("rah unknown providers fail as unsupported commands", async () => {
  const child = spawn(
    process.execPath,
    [
      "bin/rah.mjs",
      "unknown-provider",
      "--daemon-url",
      "http://127.0.0.1:9",
    ],
    {
      cwd: process.cwd(),
      env: { ...process.env },
    },
  );
  let stderr = "";
  child.stderr?.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code) => resolve(code));
  });

  assert.equal(exitCode, 1);
  assert.match(stderr, /Unsupported provider: unknown-provider/);
});

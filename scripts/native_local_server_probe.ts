import { execFile, execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path, { dirname } from "node:path";
import readline from "node:readline";
import { WebSocket } from "ws";
import { createCodexAppServerClient } from "../packages/runtime-daemon/src/codex-app-server-client";
import { runtimeDiagnosticsForOpenCodeServer } from "../packages/runtime-daemon/src/provider-control/opencode-live-client";
import {
  abortOpenCodeSession,
  archiveOpenCodeSession,
  createOpenCodeSession,
  getOpenCodeMessages,
  getOpenCodeSession,
  promptOpenCodeSessionAsync,
  resolveOpenCodeBinary,
  startOpenCodeServer,
  stopOpenCodeServer,
  subscribeOpenCodeEvents,
} from "../packages/runtime-daemon/src/opencode-api";
import { resolveConfiguredBinary } from "../packages/runtime-daemon/src/provider-binary-utils";

type ProbeProvider = "codex" | "opencode";
type ProbeStatus = "pass" | "fail" | "unverified" | "unsupported";

type CapabilityStatus = {
  structuredLiveEvents: ProbeStatus;
  structuredControl: ProbeStatus;
  historyBackfill: ProbeStatus;
  tuiClientContinuity: ProbeStatus;
  crossClientSync: ProbeStatus;
  prelaunchConfig: ProbeStatus;
  runtimeConfig: ProbeStatus;
  interrupt: ProbeStatus;
  archiveLifecycle: ProbeStatus;
};

type ProviderProbeResult = {
  provider: ProbeProvider;
  ok: boolean;
  status: ProbeStatus;
  version?: string | null;
  runtimeKind: "native_local_server";
  diagnostics?: Record<string, unknown>;
  capability: CapabilityStatus;
  checks: Array<{
    name: string;
    status: ProbeStatus;
    detail?: string;
  }>;
  error?: string;
};

type ProbeReport = {
  ok: boolean;
  generatedAt: string;
  rah: {
    branch: string | null;
    commit: string | null;
    dirty: boolean | null;
    changedFiles: number | null;
  };
  providers: ProviderProbeResult[];
};

const SELECTABLE_PROVIDERS: ProbeProvider[] = ["codex", "opencode"];
const DEFAULT_PROVIDERS: ProbeProvider[] = ["codex", "opencode"];
const TIMEOUT_MS = Number(process.env.RAH_NATIVE_LOCAL_SERVER_PROBE_TIMEOUT_MS ?? 15_000);
const ALLOW_FAILURES = process.env.RAH_NATIVE_LOCAL_SERVER_PROBE_ALLOW_FAILURES === "1";
const CREATE_CODEX_THREAD = process.env.RAH_NATIVE_LOCAL_SERVER_PROBE_CREATE_CODEX_THREAD === "1";
const CODEX_WEBSOCKET_PROBE = process.env.RAH_NATIVE_LOCAL_SERVER_PROBE_CODEX_WS === "1";
const CODEX_REMOTE_TUI_PROBE = process.env.RAH_NATIVE_LOCAL_SERVER_PROBE_CODEX_REMOTE_TUI === "1";
const REAL_TURN_PROBE = process.env.RAH_NATIVE_LOCAL_SERVER_PROBE_REAL_TURN === "1";
const INTERRUPT_PROBE = process.env.RAH_NATIVE_LOCAL_SERVER_PROBE_INTERRUPT === "1";
const OPENCODE_ATTACH_PROBE = process.env.RAH_NATIVE_LOCAL_SERVER_PROBE_OPENCODE_ATTACH === "1";
const OPENCODE_CROSS_CLIENT_PROBE = process.env.RAH_NATIVE_LOCAL_SERVER_PROBE_OPENCODE_CROSS_CLIENT === "1";
const OUTPUT_PATH = process.env.RAH_NATIVE_LOCAL_SERVER_PROBE_OUTPUT?.trim() || null;
const WORKSPACE_ROOT =
  process.env.RAH_NATIVE_LOCAL_SERVER_PROBE_WORKSPACE_ROOT?.trim() ||
  path.join(process.cwd(), "test-results", "native-local-server-probe-workspaces");

function selectedProviders(): ProbeProvider[] {
  const raw = process.env.RAH_NATIVE_LOCAL_SERVER_PROBE_PROVIDERS?.trim();
  if (!raw) {
    return DEFAULT_PROVIDERS;
  }
  if (raw === "none") {
    return [];
  }
  const selected = raw
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  const unknown = selected.filter(
    (provider): provider is string => !SELECTABLE_PROVIDERS.includes(provider as ProbeProvider),
  );
  if (unknown.length > 0) {
    throw new Error(`Unknown native local-server probe provider(s): ${unknown.join(", ")}`);
  }
  return selected as ProbeProvider[];
}

function readGitField(args: string[]): string | null {
  try {
    return execFileSync("git", args, {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

function readRahMetadata(): ProbeReport["rah"] {
  const status = readGitField(["status", "--short"]);
  return {
    branch: readGitField(["rev-parse", "--abbrev-ref", "HEAD"]),
    commit: readGitField(["rev-parse", "--short", "HEAD"]),
    dirty: status === null ? null : status.length > 0,
    changedFiles: status === null || status.length === 0 ? 0 : status.split(/\r?\n/).length,
  };
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      timer.unref?.();
    }),
  ]).finally(() => {
    if (timer) {
      clearTimeout(timer);
    }
  });
}

async function waitUntil(
  label: string,
  predicate: () => boolean | Promise<boolean>,
  options: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
  const intervalMs = options.intervalMs ?? 250;
  const started = Date.now();
  let lastError: unknown;
  while (Date.now() - started < timeoutMs) {
    try {
      if (await predicate()) {
        return;
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(
    `${label} timed out after ${timeoutMs}ms${lastError instanceof Error ? `: ${lastError.message}` : ""}`,
  );
}

function previewError(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error);
  return value.length <= 1_000 ? value : `${value.slice(0, 1_000)}...`;
}

function writeReport(reportPath: string | null, report: ProbeReport): void {
  const text = `${JSON.stringify(report, null, 2)}\n`;
  if (reportPath) {
    mkdirSync(dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, text, "utf8");
  }
  process.stdout.write(text);
}

function commandVersion(binary: string, args: string[] = ["--version"]): Promise<string | null> {
  return new Promise((resolve) => {
    const child = execFile(binary, args, { timeout: TIMEOUT_MS, maxBuffer: 512 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        resolve(null);
        return;
      }
      resolve(`${stdout}${stderr}`.trim() || null);
    });
    child.stdin?.destroy();
  });
}

type CodexRpcNotification = { method: string; params?: unknown };
type CodexRpcRequest = { id: number | string; method: string; params?: unknown };

type CodexRpcClientLike = {
  processId?: number;
  endpoint?: string;
  setNotificationHandler(handler: (notification: CodexRpcNotification) => void): void;
  setRequestHandler(handler: (request: CodexRpcRequest) => Promise<unknown> | unknown): void;
  request(method: string, params?: unknown, timeoutMs?: number): Promise<unknown>;
  notify(method: string, params?: unknown): void;
  dispose(): Promise<void>;
};

function createCodexInitializeParams() {
  return {
    clientInfo: {
      name: "rah",
      title: "rah",
      version: "0.0.0",
    },
    capabilities: {
      experimentalApi: true,
    },
  };
}

class CodexWebSocketJsonRpcClient implements CodexRpcClientLike {
  private pending = new Map<string, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  private nextId = 1;
  private notificationHandler: ((notification: CodexRpcNotification) => void) | null = null;
  private requestHandler: ((request: CodexRpcRequest) => Promise<unknown> | unknown) | null = null;
  private disposed = false;

  constructor(
    private readonly socket: WebSocket,
    private readonly child: ChildProcessWithoutNullStreams,
    readonly endpoint: string,
  ) {
    socket.on("message", (data) => {
      void this.handleMessage(data.toString());
    });
    socket.on("close", () => {
      this.disposePending(new Error("Codex websocket app-server disconnected"));
    });
    socket.on("error", (error) => {
      this.disposePending(error instanceof Error ? error : new Error(String(error)));
    });
    child.on("exit", () => {
      this.disposePending(new Error("Codex websocket app-server exited"));
    });
    child.on("error", (error) => {
      this.disposePending(error instanceof Error ? error : new Error(String(error)));
    });
  }

  get processId(): number | undefined {
    return this.child.pid;
  }

  setNotificationHandler(handler: (notification: CodexRpcNotification) => void): void {
    this.notificationHandler = handler;
  }

  setRequestHandler(handler: (request: CodexRpcRequest) => Promise<unknown> | unknown): void {
    this.requestHandler = handler;
  }

  request(method: string, params?: unknown, timeoutMs = TIMEOUT_MS): Promise<unknown> {
    if (this.disposed || this.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("Codex websocket JSON-RPC client is closed"));
    }
    const id = this.nextId++;
    const key = String(id);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(key);
        reject(new Error(`Codex websocket app-server request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(key, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }), (error) => {
        if (error) {
          this.rejectPending(key, error instanceof Error ? error : new Error(String(error)));
        }
      });
    });
  }

  notify(method: string, params?: unknown): void {
    if (this.disposed || this.socket.readyState !== WebSocket.OPEN) {
      return;
    }
    this.socket.send(JSON.stringify({ method, params }));
  }

  async dispose(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.disposePending(new Error("Codex websocket JSON-RPC client is closed"));
    await new Promise<void>((resolve) => {
      if (this.socket.readyState === WebSocket.CLOSED) {
        resolve();
        return;
      }
      const timer = setTimeout(resolve, 500);
      timer.unref?.();
      this.socket.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
      this.socket.close();
    });
    if (this.child.exitCode !== null || this.child.signalCode !== null) {
      return;
    }
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) {
          return;
        }
        settled = true;
        this.child.off("exit", finish);
        resolve();
      };
      this.child.once("exit", finish);
      try {
        if (!this.child.kill("SIGTERM")) {
          finish();
          return;
        }
      } catch {
        finish();
        return;
      }
      const sigkillTimer = setTimeout(() => {
        if (this.child.exitCode === null && this.child.signalCode === null) {
          try {
            this.child.kill("SIGKILL");
          } catch {
            // Ignore best-effort cleanup errors.
          }
        }
        finish();
      }, 750);
      sigkillTimer.unref?.();
    });
  }

  private disposePending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private rejectPending(key: string, error: Error): void {
    const pending = this.pending.get(key);
    if (!pending) {
      return;
    }
    clearTimeout(pending.timer);
    this.pending.delete(key);
    pending.reject(error);
  }

  private async handleMessage(line: string): Promise<void> {
    if (!line.trim()) {
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return;
    }
    const message = parsed as Record<string, unknown>;
    if (
      (typeof message.id === "number" || typeof message.id === "string") &&
      (message.result !== undefined || message.error !== undefined)
    ) {
      const key = String(message.id);
      const pending = this.pending.get(key);
      if (!pending) {
        return;
      }
      clearTimeout(pending.timer);
      this.pending.delete(key);
      if (message.error && typeof message.error === "object" && !Array.isArray(message.error)) {
        const error = message.error as { message?: unknown };
        pending.reject(new Error(typeof error.message === "string" ? error.message : "JSON-RPC error"));
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if ((typeof message.id === "number" || typeof message.id === "string") && typeof message.method === "string") {
      const request: CodexRpcRequest = {
        id: message.id,
        method: message.method,
        ...(message.params !== undefined ? { params: message.params } : {}),
      };
      try {
        const result = this.requestHandler ? await this.requestHandler(request) : {};
        this.socket.send(JSON.stringify({ id: request.id, result }));
      } catch (error) {
        this.socket.send(
          JSON.stringify({
            id: request.id,
            error: { message: error instanceof Error ? error.message : String(error) },
          }),
        );
      }
      return;
    }
    if (typeof message.method === "string") {
      this.notificationHandler?.({
        method: message.method,
        ...(message.params !== undefined ? { params: message.params } : {}),
      });
    }
  }
}

async function createCodexWebSocketAppServerClient(binary: string): Promise<CodexWebSocketJsonRpcClient> {
  const child = spawn(binary, ["app-server", "--listen", "ws://127.0.0.1:0"], {
    stdio: ["ignore", "ignore", "pipe"],
    env: process.env,
  });
  const stderr = readline.createInterface({ input: child.stderr });
  const stderrLines: string[] = [];
  const endpoint = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Codex websocket app-server did not report an endpoint within ${TIMEOUT_MS}ms`));
    }, TIMEOUT_MS);
    timer.unref?.();
    const cleanup = () => {
      clearTimeout(timer);
      stderr.off("line", onLine);
      child.off("exit", onExit);
      child.off("error", onError);
    };
    const onLine = (line: string) => {
      if (stderrLines.join("\n").length < 10_000) {
        stderrLines.push(line);
      }
      const match = line.match(/ws:\/\/[^\s]+/);
      if (!match) {
        return;
      }
      cleanup();
      resolve(match[0]);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      reject(
        new Error(
          `Codex websocket app-server exited before endpoint: code=${code ?? "null"} signal=${signal ?? "null"} stderr=${stderrLines.join(" ").slice(0, 1_000)}`,
        ),
      );
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    stderr.on("line", onLine);
    child.once("exit", onExit);
    child.once("error", onError);
  });

  const socket = await new Promise<WebSocket>((resolve, reject) => {
    const ws = new WebSocket(endpoint);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error(`Codex websocket connect timed out: ${endpoint}`));
    }, TIMEOUT_MS);
    timer.unref?.();
    ws.once("open", () => {
      clearTimeout(timer);
      resolve(ws);
    });
    ws.once("error", (error) => {
      clearTimeout(timer);
      reject(error instanceof Error ? error : new Error(String(error)));
    });
  });

  const client = new CodexWebSocketJsonRpcClient(socket, child, endpoint);
  try {
    await client.request("initialize", createCodexInitializeParams(), TIMEOUT_MS);
    client.notify("initialized", {});
    return client;
  } catch (error) {
    await client.dispose().catch(() => undefined);
    throw error;
  }
}

function resolveSystemBinary(name: string): string | null {
  try {
    return execFileSync("which", [name], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim() || null;
  } catch {
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type OpenCodeAttachClientHandle = {
  write(input: string): void;
  output(): string;
  outputPreview(): string;
  exited(): boolean;
  close(): Promise<void>;
};

async function startOpenCodeAttachClient(args: {
  binary: string;
  cwd: string;
  serverUrl: string;
  providerSessionId: string;
}): Promise<
  | { status: "pass"; detail: string; handle: OpenCodeAttachClientHandle }
  | { status: Exclude<ProbeStatus, "pass">; detail: string }
> {
  const pythonBinary = resolveSystemBinary(process.env.RAH_PYTHON_BINARY?.trim() || "python3");
  if (!pythonBinary) {
    return {
      status: "unverified",
      detail: "System `python3` binary is unavailable; cannot allocate a PTY for opencode attach.",
    };
  }

  const ptyBridge = `
import os
import pty
import selectors
import signal
import fcntl
import struct
import sys
import time
import termios

argv = sys.argv[1:]
pid, fd = pty.fork()
if pid == 0:
    os.execvpe(argv[0], argv, os.environ)

try:
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 32, 120, 0, 0))
except Exception:
    pass

os.set_blocking(fd, False)
os.set_blocking(sys.stdin.fileno(), False)
selector = selectors.DefaultSelector()
selector.register(fd, selectors.EVENT_READ, "pty")
selector.register(sys.stdin, selectors.EVENT_READ, "stdin")

probe_buffer = b""

def handle_terminal_queries(data):
    global probe_buffer
    probe_buffer = (probe_buffer + data)[-4096:]
    responses = []
    if b"\\x1b[6n" in probe_buffer:
        responses.append(b"\\x1b[1;1R")
    if b"\\x1b[c" in probe_buffer:
        responses.append(b"\\x1b[?1;2c")
    if b"\\x1b[?u" in probe_buffer:
        responses.append(b"\\x1b[?0u")
    if b"\\x1b]10;?\\x07" in probe_buffer or b"\\x1b]10;?\\x1b\\\\" in probe_buffer:
        responses.append(b"\\x1b]10;rgb:ffff/ffff/ffff\\x07")
    if b"\\x1b]11;?\\x07" in probe_buffer or b"\\x1b]11;?\\x1b\\\\" in probe_buffer:
        responses.append(b"\\x1b]11;rgb:0000/0000/0000\\x07")
    if b"\\x1b[14t" in probe_buffer:
        responses.append(b"\\x1b[4;900;1200t")
    for response in responses:
        try:
            os.write(fd, response)
        except OSError:
            pass
    if responses:
        probe_buffer = b""

def stop_child():
    try:
        os.kill(pid, signal.SIGTERM)
    except ProcessLookupError:
        return
    deadline = time.time() + 0.75
    while time.time() < deadline:
        try:
            done, _ = os.waitpid(pid, os.WNOHANG)
            if done:
                return
        except ChildProcessError:
            return
        time.sleep(0.05)
    try:
        os.kill(pid, signal.SIGKILL)
    except ProcessLookupError:
        pass

try:
    while True:
        try:
            done, status = os.waitpid(pid, os.WNOHANG)
            if done:
                sys.exit(os.waitstatus_to_exitcode(status))
        except ChildProcessError:
            sys.exit(0)
        for key, _ in selector.select(0.1):
            if key.data == "pty":
                try:
                    data = os.read(fd, 8192)
                except OSError:
                    data = b""
                if not data:
                    sys.exit(0)
                os.write(sys.stdout.fileno(), data)
                handle_terminal_queries(data)
            elif key.data == "stdin":
                try:
                    data = os.read(sys.stdin.fileno(), 8192)
                except BlockingIOError:
                    continue
                if data:
                    os.write(fd, data)
finally:
    stop_child()
`;

  return await new Promise((resolve) => {
    const output: string[] = [];
    let exited = false;
    let exitSummary: string | null = null;
    const child = spawn(
      pythonBinary,
      [
        "-c",
        ptyBridge,
        args.binary,
        "attach",
        args.serverUrl,
        "--session",
        args.providerSessionId,
        "--dir",
        args.cwd,
      ],
      {
        cwd: args.cwd,
        env: process.env,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    const joinedOutput = () => output.join("");
    const collect = (chunk: Buffer) => {
      if (joinedOutput().length < 24_000) {
        output.push(chunk.toString("utf8"));
      }
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);
    const timer = setTimeout(() => {
      if (exited) {
        return;
      }
      const handle: OpenCodeAttachClientHandle = {
        write(input: string) {
          child.stdin?.write(input);
        },
        output: joinedOutput,
        outputPreview() {
          return joinedOutput().replace(/\s+/g, " ").trim().slice(0, 1_000);
        },
        exited() {
          return exited;
        },
        async close() {
          if (exited) {
            return;
          }
          child.kill("SIGTERM");
          await Promise.race([
            new Promise<void>((done) => child.once("exit", () => done())),
            sleep(750).then(() => {
              if (!exited) {
                child.kill("SIGKILL");
              }
            }),
          ]);
        },
      };
      resolve({
        status: "pass",
        detail: `attach client stayed alive for ${Math.min(1_500, TIMEOUT_MS)}ms`,
        handle,
      });
    }, Math.min(1_500, TIMEOUT_MS));
    timer.unref?.();
    child.on("error", (error) => {
      exited = true;
      clearTimeout(timer);
      resolve({ status: "fail", detail: previewError(error) });
    });
    child.on("exit", (code, signal) => {
      exited = true;
      clearTimeout(timer);
      const preview = joinedOutput().replace(/\s+/g, " ").trim();
      exitSummary = `code=${code ?? "null"} signal=${signal ?? "null"}${
        preview ? ` output=${preview.slice(0, 500)}` : ""
      }`;
      resolve({
        status: "fail",
        detail: `attach client exited early ${exitSummary}`,
      });
    });
  });
}

type CodexRemoteTuiClientHandle = {
  write(input: string): void;
  output(): string;
  outputPreview(): string;
  exited(): boolean;
  close(): Promise<void>;
};

async function startCodexRemoteTuiClient(args: {
  binary: string;
  cwd: string;
  serverUrl: string;
  threadId: string;
}): Promise<
  | { status: "pass"; detail: string; handle: CodexRemoteTuiClientHandle }
  | { status: Exclude<ProbeStatus, "pass">; detail: string }
> {
  const pythonBinary = resolveSystemBinary(process.env.RAH_PYTHON_BINARY?.trim() || "python3");
  if (!pythonBinary) {
    return {
      status: "unverified",
      detail: "System `python3` binary is unavailable; cannot allocate a PTY for codex --remote.",
    };
  }

  const ptyBridge = `
import os
import pty
import selectors
import signal
import fcntl
import struct
import sys
import time
import termios

argv = sys.argv[1:]
pid, fd = pty.fork()
if pid == 0:
    os.execvpe(argv[0], argv, os.environ)

try:
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 32, 120, 0, 0))
except Exception:
    pass

os.set_blocking(fd, False)
os.set_blocking(sys.stdin.fileno(), False)
selector = selectors.DefaultSelector()
selector.register(fd, selectors.EVENT_READ, "pty")
selector.register(sys.stdin, selectors.EVENT_READ, "stdin")

probe_buffer = b""

def handle_terminal_queries(data):
    global probe_buffer
    probe_buffer = (probe_buffer + data)[-4096:]
    responses = []
    if b"\\x1b[6n" in probe_buffer:
        responses.append(b"\\x1b[1;1R")
    if b"\\x1b[c" in probe_buffer:
        responses.append(b"\\x1b[?1;2c")
    if b"\\x1b[?u" in probe_buffer:
        responses.append(b"\\x1b[?0u")
    if b"\\x1b]10;?\\x07" in probe_buffer or b"\\x1b]10;?\\x1b\\\\" in probe_buffer:
        responses.append(b"\\x1b]10;rgb:ffff/ffff/ffff\\x07")
    if b"\\x1b]11;?\\x07" in probe_buffer or b"\\x1b]11;?\\x1b\\\\" in probe_buffer:
        responses.append(b"\\x1b]11;rgb:0000/0000/0000\\x07")
    if b"\\x1b[14t" in probe_buffer:
        responses.append(b"\\x1b[4;900;1200t")
    for response in responses:
        try:
            os.write(fd, response)
        except OSError:
            pass
    if responses:
        probe_buffer = b""

def stop_child():
    try:
        os.kill(pid, signal.SIGTERM)
    except ProcessLookupError:
        return
    deadline = time.time() + 0.75
    while time.time() < deadline:
        try:
            done, _ = os.waitpid(pid, os.WNOHANG)
            if done:
                return
        except ChildProcessError:
            return
        time.sleep(0.05)
    try:
        os.kill(pid, signal.SIGKILL)
    except ProcessLookupError:
        pass

try:
    while True:
        try:
            done, status = os.waitpid(pid, os.WNOHANG)
            if done:
                sys.exit(os.waitstatus_to_exitcode(status))
        except ChildProcessError:
            sys.exit(0)
        for key, _ in selector.select(0.1):
            if key.data == "pty":
                try:
                    data = os.read(fd, 8192)
                except OSError:
                    data = b""
                if not data:
                    sys.exit(0)
                os.write(sys.stdout.fileno(), data)
                handle_terminal_queries(data)
            elif key.data == "stdin":
                try:
                    data = os.read(sys.stdin.fileno(), 8192)
                except BlockingIOError:
                    continue
                if data:
                    os.write(fd, data)
finally:
    stop_child()
`;

  return await new Promise((resolve) => {
    const output: string[] = [];
    let exited = false;
    const child = spawn(
      pythonBinary,
      [
        "-c",
        ptyBridge,
        args.binary,
        "--remote",
        args.serverUrl,
        "resume",
        args.threadId,
      ],
      {
        cwd: args.cwd,
        env: process.env,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    const joinedOutput = () => output.join("");
    const collect = (chunk: Buffer) => {
      if (joinedOutput().length < 24_000) {
        output.push(chunk.toString("utf8"));
      }
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);
    const timer = setTimeout(() => {
      if (exited) {
        return;
      }
      const handle: CodexRemoteTuiClientHandle = {
        write(input: string) {
          child.stdin?.write(input);
        },
        output: joinedOutput,
        outputPreview() {
          return joinedOutput().replace(/\s+/g, " ").trim().slice(0, 1_000);
        },
        exited() {
          return exited;
        },
        async close() {
          if (exited) {
            return;
          }
          child.kill("SIGTERM");
          await Promise.race([
            new Promise<void>((done) => child.once("exit", () => done())),
            sleep(750).then(() => {
              if (!exited) {
                child.kill("SIGKILL");
              }
            }),
          ]);
        },
      };
      resolve({
        status: "pass",
        detail: `remote TUI stayed alive for ${Math.min(1_500, TIMEOUT_MS)}ms`,
        handle,
      });
    }, Math.min(1_500, TIMEOUT_MS));
    timer.unref?.();
    child.on("error", (error) => {
      exited = true;
      clearTimeout(timer);
      resolve({ status: "fail", detail: previewError(error) });
    });
    child.on("exit", (code, signal) => {
      exited = true;
      clearTimeout(timer);
      const preview = joinedOutput().replace(/\s+/g, " ").trim();
      resolve({
        status: "fail",
        detail: `remote TUI exited early code=${code ?? "null"} signal=${signal ?? "null"}${
          preview ? ` output=${preview.slice(0, 500)}` : ""
        }`,
      });
    });
  });
}

async function probeOpenCodeAttachClient(args: {
  binary: string;
  cwd: string;
  serverUrl: string;
  providerSessionId: string;
}): Promise<{ status: ProbeStatus; detail: string }> {
  const started = await startOpenCodeAttachClient(args);
  if (started.status !== "pass") {
    return started;
  }
  await started.handle.close();
  return { status: "pass", detail: started.detail };
}

function baseCapability(overrides: Partial<CapabilityStatus>): CapabilityStatus {
  return {
    structuredLiveEvents: "unverified",
    structuredControl: "unverified",
    historyBackfill: "unverified",
    tuiClientContinuity: "unverified",
    crossClientSync: "unverified",
    prelaunchConfig: "unverified",
    runtimeConfig: "unverified",
    interrupt: "unverified",
    archiveLifecycle: "unverified",
    ...overrides,
  };
}

function statusFromChecks(checks: ProviderProbeResult["checks"]): ProbeStatus {
  return checks.some((check) => check.status === "fail") ? "fail" : "pass";
}

function openCodeMessagesContainText(
  messages: Awaited<ReturnType<typeof getOpenCodeMessages>>,
  text: string,
): boolean {
  return messages.some((message) =>
    message.parts.some((part) => {
      if ((part.type === "text" || part.type === "reasoning") && typeof part.text === "string") {
        return part.text.includes(text);
      }
      if (part.type === "tool") {
        const output = part.state.status === "completed" ? part.state.output : undefined;
        return typeof output === "string" && output.includes(text);
      }
      return false;
    }),
  );
}

function unknownContainsText(value: unknown, text: string): boolean {
  if (typeof value === "string") {
    return value.includes(text);
  }
  if (!value || typeof value !== "object") {
    return false;
  }
  if (Array.isArray(value)) {
    return value.some((item) => unknownContainsText(item, text));
  }
  return Object.values(value).some((item) => unknownContainsText(item, text));
}

function makeWorkspace(provider: ProbeProvider): string {
  mkdirSync(WORKSPACE_ROOT, { recursive: true });
  const cwd = mkdtempSync(path.join(WORKSPACE_ROOT, `${provider}-`));
  writeFileSync(path.join(cwd, "README.md"), `# RAH ${provider} native local-server probe\n`, "utf8");
  return cwd;
}

async function probeCodex(): Promise<ProviderProbeResult> {
  const checks: ProviderProbeResult["checks"] = [];
  let cwd: string | null = null;
  try {
    const binary = await resolveConfiguredBinary("RAH_CODEX_BINARY", "codex");
    const version = await commandVersion(binary);
    checks.push({
      name: "binary",
      status: "pass",
      detail: version ? `${binary} (${version})` : binary,
    });

    cwd = makeWorkspace("codex");
    const useWebSocket = CODEX_WEBSOCKET_PROBE || CODEX_REMOTE_TUI_PROBE;
    const client = (await withTimeout(
      useWebSocket
        ? createCodexWebSocketAppServerClient(binary)
        : createCodexAppServerClient().then((value) => value as unknown as CodexRpcClientLike),
      TIMEOUT_MS,
      useWebSocket ? "codex websocket app-server initialize" : "codex app-server initialize",
    )) as CodexRpcClientLike;
    try {
      const notifications: Array<{ method: string; params?: unknown }> = [];
      client.setNotificationHandler((notification) => {
        notifications.push(notification);
      });
      client.setRequestHandler(() => ({}));
      checks.push({
        name: useWebSocket ? "websocket app-server initialize" : "app-server initialize",
        status: "pass",
        detail: `${client.endpoint ?? "stdio:codex app-server"}${client.processId ? ` pid ${client.processId}` : ""}`,
      });
      const hasWebSocketEndpoint = Boolean(client.endpoint);

      const collaborationModes = (await withTimeout(
        client.request("collaborationMode/list", {}, TIMEOUT_MS),
        TIMEOUT_MS,
        "codex collaborationMode/list",
      )) as { data?: unknown[] };
      checks.push({
        name: "collaborationMode/list",
        status: "pass",
        detail: `${Array.isArray(collaborationModes.data) ? collaborationModes.data.length : 0} mode(s)`,
      });

      let threadId: string | undefined;
      if (CREATE_CODEX_THREAD || REAL_TURN_PROBE || CODEX_REMOTE_TUI_PROBE) {
        const threadStart = (await withTimeout(
          client.request(
            "thread/start",
            {
              cwd,
              name: `RAH native local-server probe ${randomUUID()}`,
              experimentalRawEvents: false,
              persistExtendedHistory: true,
            },
            TIMEOUT_MS,
          ),
          TIMEOUT_MS,
          "codex thread/start",
        )) as { thread?: { id?: string } };
        threadId = threadStart.thread?.id;
        checks.push({
          name: "thread/start",
          status: threadId ? "pass" : "fail",
          detail: threadId ? `thread:${threadId}` : "Codex app-server did not return thread.id",
        });
      } else {
        checks.push({
          name: "thread/start",
          status: "unverified",
          detail: "Skipped by default. Set RAH_NATIVE_LOCAL_SERVER_PROBE_CREATE_CODEX_THREAD=1 to verify.",
        });
      }

      let structuredLiveEvents: ProbeStatus = "unverified";
      let structuredControl: ProbeStatus = "unverified";
      let interrupt: ProbeStatus = "unverified";
      let tuiClientContinuity: ProbeStatus = hasWebSocketEndpoint ? "unverified" : "unsupported";
      let crossClientSync: ProbeStatus = hasWebSocketEndpoint ? "unverified" : "unsupported";
      if (CODEX_REMOTE_TUI_PROBE && threadId && client.endpoint) {
        const materializeMarker = `RAH_CODEX_MATERIALIZE_${randomUUID()}`;
        await client.request(
          "thread/shellCommand",
          {
            threadId,
            command: `printf '${materializeMarker}\\n'`,
          },
          TIMEOUT_MS,
        );
        structuredControl = "pass";
        await waitUntil(
          "codex thread materialization",
          () => notifications.some((notification) => unknownContainsText(notification.params, materializeMarker)),
          { timeoutMs: TIMEOUT_MS, intervalMs: 250 },
        );
        structuredLiveEvents = "pass";
        checks.push({
          name: "thread materialized",
          status: "pass",
          detail: materializeMarker,
        });

        const remoteTui = await startCodexRemoteTuiClient({
          binary,
          cwd,
          serverUrl: client.endpoint,
          threadId,
        });
        if (remoteTui.status !== "pass") {
          checks.push({
            name: "remote TUI attach",
            status: remoteTui.status,
            detail: remoteTui.detail,
          });
          tuiClientContinuity = remoteTui.status;
          crossClientSync = remoteTui.status === "fail" ? "fail" : "unverified";
        } else {
          tuiClientContinuity = "pass";
          checks.push({
            name: "remote TUI attach",
            status: "pass",
            detail: `${remoteTui.detail}; ${remoteTui.handle.outputPreview() || "no output preview"}`,
          });

          try {
            const webToTuiMarker = `RAH_CODEX_WS_TO_TUI_${randomUUID()}`;
            await client.request(
              "thread/shellCommand",
              {
                threadId,
                command: `printf '${webToTuiMarker}\\n'`,
              },
              TIMEOUT_MS,
            );
            structuredControl = "pass";
            await waitUntil(
              "codex web-to-tui marker",
              () => remoteTui.handle.output().includes(webToTuiMarker),
              { timeoutMs: TIMEOUT_MS, intervalMs: 250 },
            );
            structuredLiveEvents = "pass";
            checks.push({
              name: "web-to-tui sync",
              status: "pass",
              detail: webToTuiMarker,
            });

            const tuiToWebMarker = `RAH_CODEX_TUI_TO_WS_${randomUUID()}`;
            remoteTui.handle.write(`\x1b[200~!printf '${tuiToWebMarker}\\n'\x1b[201~\r`);
            try {
              await waitUntil(
                "codex tui-to-web marker",
                () => notifications.some((notification) => unknownContainsText(notification.params, tuiToWebMarker)),
                { timeoutMs: 30_000, intervalMs: 500 },
              );
            } catch (error) {
              const output = remoteTui.handle.outputPreview();
              throw new Error(`${previewError(error)}; remote TUI output after input: ${output || "<empty>"}`);
            }
            checks.push({
              name: "tui-to-web sync",
              status: "pass",
              detail: tuiToWebMarker,
            });
            crossClientSync = "pass";
          } finally {
            await remoteTui.handle.close();
          }
        }
      } else if (CODEX_REMOTE_TUI_PROBE) {
        checks.push({
          name: "remote TUI attach",
          status: "fail",
          detail: "Skipped because websocket endpoint or thread/start result is unavailable.",
        });
        tuiClientContinuity = "fail";
        crossClientSync = "fail";
      } else if (useWebSocket) {
        checks.push({
          name: "remote TUI attach",
          status: "unverified",
          detail: "Skipped by default. Set RAH_NATIVE_LOCAL_SERVER_PROBE_CODEX_REMOTE_TUI=1 to verify.",
        });
      }
      if (REAL_TURN_PROBE && threadId) {
        const marker = `RAH_NATIVE_LOCAL_SERVER_PROBE_${randomUUID()}`;
        const promptText = INTERRUPT_PROBE
          ? [
              "Use the shell tool to run this exact command, wait for it to finish, then reply with",
              `exactly ${marker}:`,
              "python3 -c \"import time; time.sleep(45); print('RAH_CODEX_INTERRUPT_SLEEP_DONE')\"",
            ].join(" ")
          : `Reply exactly ${marker}. Do not use tools.`;
        const turnStart = (await withTimeout(
          client.request(
            "turn/start",
            {
              threadId,
              input: [
                {
                  type: "text",
                  text: promptText,
                },
              ],
              cwd,
            },
            90_000,
          ),
          90_000,
          "codex turn/start",
        )) as { turn?: { id?: string } };
        const turnId = turnStart.turn?.id;
        checks.push({
          name: "turn/start",
          status: turnId ? "pass" : "fail",
          detail: turnId ? `turn:${turnId}` : "Codex app-server did not return turn.id",
        });
        if (turnId) {
          structuredControl = "pass";
          let interruptRequestAccepted = false;
          if (INTERRUPT_PROBE) {
            await waitUntil(
              "codex turn started before interrupt",
              () =>
                notifications.some(
                  (notification) =>
                    notification.method === "turn/started" &&
                    unknownContainsText(notification.params, turnId),
                ),
              { timeoutMs: 10_000, intervalMs: 250 },
            ).catch(() => undefined);
            const commandStarted = await waitUntil(
              "codex command execution started before interrupt",
              () =>
                notifications.some(
                  (notification) =>
                    notification.method === "item/started" &&
                    unknownContainsText(notification.params, "commandExecution") &&
                    unknownContainsText(notification.params, "RAH_CODEX_INTERRUPT_SLEEP_DONE"),
                ),
              { timeoutMs: 30_000, intervalMs: 500 },
            )
              .then(() => true)
              .catch(() => false);
            if (!commandStarted) {
              await sleep(750);
            }
            await client.request("turn/interrupt", { threadId, turnId }, TIMEOUT_MS).then(
              () => {
                checks.push({
                  name: "turn/interrupt request",
                  status: "pass",
                  detail: `turn:${turnId}`,
                });
                interruptRequestAccepted = true;
              },
              (error) => {
                checks.push({
                  name: "turn/interrupt request",
                  status: "unverified",
                  detail: previewError(error),
                });
                interrupt = "unverified";
              },
            );
          }
          await waitUntil(
            "codex turn completion event",
            () =>
              notifications.some(
                (notification) =>
                  notification.method === "turn/completed" ||
                  notification.method === "turn/failed" ||
                  notification.method === "turn/canceled",
              ),
            { timeoutMs: 120_000, intervalMs: 500 },
          );
          const eventMethods = [...new Set(notifications.map((notification) => notification.method))];
          checks.push({
            name: "event stream",
            status: "pass",
            detail: eventMethods.slice(0, 12).join(", "),
          });
          if (INTERRUPT_PROBE) {
            const interrupted = notifications.some(
              (notification) =>
                notification.method === "turn/canceled" ||
                (notification.method === "turn/completed" &&
                  unknownContainsText(notification.params, "interrupted")),
            );
            interrupt = interruptRequestAccepted && interrupted ? "pass" : "unverified";
            checks.push({
              name: "turn/interrupt outcome",
              status: interrupt,
              detail: interrupted
                ? "turn completed with interrupted status"
                : "turn finished before interruption was observed",
            });
          }
          structuredLiveEvents = "pass";
        }
      } else if (REAL_TURN_PROBE) {
        checks.push({
          name: "turn/start",
          status: "fail",
          detail: "Skipped because thread/start did not return thread.id.",
        });
      } else {
        checks.push({
          name: "turn/start",
          status: "unverified",
          detail: "Skipped by default. Set RAH_NATIVE_LOCAL_SERVER_PROBE_REAL_TURN=1 to verify.",
        });
      }

      const status = statusFromChecks(checks);
      return {
        provider: "codex",
        ok: status !== "fail",
        status,
        version,
        runtimeKind: "native_local_server",
        diagnostics: {
          serverEndpoint: client.endpoint ?? "stdio:codex app-server",
          serverPid: client.processId ?? null,
          attachState: client.endpoint ? "remote-tui-probeable" : "unavailable",
          ...(threadId ? { lastEventCursor: `thread:${threadId}` } : {}),
        },
        capability: baseCapability({
          structuredLiveEvents,
          structuredControl,
          historyBackfill: "unverified",
          tuiClientContinuity,
          crossClientSync,
          prelaunchConfig: "pass",
          runtimeConfig: "unverified",
          interrupt,
          archiveLifecycle: "unverified",
        }),
        checks,
      };
    } finally {
      await client.dispose().catch(() => undefined);
    }
  } catch (error) {
    checks.push({ name: "probe failed", status: "fail", detail: previewError(error) });
    return {
      provider: "codex",
      ok: false,
      status: "fail",
      runtimeKind: "native_local_server",
      capability: baseCapability({}),
      checks,
      error: previewError(error),
    };
  } finally {
    if (cwd) {
      rmSync(cwd, { recursive: true, force: true });
    }
  }
}

async function probeOpenCode(): Promise<ProviderProbeResult> {
  const checks: ProviderProbeResult["checks"] = [];
  let cwd: string | null = null;
  const previousXdgDataHome = process.env.XDG_DATA_HOME;
  try {
    const binary = await resolveOpenCodeBinary();
    const version = await commandVersion(binary);
    checks.push({
      name: "binary",
      status: "pass",
      detail: version ? `${binary} (${version})` : binary,
    });

    cwd = makeWorkspace("opencode");
    process.env.XDG_DATA_HOME = path.join(cwd, ".xdg-data");
    mkdirSync(process.env.XDG_DATA_HOME, { recursive: true });
    const serverOutput: string[] = [];
    const server = await withTimeout(
      startOpenCodeServer({
        cwd,
        onOutput(data) {
          serverOutput.push(data);
        },
      }),
      TIMEOUT_MS + 5_000,
      "opencode serve",
    );
    let unsubscribeEvents: (() => void) | null = null;
    try {
      const events: Array<{ type: string; properties?: Record<string, unknown> }> = [];
      unsubscribeEvents = subscribeOpenCodeEvents({
        handle: server,
        onEvent(event) {
          events.push(event);
        },
        onError(error) {
          checks.push({ name: "event stream error", status: "fail", detail: previewError(error) });
        },
      });
      checks.push({
        name: "serve",
        status: "pass",
        detail: `${server.baseUrl}${server.child.pid ? ` pid ${server.child.pid}` : ""}`,
      });

      const session = await withTimeout(
        createOpenCodeSession(server, { title: "RAH native local-server probe" }),
        TIMEOUT_MS,
        "opencode session create",
      );
      checks.push({
        name: "session create",
        status: "pass",
        detail: `session:${session.id}`,
      });

      const loaded = await withTimeout(
        getOpenCodeSession(server, session.id),
        TIMEOUT_MS,
        "opencode session get",
      );
      checks.push({
        name: "session get",
        status: loaded.id === session.id ? "pass" : "fail",
        detail: loaded.id === session.id ? `session:${loaded.id}` : `expected ${session.id}, got ${loaded.id}`,
      });

      const diagnostics = runtimeDiagnosticsForOpenCodeServer(server, session.id);
      checks.push({
        name: "attach command",
        status: diagnostics.attachCommand?.includes(server.baseUrl) ? "pass" : "fail",
        detail: diagnostics.attachCommand ?? "missing attach command",
      });

      let tuiClientContinuity: ProbeStatus = "unverified";
      let crossClientSync: ProbeStatus = "unverified";
      let structuredLiveEvents: ProbeStatus = "unverified";
      let structuredControl: ProbeStatus = "unverified";
      let interrupt: ProbeStatus = "unverified";
      let archiveLifecycle: ProbeStatus = "unverified";

      if (OPENCODE_CROSS_CLIENT_PROBE) {
        const attachClient = await startOpenCodeAttachClient({
          binary,
          cwd,
          serverUrl: server.baseUrl,
          providerSessionId: session.id,
        });
        checks.push({
          name: "opencode attach client",
          status: attachClient.status,
          detail: attachClient.detail,
        });
        if (attachClient.status === "pass") {
          tuiClientContinuity = "pass";
          try {
            const webToTuiMarker = `RAH_WEB_TO_TUI_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
            const eventCountBeforeWebPrompt = events.length;
            await withTimeout(
              promptOpenCodeSessionAsync({
                handle: server,
                providerSessionId: session.id,
                text: `Reply exactly ${webToTuiMarker}. Do not use tools.`,
              }),
              TIMEOUT_MS,
              "opencode web-to-attach prompt_async",
            );
            structuredControl = "pass";
            await waitUntil(
              "opencode web prompt visible via server timeline",
              async () => {
                const messages = await getOpenCodeMessages(server, session.id);
                return openCodeMessagesContainText(messages, webToTuiMarker);
              },
              { timeoutMs: 120_000, intervalMs: 1_000 },
            );
            checks.push({
              name: "web to server timeline",
              status: "pass",
              detail: `marker:${webToTuiMarker}`,
            });
            await waitUntil(
              "opencode web prompt visible in attach client",
              () => attachClient.handle.output().includes(webToTuiMarker),
              { timeoutMs: 120_000, intervalMs: 750 },
            );
            checks.push({
              name: "web to attach client",
              status: "pass",
              detail: `marker:${webToTuiMarker}`,
            });
            if (events.length > eventCountBeforeWebPrompt) {
              structuredLiveEvents = "pass";
            }
            await abortOpenCodeSession({ handle: server, providerSessionId: session.id }).catch(() => undefined);

            const tuiToWebMarker = `RAH_TUI_TO_WEB_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
            attachClient.handle.write(`Reply exactly ${tuiToWebMarker}. Do not use tools.\r`);
            await waitUntil(
              "opencode attach client prompt visible via server timeline",
              async () => {
                const messages = await getOpenCodeMessages(server, session.id);
                return openCodeMessagesContainText(messages, tuiToWebMarker);
              },
              { timeoutMs: 120_000, intervalMs: 1_000 },
            );
            checks.push({
              name: "attach client to server timeline",
              status: "pass",
              detail: `marker:${tuiToWebMarker}`,
            });
            crossClientSync = "pass";
            await abortOpenCodeSession({ handle: server, providerSessionId: session.id }).catch(() => undefined);
          } catch (error) {
            checks.push({
              name: "cross-client sync",
              status: "fail",
              detail: `${previewError(error)}; attach output=${attachClient.handle.outputPreview()}`,
            });
            crossClientSync = "fail";
          } finally {
            await attachClient.handle.close();
          }
        } else {
          tuiClientContinuity = attachClient.status;
          crossClientSync = attachClient.status === "fail" ? "fail" : "unverified";
        }
      } else if (OPENCODE_ATTACH_PROBE) {
        const attachProbe = await probeOpenCodeAttachClient({
          binary,
          cwd,
          serverUrl: server.baseUrl,
          providerSessionId: session.id,
        });
        checks.push({
          name: "opencode attach client",
          status: attachProbe.status,
          detail: attachProbe.detail,
        });
        tuiClientContinuity = attachProbe.status;
      } else {
        checks.push({
          name: "opencode attach client",
          status: "unverified",
          detail:
            "Skipped by default. Set RAH_NATIVE_LOCAL_SERVER_PROBE_OPENCODE_ATTACH=1 or RAH_NATIVE_LOCAL_SERVER_PROBE_OPENCODE_CROSS_CLIENT=1 to verify.",
        });
      }

      if (REAL_TURN_PROBE) {
        const marker = `RAH_NATIVE_LOCAL_SERVER_PROBE_${randomUUID()}`;
        const eventCountBeforePrompt = events.length;
        const messageCountBeforePrompt = await getOpenCodeMessages(server, session.id)
          .then((messages) => messages.length)
          .catch(() => 0);
        await withTimeout(
          promptOpenCodeSessionAsync({
            handle: server,
            providerSessionId: session.id,
            text: `Reply exactly ${marker}. Do not use tools.`,
          }),
          TIMEOUT_MS,
          "opencode prompt_async",
        );
        checks.push({ name: "prompt_async", status: "pass", detail: `marker:${marker}` });
        structuredControl = "pass";
        if (INTERRUPT_PROBE) {
          await withTimeout(
            abortOpenCodeSession({ handle: server, providerSessionId: session.id }),
            TIMEOUT_MS,
            "opencode abort",
          );
          checks.push({ name: "abort", status: "pass", detail: `session:${session.id}` });
          interrupt = "pass";
        }
        await waitUntil(
          "opencode post-prompt event or stored message",
          async () => {
            if (events.length > eventCountBeforePrompt) {
              return true;
            }
            const messages = await getOpenCodeMessages(server, session.id);
            return messages.length > messageCountBeforePrompt;
          },
          { timeoutMs: 120_000, intervalMs: 1_000 },
        );
        const postPromptEvents = events.slice(eventCountBeforePrompt);
        const eventTypes = [...new Set(postPromptEvents.map((event) => event.type))];
        const messageCountAfterPrompt = await getOpenCodeMessages(server, session.id)
          .then((messages) => messages.length)
          .catch(() => messageCountBeforePrompt);
        checks.push({
          name: "event stream",
          status: eventTypes.length > 0 ? "pass" : "unverified",
          detail:
            eventTypes.length > 0
              ? eventTypes.slice(0, 12).join(", ")
              : `messages observed via API (${messageCountBeforePrompt} -> ${messageCountAfterPrompt})`,
        });
        structuredLiveEvents = eventTypes.length > 0 ? "pass" : "unverified";
      } else {
        checks.push({
          name: "prompt_async",
          status: "unverified",
          detail: "Skipped by default. Set RAH_NATIVE_LOCAL_SERVER_PROBE_REAL_TURN=1 to verify.",
        });
      }

      try {
        const archived = await withTimeout(
          archiveOpenCodeSession({ handle: server, providerSessionId: session.id }),
          TIMEOUT_MS,
          "opencode archive",
        );
        const archivedAt = archived.time.archived;
        archiveLifecycle = typeof archivedAt === "number" ? "pass" : "unverified";
        checks.push({
          name: "archive",
          status: archiveLifecycle,
          detail: typeof archivedAt === "number" ? `archived:${archivedAt}` : "archive response had no time.archived",
        });
      } catch (error) {
        checks.push({ name: "archive", status: "fail", detail: previewError(error) });
      }

      const status = statusFromChecks(checks);
      return {
        provider: "opencode",
        ok: status !== "fail",
        status,
        version,
        runtimeKind: "native_local_server",
        diagnostics: {
          ...diagnostics,
          authHeaderConfigured: Boolean(server.authHeader),
        },
        capability: baseCapability({
          structuredLiveEvents,
          structuredControl,
          historyBackfill: "unverified",
          tuiClientContinuity,
          crossClientSync,
          prelaunchConfig: "unverified",
          runtimeConfig: "unverified",
          interrupt,
          archiveLifecycle,
        }),
        checks,
      };
    } finally {
      unsubscribeEvents?.();
      await stopOpenCodeServer(server).catch((error) => {
        checks.push({ name: "serve stop", status: "fail", detail: previewError(error) });
      });
    }
  } catch (error) {
    checks.push({ name: "probe failed", status: "fail", detail: previewError(error) });
    return {
      provider: "opencode",
      ok: false,
      status: "fail",
      runtimeKind: "native_local_server",
      capability: baseCapability({}),
      checks,
      error: previewError(error),
    };
  } finally {
    if (previousXdgDataHome === undefined) {
      delete process.env.XDG_DATA_HOME;
    } else {
      process.env.XDG_DATA_HOME = previousXdgDataHome;
    }
    if (cwd) {
      rmSync(cwd, { recursive: true, force: true });
    }
  }
}

async function probeProvider(provider: ProbeProvider): Promise<ProviderProbeResult> {
  if (provider === "codex") {
    return await probeCodex();
  }
  return await probeOpenCode();
}

async function main(): Promise<void> {
  const providers = selectedProviders();
  const results: ProviderProbeResult[] = [];
  for (const provider of providers) {
    results.push(await probeProvider(provider));
  }
  const report: ProbeReport = {
    ok: results.every((result) => result.ok),
    generatedAt: new Date().toISOString(),
    rah: readRahMetadata(),
    providers: results,
  };
  writeReport(OUTPUT_PATH, report);
  if (!report.ok && !ALLOW_FAILURES) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  const report: ProbeReport = {
    ok: false,
    generatedAt: new Date().toISOString(),
    rah: readRahMetadata(),
    providers: [
      {
        provider: "codex",
        ok: false,
        status: "fail",
        runtimeKind: "native_local_server",
        capability: baseCapability({}),
        checks: [{ name: "script", status: "fail", detail: previewError(error) }],
        error: previewError(error),
      },
    ],
  };
  writeReport(OUTPUT_PATH, report);
  if (!ALLOW_FAILURES) {
    process.exitCode = 1;
  }
});

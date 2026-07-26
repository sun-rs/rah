import { spawn, type ChildProcess } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { setTimeout as delay } from "node:timers/promises";
import {
  applyBackgroundProcessPriority,
  backgroundProcessLaunch,
} from "./background-process-priority";
import { BackpressuredByteIngress } from "./backpressured-byte-ingress";
import { resolveOpenCodeBinary } from "./opencode-api";
import { providerBinaryArgv } from "./provider-binary-utils";

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: unknown;
}

interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

type JsonRpcIncoming =
  | { jsonrpc: "2.0"; id: number; result?: unknown; error?: { message?: string } | unknown }
  | (JsonRpcRequest | JsonRpcNotification);

interface PendingRequest {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  timeout: NodeJS.Timeout;
}

const MAX_ACP_JSON_LINE_BYTES = 8 * 1024 * 1024;

export interface OpenCodeAcpSessionUpdate {
  sessionId: string;
  update: Record<string, unknown> & { sessionUpdate?: string };
}

export interface OpenCodeAcpSessionResponse {
  sessionId: string;
  configOptions?: unknown[];
  models?: unknown;
  modes?: unknown;
  _meta?: unknown;
}

export interface OpenCodeAcpPromptUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cachedReadTokens?: number | null;
  cachedWriteTokens?: number | null;
  thoughtTokens?: number | null;
}

export interface OpenCodeAcpPromptResponse {
  stopReason?: string;
  usage?: OpenCodeAcpPromptUsage;
  _meta?: unknown;
}

export class OpenCodeAcpClient {
  private child: ChildProcess | null = null;
  private nextId = 1;
  private stdoutBuffer = "";
  private stderrBuffer = "";
  private stdoutIngress: BackpressuredByteIngress | null = null;
  private stderrIngress: BackpressuredByteIngress | null = null;
  private readonly pending = new Map<number, PendingRequest>();
  private closed = false;

  constructor(
    private readonly cwd: string,
    private onSessionUpdate: (update: OpenCodeAcpSessionUpdate) => void = () => undefined,
  ) {}

  setSessionUpdateHandler(handler: (update: OpenCodeAcpSessionUpdate) => void): void {
    this.onSessionUpdate = handler;
  }

  async start(): Promise<void> {
    const binary = await resolveOpenCodeBinary();
    const [command, ...prefixArgs] = providerBinaryArgv(binary);
    if (!command) {
      throw new Error("OpenCode ACP command is empty.");
    }
    const launch = backgroundProcessLaunch(command, [
      ...prefixArgs,
      "acp",
      "--cwd",
      this.cwd,
    ]);
    const child = spawn(launch.command, launch.args, {
      cwd: this.cwd,
      env: process.env,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });
    applyBackgroundProcessPriority(
      child.pid,
      "OpenCode ACP",
      launch.priority,
    );
    this.child = child;
    const stdoutDecoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");
    let stdoutEnded = false;
    let stderrEnded = false;
    let stdoutFlushed = false;
    let stderrFlushed = false;
    let exitState:
      | { code: number | null; signal: NodeJS.Signals | null }
      | undefined;

    const appendStderr = (chunk: string) => {
      this.stderrBuffer = (this.stderrBuffer + chunk).slice(-8192);
    };
    const flushDecoders = () => {
      if (stdoutEnded && !stdoutFlushed && stdoutIngress.isIdle()) {
        stdoutFlushed = true;
        this.handleStdout(stdoutDecoder.end());
      }
      if (stderrEnded && !stderrFlushed && stderrIngress.isIdle()) {
        stderrFlushed = true;
        appendStderr(stderrDecoder.end());
      }
    };
    const finalizeExit = () => {
      flushDecoders();
      if (
        !exitState ||
        !stdoutIngress.isIdle() ||
        !stderrIngress.isIdle() ||
        !stdoutFlushed ||
        !stderrFlushed
      ) {
        return;
      }
      stdoutIngress.dispose();
      stderrIngress.dispose();
      this.stdoutIngress = null;
      this.stderrIngress = null;
      if (this.closed) {
        return;
      }
      this.closed = true;
      const suffix = this.stderrBuffer.trim() ? `: ${this.stderrBuffer.trim()}` : "";
      const error = new Error(
        `OpenCode ACP exited with code ${exitState.code ?? "null"} signal ${exitState.signal ?? "null"}${suffix}`,
      );
      this.rejectPending(error);
    };
    const stdoutIngress = new BackpressuredByteIngress({
      consume: (chunk) => this.handleStdout(stdoutDecoder.write(chunk)),
      pauseSource: () => child.stdout.pause(),
      resumeSource: () => child.stdout.resume(),
      onIdle: finalizeExit,
    });
    const stderrIngress = new BackpressuredByteIngress({
      consume: (chunk) => appendStderr(stderrDecoder.write(chunk)),
      pauseSource: () => child.stderr.pause(),
      resumeSource: () => child.stderr.resume(),
      onIdle: finalizeExit,
    });
    this.stdoutIngress = stdoutIngress;
    this.stderrIngress = stderrIngress;
    child.stdout.on("data", (chunk: Buffer) => stdoutIngress.enqueue(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderrIngress.enqueue(chunk));
    child.stdout.once("end", () => {
      stdoutEnded = true;
      finalizeExit();
    });
    child.stderr.once("end", () => {
      stderrEnded = true;
      finalizeExit();
    });
    const spawned = new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    child.once("exit", (code, signal) => {
      exitState = { code, signal };
      finalizeExit();
    });
    try {
      await spawned;
    } catch (error) {
      this.closed = true;
      this.child = null;
      this.disposeIngress();
      throw error;
    }
    child.once("error", (error) => {
      if (this.closed) {
        return;
      }
      this.closed = true;
      this.rejectPending(error);
    });
    await this.request("initialize", {
      protocolVersion: 1,
      clientInfo: { name: "RAH", version: "1.0.0" },
      clientCapabilities: {},
    });
  }

  async createSession(cwd: string): Promise<OpenCodeAcpSessionResponse> {
    return await this.request<OpenCodeAcpSessionResponse>("session/new", {
      cwd,
      mcpServers: [],
      additionalDirectories: [],
    });
  }

  async loadSession(sessionId: string, cwd: string): Promise<OpenCodeAcpSessionResponse> {
    return await this.request<OpenCodeAcpSessionResponse>("session/load", {
      sessionId,
      cwd,
      mcpServers: [],
      additionalDirectories: [],
    });
  }

  async prompt(sessionId: string, text: string): Promise<OpenCodeAcpPromptResponse> {
    return await this.request<OpenCodeAcpPromptResponse>(
      "session/prompt",
      {
        sessionId,
        prompt: [{ type: "text", text }],
      },
      30 * 60_000,
    );
  }

  async setSessionModel(sessionId: string, modelId: string): Promise<void> {
    await this.request("session/set_model", {
      sessionId,
      modelId,
    });
  }

  async setSessionMode(sessionId: string, modeId: string): Promise<void> {
    await this.request("session/set_mode", {
      sessionId,
      modeId,
    });
  }

  async cancel(sessionId: string): Promise<void> {
    this.notify("session/cancel", { sessionId });
  }

  async close(): Promise<void> {
    this.closed = true;
    this.rejectPending(new Error("OpenCode ACP client closed"));
    const child = this.child;
    this.child = null;
    if (!child?.pid || child.exitCode !== null || child.signalCode !== null) {
      this.disposeIngress();
      return;
    }
    await new Promise<void>((resolveDone) => {
      let done = false;
      const finish = () => {
        if (done) {
          return;
        }
        done = true;
        clearTimeout(killTimer);
        child.off("exit", finish);
        this.disposeIngress();
        resolveDone();
      };
      const killTimer = setTimeout(() => {
        this.signalChild(child, "SIGKILL");
        finish();
      }, 2_000);
      child.once("exit", finish);
      this.signalChild(child, "SIGTERM");
    });
  }

  private async request<T = unknown>(method: string, params?: unknown, timeoutMs = 60_000): Promise<T> {
    if (!this.child?.stdin || this.closed) {
      throw new Error("OpenCode ACP client is not running.");
    }
    const id = this.nextId++;
    const message: JsonRpcRequest = {
      jsonrpc: "2.0",
      id,
      method,
      ...(params !== undefined ? { params } : {}),
    };
    const payload = `${JSON.stringify(message)}\n`;
    return await new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`OpenCode ACP request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        method,
        resolve: (value) => resolve(value as T),
        reject,
        timeout,
      });
      this.child!.stdin!.write(payload, (error) => {
        if (!error) {
          return;
        }
        const pending = this.pending.get(id);
        if (!pending) {
          return;
        }
        clearTimeout(pending.timeout);
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  private notify(method: string, params?: unknown): void {
    if (!this.child?.stdin || this.closed) {
      return;
    }
    const message: JsonRpcNotification = {
      jsonrpc: "2.0",
      method,
      ...(params !== undefined ? { params } : {}),
    };
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private handleStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    const lines = this.stdoutBuffer.split("\n");
    this.stdoutBuffer = lines.pop() ?? "";
    if (Buffer.byteLength(this.stdoutBuffer, "utf8") > MAX_ACP_JSON_LINE_BYTES) {
      this.failProtocol(
        new Error(
          `OpenCode ACP emitted a JSON line larger than ${MAX_ACP_JSON_LINE_BYTES} bytes.`,
        ),
      );
      return;
    }
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      if (Buffer.byteLength(trimmed, "utf8") > MAX_ACP_JSON_LINE_BYTES) {
        this.failProtocol(
          new Error(
            `OpenCode ACP emitted a JSON line larger than ${MAX_ACP_JSON_LINE_BYTES} bytes.`,
          ),
        );
        return;
      }
      let message: JsonRpcIncoming;
      try {
        message = JSON.parse(trimmed) as JsonRpcIncoming;
      } catch {
        continue;
      }
      this.handleMessage(message);
    }
  }

  private handleMessage(message: JsonRpcIncoming): void {
    if ("id" in message && typeof message.id === "number" && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id)!;
      clearTimeout(pending.timeout);
      this.pending.delete(message.id);
      if ("error" in message && message.error !== undefined) {
        const error = message.error;
        pending.reject(new Error(typeof error === "object" && error && "message" in error ? String(error.message) : JSON.stringify(error)));
        return;
      }
      pending.resolve("result" in message ? message.result : undefined);
      return;
    }
    if (!("method" in message)) {
      return;
    }
    if (message.method === "session/update") {
      const params = asRecord(message.params);
      const update = asRecord(params?.update);
      const sessionId = typeof params?.sessionId === "string" ? params.sessionId : undefined;
      if (sessionId && update) {
        this.onSessionUpdate({ sessionId, update });
      }
      return;
    }
    if ("id" in message && typeof message.id === "number") {
      void this.respondToRequest(message);
    }
  }

  private async respondToRequest(message: JsonRpcRequest): Promise<void> {
    const result = await this.handleRequest(message).catch((error) => ({
      error: error instanceof Error ? error.message : String(error),
    }));
    this.child?.stdin?.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: message.id,
        result,
      })}\n`,
    );
  }

  private async handleRequest(message: JsonRpcRequest): Promise<unknown> {
    const params = asRecord(message.params);
    if (message.method === "fs/read_text_file" || message.method === "readTextFile") {
      const path = typeof params?.path === "string" ? params.path : undefined;
      if (!path) {
        return { content: "" };
      }
      const resolved = isAbsolute(path) ? path : resolve(this.cwd, path);
      return { content: await readFile(resolved, "utf8") };
    }
    if (message.method === "fs/write_text_file" || message.method === "writeTextFile") {
      const path = typeof params?.path === "string" ? params.path : undefined;
      const content = typeof params?.content === "string" ? params.content : "";
      if (path) {
        const resolved = isAbsolute(path) ? path : resolve(this.cwd, path);
        await writeFile(resolved, content);
      }
      return {};
    }
    return null;
  }

  private signalChild(child: ChildProcess, signal: NodeJS.Signals): void {
    const pid = child.pid;
    if (!pid) {
      return;
    }
    try {
      if (process.platform === "win32") {
        child.kill(signal);
        return;
      }
      process.kill(-pid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
        throw error;
      }
    }
  }

  private failProtocol(error: Error): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.rejectPending(error);
    if (this.child) {
      this.signalChild(this.child, "SIGTERM");
    }
  }

  private rejectPending(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timeout);
      pending.reject(error);
      this.pending.delete(id);
    }
  }

  private disposeIngress(): void {
    this.stdoutIngress?.dispose();
    this.stderrIngress?.dispose();
    this.stdoutIngress = null;
    this.stderrIngress = null;
  }
}

export async function waitForAcpDrain(lastActivityAt: () => number, quietMs: number): Promise<void> {
  while (Date.now() - lastActivityAt() < quietMs) {
    await delay(Math.max(10, quietMs - (Date.now() - lastActivityAt())));
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

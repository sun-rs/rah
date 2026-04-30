import { spawn, type ChildProcess } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { resolveOpenCodeBinary } from "./opencode-api";

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
    const child = spawn(binary, ["acp", "--cwd", this.cwd], {
      cwd: this.cwd,
      env: process.env,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.handleStdout(chunk));
    child.stderr.on("data", (chunk: string) => {
      this.stderrBuffer = (this.stderrBuffer + chunk).slice(-8192);
    });
    const spawned = new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    child.once("exit", (code, signal) => {
      if (this.closed) {
        return;
      }
      this.closed = true;
      const suffix = this.stderrBuffer.trim() ? `: ${this.stderrBuffer.trim()}` : "";
      const error = new Error(`OpenCode ACP exited with code ${code ?? "null"} signal ${signal ?? "null"}${suffix}`);
      for (const [id, pending] of this.pending) {
        clearTimeout(pending.timeout);
        pending.reject(error);
        this.pending.delete(id);
      }
    });
    try {
      await spawned;
    } catch (error) {
      this.closed = true;
      this.child = null;
      throw error;
    }
    child.once("error", (error) => {
      if (this.closed) {
        return;
      }
      this.closed = true;
      for (const [id, pending] of this.pending) {
        clearTimeout(pending.timeout);
        pending.reject(error);
        this.pending.delete(id);
      }
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
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("OpenCode ACP client closed"));
      this.pending.delete(id);
    }
    const child = this.child;
    this.child = null;
    if (!child?.pid || child.exitCode !== null || child.signalCode !== null) {
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
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
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

import type { ChildProcess, ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";
import { WebSocket } from "ws";
import {
  JSON_RPC_TIMEOUT_MS,
  type JsonRpcNotification,
  type JsonRpcRequest,
} from "./codex-live-types";

type JsonRpcResponse = {
  id: number | string;
  result?: unknown;
  error?: { message?: string };
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export interface CodexAppServerRpcClient {
  readonly processId?: number | undefined;
  readonly endpoint?: string | undefined;
  setNotificationHandler(handler: (notification: JsonRpcNotification) => void): void;
  setRequestHandler(handler: (request: JsonRpcRequest) => Promise<unknown> | unknown): void;
  setCloseHandler(handler: (error: Error) => void): void;
  request(method: string, params?: unknown, timeoutMs?: number): Promise<unknown>;
  notify(method: string, params?: unknown): void;
  dispose(): Promise<void>;
}

export class CodexJsonRpcClient implements CodexAppServerRpcClient {
  private readonly rl: readline.Interface;
  private readonly pending = new Map<number, PendingRequest>();
  private nextId = 1;
  private notificationHandler: ((notification: JsonRpcNotification) => void) | null = null;
  private requestHandler:
    | ((request: JsonRpcRequest) => Promise<unknown> | unknown)
    | null = null;
  private closeHandler: ((error: Error) => void) | null = null;
  private closeNotified = false;
  private disposed = false;

  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    this.rl = readline.createInterface({ input: child.stdout });
    this.rl.on("line", (line) => {
      void this.handleLine(line);
    });
    child.on("exit", () => {
      this.disposePending(new Error("Codex app-server exited"));
    });
    child.on("error", (error) => {
      this.disposePending(error instanceof Error ? error : new Error(String(error)));
    });
  }

  get processId(): number | undefined {
    return this.child.pid;
  }

  get endpoint(): undefined {
    return undefined;
  }

  setNotificationHandler(handler: (notification: JsonRpcNotification) => void) {
    this.notificationHandler = handler;
  }

  setRequestHandler(handler: (request: JsonRpcRequest) => Promise<unknown> | unknown) {
    this.requestHandler = handler;
  }

  setCloseHandler(handler: (error: Error) => void) {
    this.closeHandler = handler;
  }

  request(method: string, params?: unknown, timeoutMs = JSON_RPC_TIMEOUT_MS): Promise<unknown> {
    if (this.disposed) {
      return Promise.reject(new Error("Codex JSON-RPC client is closed"));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex app-server request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.child.stdin.write(`${JSON.stringify({ id, method, params })}\n`, (error) => {
          if (error) {
            this.rejectPending(id, error instanceof Error ? error : new Error(String(error)));
          }
        });
      } catch (error) {
        this.rejectPending(id, error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  notify(method: string, params?: unknown): void {
    if (this.disposed) {
      return;
    }
    this.child.stdin.write(`${JSON.stringify({ method, params })}\n`);
  }

  async dispose(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.rl.close();
    this.disposePending(new Error("Codex JSON-RPC client is closed"));
    if (this.child.exitCode !== null || this.child.signalCode !== null) {
      return;
    }
    await new Promise<void>((resolve) => {
      let settled = false;
      let sigkillTimer: ReturnType<typeof setTimeout> | undefined;
      let settleTimer: ReturnType<typeof setTimeout> | undefined;
      const finish = () => {
        if (settled) {
          return;
        }
        settled = true;
        if (sigkillTimer) {
          clearTimeout(sigkillTimer);
        }
        if (settleTimer) {
          clearTimeout(settleTimer);
        }
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
      sigkillTimer = setTimeout(() => {
        if (this.child.exitCode === null && this.child.signalCode === null) {
          try {
            this.child.kill("SIGKILL");
          } catch {
            finish();
            return;
          }
        }
        settleTimer = setTimeout(finish, 500);
      }, 500);
    });
  }

  private disposePending(error: Error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    if (!this.closeNotified) {
      this.closeNotified = true;
      this.closeHandler?.(error);
    }
    this.disposed = true;
  }

  private rejectPending(id: number, error: Error): void {
    const pending = this.pending.get(id);
    if (!pending) {
      return;
    }
    clearTimeout(pending.timer);
    this.pending.delete(id);
    pending.reject(error);
  }

  private async handleLine(line: string) {
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
    if (typeof message.id === "number" && (message.result !== undefined || message.error !== undefined)) {
      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      const response = message as JsonRpcResponse;
      if (response.error && typeof response.error === "object" && !Array.isArray(response.error)) {
        pending.reject(
          new Error(typeof response.error.message === "string" ? response.error.message : "JSON-RPC error"),
        );
      } else {
        pending.resolve(response.result);
      }
      return;
    }
    if (typeof message.id === "number" && typeof message.method === "string") {
      const request: JsonRpcRequest = {
        id: message.id,
        method: message.method,
        ...(message.params !== undefined ? { params: message.params } : {}),
      };
      try {
        const result = this.requestHandler ? await this.requestHandler(request) : {};
        this.child.stdin.write(`${JSON.stringify({ id: request.id, result })}\n`);
      } catch (error) {
        this.child.stdin.write(
          `${JSON.stringify({
            id: request.id,
            error: { message: error instanceof Error ? error.message : String(error) },
          })}\n`,
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

export class CodexWebSocketRpcClient implements CodexAppServerRpcClient {
  private readonly pending = new Map<string, PendingRequest>();
  private nextId = 1;
  private notificationHandler: ((notification: JsonRpcNotification) => void) | null = null;
  private requestHandler:
    | ((request: JsonRpcRequest) => Promise<unknown> | unknown)
    | null = null;
  private closeHandler: ((error: Error) => void) | null = null;
  private closeNotified = false;
  private disposed = false;

  constructor(
    private readonly socket: WebSocket,
    private readonly child: ChildProcess,
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

  setNotificationHandler(handler: (notification: JsonRpcNotification) => void) {
    this.notificationHandler = handler;
  }

  setRequestHandler(handler: (request: JsonRpcRequest) => Promise<unknown> | unknown) {
    this.requestHandler = handler;
  }

  setCloseHandler(handler: (error: Error) => void) {
    this.closeHandler = handler;
  }

  request(method: string, params?: unknown, timeoutMs = JSON_RPC_TIMEOUT_MS): Promise<unknown> {
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
      let sigkillTimer: ReturnType<typeof setTimeout> | undefined;
      const finish = () => {
        if (settled) {
          return;
        }
        settled = true;
        if (sigkillTimer) {
          clearTimeout(sigkillTimer);
        }
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
      sigkillTimer = setTimeout(() => {
        if (this.child.exitCode === null && this.child.signalCode === null) {
          try {
            this.child.kill("SIGKILL");
          } catch {
            finish();
            return;
          }
        }
        finish();
      }, 750);
      sigkillTimer.unref?.();
    });
  }

  private disposePending(error: Error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    if (!this.closeNotified) {
      this.closeNotified = true;
      this.closeHandler?.(error);
    }
    this.disposed = true;
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

  private async handleMessage(line: string) {
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
        pending.reject(
          new Error(typeof error.message === "string" ? error.message : "JSON-RPC error"),
        );
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if ((typeof message.id === "number" || typeof message.id === "string") && typeof message.method === "string") {
      const request: JsonRpcRequest = {
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

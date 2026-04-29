import type { ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";
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

export class CodexJsonRpcClient {
  private readonly rl: readline.Interface;
  private readonly pending = new Map<number, PendingRequest>();
  private nextId = 1;
  private notificationHandler: ((notification: JsonRpcNotification) => void) | null = null;
  private requestHandler:
    | ((request: JsonRpcRequest) => Promise<unknown> | unknown)
    | null = null;
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

  setNotificationHandler(handler: (notification: JsonRpcNotification) => void) {
    this.notificationHandler = handler;
  }

  setRequestHandler(handler: (request: JsonRpcRequest) => Promise<unknown> | unknown) {
    this.requestHandler = handler;
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

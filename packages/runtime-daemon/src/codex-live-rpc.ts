import type { ChildProcess, ChildProcessWithoutNullStreams } from "node:child_process";
import { WebSocket, type RawData } from "ws";
import {
  JSON_RPC_TIMEOUT_MS,
  type JsonRpcNotification,
  type JsonRpcRequest,
} from "./codex-live-types";
import { BackpressuredByteIngress } from "./backpressured-byte-ingress";

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

export const CODEX_RPC_MAX_MESSAGE_BYTES = 8 * 1024 * 1024;
const CODEX_RPC_PENDING_MESSAGE_BYTES = 16 * 1024 * 1024;
const CODEX_RPC_PENDING_MESSAGE_COUNT = 2_048;
const CODEX_RPC_DRAIN_BATCH = 32;
const CODEX_RPC_DRAIN_BUDGET_MS = 4;

function rawDataByteLength(data: RawData): number {
  if (Array.isArray(data)) {
    return data.reduce((total, chunk) => total + chunk.byteLength, 0);
  }
  return data.byteLength;
}

function rawDataBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) {
    return data;
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data, rawDataByteLength(data));
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data);
  }
  throw new TypeError("Unsupported Codex websocket payload type.");
}

export class CodexJsonRpcResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodexJsonRpcResponseError";
  }
}

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
  private readonly pending = new Map<number, PendingRequest>();
  private readonly lineChunks: Buffer[] = [];
  private lineBytes = 0;
  private readonly inboundQueue: Buffer[] = [];
  private inboundQueueHead = 0;
  private inboundQueueBytes = 0;
  private drainScheduled = false;
  private inFlightMessages = 0;
  private stdoutEnded = false;
  private transportExitError: Error | null = null;
  private readonly stdoutIngress: BackpressuredByteIngress;
  private nextId = 1;
  private notificationHandler: ((notification: JsonRpcNotification) => void) | null = null;
  private requestHandler:
    | ((request: JsonRpcRequest) => Promise<unknown> | unknown)
    | null = null;
  private closeHandler: ((error: Error) => void) | null = null;
  private closeNotified = false;
  private transportClosed = false;
  private disposed = false;

  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly maxMessageBytes = CODEX_RPC_MAX_MESSAGE_BYTES,
  ) {
    this.stdoutIngress = new BackpressuredByteIngress({
      consume: this.consumeStdoutData,
      pauseSource: () => child.stdout.pause(),
      resumeSource: () => child.stdout.resume(),
      onIdle: this.handleStdoutIngressIdle,
    });
    child.stdout.on("data", this.enqueueStdoutData);
    child.stdout.on("end", this.handleStdoutEnd);
    child.stdout.on("error", this.handleStdoutError);
    child.on("exit", () => {
      this.transportExitError = new Error("Codex app-server exited");
      this.maybeFinalizeTransportExit();
    });
    child.on("close", () => {
      this.transportExitError ??= new Error("Codex app-server closed");
      this.stdoutEnded = true;
      this.handleStdoutIngressIdle();
    });
    child.on("error", (error) => {
      this.transportExitError =
        error instanceof Error ? error : new Error(String(error));
      this.maybeFinalizeTransportExit();
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
    if (this.disposed || this.transportClosed) {
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
    if (this.disposed || this.transportClosed) {
      return;
    }
    this.child.stdin.write(`${JSON.stringify({ method, params })}\n`);
  }

  async dispose(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.detachStdout();
    this.stdoutIngress.dispose();
    this.inboundQueue.length = 0;
    this.inboundQueueHead = 0;
    this.inboundQueueBytes = 0;
    this.lineChunks.length = 0;
    this.lineBytes = 0;
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
    this.transportClosed = true;
  }

  private readonly enqueueStdoutData = (chunkValue: Buffer | string): void => {
    if (this.disposed || this.transportClosed) {
      return;
    }
    this.stdoutIngress.enqueue(
      Buffer.isBuffer(chunkValue) ? chunkValue : Buffer.from(chunkValue),
    );
  };

  private readonly consumeStdoutData = (
    chunk: Buffer<ArrayBufferLike>,
  ): void => {
    if (this.disposed || this.transportClosed) {
      return;
    }
    let cursor = 0;
    while (cursor < chunk.length) {
      const newline = chunk.indexOf(0x0a, cursor);
      const end = newline < 0 ? chunk.length : newline;
      if (!this.appendLineSegment(chunk.subarray(cursor, end))) {
        return;
      }
      if (newline < 0) {
        return;
      }
      this.finishInboundLine();
      if (this.disposed || this.transportClosed) {
        return;
      }
      cursor = newline + 1;
    }
  };

  private readonly handleStdoutEnd = (): void => {
    this.stdoutEnded = true;
    this.handleStdoutIngressIdle();
  };

  private readonly handleStdoutError = (error: Error): void => {
    this.failInboundTransport(error);
  };

  private readonly handleStdoutIngressIdle = (): void => {
    if (
      this.stdoutEnded &&
      this.lineBytes > 0 &&
      !this.transportClosed &&
      !this.disposed
    ) {
      this.finishInboundLine();
    }
    this.maybeFinalizeTransportExit();
  };

  private appendLineSegment(segment: Buffer): boolean {
    if (this.disposed || this.transportClosed) {
      return false;
    }
    if (segment.length === 0) {
      return true;
    }
    if (this.lineBytes + segment.length > this.maxMessageBytes) {
      this.failInboundTransport(
        new Error(
          `Codex stdio JSON-RPC message exceeded ${this.maxMessageBytes} bytes.`,
        ),
      );
      return false;
    }
    this.lineChunks.push(segment);
    this.lineBytes += segment.length;
    return true;
  }

  private finishInboundLine(): void {
    let line = Buffer.concat(this.lineChunks, this.lineBytes);
    this.lineChunks.length = 0;
    this.lineBytes = 0;
    if (line.at(-1) === 0x0d) {
      line = line.subarray(0, -1);
    }
    if (line.length === 0) {
      return;
    }
    this.enqueueInbound(line);
  }

  private enqueueInbound(message: Buffer): void {
    if (
      this.inboundQueue.length - this.inboundQueueHead >=
        CODEX_RPC_PENDING_MESSAGE_COUNT ||
      this.inboundQueueBytes + message.length > CODEX_RPC_PENDING_MESSAGE_BYTES
    ) {
      this.failInboundTransport(
        new Error("Codex stdio JSON-RPC ingress queue exceeded its bounded capacity."),
      );
      return;
    }
    this.inboundQueue.push(message);
    this.inboundQueueBytes += message.length;
    this.scheduleDrain();
  }

  private scheduleDrain(): void {
    if (this.drainScheduled || this.disposed || this.transportClosed) {
      return;
    }
    this.drainScheduled = true;
    setImmediate(() => {
      this.drainScheduled = false;
      this.drainInbound();
    });
  }

  private drainInbound(): void {
    const startedAt = performance.now();
    let drained = 0;
    while (
      this.inboundQueueHead < this.inboundQueue.length &&
      drained < CODEX_RPC_DRAIN_BATCH &&
      performance.now() - startedAt < CODEX_RPC_DRAIN_BUDGET_MS
    ) {
      const message = this.inboundQueue[this.inboundQueueHead++]!;
      this.inboundQueueBytes -= message.length;
      drained += 1;
      this.inFlightMessages += 1;
      void this.handleLine(message.toString("utf8")).finally(() => {
        this.inFlightMessages -= 1;
        this.maybeFinalizeTransportExit();
      });
    }
    if (
      this.inboundQueueHead > 1_024 ||
      this.inboundQueueHead * 2 > this.inboundQueue.length
    ) {
      this.inboundQueue.splice(0, this.inboundQueueHead);
      this.inboundQueueHead = 0;
    }
    if (this.inboundQueueHead < this.inboundQueue.length) {
      this.scheduleDrain();
      return;
    }
    this.maybeFinalizeTransportExit();
  }

  private failInboundTransport(error: Error): void {
    if (this.disposed || this.transportClosed) {
      return;
    }
    this.detachStdout();
    this.stdoutIngress.dispose();
    this.child.stdout.pause();
    this.inboundQueue.length = 0;
    this.inboundQueueHead = 0;
    this.inboundQueueBytes = 0;
    this.lineChunks.length = 0;
    this.lineBytes = 0;
    this.disposePending(error);
    if (this.child.exitCode === null && this.child.signalCode === null) {
      try {
        this.child.kill("SIGTERM");
      } catch {
        // The close handler still receives the protocol failure.
      }
    }
  }

  private detachStdout(): void {
    this.child.stdout.off("data", this.enqueueStdoutData);
    this.child.stdout.off("end", this.handleStdoutEnd);
    this.child.stdout.off("error", this.handleStdoutError);
  }

  private maybeFinalizeTransportExit(): void {
    if (
      !this.transportExitError ||
      this.disposed ||
      this.transportClosed ||
      !this.stdoutEnded ||
      !this.stdoutIngress.isIdle() ||
      this.inboundQueueHead < this.inboundQueue.length ||
      this.drainScheduled ||
      this.inFlightMessages > 0
    ) {
      return;
    }
    this.disposePending(this.transportExitError);
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
          new CodexJsonRpcResponseError(
            typeof response.error.message === "string"
              ? response.error.message
              : "JSON-RPC error",
          ),
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
  private readonly inboundQueue: Buffer[] = [];
  private inboundQueueHead = 0;
  private inboundQueueBytes = 0;
  private drainScheduled = false;
  private inFlightMessages = 0;
  private transportEndError: Error | null = null;
  private nextId = 1;
  private notificationHandler: ((notification: JsonRpcNotification) => void) | null = null;
  private requestHandler:
    | ((request: JsonRpcRequest) => Promise<unknown> | unknown)
    | null = null;
  private closeHandler: ((error: Error) => void) | null = null;
  private closeNotified = false;
  private transportClosed = false;
  private disposed = false;

  constructor(
    private readonly socket: WebSocket,
    private readonly child: ChildProcess,
    readonly endpoint: string,
    private readonly maxMessageBytes = CODEX_RPC_MAX_MESSAGE_BYTES,
  ) {
    socket.on("message", (data) => {
      this.enqueueInbound(data);
    });
    socket.on("close", () => {
      this.markTransportEnded(
        new Error("Codex websocket app-server disconnected"),
      );
    });
    socket.on("error", (error) => {
      this.markTransportEnded(
        error instanceof Error ? error : new Error(String(error)),
      );
    });
    child.on("exit", () => {
      this.markTransportEnded(new Error("Codex websocket app-server exited"));
    });
    child.on("error", (error) => {
      this.markTransportEnded(
        error instanceof Error ? error : new Error(String(error)),
      );
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
    if (
      this.disposed ||
      this.transportClosed ||
      this.transportEndError ||
      this.socket.readyState !== WebSocket.OPEN
    ) {
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
    if (
      this.disposed ||
      this.transportClosed ||
      this.transportEndError ||
      this.socket.readyState !== WebSocket.OPEN
    ) {
      return;
    }
    this.socket.send(JSON.stringify({ method, params }));
  }

  async dispose(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.inboundQueue.length = 0;
    this.inboundQueueHead = 0;
    this.inboundQueueBytes = 0;
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
    // A closed socket makes RPC unavailable, but the owned app-server child
    // can still be alive. Keep explicit disposal available so callers can
    // terminate that process instead of leaking an orphan.
    this.transportClosed = true;
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

  private enqueueInbound(data: RawData): void {
    if (this.disposed || this.transportClosed) {
      return;
    }
    const bytes = rawDataByteLength(data);
    if (bytes > this.maxMessageBytes) {
      this.failInboundTransport(
        new Error(
          `Codex websocket JSON-RPC message exceeded ${this.maxMessageBytes} bytes.`,
        ),
      );
      return;
    }
    if (
      this.inboundQueue.length - this.inboundQueueHead >=
        CODEX_RPC_PENDING_MESSAGE_COUNT ||
      this.inboundQueueBytes + bytes > CODEX_RPC_PENDING_MESSAGE_BYTES
    ) {
      this.failInboundTransport(
        new Error("Codex websocket JSON-RPC ingress queue exceeded its bounded capacity."),
      );
      return;
    }
    const message = rawDataBuffer(data);
    this.inboundQueue.push(message);
    this.inboundQueueBytes += message.length;
    this.scheduleDrain();
  }

  private scheduleDrain(): void {
    if (this.drainScheduled || this.disposed || this.transportClosed) {
      return;
    }
    this.drainScheduled = true;
    setImmediate(() => {
      this.drainScheduled = false;
      this.drainInbound();
    });
  }

  private drainInbound(): void {
    const startedAt = performance.now();
    let drained = 0;
    while (
      this.inboundQueueHead < this.inboundQueue.length &&
      drained < CODEX_RPC_DRAIN_BATCH &&
      performance.now() - startedAt < CODEX_RPC_DRAIN_BUDGET_MS
    ) {
      const message = this.inboundQueue[this.inboundQueueHead++]!;
      this.inboundQueueBytes -= message.length;
      drained += 1;
      this.inFlightMessages += 1;
      void this.handleMessage(message.toString("utf8")).finally(() => {
        this.inFlightMessages -= 1;
        this.maybeFinalizeTransportEnd();
      });
    }
    if (
      this.inboundQueueHead > 1_024 ||
      this.inboundQueueHead * 2 > this.inboundQueue.length
    ) {
      this.inboundQueue.splice(0, this.inboundQueueHead);
      this.inboundQueueHead = 0;
    }
    if (this.inboundQueueHead < this.inboundQueue.length) {
      this.scheduleDrain();
      return;
    }
    this.maybeFinalizeTransportEnd();
  }

  private failInboundTransport(error: Error): void {
    if (this.disposed || this.transportClosed) {
      return;
    }
    this.inboundQueue.length = 0;
    this.inboundQueueHead = 0;
    this.inboundQueueBytes = 0;
    this.disposePending(error);
    try {
      this.socket.close(1009, "Codex RPC ingress limit exceeded");
    } catch {
      this.socket.terminate();
    }
  }

  private markTransportEnded(error: Error): void {
    if (this.disposed || this.transportClosed) {
      return;
    }
    this.transportEndError ??= error;
    this.maybeFinalizeTransportEnd();
  }

  private maybeFinalizeTransportEnd(): void {
    if (
      !this.transportEndError ||
      this.disposed ||
      this.transportClosed ||
      this.inboundQueueHead < this.inboundQueue.length ||
      this.drainScheduled ||
      this.inFlightMessages > 0
    ) {
      return;
    }
    this.disposePending(this.transportEndError);
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
          new CodexJsonRpcResponseError(
            typeof error.message === "string" ? error.message : "JSON-RPC error",
          ),
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

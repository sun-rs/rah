import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  applyBackgroundProcessPriority,
  backgroundProcessLaunch,
} from "./background-process-priority";

export type BackgroundIpcChild = ChildProcess;

const DEFAULT_MAX_REQUEST_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_OLD_GENERATION_MB = 256;
const DEFAULT_MAX_YOUNG_GENERATION_MB = 32;
const DEFAULT_STACK_SIZE_MB = 4;
const TERMINATE_GRACE_MS = 500;

export type BackgroundIpcTaskOptions<Request> = {
  script: URL;
  request: Request;
  label: string;
  signal?: AbortSignal;
  maxRequestBytes?: number;
  maxResponseBytes?: number;
  maxOldGenerationSizeMb?: number;
  maxYoungGenerationSizeMb?: number;
  stackSizeMb?: number;
  timeoutMs?: number;
  onSpawn?: (child: ChildProcess) => void;
  onClose?: (child: ChildProcess) => void;
};

export type BackgroundIpcTaskServerOptions<Request, Response> = {
  label: string;
  handle: (request: Request) => Response | Promise<Response>;
  onError: (error: unknown) => Response;
  maxRequestBytes?: number;
  maxResponseBytes?: number;
};

function positiveInteger(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(1, Math.floor(value));
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    return `${Math.round(bytes / (1024 * 1024))} MiB`;
  }
  if (bytes >= 1024) {
    return `${Math.round(bytes / 1024)} KiB`;
  }
  return `${bytes} B`;
}

export function encodeBoundedIpcMessage(
  value: unknown,
  maxBytes: number,
  label: string,
): string {
  const payload = JSON.stringify(value);
  if (payload === undefined) {
    throw new Error(`${label} cannot encode an undefined IPC payload.`);
  }
  const bytes = Buffer.byteLength(payload, "utf8");
  if (bytes > maxBytes) {
    throw new Error(
      `${label} exceeded the ${formatBytes(maxBytes)} IPC message limit.`,
    );
  }
  return payload;
}

export function decodeBoundedIpcMessage<T>(
  payload: unknown,
  maxBytes: number,
  label: string,
): T {
  if (typeof payload !== "string") {
    throw new Error(`${label} received a non-string IPC payload.`);
  }
  const bytes = Buffer.byteLength(payload, "utf8");
  if (bytes > maxBytes) {
    throw new Error(
      `${label} exceeded the ${formatBytes(maxBytes)} IPC message limit.`,
    );
  }
  return JSON.parse(payload) as T;
}

function childExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

async function waitForChildExit(
  child: ChildProcess,
  timeoutMs: number,
): Promise<boolean> {
  if (childExited(child)) {
    return true;
  }
  return await new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (exited: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      child.off("exit", onExit);
      child.off("close", onExit);
      child.off("error", onExit);
      resolve(exited);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref?.();
    child.once("exit", onExit);
    child.once("close", onExit);
    child.once("error", onExit);
    if (childExited(child)) {
      finish(true);
    }
  });
}

export async function terminateBackgroundIpcProcess(
  child: ChildProcess,
): Promise<void> {
  if (childExited(child)) {
    return;
  }
  child.kill("SIGTERM");
  if (await waitForChildExit(child, TERMINATE_GRACE_MS)) {
    return;
  }
  child.kill("SIGKILL");
  await waitForChildExit(child, 1_000);
}

/**
 * Executes one CPU- or I/O-heavy task in a separately scheduled process.
 *
 * Unlike a Worker thread, this process can receive Darwin's background task
 * policy before any provider history code runs. Requests and responses are
 * serialized as explicitly bounded strings so one giant provider transcript
 * cannot create an unbounded structured-clone or IPC allocation in the daemon.
 */
export async function runBackgroundIpcTask<Request, Response>(
  options: BackgroundIpcTaskOptions<Request>,
): Promise<Response> {
  if (options.signal?.aborted) {
    throw options.signal.reason ?? new DOMException("Aborted", "AbortError");
  }
  const maxRequestBytes = positiveInteger(
    options.maxRequestBytes,
    DEFAULT_MAX_REQUEST_BYTES,
  );
  const maxResponseBytes = positiveInteger(
    options.maxResponseBytes,
    DEFAULT_MAX_RESPONSE_BYTES,
  );
  const requestPayload = encodeBoundedIpcMessage(
    options.request,
    maxRequestBytes,
    `${options.label} request`,
  );
  const nodeArgs = [
    `--max-old-space-size=${positiveInteger(
      options.maxOldGenerationSizeMb,
      DEFAULT_MAX_OLD_GENERATION_MB,
    )}`,
    `--max-semi-space-size=${positiveInteger(
      options.maxYoungGenerationSizeMb,
      DEFAULT_MAX_YOUNG_GENERATION_MB,
    )}`,
    `--stack-size=${
      positiveInteger(options.stackSizeMb, DEFAULT_STACK_SIZE_MB) * 1024
    }`,
    "--import",
    "tsx",
    fileURLToPath(options.script),
  ];
  const launch = backgroundProcessLaunch(process.execPath, nodeArgs);

  return await new Promise<Response>((resolve, reject) => {
    const child = spawn(launch.command, launch.args, {
      stdio: ["ignore", "ignore", "inherit", "ipc"],
    });
    options.onSpawn?.(child);
    applyBackgroundProcessPriority(
      child.pid,
      options.label,
      launch.priority,
    );

    let settled = false;
    let closeNotified = false;
    let timeout: NodeJS.Timeout | undefined;
    let killTimer: NodeJS.Timeout | undefined;

    const clearTimeoutTimer = () => {
      if (timeout) {
        clearTimeout(timeout);
        timeout = undefined;
      }
    };
    const notifyClose = () => {
      if (closeNotified) {
        return;
      }
      closeNotified = true;
      if (killTimer) {
        clearTimeout(killTimer);
        killTimer = undefined;
      }
      clearTimeoutTimer();
      options.onClose?.(child);
    };
    const removeAbortListener = () => {
      if (options.signal) {
        options.signal.removeEventListener("abort", abort);
      }
    };
    const requestTermination = () => {
      if (childExited(child)) {
        return;
      }
      child.kill("SIGTERM");
      if (!killTimer) {
        killTimer = setTimeout(() => {
          if (!childExited(child)) {
            child.kill("SIGKILL");
          }
        }, TERMINATE_GRACE_MS);
        killTimer.unref?.();
      }
    };
    const fail = (error: unknown) => {
      if (settled) {
        return;
      }
      settled = true;
      removeAbortListener();
      clearTimeoutTimer();
      requestTermination();
      reject(error);
    };
    const abort = () => {
      fail(
        options.signal?.reason ??
          new DOMException(`${options.label} aborted`, "AbortError"),
      );
    };

    options.signal?.addEventListener("abort", abort, { once: true });
    child.once("message", (message: unknown) => {
      if (settled) {
        return;
      }
      try {
        const response = decodeBoundedIpcMessage<Response>(
          message,
          maxResponseBytes,
          `${options.label} response`,
        );
        settled = true;
        removeAbortListener();
        clearTimeoutTimer();
        resolve(response);
      } catch (error) {
        fail(error);
      }
    });
    child.once("error", (error) => {
      fail(error);
    });
    child.once("exit", (code, signal) => {
      if (!settled) {
        settled = true;
        removeAbortListener();
        clearTimeoutTimer();
        reject(
          new Error(
            code === 0
              ? `${options.label} exited without a result.`
              : `${options.label} exited with ${
                  signal ? `signal ${signal}` : `code ${code}`
                }.`,
          ),
        );
      }
    });
    child.once("close", notifyClose);

    if (options.timeoutMs !== undefined && options.timeoutMs > 0) {
      timeout = setTimeout(() => {
        fail(new Error(`${options.label} timed out.`));
      }, options.timeoutMs);
      timeout.unref?.();
    }
    if (!child.connected) {
      fail(new Error(`${options.label} did not open an IPC channel.`));
      return;
    }
    child.send(requestPayload, (error) => {
      if (error) {
        fail(error);
      }
    });
  });
}

/**
 * Installs the one-shot worker side of the bounded IPC protocol.
 *
 * Importing a worker module in the test runner remains safe because a normal
 * process has no parent IPC channel. A background child handles exactly one
 * request, sends one bounded response, disconnects, and exits.
 */
export function serveBackgroundIpcTask<Request, Response>(
  options: BackgroundIpcTaskServerOptions<Request, Response>,
): boolean {
  if (!process.send) {
    return false;
  }
  const maxRequestBytes = positiveInteger(
    options.maxRequestBytes,
    DEFAULT_MAX_REQUEST_BYTES,
  );
  const maxResponseBytes = positiveInteger(
    options.maxResponseBytes,
    DEFAULT_MAX_RESPONSE_BYTES,
  );
  const finish = (response: Response) => {
    let payload: string;
    try {
      payload = encodeBoundedIpcMessage(
        response,
        maxResponseBytes,
        `${options.label} response`,
      );
    } catch (error) {
      try {
        payload = encodeBoundedIpcMessage(
          options.onError(error),
          maxResponseBytes,
          `${options.label} error response`,
        );
      } catch (nestedError) {
        console.error(
          `[rah] ${options.label} could not encode its bounded IPC response`,
          nestedError,
        );
        process.exitCode = 1;
        process.disconnect?.();
        return;
      }
    }
    try {
      process.send?.(payload, (error) => {
        if (error) {
          console.error(`[rah] ${options.label} failed to send its IPC response`, error);
          process.exitCode = 1;
        }
        process.disconnect?.();
      });
    } catch (error) {
      console.error(`[rah] ${options.label} failed to send its IPC response`, error);
      process.exitCode = 1;
      process.disconnect?.();
    }
  };

  process.once("message", (message: unknown) => {
    void Promise.resolve()
      .then(() =>
        decodeBoundedIpcMessage<Request>(
          message,
          maxRequestBytes,
          `${options.label} request`,
        ),
      )
      .then(options.handle)
      .then(finish, (error) => finish(options.onError(error)));
  });
  return true;
}

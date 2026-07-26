import { spawn } from "node:child_process";
import { BackpressuredByteIngress } from "./backpressured-byte-ingress";
import {
  applyBackgroundProcessPriority,
  backgroundProcessLaunch,
} from "./background-process-priority";

const DEFAULT_MAX_STDOUT_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_STDERR_BYTES = 2 * 1024 * 1024;
const TERMINATE_GRACE_MS = 500;
const STDIN_WRITE_SLICE_BYTES = 64 * 1024;

export type BackgroundCommandOptions = {
  command: string;
  args?: readonly string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: string | Buffer;
  signal?: AbortSignal;
  label: string;
  acceptedExitCodes?: readonly number[];
  allowNonZeroExit?: boolean;
  timeoutMs?: number;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
};

export type BackgroundCommandResult = {
  stdout: string;
  stderr: string;
  code: number;
};

/**
 * Run a finite background command under RAH's common resource contract.
 *
 * The command tree receives reduced CPU priority before it starts and the
 * additional macOS background I/O/QoS policy asynchronously after spawn.
 * stdout/stderr are admitted through byte- and time-sliced queues, and exact
 * output is retained only up to explicit hard limits. This is deliberately
 * separate from live provider streams: finite probes and Git reads must fail
 * closed when their result is too large rather than silently returning a tail.
 */
export async function runBackgroundCommand(
  options: BackgroundCommandOptions,
): Promise<BackgroundCommandResult> {
  const args = [...(options.args ?? [])];
  const launch = backgroundProcessLaunch(options.command, args);
  const maxStdoutBytes = nonNegativeInteger(
    options.maxStdoutBytes,
    DEFAULT_MAX_STDOUT_BYTES,
  );
  const maxStderrBytes = nonNegativeInteger(
    options.maxStderrBytes,
    DEFAULT_MAX_STDERR_BYTES,
  );
  const acceptedExitCodes = new Set(options.acceptedExitCodes ?? [0]);

  return await new Promise<BackgroundCommandResult>((resolve, reject) => {
    const child = spawn(launch.command, launch.args, {
      ...(options.cwd ? { cwd: options.cwd } : {}),
      env: options.env ?? process.env,
      ...(options.signal ? { signal: options.signal } : {}),
      stdio: ["pipe", "pipe", "pipe"],
    });
    applyBackgroundProcessPriority(
      child.pid,
      options.label,
      launch.priority,
    );

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let childClosed = false;
    let closeCode: number | null = null;
    let settled = false;
    let failure: Error | undefined;
    let timeout: NodeJS.Timeout | undefined;
    let killTimer: NodeJS.Timeout | undefined;

    const clearTimers = () => {
      if (timeout) {
        clearTimeout(timeout);
        timeout = undefined;
      }
      if (killTimer) {
        clearTimeout(killTimer);
        killTimer = undefined;
      }
    };
    const requestTermination = () => {
      if (childClosed) {
        return;
      }
      child.kill("SIGTERM");
      if (!killTimer) {
        killTimer = setTimeout(() => {
          if (!childClosed) {
            child.kill("SIGKILL");
          }
        }, TERMINATE_GRACE_MS);
        killTimer.unref?.();
      }
    };
    const fail = (error: Error) => {
      if (!failure) {
        failure = error;
      }
      requestTermination();
    };
    const append = (
      stream: "stdout" | "stderr",
      chunk: Buffer<ArrayBufferLike>,
    ) => {
      if (failure || chunk.length === 0) {
        return;
      }
      if (stream === "stdout") {
        if (stdoutBytes + chunk.length > maxStdoutBytes) {
          fail(
            new Error(
              `${options.label} exceeded the ${formatBytes(maxStdoutBytes)} stdout limit.`,
            ),
          );
          return;
        }
        stdoutChunks.push(Buffer.from(chunk));
        stdoutBytes += chunk.length;
        return;
      }
      if (stderrBytes + chunk.length > maxStderrBytes) {
        fail(
          new Error(
            `${options.label} exceeded the ${formatBytes(maxStderrBytes)} stderr limit.`,
          ),
        );
        return;
      }
      stderrChunks.push(Buffer.from(chunk));
      stderrBytes += chunk.length;
    };

    let stdoutIngress: BackpressuredByteIngress;
    let stderrIngress: BackpressuredByteIngress;
    const maybeFinish = () => {
      if (
        settled ||
        !childClosed ||
        !stdoutIngress.isIdle() ||
        !stderrIngress.isIdle()
      ) {
        return;
      }
      settled = true;
      clearTimers();
      stdoutIngress.dispose();
      stderrIngress.dispose();
      const stdout = Buffer.concat(stdoutChunks, stdoutBytes).toString("utf8");
      const stderr = Buffer.concat(stderrChunks, stderrBytes).toString("utf8");
      if (failure) {
        reject(failure);
        return;
      }
      const code = closeCode ?? -1;
      if (!options.allowNonZeroExit && !acceptedExitCodes.has(code)) {
        reject(
          new Error(
            stderr.trim() ||
              `${options.label} exited with code ${closeCode ?? "null"}.`,
          ),
        );
        return;
      }
      resolve({ stdout, stderr, code });
    };

    stdoutIngress = new BackpressuredByteIngress({
      consume: (chunk) => append("stdout", chunk),
      pauseSource: () => child.stdout.pause(),
      resumeSource: () => child.stdout.resume(),
      onIdle: maybeFinish,
    });
    stderrIngress = new BackpressuredByteIngress({
      consume: (chunk) => append("stderr", chunk),
      pauseSource: () => child.stderr.pause(),
      resumeSource: () => child.stderr.resume(),
      onIdle: maybeFinish,
    });

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutIngress.enqueue(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrIngress.enqueue(chunk);
    });
    child.once("error", (error) => {
      failure = error;
      childClosed = true;
      maybeFinish();
    });
    child.once("close", (code) => {
      childClosed = true;
      closeCode = code;
      maybeFinish();
    });

    if (options.timeoutMs !== undefined && options.timeoutMs > 0) {
      timeout = setTimeout(() => {
        fail(new Error(`${options.label} timed out.`));
      }, options.timeoutMs);
    }

    child.stdin.once("error", (error) => {
      fail(error);
    });

    const input = options.input;
    if (input === undefined || input.length === 0) {
      child.stdin.end();
      return;
    }

    // A single `stdin.end(veryLargeString)` forces Node to encode and queue the
    // whole payload in one event-loop turn. Provider histories can contain
    // multi-megabyte base64 images, so feed finite commands in bounded slices
    // and yield between writable bursts. Backpressure from the child is
    // observed rather than turning stdin into another unbounded memory queue.
    let inputOffset = 0;
    const pumpInput = () => {
      if (childClosed || failure || child.stdin.destroyed) {
        return;
      }
      const nextOffset = Math.min(
        input.length,
        inputOffset + STDIN_WRITE_SLICE_BYTES,
      );
      const chunk =
        typeof input === "string"
          ? input.slice(inputOffset, nextOffset)
          : input.subarray(inputOffset, nextOffset);
      inputOffset = nextOffset;
      const writable = child.stdin.write(chunk);
      if (inputOffset >= input.length) {
        child.stdin.end();
        return;
      }
      if (!writable) {
        child.stdin.once("drain", pumpInput);
        return;
      }
      setImmediate(pumpInput);
    };
    pumpInput();
  });
}

function nonNegativeInteger(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(0, Math.floor(value));
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

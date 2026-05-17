import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";

const HOST_FRAME_READY = 1;
const HOST_FRAME_OUTPUT = 2;
const HOST_FRAME_ERROR = 3;
const HOST_FRAME_EXIT = 4;

const CLIENT_FRAME_INPUT = 1;
const CLIENT_FRAME_RESIZE = 2;
const CLIENT_FRAME_CLOSE = 3;

const FRAME_HEADER_SIZE = 5;
const MAX_HOST_FRAME_BYTES = 32 * 1024 * 1024;

function encodeClientFrame(frameType: number, payload?: Buffer): Buffer {
  const body = payload ?? Buffer.alloc(0);
  const header = Buffer.allocUnsafe(FRAME_HEADER_SIZE);
  header.writeUInt8(frameType, 0);
  header.writeUInt32BE(body.length, 1);
  return body.length === 0 ? header : Buffer.concat([header, body]);
}

function cleanEnv(args: {
  cols?: number;
  rows?: number;
  shell: string;
  command?: string;
  commandArgs?: string[];
  extraEnv?: Record<string, string>;
}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      env[key] = value;
    }
  }
  for (const [key, value] of Object.entries(args.extraEnv ?? {})) {
    env[key] = value;
  }
  normalizeTerminalEnvironment(env);
  env.RAH_TERMINAL_SHELL = args.shell;
  env.RAH_TERMINAL_HOST_PROTOCOL = "2";
  if (args.cols !== undefined) {
    env.COLUMNS = String(args.cols);
  }
  if (args.rows !== undefined) {
    env.LINES = String(args.rows);
  }
  if (args.command) {
    env.RAH_TERMINAL_COMMAND = args.command;
    env.RAH_TERMINAL_ARGS_JSON = JSON.stringify(args.commandArgs ?? []);
  } else {
    delete env.RAH_TERMINAL_COMMAND;
    delete env.RAH_TERMINAL_ARGS_JSON;
  }
  return env;
}

function normalizeTerminalEnvironment(env: Record<string, string>): void {
  const misleadingParentTerminalKeys = [
    "ALACRITTY_SOCKET",
    "GNOME_TERMINAL_SCREEN",
    "ITERM_PROFILE",
    "ITERM_PROFILE_NAME",
    "ITERM_SESSION_ID",
    "KITTY_WINDOW_ID",
    "KONSOLE_VERSION",
    "NO_COLOR",
    "TERM_PROGRAM",
    "TERM_PROGRAM_VERSION",
    "TERM_SESSION_ID",
    "TMUX",
    "VTE_VERSION",
    "WEZTERM_VERSION",
    "WT_SESSION",
  ];
  for (const key of misleadingParentTerminalKeys) {
    delete env[key];
  }
  env.TERM = "xterm-256color";
  env.COLORTERM = "truecolor";
  env.CLICOLOR = "1";
  env.FORCE_COLOR = "1";
}

function resolveShellBinary(): string {
  return process.env.RAH_TERMINAL_SHELL || process.env.SHELL || "/bin/zsh";
}

function resolvePythonBinary(): string {
  return process.env.RAH_TERMINAL_PYTHON || "python3";
}

function resolveHostScriptPath(): string {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(moduleDir, "independent-terminal-host.py"),
    resolve(moduleDir, "..", "src", "independent-terminal-host.py"),
    resolve(process.cwd(), "src", "independent-terminal-host.py"),
    resolve(process.cwd(), "packages", "runtime-daemon", "src", "independent-terminal-host.py"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return candidates[0]!;
}

export interface IndependentTerminalStartOptions {
  cwd: string;
  cols?: number;
  rows?: number;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  onData: (data: string) => void;
  onExit: (args: { exitCode?: number; signal?: string }) => void;
}

export class IndependentTerminalProcess {
  readonly shell: string;
  readonly cwd: string;

  private readonly child: ChildProcessWithoutNullStreams;
  private readonly onData: (data: string) => void;
  private readonly onExit: (args: { exitCode?: number; signal?: string }) => void;
  private readonly outputDecoder = new StringDecoder("utf8");
  private stdoutBuffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  private readonly readyPromise: Promise<void>;
  private resolveReady: (() => void) | null = null;
  private rejectReady: ((error: Error) => void) | null = null;
  private readySettled = false;
  private exitHandled = false;
  private closed = false;

  constructor(options: IndependentTerminalStartOptions) {
    this.shell = resolveShellBinary();
    this.cwd = options.cwd;
    this.onData = options.onData;
    this.onExit = options.onExit;

    this.child = spawn(
      resolvePythonBinary(),
      [
        "-u",
        resolveHostScriptPath(),
        options.cwd,
        String(options.cols ?? 100),
        String(options.rows ?? 32),
      ],
      {
        env: cleanEnv({
          shell: this.shell,
          ...(options.command ? { command: options.command } : {}),
          ...(options.args ? { commandArgs: options.args } : {}),
          ...(options.env ? { extraEnv: options.env } : {}),
          ...(options.cols !== undefined ? { cols: options.cols } : {}),
          ...(options.rows !== undefined ? { rows: options.rows } : {}),
        }),
        stdio: "pipe",
      },
    );
    this.child.stderr.setEncoding("utf8");

    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
      const rejectStartup = (message: string) => {
        if (this.readySettled) {
          return;
        }
        this.readySettled = true;
        reject(new Error(message));
      };

      this.child.stdout.on("data", (chunk: Buffer | string) => {
        this.handleStdoutChunk(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });

      this.child.stderr.on("data", (chunk: string | Buffer) => {
        const text = chunk.toString();
        if (!text.trim()) {
          return;
        }
        if (!this.readySettled) {
          rejectStartup(text.trim());
          return;
        }
        this.onData(`\r\n[terminal host] ${text.trimEnd()}\r\n`);
      });

      this.child.on("error", (error) => {
        if (!this.readySettled) {
          rejectStartup(error.message);
          return;
        }
        this.onData(`\r\n[terminal host] ${error.message}\r\n`);
      });

      this.child.on("exit", (exitCode, signal) => {
        if (!this.readySettled) {
          rejectStartup(`terminal host exited before ready (${exitCode ?? signal ?? "unknown"})`);
        }
        this.handleExit({
          ...(exitCode !== null ? { exitCode } : {}),
          ...(signal !== null ? { signal } : {}),
        });
      });
    });
  }

  async waitUntilReady(): Promise<void> {
    await this.readyPromise;
  }

  write(data: string): void {
    if (this.closed) {
      return;
    }
    this.sendFrame(CLIENT_FRAME_INPUT, Buffer.from(data, "utf8"));
  }

  resize(cols: number, rows: number): void {
    if (this.closed) {
      return;
    }
    this.sendFrame(
      CLIENT_FRAME_RESIZE,
      Buffer.from(JSON.stringify({ cols, rows }), "utf8"),
    );
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.sendFrame(CLIENT_FRAME_CLOSE);

    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        if (!this.exitHandled) {
          this.child.kill("SIGTERM");
        }
      }, 500);
      const hardTimeout = setTimeout(() => {
        if (!this.exitHandled) {
          this.child.kill("SIGKILL");
        }
        resolve();
      }, 2_000);
      this.child.once("exit", () => {
        clearTimeout(timeout);
        clearTimeout(hardTimeout);
        resolve();
      });
    });
  }

  private sendFrame(frameType: number, payload?: Buffer): void {
    if (this.child.stdin.destroyed) {
      return;
    }
    this.child.stdin.write(encodeClientFrame(frameType, payload));
  }

  private handleStdoutChunk(chunk: Buffer<ArrayBufferLike>): void {
    this.stdoutBuffer = this.stdoutBuffer.length === 0
      ? chunk
      : Buffer.concat([this.stdoutBuffer, chunk]);
    while (this.stdoutBuffer.length >= FRAME_HEADER_SIZE) {
      const frameType = this.stdoutBuffer.readUInt8(0);
      const payloadLength = this.stdoutBuffer.readUInt32BE(1);
      if (payloadLength > MAX_HOST_FRAME_BYTES) {
        this.onData(`\r\n[terminal error] host frame is too large: ${payloadLength} bytes\r\n`);
        this.child.kill("SIGTERM");
        this.stdoutBuffer = Buffer.alloc(0);
        return;
      }
      const frameLength = FRAME_HEADER_SIZE + payloadLength;
      if (this.stdoutBuffer.length < frameLength) {
        return;
      }
      const payload = this.stdoutBuffer.subarray(FRAME_HEADER_SIZE, frameLength);
      this.stdoutBuffer = this.stdoutBuffer.subarray(frameLength);
      this.handleHostFrame(frameType, payload);
    }
  }

  private handleHostFrame(frameType: number, payload: Buffer): void {
    if (frameType === HOST_FRAME_READY) {
      if (!this.readySettled) {
        this.readySettled = true;
        this.resolveReady?.();
      }
      return;
    }
    if (frameType === HOST_FRAME_OUTPUT) {
      const decoded = this.outputDecoder.write(payload);
      if (decoded) {
        this.onData(decoded);
      }
      return;
    }
    if (frameType === HOST_FRAME_ERROR) {
      const message = decodeHostErrorMessage(payload);
      if (!this.readySettled) {
        this.readySettled = true;
        this.rejectReady?.(new Error(message));
        return;
      }
      this.onData(`\r\n[terminal error] ${message}\r\n`);
      return;
    }
    if (frameType === HOST_FRAME_EXIT) {
      this.handleExit(decodeHostExit(payload));
      return;
    }
    this.onData(`\r\n[terminal error] unknown host frame ${frameType}\r\n`);
  }

  private handleExit(message: { exitCode?: number; signal?: string }): void {
    if (this.exitHandled) {
      return;
    }
    this.exitHandled = true;
    this.closed = true;
    const trailingOutput = this.outputDecoder.end();
    if (trailingOutput) {
      this.onData(trailingOutput);
    }
    this.onExit({
      ...(message.exitCode !== undefined ? { exitCode: message.exitCode } : {}),
      ...(message.signal !== undefined ? { signal: message.signal } : {}),
    });
  }
}

function decodeHostJsonObject(payload: Buffer<ArrayBufferLike>): Record<string, unknown> {
  try {
    const parsed = JSON.parse(payload.toString("utf8")) as unknown;
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function decodeHostErrorMessage(payload: Buffer<ArrayBufferLike>): string {
  const parsed = decodeHostJsonObject(payload);
  return typeof parsed.message === "string" ? parsed.message : payload.toString("utf8");
}

function decodeHostExit(payload: Buffer<ArrayBufferLike>): { exitCode?: number; signal?: string } {
  const parsed = decodeHostJsonObject(payload);
  return {
    ...(typeof parsed.exitCode === "number" ? { exitCode: parsed.exitCode } : {}),
    ...(typeof parsed.signal === "string" ? { signal: parsed.signal } : {}),
  };
}

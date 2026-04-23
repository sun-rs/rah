import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

type TerminalHostMessage =
  | {
      type: "ready";
    }
  | {
      type: "output";
      data: string;
    }
  | {
      type: "error";
      message: string;
    }
  | {
      type: "exit";
      exitCode?: number;
      signal?: string;
    };

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
  env.TERM = env.TERM || "xterm-256color";
  env.RAH_TERMINAL_SHELL = args.shell;
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
  for (const [key, value] of Object.entries(args.extraEnv ?? {})) {
    env[key] = value;
  }
  return env;
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
  private readonly stdoutReader: readline.Interface;
  private readonly onData: (data: string) => void;
  private readonly onExit: (args: { exitCode?: number; signal?: string }) => void;
  private readonly readyPromise: Promise<void>;
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
    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");
    this.stdoutReader = readline.createInterface({
      input: this.child.stdout,
      crlfDelay: Infinity,
    });

    this.readyPromise = new Promise<void>((resolve, reject) => {
      const rejectStartup = (message: string) => {
        if (this.readySettled) {
          return;
        }
        this.readySettled = true;
        reject(new Error(message));
      };

      this.stdoutReader.on("line", (line) => {
        if (!line.trim()) {
          return;
        }
        let message: TerminalHostMessage;
        try {
          message = JSON.parse(line) as TerminalHostMessage;
        } catch {
          this.onData(`${line}\r\n`);
          return;
        }

        if (message.type === "ready") {
          if (!this.readySettled) {
            this.readySettled = true;
            resolve();
          }
          return;
        }

        if (message.type === "output") {
          this.onData(message.data);
          return;
        }

        if (message.type === "error") {
          if (!this.readySettled) {
            rejectStartup(message.message);
            return;
          }
          this.onData(`\r\n[terminal error] ${message.message}\r\n`);
          return;
        }

        this.handleExit(message);
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
    this.sendMessage({
      type: "input",
      data,
    });
  }

  resize(cols: number, rows: number): void {
    if (this.closed) {
      return;
    }
    this.sendMessage({
      type: "resize",
      cols,
      rows,
    });
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.sendMessage({ type: "close" });

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

  private sendMessage(payload: Record<string, unknown>): void {
    if (this.child.stdin.destroyed) {
      return;
    }
    this.child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  private handleExit(message: { exitCode?: number; signal?: string }): void {
    if (this.exitHandled) {
      return;
    }
    this.exitHandled = true;
    this.closed = true;
    this.stdoutReader.close();
    this.onExit({
      ...(message.exitCode !== undefined ? { exitCode: message.exitCode } : {}),
      ...(message.signal !== undefined ? { signal: message.signal } : {}),
    });
  }
}

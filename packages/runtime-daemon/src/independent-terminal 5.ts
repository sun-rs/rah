import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { accessSync, constants } from "node:fs";
import os from "node:os";
import path from "node:path";

function cleanEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      env[key] = value;
    }
  }
  env.TERM = env.TERM || "xterm-256color";
  return env;
}

function resolveShellBinary(): string {
  return process.env.SHELL || "/bin/zsh";
}

function renderPrompt(cwd: string): string {
  const home = os.homedir();
  const display = cwd === home ? "~" : cwd.startsWith(`${home}/`) ? `~/${cwd.slice(home.length + 1)}` : cwd;
  return `${display} % `;
}

function isDirectory(targetPath: string): boolean {
  try {
    accessSync(targetPath, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

export interface IndependentTerminalStartOptions {
  cwd: string;
  onData: (data: string) => void;
  onExit: (args: { exitCode?: number; signal?: string }) => void;
}

export class IndependentTerminalProcess {
  readonly shell: string;
  readonly cwd: string;
  private lineBuffer = "";
  private runningCommand: ChildProcessWithoutNullStreams | null = null;
  private closed = false;
  private currentCwd: string;
  private readonly onData: (data: string) => void;
  private readonly onExit: (args: { exitCode?: number; signal?: string }) => void;

  constructor(options: IndependentTerminalStartOptions) {
    this.shell = resolveShellBinary();
    this.cwd = options.cwd;
    this.currentCwd = options.cwd;
    this.onData = options.onData;
    this.onExit = options.onExit;
    this.onData(renderPrompt(this.currentCwd));
  }

  write(data: string): void {
    if (this.closed) {
      return;
    }

    if (this.runningCommand) {
      if (data.includes("\u0003")) {
        this.runningCommand.kill("SIGTERM");
        this.onData("^C\r\n");
      }
      return;
    }

    for (const char of data) {
      if (char === "\r" || char === "\n") {
        const command = this.lineBuffer;
        this.lineBuffer = "";
        this.onData("\r\n");
        void this.execute(command.trim());
        continue;
      }
      if (char === "\u007f" || char === "\b") {
        if (this.lineBuffer.length > 0) {
          this.lineBuffer = this.lineBuffer.slice(0, -1);
          this.onData("\b \b");
        }
        continue;
      }
      if (char === "\u0003") {
        this.onData("^C\r\n");
        this.lineBuffer = "";
        this.onData(renderPrompt(this.currentCwd));
        continue;
      }
      if (char === "\u001b") {
        continue;
      }
      this.lineBuffer += char;
      this.onData(char);
    }
  }

  resize(_cols: number, _rows: number): void {
    // Line-based implementation does not emulate a real PTY size.
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    if (this.runningCommand) {
      this.runningCommand.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        this.runningCommand?.once("exit", () => resolve());
        setTimeout(resolve, 500);
      });
    }
    this.onExit({});
  }

  private async execute(command: string): Promise<void> {
    if (!command) {
      this.onData(renderPrompt(this.currentCwd));
      return;
    }

    if (command === "exit") {
      await this.close();
      return;
    }

    if (command === "clear") {
      this.onData("\u001bc");
      this.onData(renderPrompt(this.currentCwd));
      return;
    }

    if (command === "pwd") {
      this.onData(`${this.currentCwd}\r\n`);
      this.onData(renderPrompt(this.currentCwd));
      return;
    }

    if (command === "cd" || command.startsWith("cd ")) {
      const rawTarget = command === "cd" ? "~" : command.slice(3).trim() || "~";
      const resolved =
        rawTarget === "~"
          ? os.homedir()
          : rawTarget.startsWith("~/")
            ? path.resolve(os.homedir(), rawTarget.slice(2))
            : path.resolve(this.currentCwd, rawTarget);
      if (!isDirectory(resolved)) {
        this.onData(`cd: no such file or directory: ${rawTarget}\r\n`);
      } else {
        this.currentCwd = resolved;
      }
      this.onData(renderPrompt(this.currentCwd));
      return;
    }

    const child = spawn(this.shell, ["-lc", command], {
      cwd: this.currentCwd,
      env: cleanEnv(),
      stdio: "pipe",
    });
    this.runningCommand = child;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      this.onData(chunk.replace(/\n/g, "\r\n"));
    });
    child.stderr.on("data", (chunk: string) => {
      this.onData(chunk.replace(/\n/g, "\r\n"));
    });
    child.on("error", (error) => {
      this.onData(`[shell error] ${error.message}\r\n`);
    });
    child.on("exit", (exitCode) => {
      this.runningCommand = null;
      if (this.closed) {
        return;
      }
      if (exitCode && exitCode !== 0) {
        this.onData(`[exit ${exitCode}]\r\n`);
      }
      this.onData(renderPrompt(this.currentCwd));
    });
  }
}

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

const HOST_SCRIPT_PATH = (() => {
  const cwdCandidate = resolve(process.cwd(), "src", "independent-terminal-host.mjs");
  if (existsSync(cwdCandidate)) {
    return cwdCandidate;
  }
  return resolve(dirname(fileURLToPath(import.meta.url)), "independent-terminal-host.mjs");
})();

function resolveNodeBinary(): string {
  return process.release?.name === "node" ? process.execPath : "node";
}

export interface IndependentTerminalStartOptions {
  cwd: string;
  cols?: number;
  rows?: number;
  onData: (data: string) => void;
  onExit: (args: { exitCode?: number; signal?: string }) => void;
}

type HostMessage =
  | { type: "output"; data: string }
  | { type: "exit"; exitCode?: number; signal?: string }
  | { type: "error"; message: string };

export class IndependentTerminalProcess {
  readonly shell: string;
  readonly cwd: string;
  private readonly host: ChildProcessWithoutNullStreams;
  private closed = false;

  constructor(options: IndependentTerminalStartOptions) {
    this.shell = process.env.SHELL || "/bin/zsh";
    this.cwd = options.cwd;
    this.host = spawn(
      resolveNodeBinary(),
      [HOST_SCRIPT_PATH, options.cwd, String(options.cols ?? 100), String(options.rows ?? 32)],
      {
        stdio: "pipe",
      },
    );

    let bufferedStdout = "";
    this.host.stdout.setEncoding("utf8");
    this.host.stdout.on("data", (chunk: string) => {
      console.error("[independent-terminal stdout]", chunk.slice(0, 200));
      bufferedStdout += chunk;
      for (;;) {
        const newlineIndex = bufferedStdout.indexOf("\n");
        if (newlineIndex < 0) {
          break;
        }
        const line = bufferedStdout.slice(0, newlineIndex);
        bufferedStdout = bufferedStdout.slice(newlineIndex + 1);
        let message: HostMessage;
        try {
          message = JSON.parse(line) as HostMessage;
        } catch {
          continue;
        }
        if (message.type === "output") {
          options.onData(message.data);
          continue;
        }
        if (message.type === "error") {
          options.onData(`\r\n[terminal host error] ${message.message}\r\n`);
          continue;
        }
        this.closed = true;
        options.onExit({
          ...(message.exitCode !== undefined ? { exitCode: message.exitCode } : {}),
          ...(message.signal !== undefined ? { signal: message.signal } : {}),
        });
      }
    });

    this.host.stderr.setEncoding("utf8");
    this.host.stderr.on("data", (chunk: string) => {
      console.error("[independent-terminal stderr]", chunk.slice(0, 200));
      options.onData(`\r\n[terminal host stderr] ${chunk}`);
    });
    this.host.on("error", (error) => {
      options.onData(`\r\n[terminal host error] ${error.message}\r\n`);
    });
    this.host.on("exit", (exitCode, signal) => {
      if (this.closed) {
        return;
      }
      this.closed = true;
      options.onExit({
        ...(exitCode !== null ? { exitCode } : {}),
        ...(signal !== null ? { signal } : {}),
      });
    });
  }

  write(data: string): void {
    if (this.closed) {
      return;
    }
    this.host.stdin.write(`${JSON.stringify({ type: "input", data })}\n`);
  }

  resize(cols: number, rows: number): void {
    if (this.closed) {
      return;
    }
    this.host.stdin.write(`${JSON.stringify({ type: "resize", cols, rows })}\n`);
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.host.stdin.write(`${JSON.stringify({ type: "close" })}\n`);
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        if (!this.closed) {
          this.host.kill("SIGKILL");
        }
        resolve();
      }, 1000);
      this.host.once("exit", () => {
        clearTimeout(timeout);
        resolve();
      });
    });
  }
}

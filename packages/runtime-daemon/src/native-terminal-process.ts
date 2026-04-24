import { spawn, type ChildProcess } from "node:child_process";

export interface NativeTerminalStartOptions {
  cwd: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  onExit: (args: { exitCode?: number; signal?: string }) => void;
}

export class NativeTerminalProcess {
  private readonly child: ChildProcess;
  private closed = false;

  constructor(options: NativeTerminalStartOptions) {
    this.child = spawn(options.command, options.args ?? [], {
      cwd: options.cwd,
      env: {
        ...process.env,
        ...(options.env ?? {}),
      },
      stdio: "inherit",
      shell: false,
    });

    this.child.on("exit", (exitCode, signal) => {
      options.onExit({
        ...(exitCode !== null ? { exitCode } : {}),
        ...(signal !== null ? { signal } : {}),
      });
    });
  }

  async close(signal: NodeJS.Signals = "SIGTERM"): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    if (this.child.exitCode !== null || this.child.killed) {
      return;
    }
    this.child.kill(signal);
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        if (this.child.exitCode === null && !this.child.killed) {
          this.child.kill("SIGKILL");
        }
      }, 2_000);
      this.child.once("exit", () => {
        clearTimeout(timeout);
        resolve();
      });
    });
  }
}

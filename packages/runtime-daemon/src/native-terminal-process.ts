import { spawn, type ChildProcess } from "node:child_process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface NativeTerminalStartOptions {
  cwd: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  closeTimeoutMs?: number;
  onExit: (args: { exitCode?: number; signal?: string }) => void;
}

export class NativeTerminalProcess {
  private readonly child: ChildProcess;
  private readonly closeTimeoutMs: number;
  private closed = false;

  constructor(options: NativeTerminalStartOptions) {
    this.closeTimeoutMs = options.closeTimeoutMs ?? 2_000;
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

  private async childTreePids(): Promise<number[]> {
    const rootPid = this.child.pid;
    if (rootPid === undefined || process.platform === "win32") {
      return [];
    }
    try {
      const { stdout } = await execFileAsync("ps", ["-axo", "pid=,ppid="], {
        maxBuffer: 1024 * 1024,
      });
      const childrenByParent = new Map<number, number[]>();
      for (const line of stdout.split("\n")) {
        const [pidRaw, ppidRaw] = line.trim().split(/\s+/);
        const pid = Number(pidRaw);
        const ppid = Number(ppidRaw);
        if (!Number.isInteger(pid) || !Number.isInteger(ppid)) {
          continue;
        }
        const children = childrenByParent.get(ppid) ?? [];
        children.push(pid);
        childrenByParent.set(ppid, children);
      }
      const result: number[] = [];
      const pending = [...(childrenByParent.get(rootPid) ?? [])];
      while (pending.length > 0) {
        const pid = pending.shift()!;
        result.push(pid);
        pending.push(...(childrenByParent.get(pid) ?? []));
      }
      return result.reverse();
    } catch {
      return [];
    }
  }

  private killPids(pids: number[], signal: NodeJS.Signals): void {
    for (const pid of pids) {
      try {
        process.kill(pid, signal);
      } catch {
        // Process already exited.
      }
    }
  }

  async close(signal: NodeJS.Signals = "SIGTERM"): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    if (this.child.exitCode !== null || this.child.killed) {
      return;
    }
    const childTree = await this.childTreePids();
    this.killPids(childTree, signal);
    this.child.kill(signal);
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        void this.childTreePids().then((lateChildTree) => {
          this.killPids([...childTree, ...lateChildTree], "SIGKILL");
        });
        if (this.child.exitCode === null) {
          this.child.kill("SIGKILL");
        }
      }, this.closeTimeoutMs);
      this.child.once("exit", () => {
        clearTimeout(timeout);
        resolve();
      });
    });
  }
}

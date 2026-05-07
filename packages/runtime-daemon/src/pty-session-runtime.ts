import { randomUUID } from "node:crypto";

import { IndependentTerminalProcess } from "./independent-terminal";

export type PtySessionRuntimeExitArgs = {
  exitCode?: number;
  signal?: string;
};

export type PtySessionRuntimeStartRequest = {
  id?: string;
  cwd: string;
  cols?: number;
  rows?: number;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  onData: (id: string, data: string) => void;
  onExit: (id: string, args: PtySessionRuntimeExitArgs) => void;
};

export type PtySessionRuntimeEntry = {
  id: string;
  cwd: string;
  shell: string;
  process: IndependentTerminalProcess;
};

export type PtySessionRuntimeCloseResult = {
  id: string;
  status: "fulfilled" | "rejected";
  reason?: unknown;
};

export class PtySessionRuntime {
  private readonly sessions = new Map<string, PtySessionRuntimeEntry>();

  has(id: string): boolean {
    return this.sessions.has(id);
  }

  get(id: string): PtySessionRuntimeEntry | undefined {
    return this.sessions.get(id);
  }

  list(): PtySessionRuntimeEntry[] {
    return [...this.sessions.values()];
  }

  write(id: string, data: string): boolean {
    const session = this.sessions.get(id);
    if (!session) {
      return false;
    }
    session.process.write(data);
    return true;
  }

  resize(id: string, cols: number, rows: number): boolean {
    const session = this.sessions.get(id);
    if (!session) {
      return false;
    }
    session.process.resize(cols, rows);
    return true;
  }

  create(request: PtySessionRuntimeStartRequest): PtySessionRuntimeEntry {
    const id = request.id ?? randomUUID();
    if (this.sessions.has(id)) {
      throw new Error(`PTY session ${id} already exists.`);
    }
    const process = new IndependentTerminalProcess({
      cwd: request.cwd,
      ...(request.cols !== undefined ? { cols: request.cols } : {}),
      ...(request.rows !== undefined ? { rows: request.rows } : {}),
      ...(request.command ? { command: request.command } : {}),
      ...(request.args ? { args: request.args } : {}),
      ...(request.env ? { env: request.env } : {}),
      onData: (data) => {
        request.onData(id, data);
      },
      onExit: (args) => {
        this.sessions.delete(id);
        request.onExit(id, args);
      },
    });
    const entry: PtySessionRuntimeEntry = {
      id,
      cwd: request.cwd,
      shell: process.shell,
      process,
    };
    this.sessions.set(id, entry);
    return entry;
  }

  async start(request: PtySessionRuntimeStartRequest): Promise<PtySessionRuntimeEntry> {
    const entry = this.create(request);
    try {
      await entry.process.waitUntilReady();
    } catch (error) {
      this.sessions.delete(entry.id);
      await entry.process.close().catch(() => undefined);
      throw error;
    }
    return entry;
  }

  remove(id: string): boolean {
    return this.sessions.delete(id);
  }

  async close(id: string): Promise<boolean> {
    const session = this.sessions.get(id);
    if (!session) {
      return false;
    }
    this.sessions.delete(id);
    await session.process.close();
    return true;
  }

  async closeAll(): Promise<PtySessionRuntimeCloseResult[]> {
    const sessions = this.list();
    this.sessions.clear();
    const results = await Promise.allSettled(
      sessions.map(async (session) => {
        await session.process.close();
      }),
    );
    return results.map((result, index) => {
      const id = sessions[index]?.id ?? "unknown";
      if (result.status === "fulfilled") {
        return { id, status: "fulfilled" };
      }
      return { id, status: "rejected", reason: result.reason };
    });
  }
}

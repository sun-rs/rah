import { createHash, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

import type {
  CreateMuxPaneRequest,
  CreateMuxPaneResult,
  DumpMuxScreenOptions,
  MuxPaneId,
  MuxPaneState,
  MuxPaneSubscription,
  MuxPaneUpdate,
  MuxRuntime,
  MuxSessionState,
  SubscribeMuxPaneOptions,
} from "./mux-runtime";

const DEFAULT_COMMAND_TIMEOUT_MS = 10_000;
const SUBSCRIBE_POLL_INTERVAL_MS = 100;

type ExecResult = {
  stdout: string;
  stderr: string;
};

export class TmuxCommandError extends Error {
  readonly command: string;
  readonly args: string[];
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;

  constructor(params: {
    command: string;
    args: string[];
    stdout?: string;
    stderr?: string;
    exitCode?: number | null;
    cause?: unknown;
  }) {
    const detail = params.stderr?.trim() || params.stdout?.trim() || "tmux command failed";
    super(`${params.command} ${params.args.join(" ")} failed: ${detail}`, {
      cause: params.cause,
    });
    this.name = "TmuxCommandError";
    this.command = params.command;
    this.args = params.args;
    this.stdout = params.stdout ?? "";
    this.stderr = params.stderr ?? "";
    this.exitCode = params.exitCode ?? null;
  }
}

export type TmuxMuxBackendOptions = {
  binary?: string;
  env?: NodeJS.ProcessEnv;
  commandTimeoutMs?: number;
  subscribePollIntervalMs?: number;
};

export function createShortTmuxSessionName(prefix = "rah"): string {
  return `${prefix}-${randomBytes(4).toString("hex")}`;
}

export function createTmuxSessionNameForRahSession(
  rahSessionId: string,
  prefix = "rah",
): string {
  const visiblePrefix = rahSessionId
    .trim()
    .replace(/[^0-9a-z]/gi, "")
    .toLowerCase()
    .slice(0, 8);
  const digest = createHash("sha256").update(rahSessionId).digest("hex").slice(0, 24);
  return `${prefix}-${visiblePrefix ? `${visiblePrefix}-` : ""}${digest}`;
}

function shellQuote(value: string): string {
  if (value.length === 0) {
    return "''";
  }
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function shellCommandForRequest(request: CreateMuxPaneRequest): string {
  const envPrefix = Object.entries(request.env ?? {})
    .filter(([name]) => name.trim().length > 0 && !name.includes("="))
    .map(([name, value]) => `${name}=${shellQuote(value)}`);
  return [
    ...envPrefix,
    shellQuote(request.command),
    ...(request.args ?? []).map((arg) => shellQuote(arg)),
  ].join(" ");
}

function tmuxKeyFor(key: string): string {
  const normalized = key.trim();
  if (/^ctrl\s+/i.test(normalized)) {
    return `C-${normalized.replace(/^ctrl\s+/i, "").trim()}`;
  }
  if (/^esc$/i.test(normalized)) {
    return "Escape";
  }
  if (/^return$/i.test(normalized)) {
    return "Enter";
  }
  return normalized;
}

function isMissingServerOrSession(error: unknown): boolean {
  if (!(error instanceof TmuxCommandError)) {
    return false;
  }
  const text = `${error.stdout}\n${error.stderr}\n${error.message}`;
  return /no server running|can't find session|session not found/i.test(text);
}

function parsePaneLine(line: string): MuxPaneState | null {
  const [
    sessionName,
    windowId,
    windowName,
    paneId,
    paneTitle,
    command,
    cwd,
    active,
    dead,
    deadStatus,
    width,
    height,
  ] = line.split("\t");
  if (!sessionName || !paneId) {
    return null;
  }
  const rows = Number.parseInt(height ?? "", 10);
  const columns = Number.parseInt(width ?? "", 10);
  const tabId = windowId ? Number.parseInt(windowId.replace(/^@/, ""), 10) : null;
  return {
    paneId,
    title: paneTitle ?? "",
    isPlugin: false,
    isFocused: active === "1",
    isFloating: false,
    exited: dead === "1",
    held: dead === "1",
    exitStatus: deadStatus ? Number.parseInt(deadStatus, 10) : null,
    rows: Number.isFinite(rows) ? rows : 0,
    columns: Number.isFinite(columns) ? columns : 0,
    contentRows: Number.isFinite(rows) ? rows : 0,
    contentColumns: Number.isFinite(columns) ? columns : 0,
    ...(command ? { command } : {}),
    ...(cwd ? { cwd } : {}),
    ...(tabId !== null && Number.isFinite(tabId) ? { tabId } : {}),
    ...(windowName ? { tabName: windowName } : {}),
  };
}

export class TmuxMuxBackend implements MuxRuntime {
  private readonly binary: string;
  private readonly baseEnv: NodeJS.ProcessEnv;
  private readonly commandTimeoutMs: number;
  private readonly subscribePollIntervalMs: number;

  constructor(options: TmuxMuxBackendOptions = {}) {
    this.binary = options.binary ?? "tmux";
    this.baseEnv = options.env ?? process.env;
    this.commandTimeoutMs = options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    this.subscribePollIntervalMs = options.subscribePollIntervalMs ?? SUBSCRIBE_POLL_INTERVAL_MS;
  }

  async ensureAvailable(): Promise<void> {
    await this.exec(["-V"]);
  }

  async listSessions(): Promise<MuxSessionState[]> {
    const result = await this.exec(["list-sessions", "-F", "#{session_name}"]).catch((error) => {
      if (isMissingServerOrSession(error)) {
        return { stdout: "", stderr: "" };
      }
      throw error;
    });
    return result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((sessionName) => ({ sessionName }));
  }

  async createSession(request: CreateMuxPaneRequest): Promise<CreateMuxPaneResult> {
    if (!(await this.hasSession(request.sessionName))) {
      return await this.createDetachedSession(request);
    }
    return await this.createProviderPane(request);
  }

  async createProviderPane(request: CreateMuxPaneRequest): Promise<CreateMuxPaneResult> {
    if (!(await this.hasSession(request.sessionName))) {
      return await this.createDetachedSession(request);
    }
    return request.placement === "tab"
      ? await this.newWindow(request)
      : await this.splitPane(request);
  }

  async listPanes(sessionName: string): Promise<MuxPaneState[]> {
    const result = await this.exec([
      "list-panes",
      "-a",
      "-F",
      [
        "#{session_name}",
        "#{window_id}",
        "#{window_name}",
        "#{pane_id}",
        "#{pane_title}",
        "#{pane_current_command}",
        "#{pane_current_path}",
        "#{pane_active}",
        "#{pane_dead}",
        "#{pane_dead_status}",
        "#{pane_width}",
        "#{pane_height}",
      ].join("\t"),
    ]).catch((error) => {
      if (isMissingServerOrSession(error)) {
        return { stdout: "", stderr: "" };
      }
      throw error;
    });
    return result.stdout
      .split(/\r?\n/)
      .map((line) => line.trimEnd())
      .filter((line) => line.startsWith(`${sessionName}\t`))
      .map(parsePaneLine)
      .filter((pane): pane is MuxPaneState => pane !== null);
  }

  async dumpScreen(
    _sessionName: string,
    paneId: MuxPaneId,
    options: DumpMuxScreenOptions = {},
  ): Promise<string> {
    const args = ["capture-pane", "-t", paneId, "-p"];
    if (options.ansi === true) {
      args.push("-e");
    }
    if (options.full === true) {
      args.push("-S", "-");
    }
    return (await this.exec(args)).stdout;
  }

  subscribePane(
    sessionName: string,
    paneId: MuxPaneId,
    onUpdate: (update: MuxPaneUpdate) => void,
    options: SubscribeMuxPaneOptions = {},
  ): MuxPaneSubscription {
    let closed = false;
    let inFlight = false;
    let last = "";
    let initial = true;
    const poll = async () => {
      if (closed || inFlight) {
        return;
      }
      inFlight = true;
      try {
        const dumpOptions: DumpMuxScreenOptions = {
          full: options.scrollback === "all",
          ...(options.ansi === undefined ? {} : { ansi: options.ansi }),
        };
        const dumped = await this.dumpScreen(sessionName, paneId, dumpOptions);
        if (dumped !== last || initial) {
          last = dumped;
          onUpdate({
            paneId,
            initial,
            viewport: dumped.split(/\r?\n/),
          });
          initial = false;
        }
      } catch (error) {
        if (!closed) {
          options.onExit?.({ error: error instanceof Error ? error : new Error(String(error)) });
        }
        closed = true;
        clearInterval(timer);
      } finally {
        inFlight = false;
      }
    };
    const timer = setInterval(() => {
      void poll();
    }, this.subscribePollIntervalMs);
    timer.unref?.();
    void poll();
    return {
      close: () => {
        closed = true;
        clearInterval(timer);
      },
    };
  }

  async writeChars(_sessionName: string, paneId: MuxPaneId, text: string): Promise<void> {
    if (text.length === 0) {
      return;
    }
    await this.exec(["send-keys", "-t", paneId, "-l", text]);
  }

  async writeBytes(sessionName: string, paneId: MuxPaneId, data: string): Promise<void> {
    let literal = "";
    const flushLiteral = async () => {
      if (literal.length === 0) {
        return;
      }
      const next = literal;
      literal = "";
      await this.writeChars(sessionName, paneId, next);
    };
    for (const char of data) {
      if (char === "\r" || char === "\n") {
        await flushLiteral();
        await this.sendKeys(sessionName, paneId, ["Enter"]);
      } else if (char === "\u001b") {
        await flushLiteral();
        await this.sendKeys(sessionName, paneId, ["Escape"]);
      } else if (char === "\u0003") {
        await flushLiteral();
        await this.sendKeys(sessionName, paneId, ["C-c"]);
      } else if (char === "\u0015") {
        await flushLiteral();
        await this.sendKeys(sessionName, paneId, ["C-u"]);
      } else if (char === "\u000b") {
        await flushLiteral();
        await this.sendKeys(sessionName, paneId, ["C-k"]);
      } else if (char === "\u0004") {
        await flushLiteral();
        await this.sendKeys(sessionName, paneId, ["C-d"]);
      } else {
        literal += char;
      }
    }
    await flushLiteral();
  }

  async sendKeys(_sessionName: string, paneId: MuxPaneId, keys: string[]): Promise<void> {
    if (keys.length === 0) {
      return;
    }
    await this.exec(["send-keys", "-t", paneId, ...keys.map(tmuxKeyFor)]);
  }

  async closePane(_sessionName: string, paneId: MuxPaneId): Promise<void> {
    await this.exec(["kill-pane", "-t", paneId]);
  }

  async killSession(sessionName: string): Promise<void> {
    await this.exec(["kill-session", "-t", sessionName]).catch((error) => {
      if (isMissingServerOrSession(error)) {
        return;
      }
      throw error;
    });
  }

  async deleteSession(sessionName: string): Promise<void> {
    await this.killSession(sessionName);
  }

  private async hasSession(sessionName: string): Promise<boolean> {
    return (await this.listSessions()).some((session) => session.sessionName === sessionName);
  }

  private async createDetachedSession(request: CreateMuxPaneRequest): Promise<CreateMuxPaneResult> {
    await this.exec([
      "new-session",
      "-d",
      "-s",
      request.sessionName,
      "-c",
      request.cwd,
      "-n",
      request.title ?? "rah",
      shellCommandForRequest(request),
    ]);
    const pane = await this.waitForSessionPane(request.sessionName, request.title);
    return { sessionName: request.sessionName, paneId: pane.paneId };
  }

  private async newWindow(request: CreateMuxPaneRequest): Promise<CreateMuxPaneResult> {
    const result = await this.exec([
      "new-window",
      "-P",
      "-F",
      "#{pane_id}",
      "-t",
      request.sessionName,
      "-n",
      request.title ?? "rah",
      "-c",
      request.cwd,
      shellCommandForRequest(request),
    ]);
    const paneId = result.stdout.trim();
    if (!paneId) {
      throw new Error("tmux new-window did not return a pane id.");
    }
    return { sessionName: request.sessionName, paneId };
  }

  private async splitPane(request: CreateMuxPaneRequest): Promise<CreateMuxPaneResult> {
    const result = await this.exec([
      "split-window",
      "-P",
      "-F",
      "#{pane_id}",
      "-t",
      request.sessionName,
      "-c",
      request.cwd,
      shellCommandForRequest(request),
    ]);
    const paneId = result.stdout.trim();
    if (!paneId) {
      throw new Error("tmux split-window did not return a pane id.");
    }
    return { sessionName: request.sessionName, paneId };
  }

  private async waitForSessionPane(
    sessionName: string,
    title: string | undefined,
  ): Promise<MuxPaneState> {
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      const panes = await this.listPanes(sessionName).catch(() => []);
      const titled = title ? panes.find((pane) => pane.tabName === title) : undefined;
      const pane = titled ?? panes.find((candidate) => !candidate.exited) ?? panes[0];
      if (pane) {
        return pane;
      }
      await delay(50);
    }
    throw new Error(`Timed out waiting for tmux session ${sessionName} to expose a pane.`);
  }

  private async exec(args: string[]): Promise<ExecResult> {
    return await new Promise<ExecResult>((resolve, reject) => {
      execFile(
        this.binary,
        args,
        {
          env: this.baseEnv,
          timeout: this.commandTimeoutMs,
          maxBuffer: 10 * 1024 * 1024,
          encoding: "utf8",
        },
        (error, stdout, stderr) => {
          if (error) {
            const failed = error as NodeJS.ErrnoException & { code?: number | string | null };
            reject(
              new TmuxCommandError({
                command: this.binary,
                args,
                stdout,
                stderr,
                exitCode: typeof failed.code === "number" ? failed.code : null,
                cause: error,
              }),
            );
            return;
          }
          resolve({ stdout, stderr });
        },
      );
    });
  }
}

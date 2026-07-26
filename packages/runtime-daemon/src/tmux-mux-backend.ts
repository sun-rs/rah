import { createHash, randomBytes } from "node:crypto";
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
import {
  isProcessAlive,
  RAH_TMUX_OWNER_PID_OPTION,
  RAH_TMUX_OWNER_SCOPE_OPTION,
  resolveRahTmuxOwnerScope,
} from "./tmux-session-ownership";
import { resolveBackgroundProcessNice } from "./background-process-priority";
import { runBackgroundCommand } from "./background-command";

const DEFAULT_COMMAND_TIMEOUT_MS = 10_000;
const SUBSCRIBE_POLL_INTERVAL_MS = 100;
const MAX_SUBSCRIBE_POLL_INTERVAL_MS = 1_000;
const MAX_CAPTURE_SCROLLBACK_LINES = 5_000;

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
  maxSubscribePollIntervalMs?: number;
  ownerScope?: string;
  ownerPid?: number;
  backgroundNice?: number;
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

export function createTmuxPaneShellCommand(
  request: CreateMuxPaneRequest,
  backgroundNice = resolveBackgroundProcessNice(),
  platform: NodeJS.Platform = process.platform,
): string {
  const envPrefix = Object.entries(request.env ?? {})
    .filter(([name]) => name.trim().length > 0 && !name.includes("="))
    .map(([name, value]) => `${name}=${shellQuote(value)}`);
  const nice = Math.max(0, Math.min(19, Math.floor(backgroundNice)));
  return [
    ...envPrefix,
    "exec",
    ...(nice > 0 && platform === "darwin"
      ? ["/usr/sbin/taskpolicy", "-b", "nice", "-n", String(nice)]
      : nice > 0
        ? ["nice", "-n", String(nice)]
        : []),
    shellQuote(request.command),
    ...(request.args ?? []).map((arg) => shellQuote(arg)),
  ].join(" ");
}

export function nextTmuxSubscriptionPollInterval(args: {
  currentMs: number;
  changed: boolean;
  minMs: number;
  maxMs: number;
}): number {
  const minMs = Math.max(1, Math.floor(args.minMs));
  const maxMs = Math.max(minMs, Math.floor(args.maxMs));
  if (args.changed) {
    return minMs;
  }
  return Math.min(
    maxMs,
    Math.max(minMs, Math.floor(args.currentMs) * 2),
  );
}

function shellCommandWithRemainOnExit(
  request: CreateMuxPaneRequest,
  backgroundNice: number,
): string {
  return [
    "tmux set-option -w remain-on-exit on >/dev/null 2>&1 || true",
    createTmuxPaneShellCommand(request, backgroundNice),
  ].join("; ");
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
  return /no server running|can't find session|session not found|error connecting to .*no such file/i.test(
    text,
  );
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
  private readonly maxSubscribePollIntervalMs: number;
  private readonly backgroundNice: number;
  private readonly paneSubscriptionWakeups = new Map<string, Set<() => void>>();
  readonly ownerScope: string;
  readonly ownerPid: number;

  constructor(options: TmuxMuxBackendOptions = {}) {
    this.binary = options.binary ?? "tmux";
    this.baseEnv = options.env ?? process.env;
    this.commandTimeoutMs = options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    this.subscribePollIntervalMs = options.subscribePollIntervalMs ?? SUBSCRIBE_POLL_INTERVAL_MS;
    this.maxSubscribePollIntervalMs = Math.max(
      this.subscribePollIntervalMs,
      options.maxSubscribePollIntervalMs ?? MAX_SUBSCRIBE_POLL_INTERVAL_MS,
    );
    this.backgroundNice =
      options.backgroundNice ??
      resolveBackgroundProcessNice(this.baseEnv.RAH_BACKGROUND_PROCESS_NICE);
    this.ownerScope = options.ownerScope ?? resolveRahTmuxOwnerScope(this.baseEnv.RAH_HOME);
    this.ownerPid = options.ownerPid ?? process.pid;
  }

  async ensureAvailable(): Promise<void> {
    await this.exec(["-V"]);
  }

  async listSessions(): Promise<MuxSessionState[]> {
    const result = await this.exec([
      "list-sessions",
      "-F",
      `#{session_name}\t#{${RAH_TMUX_OWNER_SCOPE_OPTION}}\t#{${RAH_TMUX_OWNER_PID_OPTION}}`,
    ]).catch((error) => {
      if (isMissingServerOrSession(error)) {
        return { stdout: "", stderr: "" };
      }
      throw error;
    });
    return result.stdout
      .split(/\r?\n/)
      .map((line) => line.trimEnd())
      .filter((line) => line.trim().length > 0)
      .map((line) => {
        const [sessionName, ownerScope, rawOwnerPid] = line.split("\t");
        const ownerPid = Number.parseInt(rawOwnerPid ?? "", 10);
        return {
          sessionName: sessionName!.trim(),
          ...(ownerScope ? { ownerScope } : {}),
          ...(Number.isInteger(ownerPid) && ownerPid > 0 ? { ownerPid } : {}),
        };
      });
  }

  async claimSessionOwnership(sessionName: string): Promise<boolean> {
    const session = (await this.listSessions()).find(
      (candidate) => candidate.sessionName === sessionName,
    );
    if (!session) {
      return false;
    }
    if (session.ownerScope && session.ownerScope !== this.ownerScope) {
      return false;
    }
    if (
      session.ownerPid &&
      session.ownerPid !== this.ownerPid &&
      isProcessAlive(session.ownerPid)
    ) {
      return false;
    }
    await this.markSessionOwnership(sessionName);
    return true;
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
      args.push("-S", `-${MAX_CAPTURE_SCROLLBACK_LINES}`);
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
    let wakePending = false;
    let last = "";
    let initial = true;
    let pollIntervalMs = this.subscribePollIntervalMs;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unregisterWake = this.registerPaneSubscriptionWakeup(paneId, () => {
      if (closed) {
        return;
      }
      if (inFlight) {
        wakePending = true;
        return;
      }
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      pollIntervalMs = this.subscribePollIntervalMs;
      timer = setTimeout(() => {
        timer = undefined;
        void poll();
      }, 0);
      timer.unref?.();
    });
    const scheduleNextPoll = (delayMs: number) => {
      if (closed) {
        return;
      }
      timer = setTimeout(() => {
        timer = undefined;
        void poll();
      }, delayMs);
      timer.unref?.();
    };
    const poll = async () => {
      if (closed || inFlight) {
        return;
      }
      inFlight = true;
      let changed = false;
      try {
        const dumpOptions: DumpMuxScreenOptions = {
          full: options.scrollback === "all",
          ...(options.ansi === undefined ? {} : { ansi: options.ansi }),
        };
        const dumped = await this.dumpScreen(sessionName, paneId, dumpOptions);
        if (dumped !== last || initial) {
          changed = true;
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
        if (timer) {
          clearTimeout(timer);
          timer = undefined;
        }
        unregisterWake();
      } finally {
        inFlight = false;
        if (!closed) {
          pollIntervalMs = nextTmuxSubscriptionPollInterval({
            currentMs: pollIntervalMs,
            changed: changed || wakePending,
            minMs: this.subscribePollIntervalMs,
            maxMs: this.maxSubscribePollIntervalMs,
          });
          const runImmediately = wakePending;
          wakePending = false;
          scheduleNextPoll(runImmediately ? 0 : pollIntervalMs);
        }
      }
    };
    void poll();
    return {
      close: () => {
        closed = true;
        if (timer) {
          clearTimeout(timer);
          timer = undefined;
        }
        unregisterWake();
      },
    };
  }

  async writeChars(_sessionName: string, paneId: MuxPaneId, text: string): Promise<void> {
    if (text.length === 0) {
      return;
    }
    await this.exec(["send-keys", "-t", paneId, "-l", text]);
    this.wakePaneSubscriptions(paneId);
  }

  async pasteText(_sessionName: string, paneId: MuxPaneId, text: string): Promise<void> {
    if (text.length === 0) {
      return;
    }
    const bufferName = `rah-${randomBytes(8).toString("hex")}`;
    await this.exec(["set-buffer", "-b", bufferName, text]);
    try {
      // `-p` adds bracketed-paste markers when the target application has
      // enabled them, so a terminal composer consumes the prompt atomically.
      await this.exec(["paste-buffer", "-p", "-d", "-b", bufferName, "-t", paneId]);
      this.wakePaneSubscriptions(paneId);
    } catch (error) {
      await this.exec(["delete-buffer", "-b", bufferName]).catch(() => undefined);
      throw error;
    }
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
    this.wakePaneSubscriptions(paneId);
  }

  async resizePane(
    _sessionName: string,
    paneId: MuxPaneId,
    cols: number,
    rows: number,
  ): Promise<void> {
    // RAH's Claude mux sessions are detached single-pane tmux windows.
    // In that shape `resize-pane -x/-y` cannot grow the pane beyond the
    // window's current 80x24-ish size; the window itself must be resized.
    await this.exec([
      "resize-window",
      "-t",
      paneId,
      "-x",
      String(Math.max(20, Math.floor(cols))),
      "-y",
      String(Math.max(8, Math.floor(rows))),
    ]);
    this.wakePaneSubscriptions(paneId);
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

  private registerPaneSubscriptionWakeup(
    paneId: string,
    wake: () => void,
  ): () => void {
    const wakeups = this.paneSubscriptionWakeups.get(paneId) ?? new Set();
    wakeups.add(wake);
    this.paneSubscriptionWakeups.set(paneId, wakeups);
    return () => {
      wakeups.delete(wake);
      if (wakeups.size === 0) {
        this.paneSubscriptionWakeups.delete(paneId);
      }
    };
  }

  private wakePaneSubscriptions(paneId: string): void {
    for (const wake of this.paneSubscriptionWakeups.get(paneId) ?? []) {
      wake();
    }
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
      shellCommandWithRemainOnExit(request, this.backgroundNice),
    ]);
    try {
      await this.markSessionOwnership(request.sessionName);
    } catch (error) {
      await this.killSession(request.sessionName).catch(() => undefined);
      throw error;
    }
    const pane = await this.waitForSessionPane(request.sessionName, request.title);
    return { sessionName: request.sessionName, paneId: pane.paneId };
  }

  private async markSessionOwnership(sessionName: string): Promise<void> {
    await this.exec([
      "set-option",
      "-t",
      sessionName,
      RAH_TMUX_OWNER_SCOPE_OPTION,
      this.ownerScope,
    ]);
    await this.exec([
      "set-option",
      "-t",
      sessionName,
      RAH_TMUX_OWNER_PID_OPTION,
      String(this.ownerPid),
    ]);
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
      shellCommandWithRemainOnExit(request, this.backgroundNice),
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
      shellCommandWithRemainOnExit(request, this.backgroundNice),
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
    try {
      const result = await runBackgroundCommand({
        command: this.binary,
        args,
        env: this.baseEnv,
        label: `tmux ${args[0] ?? "command"}`,
        timeoutMs: this.commandTimeoutMs,
        maxStdoutBytes: 10 * 1024 * 1024,
        maxStderrBytes: 2 * 1024 * 1024,
        allowNonZeroExit: true,
      });
      if (result.code !== 0) {
        throw new TmuxCommandError({
          command: this.binary,
          args,
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.code >= 0 ? result.code : null,
        });
      }
      return { stdout: result.stdout, stderr: result.stderr };
    } catch (error) {
      if (error instanceof TmuxCommandError) {
        throw error;
      }
      throw new TmuxCommandError({
        command: this.binary,
        args,
        cause: error,
      });
    }
  }
}

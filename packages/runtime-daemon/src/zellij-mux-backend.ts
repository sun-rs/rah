import { createHash, randomBytes } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdirSync } from "node:fs";
import { createInterface } from "node:readline";

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

const DEFAULT_ZELLIJ_SOCKET_DIR = "/tmp/rah-zellij-sock";
const ZELLIJ_SOCKET_DIR_ENV = "RAH_ZELLIJ_SOCKET_DIR";
const DEFAULT_COMMAND_TIMEOUT_MS = 10_000;

type ExecResult = {
  stdout: string;
  stderr: string;
};

type RawZellijPane = {
  id?: unknown;
  is_plugin?: unknown;
  is_focused?: unknown;
  is_floating?: unknown;
  title?: unknown;
  exited?: unknown;
  exit_status?: unknown;
  is_held?: unknown;
  pane_rows?: unknown;
  pane_columns?: unknown;
  pane_content_rows?: unknown;
  pane_content_columns?: unknown;
  pane_command?: unknown;
  pane_cwd?: unknown;
  tab_id?: unknown;
  tab_name?: unknown;
};

type RawZellijPaneUpdate = {
  event?: unknown;
  is_initial?: unknown;
  pane_id?: unknown;
  viewport?: unknown;
  scrollback?: unknown;
};

export class ZellijCommandError extends Error {
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
    const detail = params.stderr?.trim() || params.stdout?.trim() || "zellij command failed";
    super(`${params.command} ${params.args.join(" ")} failed: ${detail}`, {
      cause: params.cause,
    });
    this.name = "ZellijCommandError";
    this.command = params.command;
    this.args = params.args;
    this.stdout = params.stdout ?? "";
    this.stderr = params.stderr ?? "";
    this.exitCode = params.exitCode ?? null;
  }
}

export type ZellijMuxBackendOptions = {
  binary?: string;
  socketDir?: string;
  env?: NodeJS.ProcessEnv;
  commandTimeoutMs?: number;
};

export function createShortZellijSessionName(prefix = "rah"): string {
  return `${prefix}-${randomBytes(4).toString("hex")}`;
}

export function createZellijSessionNameForRahSession(
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

function paneIdFor(raw: RawZellijPane): MuxPaneId {
  const id = typeof raw.id === "number" ? raw.id : Number(raw.id);
  const prefix = raw.is_plugin === true ? "plugin" : "terminal";
  return `${prefix}_${Number.isFinite(id) ? id : "unknown"}`;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
}

function outputMentionsMissingSession(value: string): boolean {
  return /Session '[^']+' not found|There is no active session/i.test(stripAnsi(value));
}

function normalizePane(raw: RawZellijPane): MuxPaneState {
  const command = optionalString(raw.pane_command);
  const cwd = optionalString(raw.pane_cwd);
  const tabId = optionalNumber(raw.tab_id);
  const tabName = optionalString(raw.tab_name);
  return {
    paneId: paneIdFor(raw),
    title: optionalString(raw.title) ?? "",
    isPlugin: raw.is_plugin === true,
    isFocused: raw.is_focused === true,
    isFloating: raw.is_floating === true,
    exited: raw.exited === true,
    held: raw.is_held === true,
    exitStatus: optionalNumber(raw.exit_status) ?? null,
    rows: optionalNumber(raw.pane_rows) ?? 0,
    columns: optionalNumber(raw.pane_columns) ?? 0,
    contentRows: optionalNumber(raw.pane_content_rows) ?? 0,
    contentColumns: optionalNumber(raw.pane_content_columns) ?? 0,
    ...(command !== undefined ? { command } : {}),
    ...(cwd !== undefined ? { cwd } : {}),
    ...(tabId !== undefined ? { tabId } : {}),
    ...(tabName !== undefined ? { tabName } : {}),
  };
}

function normalizePaneUpdate(raw: RawZellijPaneUpdate): MuxPaneUpdate | null {
  if (raw.event !== "pane_update" || typeof raw.pane_id !== "string") {
    return null;
  }
  const viewport = Array.isArray(raw.viewport)
    ? raw.viewport.filter((line): line is string => typeof line === "string")
    : [];
  const scrollback = Array.isArray(raw.scrollback)
    ? raw.scrollback.filter((line): line is string => typeof line === "string")
    : undefined;
  return {
    paneId: raw.pane_id,
    initial: raw.is_initial === true,
    viewport,
    ...(scrollback !== undefined ? { scrollback } : {}),
  };
}

export class ZellijMuxBackend implements MuxRuntime {
  private readonly binary: string;
  private readonly socketDir: string;
  private readonly baseEnv: NodeJS.ProcessEnv;
  private readonly commandTimeoutMs: number;

  constructor(options: ZellijMuxBackendOptions = {}) {
    this.binary = options.binary ?? "zellij";
    this.baseEnv = options.env ?? process.env;
    const envSocketDir = this.baseEnv[ZELLIJ_SOCKET_DIR_ENV]?.trim();
    this.socketDir =
      options.socketDir ?? (envSocketDir && envSocketDir.length > 0
        ? envSocketDir
        : DEFAULT_ZELLIJ_SOCKET_DIR);
    this.commandTimeoutMs = options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  }

  getSocketDir(): string {
    return this.socketDir;
  }

  async ensureAvailable(): Promise<void> {
    await this.exec(["--version"]);
  }

  async createSession(request: CreateMuxPaneRequest): Promise<CreateMuxPaneResult> {
    return await this.createProviderPane(request);
  }

  async listSessions(): Promise<MuxSessionState[]> {
    const result = await this.exec(["list-sessions", "--short", "--no-formatting"]);
    return result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((sessionName) => ({ sessionName }));
  }

  async createProviderPane(request: CreateMuxPaneRequest): Promise<CreateMuxPaneResult> {
    await this.ensureSession(request.sessionName);
    await this.closeStartupFloatingPanes(request.sessionName);
    const paneId = await this.runPane(request);
    if (request.replaceDefaultPane === true) {
      await this.closePane(request.sessionName, "terminal_0").catch(() => undefined);
    }
    return { sessionName: request.sessionName, paneId };
  }

  async listPanes(sessionName: string): Promise<MuxPaneState[]> {
    const args = [
      "--session",
      sessionName,
      "action",
      "list-panes",
      "--json",
      "--all",
      "--command",
      "--geometry",
      "--state",
      "--tab",
    ];
    const result = await this.exec(args);
    if (outputMentionsMissingSession(result.stdout) || outputMentionsMissingSession(result.stderr)) {
      throw new ZellijCommandError({
        command: this.binary,
        args,
        stdout: result.stdout,
        stderr: result.stderr,
      });
    }
    const parsed = JSON.parse(result.stdout) as unknown;
    if (!Array.isArray(parsed)) {
      throw new Error("zellij list-panes returned a non-array payload.");
    }
    return parsed.map((pane) => normalizePane(pane as RawZellijPane));
  }

  async dumpScreen(
    sessionName: string,
    paneId: MuxPaneId,
    options: DumpMuxScreenOptions = {},
  ): Promise<string> {
    const args = ["--session", sessionName, "action", "dump-screen", "--pane-id", paneId];
    if (options.full === true) {
      args.push("--full");
    }
    if (options.ansi === true) {
      args.push("--ansi");
    }
    return (await this.exec(args)).stdout;
  }

  subscribePane(
    sessionName: string,
    paneId: MuxPaneId,
    onUpdate: (update: MuxPaneUpdate) => void,
    options: SubscribeMuxPaneOptions = {},
  ): MuxPaneSubscription {
    const args = ["--session", sessionName, "subscribe", "--pane-id", paneId, "--format", "json"];
    if (options.ansi === true) {
      args.push("--ansi");
    }
    if (options.scrollback !== undefined) {
      args.push("--scrollback");
      if (options.scrollback !== "all") {
        args.push(String(options.scrollback));
      }
    }
    const child = this.spawn(args);
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      if (!line.trim()) {
        return;
      }
      try {
        const update = normalizePaneUpdate(JSON.parse(line) as RawZellijPaneUpdate);
        if (update) {
          onUpdate(update);
        }
      } catch {
        // Ignore malformed subscription frames; the next zellij frame can still
        // bring the terminal snapshot back in sync.
      }
    });
    return {
      close: () => {
        lines.close();
        child.kill("SIGTERM");
      },
    };
  }

  async writeChars(sessionName: string, paneId: MuxPaneId, text: string): Promise<void> {
    await this.exec([
      "--session",
      sessionName,
      "action",
      "write-chars",
      "--pane-id",
      paneId,
      text,
    ]);
  }

  async sendKeys(sessionName: string, paneId: MuxPaneId, keys: string[]): Promise<void> {
    if (keys.length === 0) {
      return;
    }
    await this.exec([
      "--session",
      sessionName,
      "action",
      "send-keys",
      "--pane-id",
      paneId,
      ...keys,
    ]);
  }

  async closePane(sessionName: string, paneId: MuxPaneId): Promise<void> {
    await this.exec(["--session", sessionName, "action", "close-pane", "--pane-id", paneId]);
  }

  async killSession(sessionName: string): Promise<void> {
    await this.exec(["kill-session", sessionName]);
  }

  private async ensureSession(sessionName: string): Promise<void> {
    await this.exec(["attach", "-b", sessionName]);
  }

  private async closeStartupFloatingPanes(sessionName: string): Promise<void> {
    const panes = await this.listPanes(sessionName).catch(() => []);
    await Promise.allSettled(
      panes
        .filter((pane) => pane.isPlugin && pane.isFloating)
        .map((pane) => this.closePane(sessionName, pane.paneId)),
    );
  }

  private async runPane(request: CreateMuxPaneRequest): Promise<MuxPaneId> {
    const args = ["--session", request.sessionName, "run"];
    if (request.title) {
      args.push("--name", request.title);
    }
    args.push("--cwd", request.cwd, "--", request.command, ...(request.args ?? []));
    const result = await this.exec(args);
    const paneId = result.stdout.trim();
    if (!paneId) {
      throw new Error("zellij run did not return a pane id.");
    }
    return paneId;
  }

  private zellijEnv(): NodeJS.ProcessEnv {
    mkdirSync(this.socketDir, { recursive: true });
    return {
      ...this.baseEnv,
      ZELLIJ_SOCKET_DIR: this.socketDir,
    };
  }

  private async exec(args: string[]): Promise<ExecResult> {
    return await new Promise<ExecResult>((resolve, reject) => {
      execFile(
        this.binary,
        args,
        {
          env: this.zellijEnv(),
          timeout: this.commandTimeoutMs,
          maxBuffer: 10 * 1024 * 1024,
          encoding: "utf8",
        },
        (error, stdout, stderr) => {
          if (error) {
            const failed = error as NodeJS.ErrnoException & { code?: number | string | null };
            reject(
              new ZellijCommandError({
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

  private spawn(args: string[]): ChildProcessWithoutNullStreams {
    return spawn(this.binary, args, {
      env: this.zellijEnv(),
    });
  }
}

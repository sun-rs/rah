import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ProviderKind, StartSessionRequest } from "@rah/runtime-protocol";
import { IndependentTerminalProcess } from "../packages/runtime-daemon/src/independent-terminal";
import { nativeTuiStartLaunchSpec } from "../packages/runtime-daemon/src/native-tui-launch-spec";

type ProbeProvider = Extract<
  ProviderKind,
  "codex" | "claude" | "gemini" | "kimi" | "opencode"
>;

type ProviderProbeResult = {
  provider: ProbeProvider;
  ok: boolean;
  cwd: string;
  launchPreview?: string;
  outputObserved: boolean;
  rawOutputObserved: boolean;
  visibleOutputObserved: boolean;
  outputBytes: number;
  visibleOutputLength: number;
  outputPreview: string;
  error?: string;
  exit?: {
    exitCode?: number;
    signal?: string;
  };
};

type RahProbeMetadata = {
  branch: string | null;
  commit: string | null;
  dirty: boolean | null;
  changedFiles: number | null;
};

const ALL_PROVIDERS: ProbeProvider[] = [
  "codex",
  "claude",
  "gemini",
  "kimi",
  "opencode",
];

const SETTLE_MS = Number(process.env.RAH_NATIVE_REAL_TUI_PROBE_SETTLE_MS ?? 3_000);
const CLOSE_TIMEOUT_MS = Number(process.env.RAH_NATIVE_REAL_TUI_PROBE_CLOSE_TIMEOUT_MS ?? 4_000);
const ALLOW_FAILURES = process.env.RAH_NATIVE_REAL_TUI_PROBE_ALLOW_FAILURES === "1";
const OUTPUT_PATH = process.env.RAH_NATIVE_REAL_TUI_PROBE_OUTPUT?.trim() || null;
const WORKSPACE_ROOT =
  process.env.RAH_NATIVE_REAL_TUI_PROBE_WORKSPACE_ROOT?.trim() ||
  join(process.cwd(), "test-results", "native-real-tui-workspaces");

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function selectedProviders(): ProbeProvider[] {
  const raw = process.env.RAH_NATIVE_REAL_TUI_PROBE_PROVIDERS?.trim();
  if (!raw) {
    return ALL_PROVIDERS;
  }
  const selected = raw
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  const unknown = selected.filter(
    (provider): provider is string => !ALL_PROVIDERS.includes(provider as ProbeProvider),
  );
  if (unknown.length > 0) {
    throw new Error(`Unknown provider(s): ${unknown.join(", ")}`);
  }
  return selected as ProbeProvider[];
}

function previewOutput(output: string): string {
  const normalized = normalizeOutput(output);
  return normalized.length <= 1_600 ? normalized : `${normalized.slice(0, 1_600)}...`;
}

function normalizeOutput(output: string): string {
  return output
    .replace(/\x1bP[\s\S]*?\x1b\\/g, "")
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b[78]/g, "")
    .replace(/\x1b\[[0-9;?<=>]*[ -/]*[@-~]/g, "")
    .replace(/\r/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function readGitField(args: string[]): string | null {
  try {
    return execFileSync("git", args, {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim() || null;
  } catch {
    return null;
  }
}

function readRahMetadata(): RahProbeMetadata {
  const status = readGitField(["status", "--short"]);
  return {
    branch: readGitField(["rev-parse", "--abbrev-ref", "HEAD"]),
    commit: readGitField(["rev-parse", "--short", "HEAD"]),
    dirty: status === null ? null : status.length > 0,
    changedFiles: status === null || status.length === 0 ? 0 : status.split(/\r?\n/).length,
  };
}

function timeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      timer.unref?.();
    }),
  ]).finally(() => {
    if (timer) {
      clearTimeout(timer);
    }
  });
}

function writeReport(reportPath: string | null, report: unknown): void {
  if (!reportPath) {
    return;
  }
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

async function closeTerminal(process: IndependentTerminalProcess | null): Promise<void> {
  if (!process) {
    return;
  }
  await timeout(process.close(), CLOSE_TIMEOUT_MS, "native TUI close").catch(() => undefined);
}

async function probeProvider(provider: ProbeProvider): Promise<ProviderProbeResult> {
  const cwd = join(WORKSPACE_ROOT, provider);
  mkdirSync(cwd, { recursive: true });
  let process: IndependentTerminalProcess | null = null;
  let output = "";
  let exit: ProviderProbeResult["exit"] | undefined;

  try {
    const request: StartSessionRequest = {
      provider,
      cwd,
      liveBackend: "native_tui",
      title: `RAH real native TUI launch probe ${provider} ${randomUUID()}`,
    };
    const launch = await nativeTuiStartLaunchSpec(request);
    process = new IndependentTerminalProcess({
      cwd: launch.cwd,
      command: launch.command,
      args: launch.args,
      ...(launch.env ? { env: launch.env } : {}),
      cols: 100,
      rows: 32,
      onData: (data) => {
        output += data;
      },
      onExit: (args) => {
        exit = args;
      },
    });
    await timeout(process.waitUntilReady(), 10_000, `${provider} terminal host ready`);
    await sleep(SETTLE_MS);

    const ok = exit === undefined;
    const normalizedOutput = normalizeOutput(output);
    await closeTerminal(process);
    process = null;

    return {
      provider,
      ok,
      cwd,
      launchPreview: launch.preview,
      outputObserved: output.trim().length > 0,
      rawOutputObserved: output.trim().length > 0,
      visibleOutputObserved: normalizedOutput.length > 0,
      outputBytes: Buffer.byteLength(output, "utf8"),
      visibleOutputLength: normalizedOutput.length,
      outputPreview: previewOutput(output),
      ...(exit ? { exit } : {}),
      ...(!ok ? { error: "Provider TUI exited during launch settle window." } : {}),
    };
  } catch (error) {
    await closeTerminal(process);
    const normalizedOutput = normalizeOutput(output);
    return {
      provider,
      ok: false,
      cwd,
      outputObserved: output.trim().length > 0,
      rawOutputObserved: output.trim().length > 0,
      visibleOutputObserved: normalizedOutput.length > 0,
      outputBytes: Buffer.byteLength(output, "utf8"),
      visibleOutputLength: normalizedOutput.length,
      outputPreview: previewOutput(output),
      ...(exit ? { exit } : {}),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function main(): Promise<void> {
  const providers = selectedProviders();
  const results: ProviderProbeResult[] = [];
  for (const provider of providers) {
    results.push(await probeProvider(provider));
  }
  const ok = results.every((result) => result.ok) || ALLOW_FAILURES;
  const report = {
    ok,
    settleMs: SETTLE_MS,
    rah: readRahMetadata(),
    asserted: [
      "real provider native TUI launch spec starts inside RAH PTY host",
      "real provider native TUI does not exit during the launch settle window",
      "real provider native TUI can be closed by RAH PTY host without sending a model prompt",
    ],
    results,
    notes: [
      "This probe launches real provider CLIs but does not send a prompt, so it does not prove model response, permissions, quota, login, or long-running turn behavior.",
      "Some providers may still create empty local history/session metadata during startup.",
    ],
  };
  writeReport(OUTPUT_PATH, report);
  console.log(JSON.stringify(report, null, 2));
  if (!ok) {
    process.exitCode = 1;
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});

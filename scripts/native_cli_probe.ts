import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { ProviderKind } from "@rah/runtime-protocol";
import { launchSpecForProvider } from "../packages/runtime-daemon/src/provider-diagnostics";

type ProbeCommand = {
  label: string;
  args: string[];
  requiredFragments: string[];
};

type ProviderProbeConfig = {
  provider: Extract<ProviderKind, "codex" | "claude" | "opencode">;
  versionArgs: string[];
  probes: ProbeCommand[];
};

type CommandProbeResult = {
  label: string;
  argv: string[];
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  missingFragments: string[];
  outputPreview: string;
};

type ProviderProbeResult = {
  provider: ProviderProbeConfig["provider"];
  launchCommand?: string;
  ok: boolean;
  missingBinary?: boolean;
  error?: string;
  version?: CommandProbeResult;
  commands: CommandProbeResult[];
};

const PROVIDERS: ProviderProbeConfig[] = [
  {
    provider: "codex",
    versionArgs: ["--version"],
    probes: [
      {
        label: "root help",
        args: ["--help"],
        requiredFragments: [
          "--cd",
          "--model",
          "--ask-for-approval",
          "--sandbox",
          "--dangerously-bypass-approvals-and-sandbox",
          "resume",
        ],
      },
      {
        label: "resume help",
        args: ["resume", "--help"],
        requiredFragments: ["--cd", "--model"],
      },
    ],
  },
  {
    provider: "claude",
    versionArgs: ["--version"],
    probes: [
      {
        label: "root help",
        args: ["--help"],
        requiredFragments: [
          "--session-id",
          "--resume",
          "--permission-mode",
          "--model",
          "--effort",
        ],
      },
    ],
  },
  {
    provider: "opencode",
    versionArgs: ["--version"],
    probes: [
      {
        label: "root help",
        args: ["--help"],
        requiredFragments: ["--session", "--model"],
      },
    ],
  },
];

const TIMEOUT_MS = Number(process.env.RAH_NATIVE_CLI_PROBE_TIMEOUT_MS ?? 7_000);
const ALLOW_MISSING = process.env.RAH_NATIVE_CLI_PROBE_ALLOW_MISSING === "1";
const OUTPUT_PATH = process.env.RAH_NATIVE_CLI_PROBE_OUTPUT?.trim() || null;

type RahProbeMetadata = {
  branch: string | null;
  commit: string | null;
  dirty: boolean | null;
  changedFiles: number | null;
};

function readGitField(args: string[]): string | null {
  try {
    return execFileSync("git", args, {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
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

function outputPreview(output: string): string {
  const normalized = output.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").trim();
  if (normalized.length <= 1_600) {
    return normalized;
  }
  return `${normalized.slice(0, 1_600)}…`;
}

function writeProbeReport(reportPath: string | undefined, report: unknown): void {
  if (!reportPath) {
    return;
  }
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

function runProbeCommand(command: string, args: string[]): Promise<{
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  output: string;
}> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks: Buffer[] = [];
    let settled = false;
    const finish = (result: {
      exitCode: number | null;
      signal: string | null;
      timedOut: boolean;
    }) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve({
        ...result,
        output: Buffer.concat(chunks).toString("utf8"),
      });
    };
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish({ exitCode: null, signal: "SIGTERM", timedOut: true });
    }, TIMEOUT_MS);
    timer.unref?.();
    child.stdout.on("data", (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    child.stderr.on("data", (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    child.once("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (exitCode, signal) => {
      finish({ exitCode, signal, timedOut: false });
    });
  });
}

async function probeProvider(config: ProviderProbeConfig): Promise<ProviderProbeResult> {
  let launchSpec: { argv: string[] } | null;
  try {
    launchSpec = await launchSpecForProvider(config.provider);
  } catch (error) {
    return {
      provider: config.provider,
      ok: ALLOW_MISSING,
      missingBinary: true,
      error: error instanceof Error ? error.message : String(error),
      commands: [],
    };
  }
  if (!launchSpec?.argv.length) {
    return {
      provider: config.provider,
      ok: ALLOW_MISSING,
      missingBinary: true,
      error: "No launch command resolved.",
      commands: [],
    };
  }
  const [command, ...baseArgs] = launchSpec.argv;
  if (!command) {
    return {
      provider: config.provider,
      ok: ALLOW_MISSING,
      missingBinary: true,
      error: "No launch command resolved.",
      commands: [],
    };
  }
  const probeCommand = async (
    label: string,
    args: string[],
    requiredFragments: string[],
  ): Promise<CommandProbeResult> => {
    try {
      const result = await runProbeCommand(command, args);
      const missingFragments = requiredFragments.filter(
        (fragment) => !result.output.includes(fragment),
      );
      return {
        label,
        argv: [command, ...args],
        exitCode: result.exitCode,
        signal: result.signal,
        timedOut: result.timedOut,
        missingFragments,
        outputPreview: outputPreview(result.output),
      };
    } catch (error) {
      return {
        label,
        argv: [command, ...args],
        exitCode: null,
        signal: null,
        timedOut: false,
        missingFragments: requiredFragments,
        outputPreview: error instanceof Error ? error.message : String(error),
      };
    }
  };
  const version = await probeCommand("version", [...baseArgs, ...config.versionArgs], []);
  const commands: CommandProbeResult[] = [];
  for (const probe of config.probes) {
    const args = [...baseArgs, ...probe.args];
    commands.push(await probeCommand(probe.label, args, probe.requiredFragments));
  }
  return {
    provider: config.provider,
    launchCommand: launchSpec.argv.join(" "),
    ok: commands.every(
      (commandResult) =>
        !commandResult.timedOut &&
        commandResult.exitCode === 0 &&
        commandResult.missingFragments.length === 0,
    ) && !version.timedOut && version.exitCode === 0,
    version,
    commands,
  };
}

async function main(): Promise<number> {
  const results = await Promise.all(PROVIDERS.map(probeProvider));
  const ok = results.every((result) => result.ok);
  const reportPath = OUTPUT_PATH ? resolve(OUTPUT_PATH) : undefined;
  const report = {
    ok,
    ...(reportPath ? { reportPath } : {}),
    rah: readRahMetadata(),
    asserted: [
      "native TUI launch commands resolve through RAH provider launch specs",
      "real provider --version output is captured for upgrade drift audits",
      "RAH branch, commit, and dirty worktree state are captured for QA traceability",
      "real provider --help output still exposes every flag used by native TUI launch",
      "real provider --help probes must exit cleanly instead of only printing matching text",
      "missing provider binaries fail unless RAH_NATIVE_CLI_PROBE_ALLOW_MISSING=1",
    ],
    results,
  };
  writeProbeReport(reportPath, report);
  console.log(JSON.stringify(report, null, 2));
  return ok ? 0 : 1;
}

void main().then((code) => {
  process.exitCode = code;
});

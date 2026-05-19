import { spawn } from "node:child_process";

interface SmokeResult {
  ok: boolean;
  provider?: string;
  browser?: string;
  headless?: boolean;
  caseIds?: string[];
  screenshots?: string[];
  asserted?: string[];
  error?: string;
}

interface SmokeCommand {
  name: string;
  command: string;
  args: string[];
}

const COMMANDS: SmokeCommand[] = [
  {
    name: "real-codex-browser",
    command: "bash",
    args: ["scripts/codex-browser-smoke.sh"],
  },
  {
    name: "real-claude-browser",
    command: "bash",
    args: ["scripts/claude-browser-smoke.sh"],
  },
  {
    name: "real-opencode-browser",
    command: "bash",
    args: ["scripts/opencode-browser-smoke.sh"],
  },
];

const STRUCTURED_PROVIDER_CASE_IDS = [
  "REAL-PROVIDER-001",
  "REAL-CHAT-ORDER-001",
  "REAL-CHAT-UNIQUE-001",
  "REAL-STOP-NORMAL-IDLE-001",
  "REAL-INTERRUPT-ONCE-001",
  "REAL-INTERRUPT-RECOVERY-001",
  "REAL-INTERRUPT-MULTI-TURN-001",
  "REAL-HISTORY-REPLAY-001",
  "REAL-HISTORY-CLAIM-001",
  "REAL-SECOND-TURN-001",
] as const;

const CLAUDE_TMUX_CASE_IDS = [
  "REAL-PROVIDER-001",
  "REAL-CLAUDE-TMUX-MIRROR-001",
  "REAL-CLAUDE-PASSTHROUGH-001",
  "REAL-CLAUDE-ESC-BEST-EFFORT-001",
  "REAL-CLAUDE-NO-SYNTHETIC-INTERRUPT-001",
  "REAL-CLAUDE-HISTORY-REPLAY-001",
  "REAL-CLAUDE-HISTORY-CLAIM-001",
  "REAL-CLAUDE-SECOND-TURN-001",
] as const;

const REQUIRED_PROVIDERS = ["codex", "claude", "opencode"] as const;

function runSmoke(command: SmokeCommand): Promise<{ command: SmokeCommand; result: SmokeResult }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command.command, command.args, {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      process.stdout.write(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      process.stderr.write(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      const result = parseSmokeJson(stdout);
      if (code !== 0) {
        reject(
          new Error(
            `${command.name} failed with exit code ${code}. ${
              result?.error ? `reported error: ${result.error}` : stderr.trim()
            }`,
          ),
        );
        return;
      }
      if (!result?.ok) {
        reject(new Error(`${command.name} did not report ok=true`));
        return;
      }
      resolve({ command, result });
    });
  });
}

function parseSmokeJson(stdout: string): SmokeResult | null {
  const trimmed = stdout.trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end < start) {
    return null;
  }
  return JSON.parse(trimmed.slice(start, end + 1)) as SmokeResult;
}

function validateCoverage(results: readonly { command: SmokeCommand; result: SmokeResult }[]): void {
  const providers = new Set(results.map(({ result }) => result.provider).filter(Boolean));
  for (const provider of REQUIRED_PROVIDERS) {
    if (!providers.has(provider)) {
      throw new Error(`real browser regression gate missing provider: ${provider}`);
    }
  }

  for (const { result } of results) {
    const covered = new Set<string>();
    for (const id of result.caseIds ?? []) {
      covered.add(id);
    }
    const required =
      result.provider === "claude" ? CLAUDE_TMUX_CASE_IDS : STRUCTURED_PROVIDER_CASE_IDS;
    const missing = required.filter((id) => !covered.has(id));
    if (missing.length > 0) {
      throw new Error(
        `real browser regression gate for ${result.provider ?? "unknown provider"} missing required case ids: ${missing.join(", ")}`,
      );
    }
  }
}

function summarize(results: readonly { command: SmokeCommand; result: SmokeResult }[]): string {
  const lines = ["Real browser regression gate passed."];
  for (const { command, result } of results) {
    lines.push(
      `- ${command.name}: provider=${result.provider ?? "unknown"} browser=${result.browser ?? "unknown"} headless=${String(
        result.headless,
      )} cases=${result.caseIds?.length ?? 0} screenshots=${result.screenshots?.length ?? 0}`,
    );
  }
  const covered = [...new Set(results.flatMap(({ result }) => result.caseIds ?? []))].sort();
  lines.push(`Covered case ids: ${covered.join(", ")}`);
  return lines.join("\n");
}

const results = [];
for (const command of COMMANDS) {
  results.push(await runSmoke(command));
}
validateCoverage(results);
console.log(summarize(results));

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

type Provider = "codex" | "claude" | "gemini" | "kimi" | "opencode";

type RahMetadata = {
  branch: string | null;
  commit: string | null;
  dirty: boolean | null;
  changedFiles: number | null;
};

type CheckResult = {
  ok: boolean;
  blockers: string[];
  details: Record<string, unknown>;
};

const PROVIDERS: Provider[] = ["codex", "claude", "gemini", "kimi", "opencode"];
const CLI_PROBE_PATH = resolve(
  process.env.RAH_NATIVE_CLI_PROBE_OUTPUT?.trim() || "test-results/native-cli-probe.json",
);
const REAL_TUI_PROBE_PATH = resolve(
  process.env.RAH_NATIVE_REAL_TUI_PROBE_OUTPUT?.trim() ||
    "test-results/native-real-tui-launch.json",
);
const OUTPUT_PATH = process.env.RAH_NATIVE_QA_STATUS_OUTPUT?.trim()
  ? resolve(process.env.RAH_NATIVE_QA_STATUS_OUTPUT)
  : null;

const MANUAL_QA_REQUIRED = [
  "Real model response and long-running turn behavior for all providers.",
  "Real permission / trust-folder / login / quota / 429 flows.",
  "Codex /goal behavior inside the official TUI.",
  "Claude permission prompt and trust-folder confirmation.",
  "Gemini Google login and quota/error surfaces.",
  "Kimi long-running turn behavior.",
  "OpenCode real resume/model/interrupt behavior.",
  "iPad/Safari real keyboard composition and terminal resize behavior.",
  "iPad/Safari terminal canvas tap and input bridge tap keyboard anchoring behavior.",
  "iPad/Safari terminal typography, Chinese spacing, line height, and light/dark theme behavior.",
  "iPad/Safari rotation, split resize, PWA background, and LAN WebSocket replay behavior.",
];

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

function readRahMetadata(): RahMetadata {
  const status = readGitField(["status", "--short"]);
  return {
    branch: readGitField(["rev-parse", "--abbrev-ref", "HEAD"]),
    commit: readGitField(["rev-parse", "--short", "HEAD"]),
    dirty: status === null ? null : status.length > 0,
    changedFiles: status === null || status.length === 0 ? 0 : status.split(/\r?\n/).length,
  };
}

function readJsonFile(path: string): { value?: unknown; error?: string } {
  if (!existsSync(path)) {
    return { error: `Missing report: ${path}` };
  }
  try {
    return { value: JSON.parse(readFileSync(path, "utf8")) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

function reportRahMetadata(value: unknown): RahMetadata | null {
  if (!value || typeof value !== "object" || !("rah" in value)) {
    return null;
  }
  const rah = (value as { rah?: unknown }).rah;
  return rah && typeof rah === "object" ? (rah as RahMetadata) : null;
}

function providerResultMap(value: unknown): Map<string, Record<string, unknown>> {
  if (!value || typeof value !== "object" || !("results" in value)) {
    return new Map();
  }
  const results = (value as { results?: unknown }).results;
  if (!Array.isArray(results)) {
    return new Map();
  }
  return new Map(
    results
      .filter((result): result is Record<string, unknown> => {
        return Boolean(result) && typeof result === "object" && "provider" in result;
      })
      .map((result) => [String(result.provider), result]),
  );
}

function checkReportMetadata(
  label: string,
  report: unknown,
  current: RahMetadata,
  blockers: string[],
): void {
  const rah = reportRahMetadata(report);
  if (!rah) {
    blockers.push(`${label} report does not include RAH metadata.`);
    return;
  }
  if (current.commit && rah.commit && rah.commit !== current.commit) {
    blockers.push(
      `${label} report commit ${rah.commit} does not match current commit ${current.commit}.`,
    );
  }
}

function checkCliProbe(path: string, current: RahMetadata): CheckResult {
  const blockers: string[] = [];
  const loaded = readJsonFile(path);
  if (loaded.error) {
    return { ok: false, blockers: [loaded.error], details: { path } };
  }
  const report = loaded.value;
  const reportObject = report && typeof report === "object" ? (report as Record<string, unknown>) : {};
  if (reportObject.ok !== true) {
    blockers.push("native CLI probe report is not ok.");
  }
  checkReportMetadata("native CLI probe", report, current, blockers);

  const byProvider = providerResultMap(report);
  const providers = PROVIDERS.map((provider) => {
    const result = byProvider.get(provider);
    const commands = Array.isArray(result?.commands) ? result.commands : [];
    const version =
      result?.version && typeof result.version === "object"
        ? String((result.version as Record<string, unknown>).outputPreview ?? "")
        : "";
    if (!result) {
      blockers.push(`native CLI probe is missing ${provider}.`);
    } else if (result.ok !== true) {
      blockers.push(`native CLI probe failed for ${provider}.`);
    }
    for (const command of commands) {
      if (!command || typeof command !== "object") {
        continue;
      }
      const item = command as Record<string, unknown>;
      if (item.exitCode !== 0) {
        blockers.push(`${provider} help probe ${String(item.label)} exited with ${String(item.exitCode)}.`);
      }
      if (Array.isArray(item.missingFragments) && item.missingFragments.length > 0) {
        blockers.push(
          `${provider} help probe ${String(item.label)} is missing fragments: ${item.missingFragments.join(", ")}.`,
        );
      }
    }
    return {
      provider,
      ok: result?.ok === true,
      version,
      commandCount: commands.length,
    };
  });

  return {
    ok: blockers.length === 0,
    blockers,
    details: {
      path,
      providers,
    },
  };
}

function checkRealTuiProbe(path: string, current: RahMetadata): CheckResult {
  const blockers: string[] = [];
  const loaded = readJsonFile(path);
  if (loaded.error) {
    return { ok: false, blockers: [loaded.error], details: { path } };
  }
  const report = loaded.value;
  const reportObject = report && typeof report === "object" ? (report as Record<string, unknown>) : {};
  if (reportObject.ok !== true) {
    blockers.push("real TUI launch probe report is not ok.");
  }
  checkReportMetadata("real TUI launch probe", report, current, blockers);

  const byProvider = providerResultMap(report);
  const providers = PROVIDERS.map((provider) => {
    const result = byProvider.get(provider);
    if (!result) {
      blockers.push(`real TUI launch probe is missing ${provider}.`);
    } else if (result.ok !== true) {
      blockers.push(`real TUI launch probe failed for ${provider}.`);
    }
    return {
      provider,
      ok: result?.ok === true,
      rawOutputObserved: result?.rawOutputObserved === true,
      visibleOutputObserved: result?.visibleOutputObserved === true,
      outputBytes: Number(result?.outputBytes ?? 0),
    };
  });

  return {
    ok: blockers.length === 0,
    blockers,
    details: {
      path,
      settleMs: reportObject.settleMs,
      providers,
    },
  };
}

function writeReport(path: string | null, report: unknown): void {
  if (!path) {
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

function main(): void {
  const rah = readRahMetadata();
  const cliProbe = checkCliProbe(CLI_PROBE_PATH, rah);
  const realTuiLaunch = checkRealTuiProbe(REAL_TUI_PROBE_PATH, rah);
  const blockers = [...cliProbe.blockers, ...realTuiLaunch.blockers];
  const report = {
    ok: blockers.length === 0,
    rah,
    evidence: {
      cliProbe: cliProbe.details,
      realTuiLaunch: realTuiLaunch.details,
    },
    blockers,
    manualQaRequired: MANUAL_QA_REQUIRED,
    notes: [
      "This status only validates saved automatic evidence. It does not prove real model responses or iPad/Safari behavior.",
      "Run npm run test:native-tui, npm run test:smoke:native-browser-webkit, and npm run test:smoke:native-real-tui-launch to refresh evidence.",
      "Final completion also requires a passing human-filled test-results/native-manual-qa.json checked by npm run test:smoke:native-manual-qa-status.",
    ],
  };
  writeReport(OUTPUT_PATH, report);
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) {
    process.exitCode = 1;
  }
}

main();

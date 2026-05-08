import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

type Provider = "codex" | "claude" | "opencode";
type CoreLiveProvider = Extract<Provider, "codex" | "claude" | "opencode">;
type ManualQaStatus = "pass" | "fail" | "blocked" | "skipped" | "pending";

type RahMetadata = {
  branch: string | null;
  commit: string | null;
  dirty: boolean | null;
  changedFiles: number | null;
};

type ManualQaCase = {
  id: string;
  title: string;
  provider?: Provider;
};

type ManualQaResult = {
  id: string;
  status: ManualQaStatus;
  title?: string;
  tester?: string;
  testedAt?: string;
  provider?: Provider;
  device?: string;
  browser?: string;
  url?: string;
  workspace?: string;
  sessionId?: string;
  providerSessionId?: string;
  cliVersion?: string;
  notes?: string;
  evidence?: string;
};

const CORE_LIVE_PROVIDERS: CoreLiveProvider[] = ["codex", "claude", "opencode"];
const COMMON_CASES = [
  ["web-new-native-tui", "Web new starts the official native TUI."],
  ["chat-input-and-mirror", "Chat input reaches TUI and mirror eventually displays the turn."],
  ["tui-input-and-replay", "Direct TUI input works, and reload replay preserves output."],
  ["stop", "Stop interrupts an active real turn and returns to idle."],
  ["continuous-followup-no-duplicates", "Continuous follow-ups are not dropped or duplicated."],
  ["archive-history-recover", "Archive/close and history recovery do not leave orphan live state."],
] as const;

const REQUIRED_CASES: ManualQaCase[] = [
  ...CORE_LIVE_PROVIDERS.flatMap((provider) =>
    COMMON_CASES.map(([suffix, title]) => ({
      id: `${provider}.${suffix}`,
      provider,
      title,
    })),
  ),
  {
    id: "codex.goal",
    provider: "codex",
    title: "Codex /goal works inside the official TUI.",
  },
  {
    id: "claude.permission-trust",
    provider: "claude",
    title: "Claude trust-folder and permission prompts are operable in TUI.",
  },
  {
    id: "opencode.resume-model-interrupt",
    provider: "opencode",
    title: "OpenCode project, session resume, model argument, and Ctrl-C are stable.",
  },
  {
    id: "opencode.model-variant",
    provider: "opencode",
    title:
      "OpenCode model selection respects the current boundary: TUI launch uses provider/model, while variant/reasoning remains native or enhancement-only.",
  },
  {
    id: "ipad-safari.keyboard-resize",
    title: "iPad/Safari keyboard composition and terminal resize are usable.",
  },
  {
    id: "ipad-safari.terminal-keyboard-anchor",
    title:
      "iPad/Safari terminal canvas tap and input bridge tap both keep the terminal anchored above the keyboard without page drift.",
  },
  {
    id: "ipad-safari.terminal-typography-theme",
    title:
      "iPad/Safari terminal typography, Chinese spacing, line height, and light/dark colors visually match the RAH Web UI.",
  },
  {
    id: "ipad-safari.rotation-split-pwa",
    title: "iPad/Safari rotation, split resize, PWA background, and replay are usable.",
  },
];

const INPUT_PATH = resolve(
  process.env.RAH_NATIVE_MANUAL_QA_PATH?.trim() || "test-results/native-manual-qa.json",
);
const OUTPUT_PATH = process.env.RAH_NATIVE_MANUAL_QA_STATUS_OUTPUT?.trim()
  ? resolve(process.env.RAH_NATIVE_MANUAL_QA_STATUS_OUTPUT)
  : null;
const TEMPLATE_OUTPUT_PATH = process.env.RAH_NATIVE_MANUAL_QA_TEMPLATE_OUTPUT?.trim()
  ? resolve(process.env.RAH_NATIVE_MANUAL_QA_TEMPLATE_OUTPUT)
  : null;

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

function writeJson(path: string | null, value: unknown): void {
  if (!path) {
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function templateReport(current: RahMetadata): unknown {
  return {
    rah: current,
    notes: [
      "Fill every required result with status=pass after testing on the recorded RAH commit.",
      "Do not mark pass without real provider account/device evidence.",
    ],
    results: REQUIRED_CASES.map((item) => ({
      id: item.id,
      status: "pending",
      ...(item.provider ? { provider: item.provider } : {}),
      title: item.title,
      tester: "",
      testedAt: "",
      device: "",
      browser: "",
      url: "",
      workspace: "",
      sessionId: "",
      providerSessionId: "",
      cliVersion: "",
      notes: item.title,
      evidence: "",
    })),
  };
}

function parseReport(path: string): { value?: Record<string, unknown>; error?: string } {
  if (!existsSync(path)) {
    return { error: `Missing manual QA report: ${path}` };
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { error: "Manual QA report must be a JSON object." };
    }
    return { value: parsed as Record<string, unknown> };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

function readReportRah(report: Record<string, unknown>): RahMetadata | null {
  const rah = report.rah;
  return rah && typeof rah === "object" && !Array.isArray(rah) ? (rah as RahMetadata) : null;
}

function readResults(report: Record<string, unknown>): ManualQaResult[] {
  if (!Array.isArray(report.results)) {
    return [];
  }
  return report.results.filter((item): item is ManualQaResult => {
    return Boolean(item) && typeof item === "object" && typeof item.id === "string";
  });
}

function hasEvidence(result: ManualQaResult): boolean {
  return Boolean(
    result.tester?.trim() &&
      result.testedAt?.trim() &&
      result.evidence?.trim(),
  );
}

function providerSessionIdRequired(id: string): boolean {
  return !id.endsWith(".web-new-native-tui");
}

function assertPassDetails(
  result: ManualQaResult,
  item: ManualQaCase,
  blockers: string[],
): void {
  if (result.status !== "pass") {
    return;
  }
  if (!hasEvidence(result)) {
    blockers.push(`Manual QA result ${item.id} is pass but missing tester/testedAt/evidence.`);
  }
  if (item.provider) {
    if (!result.cliVersion?.trim()) {
      blockers.push(`Manual QA result ${item.id} is pass but missing cliVersion.`);
    }
    if (!result.workspace?.trim()) {
      blockers.push(`Manual QA result ${item.id} is pass but missing workspace.`);
    }
    if (!result.sessionId?.trim()) {
      blockers.push(`Manual QA result ${item.id} is pass but missing sessionId.`);
    }
    if (providerSessionIdRequired(item.id) && !result.providerSessionId?.trim()) {
      blockers.push(`Manual QA result ${item.id} is pass but missing providerSessionId.`);
    }
    return;
  }
  if (item.id.startsWith("ipad-safari.")) {
    if (!result.device?.trim()) {
      blockers.push(`Manual QA result ${item.id} is pass but missing device.`);
    }
    if (!result.browser?.trim()) {
      blockers.push(`Manual QA result ${item.id} is pass but missing browser.`);
    }
    if (!result.url?.trim()) {
      blockers.push(`Manual QA result ${item.id} is pass but missing url.`);
    }
  }
}

function main(): void {
  const current = readRahMetadata();
  if (process.argv.includes("--print-template")) {
    const template = templateReport(current);
    writeJson(TEMPLATE_OUTPUT_PATH, template);
    console.log(JSON.stringify(template, null, 2));
    return;
  }

  const loaded = parseReport(INPUT_PATH);
  const blockers: string[] = [];
  const warnings: string[] = [];
  if (loaded.error || !loaded.value) {
    const report = {
      ok: false,
      rah: current,
      inputPath: INPUT_PATH,
      blockers: [loaded.error ?? "Unable to read manual QA report."],
      templateCommand:
        "RAH_NATIVE_MANUAL_QA_TEMPLATE_OUTPUT=test-results/native-manual-qa.json npm run test:smoke:native-manual-qa-status -- --print-template",
    };
    writeJson(OUTPUT_PATH, report);
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = 1;
    return;
  }

  const reportRah = readReportRah(loaded.value);
  if (!reportRah) {
    blockers.push("Manual QA report is missing rah metadata.");
  } else if (current.commit && reportRah.commit && reportRah.commit !== current.commit) {
    blockers.push(
      `Manual QA report commit ${reportRah.commit} does not match current commit ${current.commit}.`,
    );
  }

  const results = readResults(loaded.value);
  if (results.length === 0) {
    blockers.push("Manual QA report has no results array.");
  }
  const byId = new Map<string, ManualQaResult>();
  const duplicateIds = new Set<string>();
  for (const result of results) {
    if (byId.has(result.id)) {
      duplicateIds.add(result.id);
    }
    byId.set(result.id, result);
  }
  for (const id of duplicateIds) {
    blockers.push(`Manual QA report has duplicate result id: ${id}.`);
  }

  const required = REQUIRED_CASES.map((item) => {
    const result = byId.get(item.id);
    if (!result) {
      blockers.push(`Missing manual QA result: ${item.id}`);
      return { ...item, status: "missing" };
    }
    if (result.status !== "pass") {
      blockers.push(`Manual QA result ${item.id} is ${String(result.status)}.`);
    }
    assertPassDetails(result, item, blockers);
    return {
      ...item,
      status: result.status,
      tester: result.tester ?? "",
      testedAt: result.testedAt ?? "",
      device: result.device ?? "",
      browser: result.browser ?? "",
      url: result.url ?? "",
      workspace: result.workspace ?? "",
      cliVersion: result.cliVersion ?? "",
      sessionId: result.sessionId ?? "",
      providerSessionId: result.providerSessionId ?? "",
    };
  });

  const summary = required.reduce(
    (acc, item) => {
      const scope = item.provider ?? item.id.split(".")[0] ?? "global";
      const status = String(item.status);
      acc.total += 1;
      acc.statuses[status] = (acc.statuses[status] ?? 0) + 1;
      const scoped = acc.byScope[scope] ?? {
        total: 0,
        statuses: {} as Record<string, number>,
      };
      scoped.total += 1;
      scoped.statuses[status] = (scoped.statuses[status] ?? 0) + 1;
      acc.byScope[scope] = scoped;
      return acc;
    },
    {
      total: 0,
      statuses: {} as Record<string, number>,
      byScope: {} as Record<string, { total: number; statuses: Record<string, number> }>,
    },
  );

  const knownIds = new Set(REQUIRED_CASES.map((item) => item.id));
  for (const result of results) {
    if (!knownIds.has(result.id)) {
      warnings.push(`Unknown manual QA result id ignored: ${result.id}`);
    }
  }

  const output = {
    ok: blockers.length === 0,
    rah: current,
    inputPath: INPUT_PATH,
    summary,
    required,
    blockers,
    warnings,
    templateCommand:
      "RAH_NATIVE_MANUAL_QA_TEMPLATE_OUTPUT=test-results/native-manual-qa.json npm run test:smoke:native-manual-qa-status -- --print-template",
  };
  writeJson(OUTPUT_PATH, output);
  console.log(JSON.stringify(output, null, 2));
  if (!output.ok) {
    process.exitCode = 1;
  }
}

main();

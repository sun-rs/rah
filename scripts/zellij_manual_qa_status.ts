import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

type Provider = "codex" | "claude" | "opencode";
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
  requiresBrowser?: boolean;
  requiresDevice?: boolean;
};

type ManualQaResult = {
  id: string;
  status: ManualQaStatus;
  title?: string;
  provider?: Provider;
  tester?: string;
  testedAt?: string;
  device?: string;
  browser?: string;
  url?: string;
  workspace?: string;
  sessionId?: string;
  providerSessionId?: string;
  zellijSessionName?: string;
  zellijPaneId?: string;
  cliVersion?: string;
  notes?: string;
  evidence?: string;
};

const PROVIDERS: Provider[] = ["codex", "claude", "opencode"];
const PROVIDER_CASES = [
  ["desktop-terminal", "Desktop terminal launches and remains close to native TUI."],
  ["web-attach", "Web attaches to the same zellij-backed session without resume."],
  ["chat-mirror", "TUI and Web Chat input mirror into structured Chat exactly once."],
  ["real-stop", "Web Stop interrupts a real active turn without killing the provider."],
  ["exit-archive", "Provider exit and Web Archive clean up live state and zellij sessions."],
  ["browser-reconnect", "Browser/PWA reconnect catches up without duplicate output."],
] as const;

const REQUIRED_CASES: ManualQaCase[] = [
  ...PROVIDERS.flatMap((provider) =>
    PROVIDER_CASES.map(([suffix, title]) => ({
      id: `${provider}.${suffix}`,
      provider,
      title,
      requiresBrowser: suffix !== "desktop-terminal",
    })),
  ),
  {
    id: "ipad-safari.pwa-keyboard-ime",
    title: "iPad Safari/PWA keyboard, Chinese IME, viewport, and terminal scroll are usable.",
    requiresBrowser: true,
    requiresDevice: true,
  },
  {
    id: "iphone-small-layout-safe",
    title: "iPhone/small layouts block or safely degrade unsupported canvas/TUI actions.",
    requiresBrowser: true,
    requiresDevice: true,
  },
  {
    id: "multi-client.resize",
    title: "Desktop terminal, Web, and optional iPad multi-client attach has acceptable resize behavior.",
    requiresBrowser: true,
  },
];

const INPUT_PATH = resolve(
  process.env.RAH_ZELLIJ_MANUAL_QA_PATH?.trim() || "test-results/zellij-manual-qa.json",
);
const OUTPUT_PATH = process.env.RAH_ZELLIJ_MANUAL_QA_STATUS_OUTPUT?.trim()
  ? resolve(process.env.RAH_ZELLIJ_MANUAL_QA_STATUS_OUTPUT)
  : null;
const TEMPLATE_OUTPUT_PATH = process.env.RAH_ZELLIJ_MANUAL_QA_TEMPLATE_OUTPUT?.trim()
  ? resolve(process.env.RAH_ZELLIJ_MANUAL_QA_TEMPLATE_OUTPUT)
  : null;

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
      "Fill every required result with status=pass only after real zellij provider/device testing.",
      "Do not mark pass from fake-provider tests or launch-only probes.",
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
      zellijSessionName: "",
      zellijPaneId: "",
      cliVersion: "",
      notes: item.title,
      evidence: "",
    })),
  };
}

function parseReport(path: string): { value?: Record<string, unknown>; error?: string } {
  if (!existsSync(path)) {
    return { error: `Missing zellij manual QA report: ${path}` };
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { error: "Zellij manual QA report must be a JSON object." };
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
  return Boolean(result.tester?.trim() && result.testedAt?.trim() && result.evidence?.trim());
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
    blockers.push(`Zellij manual QA result ${item.id} is pass but missing tester/testedAt/evidence.`);
  }
  if (item.provider) {
    if (!result.cliVersion?.trim()) {
      blockers.push(`Zellij manual QA result ${item.id} is pass but missing cliVersion.`);
    }
    if (!result.workspace?.trim()) {
      blockers.push(`Zellij manual QA result ${item.id} is pass but missing workspace.`);
    }
    if (!result.sessionId?.trim()) {
      blockers.push(`Zellij manual QA result ${item.id} is pass but missing sessionId.`);
    }
    if (!result.zellijSessionName?.trim()) {
      blockers.push(`Zellij manual QA result ${item.id} is pass but missing zellijSessionName.`);
    }
    if (!result.zellijPaneId?.trim()) {
      blockers.push(`Zellij manual QA result ${item.id} is pass but missing zellijPaneId.`);
    }
  }
  if (item.requiresBrowser) {
    if (!result.browser?.trim()) {
      blockers.push(`Zellij manual QA result ${item.id} is pass but missing browser.`);
    }
    if (!result.url?.trim()) {
      blockers.push(`Zellij manual QA result ${item.id} is pass but missing url.`);
    }
  }
  if (item.requiresDevice && !result.device?.trim()) {
    blockers.push(`Zellij manual QA result ${item.id} is pass but missing device.`);
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
    const output = {
      ok: false,
      rah: current,
      inputPath: INPUT_PATH,
      blockers: [loaded.error ?? "Unable to read zellij manual QA report."],
      warnings,
      templateCommand:
        "RAH_ZELLIJ_MANUAL_QA_TEMPLATE_OUTPUT=test-results/zellij-manual-qa.json npm run test:smoke:zellij-manual-qa-status -- --print-template",
    };
    writeJson(OUTPUT_PATH, output);
    console.log(JSON.stringify(output, null, 2));
    process.exitCode = 1;
    return;
  }

  const reportRah = readReportRah(loaded.value);
  if (!reportRah) {
    blockers.push("Zellij manual QA report is missing rah metadata.");
  } else if (current.commit && reportRah.commit && reportRah.commit !== current.commit) {
    blockers.push(
      `Zellij manual QA report commit ${reportRah.commit} does not match current commit ${current.commit}.`,
    );
  }

  const results = readResults(loaded.value);
  if (results.length === 0) {
    blockers.push("Zellij manual QA report has no results array.");
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
    blockers.push(`Zellij manual QA report has duplicate result id: ${id}.`);
  }

  const required = REQUIRED_CASES.map((item) => {
    const result = byId.get(item.id);
    if (!result) {
      blockers.push(`Missing zellij manual QA result: ${item.id}`);
      return { ...item, status: "missing" };
    }
    if (result.status !== "pass") {
      blockers.push(`Zellij manual QA result ${item.id} is ${String(result.status)}.`);
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
      zellijSessionName: result.zellijSessionName ?? "",
      zellijPaneId: result.zellijPaneId ?? "",
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
      warnings.push(`Unknown zellij manual QA result id ignored: ${result.id}`);
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
      "RAH_ZELLIJ_MANUAL_QA_TEMPLATE_OUTPUT=test-results/zellij-manual-qa.json npm run test:smoke:zellij-manual-qa-status -- --print-template",
  };
  writeJson(OUTPUT_PATH, output);
  console.log(JSON.stringify(output, null, 2));
  if (!output.ok) {
    process.exitCode = 1;
  }
}

main();

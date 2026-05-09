import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

type ManualQaResult = {
  id: string;
  status: string;
  provider?: "codex" | "claude" | "opencode";
  tester?: string;
  testedAt?: string;
  device?: string;
  browser?: string;
  url?: string;
  workspace?: string;
  sessionId?: string;
  providerSessionId?: string;
  cliVersion?: string;
  evidence?: string;
};

type ManualQaReport = {
  rah: unknown;
  results: ManualQaResult[];
};

const SCRIPT_PATH = path.resolve("scripts/native_manual_qa_status.ts");
const TSX_LOADER_PATH = path.resolve("node_modules/tsx/dist/loader.mjs");

function runManualQaStatus(
  args: string[],
  env: NodeJS.ProcessEnv = {},
  cwd = process.cwd(),
): {
  status: number;
  stdout: string;
} {
  try {
    const stdout = execFileSync(process.execPath, ["--import", TSX_LOADER_PATH, SCRIPT_PATH, ...args], {
      cwd,
      env: { ...process.env, ...env },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, stdout };
  } catch (error) {
    const failed = error as { status?: number; stdout?: Buffer | string };
    const stdout =
      typeof failed.stdout === "string"
        ? failed.stdout
        : Buffer.isBuffer(failed.stdout)
          ? failed.stdout.toString("utf8")
          : "";
    return { status: failed.status ?? 1, stdout };
  }
}

function createTemplateReport(): ManualQaReport {
  const dir = mkdtempSync(path.join(tmpdir(), "rah-manual-qa-test-"));
  const templatePath = path.join(dir, "template.json");
  const result = runManualQaStatus(["--print-template"], {
    RAH_NATIVE_MANUAL_QA_TEMPLATE_OUTPUT: templatePath,
  });
  assert.equal(result.status, 0);
  return JSON.parse(readFileSync(templatePath, "utf8")) as ManualQaReport;
}

function completeReport(): ManualQaReport {
  const report = createTemplateReport();
  report.results = report.results.map((result) => ({
    ...result,
    status: "pass",
    tester: "QA Tester",
    testedAt: "2026-05-08T12:00:00.000Z",
    evidence: `Verified ${result.id}.`,
    ...(result.provider
      ? {
          cliVersion: `${result.provider}-test-version`,
          workspace: `/tmp/rah-${result.provider}-workspace`,
          sessionId: `rah-session-${result.id}`,
          providerSessionId: `provider-session-${result.id}`,
        }
      : {
          device: "iPad Pro",
          browser: "Mobile Safari",
          url: "http://127.0.0.1:43111",
        }),
  }));
  return report;
}

function runReport(report: ManualQaReport): { status: number; output: Record<string, unknown> } {
  const dir = mkdtempSync(path.join(tmpdir(), "rah-manual-qa-report-"));
  const reportPath = path.join(dir, "manual-qa.json");
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  const result = runManualQaStatus([], { RAH_NATIVE_MANUAL_QA_PATH: reportPath });
  assert.ok(result.stdout.trim(), "manual QA status should print JSON");
  return { status: result.status, output: JSON.parse(result.stdout) as Record<string, unknown> };
}

function blockers(output: Record<string, unknown>): string[] {
  assert.ok(Array.isArray(output.blockers));
  return output.blockers as string[];
}

test("native manual QA status accepts complete provider and iPad/Safari evidence", () => {
  const result = runReport(completeReport());
  assert.equal(result.status, 0);
  assert.equal(result.output.ok, true);
});

test("native manual QA template reports a clean worktree as dirty false", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "rah-manual-qa-clean-git-"));
  execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
  writeFileSync(path.join(dir, "README.md"), "clean\n", "utf8");
  execFileSync("git", ["add", "README.md"], { cwd: dir, stdio: "ignore" });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=RAH Test",
      "-c",
      "user.email=rah-test@example.invalid",
      "commit",
      "-m",
      "initial",
    ],
    { cwd: dir, stdio: "ignore" },
  );

  const templatePath = path.join(dir, "template.json");
  const result = runManualQaStatus(
    ["--print-template"],
    {
      RAH_NATIVE_MANUAL_QA_TEMPLATE_OUTPUT: templatePath,
    },
    dir,
  );
  assert.equal(result.status, 0);
  const report = JSON.parse(readFileSync(templatePath, "utf8")) as {
    rah: { dirty?: unknown; changedFiles?: unknown };
  };
  assert.equal(report.rah.dirty, false);
  assert.equal(report.rah.changedFiles, 0);
});

test("native manual QA status rejects provider pass results without concrete session evidence", () => {
  const report = completeReport();
  const target = report.results.find((result) => result.id === "codex.chat-input-and-mirror");
  assert.ok(target);
  target.cliVersion = "";
  target.workspace = "";
  target.sessionId = "";
  target.providerSessionId = "";

  const result = runReport(report);
  assert.notEqual(result.status, 0);
  assert.equal(result.output.ok, false);
  assert.deepEqual(
    blockers(result.output).filter((item) => item.includes("codex.chat-input-and-mirror")),
    [
      "Manual QA result codex.chat-input-and-mirror is pass but missing cliVersion.",
      "Manual QA result codex.chat-input-and-mirror is pass but missing workspace.",
      "Manual QA result codex.chat-input-and-mirror is pass but missing sessionId.",
      "Manual QA result codex.chat-input-and-mirror is pass but missing providerSessionId.",
    ],
  );
});

test("native manual QA status rejects reports from a different dirty worktree snapshot", () => {
  const report = completeReport();
  assert.ok(report.rah && typeof report.rah === "object");
  (report.rah as { worktreeFingerprint?: string }).worktreeFingerprint = "different-fingerprint";

  const result = runReport(report);
  assert.notEqual(result.status, 0);
  assert.equal(result.output.ok, false);
  assert.ok(
    blockers(result.output).some((item) => item.includes("worktreeFingerprint")),
    "manual QA status should reject a stale dirty worktree fingerprint",
  );
});

test("native manual QA status rejects iPad/Safari pass results without device evidence", () => {
  const report = completeReport();
  const target = report.results.find((result) => result.id === "ipad-safari.keyboard-resize");
  assert.ok(target);
  target.device = "";
  target.browser = "";
  target.url = "";

  const result = runReport(report);
  assert.notEqual(result.status, 0);
  assert.equal(result.output.ok, false);
  assert.deepEqual(
    blockers(result.output).filter((item) => item.includes("ipad-safari.keyboard-resize")),
    [
      "Manual QA result ipad-safari.keyboard-resize is pass but missing device.",
      "Manual QA result ipad-safari.keyboard-resize is pass but missing browser.",
      "Manual QA result ipad-safari.keyboard-resize is pass but missing url.",
    ],
  );
});

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
  zellijSessionName?: string;
  zellijPaneId?: string;
  cliVersion?: string;
  evidence?: string;
};

type ManualQaReport = {
  rah: unknown;
  results: ManualQaResult[];
};

const SCRIPT_PATH = path.resolve("scripts/zellij_manual_qa_status.ts");

function runZellijManualQaStatus(args: string[], env: NodeJS.ProcessEnv = {}): {
  status: number;
  stdout: string;
} {
  try {
    const stdout = execFileSync(process.execPath, ["--import", "tsx", SCRIPT_PATH, ...args], {
      cwd: process.cwd(),
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
  const dir = mkdtempSync(path.join(tmpdir(), "rah-zellij-manual-qa-test-"));
  const templatePath = path.join(dir, "template.json");
  const result = runZellijManualQaStatus(["--print-template"], {
    RAH_ZELLIJ_MANUAL_QA_TEMPLATE_OUTPUT: templatePath,
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
          zellijSessionName: `rah-zellij-${result.id}`,
          zellijPaneId: "terminal_1",
        }
      : {}),
    ...(result.id.includes("web-attach") ||
    result.id.includes("chat-mirror") ||
    result.id.includes("real-stop") ||
    result.id.includes("exit-archive") ||
    result.id.includes("browser-reconnect") ||
    result.id.startsWith("ipad-safari.") ||
    result.id.startsWith("iphone-") ||
    result.id.startsWith("multi-client.")
      ? {
          browser: "Mobile Safari",
          url: "http://127.0.0.1:43111",
        }
      : {}),
    ...(result.id.startsWith("ipad-safari.") || result.id.startsWith("iphone-")
      ? {
          device: "iPad Pro",
        }
      : {}),
  }));
  return report;
}

function runReport(report: ManualQaReport): { status: number; output: Record<string, unknown> } {
  const dir = mkdtempSync(path.join(tmpdir(), "rah-zellij-manual-qa-report-"));
  const reportPath = path.join(dir, "manual-qa.json");
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  const result = runZellijManualQaStatus([], { RAH_ZELLIJ_MANUAL_QA_PATH: reportPath });
  assert.ok(result.stdout.trim(), "zellij manual QA status should print JSON");
  return { status: result.status, output: JSON.parse(result.stdout) as Record<string, unknown> };
}

function blockers(output: Record<string, unknown>): string[] {
  assert.ok(Array.isArray(output.blockers));
  return output.blockers as string[];
}

test("zellij manual QA status accepts complete provider, browser, and device evidence", () => {
  const result = runReport(completeReport());
  assert.equal(result.status, 0);
  assert.equal(result.output.ok, true);
});

test("zellij manual QA status rejects provider pass results without zellij evidence", () => {
  const report = completeReport();
  const target = report.results.find((result) => result.id === "codex.web-attach");
  assert.ok(target);
  target.cliVersion = "";
  target.workspace = "";
  target.sessionId = "";
  target.zellijSessionName = "";
  target.zellijPaneId = "";

  const result = runReport(report);
  assert.notEqual(result.status, 0);
  assert.equal(result.output.ok, false);
  assert.deepEqual(
    blockers(result.output).filter((item) => item.includes("codex.web-attach")),
    [
      "Zellij manual QA result codex.web-attach is pass but missing cliVersion.",
      "Zellij manual QA result codex.web-attach is pass but missing workspace.",
      "Zellij manual QA result codex.web-attach is pass but missing sessionId.",
      "Zellij manual QA result codex.web-attach is pass but missing zellijSessionName.",
      "Zellij manual QA result codex.web-attach is pass but missing zellijPaneId.",
    ],
  );
});

test("zellij manual QA status rejects iPad pass results without device evidence", () => {
  const report = completeReport();
  const target = report.results.find((result) => result.id === "ipad-safari.pwa-keyboard-ime");
  assert.ok(target);
  target.device = "";
  target.browser = "";
  target.url = "";

  const result = runReport(report);
  assert.notEqual(result.status, 0);
  assert.equal(result.output.ok, false);
  assert.deepEqual(
    blockers(result.output).filter((item) => item.includes("ipad-safari.pwa-keyboard-ime")),
    [
      "Zellij manual QA result ipad-safari.pwa-keyboard-ime is pass but missing browser.",
      "Zellij manual QA result ipad-safari.pwa-keyboard-ime is pass but missing url.",
      "Zellij manual QA result ipad-safari.pwa-keyboard-ime is pass but missing device.",
    ],
  );
});

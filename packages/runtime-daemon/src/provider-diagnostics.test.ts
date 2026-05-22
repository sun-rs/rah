import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  compareVersions,
  codexLaunchSpec,
  extractVersionString,
  launchSpecForProvider,
  probeProviderDiagnostic,
  resetProviderDiagnosticsCacheForTests,
  summarizeCodexDoctorReport,
} from "./provider-diagnostics";
import { resolveConfiguredBinary } from "./provider-binary-utils";

describe("provider diagnostics version helpers", () => {
  test("extractVersionString pulls a semver token out of cli output", () => {
    assert.equal(extractVersionString("codex 0.23.1"), "0.23.1");
    assert.equal(extractVersionString("claude-code v1.2.3-beta.1"), "1.2.3-beta.1");
    assert.equal(extractVersionString("unknown"), undefined);
  });

  test("compareVersions reports update availability", () => {
    assert.equal(compareVersions("0.23.0", "0.23.1"), "update_available");
    assert.equal(compareVersions("0.23.1", "0.23.1"), "up_to_date");
    assert.equal(compareVersions("0.24.0", "0.23.1"), "up_to_date");
  });

  test("compareVersions handles prerelease ordering", () => {
    assert.equal(compareVersions("1.0.0-beta.1", "1.0.0"), "update_available");
    assert.equal(compareVersions("1.0.0-rc.1", "1.0.0-beta.2"), "up_to_date");
  });

  test("compareVersions falls back to unknown for unparsable values", () => {
    assert.equal(compareVersions("codex 0.23.1", "0.23.1"), "unknown");
    assert.equal(compareVersions(undefined, "0.23.1"), "unknown");
  });

  test("summarizes Codex doctor auth and app-server status without raw paths", () => {
    const summary = summarizeCodexDoctorReport({
      generatedAt: "1779371923s since unix epoch",
      overallStatus: "ok",
      checks: {
        "auth.credentials": {
          status: "ok",
          summary: "auth is configured",
          details: {
            "auth file": "/Users/example/.codex/auth.json",
            "stored API key": "false",
            "stored ChatGPT tokens": "true",
            "stored auth mode": "chatgpt",
          },
        },
        "app_server.status": {
          status: "ok",
          summary: "background server is not running",
          details: {
            status: "not running",
            mode: "ephemeral",
            "control socket": "/Users/example/.codex/app-server.sock",
          },
        },
        "network.provider_reachability": {
          status: "ok",
          summary: "active provider endpoints are reachable over HTTP",
          details: {},
        },
      },
    });

    assert.deepEqual(summary, {
      source: "codex_doctor",
      status: "ok",
      generatedAt: "1779371923s since unix epoch",
      auth: {
        status: "configured",
        mode: "chatgpt",
        storedApiKey: false,
        storedChatGptTokens: true,
        summary: "auth is configured",
      },
      appServer: {
        status: "not running",
        mode: "ephemeral",
        summary: "background server is not running",
      },
      network: {
        status: "ok",
        summary: "active provider endpoints are reachable over HTTP",
      },
    });
  });

  test("adds Codex doctor summary to provider diagnostics using a fake binary", async () => {
    resetProviderDiagnosticsCacheForTests();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({ tag_name: "v0.132.0" }), {
      status: 200,
      headers: {
        "content-type": "application/json",
      },
    })) as typeof globalThis.fetch;

    const tempDir = mkdtempSync(path.join(os.tmpdir(), "rah-codex-doctor-"));
    const binaryPath = path.join(tempDir, "codex");
    try {
      writeFileSync(
        binaryPath,
        `#!/usr/bin/env ${path.basename(process.execPath)}
if (process.argv.includes("doctor")) {
  console.log(JSON.stringify({
    generatedAt: "now",
    overallStatus: "ok",
    checks: {
      "auth.credentials": {
        status: "ok",
        summary: "auth is configured",
        details: {
          "stored auth mode": "chatgpt",
          "stored API key": "false",
          "stored ChatGPT tokens": "true"
        }
      },
      "app_server.status": {
        status: "ok",
        summary: "background server is not running",
        details: { status: "not running", mode: "ephemeral" }
      }
    }
  }));
} else if (process.argv.includes("--version")) {
  console.log("codex-cli 0.132.0");
} else {
  process.exit(2);
}
`,
      );
      chmodSync(binaryPath, 0o755);

      const diagnostic = await probeProviderDiagnostic("codex", { argv: [binaryPath] }, { forceRefresh: true });

      assert.equal(diagnostic.status, "ready");
      assert.equal(diagnostic.installedVersion, "0.132.0");
      assert.equal(diagnostic.providerHealth?.source, "codex_doctor");
      assert.equal(diagnostic.providerHealth?.auth?.mode, "chatgpt");
      assert.equal(diagnostic.providerHealth?.auth?.storedChatGptTokens, true);
      assert.equal(diagnostic.providerHealth?.appServer?.status, "not running");
    } finally {
      globalThis.fetch = originalFetch;
      resetProviderDiagnosticsCacheForTests();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("force refresh bypasses the cached latest-version probe", async () => {
    resetProviderDiagnosticsCacheForTests();
    const originalFetch = globalThis.fetch;
    let fetchCount = 0;
    globalThis.fetch = (async () => {
      fetchCount += 1;
      return new Response(JSON.stringify({ tag_name: "v0.23.1" }), {
        status: 200,
        headers: {
          "content-type": "application/json",
        },
      });
    }) as typeof globalThis.fetch;

    try {
      const launchSpec = {
        argv: [process.execPath, "-e", "console.log('codex 0.23.0')"],
      };
      await probeProviderDiagnostic("codex", launchSpec);
      await probeProviderDiagnostic("codex", launchSpec);
      assert.equal(fetchCount, 1);

      await probeProviderDiagnostic("codex", launchSpec, { forceRefresh: true });
      assert.equal(fetchCount, 2);
    } finally {
      globalThis.fetch = originalFetch;
      resetProviderDiagnosticsCacheForTests();
    }
  });

  test("rejects relative binary overrides", async () => {
    const previousBinary = process.env.RAH_CODEX_BINARY;
    process.env.RAH_CODEX_BINARY = "./bin/codex";
    try {
      await assert.rejects(() => codexLaunchSpec(), /RAH_CODEX_BINARY must be a bare command or absolute path/);
    } finally {
      if (previousBinary === undefined) {
        delete process.env.RAH_CODEX_BINARY;
      } else {
        process.env.RAH_CODEX_BINARY = previousBinary;
      }
    }
  });

  test("resolves bare provider commands to executable paths", async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "rah-provider-bin-"));
    const binaryPath = path.join(tempDir, "rah-test-provider");
    const previousPath = process.env.PATH;
    const previousBinary = process.env.RAH_TEST_BINARY;
    try {
      writeFileSync(binaryPath, "#!/bin/sh\nexit 0\n");
      chmodSync(binaryPath, 0o755);
      process.env.PATH = tempDir;
      delete process.env.RAH_TEST_BINARY;
      assert.equal(
        await resolveConfiguredBinary("RAH_TEST_BINARY", "rah-test-provider"),
        binaryPath,
      );
    } finally {
      if (previousPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = previousPath;
      }
      if (previousBinary === undefined) {
        delete process.env.RAH_TEST_BINARY;
      } else {
        process.env.RAH_TEST_BINARY = previousBinary;
      }
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("rejects unavailable bare provider commands before spawn", async () => {
    const previousPath = process.env.PATH;
    const previousBinary = process.env.RAH_TEST_BINARY;
    try {
      process.env.PATH = "";
      delete process.env.RAH_TEST_BINARY;
      await assert.rejects(
        () => resolveConfiguredBinary("RAH_TEST_BINARY", "rah-definitely-missing-provider"),
        /Could not find executable 'rah-definitely-missing-provider'/,
      );
    } finally {
      if (previousPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = previousPath;
      }
      if (previousBinary === undefined) {
        delete process.env.RAH_TEST_BINARY;
      } else {
        process.env.RAH_TEST_BINARY = previousBinary;
      }
    }
  });

  test("only core running providers expose launch specs for diagnostics", async () => {
    const previousCodexBinary = process.env.RAH_CODEX_BINARY;
    const previousClaudeBinary = process.env.RAH_CLAUDE_BINARY;
    const previousGeminiBinary = process.env.RAH_GEMINI_BINARY;
    const previousOpenCodeBinary = process.env.RAH_OPENCODE_BINARY;
    try {
      process.env.RAH_CODEX_BINARY = process.execPath;
      process.env.RAH_CLAUDE_BINARY = process.execPath;
      process.env.RAH_GEMINI_BINARY = process.execPath;
      process.env.RAH_OPENCODE_BINARY = process.execPath;
      assert.deepEqual(await launchSpecForProvider("codex"), { argv: [process.execPath] });
      assert.deepEqual(await launchSpecForProvider("claude"), { argv: [process.execPath] });
      assert.deepEqual(await launchSpecForProvider("gemini"), { argv: [process.execPath] });
      assert.deepEqual(await launchSpecForProvider("opencode"), { argv: [process.execPath] });
    } finally {
      if (previousCodexBinary === undefined) {
        delete process.env.RAH_CODEX_BINARY;
      } else {
        process.env.RAH_CODEX_BINARY = previousCodexBinary;
      }
      if (previousClaudeBinary === undefined) {
        delete process.env.RAH_CLAUDE_BINARY;
      } else {
        process.env.RAH_CLAUDE_BINARY = previousClaudeBinary;
      }
      if (previousGeminiBinary === undefined) {
        delete process.env.RAH_GEMINI_BINARY;
      } else {
        process.env.RAH_GEMINI_BINARY = previousGeminiBinary;
      }
      if (previousOpenCodeBinary === undefined) {
        delete process.env.RAH_OPENCODE_BINARY;
      } else {
        process.env.RAH_OPENCODE_BINARY = previousOpenCodeBinary;
      }
    }
  });
});

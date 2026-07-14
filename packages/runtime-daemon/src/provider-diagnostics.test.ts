import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
import { providerBinaryArgv, resolveConfiguredBinary } from "./provider-binary-utils";

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

    try {
      const fakeCli = `
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
`;

      const diagnostic = await probeProviderDiagnostic(
        "codex",
        { argv: [process.execPath, "-e", fakeCli, "--"] },
        { forceRefresh: true },
      );

      assert.equal(diagnostic.status, "ready");
      assert.equal(diagnostic.installedVersion, "0.132.0");
      assert.equal(diagnostic.providerHealth?.source, "codex_doctor");
      assert.equal(diagnostic.providerHealth?.auth?.mode, "chatgpt");
      assert.equal(diagnostic.providerHealth?.auth?.storedChatGptTokens, true);
      assert.equal(diagnostic.providerHealth?.appServer?.status, "not running");
    } finally {
      globalThis.fetch = originalFetch;
      resetProviderDiagnosticsCacheForTests();
    }
  });

  test("can probe the Codex version without running doctor", async () => {
    resetProviderDiagnosticsCacheForTests();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({ tag_name: "v0.132.0" }), {
      status: 200,
      headers: {
        "content-type": "application/json",
      },
    })) as typeof globalThis.fetch;

    const tempDir = mkdtempSync(path.join(os.tmpdir(), "rah-codex-version-only-"));
    const doctorMarkerPath = path.join(tempDir, "doctor-called");
    try {
      const fakeCli = `
const fs = require("node:fs");
if (process.argv.includes("doctor")) {
  fs.writeFileSync(${JSON.stringify(doctorMarkerPath)}, "called");
  process.exit(2);
}
if (process.argv.includes("--version")) {
  console.log("codex-cli 0.132.0");
  process.exit(0);
}
process.exit(2);
`;

      const diagnostic = await probeProviderDiagnostic(
        "codex",
        { argv: [process.execPath, "-e", fakeCli, "--"] },
        { forceRefresh: true, includeHealth: false },
      );

      assert.equal(diagnostic.status, "ready");
      assert.equal(diagnostic.installedVersion, "0.132.0");
      assert.equal(diagnostic.providerHealth, undefined);
      assert.equal(existsSync(doctorMarkerPath), false);
    } finally {
      globalThis.fetch = originalFetch;
      resetProviderDiagnosticsCacheForTests();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("probes the installed version while the latest-version request is still pending", async () => {
    resetProviderDiagnosticsCacheForTests();
    const originalFetch = globalThis.fetch;
    let resolveFetch: ((response: Response) => void) | undefined;
    globalThis.fetch = (() => new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    })) as typeof globalThis.fetch;

    const tempDir = mkdtempSync(path.join(os.tmpdir(), "rah-provider-version-concurrency-"));
    const versionMarkerPath = path.join(tempDir, "version-called");
    try {
      const fakeCli = `
const fs = require("node:fs");
if (process.argv.includes("--version")) {
  fs.writeFileSync(${JSON.stringify(versionMarkerPath)}, "called");
  console.log("codex-cli 0.132.0");
  process.exit(0);
}
process.exit(2);
`;
      const diagnosticPromise = probeProviderDiagnostic(
        "codex",
        { argv: [process.execPath, "-e", fakeCli, "--"] },
        { forceRefresh: true, includeHealth: false },
      );

      for (let attempt = 0; attempt < 50 && !existsSync(versionMarkerPath); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(existsSync(versionMarkerPath), true);

      assert.ok(resolveFetch);
      resolveFetch(new Response(JSON.stringify({ tag_name: "v0.132.0" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }));
      const diagnostic = await diagnosticPromise;
      assert.equal(diagnostic.status, "ready");
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

  test("launches explicit JavaScript provider binaries through the current Node runtime", () => {
    assert.deepEqual(providerBinaryArgv("/tmp/fake-provider.js"), [
      process.execPath,
      "/tmp/fake-provider.js",
    ]);
    assert.deepEqual(providerBinaryArgv("/tmp/fake-provider.mjs"), [
      process.execPath,
      "/tmp/fake-provider.mjs",
    ]);
    assert.deepEqual(providerBinaryArgv("/opt/homebrew/bin/codex"), [
      "/opt/homebrew/bin/codex",
    ]);
  });

  test("launches shebang provider scripts through their declared interpreter", () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "rah-provider-script-"));
    const shellScript = path.join(tempDir, "provider-wrapper");
    const nodeScript = path.join(tempDir, "provider.js");
    try {
      writeFileSync(shellScript, "#!/bin/sh\nexit 0\n");
      writeFileSync(nodeScript, "#!/usr/bin/env node\nprocess.exit(0);\n");
      assert.deepEqual(providerBinaryArgv(shellScript), ["/bin/sh", shellScript]);
      assert.deepEqual(providerBinaryArgv(nodeScript), ["/usr/bin/env", "node", nodeScript]);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
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
    const previousOpenCodeBinary = process.env.RAH_OPENCODE_BINARY;
    try {
      process.env.RAH_CODEX_BINARY = process.execPath;
      process.env.RAH_CLAUDE_BINARY = process.execPath;
      process.env.RAH_OPENCODE_BINARY = process.execPath;
      assert.deepEqual(await launchSpecForProvider("codex"), { argv: [process.execPath] });
      assert.deepEqual(await launchSpecForProvider("claude"), { argv: [process.execPath] });
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
      if (previousOpenCodeBinary === undefined) {
        delete process.env.RAH_OPENCODE_BINARY;
      } else {
        process.env.RAH_OPENCODE_BINARY = previousOpenCodeBinary;
      }
    }
  });
});

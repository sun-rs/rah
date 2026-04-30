import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  compareVersions,
  codexLaunchSpec,
  extractVersionString,
  probeProviderDiagnostic,
  resetProviderDiagnosticsCacheForTests,
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
});

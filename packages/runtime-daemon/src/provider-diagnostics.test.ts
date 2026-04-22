import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  compareVersions,
  extractVersionString,
  probeProviderDiagnostic,
  resetProviderDiagnosticsCacheForTests,
} from "./provider-diagnostics";

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
});

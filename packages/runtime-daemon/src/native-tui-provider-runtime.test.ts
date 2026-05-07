import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DefaultNativeTuiProviderRuntime } from "./native-tui-provider-runtime";

function readSource(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

function assertNoImports(source: string, forbiddenSpecifiers: string[]) {
  for (const specifier of forbiddenSpecifiers) {
    assert.doesNotMatch(
      source,
      new RegExp(`from\\s+["']${specifier.replaceAll("/", "\\/")}["']`),
      `unexpected import from ${specifier}`,
    );
  }
}

describe("NativeTuiProviderRuntime", () => {
  test("declares the provider set owned by the native TUI runtime", () => {
    const runtime = new DefaultNativeTuiProviderRuntime();
    assert.deepEqual([...runtime.providers], [
      "codex",
      "claude",
      "gemini",
      "kimi",
      "opencode",
    ]);
    assert.equal(runtime.supports("codex"), true);
    assert.equal(runtime.supports("custom"), false);
  });

  test("keeps provider-specific binding capability behind the native runtime boundary", () => {
    const runtime = new DefaultNativeTuiProviderRuntime();
    assert.equal(runtime.canProbeBinding("codex"), true);
    assert.equal(runtime.canProbeBinding("gemini"), true);
    assert.equal(runtime.canProbeBinding("opencode"), true);
    assert.equal(runtime.canProbeBinding("claude"), false);
    assert.equal(runtime.canProbeBinding("kimi"), false);
  });

  test("does not try to mirror before the provider session is bound", () => {
    const runtime = new DefaultNativeTuiProviderRuntime();
    const update = runtime.updateMirror({
      sessionId: "rah-session",
      provider: "codex",
      cwd: "/tmp/rah-native",
      startupTimestampMs: Date.now(),
    }, undefined);
    assert.equal(update.status, "unbound");
  });

  test("keeps non-Codex terminal output observation generic", () => {
    const runtime = new DefaultNativeTuiProviderRuntime();
    const observation = runtime.observeOutput({
      sessionId: "rah-session",
      provider: "claude",
      cwd: "/tmp/rah-native",
      startupTimestampMs: Date.now(),
    }, "Session ID: should-not-bind");
    assert.deepEqual(observation, {
      promptClean: false,
      binding: null,
    });
  });

  test("keeps provider-specific discovery and mirror code out of core native TUI runtime", () => {
    const coreFiles = [
      readSource("./runtime-terminal-coordinator.ts"),
      readSource("./native-tui-provider-runtime.ts"),
    ];
    const forbiddenProviderModules = [
      "./claude-session-files",
      "./codex-rollout-activity",
      "./codex-stored-sessions",
      "./codex-terminal-wrapper-bridge",
      "./gemini-conversation-utils",
      "./gemini-session-files",
      "./kimi-session-files",
      "./opencode-activity",
      "./opencode-api",
      "./opencode-stored-sessions",
      "./native-tui-claude-provider-handler",
      "./native-tui-codex-provider-handler",
      "./native-tui-gemini-provider-handler",
      "./native-tui-kimi-provider-handler",
      "./native-tui-opencode-provider-handler",
    ];
    for (const source of coreFiles) {
      assertNoImports(source, forbiddenProviderModules);
    }
  });
});

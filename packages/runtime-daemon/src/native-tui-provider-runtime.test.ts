import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { DefaultNativeTuiProviderRuntime } from "./native-tui-provider-runtime";
import { DefaultNativeTuiMirrorProvider } from "./native-tui-mirror-provider";

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
    const runtime = new DefaultNativeTuiMirrorProvider();
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
      "./provider-adapter",
      "./runtime-structured-provider-coordinator",
      "./legacy-structured/runtime-structured-provider-coordinator",
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
    assert.doesNotMatch(
      readSource("./native-tui-provider-runtime.ts"),
      /updateMirror/,
      "native TUI lifecycle runtime should not own mirror updates",
    );
    assert.match(
      readSource("./native-tui-mirror-runtime.ts"),
      /NativeTuiMirrorProvider/,
      "mirror runtime should depend on the dedicated mirror provider seam",
    );
  });

  test("keeps structured provider coordination named as a non-core path", () => {
    const engineSource = readSource("./runtime-engine.ts");
    const providerAdapterSource = readSource("./provider-adapter.ts");
    const providerAdapterInterface = providerAdapterSource.slice(
      providerAdapterSource.indexOf("export interface ProviderAdapter\n"),
    );
    const sessionListSource = readSource("./runtime-session-list.ts");
    assert.match(engineSource, /RuntimeStructuredProviderCoordinator/);
    assert.match(engineSource, /legacy-structured\/runtime-structured-provider-coordinator/);
    assert.match(engineSource, /structuredProviders/);
    assert.match(engineSource, /structuredLiveAdaptersByProvider/);
    assert.match(engineSource, /modeAdaptersByProvider/);
    assert.match(engineSource, /modelAdaptersByProvider/);
    assert.match(engineSource, /actionAdaptersByProvider/);
    assert.match(engineSource, /diagnosticAdaptersByProvider/);
    assert.match(engineSource, /debugAdaptersById/);
    assert.match(engineSource, /storedHistoryAdaptersByProvider/);
    assert.match(engineSource, /shutdownAdaptersById/);
    assert.match(engineSource, /structuredInputAdaptersByProvider/);
    assert.match(engineSource, /structuredPermissionAdaptersByProvider/);
    assert.match(engineSource, /workspaceInspectionAdaptersByProvider/);
    assert.doesNotMatch(engineSource, /adaptersById/);
    assert.doesNotMatch(engineSource, /adaptersByProvider/);
    assert.doesNotMatch(engineSource, /structuredSessionOwners = new Map<string, ProviderAdapter>/);
    assert.doesNotMatch(engineSource, /rememberStructuredSessionOwner\(sessionId, adapter\)/);
    assert.doesNotMatch(engineSource, /historyMirrorAdapters = resolvedAdapters;/);
    assert.match(engineSource, /bindStoredHistoryCapability/);
    assert.doesNotMatch(engineSource, /storedHistoryAdaptersByProvider\.set\(provider, adapter\)/);
    assert.match(engineSource, /historyMirrorAdapters/);
    assert.doesNotMatch(engineSource, /RuntimeProviderCoordinator/);
    assert.doesNotMatch(engineSource, /private readonly providers:/);
    assert.doesNotMatch(engineSource, /discoverRuntimeStoredSessions\(this\.adaptersById\.values\(\)\)/);
    assert.match(providerAdapterSource, /ProviderStructuredLifecycleAdapter/);
    assert.match(providerAdapterSource, /ProviderStructuredInputControlAdapter/);
    assert.match(providerAdapterSource, /ProviderStructuredPermissionAdapter/);
    assert.match(providerAdapterSource, /ProviderStoredHistoryAdapter/);
    assert.match(providerAdapterSource, /ProviderEnhancedModeAdapter/);
    assert.match(providerAdapterSource, /ProviderEnhancedModelAdapter/);
    assert.match(providerAdapterSource, /startSession\?\(/);
    assert.match(providerAdapterSource, /resumeSession\?\(/);
    assert.doesNotMatch(providerAdapterInterface, /ProviderStructuredLifecycleAdapter/);
    assert.doesNotMatch(providerAdapterInterface, /ProviderStructuredInputControlAdapter/);
    assert.doesNotMatch(providerAdapterInterface, /ProviderStructuredPermissionAdapter/);
    assert.doesNotMatch(providerAdapterInterface, /ProviderStoredHistoryAdapter/);
    assert.doesNotMatch(providerAdapterInterface, /ProviderEnhancedModeAdapter/);
    assert.doesNotMatch(providerAdapterInterface, /ProviderEnhancedModelAdapter/);
    assert.doesNotMatch(providerAdapterInterface, /ProviderActionCapabilityAdapter/);
    assert.doesNotMatch(providerAdapterInterface, /ProviderDiagnosticAdapter/);
    assert.doesNotMatch(providerAdapterInterface, /ProviderDebugAdapter/);
    assert.doesNotMatch(providerAdapterInterface, /ProviderShutdownAdapter/);
    assert.doesNotMatch(providerAdapterInterface, /ProviderWorkspaceInspectionAdapter/);
    assert.doesNotMatch(providerAdapterSource, /ProviderStructuredContextAdapter/);
    assert.doesNotMatch(providerAdapterSource, /ProviderLifecycleAdapter/);
    assert.doesNotMatch(providerAdapterSource, /ProviderInputControlAdapter/);
    assert.doesNotMatch(providerAdapterSource, /ProviderModeCapabilityAdapter/);
    assert.doesNotMatch(providerAdapterSource, /ProviderModelCapabilityAdapter/);
    assert.match(sessionListSource, /ProviderStoredHistoryAdapter/);
    assert.doesNotMatch(sessionListSource, /ProviderAdapter/);
  });

  test("keeps legacy structured live clients out of the runtime root", () => {
    for (const provider of ["codex", "claude", "gemini", "kimi", "opencode"]) {
      assert.equal(
        existsSync(new URL(`./${provider}-live-client.ts`, import.meta.url)),
        false,
        `${provider} structured live client should live under legacy-structured/`,
      );
      assert.equal(
        existsSync(new URL(`./legacy-structured/${provider}-live-client.ts`, import.meta.url)),
        true,
        `${provider} structured live client should remain available as explicit legacy code`,
      );
    }
  });
});

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
    assert.match(
      readSource("./native-tui-provider-runtime.ts"),
      /createDefaultNativeTuiBindingHandlers/,
      "native TUI lifecycle runtime should use the binding-only handler factory",
    );
    assert.doesNotMatch(
      readSource("./native-tui-provider-runtime.ts"),
      /createDefaultNativeTuiProviderHandlers/,
      "native TUI lifecycle runtime should not receive the combined provider handler factory",
    );
    assert.match(
      readSource("./native-tui-mirror-provider.ts"),
      /createDefaultNativeTuiMirrorHandlers/,
      "native TUI mirror provider should use the mirror-only handler factory",
    );
    assert.doesNotMatch(
      readSource("./native-tui-mirror-provider.ts"),
      /createDefaultNativeTuiProviderHandlers/,
      "native TUI mirror provider should not receive the combined provider handler factory",
    );
  });

  test("keeps structured provider coordination named as a non-core path", () => {
    const engineSource = readSource("./runtime-engine.ts");
    const providerCapabilityBindingsSource = readSource("./provider-capability-bindings.ts");
    const providerAdapterSource = readSource("./provider-adapter.ts");
    const runtimeSessionLifecycleSource = readSource("./runtime-session-lifecycle.ts");
    const structuredCoordinatorSource = readSource("./legacy-structured/runtime-structured-provider-coordinator.ts");
    const defaultProviderAdaptersSource = readSource("./default-provider-adapters.ts");
    const claudeAdapterSource = readSource("./claude-adapter.ts");
    const claudeStoredHistoryAdapterSource = readSource("./claude-stored-history-adapter.ts");
    const geminiAdapterSource = readSource("./gemini-adapter.ts");
    const geminiStoredHistoryAdapterSource = readSource("./gemini-stored-history-adapter.ts");
    const providerAdapterInterface = providerAdapterSource.slice(
      providerAdapterSource.indexOf("export interface ProviderAdapter\n"),
    );
    const sessionListSource = readSource("./runtime-session-list.ts");
    assert.match(engineSource, /RuntimeStructuredProviderCoordinator/);
    assert.match(engineSource, /createDefaultProviderAdapters/);
    assert.match(defaultProviderAdaptersSource, /ClaudeStoredHistoryAdapter/);
    assert.match(defaultProviderAdaptersSource, /GeminiStoredHistoryAdapter/);
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
    assert.match(engineSource, /bindStructuredLifecycleCapability/);
    assert.match(engineSource, /bindStructuredInputControlCapability/);
    assert.match(engineSource, /bindStructuredPermissionCapability/);
    assert.match(engineSource, /bindWorkspaceInspectionCapability/);
    assert.match(engineSource, /bindEnhancedModeCapability/);
    assert.match(engineSource, /bindEnhancedModelCapability/);
    assert.match(engineSource, /bindActionCapability/);
    assert.match(engineSource, /bindDiagnosticCapability/);
    assert.match(engineSource, /bindDebugCapability/);
    assert.match(engineSource, /bindShutdownCapability/);
    assert.match(providerCapabilityBindingsSource, /export function bindStoredHistoryCapability/);
    assert.match(providerCapabilityBindingsSource, /export function bindStructuredLifecycleCapability/);
    assert.match(providerCapabilityBindingsSource, /export function bindEnhancedModelCapability/);
    assert.match(providerCapabilityBindingsSource, /export function bindShutdownCapability/);
    assert.doesNotMatch(engineSource, /function hasStoredHistoryCapability/);
    assert.doesNotMatch(engineSource, /function bindStoredHistoryCapability/);
    assert.doesNotMatch(engineSource, /function hasStructuredLifecycleCapability/);
    assert.doesNotMatch(engineSource, /function bindStructuredLifecycleCapability/);
    assert.doesNotMatch(engineSource, /function hasEnhancedModelCapability/);
    assert.doesNotMatch(engineSource, /function bindEnhancedModelCapability/);
    assert.doesNotMatch(engineSource, /function hasShutdownCapability/);
    assert.doesNotMatch(engineSource, /function bindShutdownCapability/);
    assertNoImports(engineSource, [
      "./claude-adapter",
      "./codex-adapter",
      "./debug-adapter",
      "./gemini-adapter",
      "./kimi-adapter",
      "./opencode-adapter",
    ]);
    assert.doesNotMatch(engineSource, /adaptersById/);
    assert.doesNotMatch(engineSource, /adaptersByProvider/);
    assert.doesNotMatch(engineSource, /structuredSessionOwners = new Map<string, ProviderAdapter>/);
    assert.doesNotMatch(engineSource, /rememberStructuredSessionOwner\(sessionId, adapter\)/);
    assert.doesNotMatch(engineSource, /structuredLiveAdaptersByProvider\.set\(provider, adapter\)/);
    assert.doesNotMatch(engineSource, /structuredInputAdaptersByProvider\.set\(provider, adapter\)/);
    assert.doesNotMatch(engineSource, /structuredPermissionAdaptersByProvider\.set\(provider, adapter\)/);
    assert.doesNotMatch(engineSource, /workspaceInspectionAdaptersByProvider\.set\(provider, adapter\)/);
    assert.doesNotMatch(engineSource, /modeAdaptersByProvider\.set\(provider, adapter\)/);
    assert.doesNotMatch(engineSource, /modelAdaptersByProvider\.set\(provider, adapter\)/);
    assert.doesNotMatch(engineSource, /actionAdaptersByProvider\.set\(provider, adapter\)/);
    assert.doesNotMatch(engineSource, /diagnosticAdaptersByProvider\.set\(provider, adapter\)/);
    assert.doesNotMatch(engineSource, /debugAdaptersById\.set\(adapter\.id, adapter\)/);
    assert.doesNotMatch(engineSource, /shutdownAdaptersById\.set\(adapter\.id, adapter\)/);
    assert.doesNotMatch(engineSource, /historyMirrorAdapters = resolvedAdapters;/);
    assert.match(engineSource, /bindStoredHistoryCapability/);
    assert.doesNotMatch(engineSource, /storedHistoryAdaptersByProvider\.set\(provider, adapter\)/);
    assert.match(engineSource, /historyMirrorAdapters/);
    assert.doesNotMatch(engineSource, /RuntimeProviderCoordinator/);
    assert.doesNotMatch(engineSource, /private readonly providers:/);
    assert.doesNotMatch(engineSource, /discoverRuntimeStoredSessions\(this\.adaptersById\.values\(\)\)/);
    assert.match(providerAdapterSource, /ProviderStructuredLifecycleAdapter/);
    assert.match(providerAdapterSource, /ProviderCapabilityView/);
    assert.match(providerAdapterSource, /ProviderStructuredInputControlAdapter/);
    assert.match(providerAdapterSource, /ProviderStructuredPermissionAdapter/);
    assert.match(providerAdapterSource, /ProviderStoredHistoryAdapter/);
    assert.match(claudeStoredHistoryAdapterSource, /ProviderStoredHistoryAdapter/);
    assert.match(claudeStoredHistoryAdapterSource, /listStoredSessions/);
    assert.match(claudeStoredHistoryAdapterSource, /getSessionHistoryPage/);
    assert.doesNotMatch(claudeAdapterSource, /listStoredSessions/);
    assert.doesNotMatch(claudeAdapterSource, /getSessionHistoryPage/);
    assert.doesNotMatch(claudeAdapterSource, /removeStoredSession/);
    assert.match(geminiStoredHistoryAdapterSource, /ProviderStoredHistoryAdapter/);
    assert.match(geminiStoredHistoryAdapterSource, /listStoredSessions/);
    assert.match(geminiStoredHistoryAdapterSource, /getSessionHistoryPage/);
    assert.doesNotMatch(geminiAdapterSource, /listStoredSessions/);
    assert.doesNotMatch(geminiAdapterSource, /getSessionHistoryPage/);
    assert.doesNotMatch(geminiAdapterSource, /removeStoredSession/);
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
    for (const source of [
      engineSource,
      providerCapabilityBindingsSource,
      runtimeSessionLifecycleSource,
      structuredCoordinatorSource,
    ]) {
      assert.doesNotMatch(source, /Pick<ProviderAdapter,\s*"id">/);
    }
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

import assert from "node:assert/strict";
import test from "node:test";
import { createDefaultProviderAdapters } from "./default-provider-adapters";
import { hasEnhancedModelCapability } from "./provider-capability-bindings";
import type { DefaultProviderAdapterServices } from "./default-provider-adapters";

test("default adapters register native TUI model catalogs for supported providers", () => {
  const adapters = createDefaultProviderAdapters({} as DefaultProviderAdapterServices);
  const catalogAdapters = adapters
    .filter(hasEnhancedModelCapability)
    .filter((adapter) => typeof adapter.listModels === "function")
    .map((adapter) => ({
      id: adapter.id,
      providers: adapter.providers,
      canHotSwitch: typeof adapter.setSessionModel === "function",
    }));

  assert.deepEqual(catalogAdapters, [
    {
      id: "codex-native-tui-catalog",
      providers: ["codex"],
      canHotSwitch: false,
    },
    {
      id: "claude-native-tui-catalog",
      providers: ["claude"],
      canHotSwitch: false,
    },
    {
      id: "opencode-native-tui-catalog",
      providers: ["opencode"],
      canHotSwitch: false,
    },
    {
      id: "codex",
      providers: ["codex"],
      canHotSwitch: true,
    },
    {
      id: "opencode",
      providers: ["opencode"],
      canHotSwitch: true,
    },
  ]);
});

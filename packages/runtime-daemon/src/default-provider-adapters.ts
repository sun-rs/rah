import { ClaudeAdapter } from "./claude-adapter";
import { ClaudeStoredHistoryAdapter } from "./claude-stored-history-adapter";
import { CodexAdapter } from "./codex-adapter";
import { DebugAdapter } from "./debug-adapter";
import { GeminiAdapter } from "./gemini-adapter";
import { KimiAdapter } from "./kimi-adapter";
import { OpenCodeAdapter } from "./opencode-adapter";
import type { ProviderAdapter, RuntimeServices } from "./provider-adapter";
import type { WorkbenchStateStore } from "./workbench-state";

export type DefaultProviderAdapterServices = RuntimeServices & {
  workbenchState: WorkbenchStateStore;
};

export function createDefaultProviderAdapters(
  services: DefaultProviderAdapterServices,
): ProviderAdapter[] {
  return [
    new DebugAdapter({
      eventBus: services.eventBus,
      ptyHub: services.ptyHub,
      sessionStore: services.sessionStore,
    }),
    new CodexAdapter(services),
    new ClaudeAdapter(services),
    new ClaudeStoredHistoryAdapter(services),
    new GeminiAdapter(services),
    new KimiAdapter(services),
    new OpenCodeAdapter(services),
  ];
}

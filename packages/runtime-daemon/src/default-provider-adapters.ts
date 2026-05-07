import { ClaudeAdapter } from "./claude-adapter";
import { ClaudeStoredHistoryAdapter } from "./claude-stored-history-adapter";
import { CodexAdapter } from "./codex-adapter";
import { CodexStoredHistoryAdapter } from "./codex-stored-history-adapter";
import { DebugAdapter } from "./debug-adapter";
import { GeminiAdapter } from "./gemini-adapter";
import { GeminiStoredHistoryAdapter } from "./gemini-stored-history-adapter";
import { KimiAdapter } from "./kimi-adapter";
import { KimiStoredHistoryAdapter } from "./kimi-stored-history-adapter";
import { OpenCodeAdapter } from "./opencode-adapter";
import { OpenCodeStoredHistoryAdapter } from "./opencode-stored-history-adapter";
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
    new CodexStoredHistoryAdapter(services),
    new ClaudeAdapter(services),
    new ClaudeStoredHistoryAdapter(services),
    new GeminiAdapter(services),
    new GeminiStoredHistoryAdapter(services),
    new KimiAdapter(services),
    new KimiStoredHistoryAdapter(services),
    new OpenCodeAdapter(services),
    new OpenCodeStoredHistoryAdapter(services),
  ];
}

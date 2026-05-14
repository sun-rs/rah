import { ClaudeStoredHistoryAdapter } from "./claude-stored-history-adapter";
import { CodexStoredHistoryAdapter } from "./codex-stored-history-adapter";
import { DebugAdapter } from "./debug-adapter";
import { CodexAdapter } from "./provider-control/codex-structured-adapter";
import { OpenCodeAdapter } from "./provider-control/opencode-structured-adapter";
import {
  ClaudeNativeTuiCatalogAdapter,
  CodexNativeTuiCatalogAdapter,
  OpenCodeNativeTuiCatalogAdapter,
} from "./native-tui-catalog-adapters";
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
    new CodexStoredHistoryAdapter(services),
    new ClaudeStoredHistoryAdapter(services),
    new OpenCodeStoredHistoryAdapter(services),
    new CodexNativeTuiCatalogAdapter(),
    new ClaudeNativeTuiCatalogAdapter(),
    new OpenCodeNativeTuiCatalogAdapter(),
    new CodexAdapter(services),
    new OpenCodeAdapter(services),
  ];
}

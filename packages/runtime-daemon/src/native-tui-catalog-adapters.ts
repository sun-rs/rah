import type {
  ProviderKind,
  ProviderModelCatalog,
} from "@rah/runtime-protocol";
import {
  ClaudeModelCatalogCache,
} from "./claude-model-catalog";
import {
  CodexModelCatalogCache,
} from "./codex-model-catalog";
import {
  OpenCodeModelCatalogCache,
} from "./opencode-model-catalog";
import type {
  ProviderAdapter,
  ProviderEnhancedModelAdapter,
} from "./provider-adapter";
import { withProviderCatalogRuntime } from "./session-runtime-descriptor";

type ListModelsOptions = {
  cwd?: string;
  forceRefresh?: boolean;
};

export class CodexNativeTuiCatalogAdapter
  implements ProviderAdapter, ProviderEnhancedModelAdapter
{
  readonly id = "codex-native-tui-catalog";
  readonly providers: ProviderKind[] = ["codex"];
  private readonly catalog = new CodexModelCatalogCache();

  async listModels(options?: ListModelsOptions): Promise<ProviderModelCatalog> {
    return withProviderCatalogRuntime(await this.catalog.listModels({
      ...(options?.forceRefresh !== undefined ? { forceRefresh: options.forceRefresh } : {}),
    }));
  }
}

export class ClaudeNativeTuiCatalogAdapter
  implements ProviderAdapter, ProviderEnhancedModelAdapter
{
  readonly id = "claude-native-tui-catalog";
  readonly providers: ProviderKind[] = ["claude"];
  private readonly catalog = new ClaudeModelCatalogCache();

  async listModels(options?: ListModelsOptions): Promise<ProviderModelCatalog> {
    return withProviderCatalogRuntime(await this.catalog.listModels(options));
  }
}

export class OpenCodeNativeTuiCatalogAdapter
  implements ProviderAdapter, ProviderEnhancedModelAdapter
{
  readonly id = "opencode-native-tui-catalog";
  readonly providers: ProviderKind[] = ["opencode"];
  private readonly catalog = new OpenCodeModelCatalogCache();

  async listModels(options?: ListModelsOptions): Promise<ProviderModelCatalog> {
    return withProviderCatalogRuntime(await this.catalog.listModels(options));
  }
}

import { ClaudeAdapter } from "../claude-adapter";
import { CodexAdapter } from "../codex-adapter";
import { GeminiAdapter } from "../gemini-adapter";
import { KimiAdapter } from "../kimi-adapter";
import { OpenCodeAdapter } from "../opencode-adapter";
import type { ProviderAdapter, RuntimeServices } from "../provider-adapter";

export function createDefaultLegacyStructuredProviderAdapters(
  services: RuntimeServices,
): ProviderAdapter[] {
  return [
    new CodexAdapter(services),
    new ClaudeAdapter(services),
    new GeminiAdapter(services),
    new KimiAdapter(services),
    new OpenCodeAdapter(services),
  ];
}

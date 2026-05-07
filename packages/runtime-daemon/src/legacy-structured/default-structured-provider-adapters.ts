import { ClaudeAdapter } from "./claude-structured-adapter";
import { CodexAdapter } from "./codex-structured-adapter";
import { GeminiAdapter } from "./gemini-structured-adapter";
import { KimiAdapter } from "./kimi-structured-adapter";
import { OpenCodeAdapter } from "./opencode-structured-adapter";
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

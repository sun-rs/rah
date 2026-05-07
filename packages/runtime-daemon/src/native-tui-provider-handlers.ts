import type { ProviderKind } from "@rah/runtime-protocol";
import { claudeNativeTuiProviderHandler } from "./native-tui-claude-provider-handler";
import { codexNativeTuiProviderHandler } from "./native-tui-codex-provider-handler";
import { geminiNativeTuiProviderHandler } from "./native-tui-gemini-provider-handler";
import { kimiNativeTuiProviderHandler } from "./native-tui-kimi-provider-handler";
import { opencodeNativeTuiProviderHandler } from "./native-tui-opencode-provider-handler";
import type { NativeTuiProviderHandler } from "./native-tui-provider-runtime-types";

export function createDefaultNativeTuiProviderHandlers(): ReadonlyMap<
  ProviderKind,
  NativeTuiProviderHandler
> {
  const handlers = [
    codexNativeTuiProviderHandler,
    claudeNativeTuiProviderHandler,
    geminiNativeTuiProviderHandler,
    kimiNativeTuiProviderHandler,
    opencodeNativeTuiProviderHandler,
  ];
  return new Map(handlers.map((handler) => [handler.provider, handler]));
}

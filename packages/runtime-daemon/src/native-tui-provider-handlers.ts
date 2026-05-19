import type { ProviderKind } from "@rah/runtime-protocol";
import { claudeNativeTuiProviderHandler } from "./native-tui-claude-provider-handler";
import { codexNativeTuiProviderHandler } from "./native-tui-codex-provider-handler";
import { geminiNativeTuiProviderHandler } from "./native-tui-gemini-provider-handler";
import { opencodeNativeTuiProviderHandler } from "./native-tui-opencode-provider-handler";
import type {
  NativeTuiBindingHandler,
  NativeTuiMirrorHandler,
  NativeTuiProviderHandler,
} from "./native-tui-provider-runtime-types";

const DEFAULT_NATIVE_TUI_PROVIDER_HANDLERS: readonly NativeTuiProviderHandler[] = [
  codexNativeTuiProviderHandler,
  claudeNativeTuiProviderHandler,
  geminiNativeTuiProviderHandler,
  opencodeNativeTuiProviderHandler,
];

export function createDefaultNativeTuiBindingHandlers(): ReadonlyMap<
  ProviderKind,
  NativeTuiBindingHandler
> {
  return new Map(
    DEFAULT_NATIVE_TUI_PROVIDER_HANDLERS.map((handler): [ProviderKind, NativeTuiBindingHandler] => [
      handler.provider,
      handler,
    ]),
  );
}

export function createDefaultNativeTuiMirrorHandlers(): ReadonlyMap<
  ProviderKind,
  NativeTuiMirrorHandler
> {
  return new Map(
    DEFAULT_NATIVE_TUI_PROVIDER_HANDLERS.map((handler): [ProviderKind, NativeTuiMirrorHandler] => [
      handler.provider,
      handler,
    ]),
  );
}
